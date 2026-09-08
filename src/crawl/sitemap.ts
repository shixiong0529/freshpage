/**
 * sitemap 解析：支持 sitemap.xml、sitemap index 与 txt 形式，不使用第三方依赖。
 */
import { safeFetch } from './fetcher';
import { config } from '../config';

export interface SitemapResult {
  urls: string[];
  sitemapsScanned: number;
  truncated: boolean;
}

const MAX_SITEMAP_BYTES = 5_000_000;
const MAX_URLS = 5_000;
const MAX_CHILD_SITEMAPS = 10;

function extractLocs(xml: string, tagName: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, '')
      .trim();
    if (text) out.push(decodeXmlEntities(text));
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function isIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

export async function fetchSitemapUrls(rootUrl: string, declared: string[] = []): Promise<SitemapResult> {
  let origin = '';
  try {
    origin = new URL(rootUrl).origin;
  } catch {
    return { urls: [], sitemapsScanned: 0, truncated: false };
  }
  /** sitemap 中常见相对地址，必须基于站点根解析为绝对地址。 */
  const absolute = (loc: string): string | null => {
    try {
      return new URL(loc, origin).toString();
    } catch {
      return null;
    }
  };
  const candidates: string[] = declared.map((d) => absolute(d) ?? d);
  const common = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap.txt`,
  ];
  for (const c of common) if (!candidates.includes(c)) candidates.push(c);

  const urls: string[] = [];
  const seenSitemaps = new Set<string>();
  let scanned = 0;
  let truncated = false;

  for (const candidate of candidates) {
    if (scanned >= MAX_CHILD_SITEMAPS + 2) break;
    if (seenSitemaps.has(candidate)) continue;
    seenSitemaps.add(candidate);

    const res = await safeFetch(candidate, {
      timeoutMs: Math.min(config.requestTimeoutMs, 10_000),
      maxBytes: MAX_SITEMAP_BYTES,
      allowedContentTypes: ['text/xml', 'application/xml', 'text/plain', 'text/html', 'application/rss+xml'],
    });
    scanned++;
    if (!res.body || res.status !== 200) continue;

    const body = res.body;
    if (isIndex(body)) {
      const children = extractLocs(body, 'loc')
        .map(absolute)
        .filter((u): u is string => Boolean(u))
        .slice(0, MAX_CHILD_SITEMAPS);
      for (const child of children) {
        if (seenSitemaps.has(child) || scanned >= MAX_CHILD_SITEMAPS + 2) continue;
        seenSitemaps.add(child);
        const childRes = await safeFetch(child, {
          timeoutMs: Math.min(config.requestTimeoutMs, 10_000),
          maxBytes: MAX_SITEMAP_BYTES,
          allowedContentTypes: ['text/xml', 'application/xml', 'text/plain'],
        });
        scanned++;
        if (childRes.body && childRes.status === 200) {
          for (const loc of extractLocs(childRes.body, 'loc')) {
            const u = absolute(loc);
            if (!u) continue;
            if (urls.length < MAX_URLS) urls.push(u);
            else truncated = true;
          }
        }
      }
    } else {
      for (const loc of extractLocs(body, 'loc')) {
        const u = absolute(loc);
        if (!u) continue;
        if (urls.length < MAX_URLS) urls.push(u);
        else truncated = true;
      }
      if (!/<urlset|<url\b/i.test(body)) {
        // txt 形式：一行一个 URL
        for (const line of body.split(/\r?\n/)) {
          const t = line.trim();
          const u = absolute(t);
          if (u && /^https?:\/\//.test(u) && urls.length < MAX_URLS) urls.push(u);
        }
      }
    }
    if (urls.length >= MAX_URLS) {
      truncated = true;
      break;
    }
  }

  return { urls: Array.from(new Set(urls)), sitemapsScanned: scanned, truncated };
}
