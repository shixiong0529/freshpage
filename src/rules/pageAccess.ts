import { fingerprint as fp } from '../util/misc';
import { urlKey } from '../security/url';
import type { FailedPage, FindingDraft } from './types';
import { baseRankScore, SEVERITY_LABEL } from './types';
import type { Severity } from '../types';

const IMPACTFUL: Severity = 'critical';

/** 页面访问异常（确定性检查）。 */
export function pageAccessFindings(
  failed: FailedPage[],
  submitted?: { url: string; finalUrl?: string | null; crossDomain?: boolean }
): FindingDraft[] {
  const out: FindingDraft[] = [];

  if (submitted?.crossDomain && submitted.finalUrl) {
    out.push({
      findingType: 'cross_domain_redirect',
      fingerprint: fp(['cross_domain_redirect', urlKey(submitted.url)]),
      severity: 'warning',
      title: '提交的网址跳转到了其他域名',
      summary: `访问 ${submitted.url} 时最终跳转到了 ${submitted.finalUrl}。请确认这是预期的跳转。`,
      pageResultIds: [],
      evidence: {
        side_a: { url: submitted.url, quote: submitted.url, note: '提交的地址' },
        side_b: { url: submitted.finalUrl, quote: submitted.finalUrl, note: '最终到达的地址' },
      },
      recommendation: '确认跳转目标是否仍是你的网站；如已更换域名，请更新对外公布的地址。',
      confidence: 1,
      detectionMethod: 'deterministic',
      rankScore: 0,
    });
  }

  for (const p of failed) {
    const important = p.isSubmitted || p.pageType === 'home' || p.pageType === 'pricing';
    const severity: Severity = important ? IMPACTFUL : 'warning';
    const reasonText = describeFailure(p);
    const draft: FindingDraft = {
      findingType: 'page_unreachable',
      fingerprint: fp(['page_unreachable', urlKey(p.url)]),
      severity,
      title: important ? '重要页面无法访问' : '页面无法访问',
      summary: `${p.url} 未能成功读取：${reasonText}`,
      pageResultIds: [p.id],
      evidence: {
        side_a: { url: p.url, page_type: p.pageType, quote: p.url, note: reasonText },
      },
      recommendation:
        p.errorCode === 'ROBOTS_DISALLOWED'
          ? '该页面被 robots.txt 禁止抓取，这是预期行为；如希望被检查，请调整 robots.txt。'
          : '确认页面仍然存在并可公开访问；如已下线，请移除指向它的链接。',
      confidence: 1,
      detectionMethod: 'deterministic',
      rankScore: 0,
    };
    draft.rankScore = baseRankScore(draft.severity, 'deterministic', important ? 1 : 0.5, 1, 1);
    out.push(draft);
  }

  return out;
}

function describeFailure(p: FailedPage): string {
  if (p.errorCode === 'HTTP_ERROR' && p.httpStatus) {
    if (p.httpStatus >= 500) return `服务器返回 ${p.httpStatus} 错误。`;
    if (p.httpStatus === 404 || p.httpStatus === 410) return `页面不存在（${p.httpStatus}）。`;
    if (p.httpStatus === 403) return `服务器拒绝访问（403），可能需要登录。`;
    if (p.httpStatus === 429) return '网站暂时限制了自动访问（429）。';
    return `服务器返回 ${p.httpStatus} 状态码。`;
  }
  switch (p.errorCode) {
    case 'TIMEOUT':
      return '页面加载超时。';
    case 'DNS_FAILURE':
      return '域名无法解析。';
    case 'TOO_MANY_REDIRECTS':
      return '重定向次数过多。';
    case 'REDIRECT_LOOP':
      return '存在重定向循环。';
    case 'CROSS_DOMAIN_REDIRECT':
      return '最终跳转到了其他域名。';
    case 'ROBOTS_DISALLOWED':
      return 'robots.txt 不允许自动访问。';
    case 'BLOCKED_ADDRESS':
      return '目标地址指向内部网络，已拒绝访问。';
    case 'BLOCKED_PORT':
      return '目标端口不被允许。';
    case 'UNSUPPORTED_CONTENT_TYPE':
      return '页面不是可读取的文本内容。';
    case 'RESPONSE_TOO_LARGE':
      return '页面内容过大。';
    case 'NETWORK_ERROR':
      return '网络连接失败。';
    default:
      return p.errorMessage || '页面无法访问。';
  }
}

export { SEVERITY_LABEL };
