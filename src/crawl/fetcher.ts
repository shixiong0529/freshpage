/**
 * 安全 HTTP 抓取器。
 *
 * 与通用 HTTP 客户端的差异：
 * - 每次请求 / 每次重定向都做 DNS 解析 + IP 校验；
 * - 通过自定义 lookup 固定连接 IP，防止 DNS rebinding；
 * - 限制响应体大小、超时、重定向次数；
 * - 只接受文本类响应，绝不下载或执行文件；
 * - 不提交表单、不携带 Cookie、不执行页面脚本。
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as zlib from 'node:zlib';
import { config } from '../config';
import { pinnedLookup, validateTarget } from '../security/ssrf';
import { isPortAllowed, normalizeDomain } from '../security/url';
import type { ErrorCode, FetchedPage } from '../types';
import { logger } from '../util/logger';

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
  /** 允许接收的 Content-Type 前缀 */
  allowedContentTypes?: string[];
  method?: 'GET' | 'HEAD';
}

const HTML_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/xml', 'text/xml'];

interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
  finalUrl: string;
}

function decodeBody(buf: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch {
    return buf;
  }
  return buf;
}

function requestOnce(
  url: URL,
  opts: FetchOptions,
  pinnedIp: string,
  family: 4 | 6
): Promise<HopResult | { errorCode: ErrorCode; errorMessage: string }> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const timeoutMs = opts.timeoutMs ?? config.requestTimeoutMs;
    const maxBytes = opts.maxBytes ?? config.maxResponseBytes;

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: opts.method ?? 'GET',
      headers: {
        Host: url.host,
        'User-Agent': config.userAgent,
        Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Connection: 'close',
      },
      lookup: pinnedLookup(pinnedIp, family) as never,
      timeout: timeoutMs,
      servername: isHttps ? url.hostname : undefined,
    };

    let settled = false;
    const finish = (value: HopResult | { errorCode: ErrorCode; errorMessage: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        req.destroy(new Error('timeout'));
      } catch {
        /* noop */
      }
      finish({ errorCode: 'TIMEOUT', errorMessage: '页面在限定时间内没有响应。' });
    }, timeoutMs);

    const req = mod.request(options as http.RequestOptions, (res) => {
      const status = res.statusCode ?? 0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
      }

      // HEAD / 不需要 body 的情况（如只验证 3xx）
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;

      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > maxBytes) {
          aborted = true;
          res.destroy();
          finish({
            errorCode: 'RESPONSE_TOO_LARGE',
            errorMessage: '页面内容过大，已停止读取。',
          });
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks);
        const body = decodeBody(raw, headers['content-encoding']);
        finish({ status, headers, body, finalUrl: url.toString() });
      });

      res.on('error', (err: Error) => {
        finish({ errorCode: 'NETWORK_ERROR', errorMessage: err.message });
      });
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOTFOUND') {
        finish({ errorCode: 'DNS_FAILURE', errorMessage: '域名无法解析。' });
        return;
      }
      if (err.code === 'ECONNREFUSED') {
        finish({ errorCode: 'NETWORK_ERROR', errorMessage: '服务器拒绝连接。' });
        return;
      }
      finish({ errorCode: 'NETWORK_ERROR', errorMessage: err.message });
    });

    req.end();
  });
}

export async function safeFetch(startUrl: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const started = Date.now();
  const redirects: string[] = [];
  let current = startUrl;
  const maxRedirects = options.maxRedirects ?? config.maxRedirects;
  const allowedTypes = options.allowedContentTypes ?? HTML_TYPES;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return fail(startUrl, current, 'INVALID_URL', '地址格式无法识别。', redirects, started);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return fail(startUrl, current, 'UNSUPPORTED_SCHEME', '仅支持 http 或 https。', redirects, started);
    }
    if (!isPortAllowed(url)) {
      return fail(startUrl, current, 'BLOCKED_PORT', '目标端口不被允许。', redirects, started);
    }

    const check = await validateTarget(url.hostname.replace(/^\[|\]$/g, ''), url.port);
    if (!check.ok || !check.pinnedIp) {
      const code: ErrorCode = check.reason === 'dns_failure' ? 'DNS_FAILURE' : 'BLOCKED_ADDRESS';
      const msg =
        check.reason === 'dns_resolves_to_private'
          ? '该地址指向内部网络，已拒绝访问。'
          : check.reason === 'dns_failure'
            ? '域名无法解析。'
            : '目标地址不被允许。';
      return fail(startUrl, current, code, msg, redirects, started);
    }

    const result = await requestOnce(url, options, check.pinnedIp, check.family ?? 4);

    if ('errorCode' in result) {
      // 超时 / 网络错误至少重试一次，避免首次抖动即判定失效
      if (hop === 0 && (result.errorCode === 'TIMEOUT' || result.errorCode === 'NETWORK_ERROR')) {
        const retry = await requestOnce(url, options, check.pinnedIp, check.family ?? 4);
        if (!('errorCode' in retry)) {
          return handleHop(retry, url, startUrl, redirects, started, allowedTypes, options);
        }
      }
      return fail(startUrl, current, result.errorCode, result.errorMessage, redirects, started);
    }

    return handleHop(result, url, startUrl, redirects, started, allowedTypes, options);
  }

  return fail(startUrl, current, 'TOO_MANY_REDIRECTS', '重定向次数过多。', redirects, started);
}

