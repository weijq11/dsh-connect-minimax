/**
 * MiniMax Code mavis 网关客户端：模型目录、Anthropic Messages 协议推理、
 * 每日签到与积分明细。全部请求走 OAuth 登录态（桌面应用写入的 access token）。
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { credentialForRequest, invalidateCredential, MiniMaxAuthError } from './auth.js';

const GATEWAY_ORIGIN = 'https://agent.minimax.cn';
const MODELS_PATH = '/mavis/api/v1/models';
const MESSAGES_PATH = '/mavis/api/v1/llm/v1/messages';
const SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status';
const SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';
const CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details';

const MODELS_CACHE_TTL_MS = 5 * 60_000;

let modelsCache = undefined; // { models, readAt }

/** 每次请求共用的头：OAuth Bearer + 官方客户端身份。 */
function baseHeaders(credential) {
  return {
    ...attributionHeaders(),
    authorization: `Bearer ${credential.accessToken}`,
    'user-agent': 'MiniMaxCode',
    'x-mavis-desktop-channel': 'desktop',
    accept: 'application/json',
  };
}

/** 统一的凭据驱动 fetch：401/403 强制重读凭据后重试一次。 */
async function authedFetch(path, init) {
  const build = () => {
    const credential = credentialForRequest();
    const headers = { ...baseHeaders(credential), ...(init.headers ?? {}) };
    return { url: GATEWAY_ORIGIN + path, init: { ...init, headers } };
  };
  let response = await fetch(GATEWAY_ORIGIN + path, build().init);
  if (response.status === 401 || response.status === 403) {
    invalidateCredential();
    response = await fetch(GATEWAY_ORIGIN + path, build().init);
  }
  return response;
}

function normalizeTimezoneOffset() {
  return -new Date().getTimezoneOffset();
}

/** 网关错误 → LlmError 兼容的失败对象。 */
export class MavisError extends Error {
  /**
   * @param {string} code 稳定失败码（与 dsh-llm 的失败分类同词汇）
   * @param {string} message
   * @param {{ status?: number, requestId?: string }} [facts]
   */
  constructor(code, message, facts = {}) {
    super(message);
    this.name = 'MavisError';
    this.code = code;
    this.status = facts.status;
    this.requestId = facts.requestId;
  }
}

function classifyHttpError(status, payloadText) {
  let payload = {};
  try {
    payload = JSON.parse(payloadText);
  } catch {
    /* 保留空对象 */
  }
  const type = typeof payload?.error?.type === 'string' ? payload.error.type : '';
  const message = typeof payload?.error?.message === 'string' && payload.error.message.length > 0
    ? payload.error.message
    : (typeof payload?.base_resp?.status_msg === 'string' && payload.base_resp.status_msg.length > 0
      ? payload.base_resp.status_msg
      : `MiniMax 网关返回 HTTP ${status}`);
  const requestId = typeof payload?.request_id === 'string' ? payload.request_id : undefined;
  let code = 'SERVER';
  if (status === 401 || status === 403 || type === 'authentication_error') code = 'AUTH';
  else if (status === 429) code = 'RATE_LIMIT';
  else if (status >= 500) code = 'SERVER';
  else if (type === 'invalid_request_error') {
    code = /context|too long|too large/i.test(message) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST';
  } else if (status === 400) code = 'INVALID_REQUEST';
  else if (status === 402 || /balance|quota/i.test(message)) code = 'QUOTA';
  return new MavisError(code, message, { status, requestId });
}

// ── 模型目录 ──────────────────────────────────────────────────────────────

/** mavis 目录条目 → DSH 模型行。 */
function toCatalogEntry(modelId, entry) {
  const limit = entry?.limit ?? {};
  const input = Array.isArray(entry?.modalities?.input) ? entry.modalities.input : [];
  const thinkingMode = entry?.thinking_config?.mode ?? 'switchable';
  const adaptiveOnly = thinkingMode === 'adaptive';
  return {
    id: modelId,
    name: typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : modelId,
    description: 'MiniMax Code 免费额度（登录态网关）',
    inputModalities: input.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: Number(limit.context) || 512000,
    maxTokens: Number(limit.output) || 128000,
    adaptiveOnly,
  };
}

/** 拉取 mavis 模型目录（5 分钟缓存），返回 DSH 目录行数组。 */
export async function fetchModelCatalog({ force = false } = {}) {
  if (!force && modelsCache && Date.now() - modelsCache.readAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }
  const response = await authedFetch(MODELS_PATH, { method: 'GET' });
  const text = await response.text();
  if (!response.ok) throw classifyHttpError(response.status, text);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new MavisError('MALFORMED_RESPONSE', '模型目录响应不是合法 JSON', { status: response.status });
  }
  const models = [];
  for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
    const bag = provider?.config?.models;
    if (!bag || typeof bag !== 'object') continue;
    for (const [modelId, entry] of Object.entries(bag)) {
      try {
        models.push(toCatalogEntry(modelId, entry));
      } catch {
        /* 单个条目损坏不影响其余 */
      }
    }
  }
  modelsCache = { models, readAt: Date.now() };
  return models;
}

