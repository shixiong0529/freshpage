import express, { type Request, type Response, type NextFunction } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config';
import * as repo from '../db/repository';
import { isPortAllowed, normalizeUrl } from '../security/url';
import { quickBlockCheck } from '../security/ssrf';
import { scanQueue } from '../scan/queue';
import { retryFailedPages } from '../scan/pipeline';
import { checkScanCreation, ipHash, voterHash } from './ratelimit';
import type { FindingRow, PageResultRow, ScanRow, Severity } from '../types';
import { logger } from '../util/logger';
import { randomToken } from '../util/misc';

const STAGE_MESSAGE: Record<string, string> = {
  queued: '正在排队，马上开始',
  checking_access: '正在确认网站是否可以访问',
  discovering_pages: '正在发现网站页面',
  checking_content: '正在检查内容和链接',
  finalizing: '正在整理结果',
  done: '已完成',
};

const FAILURE_HINT: Record<string, string> = {
  DNS_FAILURE: '我们无法解析这个域名，请确认地址是否拼写正确。',
  HTTP_ERROR: '网站返回了错误状态码，可能是临时故障，也可能是页面已下线。',
  ROBOTS_DISALLOWED: '这个网站的 robots.txt 不允许自动访问。',
  BLOCKED_ADDRESS: '这个地址指向内部网络，我们不会访问此类地址。',
  INVALID_URL: '地址格式无法识别。',
  UNSUPPORTED_SCHEME: '仅支持 http 或 https 开头的网址。',
  BLOCKED_PORT: '我们只访问标准网页端口（80 / 443）。',
  TOO_MANY_REDIRECTS: '页面存在过多重定向。',
  REDIRECT_LOOP: '页面存在重定向循环。',
  TIMEOUT: '网站响应时间过长。',
  NO_PAGES: '没有检查到任何可读取的页面。',
  UNKNOWN: '系统临时故障。',
};

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(voterCookie);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      env: config.env,
      retentionDays: config.retentionDays,
      maxPages: config.maxPages,
      telemetry: config.telemetry.enabled,
    });
  });

  /* ------------------------------ 创建扫描 ------------------------------ */
  app.post('/api/scans', async (req: Request, res: Response) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const normalized = normalizeUrl(rawUrl);
    if (!normalized.ok || !normalized.url || !normalized.normalizedUrl || !normalized.normalizedDomain) {
      return res.status(400).json({
        error: normalized.errorCode ?? 'INVALID_URL',
        message: normalized.errorMessage ?? '请输入有效的网址。',
      });
    }

    const host = normalized.url.hostname.replace(/^\[|\]$/g, '');
    const quick = quickBlockCheck(host);
    if (!quick.ok && !config.allowPrivateTargets) {
      return res.status(400).json({
        error: 'BLOCKED_ADDRESS',
        message: '我们不会检查内部或本机地址，请输入一个公开的网站地址。',
      });
    }

    if (!isPortAllowed(normalized.url)) {
      return res.status(400).json({
        error: 'BLOCKED_PORT',
        message: '我们只访问标准网页端口（80 / 443）。',
      });
    }

    const ip = clientIp(req);
    const ipH = ipHash(ip);
    const decision = checkScanCreation(ipH, normalized.normalizedDomain);
    if (!decision.allowed) {
      return res.status(429).json({
        error: 'RATE_LIMITED',
        message: decision.reason ?? '提交太频繁了。',
        retryAfterSec: decision.retryAfterSec,
      });
    }

    // 同一域名短时间内复用正在进行的扫描
    const running = repo.findRunningScanForDomain(normalized.normalizedDomain, config.abuse.domainCooldownMs);
    if (running) {
      return res.status(200).json({
        token: running.public_token,
        resultUrl: `/result/${running.public_token}`,
        reused: true,
        status: running.status,
      });
    }

    const expiresAt = new Date(Date.now() + config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const scan = repo.createScan({
      publicToken: randomToken(),
      submittedUrl: rawUrl.trim(),
      normalizedUrl: normalized.normalizedUrl,
      normalizedDomain: normalized.normalizedDomain,
      expiresAt,
      abuseFingerprintHash: ipH,
      clientIpHashes: ipH,
    });

    repo.addScanEvent(scan.id, 'created', '已创建检查任务。', 'queued', 0);
    repo.addDailyUsage(0, 1);
    if (!config.apiOnly) scanQueue.enqueue(scan.id);

    logger.info('scan created', { scanId: scan.id, domain: normalized.normalizedDomain });
    return res.status(202).json({
      token: scan.public_token,
      resultUrl: `/result/${scan.public_token}`,
      status: scan.status,
      expiresAt,
    });
  });

  /* --------------------------- 查询进度与结果 --------------------------- */
  app.get('/api/scans/:token', (req: Request, res: Response) => {
    const scan = repo.getLiveScanByToken(req.params.token);
    if (!scan) return res.status(404).json({ error: 'NOT_FOUND', message: '结果不存在或已超过 7 天保存期。' });
    return res.json(buildScanPayload(scan));
  });

  app.post('/api/scans/:token/cancel', (req: Request, res: Response) => {
    const scan = repo.getLiveScanByToken(req.params.token);
    if (!scan) return res.status(404).json({ error: 'NOT_FOUND', message: '结果不存在。' });
    if (scan.status === 'queued' || scan.status === 'running') {
      repo.updateScan(scan.id, { status: 'cancelled', finished_at: new Date().toISOString(), current_stage: 'done' });
      repo.addScanEvent(scan.id, 'cancelled', '用户取消了本次检查。', 'done', 100);
    }
    return res.json({ ok: true });
  });

  /** 只重试失败的页面，保留已成功的结果。 */
  app.post('/api/scans/:token/retry-failed', async (req: Request, res: Response) => {
    const scan = repo.getLiveScanByToken(req.params.token);
    if (!scan) return res.status(404).json({ error: 'NOT_FOUND', message: '结果不存在。' });
    if (scan.status === 'running' || scan.status === 'queued') {
      return res.status(409).json({ error: 'BUSY', message: '本次检查仍在进行中。' });
    }
    const failed = repo.listPageResults(scan.id).filter((p) => p.crawl_status === 'failed');
    if (failed.length === 0) {
      return res.status(400).json({ error: 'NO_FAILED_PAGES', message: '没有需要重试的页面。' });
    }
    if (config.apiOnly) {
      repo.updateScan(scan.id, { status: 'queued', current_stage: 'queued' });
      return res.status(202).json({ ok: true, queued: failed.length });
    }
    const recovered = await retryFailedPages(scan.id);
    return res.status(200).json({ ok: true, retried: failed.length, recovered });
  });

  app.delete('/api/scans/:token', (req: Request, res: Response) => {
    const scan = repo.getLiveScanByToken(req.params.token);
    if (!scan) return res.status(404).json({ error: 'NOT_FOUND', message: '结果不存在。' });
    repo.markDeleted(scan.id);
    return res.json({ ok: true });
  });

  /* ------------------------------ 结果反馈 ------------------------------ */
  app.post('/api/findings/:id/feedback', (req: Request, res: Response) => {
    const id = Number.parseInt(req.params.id, 10);
    const vote = req.body?.vote === 'not_helpful' ? 'not_helpful' : req.body?.vote === 'helpful' ? 'helpful' : null;
    if (!Number.isFinite(id) || !vote) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: '反馈参数无效。' });
    }
    const finding = repo.getFinding(id);
    if (!finding) return res.status(404).json({ error: 'NOT_FOUND', message: '结果不存在。' });
    const scan = repo.getLiveScanByToken(String(req.body?.token ?? ''));
    if (!scan || scan.id !== finding.scan_id) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '无法为该结果提交反馈。' });
    }
    const vh = voterHash(req.cookies?.fp_voter, clientIp(req));
    const result = repo.recordFeedback(id, scan.id, vote, vh);
    const updated = repo.getFinding(id);
    return res.json({
      ok: true,
      duplicate: result === 'duplicate',
      helpful_count: updated?.helpful_count ?? 0,
      not_helpful_count: updated?.not_helpful_count ?? 0,
    });
  });

  /* ------------------------------ 前端埋点 ------------------------------ */
  /**
   * 匿名行为埋点（docs/VALIDATION.md §2）。
   * 只接受白名单事件名，只落库「事件名 + 扫描 id + 会话哈希」，
   * 不接受也不保存 URL、页面正文、Cookie 原文与 IP 原文。
   */
  app.post('/api/telemetry', (req: Request, res: Response) => {
    const event = req.body?.event;
    if (!repo.isTelemetryEvent(event)) {
      return res.status(400).json({ error: 'INVALID_EVENT', message: '未知的事件名。' });
    }
    if (!config.telemetry.enabled) return res.json({ ok: true, disabled: true });

    const session = voterHash(req.cookies?.fp_voter, clientIp(req));
    const day = new Date().toISOString().slice(0, 10);
    const used = repo.bumpCounter(`telemetry:${session}:${day}`);
    if (used > config.telemetry.maxEventsPerSessionPerDay) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: '埋点上报过于频繁。' });
    }

    // token 只用来把事件绑定到具体扫描；无效或已过期时按无绑定记录
    const rawToken = typeof req.body?.token === 'string' ? req.body.token : '';
    const scan = rawToken ? repo.getLiveScanByToken(rawToken) : undefined;
    const result = repo.recordTelemetry(event, session, scan ? scan.id : null);
    return res.json({ ok: true, duplicate: result === 'duplicate' });
  });

  /* ------------------------------ 示例报告 ------------------------------ */
  app.get('/api/example', (_req, res) => {
    const file = path.join(config.root, 'data', 'sample-report.json');
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '示例报告尚未生成。' });
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return res.json(data);
    } catch {
      return res.status(500).json({ error: 'INVALID_SAMPLE', message: '示例报告读取失败。' });
    }
  });

  /* ------------------------------ 静态资源 ------------------------------ */
  const publicDir = path.join(config.root, 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get(['/result/:token', '/example'], (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/privacy', (_req, res) => {
    res.sendFile(path.join(publicDir, 'privacy.html'));
  });

  app.use((_req, res) => {
    res.status(404).sendFile(path.join(publicDir, 'index.html'));
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled api error', { message: err.message });
    res.status(500).json({ error: 'INTERNAL', message: '系统出现临时故障。' });
  });

  return app;
}

