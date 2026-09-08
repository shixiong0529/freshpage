import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 向上查找 package.json 定位项目根目录，兼容 dist/src 与源码两种运行方式。 */
export function projectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** 生成不可枚举的结果页 token（160 bit 随机）。 */
export function randomToken(bytes = 20): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 稳定 fingerprint：用于同一根因的问题合并。 */
export function fingerprint(parts: Array<string | number | undefined | null>): string {
  return sha256(parts.map((p) => String(p ?? '')).join('|')).slice(0, 32);
}

export function hashIp(ip: string, salt: string): string {
  return sha256(`${salt}:${ip}`).slice(0, 32);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clampText(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, max) + '…';
}

/** 去空白并压缩连续空白字符，用于正文规范化。 */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** 从任意文本中抽取一段以关键词为中心的上下文。 */
export function contextAround(text: string, index: number, radius = 90): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '');
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  function next(): void {
    const job = queue.shift();
    if (job) job();
  }
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      if (active < concurrency) task();
      else queue.push(task);
    });
  };
}

/** 带超时的 Promise，避免外部依赖卡死整个扫描。 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export function todayIsoDate(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
