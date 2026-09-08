/**
 * robots.txt 解析与准入判断（User-agent: * 与本站 UA）。
 * 不依赖第三方库，覆盖 V0 需要的 Group / Allow / Disallow / Sitemap / Crawl-delay。
 */
import { safeFetch } from './fetcher';
import { config } from '../config';
import { logger } from '../util/logger';

export interface RobotsRules {
  /** 是否完全禁止本站 UA 抓取 */
  disallowAll: boolean;
  allowPatterns: string[];
  disallowPatterns: string[];
  sitemaps: string[];
  crawlDelayMs: number;
  /** 抓取 robots.txt 本身的结果，用于结果页说明 */
  fetchStatus: 'ok' | 'missing' | 'blocked' | 'error';
}

const EMPTY_ALLOWED: RobotsRules = {
  disallowAll: false,
  allowPatterns: [],
  disallowPatterns: [],
  sitemaps: [],
  crawlDelayMs: 0,
  fetchStatus: 'missing',
};

function toRegex(pattern: string): RegExp {
  // 支持 * 与 $（robots 简化语法）
  let out = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  out = out.replace(/\*/g, '.*');
  if (out.endsWith('\\$')) out = out.slice(0, -2) + '$';
  return new RegExp('^' + out);
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  const sitemaps: string[] = [];
  let crawlDelayMs = 0;

  interface Group {
    agents: string[];
    allow: string[];
    disallow: string[];
  }
  const groups: Group[] = [];
  let current: Group | null = null;

  const globalSitemaps = (): void => {
    /* sitemap 行与 group 无关，单独处理 */
  };
  void globalSitemaps;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.allow.length > 0 || current.disallow.length > 0) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'allow' && current) {
      current.allow.push(value);
    } else if (field === 'disallow' && current) {
      current.disallow.push(value);
    } else if (field === 'sitemap') {
      sitemaps.push(value);
    } else if (field === 'crawl-delay' && current) {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) crawlDelayMs = Math.max(crawlDelayMs, Math.round(n * 1000));
    }
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const matchGroup = specific ?? groups.find((g) => g.agents.includes('*'));

  if (!matchGroup) {
    return { ...EMPTY_ALLOWED, sitemaps, crawlDelayMs, fetchStatus: 'ok' };
  }

  const disallowAll =
    matchGroup.disallow.some((d) => d === '/') && !matchGroup.allow.some((a) => a === '/' || a.length > 1);

  return {
    disallowAll,
    allowPatterns: matchGroup.allow.filter((a) => a !== ''),
    disallowPatterns: matchGroup.disallow.filter((d) => d !== ''),
    sitemaps,
    crawlDelayMs,
    fetchStatus: 'ok',
  };
}

export function isAllowed(rules: RobotsRules, url: URL): boolean {
  if (rules.disallowAll) return false;
  const path = url.pathname + (url.search || '');
  // Allow 优先于 Disallow（采用最长匹配原则的简化实现）
  const allowMatch = rules.allowPatterns
    .map(toRegex)
    .filter((r) => r.test(path))
    .sort((a, b) => b.source.length - a.source.length)[0];
  const disallowMatch = rules.disallowPatterns
    .map(toRegex)
    .filter((r) => r.test(path))
    .sort((a, b) => b.source.length - a.source.length)[0];

  if (allowMatch && disallowMatch) {
    return allowMatch.source.length >= disallowMatch.source.length;
  }
  if (disallowMatch) return false;
  return true;
}

export async function fetchRobots(rootUrl: string): Promise<RobotsRules> {
  let origin: string;
  try {
    origin = new URL(rootUrl).origin;
  } catch {
    return { ...EMPTY_ALLOWED, fetchStatus: 'error' };
  }
  const res = await safeFetch(`${origin}/robots.txt`, {
    timeoutMs: Math.min(config.requestTimeoutMs, 8000),
    maxBytes: 512_000,
  });
  if (res.status === 404 || res.status === 410) {
    return { ...EMPTY_ALLOWED, fetchStatus: 'missing' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...EMPTY_ALLOWED, fetchStatus: 'blocked', disallowAll: true };
  }
  if (!res.body || res.errorCode) {
    logger.debug('robots.txt unavailable', { rootUrl, code: res.errorCode });
    return { ...EMPTY_ALLOWED, fetchStatus: 'error' };
  }
  return parseRobots(res.body, config.userAgent);
}
