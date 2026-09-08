/**
 * AI 辅助复核。
 *
 * 约束（对应方案 6.3）：
 * - 只处理规则已经发现的少量候选，绝不自由发挥；
 * - 不联网搜索，不宣称某价格或政策一定错误；
 * - 输出必须包含指定字段；
 * - 失败、超时或返回不可解析时安全降级：不影响确定性结果，候选按启发式结果保留或丢弃。
 */
import { config } from '../config';
import type { AiReviewInput } from '../rules/types';
import { logger } from '../util/logger';

export interface AiVerdict {
  is_suspected_issue: boolean;
  confidence: number;
  summary: string;
  evidence_a: string;
  evidence_b: string;
  possible_explanation: string;
  recommended_check: string;
}

export type AiStatus = 'ok' | 'disabled' | 'no_key' | 'timeout' | 'error' | 'invalid_response';

export interface AiReviewResult {
  status: AiStatus;
  verdicts: Array<AiVerdict | null>;
}

const SYSTEM_PROMPT = `你是一个网站内容一致性检查助手，只做「判断两段来自同一网站的页面原文是否可能在描述同一件事且数值不一致」。

严格约束：
1. 只能使用用户提供的原文，不得联网、不得猜测、不得引入外部知识。
2. 不得断言某个价格或政策"错误"，只能说"疑似不一致，需要人工确认"。
3. 以下情况不是冲突，必须判定 is_suspected_issue=false：
   - 月付与年付；不同币种；不同地区或国家；限时促销；历史发布文章；起步价与固定价；示例数据；不同产品恰好同名。
4. 如果两段原文描述的对象不同（例如不同套餐、不同产品、不同时期），判定为 false。
5. confidence 取值 0~1，只有证据充分时才给 0.7 以上。
6. 输出必须是 JSON 对象，格式：
{"results":[{"is_suspected_issue":true,"confidence":0.8,"summary":"...","evidence_a":"...","evidence_b":"...","possible_explanation":"...","recommended_check":"..."}]}
其中 evidence_a / evidence_b 必须原样引用用户给出的原文片段。summary 用中文，面向非技术用户，语气中性。`;

function buildUserPrompt(candidates: AiReviewInput[]): string {
  const items = candidates.map((c, i) => {
    return [
      `候选 ${i + 1}`,
      `类型：${c.kind}`,
      `对象：${c.entityLabel}`,
      `A 页面（${c.pageTypeA}）：${c.urlA}`,
      `A 值：${c.valueA}`,
      `A 原文：${truncate(c.quoteA, 400)}`,
      `B 页面（${c.pageTypeB}）：${c.urlB}`,
      `B 值：${c.valueB}`,
      `B 原文：${truncate(c.quoteB, 400)}`,
    ].join('\n');
  });
  return `${items.join('\n\n')}\n\n请对以上 ${candidates.length} 个候选逐一判断，并按顺序输出 results 数组。`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export async function reviewCandidates(candidates: AiReviewInput[]): Promise<AiReviewResult> {
  const empty: AiReviewResult = {
    status: 'disabled',
    verdicts: candidates.map(() => null),
  };
  if (candidates.length === 0) return { status: 'ok', verdicts: [] };
  if (!config.ai.enabled) return { ...empty, status: 'disabled' };
  if (!config.ai.apiKey) return { ...empty, status: 'no_key' };

  const batch = candidates.slice(0, config.ai.maxCandidates);
  const body = {
    model: config.ai.model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(batch) },
    ],
    response_format: { type: 'json_object' },
  };

  for (let attempt = 0; attempt < config.ai.maxCalls; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    try {
      const res = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.ai.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn('ai review http error', { status: res.status });
        if (attempt === config.ai.maxCalls - 1) return { ...empty, status: 'error' };
        continue;
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? '';
      const parsed = parseVerdicts(content, batch.length);
      if (!parsed) {
        logger.warn('ai review unparsable response');
        return { ...empty, status: 'invalid_response' };
      }
      return { status: 'ok', verdicts: pad(parsed, candidates.length) };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      logger.warn('ai review failed', { attempt, aborted: isAbort });
      if (attempt === config.ai.maxCalls - 1) {
        return { ...empty, status: isAbort ? 'timeout' : 'error' };
      }
    }
  }
  return { ...empty, status: 'error' };
}

function pad(verdicts: Array<AiVerdict | null>, length: number): Array<AiVerdict | null> {
  const out = verdicts.slice(0, length);
  while (out.length < length) out.push(null);
  return out;
}

export function parseVerdicts(content: string, expected: number): Array<AiVerdict | null> | null {
  const candidates: Array<AiVerdict | null>[] = [];
  try {
    const direct = JSON.parse(stripFences(content));
    const arr = Array.isArray(direct) ? direct : direct?.results;
    if (Array.isArray(arr)) candidates.push(normalizeArray(arr));
  } catch {
    const m = stripFences(content).match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        const arr = Array.isArray(obj) ? obj : obj?.results;
        if (Array.isArray(arr)) candidates.push(normalizeArray(arr));
      } catch {
        return null;
      }
    }
  }
  if (candidates.length === 0) return null;
  const result = candidates[0];
  if (result.length !== expected) return null;
  return result;
}

function normalizeArray(arr: unknown[]): Array<AiVerdict | null> {
  return arr.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const confidenceRaw = Number(o.confidence);
    return {
      is_suspected_issue: Boolean(o.is_suspected_issue),
      confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0,
      summary: typeof o.summary === 'string' ? o.summary : '',
      evidence_a: typeof o.evidence_a === 'string' ? o.evidence_a : '',
      evidence_b: typeof o.evidence_b === 'string' ? o.evidence_b : '',
      possible_explanation: typeof o.possible_explanation === 'string' ? o.possible_explanation : '',
      recommended_check: typeof o.recommended_check === 'string' ? o.recommended_check : '',
    };
  });
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
}