function handleHop(
  result: HopResult,
  url: URL,
  startUrl: string,
  redirects: string[],
  started: number,
  allowedTypes: string[],
  options: FetchOptions
): Promise<FetchedPage> {
  const location = result.headers['location'];
  if (result.status >= 300 && result.status < 400 && location) {
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return Promise.resolve(
        fail(startUrl, url.toString(), 'NETWORK_ERROR', '重定向地址无效。', redirects, started)
      );
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return Promise.resolve(
        fail(startUrl, url.toString(), 'UNSUPPORTED_SCHEME', '重定向到了不支持的协议。', redirects, started)
      );
    }
    if (redirects.includes(next.toString())) {
      return Promise.resolve(
        fail(startUrl, url.toString(), 'REDIRECT_LOOP', '页面存在重定向循环。', redirects, started)
      );
    }
    if (redirects.length + 1 > (options.maxRedirects ?? config.maxRedirects)) {
      return Promise.resolve(
        fail(startUrl, url.toString(), 'TOO_MANY_REDIRECTS', '重定向次数过多。', redirects, started)
      );
    }
    redirects.push(next.toString());
    return safeFetchFrom(next, startUrl, redirects, started, options, allowedTypes);
  }

  const contentType = (result.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const bodyBuf = result.body ?? Buffer.alloc(0);
  const body = bodyBuf.toString('utf8');

  if (result.status >= 400) {
    const msg =
      result.status === 429
        ? '目标网站暂时限制了自动访问（429）。'
        : `页面返回了 ${result.status} 状态码。`;
    return Promise.resolve({
      requestedUrl: startUrl,
      finalUrl: url.toString(),
      status: result.status,
      headers: result.headers,
      body: null,
      redirects,
      errorCode: result.status === 429 ? 'HTTP_ERROR' : 'HTTP_ERROR',
      errorMessage: msg,
      elapsedMs: Date.now() - started,
      rendered: false,
      contentType,
      crossDomainRedirect: isCrossDomain(url, startUrl),
    });
  }

  if (contentType && !allowedTypes.some((t) => contentType.startsWith(t))) {
    return Promise.resolve(
      fail(
        startUrl,
        url.toString(),
        'UNSUPPORTED_CONTENT_TYPE',
        '页面不是可读取的文本内容。',
        redirects,
        started,
        result.status,
        result.headers,
        contentType
      )
    );
  }

  return Promise.resolve({
    requestedUrl: startUrl,
    finalUrl: url.toString(),
    status: result.status,
    headers: result.headers,
    body,
    redirects,
    errorCode: null,
    errorMessage: null,
    elapsedMs: Date.now() - started,
    rendered: false,
    contentType,
    crossDomainRedirect: isCrossDomain(url, startUrl),
  });
}

function isCrossDomain(finalUrl: URL, startUrl: string): boolean {
  try {
    return normalizeDomain(finalUrl.hostname) !== normalizeDomain(new URL(startUrl).hostname);
  } catch {
    return false;
  }
}

async function safeFetchFrom(
  next: URL,
  startUrl: string,
  redirects: string[],
  started: number,
  options: FetchOptions,
  allowedTypes: string[]
): Promise<FetchedPage> {
  // 继续重定向链：直接递归 safeFetch 会丢失已累积的 redirects，这里手动重放
  const check = await validateTarget(next.hostname.replace(/^\[|\]$/g, ''), next.port);
  if (!check.ok || !check.pinnedIp) {
    return fail(startUrl, next.toString(), 'BLOCKED_ADDRESS', '重定向目标地址不被允许。', redirects, started);
  }
  if (!isPortAllowed(next)) {
    return fail(startUrl, next.toString(), 'BLOCKED_PORT', '重定向目标端口不被允许。', redirects, started);
  }
  const result = await requestOnce(next, options, check.pinnedIp, check.family ?? 4);
  if ('errorCode' in result) {
    return fail(startUrl, next.toString(), result.errorCode, result.errorMessage, redirects, started);
  }
  return handleHop(result, next, startUrl, redirects, started, allowedTypes, options);
}

