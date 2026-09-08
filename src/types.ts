export type ScanStatus = 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'deleted';

export type ScanStage =
  | 'queued'
  | 'checking_access'
  | 'discovering_pages'
  | 'checking_content'
  | 'finalizing'
  | 'done';

export type Severity = 'critical' | 'warning' | 'info';
export type DetectionMethod = 'deterministic' | 'heuristic' | 'ai_reviewed';

export type PageType =
  | 'home'
  | 'pricing'
  | 'features'
  | 'help'
  | 'policy'
  | 'about'
  | 'contact'
  | 'blog'
  | 'other';

export type CrawlStatus = 'ok' | 'failed' | 'skipped' | 'blocked';

export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'BLOCKED_ADDRESS'
  | 'BLOCKED_PORT'
  | 'DNS_FAILURE'
  | 'TIMEOUT'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_LOOP'
  | 'CROSS_DOMAIN_REDIRECT'
  | 'HTTP_ERROR'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'RESPONSE_TOO_LARGE'
  | 'ROBOTS_DISALLOWED'
  | 'NETWORK_ERROR'
  | 'RENDER_FAILED'
  | 'UNKNOWN';

export interface ScanRow {
  id: number;
  public_token: string;
  submitted_url: string;
  normalized_url: string;
  normalized_domain: string;
  status: ScanStatus;
  current_stage: ScanStage;
  discovered_count: number;
  scanned_count: number;
  failed_count: number;
  complete: number;
  truncation_note: string | null;
  failure_reason: string | null;
  failure_code: string | null;
  ai_status: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string;
  deleted_at: string | null;
  abuse_fingerprint_hash: string | null;
  client_ip_hash: string | null;
}

export interface PageResultRow {
  id: number;
  scan_id: number;
  requested_url: string;
  final_url: string | null;
  normalized_url: string;
  http_status: number | null;
  title: string | null;
  h1: string | null;
  normalized_text: string | null;
  content_hash: string | null;
  screenshot_path: string | null;
  page_type: PageType;
  crawl_status: CrawlStatus;
  error_code: string | null;
  error_message: string | null;
  fetch_ms: number | null;
  fetched_at: string;
}

export interface ExtractedFactRow {
  id: number;
  scan_id: number;
  page_result_id: number | null;
  fact_type: string;
  entity_key: string;
  raw_text: string;
  normalized_value: string;
  unit: string | null;
  qualifier: string | null;
  context_text: string | null;
  confidence: number;
}

export interface FindingRow {
  id: number;
  scan_id: number;
  finding_type: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  summary: string;
  page_result_ids: string;
  evidence_json: string;
  recommendation: string;
  confidence: number;
  detection_method: DetectionMethod;
  rank_score: number;
  helpful_count: number;
  not_helpful_count: number;
  created_at: string;
}

export interface FindingEvidence {
  side_a?: EvidencePiece;
  side_b?: EvidencePiece;
  sources?: EvidencePiece[];
  extra?: Record<string, unknown>;
}

export interface EvidencePiece {
  url: string;
  page_type?: PageType;
  title?: string | null;
  quote: string;
  note?: string;
}

export interface ScanEventRow {
  id: number;
  scan_id: number;
  event_type: string;
  stage: string | null;
  progress_value: number | null;
  safe_message: string;
  created_at: string;
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string | null;
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  redirects: string[];
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  elapsedMs: number;
  rendered: boolean;
  contentType: string | null;
  /** 最终跳转到与提交地址不同的域名 */
  crossDomainRedirect?: boolean;
}

export interface ExtractedPage {
  url: string;
  finalUrl: string;
  title: string | null;
  h1: string | null;
  text: string;
  textLength: number;
  links: Array<{ href: string; internal: boolean; text: string }>;
  mailtos: string[];
  tels: string[];
  emails: string[];
  phones: string[];
  lang: string | null;
  meta: Record<string, string | null>;
}

export interface FactCandidate {
  factType: string;
  entityKey: string;
  rawText: string;
  normalizedValue: string;
  unit?: string;
  qualifier?: string;
  contextText: string;
  confidence: number;
  /** 用于冲突检测的分组键（含币种 / 计费周期 / 地区等限定条件） */
  groupKey: string;
  /** 事实在正文中出现的位置，便于取上下文 */
  index?: number;
}
