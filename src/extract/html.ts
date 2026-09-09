/**
 * HTML 内容抽取：标题、H1、正文、链接、联系方式与明显异常标记。
 */
import * as cheerio from 'cheerio';
import type { ExtractedPage } from '../types';
import { normalizeWhitespace } from '../util/misc';

const DROP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'form', 'nav', 'footer', 'header'];

export function extractPage(html: string, baseUrl: string, keepChrome = false): ExtractedPage {
  const $ = cheerio.load(html);
  const title = normalizeWhitespace($('title').first().text() || '') || null;
  const h1 = normalizeWhitespace($('h1').first().text() || '') || null;
  const lang = ($('html').attr('lang') || '').trim() || null;

  const meta: Record<string, string | null> = {
    description: $('meta[name="description"]').attr('content')?.trim() ?? null,
    published:
      $('meta[property="article:published_time"]').attr('content') ??
      $('meta[name="publish_date"]').attr('content') ??
      $('time[datetime]').first().attr('datetime') ??
      null,
    modified:
      $('meta[property="article:modified_time"]').attr('content') ??
      $('meta[name="last-modified"]').attr('content') ??
      null,
  };

  // 链接收集必须在移除标签前完成
  const links: Array<{ href: string; internal: boolean; text: string }> = [];
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    base = new URL('https://invalid.invalid/');
  }
  const siteHost = base.hostname.replace(/^www\./, '').toLowerCase();

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    if (/^(mailto:|tel:|javascript:|data:|#)/i.test(href)) return;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      return;
    }
    const parsed = new URL(absolute);
    const internal = parsed.hostname.replace(/^www\./, '').toLowerCase() === siteHost;
    links.push({ href: absolute, internal, text: normalizeWhitespace($(el).text() || '').slice(0, 120) });
  });

  const mailtos: string[] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const v = ($(el).attr('href') || '').replace(/^mailto:/i, '').trim();
    if (v) mailtos.push(decodeURIComponent(v.split('?')[0]));
  });

  const tels: string[] = [];
  $('a[href^="tel:"]').each((_, el) => {
    const v = ($(el).attr('href') || '').replace(/^tel:/i, '').trim();
    if (v) tels.push(v);
  });

  const clone = cheerio.load(html);
  if (!keepChrome) {
    for (const tag of DROP_TAGS) clone(tag).remove();
  }

  const rawText = clone('body').length ? clone('body').text() : clone.root().text();
  const text = normalizeWhitespace(rawText);

  const bodyHtml = clone('body').html() || '';
  const emails = extractEmails(`${text} ${bodyHtml}`);
  const phones = extractPhones(`${text} ${bodyHtml}`);

  return {
    url: baseUrl,
    finalUrl: baseUrl,
    title,
    h1,
    text,
    textLength: text.length,
    links,
    mailtos: Array.from(new Set(mailtos)),
    tels: Array.from(new Set(tels)),
    emails: Array.from(new Set(emails)),
    phones: Array.from(new Set(phones)),
    lang,
    meta,
  };
}

export function extractEmails(input: string): string[] {
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const email = m[0].toLowerCase();
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(email)) continue;
    out.add(email);
  }
  return Array.from(out);
}

export function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

export function extractPhones(input: string): string[] {
  const out = new Set<string>();
  // 国际格式
  const intl = /\+\d[\d\s().-]{6,20}\d/g;
  let m: RegExpExecArray | null;
  while ((m = intl.exec(input)) !== null) {
    const digits = normalizePhone(m[0]);
    const core = digits.replace(/^\+/, '');
    if (core.length >= 8 && core.length <= 15) out.add(digits);
  }
  // 中国大陆手机号
  const cn = /\b1[3-9]\d{9}\b/g;
  while ((m = cn.exec(input)) !== null) out.add(m[0]);
  // 固话 0755-8888-6666 / 010-12345678 / 021 12345678
  const landlineGrouped = /\b0\d{2,3}[\s-]?\d{3,4}[\s-]?\d{4}\b/g;
  while ((m = landlineGrouped.exec(input)) !== null) out.add(normalizePhone(m[0]));
  const landline = /\b0\d{2,3}[\s-]?\d{7,8}\b/g;
  while ((m = landline.exec(input)) !== null) out.add(normalizePhone(m[0]));
  // 北美格式
  const na = /\b\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
  while ((m = na.exec(input)) !== null) out.add(normalizePhone(m[0]));

  // 过滤掉与日期/金额过于相似的误报
  return Array.from(out).filter((p) => p.replace(/\D/g, '').length >= 7);
}

/**
 * 占位 / 模板残留检测。
 *
 * level=high：几乎只会出现在未完成的生产页面上（模板变量、Lorem ipsum、占位文案）；
 * level=low：在正常技术文档里也会大量出现（TODO、${HOME}、localhost 示例），
 *           只在首页 / 价格页这类关键页面才报告，避免误报。
 */
const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string; level: 'high' | 'low'; template?: boolean }> = [
  { re: /\{\{\s*[a-zA-Z0-9_.\-]+\s*\}\}/, label: '未替换的模板变量 {{...}}', level: 'high', template: true },
  {
    re: /\[\s*(product_?name|company_?name|site_?name|your_\w+|placeholder|example\.com)\s*\]/i,
    label: '未替换的占位标记',
    level: 'high',
    template: true,
  },
  { re: /lorem\s+ipsum/i, label: 'Lorem ipsum 占位文本', level: 'high' },
  { re: /此处填写|待补充|示例文本|示例内容/, label: '占位文案', level: 'high' },
  { re: /under\s+construction|网站建设中|正在建设/i, label: '在建提示', level: 'high' },
  { re: /\$\{\s*[a-zA-Z0-9_.\-]+\s*\}/, label: '未替换的模板变量 ${...}', level: 'low', template: true },
  { re: /<%=\s*[a-zA-Z0-9_.\-]+\s*%>/, label: '未替换的模板变量 <%= ... %>', level: 'low', template: true },
  // XXX 会误伤「XXX 公司」「XXX 元」这类正常占位写法，已按规则审核结果移除
  { re: /\bTODO\b|\bFIXME\b/, label: '开发标记 TODO / FIXME', level: 'low' },
  // 「测试环境地址」曾在这里：localhost / 127.0.0.1 在技术文档与帮助页里是正常内容，误报过多，已移除
];

export interface PlaceholderHit {
  label: string;
  quote: string;
  level: 'high' | 'low';
  template: boolean;
}

export function detectPlaceholders(text: string, title?: string | null): PlaceholderHit[] {
  const haystack = `${title ?? ''} ${text}`;
  const found: PlaceholderHit[] = [];
  for (const { re, label, level, template } of PLACEHOLDER_PATTERNS) {
    const m = haystack.match(re);
    if (m) {
      const idx = haystack.indexOf(m[0]);
      const start = Math.max(0, idx - 40);
      found.push({
        label,
        quote: haystack.slice(start, idx + m[0].length + 40).replace(/\s+/g, ' ').trim(),
        level,
        template: Boolean(template),
      });
    }
  }
  return found;
}
