import { getDb } from './sqlite';
import type {
  ExtractedFactRow,
  FindingRow,
  PageResultRow,
  ScanEventRow,
  ScanRow,
  ScanStage,
  ScanStatus,
} from '../types';
import { nowIso } from '../util/misc';

/* ------------------------------- scans ------------------------------- */

export function createScan(input: {
  publicToken: string;
  submittedUrl: string;
  normalizedUrl: string;
  normalizedDomain: string;
  expiresAt: string;
  abuseFingerprintHash: string;
  clientIpHashes: string;
}): ScanRow {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO scans (public_token, submitted_url, normalized_url, normalized_domain,
        status, current_stage, created_at, expires_at, abuse_fingerprint_hash, client_ip_hash)
       VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?)`
    )
    .run(
      input.publicToken,
      input.submittedUrl,
      input.normalizedUrl,
      input.normalizedDomain,
      nowIso(),
      input.expiresAt,
      input.abuseFingerprintHash,
      input.clientIpHashes
    );
  return getScanById(Number(info.lastInsertRowid))!;
}

export function getScanById(id: number): ScanRow | undefined {
  return getDb().prepare('SELECT * FROM scans WHERE id = ?').get(id) as unknown as ScanRow | undefined;
}

export function getScanByToken(token: string): ScanRow | undefined {
  return getDb().prepare('SELECT * FROM scans WHERE public_token = ?').get(token) as unknown as ScanRow | undefined;
}

/** 仅返回未删除且未过期的扫描。 */
export function getLiveScanByToken(token: string): ScanRow | undefined {
  const row = getScanByToken(token);
  if (!row || row.deleted_at) return undefined;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return undefined;
  return row;
}

/** 把长时间停留在 running 的扫描标记为失败（进程崩溃后的恢复）。 */
export function markStaleRunningFailed(staleMinutes: number): number {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const info = getDb()
    .prepare(
      `UPDATE scans SET status = 'failed', current_stage = 'done', finished_at = ?,
         failure_reason = '这次检查被中断，请重新提交。', failure_code = 'UNKNOWN'
       WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ? AND deleted_at IS NULL`
    )
    .run(new Date().toISOString(), cutoff);
  return Number(info.changes ?? 0);
}

/** 清理过期的频率限制计数，避免 abuse_counters 无限增长。 */
export function pruneAbuseCounters(days = 7): void {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare('DELETE FROM abuse_counters WHERE updated_at < ?').run(cutoff);
}

/** 领取待处理的扫描（供独立 Worker 轮询）。 */
export function getQueuedScans(limit: number): ScanRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM scans WHERE status = 'queued' AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(Math.max(1, limit)) as unknown as ScanRow[];
}

export function updateScan(
  id: number,
  patch: Partial<{
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
    started_at: string | null;
    finished_at: string | null;
  }>
): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
  getDb().prepare(`UPDATE scans SET ${sets} WHERE id = ?`).run(...(values as never[]), id);
}

export function markDeleted(id: number): void {
  getDb().prepare('UPDATE scans SET deleted_at = ?, status = ? WHERE id = ?').run(nowIso(), 'deleted', id);
}

export function findRunningScanForDomain(domain: string, withinMs: number): ScanRow | undefined {
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM scans
       WHERE normalized_domain = ? AND deleted_at IS NULL
         AND status IN ('queued','running') AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(domain, cutoff) as unknown as ScanRow | undefined;
}

export function countScansForDomainSince(domain: string, sinceIso: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM scans WHERE normalized_domain = ? AND created_at >= ?')
    .get(domain, sinceIso) as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

export function updateFailureCounter(domain: string): number {
  return bumpCounter(`fail:${domain}`);
}

export function getFailureCounter(domain: string): number {
  return readCounter(`fail:${domain}`);
}

export function resetFailureCounter(domain: string): void {
  getDb().prepare('DELETE FROM abuse_counters WHERE bucket_key = ?').run(`fail:${domain}`);
}

/* --------------------------- page results ---------------------------- */

export function upsertPageResult(row: {
  scanId: number;
  requestedUrl: string;
  finalUrl: string | null;
  normalizedUrl: string;
  httpStatus: number | null;
  title: string | null;
  h1: string | null;
  normalizedText: string | null;
  contentHash: string | null;
  pageType: string;
  crawlStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  fetchMs: number | null;
}): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO page_results (scan_id, requested_url, final_url, normalized_url, http_status,
       title, h1, normalized_text, content_hash, page_type, crawl_status, error_code, error_message,
       fetch_ms, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scan_id, normalized_url) DO UPDATE SET
       requested_url = excluded.requested_url,
       final_url = excluded.final_url,
       http_status = excluded.http_status,
       title = excluded.title,
       h1 = excluded.h1,
       normalized_text = excluded.normalized_text,
       content_hash = excluded.content_hash,
       page_type = excluded.page_type,
       crawl_status = excluded.crawl_status,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       fetch_ms = excluded.fetch_ms,
       fetched_at = excluded.fetched_at`
  ).run(
    row.scanId,
    row.requestedUrl,
    row.finalUrl,
    row.normalizedUrl,
    row.httpStatus,
    row.title,
    row.h1,
    row.normalizedText,
    row.contentHash,
    row.pageType,
    row.crawlStatus,
    row.errorCode,
    row.errorMessage,
    row.fetchMs,
    nowIso()
  );
  const found = db
    .prepare('SELECT id FROM page_results WHERE scan_id = ? AND normalized_url = ?')
    .get(row.scanId, row.normalizedUrl) as { id: number } | undefined;
  // 任务幂等：重复执行不得重复创建页面
  return found ? Number(found.id) : 0;
}

