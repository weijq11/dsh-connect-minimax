/**
 * 只读读取本机 MiniMax Code 桌面应用保存的 OAuth 登录凭据。
 *
 * 策略：插件绝不自行刷新令牌。MiniMax 的 refresh token 是一次性轮换的，
 * 官方桌面应用是刷新的唯一所有者；插件只读取它写好的 auth.json
 * （access token 约 1 小时有效），过期后提示用户打开桌面应用即可。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUTH_ROOT = join(homedir(), '.minimax', 'auth');
const SERVICE_PREFIX = 'com.minimax.mcode.oauth.';
const CACHE_TTL_MS = 30_000;
/** 提前 30 秒视为过期，避免请求中途失效。 */
const EXPIRY_MARGIN_MS = 30_000;

export class MiniMaxAuthError extends Error {
  /**
   * @param {'AUTH_MISSING'|'AUTH_EXPIRED'|'AUTH_CORRUPT'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'MiniMaxAuthError';
    this.code = code;
  }
}

let cache = undefined; // { credential, readAt }

/** 扫描本机全部已登录命名空间（<root>/<buildEnv>/<region>/mcode-public/auth.json）。 */
export function authNamespaces(root = AUTH_ROOT) {
  const found = [];
  let buildEnvs = [];
  try {
    buildEnvs = existsSync(root) ? readdirSafe(root) : [];
  } catch {
    return found;
  }
  for (const buildEnv of buildEnvs) {
    for (const region of readdirSafe(join(root, buildEnv))) {
      const authPath = join(root, buildEnv, region, 'mcode-public', 'auth.json');
      if (existsSync(authPath)) {
        found.push({ buildEnv, region, authPath });
      }
    }
  }
  return found;
}

function readdirSafe(dir) {
  try {
    return existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

/** 解析一个 auth.json：按 service 前缀挑 generation 最新的一条凭据。 */
function parseAuthFile(authPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch (error) {
    throw new MiniMaxAuthError('AUTH_CORRUPT', `MiniMax Code 凭据文件读取失败（${authPath}）：${error.message}`);
  }
  const records = raw && typeof raw === 'object' ? raw.records ?? {} : {};
  let best = null;
  for (const [key, record] of Object.entries(records)) {
    if (!key.startsWith(SERVICE_PREFIX) || !record || typeof record !== 'object') continue;
    const accessToken = typeof record.accessToken === 'string' ? record.accessToken : '';
    if (!accessToken.startsWith('mmoat_')) continue;
    const expiresAtMs = Number(record.expiresAtMs) || 0;
    const generation = Number(record.generation) || 0;
    if (!best || expiresAtMs > best.expiresAtMs || (expiresAtMs === best.expiresAtMs && generation > best.generation)) {
      best = {
        accessToken,
        refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : '',
        tokenType: typeof record.tokenType === 'string' ? record.tokenType : 'Bearer',
        clientId: record.clientId ?? '',
        audience: record.audience ?? '',
        scopes: Array.isArray(record.scopes) ? record.scopes : [],
        expiresAtMs,
        generation,
        accountKey: key,
      };
    }
  }
  if (!best) {
    throw new MiniMaxAuthError('AUTH_CORRUPT', `MiniMax Code 凭据文件里没有可用的访问令牌（${authPath}）`);
  }
  best.authPath = authPath;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(authPath).mtimeMs;
  } catch {
    /* 忽略 */
  }
  best.authMtimeMs = mtimeMs;
  return best;
}

/**
 * 读取当前登录凭据（带 30 秒缓存；auth.json 变更（mtime 变化）自动失效）。
 * @returns 凭据对象；机器上没有任何 MiniMax Code 命名空间时返回 null。
 */
export function readCredential({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.readAt < CACHE_TTL_MS) {
    return cache.credential;
  }
  const namespaces = authNamespaces();
  if (namespaces.length === 0) {
    cache = { credential: null, readAt: Date.now() };
    return null;
  }
  // prod/cn 优先，其余按 auth.json 修改时间取最新。
  let picked = namespaces.find((ns) => ns.buildEnv === 'prod' && ns.region === 'cn')
    ?? namespaces.slice().sort((a, b) => mtimeOf(b.authPath) - mtimeOf(a.authPath))[0];
  let credential = null;
  const errors = [];
  for (const ns of [picked, ...namespaces.filter((ns2) => ns2 !== picked)]) {
    try {
      credential = parseAuthFile(ns.authPath);
      credential.namespace = { buildEnv: ns.buildEnv, region: ns.region };
      break;
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!credential) {
    throw new MiniMaxAuthError('AUTH_CORRUPT', errors.join('；') || 'MiniMax Code 凭据不可用');
  }
  cache = { credential, readAt: Date.now() };
  return credential;
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** 丢弃缓存（收到 401/403 时调用，下一次读取会重读 auth.json）。 */
export function invalidateCredential() {
  cache = undefined;
}

/**
 * 取一个当前可用的 access token；缺失或过期抛 MiniMaxAuthError。
 * @param {{ force?: boolean }} [options]
 */
export function credentialForRequest(options = {}) {
  const credential = readCredential(options);
  if (!credential) {
    throw new MiniMaxAuthError(
      'AUTH_MISSING',
      '未找到 MiniMax Code 登录凭据：请打开 MiniMax Code 桌面应用并登录后重试',
    );
  }
  if (Date.now() >= credential.expiresAtMs - EXPIRY_MARGIN_MS) {
    // 先强制重读一次（桌面应用可能刚刚刷新过）。
    const fresh = readCredential({ force: true });
    if (!fresh || Date.now() >= fresh.expiresAtMs - EXPIRY_MARGIN_MS) {
      throw new MiniMaxAuthError(
        'AUTH_EXPIRED',
        'MiniMax Code 登录已过期：请打开 MiniMax Code 桌面应用刷新登录后重试（插件不自行刷新，避免与官方应用争用一次性刷新令牌）',
      );
    }
    return fresh;
  }
  return credential;
}
