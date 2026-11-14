/**
 * dsh-connect-minimax — 宿主侧入口。
 *
 * 把本机 MiniMax Code 桌面应用的登录态（免费额度）接入 DSH：
 *  - 注册 provider 路由 `minimax-code` 与模型目录（mavis 网关，Anthropic Messages 协议直连）
 *  - 每日自动签到（minimax-cloud signin 接口）
 *  - webServer 状态路由（积分/签到/模型刷新），供浏览器设置页读取
 *
 * 插件不自行刷新 OAuth 令牌：refresh token 一次性轮换，官方桌面应用是唯一所有者。
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import * as schemasteryModule from '@deepseek-ai/schemastery';
import { MiniMaxAuthError, readCredential } from './auth.js';
import { runCheckinOnce, tickCheckin, checkinSnapshot } from './checkin.js';
import * as mavis from './mavis.js';
import { localTimeZone, resolveDshHomeAsync } from './util.js';

const z = schemasteryModule.default ?? schemasteryModule;

export const name = 'dsh-connect-minimax';
export const inject = ['llm'];

export const PROVIDER_ID = 'minimax-code';

function asVolatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile();
  return schema;
}

export const Config = z.object({
  checkin: z.object({
    enabled: z.boolean().default(true).description('每日自动签到（领取免费积分）'),
    autoRetryMinutes: z.union([5, 15, 30, 60]).default(30).description('签到失败后的重试间隔上限（分钟）'),
  }).default({}),
  showCreditsInComposer: asVolatile(z.boolean().default(true)
    .description('当选中的模型属于本插件时，在输入框区域显示积分读数')),
  refreshIntervalMinutes: asVolatile(z.union([1, 5, 10, 30, 60]).default(5)
    .description('积分/签到状态自动刷新间隔（分钟）')),
}).default({});

/** MiniMax Code 的可配置 provider 目录条目（设置页展示）。 */
function settingsNamespaceOf(ctx) {
  return ctx.fiber?.entry?.options?.id ?? name;
}

// ── LlmAdapter 实现 ────────────────────────────────────────────────────────

// 继承 LlmAdapter：宿主注册校验要求完整方法面（providerRetryPolicy 等）。
class MiniMaxAdapter extends LlmAdapter {
  constructor(deps) {
    super();
    this.deps = deps;
  }

  providerInfo(provider) {
    if (provider !== PROVIDER_ID) throw new LlmError(`未知 provider：${provider}`, 'UNKNOWN_MODEL');
    return { id: PROVIDER_ID, name: 'MiniMax Code' };
  }

  async listModels(provider) {
    this.providerInfo(provider);
    const models = await this.deps.listModels();
    return models.map((model) => ({
      provider: PROVIDER_ID,
      id: model.id,
      name: model.name,
      description: model.description,
      inputModalities: model.inputModalities,
      badge: { text: { en: 'Free (Code)', zh: '免费（Code）' }, tone: 'success' },
    }));
  }

  async resolveModel(provider, model, _signal) {
    this.providerInfo(provider);
    const known = (await this.deps.listModels().catch(() => [])).find((entry) => entry.id === model);
    return {
      provider: PROVIDER_ID,
      id: model,
      name: known?.name ?? model,
      description: known?.description,
      inputModalities: known?.inputModalities ?? ['text'],
      context: { contextWindow: known?.contextWindow ?? 512000 },
      defaultMaxTokens: 16384,
      reasoning: {
        efforts: [{ id: 'adaptive', name: '自适应思考' }],
        defaultEffort: 'adaptive',
      },
    };
  }

  async *stream(options) {
    if (options.provider !== PROVIDER_ID) {
      throw new LlmError(`MiniMax Code 适配器收到其他 provider 的请求：${options.provider}`, 'UNKNOWN_MODEL');
    }
    try {
      yield* mavis.streamCompletion(options, { readImage: this.deps.readImage });
    } catch (error) {
      throw toLlmError(error);
    }
  }
}

