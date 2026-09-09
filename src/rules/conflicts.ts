import { fingerprint as fp } from '../util/misc';
import type { FindingDraft, PageContext } from './types';
import { baseRankScore } from './types';

const EXCLUDE_CONTEXT =
  /(起步价|起价|最低|低至|\d\s*元?\s*起|from\s|starting\s+(?:at|from)|as\s+low\s+as|原价|示例|举例|例如|比如|for\s+example|e\.g\.|参考价|曾为|was\s)/i;

const TYPE_LABEL: Record<string, string> = {
  price: '价格',
  trial_days: '免费试用天数',
  refund_days: '退款期限',
  quota: '使用额度',
  availability: '功能状态',
};

interface Entry {
  page: PageContext;
  fact: PageContext['facts'][number];
}

/**
 * 跨页面事实冲突候选生成。
 *
 * 分组键已包含币种与计费周期，因此月付与年付、不同币种不会互相比较。
 * 起步价、示例数据和历史文章均被排除。
 */
export function conflictCandidates(pages: PageContext[]): FindingDraft[] {
  const groups = new Map<string, Entry[]>();

  for (const page of pages) {
    for (const fact of page.facts) {
      const list = groups.get(fact.groupKey) ?? [];
      // 同一页面同值只保留一条
      if (list.some((e) => e.page.id === page.id && e.fact.normalizedValue === fact.normalizedValue)) continue;
      list.push({ page, fact });
      groups.set(fact.groupKey, list);
    }
  }

  const out: FindingDraft[] = [];

  for (const [groupKey, entries] of groups) {
    if (entries.length < 2) continue;
    const values = new Set(entries.map((e) => e.fact.normalizedValue));
    if (values.size < 2) continue;

    const pageIds = new Set(entries.map((e) => e.page.id));
    if (pageIds.size < 2) continue;

    const factType = entries[0].fact.factType;

    // 日期由专门的「过期日期」规则处理；不同页面出现不同日期是正常现象
    if (factType === 'date') continue;
    // 功能状态冲突置信度只有 0.35，价值不足且维护成本不低，已按规则审核结果移除
    if (factType === 'availability') continue;

    // 历史发布文章不作为冲突来源：博客里的旧价格/旧政策不代表当前事实
    const kept = entries.filter((e) => e.page.pageType !== 'blog');
    if (kept.length < 2) continue;
    if (new Set(kept.map((e) => e.page.id)).size < 2) continue;
    if (new Set(kept.map((e) => e.fact.normalizedValue)).size < 2) continue;

    // 起步价 / 示例数据不比较（只在数值所在的那句话里判断，避免被上下文其他词误伤）
    if (kept.some((e) => EXCLUDE_CONTEXT.test(sentenceOf(e.fact.contextText, e.fact.rawText)))) continue;

    entries.length = 0;
    entries.push(...kept);

    // 博客作为一侧时降低可信度，但仍可作为候选
    const involvesBlog = entries.some((e) => e.page.pageType === 'blog');

    // 每个值取最重要的一页作为代表
    const byValue = new Map<string, Entry[]>();
    for (const e of entries) {
      const list = byValue.get(e.fact.normalizedValue) ?? [];
      list.push(e);
      byValue.set(e.fact.normalizedValue, list);
    }
    const rankedValues = Array.from(byValue.entries())
      .map(([value, list]) => ({
        value,
        entry: list.slice().sort((a, b) => b.page.importance - a.page.importance)[0],
        count: new Set(list.map((l) => l.page.id)).size,
      }))
      .sort((a, b) => b.count - a.count || b.entry.page.importance - a.entry.page.importance);

    const a = rankedValues[0];
    const b = rankedValues[1];
    if (!a || !b) continue;

    let confidence = 0.5;
    if (factType === 'price') confidence = involvesBlog ? 0.6 : 0.8;
    else if (factType === 'trial_days' || factType === 'refund_days') confidence = involvesBlog ? 0.6 : 0.78;
    else if (factType === 'quota') confidence = 0.5;

    if (a.entry.fact.qualifier !== b.entry.fact.qualifier) confidence -= 0.15;
    if (a.entry.fact.unit !== b.entry.fact.unit) continue;

    // 不同套餐额度天然不同，quota 只作为「值得一看」的信息，不进 warning
    const severity = factType === 'quota' ? 'info' : 'warning';
    const label = TYPE_LABEL[factType] ?? factType;
    const entityLabel = humanEntity(a.entry.fact.entityKey, factType);

    const draft: FindingDraft = {
      findingType: `conflict_${factType}`,
      fingerprint: fp(['conflict', groupKey, sortedValues(values)]),
      severity,
      title: `${label}在不同页面不一致`,
      summary: buildSummary(factType, entityLabel, a, b),
      pageResultIds: Array.from(new Set([a.entry.page.id, b.entry.page.id])),
      evidence: {
        side_a: {
          url: a.entry.page.finalUrl || a.entry.page.url,
          page_type: a.entry.page.pageType,
          title: a.entry.page.title,
          quote: a.entry.fact.contextText ?? a.entry.fact.rawText,
          note: `值：${a.entry.fact.rawText}`,
        },
        side_b: {
          url: b.entry.page.finalUrl || b.entry.page.url,
          page_type: b.entry.page.pageType,
          title: b.entry.page.title,
          quote: b.entry.fact.contextText ?? b.entry.fact.rawText,
          note: `值：${b.entry.fact.rawText}`,
        },
      },
      recommendation: `请人工核对这两处关于${label}的表述，确认哪一个是当前有效的，并统一更新。`,
      confidence,
      detectionMethod: 'heuristic',
      rankScore: 0,
      aiReview: {
        kind: factType,
        entityLabel,
        valueA: a.entry.fact.rawText,
        valueB: b.entry.fact.rawText,
        quoteA: a.entry.fact.contextText ?? a.entry.fact.rawText,
        quoteB: b.entry.fact.contextText ?? b.entry.fact.rawText,
        urlA: a.entry.page.finalUrl || a.entry.page.url,
        urlB: b.entry.page.finalUrl || b.entry.page.url,
        pageTypeA: a.entry.page.pageType,
        pageTypeB: b.entry.page.pageType,
      },
    };
    draft.rankScore = baseRankScore(
      severity,
      'heuristic',
      Math.max(a.entry.page.importance, b.entry.page.importance),
      pageIds.size,
      confidence
    );
    out.push(draft);
  }

  return out;
}

