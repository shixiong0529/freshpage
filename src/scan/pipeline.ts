/**
 * 扫描主流程（对应方案第 12 节）。
 *
 * 阶段：checking_access → discovering_pages → checking_content → finalizing
 * 任何阶段失败都要写入可理解的原因，且部分失败不能导致整份报告失败。
 */
import { config } from '../config';
import * as repo from '../db/repository';
import { safeFetch, checkLinkStatus } from '../crawl/fetcher';
import { fetchRobots, isAllowed } from '../crawl/robots';
import { fetchSitemapUrls } from '../crawl/sitemap';
import { PageQueue, classifyPageType, isExcludedUrl, pageImportance, scoreUrl } from '../crawl/discovery';
import { extractPage } from '../extract/html';
import { extractFacts } from '../extract/facts';
import { renderPage } from '../crawl/browser';
import { pageAccessFindings } from '../rules/pageAccess';
import { brokenLinkFindings, type LinkCheckResult } from '../rules/brokenLinks';
import { expiredDateFindings } from '../rules/dates';
import { contactFindings } from '../rules/contact';
import { contentFindings } from '../rules/content';
import { conflictCandidates } from '../rules/conflicts';
import { reviewCandidates, type AiStatus, type AiVerdict } from '../ai/review';
import type { FindingDraft, PageContext, FailedPage } from '../rules/types';
import { baseRankScore } from '../rules/types';
import type { ExtractedPage, PageResultRow, PageType, ScanStage } from '../types';
import { logger } from '../util/logger';
import { pLimit, sha256, sleep, urlKeySafe } from './helpers';

export interface FetchOutcome {
  body: string | null;
  status: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  finalUrl: string;
  crossDomain?: boolean;
}

export interface PipelineDeps {
  fetchPage?: (url: string) => Promise<FetchOutcome>;
  linkCheck?: (url: string) => Promise<{ status: number | null; errorCode: string | null }>;
  aiReview?: (
    candidates: import('../rules/types').AiReviewInput[]
  ) => Promise<{ status: AiStatus; verdicts: Array<AiVerdict | null> }>;
}

const STAGE_MESSAGE: Record<string, string> = {
  checking_access: '正在确认网站是否可以访问',
  discovering_pages: '正在发现网站页面',
  checking_content: '正在检查内容和链接',
  finalizing: '正在整理结果',
};

