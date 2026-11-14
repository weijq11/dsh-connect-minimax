/**
 * 每日自动签到引擎：单实例串行、按本地日期去重、指数退避重试。
 * 状态文件只存进度（日期/结果/重试计数），不存任何凭据。
 */

import { claimSignin, fetchSigninStatus } from './mavis.js';
import { localDateKey, dshPath, readJsonFile, writeJsonFileAtomic } from './util.js';

const STATE_PATH = () => dshPath('.minimax-auto-checkin.json');
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

let running = false;
let lastAttemptAt = 0;
let lastResult = undefined; // 最近一次运行结果（内存）

function readState() {
  return readJsonFile(STATE_PATH(), { day: '', status: '', claimedAtMs: 0, failures: 0, retryAtMs: 0, lastError: '' });
}

function writeState(state) {
  writeJsonFileAtomic(STATE_PATH(), state);
}

/**
 * 立即尝试一次签到（幂等）：先查状态，可领才领。
 * @returns {{ attempted: boolean, claimed: boolean, alreadyClaimed: boolean, points: number, error?: string }}
 */
export async function runCheckinOnce() {
  const state = readState();
  const today = localDateKey();
  if (state.day !== today) {
    state.day = today;
    state.status = '';
    state.claimedAtMs = 0;
    state.failures = 0;
    state.retryAtMs = 0;
    state.lastError = '';
  }
  if (state.status === 'claimed') {
    return { attempted: false, claimed: false, alreadyClaimed: true, points: 0 };
  }
  try {
    const status = await fetchSigninStatus();
    const today0 = status.days.find((day) => day.isToday);
    if (!today0 || today0.status !== 2) {
      // 1=未到（不应发生）/3=已领/4=不可用：都按当日结束处理。
      state.status = today0?.status === 3 ? 'claimed' : 'unavailable';
      if (today0?.status === 3) state.claimedAtMs = Date.now();
      writeState(state);
      return { attempted: true, claimed: false, alreadyClaimed: today0?.status === 3, points: 0 };
    }
    const claim = await claimSignin();
    if (claim.claimed || claim.alreadyClaimed) {
      state.status = 'claimed';
      state.claimedAtMs = Date.now();
      state.failures = 0;
      state.retryAtMs = 0;
      state.lastError = '';
      writeState(state);
      lastResult = { at: Date.now(), day: today, ok: true, points: claim.points };
      return { attempted: true, claimed: claim.claimed, alreadyClaimed: claim.alreadyClaimed, points: claim.points };
    }
    // 业务未确认（claim_result 其他值）：按失败重试。
    throw new Error('签到返回了未确认的结果');
  } catch (error) {
    state.failures = (Number(state.failures) || 0) + 1;
    state.retryAtMs = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (state.failures - 1), RETRY_MAX_MS);
    state.lastError = String(error?.message ?? error).slice(0, 300);
    writeState(state);
    lastResult = { at: Date.now(), day: today, ok: false, error: state.lastError };
    return { attempted: true, claimed: false, alreadyClaimed: false, points: 0, error: state.lastError };
  }
}

/**
 * 由宿主定时器驱动的 tick：只在“当日未领且到达重试时刻”时发起。
 * @param {{ enabled: () => boolean }} options
 */
export async function tickCheckin(options = {}) {
  if (running) return null;
  if (options.enabled && options.enabled() === false) return null;
  const state = readState();
  const today = localDateKey();
  if (state.day === today && state.status === 'claimed') return null;
  const wait = Number(state.retryAtMs) || 0;
  if (wait > Date.now()) return null;
  // 串行保护 + 最小间隔，防止定时器堆积。
  if (Date.now() - lastAttemptAt < 15_000) return null;
  running = true;
  lastAttemptAt = Date.now();
  try {
    return await runCheckinOnce();
  } finally {
    running = false;
  }
}

/** 面板展示用的进度摘要。 */
export function checkinSnapshot() {
  const state = readState();
  return {
    day: state.day,
    status: state.status,
    claimedAtMs: Number(state.claimedAtMs) || 0,
    failures: Number(state.failures) || 0,
    retryAtMs: Number(state.retryAtMs) || 0,
    lastError: state.lastError ?? '',
    lastResult,
  };
}