function fail(
  startUrl: string,
  finalUrl: string,
  code: ErrorCode,
  message: string,
  redirects: string[],
  started: number,
  status: number | null = null,
  headers: Record<string, string> = {},
  contentType: string | null = null
): FetchedPage {
  logger.debug('fetch failed', { finalUrl, code });
  let crossDomainRedirect = false;
  try {
    crossDomainRedirect =
      normalizeDomain(new URL(finalUrl).hostname) !== normalizeDomain(new URL(startUrl).hostname);
  } catch {
    /* ignore */
  }
  return {
    requestedUrl: startUrl,
    finalUrl,
    status,
    headers,
    body: null,
    redirects,
    errorCode: code,
    errorMessage: message,
    elapsedMs: Date.now() - started,
    rendered: false,
    contentType,
    crossDomainRedirect,
  };
}

/**
 * 仅检查链接可达性：读到响应头即断开，不下载正文。
 * 用于失效站内链接检测，避免为大量链接拉取完整页面。
 */
export async function checkLinkStatus(
  startUrl: string,
  maxRedirects = 3
): Promise<{ status: number | null; finalUrl: string; errorCode: ErrorCode | null; crossDomain: boolean }> {
  let current = startUrl;
  const visited: string[] = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return { status: null, finalUrl: current, errorCode: 'INVALID_URL', crossDomain: false };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { status: null, finalUrl: current, errorCode: 'UNSUPPORTED_SCHEME', crossDomain: false };
    }
    if (!isPortAllowed(url)) {
      return { status: null, finalUrl: current, errorCode: 'BLOCKED_PORT', crossDomain: false };
    }
    const check = await validateTarget(url.hostname.replace(/^\[|\]$/g, ''), url.port);
    if (!check.ok || !check.pinnedIp) {
      return {
        status: null,
        finalUrl: current,
        errorCode: check.reason === 'dns_failure' ? 'DNS_FAILURE' : 'BLOCKED_ADDRESS',
        crossDomain: false,
      };
    }

    const result = await new Promise<{ status: number; headers: Record<string, string> } | { errorCode: ErrorCode }>(
      (resolve) => {
        const isHttps = url.protocol === 'https:';
        const mod = isHttps ? https : http;
        const timeoutMs = Math.min(config.requestTimeoutMs, 10_000);
        const req = mod.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            headers: {
              Host: url.host,
              'User-Agent': config.userAgent,
              Accept: '*/*',
              'Accept-Encoding': 'identity',
              Connection: 'close',
            },
            lookup: pinnedLookup(check.pinnedIp!, check.family ?? 4) as never,
            timeout: timeoutMs,
            servername: isHttps ? url.hostname : undefined,
          },
          (res) => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') headers[k.toLowerCase()] = v;
            }
            const status = res.statusCode ?? 0;
            res.destroy();
            req.destroy();
            resolve({ status, headers });
          }
        );
        req.on('error', (err: NodeJS.ErrnoException) => {
          resolve({
            errorCode:
              err.code === 'ENOTFOUND' ? 'DNS_FAILURE' : err.code === 'ECONNREFUSED' ? 'NETWORK_ERROR' : 'NETWORK_ERROR',
          });
        });
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          resolve({ errorCode: 'TIMEOUT' });
        });
        req.end();
      }
    );

    if ('errorCode' in result) {
      if (hop === 0 && (result.errorCode === 'TIMEOUT' || result.errorCode === 'NETWORK_ERROR')) {
        // 网络抖动重试一次
        continue;
      }
      return { status: null, finalUrl: current, errorCode: result.errorCode, crossDomain: false };
    }

    const location = result.headers['location'];
    if (result.status >= 300 && result.status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { status: result.status, finalUrl: current, errorCode: null, crossDomain: false };
      }
      if (visited.includes(next.toString())) {
        return { status: result.status, finalUrl: next.toString(), errorCode: 'REDIRECT_LOOP', crossDomain: false };
      }
      visited.push(next.toString());
      current = next.toString();
      continue;
    }

    return {
      status: result.status,
      finalUrl: current,
      errorCode: null,
      crossDomain: isCrossDomain(url, startUrl),
    };
  }
  return { status: null, finalUrl: current, errorCode: 'TOO_MANY_REDIRECTS', crossDomain: false };
}

/** 只检查可达性（GET 首包，用于首页可达性确认）。 */
export async function headOrGet(url: string, timeoutMs?: number): Promise<FetchedPage> {
  return safeFetch(url, { timeoutMs: timeoutMs ?? Math.min(config.requestTimeoutMs, 8000), method: 'GET' });
}
