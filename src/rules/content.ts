import { detectPlaceholders } from '../extract/html';
import { fingerprint as fp } from '../util/misc';
import { urlKey } from '../security/url';
import type { FindingDraft, PageContext } from './types';
import { baseRankScore } from './types';
import type { Severity } from '../types';

/**
 * 基础内容异常（确定性检查）。
 * 为避免噪音，低价值页面只上报信息级问题。
 */
export function contentFindings(pages: PageContext[]): FindingDraft[] {
  const out: FindingDraft[] = [];

  for (const page of pages) {
    const importance = page.importance;
    const isKeyPage = page.isSubmitted || importance >= 0.7;

    if (!page.title || page.title.trim().length === 0) {
      out.push(
        make(page, 'empty_title', isKeyPage ? 'warning' : 'info', '页面缺少标题', '该页面没有设置 <title>，浏览器标签和搜索结果会显示为空。', '为该页面补充一个能概括内容的标题。', 1, 'deterministic')
      );
    }

    if ((!page.h1 || page.h1.trim().length === 0) && importance >= 0.45) {
      out.push(
        make(page, 'empty_h1', isKeyPage ? 'warning' : 'info', '页面缺少主标题', '该页面没有 H1 主标题，读者和搜索引擎都难以判断页面主题。', '为页面添加一个明确的 H1 主标题。', 1, 'deterministic')
      );
    }

    if (page.extracted.textLength < 150 && importance >= 0.45) {
      out.push(
        make(
          page,
          'thin_content',
          'warning',
          '页面正文内容很少',
          `该页面可读取的正文只有约 ${page.extracted.textLength} 个字符，可能是空页面、需要 JavaScript 渲染，或内容加载失败。`,
          '确认页面在浏览器中是否正常显示内容；若依赖脚本加载，请提供可直接读取的内容。',
          0.8,
          'deterministic'
        )
      );
    }

    const placeholders = detectPlaceholders(page.extracted.text, page.title);
    for (const ph of placeholders) {
      // 低置信度标记（TODO、${HOME}、localhost 示例）只在首页 / 价格页报告
      if (ph.level === 'low' && !(page.pageType === 'home' || page.pageType === 'pricing')) continue;
      const critical = ph.template && ph.level === 'high' && isKeyPage;
      const severity: Severity = critical ? 'critical' : 'warning';
      out.push({
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
        rankScore: 0,
      });
      const last = out[out.length - 1];
      last.rankScore = baseRankScore(severity, 'deterministic', importance, 1, 1);
    }
  }

  return out;
}

function make(
  page: PageContext,
  type: string,
  severity: Severity,
  title: string,
  summary: string,
  recommendation: string,
  confidence: number,
  method: 'deterministic' | 'heuristic'
): FindingDraft {
  const draft: FindingDraft = {
    findingType: type,
    fingerprint: fp([type, urlKey(page.url)]),
    severity,
    title,
    summary,
    pageResultIds: [page.id],
    evidence: {
      side_a: {
        url: page.finalUrl || page.url,
        page_type: page.pageType,
        title: page.title,
        quote: page.title ? page.title : page.url,
        note: '页面信息',
      },
    },
    recommendation,
    confidence,
    detectionMethod: method,
    rankScore: 0,
  };
  draft.rankScore = baseRankScore(severity, method, page.importance, 1, confidence);
  return draft;
}