/** 插件内部错误 → LlmError（共享失败分类词汇）。 */
function toLlmError(error) {
  if (error instanceof LlmError) return error;
  if (error instanceof MiniMaxAuthError) {
    return new LlmError(error.message, error.code === 'AUTH_CORRUPT' ? 'AUTH' : 'ACCOUNT_SIGN_IN_REQUIRED');
  }
  if (error instanceof mavis.MavisError) {
    return new LlmError(error.message, error.code, { status: error.status, requestId: error.requestId });
  }
  return new LlmError(String(error?.message ?? error), 'UNKNOWN');
}

// ── webServer 状态路由 ──────────────────────────────────────────────────────

function loopbackOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
      || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function failJson(res, error) {
  const known = error instanceof MiniMaxAuthError || error instanceof mavis.MavisError;
  json(res, 200, {
    ok: false,
    error: {
      code: known ? error.code : 'UNKNOWN',
      message: String(error?.message ?? error),
    },
  });
}

const USAGE_PATH = '/plugins/dsh-connect-minimax/usage';
const CHECKIN_PATH = '/plugins/dsh-connect-minimax/checkin';
const MODELS_REFRESH_PATH = '/plugins/dsh-connect-minimax/models/refresh';
const DIAG_PATH = '/plugins/dsh-connect-minimax/diag';

function registerUsageRoutes(webCtx, ctx) {
  // 注入的 webServer 上下文经 `.webServer` 属性暴露服务（同 trae）。
  const server = webCtx.webServer ?? webCtx;
  if (typeof server?.register !== 'function') {
    ctx.logger?.warn?.('[dsh-connect-minimax] webServer 服务不可用，状态路由未注册');
    return () => {};
  }
  const disposers = [
    {
      kind: 'exact',
      path: USAGE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
        try {
          json(res, 200, {
            ok: true,
            provider: PROVIDER_ID,
            timezone: localTimeZone(),
            auth: authSummary(),
            signin: await mavis.fetchSigninStatus().then((status) => ({ ...status, auto: checkinSnapshot() }))
              .catch((error) => ({ error: error.message, auto: checkinSnapshot() })),
            credits: await mavis.fetchCredits().catch((error) => ({ error: error.message })),
            models: (await mavis.fetchModelCatalog().catch(() => [])).map((m) => ({ id: m.id, name: m.name })),
          });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: CHECKIN_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
        try {
          json(res, 200, { ok: true, result: await runCheckinOnce() });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: DIAG_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
        try {
          const llm = ctx.llm;
          const providers = llm.listProviders().map((p) => ({ id: p.id, name: p.name }));
          const mine = providers.some((p) => p.id === PROVIDER_ID);
          let models = null;
          let modelsError = null;
          if (mine) {
            try {
              models = (await llm.listModels(PROVIDER_ID)).map((m) => ({ id: m.id, name: m.name }));
            } catch (error) {
              modelsError = String(error?.message ?? error);
            }
          }
          json(res, 200, {
            ok: true,
            hasLlm: llm !== undefined,
            providers,
            mine,
            models,
            modelsError,
            configurable: (llm.listConfigurableProviders?.() ?? []).map((p) => p.provider),
            settingsNs: settingsNamespaceOf(ctx),
            llmReg: llmRegState,
          });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: MODELS_REFRESH_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (!loopbackOrigin(req)) return json(res, 403, { error: 'origin-not-trusted' });
        try {
          mavis.invalidateModelCatalog();
          const models = await mavis.fetchModelCatalog({ force: true });
          ctx.emit?.('llm/models-updated', PROVIDER_ID);
          json(res, 200, { ok: true, models: models.map((m) => ({ id: m.id, name: m.name })) });
        } catch (error) {
          failJson(res, error);
        }
      },
    },
  ].map((route) => {
    try {
      return server.register(route);
    } catch (error) {
      ctx.logger?.warn?.('[dsh-connect-minimax] 注册 webServer 路由失败：', route.path, error);
      return undefined;
    }
  });
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 已被宿主回收 */
      }
    }
  };
}

