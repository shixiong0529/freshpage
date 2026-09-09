import { fingerprint as fp } from '../util/misc';
import { normalizeDomain } from '../security/url';
import type { FindingDraft, PageContext } from './types';
import { baseRankScore, quoteOf } from './types';

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com',
  'qq.com', '163.com', '126.com', 'foxmail.com', 'sina.com', 'sohu.com', 'icloud.com',
  'me.com', 'protonmail.com', 'proton.me', 'zoho.com', 'yeah.net', '139.com', 'aliyun.com',
]);

function normalizeTel(raw: string): string {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('+86')) digits = digits.slice(3);
  else if (digits.startsWith('86') && digits.length >= 13) digits = digits.slice(2);
  if (digits.startsWith('+')) digits = digits.slice(1);
  return digits;
}

/** 同一号码的判定：比较后 8 位，兼容不同书写格式。 */
function phoneKey(digits: string): string {
  return digits.length > 8 ? digits.slice(-8) : digits;
}

/**
 * 联系信息异常候选（只报告候选，不宣称一定错误）。
 */
export function contactFindings(pages: PageContext[], siteDomain: string): FindingDraft[] {
  const out: FindingDraft[] = [];
  if (pages.length === 0) return out;

  /* ---------- 多个不同的主要联系电话 ---------- */
  const phoneMap = new Map<string, Array<{ page: PageContext; raw: string }>>();
  for (const page of pages) {
    const candidates = [...page.extracted.phones, ...page.extracted.tels];
    for (const raw of candidates) {
      const norm = normalizeTel(raw);
      if (norm.length < 7) continue;
      const key = phoneKey(norm);
      const list = phoneMap.get(key) ?? [];
      if (!list.some((x) => x.page.id === page.id)) list.push({ page, raw });
      phoneMap.set(key, list);
    }
  }

  if (phoneMap.size >= 2) {
    const groups = Array.from(phoneMap.entries());
    // 只比较出现在「联系/首页/关于」类页面上的号码，减少误报
    const relevant = groups.filter(([, list]) => list.some((x) => x.page.importance >= 0.6 || x.page.pageType === 'contact'));
    if (relevant.length >= 2) {
      const sorted = relevant.sort((a, b) => b[1].length - a[1].length);
      const [keyA, listA] = sorted[0];
      const [keyB, listB] = sorted[1];
      const pa = listA[0];
      const pb = listB[0];
      const allPages = Array.from(new Map([...listA, ...listB].map((x) => [x.page.id, x.page])).values());
      const draft: FindingDraft = {
        findingType: 'contact_phone_mismatch',
        fingerprint: fp(['contact_phone_mismatch', keyA, keyB]),
        severity: 'warning',
        title: '网站上出现了不同的联系电话',
        summary: `在不同页面中发现了两个不同的联系电话：${pa.raw} 与 ${pb.raw}。可能存在新旧号码并存的情况。`,
        pageResultIds: allPages.map((p) => p.id),
        evidence: {
          side_a: {
            url: pa.page.finalUrl || pa.page.url,
            page_type: pa.page.pageType,
            title: pa.page.title,
            quote: quoteOf(pa.page.extracted.text, pa.raw),
            note: '号码一',
          },
          side_b: {
            url: pb.page.finalUrl || pb.page.url,
            page_type: pb.page.pageType,
            title: pb.page.title,
            quote: quoteOf(pb.page.extracted.text, pb.raw),
            note: '号码二',
          },
        },
        recommendation: '确认哪个号码是当前有效的联系方式，并统一全站展示。',
        confidence: 0.6,
        detectionMethod: 'heuristic',
        rankScore: 0,
      };
      draft.rankScore = baseRankScore('warning', 'heuristic', 0.7, allPages.length, 0.6);
      out.push(draft);
    }
  }

  /* ---------- 联系邮箱域名与品牌明显不一致 ---------- */
  const siteRoot = normalizeDomain(siteDomain);
  const emailEntries: Array<{ page: PageContext; email: string; fromMailto: boolean }> = [];
  for (const page of pages) {
    for (const e of page.extracted.emails) entriesPush(emailEntries, page, e, false);
    for (const e of page.extracted.mailtos) entriesPush(emailEntries, page, e, true);
  }
  for (const entry of emailEntries) {
    const domain = entry.email.split('@')[1]?.toLowerCase() ?? '';
    if (!domain) continue;
    if (domain === siteRoot || domain.endsWith(`.${siteRoot}`) || siteRoot.endsWith(`.${domain}`)) continue;
    if (FREE_MAIL_DOMAINS.has(domain)) continue;
    if (!entry.page.importance || entry.page.importance < 0.6) {
      if (entry.page.pageType !== 'contact') continue;
    }
    const draft: FindingDraft = {
      findingType: 'contact_email_domain_mismatch',
      fingerprint: fp(['contact_email_domain_mismatch', domain]),
      // 集团邮箱、外包客服邮箱都很常见，0.55 的置信度撑不起 warning，按规则审核结果降为 info
      severity: 'info',
      title: '联系邮箱的域名与网站域名不一致',
      summary: `页面中出现的邮箱 ${entry.email} 使用的域名与 ${siteRoot} 不同。可能是旧品牌、代理商或第三方服务留下的地址。`,
      pageResultIds: [entry.page.id],
      evidence: {
        side_a: {
          url: entry.page.finalUrl || entry.page.url,
          page_type: entry.page.pageType,
          title: entry.page.title,
          quote: quoteOf(entry.page.extracted.text, entry.email, 60),
          note: entry.fromMailto ? '来自 mailto 链接' : '页面正文中出现',
        },
      },
      recommendation: '确认该邮箱是否仍然属于你的团队；如已更换品牌或外包方，请更新为当前邮箱。',
      confidence: 0.55,
      detectionMethod: 'heuristic',
      rankScore: 0,
    };
    draft.rankScore = baseRankScore('info', 'heuristic', entry.page.importance, 1, 0.55);
    out.push(draft);
  }

  /* ---------- mailto / tel 与页面展示值不一致 ---------- */
  for (const page of pages) {
    for (const mailto of page.extracted.mailtos) {
      const shown = page.extracted.emails;
      if (shown.length === 0) continue;
      if (shown.some((e) => e.toLowerCase() === mailto.toLowerCase())) continue;
      const draft: FindingDraft = {
        findingType: 'mailto_mismatch',
        fingerprint: fp(['mailto_mismatch', page.url, mailto]),
        severity: 'warning',
        title: '邮箱链接地址与页面展示的邮箱不一致',
        summary: `页面展示的邮箱是 ${shown[0]}，但点击链接实际会发送到 ${mailto}。`,
        pageResultIds: [page.id],
        evidence: {
          side_a: {
            url: page.finalUrl || page.url,
            page_type: page.pageType,
            title: page.title,
            quote: quoteOf(page.extracted.text, shown[0], 60),
            note: '页面展示的邮箱',
          },
          side_b: {
            url: page.finalUrl || page.url,
            page_type: page.pageType,
            title: page.title,
            quote: mailto,
            note: 'mailto 链接实际地址',
          },
        },
        recommendation: '确认点击后应发送到哪个邮箱，并让展示值与链接地址保持一致。',
        confidence: 0.75,
        detectionMethod: 'heuristic',
        rankScore: 0,
      };
      draft.rankScore = baseRankScore('warning', 'heuristic', page.importance, 1, 0.75);
      out.push(draft);
    }
  }

  return out;
}

function entriesPush(
  arr: Array<{ page: PageContext; email: string; fromMailto: boolean }>,
  page: PageContext,
  email: string,
  fromMailto: boolean
): void {
  const value = email.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return;
  if (arr.some((x) => x.page.id === page.id && x.email === value)) return;
  arr.push({ page, email: value, fromMailto });
}