function voterCookie(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  (req as Request & { cookies?: Record<string, string> }).cookies = cookies;
  if (!cookies.fp_voter) {
    const value = randomToken(12);
    res.setHeader('Set-Cookie', `fp_voter=${value}; Path=/; Max-Age=15552000; SameSite=Lax; HttpOnly`);
  }
  next();
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function clientIp(req: Request): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) return xf.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export function buildScanPayload(scan: ScanRow): Record<string, unknown> {
  const findings = repo.listFindings(scan.id);
  const pages = repo.listPageResults(scan.id);
  const events = repo.listScanEvents(scan.id, 8).reverse();

  const summary = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === 'critical') summary.critical++;
    else if (f.severity === 'warning') summary.warning++;
    else summary.info++;
  }

  return {
    scan: {
      token: scan.public_token,
      submittedUrl: scan.submitted_url,
      normalizedUrl: scan.normalized_url,
      domain: scan.normalized_domain,
      status: scan.status,
      stage: scan.current_stage,
      stageMessage: STAGE_MESSAGE[scan.current_stage] ?? '处理中',
      discoveredCount: scan.discovered_count,
      scannedCount: scan.scanned_count,
      failedCount: scan.failed_count,
      complete: Boolean(scan.complete),
      maxPages: config.maxPages,
      createdAt: scan.created_at,
      finishedAt: scan.finished_at,
      expiresAt: scan.expires_at,
      failureReason: scan.failure_reason,
      failureCode: scan.failure_code,
      failureHint: scan.failure_code ? FAILURE_HINT[scan.failure_code] ?? null : null,
      truncationNote: scan.truncation_note,
      aiStatus: scan.ai_status,
    },
    summary,
    findings: findings.map((f) => serializeFinding(f, pages)),
    pages: pages.map(serializePage),
    events: events.map((e) => ({
      type: e.event_type,
      stage: e.stage,
      message: e.safe_message,
      progress: e.progress_value,
      at: e.created_at,
    })),
  };
}