export function listPageResults(scanId: number): PageResultRow[] {
  return getDb()
    .prepare('SELECT * FROM page_results WHERE scan_id = ? ORDER BY id')
    .all(scanId) as unknown as PageResultRow[];
}

export function getPageResults(scanId: number, ids: number[]): PageResultRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM page_results WHERE scan_id = ? AND id IN (${placeholders})`)
    .all(scanId, ...ids) as unknown as PageResultRow[];
}

/* -------------------------- extracted facts -------------------------- */

export function insertFacts(
  scanId: number,
  pageResultId: number | null,
  facts: Array<{
    factType: string;
    entityKey: string;
    rawText: string;
    normalizedValue: string;
    unit?: string;
    qualifier?: string;
    contextText?: string;
    confidence: number;
  }>
): void {
  if (facts.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO extracted_facts (scan_id, page_result_id, fact_type, entity_key, raw_text,
      normalized_value, unit, qualifier, context_text, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec('BEGIN');
  try {
    for (const f of facts) {
      stmt.run(
        scanId,
        pageResultId,
        f.factType,
        f.entityKey,
        f.rawText,
        f.normalizedValue,
        f.unit ?? null,
        f.qualifier ?? null,
        f.contextText ?? null,
        f.confidence
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function listFacts(scanId: number): ExtractedFactRow[] {
  return getDb()
    .prepare('SELECT * FROM extracted_facts WHERE scan_id = ? ORDER BY id')
    .all(scanId) as unknown as ExtractedFactRow[];
}

export function deleteFactsForPage(scanId: number, pageResultId: number): void {
  getDb().prepare('DELETE FROM extracted_facts WHERE scan_id = ? AND page_result_id = ?').run(scanId, pageResultId);
}

/* ------------------------------ findings ----------------------------- */

export function replaceFindings(
  scanId: number,
  findings: Array<{
    findingType: string;
    fingerprint: string;
    severity: string;
    title: string;
    summary: string;
    pageResultIds: number[];
    evidence: unknown;
    recommendation: string;
    confidence: number;
    detectionMethod: string;
    rankScore: number;
  }>
): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM findings WHERE scan_id = ?').run(scanId);
    const stmt = db.prepare(
      `INSERT INTO findings (scan_id, finding_type, fingerprint, severity, title, summary,
        page_result_ids, evidence_json, recommendation, confidence, detection_method, rank_score,
        helpful_count, not_helpful_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
    );
    for (const f of findings) {
      stmt.run(
        scanId,
        f.findingType,
        f.fingerprint,
        f.severity,
        f.title,
        f.summary,
        JSON.stringify(f.pageResultIds),
        JSON.stringify(f.evidence),
        f.recommendation,
        f.confidence,
        f.detectionMethod,
        f.rankScore,
        nowIso()
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function listFindings(scanId: number): FindingRow[] {
  return getDb()
    .prepare('SELECT * FROM findings WHERE scan_id = ? ORDER BY rank_score DESC, id ASC')
    .all(scanId) as unknown as FindingRow[];
}

export function getFinding(id: number): FindingRow | undefined {
  return getDb().prepare('SELECT * FROM findings WHERE id = ?').get(id) as unknown as FindingRow | undefined;
}

export function recordFeedback(
  findingId: number,
  scanId: number,
  vote: 'helpful' | 'not_helpful',
  voterHash: string
): 'created' | 'duplicate' {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM feedback_events WHERE finding_id = ? AND voter_hash = ?')
    .get(findingId, voterHash);
  if (existing) return 'duplicate';
  db.prepare(
    'INSERT INTO feedback_events (finding_id, scan_id, vote, voter_hash, created_at) VALUES (?,?,?,?,?)'
  ).run(findingId, scanId, vote, voterHash, nowIso());
  const col = vote === 'helpful' ? 'helpful_count' : 'not_helpful_count';
  db.prepare(`UPDATE findings SET ${col} = ${col} + 1 WHERE id = ?`).run(findingId);
  return 'created';
}

/* ------------------------------ events ------------------------------- */

export function addScanEvent(
  scanId: number,
  eventType: string,
  safeMessage: string,
  stage?: ScanStage,
  progressValue?: number
): void {
  getDb()
    .prepare(
      'INSERT INTO scan_events (scan_id, event_type, stage, progress_value, safe_message, created_at) VALUES (?,?,?,?,?,?)'
    )
    .run(scanId, eventType, stage ?? null, progressValue ?? null, safeMessage, nowIso());
}

export function listScanEvents(scanId: number, limit = 50): ScanEventRow[] {
  return getDb()
    .prepare('SELECT * FROM scan_events WHERE scan_id = ? ORDER BY id DESC LIMIT ?')
    .all(scanId, limit) as unknown as ScanEventRow[];
}

/* --------------------------- abuse counters -------------------------- */

export function bumpCounter(key: string, windowMs?: number): number {
  const db = getDb();
  const now = Date.now();
  const row = db.prepare('SELECT counter, updated_at FROM abuse_counters WHERE bucket_key = ?').get(key) as
    | { counter: number; updated_at: string }
    | undefined;
  if (row && windowMs && now - new Date(row.updated_at).getTime() > windowMs) {
    db.prepare('UPDATE abuse_counters SET counter = 1, updated_at = ? WHERE bucket_key = ?').run(nowIso(), key);
    return 1;
  }
  if (!row) {
    db.prepare('INSERT INTO abuse_counters (bucket_key, counter, updated_at) VALUES (?, 1, ?)').run(key, nowIso());
    return 1;
  }
  const next = Number(row.counter) + 1;
  db.prepare('UPDATE abuse_counters SET counter = ?, updated_at = ? WHERE bucket_key = ?').run(next, nowIso(), key);
  return next;
}

export function readCounter(key: string): number {
  const row = getDb().prepare('SELECT counter FROM abuse_counters WHERE bucket_key = ?').get(key) as
    | { counter: number }
    | undefined;
  return row ? Number(row.counter) : 0;
}

export function setCounter(key: string, value: number): void {
  getDb()
    .prepare(
      'INSERT INTO abuse_counters (bucket_key, counter, updated_at) VALUES (?,?,?) ON CONFLICT(bucket_key) DO UPDATE SET counter = excluded.counter, updated_at = excluded.updated_at'
    )
    .run(key, value, nowIso());
}

/* ---------------------------- daily usage ---------------------------- */

export function addDailyUsage(pages: number, scans: number): void {
  const day = nowIso().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO daily_usage (day, pages_crawled, scans_created) VALUES (?,?,?)
       ON CONFLICT(day) DO UPDATE SET pages_crawled = pages_crawled + excluded.pages_crawled,
         scans_created = scans_created + excluded.scans_created`
    )
    .run(day, pages, scans);
}

export function getDailyUsage(day = nowIso().slice(0, 10)): { pages_crawled: number; scans_created: number } {
  const row = getDb().prepare('SELECT * FROM daily_usage WHERE day = ?').get(day) as
    | { pages_crawled: number; scans_created: number }
    | undefined;
  return row ?? { pages_crawled: 0, scans_created: 0 };
}

/* ----------------------------- retention ----------------------------- */

/** 删除过期（>7 天）或被标记删除的扫描及其全部正文数据。 */
export function purgeExpired(retentionDays: number): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare('SELECT id FROM scans WHERE deleted_at IS NOT NULL OR created_at < ?')
    .all(cutoff) as Array<{ id: number }>;
  let removed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      db.prepare('DELETE FROM extracted_facts WHERE scan_id = ?').run(r.id);
      db.prepare('DELETE FROM findings WHERE scan_id = ?').run(r.id);
      db.prepare('DELETE FROM page_results WHERE scan_id = ?').run(r.id);
      db.prepare('DELETE FROM scan_events WHERE scan_id = ?').run(r.id);
      db.prepare('DELETE FROM feedback_events WHERE scan_id = ?').run(r.id);
      db.prepare('DELETE FROM scans WHERE id = ?').run(r.id);
      removed++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return removed;
}