export async function runScan(scanId: number, deps: PipelineDeps = {}): Promise<void> {
  const scan = repo.getScanById(scanId);
  if (!scan) return;

  repo.updateScan(scanId, { status: 'running', started_at: new Date().toISOString(), current_stage: 'checking_access' });
  event(scanId, 'stage', STAGE_MESSAGE.checking_access, 'checking_access', 5);

  const deadline = Date.now() + config.scanBudgetMs;
  const discovered = new Set<string>();
  const contentHashes = new Set<string>();
  const crawled: PageContext[] = [];
  const failedPages: FailedPage[] = [];
  const queue = new PageQueue();
  let requestsMade = 0;
  let scannedCount = 0;
  let failedCount = 0;
  let truncated = false;
  let extraFromSitemap = 0;
  /** 目标站点返回 429：立即停止后续抓取，避免继续施压。 */
  let rateLimited = false;

  const isCancelled = (): boolean => {
    const s = repo.getScanById(scanId);
    return !s || s.status === 'cancelled' || Boolean(s.deleted_at);
  };

  const abortCancelled = (): boolean => {
    if (!isCancelled()) return false;
    repo.updateScan(scanId, { status: 'cancelled', finished_at: new Date().toISOString(), current_stage: 'done' });
    event(scanId, 'cancelled', '已取消本次检查。', 'done', 100);
    return true;
  };

  try {
    /* ------------------- 阶段一：确认网站可访问 ------------------- */
    const first = await fetchOne(scan.normalized_url, deps);
    requestsMade++;

    if (!first.body || first.status === null || first.status >= 400 || first.errorCode) {
      const reason = first.errorMessage || '网站无法访问。';
      const code = first.errorCode ?? (first.status && first.status >= 400 ? 'HTTP_ERROR' : 'NETWORK_ERROR');
      repo.updateScan(scanId, {
        status: 'failed',
        current_stage: 'done',
        finished_at: new Date().toISOString(),
        failure_reason: reason,
        failure_code: code,
        discovered_count: 1,
        scanned_count: 0,
        failed_count: 1,
        complete: 0,
      });
      event(scanId, 'failed', `无法访问该网站：${reason}`, 'done', 100);
      repo.bumpCounter('fail:' + scan.normalized_domain);
      return;
    }
    repo.resetFailureCounter(scan.normalized_domain);

    let baseUrl: URL;
    try {
      baseUrl = new URL(first.finalUrl || scan.normalized_url);
    } catch {
      repo.updateScan(scanId, {
        status: 'failed',
        current_stage: 'done',
        finished_at: new Date().toISOString(),
        failure_reason: '地址无法解析为有效的网址。',
        failure_code: 'INVALID_URL',
      });
      return;
    }

    const firstUrl = first.finalUrl || scan.normalized_url;
    discovered.add(urlKeySafe(firstUrl));
    const home = await storePage(scanId, {
      requestedUrl: scan.normalized_url,
      finalUrl: firstUrl,
      status: first.status,
      body: first.body,
      pageType: 'home',
      isSubmitted: true,
    });
    scannedCount = 1;
    contentHashes.add(home.contentHash);
    const homeContext = await makeContext(scanId, home.id, home.extracted, new URL(firstUrl), home.pageType, true);
    crawled.push(homeContext);

    /* ------------------- 阶段二：发现页面 ------------------- */
    repo.updateScan(scanId, { current_stage: 'discovering_pages', scanned_count: 1, discovered_count: 1 });
    event(scanId, 'stage', STAGE_MESSAGE.discovering_pages, 'discovering_pages', 15);

    const robots = await fetchRobots(baseUrl.origin);
    requestsMade++;
    if (robots.disallowAll) {
      repo.updateScan(scanId, {
        status: 'failed',
        current_stage: 'done',
        finished_at: new Date().toISOString(),
        failure_reason: '网站的 robots.txt 不允许自动访问。',
        failure_code: 'ROBOTS_DISALLOWED',
        complete: 0,
      });
      event(scanId, 'failed', '网站的 robots.txt 不允许自动访问。', 'done', 100);
      return;
    }

    // 首页链接入队（深度 1）
    enqueueLinks(homeContext, baseUrl, robots, 0, queue, discovered);

    const sitemap = await fetchSitemapUrls(baseUrl.origin, robots.sitemaps);
    requestsMade += sitemap.sitemapsScanned;
    const sitemapCandidates = sitemap.urls.slice(0, config.maxPages * 4);
    extraFromSitemap = Math.max(0, sitemap.urls.length - sitemapCandidates.length);
    for (const u of sitemapCandidates) {
      if (isExcludedUrl(u, baseUrl)) continue;
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        continue;
      }
      if (!isAllowed(robots, parsed)) continue;
      queue.push({
        url: u,
        depth: 1,
        score: scoreUrl(parsed, classifyPageType(parsed), 1, 'sitemap'),
        source: 'sitemap',
      });
    }

    const limit = pLimit(config.perScanConcurrency);
    const submittedRedirectInfo = {
      url: scan.normalized_url,
      finalUrl: first.finalUrl,
      crossDomain: Boolean(first.crossDomain),
    };

    while (crawled.length < config.maxPages) {
      if (abortCancelled()) return;
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      if (requestsMade >= config.maxRequestsPerScan) {
        truncated = true;
        break;
      }
      if (repo.getDailyUsage().pages_crawled >= config.abuse.dailyPageBudget) {
        truncated = true;
        break;
      }
      const item = queue.pop();
      if (!item) break;

      const key = urlKeySafe(item.url);
      if (discovered.has(key)) continue;
      discovered.add(key);

      const res = await limit(() => fetchOne(item.url, deps));
      requestsMade++;
      if (abortCancelled()) return;

      if (!res.body || res.status === null || res.status >= 400 || res.errorCode) {
        failedCount++;
        if (isRateLimited(res)) rateLimited = true;
        const pageId = await storeFailure(scanId, {
          requestedUrl: item.url,
          finalUrl: res.finalUrl,
          status: res.status,
          errorCode: res.errorCode,
          errorMessage: res.errorMessage,
        });
        failedPages.push({
          id: pageId,
          url: item.url,
          pageType: classifyPageType(new URL(item.url)),
          errorCode: res.errorCode,
          errorMessage: res.errorMessage,
          httpStatus: res.status,
          isSubmitted: false,
        });
        syncProgress(scanId, discovered.size, queue.seenCount, scannedCount, failedCount);
        if (rateLimited) {
          // 429：立即退避，不再继续请求该站点
          event(
            scanId,
            'rate_limited',
            '目标网站开始限制自动访问（429），已停止继续抓取，已完成部分仍然可用。',
            'discovering_pages',
            60
          );
          repo.bumpCounter('ratelimit:' + scan.normalized_domain);
          break;
        }
        continue;
      }

      let body = res.body;
      let finalUrl = res.finalUrl || item.url;
      let urlObj: URL;
      try {
        urlObj = new URL(finalUrl);
      } catch {
        continue;
      }

      const initial = extractPage(body, finalUrl);
      if (initial.textLength < 150 && config.browserFallback.enabled) {
        const rendered = await renderPage(finalUrl);
        if (rendered && rendered.html) {
          const renderedExtract = extractPage(rendered.html, rendered.finalUrl || finalUrl);
          if (renderedExtract.textLength > initial.textLength) {
            body = rendered.html;
            finalUrl = rendered.finalUrl || finalUrl;
            try {
              urlObj = new URL(finalUrl);
            } catch {
              /* keep previous */
            }
          }
        }
      }

      const pageType = classifyPageType(urlObj, initial.title, initial.h1);
      const stored = await storePage(scanId, {
        requestedUrl: item.url,
        finalUrl,
        status: res.status,
        body,
        pageType,
        isSubmitted: false,
      });
      scannedCount++;

      // 内容完全相同的页面只分析一次（同一页面的不同地址），避免重复问题
      if (!contentHashes.has(stored.contentHash)) {
        contentHashes.add(stored.contentHash);
        const ctx = await makeContext(scanId, stored.id, stored.extracted, urlObj, stored.pageType, false);
        crawled.push(ctx);
        if (item.depth < config.maxDepth) {
          enqueueLinks(ctx, baseUrl, robots, item.depth, queue, discovered);
        }
      }

      syncProgress(scanId, discovered.size, queue.seenCount, scannedCount, failedCount);
      event(
        scanId,
        'progress',
        `已检查 ${scannedCount} 个页面`,
        'discovering_pages',
        15 + Math.round((scannedCount / config.maxPages) * 45)
      );
      await sleep(robots.crawlDelayMs > 0 ? Math.min(robots.crawlDelayMs, 2000) : config.crawlDelayMs);
    }

    if (queue.size > 0 || rateLimited) truncated = true;

    /* ------------------- 阶段三：检查内容和链接 ------------------- */
    repo.updateScan(scanId, { current_stage: 'checking_content' });
    event(scanId, 'stage', STAGE_MESSAGE.checking_content, 'checking_content', 65);

    // 已经抓取过的地址（含失败页）不再重复做链接检查，避免同一根因出现两条结果
    const failedUrls = failedPages.map((p) => urlKeySafe(p.url));
    const linkResults = await checkInternalLinks(
      crawled,
      baseUrl,
      deps,
      isCancelled,
      () => requestsMade++,
      new Set(failedUrls)
    );

    const drafts: FindingDraft[] = [];
    drafts.push(...pageAccessFindings(failedPages, submittedRedirectInfo));
    drafts.push(...brokenLinkFindings(linkResults).map((x) => x.draft));
    drafts.push(...expiredDateFindings(crawled));
    drafts.push(...contactFindings(crawled, scan.normalized_domain));
    drafts.push(...contentFindings(crawled));
    drafts.push(...conflictCandidates(crawled));

    /* ------------------- 阶段四：整理结果 ------------------- */
    repo.updateScan(scanId, { current_stage: 'finalizing' });
    event(scanId, 'stage', STAGE_MESSAGE.finalizing, 'finalizing', 85);

    const aiStatus = await applyAiReview(drafts, deps);
    const merged = mergeAndSort(drafts);
    repo.replaceFindings(
      scanId,
      merged.map((f) => ({
        findingType: f.findingType,
        fingerprint: f.fingerprint,
        severity: f.severity,
        title: f.title,
        summary: f.summary,
        pageResultIds: f.pageResultIds,
        evidence: f.evidence,
        recommendation: f.recommendation,
        confidence: f.confidence,
        detectionMethod: f.detectionMethod,
        rankScore: f.rankScore,
      }))
    );
    repo.addDailyUsage(scannedCount, 0);

    const status = crawled.length === 0 ? 'failed' : failedCount > 0 || truncated ? 'partial' : 'complete';
    repo.updateScan(scanId, {
      status,
      current_stage: 'done',
      finished_at: new Date().toISOString(),
      discovered_count: Math.max(discovered.size, queue.seenCount),
      scanned_count: scannedCount,
      failed_count: failedCount,
      complete: truncated || failedCount > 0 ? 0 : 1,
      truncation_note: buildTruncationNote(truncated, queue.size, extraFromSitemap, crawled.length, rateLimited),
      ai_status: aiStatus,
      failure_reason: status === 'failed' ? '没有检查到任何可读取的页面。' : null,
      failure_code: status === 'failed' ? 'NO_PAGES' : null,
    });
    event(scanId, 'done', '检查完成。', 'done', 100);
    logger.info('scan finished', {
      scanId,
      status,
      pages: crawled.length,
      failed: failedCount,
      findings: merged.length,
      aiStatus,
    });
  } catch (err) {
    logger.error('scan crashed', { scanId, message: (err as Error).message });
    repo.updateScan(scanId, {
      status: 'failed',
      current_stage: 'done',
      finished_at: new Date().toISOString(),
      failure_reason: '系统在处理这次检查时出现临时故障，请稍后重试。',
      failure_code: 'UNKNOWN',
    });
    event(scanId, 'failed', '系统在处理这次检查时出现临时故障，请稍后重试。', 'done', 100);
  }
}

