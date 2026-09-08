import type {
  DetectionMethod,
  EvidencePiece,
  FindingEvidence,
  PageType,
  Severity,
} from '../types';
import type { ExtractedPage } from '../types';

export interface PageContext {
  id: number;
  url: string;
  finalUrl: string;
  pageType: PageType;
  importance: number;
  title: string | null;
  h1: string | null;
  httpStatus: number | null;
  isSubmitted: boolean;
  extracted: ExtractedPage;
  facts: Array<{
    id: number;
    factType: string;
    entityKey: string;
    rawText: string;
    normalizedValue: string;
    unit: string | null;
    qualifier: string | null;
    contextText: string | null;
    groupKey: string;
    confidence: number;
  }>;
}

export interface FailedPage {
  id: number;
  url: string;
  pageType: PageType;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  isSubmitted: boolean;
}

export interface FindingDraft {
  findingType: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  summary: string;
  pageResultIds: number[];
  evidence: FindingEvidence;
  recommendation: string;
  confidence: number;
  detectionMethod: DetectionMethod;
  /** AI 复核前的初始排序分，AI 复核后会被重算 */
  rankScore: number;
  /** 需要 AI 复核的候选（仅 heuristic 类使用） */
  aiReview?: AiReviewInput;
}

export interface AiReviewInput {
  kind: string;
  entityLabel: string;
  valueA: string;
  valueB: string;
  quoteA: string;
  quoteB: string;
  urlA: string;
  urlB: string;
  pageTypeA: string;
  pageTypeB: string;
}

export function evidencePiece(page: PageContext, quote: string, note?: string): EvidencePiece {
  return {
    url: page.finalUrl || page.url,
    page_type: page.pageType,
    title: page.title,
    quote,
    note,
  };
}

export function quoteOf(text: string, needle: string, radius = 90): string {
  const idx = text.indexOf(needle);
  if (idx < 0) return needle.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

export function baseRankScore(
  severity: Severity,
  method: DetectionMethod,
  importance: number,
  pageCount: number,
  confidence: number
): number {
  const sevWeight = severity === 'critical' ? 1000 : severity === 'warning' ? 500 : 100;
  const methodWeight =
    method === 'deterministic' ? 220 : method === 'ai_reviewed' ? 80 + confidence * 140 : 40 + confidence * 60;
  return sevWeight + methodWeight + importance * 60 + Math.min(pageCount, 10) * 8;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '需要优先处理',
  warning: '建议检查',
  info: '信息',
};
