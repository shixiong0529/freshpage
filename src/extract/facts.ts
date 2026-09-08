/**
 * 结构化事实抽取：价格、试用期、退款期限、额度、日期与功能状态。
 * 抽取结果只作为「候选」，冲突判断由规则层按分组键比较，且必须保留币种与计费周期。
 */
import type { ExtractedPage, FactCandidate, PageType } from '../types';
import { contextAround, normalizeWhitespace } from '../util/misc';

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/(?:US\$|\bUSD\b)/i, 'USD'],
  [/(?:RMB|CNY|￥|¥)/i, 'CNY'],
  [/\$/, 'USD'],
  [/€|\bEUR\b/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/₩|\bKRW\b/i, 'KRW'],
  [/\bJPY\b/i, 'JPY'],
];

const PERIOD_PATTERNS: Array<[RegExp, string]> = [
  [/(per\s+month|\/\s?mo\b|monthly|每月|按月|月付|／月|\/\s?month)/i, 'monthly'],
  [/(per\s+year|\/\s?yr\b|annually|annual|per\s+annum|每年|按年|年付|\/\s?year)/i, 'yearly'],
  [/(one[- ]?time|lifetime|买断|一次性|终身)/i, 'one-time'],
];

const PLAN_WORDS =
  /(basic|starter|standard|pro|premium|plus|enterprise|business|team|growth|scale|free|基础版|标准版|专业版|旗舰版|企业版|团队版|免费版|高级版)/i;

function detectCurrency(snippet: string): string { // 保留兼容，供外部调用
  for (const [re, code] of CURRENCY_SYMBOLS) {
    if (re.test(snippet)) return code;
  }
  return 'UNKNOWN';
}

function detectPeriod(snippet: string): string { // 保留兼容，供外部调用
  for (const [re, key] of PERIOD_PATTERNS) {
    if (re.test(snippet)) return key;
  }
  return 'unspecified';
}

function normalizeAmount(raw: string): string {
  const n = Number.parseFloat(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return raw;
  return String(Math.round(n * 100) / 100);
}

/**
 * 在价格附近寻找「最近」的限定词，而不是取窗口内第一个匹配。
 * 否则一行里出现多个套餐时，月付/年付和币种会被串在一起，造成误判。
 */
function nearestToken(text: string, start: number, end: number, patterns: Array<[RegExp, string]>): string | null {
  const windowStart = Math.max(0, start - 70);
  const windowEnd = Math.min(text.length, end + 35);
  const window = text.slice(windowStart, windowEnd);
  const priceMid = (start + end) / 2 - windowStart;
  let best: { key: string; dist: number } | null = null;
  for (const [re, key] of patterns) {
    const scanner = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = scanner.exec(window)) !== null) {
      const mid = m.index + m[0].length / 2;
      const dist = Math.abs(mid - priceMid);
      if (!best || dist < best.dist) best = { key, dist };
    }
  }
  return best ? best.key : null;
}

function nearbyPlanName(text: string, index: number, length = 0): string {
  const key = nearestToken(text, index, index + length, [[PLAN_WORDS, '$']]);
  if (!key) return 'default';
  const windowStart = Math.max(0, index - 70);
  const m = text.slice(windowStart, index + length + 35).match(PLAN_WORDS);
  return m ? m[1].toLowerCase() : 'default';
}

function ctx(text: string, index: number, len: number): string {
  return contextAround(text, index + Math.floor(len / 2), 80);
}