/** 丢弃模型目录缓存（设置页手动刷新用）。 */
export function invalidateModelCatalog() {
  modelsCache = undefined;
}

// ── 推理（Anthropic Messages 协议）─────────────────────────────────────────

/** 收集请求里的全部图片引用（attachmentId → base64 的解析交给 resolver）。 */
function collectImageRefs(messages) {
  const refs = [];
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'image' && !block.offloaded && block.attachment?.attachmentId) {
        refs.push(block.attachment);
      }
    }
  }
  return refs;
}

/** DSH ContentBlock → Anthropic content part（图片以 base64 内联）。 */
function toAnthropicContent(blocks, imageBase64) {
  const parts = [];
  for (const block of blocks ?? []) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && !block.offloaded) {
      const ref = block.attachment ?? {};
      const mediaType = typeof ref.mediaType === 'string' && ref.mediaType.startsWith('image/')
        ? ref.mediaType
        : 'image/png';
      const data = imageBase64.get(ref.attachmentId) ?? '';
      if (data) parts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }
    // file/tool-addition/tool-removal 等已由请求组装层投射为文本。
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

/**
 * 把 DSH 请求消息翻译成 Anthropic Messages 的 messages/system。
 * system：leading system 消息拼接；one-shot 的 options.system 追加在后。
 */
function translateMessages(messages, extraSystem = '') {
  const systemParts = [];
  if (extraSystem) systemParts.push(extraSystem);
  const out = [];
  for (const message of messages ?? []) {
    if (message.role === 'system') {
      for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text) systemParts.push(block.text);
      }
      continue;
    }
    if (message.role === 'developer') {
      // 工具增删已在 tools 全量声明里表达；其余文本并入 system。
      for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text) systemParts.push(block.text);
      }
      continue;
    }
    if (message.role === 'user') {
      out.push({ role: 'user', raw: message.content ?? [] });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = [];
      for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text });
        else if (block.type === 'reasoning' && block.text) {
          parts.push({ type: 'thinking', thinking: block.text });
        } else if (block.type === 'tool-call') {
          parts.push({ type: 'tool_use', id: block.id, name: block.name, input: safeJsonParse(block.arguments) });
        }
      }
      out.push({ role: 'assistant', parts: parts.length > 0 ? parts : [{ type: 'text', text: '' }] });
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        parts: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: (message.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n') || '',
          is_error: message.isError === true,
        }],
      });
    }
  }
  // Anthropic 协议要求 user/assistant 严格交替：合并连续同角色消息。
  const merged = [];
  for (const entry of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === entry.role && (entry.raw !== undefined) === (last.raw !== undefined)) {
      // 同为 raw（用户块）或同为 parts（成形 part）才可合并。
      if (entry.raw !== undefined) last.raw = [...last.raw, ...entry.raw];
      else last.parts = [...(last.parts ?? []), ...entry.parts];
    } else {
      merged.push({ ...entry });
    }
  }
  return { system: systemParts.join('\n\n'), messages: merged };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** SSE 逐行解析器（Anthropic messages 流）。 */
function createSseParser(onEvent) {
  let buffer = '';
  return (chunkText) => {
    buffer += chunkText;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data.length > 0 && data !== '[DONE]') {
          try {
            onEvent(JSON.parse(data));
          } catch {
            /* 非 JSON 行忽略 */
          }
        }
      }
    }
  };
}

/**
 * 流式推理一条请求，逐个产出 StreamChunk。
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
 * @param {{ readImage?: (ref: unknown, signal?: AbortSignal) => Promise<{ data: Uint8Array }> }} deps
 */
