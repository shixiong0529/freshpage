/**
 * 页面发现：优先级排序、排除规则与去重队列。
 */
import { isSameSite, normalizeDomain, urlKey } from '../security/url';
import type { PageType } from '../types';

const EXCLUDED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic',
  'mp4', 'mp3', 'wav', 'webm', 'ogg', 'mov', 'avi',
  'pdf', 'zip', 'rar', 'gz', 'tar', '7z', 'bz2', 'xz', 'exe', 'dmg', 'apk', 'msi', 'deb', 'rpm',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'css', 'js', 'mjs', 'map', 'json', 'xml', 'txt',
]);

const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /\/(search|searchresults)\b/i,
  /\/(tag|tags|topic|topics)\//i,
  /\/(category|categories)\//i,
  /\/(author|authors)\//i,
  /\/(calendar|archive|archives)\//i,
  /\/(feed|rss|atom)(\/|$|\.)/i,
  /\/(logout|signout|sign-out|sign_out|delete|remove|unsubscribe|destroy)\b/i,
  /\/(login|signin|sign-in|signup|sign-up|register|account|cart|checkout|admin|dashboard|settings)\b/i,
  /\/(wp-admin|wp-login|wp-json|wp-content)\b/i,
  /\/(cdn-cgi|cdn)\//i,
  /\/(print|share|email|printview)\b/i,
  /\/(page|pages)\/(\d+)/i,
];

const EXCLUDED_QUERY_KEYS = ['s', 'q', 'query', 'search', 'keyword', 'keywords', 'utm_source'];

const PAGINATION_KEYS = ['page', 'p', 'paged', 'offset'];

export interface QueueItem {
  url: string;
  depth: number;
  score: number;
  source: 'submitted' | 'sitemap' | 'link';
}

export class PageQueue {
  private items: QueueItem[] = [];
  private seen = new Set<string>();

  push(item: QueueItem): boolean {
    const key = urlKey(item.url);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.items.push(item);
    return true;
  }

  has(url: string): boolean {
    return this.seen.has(urlKey(url));
  }

  pop(): QueueItem | undefined {
    if (this.items.length === 0) return undefined;
    let bestIndex = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i];
      const b = this.items[bestIndex];
      if (a.score > b.score || (a.score === b.score && a.depth < b.depth)) bestIndex = i;
    }
    return this.items.splice(bestIndex, 1)[0];
  }

  get size(): number {
    return this.items.length;
  }

  get seenCount(): number {
    return this.seen.size;
  }

  drain(): QueueItem[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

/** 判断 URL 是否应被默认排除（不抓取）。 */
export function isExcludedUrl(rawUrl: string, baseUrl: URL): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (!isSameSite(url, baseUrl)) return true;

  const pathname = url.pathname.toLowerCase();
  const ext = pathname.slice(pathname.lastIndexOf('.') + 1);
  if (pathname.includes('.') && EXCLUDED_EXTENSIONS.has(ext)) return true;

  if (EXCLUDED_PATH_PATTERNS.some((re) => re.test(pathname))) return true;

  for (const key of EXCLUDED_QUERY_KEYS) {
    if (url.searchParams.has(key)) return true;
  }
  for (const key of PAGINATION_KEYS) {
    const v = url.searchParams.get(key);
    if (v && /^\d+$/.test(v) && Number(v) > 1) return true;
  }
  // 大量 query 参数通常是追踪或筛选组合
  if (Array.from(url.searchParams.keys()).length > 6) return true;

  // 极长路径通常不是稳定内容页
  if (url.pathname.length > 220) return true;

  return false;
}

/** URL 中的中文路径是百分号编码的，需要先解码再匹配语义。 */
function decodePath(pathname: string): string {
  if (!pathname.includes('%')) return pathname;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

const TYPE_PATTERNS: Array<[PageType, RegExp]> = [
  ['pricing', /(pricing|price|plans?|billing|套餐|价格|定价|方案价格)/i],
  ['policy', /(refund|returns?|cancel|terms|privacy|legal|policy|policies|退款|取消|条款|隐私|协议)/i],
  ['help', /(help|docs?|support|faq|knowledge|documentation|帮助|文档|支持|常见问题)/i],
  ['features', /(features?|product|products?|solutions?|功能|产品|解决方案)/i],
  ['contact', /(contact|get-in-touch|联系|联系我们)/i],
  ['about', /(about|company|team|关于|团队|公司)/i],
  ['blog', /(blog|news|posts?|articles?|changelog|博客|新闻|文章|更新日志)/i],
];

export function classifyPageType(url: URL, title?: string | null, h1?: string | null): PageType {
  const path = decodePath(url.pathname);
  if (path === '/' || path === '') return 'home';
  // 先按 URL 路径判断，路径没有信号时才看标题，避免标题里的词误导分类
  for (const [type, re] of TYPE_PATTERNS) {
    if (re.test(path)) return type;
  }
  const haystack = `${title ?? ''} ${h1 ?? ''}`;
  for (const [type, re] of TYPE_PATTERNS) {
    if (re.test(haystack)) return type;
  }
  return 'other';
}

const TYPE_BASE_SCORE: Record<PageType, number> = {
  home: 100,
  pricing: 95,
  policy: 90,
  features: 85,
  help: 78,
  contact: 70,
  about: 62,
  blog: 30,
  other: 45,
};

/** 页面重要性：用于结果排序与严重度判断。 */
export function pageImportance(type: PageType): number {
  return TYPE_BASE_SCORE[type] / 100;
}

export function scoreUrl(url: URL, type: PageType, depth: number, source: QueueItem['source']): number {
  let score = TYPE_BASE_SCORE[type];
  score -= depth * 8;
  if (source === 'sitemap') score += 10;
  if (source === 'submitted') score += 25;
  // 路径过深适度降权
  const segments = url.pathname.split('/').filter(Boolean).length;
  if (segments > 3) score -= (segments - 3) * 3;
  return score;
}

export function sortSitemapUrls(urls: string[], baseUrl: URL): string[] {
  return urls
    .filter((u) => !isExcludedUrl(u, baseUrl))
    .map((u) => {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return null;
      }
      const type = classifyPageType(parsed);
      return { u, score: scoreUrl(parsed, type, 1, 'sitemap') };
    })
    .filter((x): x is { u: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.u);
}

export function domainOf(url: string): string {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}
