import './../setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../../src/extract/html';
import { extractFacts } from '../../src/extract/facts';
import { conflictCandidates } from '../../src/rules/conflicts';
import { expiredDateFindings } from '../../src/rules/dates';
import { contentFindings } from '../../src/rules/content';
import { contactFindings } from '../../src/rules/contact';
import { pageAccessFindings } from '../../src/rules/pageAccess';
import { mergeAndSort } from '../../src/scan/pipeline';
import type { PageContext } from '../../src/rules/types';

function page(id: number, url: string, html: string, pageType: PageContext['pageType'] = 'other', text?: string): PageContext {
  const extracted = extractPage(html, url);
  if (text) {
    extracted.text = text;
    extracted.textLength = text.length;
  }
  const facts = extractFacts(extracted, new URL(url), pageType);
  return {
    id,
    url,
    finalUrl: url,
    pageType,
    importance: pageType === 'pricing' ? 0.95 : pageType === 'blog' ? 0.3 : 0.6,
    title: extracted.title,
    h1: extracted.h1,
    httpStatus: 200,
    isSubmitted: false,
    extracted,
    facts: facts.map((f, i) => ({
      id: i + 1,
      factType: f.factType,
      entityKey: f.entityKey,
      rawText: f.rawText,
      normalizedValue: f.normalizedValue,
      unit: f.unit ?? null,
      qualifier: f.qualifier ?? null,
      contextText: f.contextText,
      groupKey: f.groupKey,
      confidence: f.confidence,
    })),
  };
}

test('价格冲突：同币种同周期不同值会生成候选', () => {
  const a = page(1, 'https://a.com/pricing', '<html><body><h1>价格</h1><p>Pro 专业版 每月 ¥299。</p></body></html>', 'pricing');
  const b = page(2, 'https://a.com/help', '<html><body><h1>帮助</h1><p>Pro 专业版 每月 ¥399。</p></body></html>', 'help');
  const findings = conflictCandidates([a, b]);
  assert.ok(findings.length >= 1, '应生成价格冲突候选');
  const f = findings[0];
  assert.equal(f.findingType, 'conflict_price');
  assert.ok(f.evidence.side_a && f.evidence.side_b, '必须并排展示双方原文');
  assert.ok(f.aiReview, '候选需要送 AI 复核');
});

test('月付与年付不被判为冲突', () => {
  const a = page(1, 'https://a.com/pricing', '<html><body><p>Pro 专业版 每月 ¥299。</p></body></html>', 'pricing');
  const b = page(2, 'https://a.com/help', '<html><body><p>Pro 专业版 每年 ¥2999。</p></body></html>', 'help');
  const findings = conflictCandidates([a, b]);
  assert.equal(findings.filter((f) => f.findingType === 'conflict_price').length, 0);
});

test('不同币种不被判为冲突', () => {
  const a = page(1, 'https://a.com/pricing', '<html><body><p>Pro is $29 per month。</p></body></html>', 'pricing');
  const b = page(2, 'https://a.com/help', '<html><body><p>Pro 专业版 每月 ¥299。</p></body></html>', 'help');
  const findings = conflictCandidates([a, b]);
  assert.equal(findings.filter((f) => f.findingType === 'conflict_price').length, 0);
});

test('起步价与示例数据被排除', () => {
  const a = page(1, 'https://a.com/pricing', '<html><body><p>Pro 专业版 每月 ¥299。</p></body></html>', 'pricing');
  const b = page(2, 'https://a.com/help', '<html><body><p>例如 Pro 专业版 每月 ¥199 起。</p></body></html>', 'help');
  const findings = conflictCandidates([a, b]);
  assert.equal(findings.filter((f) => f.findingType === 'conflict_price').length, 0);
});

test('试用期不一致会生成候选', () => {
  const a = page(1, 'https://a.com/pricing', '<html><body><p>提供 14 天免费试用。</p></body></html>', 'pricing');
  const b = page(2, 'https://a.com/features', '<html><body><p>提供 30 天免费试用。</p></body></html>', 'features');
  const findings = conflictCandidates([a, b]);
  assert.ok(findings.some((f) => f.findingType === 'conflict_trial_days'));
});

test('博客发布日期不会被当作过期内容', () => {
  const blog = page(
    1,
    'https://a.com/blog/1',
    '<html><head><title>2025 回顾</title><meta property="article:published_time" content="2025-03-18T09:00:00Z"></head><body><h1>2025 回顾</h1><p>发布于 2025-03-18 的文章。</p></body></html>',
    'blog'
  );
  const findings = expiredDateFindings([blog]);
  assert.equal(findings.length, 0, '博客发布时间不应被报告');
});

test('首页促销截止日期已过会被报告', () => {
  const home = page(
    1,
    'https://a.com/',
    '<html><head><title>首页</title></head><body><h1>首页</h1><p>夏季促销活动截止 2026年6月30日，报名从速。</p></body></html>',
    'home'
  );
  const findings = expiredDateFindings([home]);
  assert.ok(findings.length >= 1);
  assert.equal(findings[0].findingType, 'expired_date');
});

test('未替换模板变量被判定为需要优先处理', () => {
  const p = page(1, 'https://a.com/pricing', '<html><head><title>价格</title></head><body><h1>价格</h1><p>当前折扣为 {{discount_label}} 请稍后。</p></body></html>', 'pricing');
  const findings = contentFindings([p]);
  const placeholder = findings.find((f) => f.findingType === 'placeholder_content');
  assert.ok(placeholder);
  assert.equal(placeholder.severity, 'critical');
});

test('不同联系电话生成候选', () => {
  const a = page(1, 'https://a.com/contact', '<html><body><p>客服电话：400-123-4567</p></body></html>', 'contact');
  const b = page(2, 'https://a.com/about', '<html><body><p>联系电话：0755-8888-6666</p></body></html>', 'about');
  const findings = contactFindings([a, b], 'a.com');
  assert.ok(findings.some((f) => f.findingType === 'contact_phone_mismatch'));
});

test('免费邮箱域名不会被误判为品牌不一致', () => {
  const a = page(1, 'https://a.com/contact', '<html><body><p>邮箱：someone@gmail.com</p></body></html>', 'contact');
  const findings = contactFindings([a], 'a.com');
  assert.equal(findings.filter((f) => f.findingType === 'contact_email_domain_mismatch').length, 0);
});

test('提交地址无法访问时判定为需要优先处理', () => {
  const findings = pageAccessFindings(
    [{ id: 1, url: 'https://a.com/', pageType: 'home', errorCode: 'TIMEOUT', errorMessage: '超时', httpStatus: null, isSubmitted: true }]
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
});

test('同一 fingerprint 只保留一条，并按严重度排序', () => {
  const base = {
    findingType: 'x',
    title: 't',
    summary: 's',
    pageResultIds: [1],
    evidence: {},
    recommendation: 'r',
    confidence: 1,
    detectionMethod: 'deterministic' as const,
  };
  const merged = mergeAndSort([
    { ...base, fingerprint: 'a', severity: 'info', rankScore: 10 },
    { ...base, fingerprint: 'a', severity: 'critical', rankScore: 900 },
    { ...base, fingerprint: 'b', severity: 'warning', rankScore: 500 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].severity, 'critical');
  assert.equal(merged[1].severity, 'warning');
});
