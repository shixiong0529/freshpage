/**
 * FreshPage 全局配置
 * 所有值均可通过环境变量覆盖；默认值满足 V0 本地运行需求。
 */
import * as path from 'node:path';
import { projectRoot } from './util/misc';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ROOT = projectRoot();

export const config = {
  env: process.env.NODE_ENV || 'development',
  root: ROOT,
  port: int('PORT', 3000),

  // ---------- 存储 ----------
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'freshpage.db'),

  // ---------- 抓取边界 ----------
  maxPages: int('FP_MAX_PAGES', 50),
  maxDepth: int('FP_MAX_DEPTH', 2),
  perScanConcurrency: int('FP_SCAN_CONCURRENCY', 3),
  requestTimeoutMs: int('FP_REQUEST_TIMEOUT_MS', 12_000),
  maxResponseBytes: int('FP_MAX_RESPONSE_BYTES', 2_000_000),
  maxRedirects: int('FP_MAX_REDIRECTS', 5),
  maxRequestsPerScan: int('FP_MAX_REQUESTS_PER_SCAN', 400),
  scanBudgetMs: int('FP_SCAN_BUDGET_MS', 8 * 60 * 1000),
  retryOn5xx: int('FP_RETRY_5XX', 1),
  crawlDelayMs: int('FP_CRAWL_DELAY_MS', 150),
  userAgent:
    process.env.FP_USER_AGENT ||
    'FreshPageBot/0.1 (+https://freshpage.example/bot; website content freshness check)',

  // ---------- 安全 ----------
  /** 仅测试夹具使用：允许抓取私网 / 回环地址。生产环境必须为 false。 */
  allowPrivateTargets: bool('FP_ALLOW_PRIVATE_TARGETS', false),
  allowedPorts: list('FP_ALLOWED_PORTS', ['80', '443']),

  // ---------- AI ----------
  ai: {
    enabled: bool('FP_AI_ENABLED', true),
    baseUrl: process.env.AI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.AI_MODEL || 'deepseek-chat',
    timeoutMs: int('FP_AI_TIMEOUT_MS', 30_000),
    maxCandidates: int('FP_AI_MAX_CANDIDATES', 12),
    maxCalls: int('FP_AI_MAX_CALLS', 2),
    /** 低于该置信度的 AI 判断默认不展示 */
    minConfidence: Number.parseFloat(process.env.FP_AI_MIN_CONFIDENCE || '0.55'),
  },

  // ---------- 浏览器回退 ----------
  browserFallback: {
    enabled: bool('FP_BROWSER_FALLBACK', true),
    timeoutMs: int('FP_BROWSER_TIMEOUT_MS', 20_000),
  },

  // ---------- 展示 ----------
  maxMainFindings: int('FP_MAX_MAIN_FINDINGS', 20),

  // ---------- 数据保留 ----------
  retentionDays: int('FP_RETENTION_DAYS', 7),
  cleanupIntervalMs: int('FP_CLEANUP_INTERVAL_MS', 60 * 60 * 1000),

  // ---------- 防滥用 ----------
  abuse: {
    maxScansPerIpPerWindow: int('FP_MAX_SCANS_PER_IP', 6),
    ipWindowMs: int('FP_IP_WINDOW_MS', 10 * 60 * 1000),
    maxScansPerIpPerDay: int('FP_MAX_SCANS_PER_IP_DAY', 30),
    domainCooldownMs: int('FP_DOMAIN_COOLDOWN_MS', 5 * 60 * 1000),
    failureCooldownMs: int('FP_FAILURE_COOLDOWN_MS', 30 * 60 * 1000),
    failureThreshold: int('FP_FAILURE_THRESHOLD', 3),
    globalConcurrentScans: int('FP_GLOBAL_CONCURRENT_SCANS', 3),
    dailyPageBudget: int('FP_DAILY_PAGE_BUDGET', 5000),
    /** 同一 IP 在提交阶段的全局并发上限 */
    maxQueuedScans: int('FP_MAX_QUEUED_SCANS', 50),
  },

  // ---------- 运行模式 ----------
  /** true 时进程只运行 worker（不监听 HTTP） */
  workerOnly: bool('FP_WORKER_ONLY', false),
  /** true 时进程不消费队列（只提供 API，配合独立 worker 部署） */
  apiOnly: bool('FP_API_ONLY', false),
} as const;

export function isProduction(): boolean {
  return config.env === 'production';
}
