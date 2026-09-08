/**
 * SQLite 访问层（node:sqlite，Node >= 22.5）。
 *
 * 方案文档建议 PostgreSQL；本机未安装 Postgres，V0 采用 SQLite 以降低部署门槛。
 * 所有 SQL 集中在本文件，迁移到 Postgres 时只需替换本文件实现 + 少量类型调整
 * （BOOLEAN/JSON 以 TEXT 存储，时间戳统一 ISO8601 字符串）。
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config';
import { logger } from '../util/logger';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = config.dbPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

/** 仅供测试：使用内存数据库。 */
export function initInMemory(): DatabaseSync {
  closeDb();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, ':memory:');
  return db;
}

function migrate(d: DatabaseSync, label = config.dbPath): void {
  d.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_token TEXT NOT NULL UNIQUE,
    submitted_url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    normalized_domain TEXT NOT NULL,
    status TEXT NOT NULL,
    current_stage TEXT NOT NULL DEFAULT 'queued',
    discovered_count INTEGER NOT NULL DEFAULT 0,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0,
    truncation_note TEXT,
    failure_reason TEXT,
    failure_code TEXT,
    ai_status TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    expires_at TEXT NOT NULL,
    deleted_at TEXT,
    abuse_fingerprint_hash TEXT,
    client_ip_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(normalized_domain);
  CREATE INDEX IF NOT EXISTS idx_scans_expires ON scans(expires_at);

  CREATE TABLE IF NOT EXISTS page_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    requested_url TEXT NOT NULL,
    final_url TEXT,
    normalized_url TEXT NOT NULL,
    http_status INTEGER,
    title TEXT,
    h1 TEXT,
    normalized_text TEXT,
    content_hash TEXT,
    screenshot_path TEXT,
    page_type TEXT,
    crawl_status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    fetch_ms INTEGER,
    fetched_at TEXT NOT NULL,
    UNIQUE(scan_id, normalized_url)
  );
  CREATE INDEX IF NOT EXISTS idx_pages_scan ON page_results(scan_id);

  CREATE TABLE IF NOT EXISTS extracted_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    page_result_id INTEGER REFERENCES page_results(id) ON DELETE CASCADE,
    fact_type TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    unit TEXT,
    qualifier TEXT,
    context_text TEXT,
    confidence REAL NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_facts_scan ON extracted_facts(scan_id);
  CREATE INDEX IF NOT EXISTS idx_facts_key ON extracted_facts(scan_id, fact_type, entity_key);

  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    finding_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    page_result_ids TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1,
    detection_method TEXT NOT NULL,
    rank_score REAL NOT NULL DEFAULT 0,
    helpful_count INTEGER NOT NULL DEFAULT 0,
    not_helpful_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(scan_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);

  CREATE TABLE IF NOT EXISTS scan_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    stage TEXT,
    progress_value INTEGER,
    safe_message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_scan ON scan_events(scan_id);

  CREATE TABLE IF NOT EXISTS feedback_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    scan_id INTEGER NOT NULL,
    vote TEXT NOT NULL,
    voter_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(finding_id, voter_hash)
  );

  CREATE TABLE IF NOT EXISTS abuse_counters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_key TEXT NOT NULL UNIQUE,
    counter INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    day TEXT PRIMARY KEY,
    pages_crawled INTEGER NOT NULL DEFAULT 0,
    scans_created INTEGER NOT NULL DEFAULT 0
  );
  `);
  logger.info('database ready', { path: label });
}
