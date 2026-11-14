/** 共享工具：DSH 家目录解析、本地时间、原子 JSON 文件读写。 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

let resolvedDshHome;
/** DSH 家目录（优先宿主包，退化到 ~/.dsh）。 */
export function dshHome() {
  if (resolvedDshHome) return resolvedDshHome;
  let home = join(homedir(), '.dsh');
  try {
    // 动态 import：宿主包缺失时插件其余功能不受影响。
    const mod = import('@deepseek-ai/dsh-home-paths');
    // 同步上下文里拿不到 async 结果：接受默认值，由调用处异步覆盖。
    void mod;
  } catch {
    /* 保持默认 */
  }
  resolvedDshHome = home;
  return home;
}

/** 异步解析 DSH 家目录（宿主包可用时以宿主为准）。 */
export async function resolveDshHomeAsync() {
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths');
    if (typeof mod.resolveDshHome === 'function') {
      resolvedDshHome = mod.resolveDshHome();
    }
  } catch {
    /* 保持默认 */
  }
  return resolvedDshHome ?? join(homedir(), '.dsh');
}

/** IANA 时区名（签到接口的 timezone_id）。 */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/** 本地日期键 YYYY-MM-DD（按本地时钟）。 */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 读 JSON 文件，不存在或损坏返回 fallback。 */
export function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON 文件（临时文件 + rename，0600）。 */
export function writeJsonFileAtomic(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** 合并路径片段到 DSH 家目录。 */
export function dshPath(...parts) {
  return join(dshHome(), ...parts);
}
