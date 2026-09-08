import { fingerprint as fp } from '../util/misc';
import { urlKey } from '../security/url';
import type { PageContext } from './types';
import { baseRankScore, quoteOf } from './types';

export interface LinkCheckResult {
  target: string;
  status: number | null;
  errorCode: string | null;
  sources: PageContext[];
}

/**
 * 失效站内链接：同一个失效目标合并为一条结果，并展示所有来源页面。
 */
export function brokenLinkFindings(results: LinkCheckResult[]): Array<{
  draft: import('./types').FindingDraft;
  sources: PageContext[];
  target: string;
}> {
  const out: Array<{ draft: import('./types').FindingDraft; sources: PageContext[]; target: string }> = [];

  for (const r of results) {
    if (!isBroken(r)) continue;
    const sources = dedupeSources(r.sources);
    if (sources.length === 0) continue;

    const statusText =
      r.status && r.status >= 400
        ? `返回 ${r.status} 状态码`
        : r.errorCode === 'TIMEOUT'
          ? '请求超时'
          : r.errorCode === 'DNS_FAILURE'
            ? '域名无法解析'
            : r.errorCode === 'REDIRECT_LOOP'
              ? '存在重定向循环'
              : r.errorCode === 'TOO_MANY_REDIRECTS'
                ? '重定向次数过多'
                : '无法访问';

    const important = sources.some((s) => s.pageType === 'home' || s.pageType === 'pricing' || s.isSubmitted);
    const severity = r.status === 404 || r.status === 410 ? (important ? 'critical' : 'warning') : 'warning';

    const evidenceSources = sources.slice(0, 6).map((s) => ({
      url: s.finalUrl || s.url,
      page_type: s.pageType,
      title: s.title,
      quote: quoteOf(s.extracted.text, extractAnchorText(s, r.target), 70) || r.target,
      note: '页面中的链接',
    }));

    const draft: import('./types').FindingDraft = {
      findingType: 'broken_internal_link',
      fingerprint: fp(['broken_internal_link', urlKey(r.target)]),
      severity,
      title: sources.length > 1 ? `有 ${sources.length} 个页面指向失效的链接` : '页面中存在失效链接',
      summary: `链接 ${r.target} ${statusText}。该链接出现在 ${sources.length} 个页面中。`,
      pageResultIds: sources.map((s) => s.id),
      evidence: {
        side_a: { url: r.target, quote: r.target, note: `失效目标（${statusText}）` },
        sources: evidenceSources,
      },
      recommendation: `检查 ${r.target} 是否仍然存在。若页面已迁移，请把链接更新为新地址；若已下线，请删除这些链接。`,
      confidence: 1,
      detectionMethod: 'deterministic',
      rankScore: 0,
    };
    draft.rankScore = baseRankScore(
      severity,
      'deterministic',
      Math.max(...sources.map((s) => s.importance)),
      sources.length,
      1
    );
    out.push({ draft, sources, target: r.target });
  }

  return out;
}

function isBroken(r: LinkCheckResult): boolean {
  if (r.status !== null && r.status >= 400) return true;
  if (r.errorCode === 'TIMEOUT' || r.errorCode === 'REDIRECT_LOOP' || r.errorCode === 'TOO_MANY_REDIRECTS') return true;
  return false;
}

function dedupeSources(sources: PageContext[]): PageContext[] {
  const seen = new Set<number>();
  const out: PageContext[] = [];
  for (const s of sources) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out.sort((a, b) => b.importance - a.importance);
}

function extractAnchorText(page: PageContext, target: string): string {
  const link = page.extracted.links.find((l) => l.href === target);
  return link?.text || '';
}