function serializePage(p: PageResultRow): Record<string, unknown> {
  return {
    url: p.final_url || p.requested_url,
    requestedUrl: p.requested_url,
    status: p.http_status,
    title: p.title,
    pageType: p.page_type,
    crawlStatus: p.crawl_status,
    errorCode: p.error_code,
    errorMessage: p.error_message,
  };
}

function serializeFinding(f: FindingRow, pages: PageResultRow[]): Record<string, unknown> {
  let evidence: unknown = {};
  try {
    evidence = JSON.parse(f.evidence_json);
  } catch {
    evidence = {};
  }
  let ids: number[] = [];
  try {
    ids = JSON.parse(f.page_result_ids) as number[];
  } catch {
    ids = [];
  }
  const byId = new Map(pages.map((p) => [p.id, p]));
  const relatedPages = ids
    .map((id) => byId.get(id))
    .filter((p): p is PageResultRow => Boolean(p))
    .map((p) => ({ url: p.final_url || p.requested_url, title: p.title, pageType: p.page_type }));

  return {
    id: f.id,
    type: f.finding_type,
    severity: f.severity as Severity,
    title: f.title,
    summary: f.summary,
    recommendation: f.recommendation,
    confidence: f.confidence,
    method: f.detection_method,
    helpful: f.helpful_count,
    notHelpful: f.not_helpful_count,
    evidence,
    pages: relatedPages,
  };
}
