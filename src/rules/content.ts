import { detectPlaceholders } from '../extract/html';
import { fingerprint as fp } from '../util/misc';
import { urlKey } from '../security/url';
import type { FindingDraft, PageContext } from './types';
import { baseRankScore } from './types';
import type { Severity } from '../types';

/**
 * 基础内容异常（确定性检查）。
 *
 * 只报「生产页面不该出现的内容」。缺少 title / H1、正文过短曾经也在这里报，
 * 已按 2026-09-09 的规则审核结果移除：前两条属于 SEO 建议，与「内容是否准确」无关；
 * 正文过短多数是抓取侧限制（SPA 未渲染、需要登录），报给站长等于误伤，
 * 该情况已由结果页「本次检查限制」说明覆盖。
 */
export function contentFindings(pages: PageContext[]): FindingDraft[] {
  const out: FindingDraft[] = [];

  for (const page of pages) {
    const importance = page.importance;
    const isKeyPage = page.isSubmitted || importance >= 0.7;

    const placeholders = detectPlaceholders(page.extracted.text, page.title);
    for (const ph of placeholders) {
      // 低置信度标记（TODO / FIXME、${...}、<%= %>）只在首页 / 价格页报
      if (ph.level === 'low' && !(page.pageType === 'home' || page.pageType === 'pricing')) continue;
      const critical = ph.template && ph.level === 'high' && isKeyPage;
      const severity: Severity = critical ? 'critical' : 'warning';
      const draft: FindingDraft = {
        findingType: 'placeholder_content',
        fingerprint: fp(['placeholder_content', urlKey(page.url), ph.label]),
        severity,
        title: critical ? '页面中存在未替换的模板变量' : '页面中存在占位内容',
        summary: `在页面中发现了${ph.label}，生产环境的页面不应出现这类内容。`,
        pageResultIds: [page.id],
        evidence: {
          side_a: {
            url: page.finalUrl || page.url,
            page_type: page.pageType,
            title: page.title,
            quote: ph.quote,
            note: '原文中出现的位置',
          },
        },
        recommendation: critical
          ? '把模板变量替换为真实内容后再发布。'
          : '删除或替换示例文本，确保访问者看到的是真实内容。',
        confidence: 1,
        detectionMethod: 'deterministic',
        rankScore: baseRankScore(severity, 'deterministic', importance, 1, 1),
      };
      out.push(draft);
    }
  }

  return out;
}