/**
 * 只重试本次扫描中失败的页面，不影响已经成功的结果。
 * 对应方案 8.5「部分完成」：允许重试失败页面。
 */
export async function retryFailedPages(scanId: number): Promise<number> {
  const scan = repo.getScanById(scanId);
  if (!scan) return 0;

  const pages = repo.listPageResults(scanId);
  const failed = pages.filter((p) => p.crawl_status === 'failed');
  if (failed.length === 0) return 0;

  repo.updateScan(scanId, { status: 'running', current_stage: 'checking_content' });
  event(scanId, 'retry', `正在重新检查 ${failed.length} 个失败的页面。`, 'checking_content', 60);

  const retriedIds = new Set(failed.map((p) => p.id));
  const newContexts: PageContext[] = [];
  const stillFailed: FailedPage[] = [];
  let recovered = 0;

  const pending = failed.slice(0, config.maxPages);
  let rateLimited = false;

  for (let i = 0; i < pending.length; i++) {
    const page = pending[i];
    const res = await fetchOne(page.requested_url, {});
    if (isRateLimited(res)) {
      // 429：立即退避，本页与剩余未重试页面都保持失败状态，不再继续加压
      rateLimited = true;
      stillFailed.push(toFailedPage(page, res));
      for (const rest of pending.slice(i + 1)) stillFailed.push(toFailedPage(rest));
      event(
        scanId,
        'rate_limited',
        '目标网站正在限制自动访问（429），已停止继续重试，稍后再试。',
        'checking_content',
        90
      );
      repo.bumpCounter('ratelimit:' + scan.normalized_domain);
      break;
    }
    if (res.body && res.status !== null && res.status < 400 && !res.errorCode) {
      const stored = await storePage(scanId, {
        requestedUrl: page.requested_url,
        finalUrl: res.finalUrl || page.requested_url,
        status: res.status,
        body: res.body,
        pageType: classifyPageType(new URL(res.finalUrl || page.requested_url), null, null),
        isSubmitted: false,
      });
      newContexts.push(
        await makeContext(scanId, stored.id, stored.extracted, new URL(res.finalUrl || page.requested_url), stored.pageType, false)
      );
      recovered++;
    } else {
      stillFailed.push(toFailedPage(page, res));
    }
  }

  const drafts: FindingDraft[] = [];
  drafts.push(...pageAccessFindings(stillFailed));
  drafts.push(...expiredDateFindings(newContexts));
  drafts.push(...contactFindings(newContexts, scan.normalized_domain));
  drafts.push(...contentFindings(newContexts));

  // 与已有结果合并：被重试页面产生的旧结果先移除，再写入新结果
  const existing = repo.listFindings(scanId);
  const newFingerprints = new Set(drafts.map((d) => d.fingerprint));
  const kept = existing.filter((f) => {
    if (newFingerprints.has(f.fingerprint)) return false;
    let ids: number[] = [];
    try {
      ids = JSON.parse(f.page_result_ids) as number[];
    } catch {
      ids = [];
    }
    if (ids.length > 0 && ids.every((id) => retriedIds.has(id))) return false;
    return true;
  });

  const merged = [
    ...drafts.map((d) => ({
      findingType: d.findingType,
      fingerprint: d.fingerprint,
      severity: d.severity,
      title: d.title,
      summary: d.summary,
      pageResultIds: d.pageResultIds,
      evidence: d.evidence,
      recommendation: d.recommendation,
      confidence: d.confidence,
      detectionMethod: d.detectionMethod,
      rankScore: d.rankScore,
    })),
    ...kept.map((f) => ({
      findingType: f.finding_type,
      fingerprint: f.fingerprint,
      severity: f.severity,
      title: f.title,
      summary: f.summary,
      pageResultIds: safeIds(f.page_result_ids),
      evidence: safeJson(f.evidence_json),
      recommendation: f.recommendation,
      confidence: f.confidence,
      detectionMethod: f.detection_method,
      rankScore: f.rank_score,
    })),
  ];
  repo.replaceFindings(scanId, merged);

  const okCount = pages.filter((p) => p.crawl_status === 'ok').length + recovered;
  const failCount = stillFailed.length;
  repo.updateScan(scanId, {
    status: failCount > 0 ? 'partial' : 'complete',
    current_stage: 'done',
    finished_at: new Date().toISOString(),
    scanned_count: okCount,
    failed_count: failCount,
    complete: failCount > 0 ? 0 : 1,
    failure_reason: null,
    failure_code: null,
    truncation_note: rateLimited ? withRateLimitNote(scan.truncation_note) : scan.truncation_note,
  });
  event(
    scanId,
    'retry_done',
    rateLimited ? `已重新检查 ${recovered} 个页面，其余页面因目标网站限流未重试。` : `已重新检查 ${recovered} 个页面。`,
    'done',
    100
  );
  return recovered;
}

