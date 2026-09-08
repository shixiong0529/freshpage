import { extractDates, isPastDate } from '../extract/facts';
import { fingerprint as fp } from '../util/misc';
import { urlKey } from '../security/url';
import type { FindingDraft, PageContext } from './types';
import { baseRankScore } from './types';

/**
 * 明确过期日期候选。
 * 只有满足以下之一才报告，避免把正常的历史日期当成问题：
 * 1. 日期周边存在「截止 / 报名 / 限时 / 今年 / 最新 / 即将」等促销语境；
 * 2. 日期出现在页面主标题或 H1 中；
 * 3. 日期与「活动/促销/报名」类关键词直接相邻。
 */
export function expiredDateFindings(pages: PageContext[]): FindingDraft[] {
  const out: FindingDraft[] = [];

  for (const page of pages) {
    const dates = extractDates(page.extracted.text);
    if (dates.length === 0) continue;

    const published = page.extracted.meta.published ? page.extracted.meta.published.slice(0, 10) : null;

    for (const d of dates) {
      if (!isPastDate(d.iso, d.precision)) continue;
      // 博客发布时间不当作过期内容
      if (published && d.iso === published) continue;
      if (page.pageType === 'blog' && d.kind !== 'promo') continue;

      const inHeadline = Boolean(
        (page.title && page.title.includes(d.raw)) ||
          (page.h1 && page.h1.includes(d.raw)) ||
          (page.h1 && d.raw && page.h1.replace(/\s/g, '').includes(d.raw.replace(/\s/g, '')))
      );
      if (!inHeadline && d.kind !== 'promo') continue;

      const quote = d.context;
      const draft: FindingDraft = {
        findingType: 'expired_date',
        fingerprint: fp(['expired_date', urlKey(page.url), d.raw]),
        severity: 'warning',
        title: inHeadline ? '标题中包含已过去的日期' : '页面中出现疑似过期的日期',
        summary: `页面中出现的「${d.raw}」已经过去，且周边语境包含活动、截止或「今年 / 最新」等表述。请确认这段内容是否仍然有效。`,
        pageResultIds: [page.id],
        evidence: {
          side_a: {
            url: page.finalUrl || page.url,
            page_type: page.pageType,
            title: page.title,
            quote,
            note: '原文中出现的位置',
          },
        },
        recommendation: '确认该活动或信息是否仍然有效；如已过期，请更新或移除相应内容。',
        confidence: inHeadline ? 0.85 : 0.6,
        detectionMethod: 'heuristic',
        rankScore: 0,
      };
      draft.rankScore = baseRankScore('warning', 'heuristic', page.importance, 1, draft.confidence);
      out.push(draft);
    }
  }

  return out;
}