/** 取包含该数值的那一句话，用于判断「起 / 例如 / 原价」等排除语境。 */
function sentenceOf(context: string | null, rawText: string): string {
  if (!context) return '';
  const segments = context.split(/[。！？!?；;\n]/);
  const hit = segments.find((s) => rawText && s.includes(rawText));
  return hit ?? context;
}

function sortedValues(values: Set<string>): string {
  return Array.from(values).sort().join(',');
}

function humanEntity(entityKey: string, factType: string): string {
  if (factType === 'refund_days' || factType === 'trial_days') return '该网站';
  if (entityKey === 'default' || entityKey === 'policy') return '该网站';
  return entityKey;
}

function buildSummary(
  factType: string,
  entityLabel: string,
  a: { value: string; entry: Entry },
  b: { value: string; entry: Entry }
): string {
  const unitA = a.entry.fact.unit ? ` ${a.entry.fact.unit}` : '';
  const unitB = b.entry.fact.unit ? ` ${b.entry.fact.unit}` : '';
  const qualifier = a.entry.fact.qualifier && a.entry.fact.qualifier !== 'unspecified'
    ? `（${qualifierLabel(a.entry.fact.qualifier)}）`
    : '';
  const label = TYPE_LABEL[factType] ?? factType;
  return `关于「${entityLabel}」的${label}，一个页面写的是 ${a.value}${unitA}${qualifier}，另一个页面写的是 ${b.value}${unitB}。两者可能描述的是同一件事，也可能分别对应不同套餐或时期，需要人工确认。`;
}

function qualifierLabel(q: string): string {
  switch (q) {
    case 'monthly':
      return '按月';
    case 'yearly':
      return '按年';
    case 'one-time':
      return '一次性';
    case 'trial':
      return '试用';
    case 'refund_window':
      return '退款期限';
    case 'limit':
      return '额度';
    case 'feature_state':
      return '功能状态';
    default:
      return '未注明周期';
  }
}