/** 失败页面记录转换为规则层需要的结构；res 存在时用本次重试的失败原因。 */
function toFailedPage(page: PageResultRow, res?: FetchOutcome): FailedPage {
  return {
    id: page.id,
    url: page.requested_url,
    pageType: (page.page_type as FailedPage['pageType']) ?? 'other',
    errorCode: res ? res.errorCode : page.error_code,
    errorMessage: res ? res.errorMessage : page.error_message,
    httpStatus: res ? res.status : page.http_status,
    isSubmitted: false,
  };
}

/** 在原有截断说明后补充 429 说明（已包含时不重复追加）。 */
function withRateLimitNote(existing: string | null): string {
  const note = '目标网站返回 429（限制自动访问），本次重试已提前停止。';
  if (!existing) return note;
  return existing.includes('429') ? existing : existing + note;
}

function safeIds(raw: string): number[] {
  try {
    return JSON.parse(raw) as number[];
  } catch {
    return [];
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function event(scanId: number, type: string, message: string, stage?: ScanStage, progress?: number): void {
  repo.addScanEvent(scanId, type, message, stage, progress);
}

/** 把页面中的站内链接加入候选队列（受排除规则、robots 与去重约束）。 */
function enqueueLinks(
  page: PageContext,
  baseUrl: URL,
  robots: { disallowAll: boolean; allowPatterns: string[]; disallowPatterns: string[] },
  currentDepth: number,
  queue: PageQueue,
  discovered: Set<string>
): void {
  for (const link of page.extracted.links) {
    if (!link.internal) continue;
    if (isExcludedUrl(link.href, baseUrl)) continue;
    let parsed: URL;
    try {
      parsed = new URL(link.href);
    } catch {
      continue;
    }
    if (!isAllowed(robots as never, parsed)) continue;
    if (discovered.has(urlKeySafe(link.href))) continue;
    queue.push({
      url: link.href,
      depth: currentDepth + 1,
      score: scoreUrl(parsed, classifyPageType(parsed), currentDepth + 1, 'link'),
      source: 'link',
    });
  }
}

function syncProgress(
  scanId: number,
  discovered: number,
  seen: number,
  scanned: number,
  failed: number
): void {
  repo.updateScan(scanId, {
    discovered_count: Math.max(discovered, seen),
    scanned_count: scanned,
    failed_count: failed,
  });
}

/** 目标站点限流判定（主抓取与失败页重试共用）：429 必须立即停止继续请求。 */
function isRateLimited(res: Pick<FetchOutcome, 'status'>): boolean {
  return res.status === 429;
}

async function fetchOne(url: string, deps: PipelineDeps): Promise<FetchOutcome> {
  if (deps.fetchPage) return deps.fetchPage(url);
  const res = await safeFetch(url);
  return {
    body: res.body,
    status: res.status,
    errorCode: res.errorCode,
    errorMessage: res.errorMessage,
    finalUrl: res.finalUrl ?? url,
    crossDomain: res.crossDomainRedirect,
  };
}

async function storePage(
  scanId: number,
  input: {
    requestedUrl: string;
    finalUrl: string;
    status: number | null;
    body: string;
    pageType: PageType;
    isSubmitted: boolean;
  }
): Promise<{ id: number; extracted: ExtractedPage; pageType: PageType; contentHash: string }> {
  const extracted = extractPage(input.body, input.finalUrl);
  let url: URL;
  try {
    url = new URL(input.finalUrl);
  } catch {
    url = new URL('https://invalid.invalid/');
  }
  const pageType =
    input.isSubmitted && (url.pathname === '/' || url.pathname === '') ? 'home' : classifyPageType(url, extracted.title, extracted.h1);
  const text = extracted.text.slice(0, 200_000);
  const contentHash = sha256(text);
  const id = repo.upsertPageResult({
    scanId,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    normalizedUrl: urlKeySafe(input.finalUrl),
    httpStatus: input.status,
    title: extracted.title ? extracted.title.slice(0, 300) : null,
    h1: extracted.h1 ? extracted.h1.slice(0, 300) : null,
    normalizedText: text,
    contentHash,
    pageType,
    crawlStatus: 'ok',
    errorCode: null,
    errorMessage: null,
    fetchMs: null,
  });
  return { id, extracted, pageType, contentHash };
}

async function storeFailure(
  scanId: number,
  input: { requestedUrl: string; finalUrl: string; status: number | null; errorCode: string | null; errorMessage: string | null }
): Promise<number> {
  return repo.upsertPageResult({
    scanId,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    normalizedUrl: urlKeySafe(input.requestedUrl),
    httpStatus: input.status,
    title: null,
    h1: null,
    normalizedText: null,
    contentHash: null,
    pageType: classifyPageType(new URL(input.requestedUrl)),
    crawlStatus: 'failed',
    errorCode: input.errorCode,
    errorMessage: input.errorMessage ? input.errorMessage.slice(0, 300) : null,
    fetchMs: null,
  });
}

async function makeContext(
  scanId: number,
  pageId: number,
  extracted: ExtractedPage,
  url: URL,
  pageType: PageType,
  isSubmitted: boolean
): Promise<PageContext> {
  const facts = extractFacts(extracted, url, pageType);
  repo.deleteFactsForPage(scanId, pageId);
  if (facts.length > 0) {
    repo.insertFacts(
      scanId,
      pageId,
      facts.map((f) => ({
        factType: f.factType,
        entityKey: f.entityKey,
        rawText: f.rawText,
        normalizedValue: f.normalizedValue,
        unit: f.unit,
        qualifier: f.qualifier,
        contextText: f.contextText,
        confidence: f.confidence,
      }))
    );
  }
  const stored = repo.listFacts(scanId).filter((f) => f.page_result_id === pageId);
  return {
    id: pageId,
    url: url.toString(),
    finalUrl: url.toString(),
    pageType,
    importance: pageImportance(pageType),
    title: extracted.title,
    h1: extracted.h1,
    httpStatus: null,
    isSubmitted,
    extracted,
    facts: stored.map((f) => ({
      id: f.id,
      factType: f.fact_type,
      entityKey: f.entity_key,
      rawText: f.raw_text,
      normalizedValue: f.normalized_value,
      unit: f.unit,
      qualifier: f.qualifier,
      contextText: f.context_text,
      groupKey: `${f.fact_type}:${f.entity_key}:${f.unit ?? ''}:${f.qualifier ?? ''}`,
      confidence: f.confidence,
    })),
  };
}

async function checkInternalLinks(
  pages: PageContext[],
  baseUrl: URL,
  deps: PipelineDeps,
  isCancelled: () => boolean,
  countRequest: () => void,
  skipKeys: Set<string> = new Set()
): Promise<LinkCheckResult[]> {
  const targets = new Map<string, PageContext[]>();
  const alreadyFetched = new Set(pages.map((p) => urlKeySafe(p.finalUrl)));
  for (const k of skipKeys) alreadyFetched.add(k);

  for (const page of pages) {
    for (const link of page.extracted.links) {
      if (!link.internal) continue;
      if (isExcludedUrl(link.href, baseUrl)) continue;
      const key = urlKeySafe(link.href);
      if (alreadyFetched.has(key)) continue;
      const list = targets.get(key) ?? [];
      if (!list.some((p) => p.id === page.id)) list.push(page);
      targets.set(key, list);
    }
  }

  const entries = Array.from(targets.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 60);

  const limit = pLimit(4);
  const results: LinkCheckResult[] = [];
  await Promise.all(
    entries.map(([key, sources]) =>
      limit(async () => {
        if (isCancelled()) return;
        countRequest();
        const url = findOriginalHref(sources, key) ?? key;
        const res = deps.linkCheck
          ? await deps.linkCheck(url)
          : await (async () => {
              const r = await checkLinkStatus(url);
              return { status: r.status, errorCode: r.errorCode };
            })();
        results.push({ target: url, status: res.status, errorCode: res.errorCode, sources });
      })
    )
  );
  return results;
}

function findOriginalHref(sources: PageContext[], key: string): string | null {
  for (const s of sources) {
    const link = s.extracted.links.find((l) => urlKeySafe(l.href) === key);
    if (link) return link.href;
  }
  return null;
}

async function applyAiReview(drafts: FindingDraft[], deps: PipelineDeps): Promise<string> {
  const candidates = drafts.filter((d) => d.aiReview);
  if (candidates.length === 0) return 'not_needed';

  const inputs = candidates.map((d) => d.aiReview!);
  const result = deps.aiReview ? await deps.aiReview(inputs) : await reviewCandidates(inputs);

  if (result.status !== 'ok') {
    // 安全降级：丢弃依赖 AI 的低置信度候选，保留规则强候选并标注
    for (let i = drafts.length - 1; i >= 0; i--) {
      const d = drafts[i];
      if (!d.aiReview) continue;
      if (d.findingType === 'conflict_quota') {
        drafts.splice(i, 1);
      } else {
        d.summary = `${d.summary}（本次未能完成自动复核，请人工确认。）`;
      }
    }
    return result.status;
  }

  const verdicts = result.verdicts;
  for (let i = drafts.length - 1; i >= 0; i--) {
    const d = drafts[i];
    if (!d.aiReview) continue;
    const idx = inputs.indexOf(d.aiReview);
    const verdict = verdicts[idx];
    if (!verdict || !verdict.is_suspected_issue || verdict.confidence < config.ai.minConfidence) {
      drafts.splice(i, 1);
      continue;
    }
    d.detectionMethod = 'ai_reviewed';
    d.confidence = verdict.confidence;
    d.summary = verdict.summary || d.summary;
    if (verdict.possible_explanation) {
      d.evidence = { ...d.evidence, extra: { possible_explanation: verdict.possible_explanation } };
    }
    if (verdict.recommended_check) d.recommendation = verdict.recommended_check;
    if (verdict.evidence_a && d.evidence.side_a) d.evidence.side_a.quote = verdict.evidence_a;
    if (verdict.evidence_b && d.evidence.side_b) d.evidence.side_b.quote = verdict.evidence_b;
    if (verdict.confidence >= 0.75 && /price|refund/.test(d.findingType)) d.severity = 'critical';
    d.rankScore = baseRankScore(
      d.severity,
      'ai_reviewed',
      d.pageResultIds.length > 0 ? 0.8 : 0.5,
      d.pageResultIds.length,
      verdict.confidence
    );
  }
  return 'ok';
}

/** 同一 fingerprint 只保留排序分最高的一条，再做稳定排序。 */
export function mergeAndSort(drafts: FindingDraft[]): FindingDraft[] {
  const map = new Map<string, FindingDraft>();
  for (const d of drafts) {
    const existing = map.get(d.fingerprint);
    if (!existing || d.rankScore > existing.rankScore) map.set(d.fingerprint, d);
  }
  return Array.from(map.values()).sort(
    (a, b) => b.rankScore - a.rankScore || a.fingerprint.localeCompare(b.fingerprint)
  );
}

function buildTruncationNote(
  truncated: boolean,
  queueLeft: number,
  extraSitemap: number,
  scanned: number,
  rateLimited = false
): string | null {
  if (!truncated && extraSitemap === 0) return null;
  const parts: string[] = [`本次最多检查 ${config.maxPages} 个页面，已检查 ${scanned} 个。`];
  if (rateLimited) parts.push('目标网站返回 429（限制自动访问），已提前停止抓取。');
  if (queueLeft > 0) parts.push(`另有约 ${queueLeft} 个已发现的页面未检查。`);
  if (extraSitemap > 0) parts.push(`站点地图中还有约 ${extraSitemap} 个页面未纳入本次检查。`);
  return parts.join('');
}
