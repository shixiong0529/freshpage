import './../setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage, detectPlaceholders } from '../../src/extract/html';
import { extractFacts, extractDates, isPastDate } from '../../src/extract/facts';

test('抽取标题、H1、正文与链接', () => {
  const html = `<html><head><title>价格</title></head><body>
    <h1>套餐价格</h1><p>Pro 每月 ¥299。</p>
    <a href="/help">帮助</a><a href="https://other.com/x">外链</a>
    <a href="mailto:hi@a.com">邮件</a><a href="tel:+8613800138000">电话</a>
  </body></html>`;
  const page = extractPage(html, 'https://a.com/pricing');
  assert.equal(page.title, '价格');
  assert.equal(page.h1, '套餐价格');
  assert.equal(page.links.filter((l) => l.internal).length, 1);
  assert.equal(page.links.filter((l) => !l.internal).length, 1);
  assert.deepEqual(page.mailtos, ['hi@a.com']);
  assert.ok(page.tels.length === 1);
  assert.ok(page.text.includes('Pro 每月 ¥299'));
});

test('抽取邮箱与电话', () => {
  const page = extractPage(
    '<html><body><p>联系 hello@acme.test 或 13800138000，或 0755-8888-6666</p></body></html>',
    'https://a.com/contact'
  );
  assert.ok(page.emails.includes('hello@acme.test'));
  assert.ok(page.phones.some((p) => p.replace(/\D/g, '') === '13800138000'));
  assert.ok(page.phones.some((p) => p.replace(/\D/g, '') === '075588886666'));
});

test('识别占位内容与未替换模板变量', () => {
  const found = detectPlaceholders('欢迎使用 {{company_name}} 的产品，这里是 Lorem ipsum dolor sit amet。');
  assert.ok(found.some((f) => f.label.includes('模板变量')));
  assert.ok(found.some((f) => f.label.includes('Lorem ipsum')));
});

test('价格抽取保留币种与计费周期', () => {
  const page = extractPage('<html><body><p>Pro 专业版 每月 ¥299，Enterprise 每年 ¥2999。</p></body></html>', 'https://a.com/pricing');
  const facts = extractFacts(page, new URL('https://a.com/pricing'), 'pricing');
  const prices = facts.filter((f) => f.factType === 'price');
  assert.ok(prices.length >= 2, `应至少抽到 2 个价格，实际 ${prices.length}`);
  const monthly = prices.find((p) => p.qualifier === 'monthly');
  assert.ok(monthly, '应识别出按月计费');
  assert.equal(monthly?.unit, 'CNY');
  assert.equal(monthly?.normalizedValue, '299');
  // 月付与年付分组键不同，不会被误判为冲突
  const keys = new Set(prices.map((p) => p.groupKey));
  assert.ok(keys.size >= 2);
});

test('美元与人民币不会被互相比较', () => {
  const page = extractPage('<html><body><p>Pro is $29 per month. 专业版 ¥299 每月。</p></body></html>', 'https://a.com/pricing');
  const facts = extractFacts(page, new URL('https://a.com/pricing'), 'pricing');
  const prices = facts.filter((f) => f.factType === 'price');
  const usd = prices.find((p) => p.unit === 'USD');
  const cny = prices.find((p) => p.unit === 'CNY');
  assert.ok(usd && cny);
  assert.notEqual(usd.groupKey, cny.groupKey);
});

test('试用天数与退款期限抽取', () => {
  const page = extractPage(
    '<html><body><p>提供 14 天免费试用，购买后 7 天内可申请无理由退款。</p></body></html>',
    'https://a.com/pricing'
  );
  const facts = extractFacts(page, new URL('https://a.com/pricing'), 'pricing');
  assert.equal(facts.find((f) => f.factType === 'trial_days')?.normalizedValue, '14');
  assert.equal(facts.find((f) => f.factType === 'refund_days')?.normalizedValue, '7');
});

test('日期抽取支持中英文与 ISO', () => {
  const text = '活动截止 2026年6月30日；Deadline: September 8, 2026；发布于 2025-03-18。';
  const dates = extractDates(text);
  assert.ok(dates.some((d) => d.iso === '2026-06-30'));
  assert.ok(dates.some((d) => d.iso === '2026-09-08'));
  assert.ok(dates.some((d) => d.iso === '2025-03-18'));
  // 促销语境会被标记
  assert.equal(dates.find((d) => d.iso === '2026-06-30')?.kind, 'promo');
});

test('过去日期判定按精度比较', () => {
  assert.equal(isPastDate('2020-01-01', 'day', new Date('2026-09-08')), true);
  assert.equal(isPastDate('2030-01-01', 'day', new Date('2026-09-08')), false);
  assert.equal(isPastDate('2026-01', 'month', new Date('2026-09-08')), true);
  assert.equal(isPastDate('2026-12', 'month', new Date('2026-09-08')), false);
});