export function extractFacts(page: ExtractedPage, url: URL, pageType: PageType): FactCandidate[] {
  const text = page.text || '';
  if (text.length === 0) return [];
  const facts: FactCandidate[] = [];

  /* ------------------------------ 价格 ------------------------------ */
  const priceRe =
    /(?:US\$|USD\s|RMB\s|CNY\s|￥|¥|\$|€|£)\s?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s?(?:元|块钱)(?!\w)/g;
  let m: RegExpExecArray | null;
  while ((m = priceRe.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const currency = nearestToken(text, m.index, m.index + m[0].length, CURRENCY_SYMBOLS) ?? 'UNKNOWN';
    const period = nearestToken(text, m.index, m.index + m[0].length, PERIOD_PATTERNS) ?? 'unspecified';
    const entity = nearbyPlanName(text, m.index, m[0].length);
    facts.push({
      factType: 'price',
      entityKey: entity,
      rawText: normalizeWhitespace(m[0]),
      normalizedValue: normalizeAmount(raw),
      unit: currency,
      qualifier: period,
      contextText: ctx(text, m.index, m[0].length),
      confidence: currency === 'UNKNOWN' ? 0.6 : 0.9,
      groupKey: `price:${entity}:${currency}:${period}`,
      index: m.index,
    });
  }

  /* ---------------------------- 免费试用 ---------------------------- */
  const trialPatterns: RegExp[] = [
    /(\d{1,3})\s*(?:天|日)\s*(?:的)?\s*(?:免费)?\s*试用/g,
    /免费试用\s*(\d{1,3})\s*(?:天|日)/g,
    /(\d{1,3})[- ]day\s+(?:free\s+)?trial/gi,
    /free\s+trial\s+(?:of\s+|for\s+)?(\d{1,3})\s*days?/gi,
    /trial[:：]?\s*(\d{1,3})\s*days?/gi,
  ];
  for (const re of trialPatterns) {
    while ((m = re.exec(text)) !== null) {
      const days = m[1];
      facts.push({
        factType: 'trial_days',
        entityKey: 'policy',
        rawText: normalizeWhitespace(m[0]),
        normalizedValue: String(Number.parseInt(days, 10)),
        unit: 'days',
        qualifier: 'trial',
        contextText: ctx(text, m.index, m[0].length),
        confidence: 0.9,
        groupKey: `trial_days:${nearbyPlanName(text, m.index, m[0].length)}`,
        index: m.index,
      });
    }
  }

  /* ---------------------------- 退款期限 ---------------------------- */
  const refundPatterns: RegExp[] = [
    /(\d{1,3})\s*(?:天|日)[^。.]{0,12}?(?:退款|无理由退换|money[- ]back|refund)/gi,
    /(?:退款|refund|money[- ]back)[^。.]{0,12}?(\d{1,3})\s*(?:天|日|days?)/gi,
    /(\d{1,3})[- ]day\s+(?:money[- ]back|refund)/gi,
  ];
  for (const re of refundPatterns) {
    while ((m = re.exec(text)) !== null) {
      facts.push({
        factType: 'refund_days',
        entityKey: 'policy',
        rawText: normalizeWhitespace(m[0]),
        normalizedValue: String(Number.parseInt(m[1], 10)),
        unit: 'days',
        qualifier: 'refund_window',
        contextText: ctx(text, m.index, m[0].length),
        confidence: 0.85,
        groupKey: 'refund_days:policy',
        index: m.index,
      });
    }
  }

  /* ------------------------------ 额度 ------------------------------ */
  const quotaRe =
    /(\d[\d,]*)\s*(?:个)?\s*(用户|席位|人|团队成员|seats?|users?|members?|projects?|项目|GB|MB|TB|requests?|请求|次|条|domains?|域名)/gi;
  while ((m = quotaRe.exec(text)) !== null) {
    const unitRaw = m[2].toLowerCase();
    const isStorage = /gb|mb|tb/.test(unitRaw);
    if (!isStorage && Number.parseInt(m[1].replace(/,/g, ''), 10) <= 1) continue;
    facts.push({
      factType: 'quota',
      entityKey: nearbyPlanName(text, m.index, m[0].length),
      rawText: normalizeWhitespace(m[0]),
      normalizedValue: normalizeAmount(m[1]),
      unit: unitRaw,
      qualifier: 'limit',
      contextText: ctx(text, m.index, m[0].length),
      confidence: 0.7,
      groupKey: `quota:${nearbyPlanName(text, m.index, m[0].length)}:${unitRaw}`,
      index: m.index,
    });
  }

  /* ------------------------------ 日期 ------------------------------ */
  for (const d of extractDates(text)) {
    facts.push({
      factType: 'date',
      entityKey: 'date',
      rawText: d.raw,
      normalizedValue: d.iso,
      unit: d.precision,
      qualifier: d.kind,
      contextText: d.context,
      confidence: 0.8,
      groupKey: `date:${d.kind}`,
      index: d.index,
    });
  }

  /* --------------------------- 功能可用状态 --------------------------- */
  const availabilityRe =
    /\b([A-Z][A-Za-z0-9 ]{2,28}|[\u4e00-\u9fa5]{2,10})\b[^。.\n]{0,20}?(is\s+)?(coming\s+soon|not\s+included|included\s+in\s+all\s+plans|beta|即将推出|即将上线|暂不支持|已包含|不包含)/gi;
  while ((m = availabilityRe.exec(text)) !== null) {
    const feature = normalizeWhitespace(m[1]).toLowerCase().slice(0, 30);
    const state = normalizeWhitespace(m[3]).toLowerCase();
    facts.push({
      factType: 'availability',
      entityKey: feature,
      rawText: normalizeWhitespace(m[0]).slice(0, 160),
      normalizedValue: state,
      unit: undefined,
      qualifier: 'feature_state',
      contextText: ctx(text, m.index, m[0].length),
      confidence: 0.5,
      groupKey: `availability:${feature}`,
      index: m.index,
    });
  }

  void url;
  void pageType;
  return dedupeFacts(facts);
}

/** 同一页面内相同分组键 + 相同值只保留一条，避免导航/页脚重复导致误判。 */
function dedupeFacts(facts: FactCandidate[]): FactCandidate[] {
  const seen = new Set<string>();
  const out: FactCandidate[] = [];
  for (const f of facts) {
    const key = `${f.groupKey}|${f.normalizedValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export interface DateHit {
  raw: string;
  iso: string;
  precision: 'day' | 'month' | 'year';
  kind: 'generic' | 'promo';
  context: string;
  index: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * 促销 / 时令语境。只保留明确表示「活动、截止、限时」的词；
 * until、ends 这类常见英文介词会造成大量误报，已从列表中移除。
 */
const PROMO_WORDS =
  /(截止|截止日期|截至|报名|活动|促销|限时|优惠|即将|即将开始|倒计时|今年|最新|本年度|deadline|register by|early bird|expires|valid through|limited time|sign up by|before\s)/i;

export function extractDates(text: string): DateHit[] {
  const out: DateHit[] = [];
  const push = (raw: string, iso: string, precision: DateHit['precision'], index: number): void => {
    const context = contextAround(text, index, 70);
    out.push({
      raw: normalizeWhitespace(raw),
      iso,
      precision,
      kind: PROMO_WORDS.test(context) ? 'promo' : 'generic',
      context,
      index,
    });
  };

  // ISO: 2026-09-08 / 2026/09/08
  const isoRe = /\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = isoRe.exec(text)) !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    push(m[0], `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 'day', m.index);
  }

  // 中文：2026年9月8日
  const cnRe = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
  while ((m = cnRe.exec(text)) !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    push(m[0], `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 'day', m.index);
  }

  // 英文：September 8, 2026 / Sep 8 2026
  const enRe1 = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/g;
  while ((m = enRe1.exec(text)) !== null) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) continue;
    push(m[0], `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`, 'day', m.index);
  }

  // 英文：8 September 2026
  const enRe2 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(20\d{2})\b/g;
  while ((m = enRe2.exec(text)) !== null) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) continue;
    push(m[0], `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`, 'day', m.index);
  }

  // 年月：2026年9月 / September 2026
  const ymRe = /(20\d{2})\s*年\s*(\d{1,2})\s*月/g;
  while ((m = ymRe.exec(text)) !== null) {
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) continue;
    push(m[0], `${m[1]}-${String(mo).padStart(2, '0')}`, 'month', m.index);
  }
  const enMonthRe = /\b([A-Za-z]{3,9})\.?\s+(20\d{2})\b/g;
  while ((m = enMonthRe.exec(text)) !== null) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) continue;
    push(m[0], `${m[2]}-${String(mo).padStart(2, '0')}`, 'month', m.index);
  }

  return dedupeDates(out);
}

/**
 * 同一个日期常被多种写法命中（2026年6月30日 同时匹配到「日」与「月」两种精度），
 * 必须去重：精确到日优先，并丢弃已被日精度覆盖的月精度结果。
 */
function dedupeDates(hits: DateHit[]): DateHit[] {
  const byIso = new Map<string, DateHit>();
  for (const h of hits) {
    const existing = byIso.get(h.iso);
    if (!existing || (existing.precision === 'month' && h.precision === 'day')) byIso.set(h.iso, h);
  }
  const dayMonths = new Set(
    Array.from(byIso.values())
      .filter((h) => h.precision === 'day')
      .map((h) => h.iso.slice(0, 7))
  );
  return Array.from(byIso.values()).filter((h) => !(h.precision === 'month' && dayMonths.has(h.iso)));
}

/** 判断日期是否已经过去（按精度比较，避免边界误判）。 */
export function isPastDate(iso: string, precision: 'day' | 'month' | 'year', now = new Date()): boolean {
  const nowIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const compareTo = precision === 'day' ? iso : `${iso}-01`;
  const base = precision === 'day' ? nowIso : `${nowIso.slice(0, 7)}-01`;
  return compareTo < base;
}