export async function* streamCompletion(options, deps = {}) {
  const catalog = await fetchModelCatalog().catch(() => []);
  const known = catalog.find((m) => m.id === options.model);
  // 解析请求里的图片引用为 base64（网关按 Anthropic 协议接受 base64 source）。
  const imageBase64 = new Map();
  const refs = collectImageRefs(options.messages);
  if (refs.length > 0 && typeof deps.readImage === 'function') {
    for (const ref of refs) {
      try {
        const { data } = await deps.readImage(ref, options.signal);
        imageBase64.set(ref.attachmentId, Buffer.from(data).toString('base64'));
      } catch {
        /* 单张图片失败：按文本占位降级（内容里留空，由其余文本承载语义） */
      }
    }
  }
  const { system, messages } = translateMessages(options.messages, options.system);
  const body = {
    model: options.model,
    max_tokens: options.maxTokens ?? known?.maxTokens ?? 16384,
    // 网关要求自适应思考（实测 disabled 返回 2013），流里会给出 thinking 块。
    thinking: { type: 'adaptive' },
    stream: true,
  };
  if (system.length > 0) body.system = system;
  if (messages.length > 0) {
    body.messages = messages.map((m) => ({
      role: m.role,
      content: m.raw !== undefined ? toAnthropicContent(m.raw, imageBase64) : m.parts,
    }));
  }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature;
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop_sequences = options.stop;

  const credential = credentialForRequest();
  const headers = {
    ...baseHeaders(credential),
    'content-type': 'application/json',
    'x-mavis-agent-id': 'main',
    'x-mavis-timezone-offset': String(normalizeTimezoneOffset()),
    'x-mavis-session-id': randomSessionId(),
    accept: 'text/event-stream',
  };
  const send = (token) => fetch(GATEWAY_ORIGIN + MESSAGES_PATH, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  let response = await send(credential.accessToken);
  if (response.status === 401 || response.status === 403) {
    invalidateCredential();
    const retryCredential = credentialForRequest({ force: true });
    response = await send(retryCredential.accessToken);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw classifyHttpError(response.status, text);
  }
  yield* consumeMessageStream(response, options, known);
}

async function* consumeMessageStream(response, options, known) {
  if (!response.body) throw new MavisError('STREAM_CLOSED', 'MiniMax 网关没有返回响应体', { status: response.status });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pendingEvents = [];
  const parseLine = createSseParser((event) => pendingEvents.push(event));
  let blockIndex = -1;
  let openedKind = ''; // '' | 'text' | 'reasoning' | 'tool'
  let toolId = '';
  let toolName = '';
  let toolArgs = '';
  let textAccum = '';
  let reasoningAccum = '';
  let usage = undefined;
  let stopReason = 'end_turn';
  let sawMessageStart = false;

  const closeOpen = function* () {
    if (openedKind === 'tool') {
      openedKind = '';
      yield {
        type: 'block-end', index: blockIndex,
        block: { type: 'tool-call', id: toolId || `tool_${blockIndex}`, name: toolName || 'tool', arguments: toolArgs || '{}' },
      };
      toolId = ''; toolName = ''; toolArgs = '';
    } else if (openedKind === 'text') {
      openedKind = '';
      yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: textAccum } };
      textAccum = '';
    } else if (openedKind === 'reasoning') {
      openedKind = '';
      yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningAccum } };
      reasoningAccum = '';
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parseLine(decoder.decode(value, { stream: true }));
      while (pendingEvents.length > 0) {
        const event = pendingEvents.shift();
        if (event.type === 'message_start') {
          sawMessageStart = true;
          if (event.message?.usage) usage = usageFromAnthropic(event.message.usage, usage);
        } else if (event.type === 'content_block_start') {
          yield* closeOpen();
          blockIndex += 1;
          const kind = event.content_block?.type;
          if (kind === 'thinking') {
            openedKind = 'reasoning';
            reasoningAccum = '';
            yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' };
          } else if (kind === 'tool_use') {
            openedKind = 'tool';
            toolId = event.content_block?.id ?? '';
            toolName = event.content_block?.name ?? '';
            toolArgs = '';
            yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
          } else {
            openedKind = 'text';
            textAccum = '';
            yield { type: 'block-start', index: blockIndex, blockType: 'text' };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta ?? {};
          if (delta.type === 'text_delta') {
            textAccum += delta.text ?? '';
            yield { type: 'text-delta', index: blockIndex, text: delta.text ?? '' };
          } else if (delta.type === 'thinking_delta') {
            reasoningAccum += delta.thinking ?? '';
            yield { type: 'reasoning-delta', index: blockIndex, text: delta.thinking ?? '' };
          } else if (delta.type === 'input_json_delta') {
            toolArgs += delta.partial_json ?? '';
            yield { type: 'tool-call-delta', index: blockIndex, id: toolId, name: toolName, argumentsDelta: delta.partial_json ?? '' };
          }
        } else if (event.type === 'content_block_stop') {
          yield* closeOpen();
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) stopReason = mapStopReason(event.delta.stop_reason);
          if (event.usage) usage = usageFromAnthropic(event.usage, usage);
        } else if (event.type === 'message_stop') {
          // 终止事件：收尾在循环外统一处理。
        } else if (event.type === 'error') {
          const failure = event.error ?? {};
          throw new MavisError(
            failure.type === 'overloaded_error' ? 'RATE_LIMIT' : 'SERVER',
            typeof failure.message === 'string' ? failure.message : 'MiniMax 流式响应报错',
          );
        } else if (event.type === 'ping') {
          /* 心跳 */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已经关闭 */
    }
  }
  if (!sawMessageStart) {
    throw new MavisError('MALFORMED_RESPONSE', 'MiniMax 流式响应缺少 message_start');
  }
  yield* closeOpen();
  if (usage) yield { type: 'usage', usage };
  // FinishReasonMap：stop/tool-calls/max-tokens 为简单对象；aborted/error 由
  // LlmRuntime 在抛错/信号中止时归一化，适配器不自行产出。
  const kind = mapStopReason(stopReason);
  void known;
  yield { type: 'finish', reason: { kind } };
}

