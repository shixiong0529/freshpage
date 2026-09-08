/**
 * URL 标准化与校验。
 */
import { config } from '../config';
import { quickBlockCheck } from './ssrf';

export interface NormalizedUrl {
  ok: boolean;
  url?: URL;
  /** 用于去重与比较：去 tracking 参数、去 hash、小写 host、去默认端口 */
  normalizedUrl?: string;
  normalizedDomain?: string;
  errorCode?: string;
  errorMessage?: string;
}

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'igshid',
  'mc_eid',
  'mc_cid',
  'ref_src',
  'ref_url',
  '_ga',
  'yclid',
];

/** 判断字符串是否看起来像裸域名。 */
function looksLikeBareDomain(input: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(input);
}

/** 检测输入是否自带协议（不含点，避免把 example.com:8080 误判为协议）。 */
export function detectScheme(input: string): string | null {
  const m = input.match(/^([a-zA-Z][a-zA-Z0-9+-]*):/);
  return m ? m[1].toLowerCase() : null;
}

export function addMissingScheme(input: string): string {
  const trimmed = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (looksLikeBareDomain(trimmed.split(/[/?#]/)[0])) return `https://${trimmed}`;
  return `https://${trimmed}`;
}

export function normalizeUrl(rawInput: string): NormalizedUrl {
  const input = (rawInput ?? '').trim();
  if (!input) {
    return { ok: false, errorCode: 'INVALID_URL', errorMessage: '请输入网站地址。' };
  }
  // mailto:、javascript:、data:、ftp: 等一律拒绝，不能被当成主机名补全
  const scheme = detectScheme(input);
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return { ok: false, errorCode: 'UNSUPPORTED_SCHEME', errorMessage: '仅支持 http 或 https 开头的网址。' };
  }

  let parsed: URL;
  try {
    parsed = new URL(addMissingScheme(input));
  } catch {
    return { ok: false, errorCode: 'INVALID_URL', errorMessage: '地址格式无法识别，请输入类似 example.com 的网址。' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      errorCode: 'UNSUPPORTED_SCHEME',
      errorMessage: '仅支持 http 或 https 开头的网址。',
    };
  }
  // 内部 / 保留地址优先给出明确原因（测试环境允许私网时跳过）
  if (!config.allowPrivateTargets) {
    const quick = quickBlockCheck(parsed.hostname);
    if (!quick.ok) {
      return {
        ok: false,
        errorCode: 'BLOCKED_ADDRESS',
        errorMessage: '我们不会检查内部或本机地址，请输入一个公开的网站地址。',
      };
    }
  }

  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    // 允许 IP 字面量以外的主机名必须含点；localhost 类地址由 SSRF 层拦截
    if (!/^\[|^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) && !parsed.hostname.includes(':')) {
      return { ok: false, errorCode: 'INVALID_URL', errorMessage: '网址缺少有效的域名。' };
    }
  }

  parsed.hash = '';
  for (const p of TRACKING_PARAMS) parsed.searchParams.delete(p);
  // 空 value 的追踪参数一并清理
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (/^(utm_|_ga|__hs|vero|hsa)/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.port === '80' || parsed.port === '443') parsed.port = '';

  return {
    ok: true,
    url: parsed,
    normalizedUrl: stripIndex(parsed.toString()),
    normalizedDomain: normalizeDomain(parsed.hostname),
  };
}

function stripIndex(u: string): string {
  // 保留尾斜杠一致性：根路径统一为 "/"
  try {
    const url = new URL(u);
    if (url.pathname === '') url.pathname = '/';
    return url.toString();
  } catch {
    return u;
  }
}

/** 归一化为可比较的域名：去端口号、去 www 前缀。 */
export function normalizeDomain(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  if (colon > 0 && !h.includes(']')) h = h.slice(0, colon);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/** 判断两个 URL 是否属于同一站点（同域名，允许 www 变体）。 */
export function isSameSite(a: URL, b: URL): boolean {
  return normalizeDomain(a.hostname) === normalizeDomain(b.hostname);
}

/** 判断端口是否被允许（V0 默认仅 80/443）。 */
export function isPortAllowed(url: URL): boolean {
  if (config.allowPrivateTargets) return true;
  if (url.port === '') return true; // 协议默认端口
  return config.allowedPorts.includes(url.port);
}

export function urlKey(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
    if (url.pathname === '') url.pathname = '/';
    let path = url.pathname;
    if (/^\/index\.(html?|htm|php|aspx)$/i.test(path)) path = '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? ':' + url.port : ''}${path}${
      url.search ? '?' + url.searchParams.toString() : ''
    }`;
  } catch {
    return u;
  }
}