/** 登录态摘要（绝不包含令牌本体）。 */
function authSummary() {
  try {
    const credential = readCredential();
    if (!credential) return { signedIn: false };
    return {
      signedIn: true,
      region: credential.namespace?.region ?? '',
      clientId: credential.clientId || '',
      expiresAtMs: credential.expiresAtMs,
      generation: credential.generation,
    };
  } catch (error) {
    return { signedIn: false, error: String(error?.message ?? error) };
  }
}

// ── apply ──────────────────────────────────────────────────────────────────

/** llm 注册自诊断（diag 路由回读；无令牌，仅注册结果）。 */
const llmRegState = { ran: false, adapter: null, discovery: null, directory: null, emit: null };

export function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx);

  ctx.effect(() => {
    llmRegState.ran = true;
    const adapter = new MiniMaxAdapter({
      listModels: () => mavis.fetchModelCatalog(),
      // 图片附件字节由附件服务读取（运行时惰性取，注册时服务可能尚未挂上）。
      readImage: (ref, signal) => {
        const service = ctx.attachments;
        if (typeof service?.readImage !== 'function') {
          return Promise.reject(new Error('附件服务不可用'));
        }
        return service.readImage(ref, signal);
      },
    });
    let adapterHandle;
    let discoveryHandle;
    let directoryHandle;
    try {
      adapterHandle = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
      llmRegState.adapter = 'ok';
    } catch (error) {
      llmRegState.adapter = String(error?.message ?? error);
      ctx.logger?.warn?.('[dsh-connect-minimax] 注册 LLM 适配器失败：', error);
      return () => {};
    }
    try {
      discoveryHandle = ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
        void signal;
        const models = await mavis.fetchModelCatalog();
        return models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          inputModalities: model.inputModalities,
        }));
      });
      llmRegState.discovery = 'ok';
    } catch (error) {
      llmRegState.discovery = String(error?.message ?? error);
      ctx.logger?.warn?.('[dsh-connect-minimax] 注册模型发现失败：', error);
    }
    try {
      directoryHandle = ctx.llm.registerConfigurableProviders([{
        provider: PROVIDER_ID,
        displayName: 'MiniMax Code',
        settingsNs,
        settingsPath: [],
        declared: false,
      }]);
      llmRegState.directory = 'ok';
    } catch (error) {
      llmRegState.directory = String(error?.message ?? error);
      ctx.logger?.warn?.('[dsh-connect-minimax] 注册 provider 目录失败：', error);
    }
    try {
      ctx.emit('llm/models-updated', PROVIDER_ID);
      ctx.emit('llm/adapters-updated');
      llmRegState.emit = 'ok';
    } catch (error) {
      llmRegState.emit = String(error?.message ?? error);
      /* 事件失败不影响注册 */
    }
    return () => {
      for (const dispose of [adapterHandle, discoveryHandle, directoryHandle]) {
        try {
          dispose?.();
        } catch {
          /* REGISTRATION_DISPOSED 等：宿主已回收 */
        }
      }
    };
  }, 'dsh-connect-minimax: llm registration');

  // 每日自动签到：60s 粒度轮询，tick 内部按日期/退避节流。
  ctx.effect(() => {
    let disposed = false;
    let timer;
    const enabled = () => config?.checkin?.enabled !== false;
    const tick = () => {
      tickCheckin({ enabled }).catch(() => {});
    };
    resolveDshHomeAsync().finally(() => {
      if (disposed) return;
      tick();
      timer = setInterval(tick, 60_000);
    });
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, 'dsh-connect-minimax: checkin scheduler');

  // webServer 状态路由：与 trae 相同的惰性注入惯例，回调返回 disposer。
  ctx.inject?.(['webServer'], (webCtx) => registerUsageRoutes(webCtx, ctx));
}