function mapStopReason(reason) {
  if (reason === 'tool_use' || reason === 'tool_calls') return 'tool-calls';
  if (reason === 'max_tokens') return 'max-tokens';
  return 'stop';
}

function usageFromAnthropic(raw, previous) {
  const next = { ...(previous ?? {}) };
  if (Number.isFinite(raw.input_tokens)) next.inputTokens = raw.input_tokens;
  if (Number.isFinite(raw.output_tokens)) next.outputTokens = raw.output_tokens;
  if (Number.isFinite(raw.cache_read_input_tokens)) next.cacheReadTokens = raw.cache_read_input_tokens;
  if (Number.isFinite(raw.cache_creation_input_tokens)) next.cacheWriteTokens = raw.cache_creation_input_tokens;
  const thinking = Number(raw.output_tokens_details?.thinking_tokens);
  if (Number.isFinite(thinking) && thinking > 0) next.reasoningTokens = thinking;
  return next;
}

function randomSessionId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── 签到与积分 ─────────────────────────────────────────────────────────────

function signinHeaders() {
  return { 'content-type': 'application/json' };
}

function timezoneQuery() {
  let zone = 'Asia/Shanghai';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
  } catch {
    /* 保留默认 */
  }
  return `?timezone_id=${encodeURIComponent(zone)}`;
}

/** 签到面板状态。 */
export async function fetchSigninStatus() {
  const response = await authedFetch(SIGNIN_STATUS_PATH + timezoneQuery(), { method: 'GET' });
  const text = await response.text();
  if (!response.ok) throw classifyHttpError(response.status, text);
  const payload = JSON.parse(text);
  const data = payload?.data ?? {};
  return {
    scene: Number(data.scene) || 0,
    days: (Array.isArray(data.days) ? data.days : []).map((day) => ({
      dayNo: Number(day.day_no) || 0,
      points: Number(day.points) || 0,
      bonusPoints: Number(day.bonus_points) || 0,
      status: Number(day.status) || 0, // 1 未到 2 可领 3 已领 4 不可用
      isToday: day.is_today === true,
    })),
  };
}

/** 领取今日签到（幂等：已领过时返回 claimed:false）。 */
export async function claimSignin() {
  const response = await authedFetch(SIGNIN_CLAIM_PATH + timezoneQuery(), {
    method: 'POST',
    headers: signinHeaders(),
    body: '{}',
  });
  const text = await response.text();
  if (!response.ok) {
    // 业务拒绝（如已领过）可能以 4xx 返回：返回幂等结果而不是抛错。
    const already = /already|claimed|已领取|重复/i.test(text);
    if (already) return { claimed: false, alreadyClaimed: true, dayNo: 0, points: 0 };
    throw classifyHttpError(response.status, text);
  }
  const payload = JSON.parse(text);
  const data = payload?.data ?? {};
  const result = Number(data.claim_result);
  return {
    claimed: result === 1,
    alreadyClaimed: result === 2 || Number(data?.panel?.scene) === 3,
    dayNo: Number(data.day_no) || 0,
    points: Number(data.points) || 0,
    expireAtMs: Number(data.expire_at_ms) || 0,
    requestId: typeof payload?.request_id === 'string' ? payload.request_id : undefined,
  };
}

/** 积分明细与汇总。 */
export async function fetchCredits() {
  const response = await authedFetch(CREDIT_DETAILS_PATH, { method: 'GET' });
  const text = await response.text();
  if (!response.ok) throw classifyHttpError(response.status, text);
  const payload = JSON.parse(text);
  const details = (Array.isArray(payload?.details) ? payload.details : []).map((entry) => ({
    creditType: Number(entry.credit_type) || 0,
    granted: Number(entry.granted_amount) || 0,
    remaining: Number(entry.remaining_amount) || 0,
    consumed: Number(entry.consumed_amount) || 0,
    grantedAtMs: Number(entry.granted_at_ms) || 0,
    expireAtMs: Number(entry.expire_at_ms) || 0,
  }));
  let granted = 0;
  let remaining = 0;
  let consumed = 0;
  for (const entry of details) {
    granted += entry.granted;
    remaining += entry.remaining;
    consumed += entry.consumed;
  }
  return { granted, remaining, consumed, details };
}

export { MiniMaxAuthError };
