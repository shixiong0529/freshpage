import './../setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, addMissingScheme, isSameSite, urlKey } from '../../src/security/url';

test('裸域名自动补全 https', () => {
  assert.equal(addMissingScheme('example.com'), 'https://example.com');
  assert.equal(addMissingScheme('example.com/pricing'), 'https://example.com/pricing');
  assert.equal(addMissingScheme('http://example.com'), 'http://example.com');
  assert.equal(addMissingScheme('//example.com'), 'https://example.com');
});

test('标准化：去 hash、去追踪参数、小写 host、去默认端口', () => {
  const r = normalizeUrl('HTTPS://WWW.Example.com:443/pricing/?utm_source=x&a=1#top');
  assert.ok(r.ok && r.url && r.normalizedUrl && r.normalizedDomain);
  assert.equal(r.url?.protocol, 'https:');
  assert.equal(r.normalizedDomain, 'example.com');
  assert.ok(!r.normalizedUrl.includes('utm_source'));
  assert.ok(!r.normalizedUrl.includes('#'));
});

test('拒绝非 http/https 协议', () => {
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.com']) {
    const r = normalizeUrl(bad);
    assert.equal(r.ok, false, `${bad} 应被拒绝`);
    assert.equal(r.errorCode, 'UNSUPPORTED_SCHEME');
  }
});

test('空输入与乱码输入被拒绝', () => {
  assert.equal(normalizeUrl('').ok, false);
  assert.equal(normalizeUrl('   ').ok, false);
});

test('同站判定允许 www 变体，区分不同域名', () => {
  assert.equal(isSameSite(new URL('https://www.a.com/x'), new URL('https://a.com/y')), true);
  assert.equal(isSameSite(new URL('https://a.com'), new URL('https://b.com')), false);
});

test('urlKey 对追踪参数与尾斜杠归一化', () => {
  assert.equal(urlKey('https://a.com/x/?utm_source=1'), urlKey('https://a.com/x/'));
  assert.equal(urlKey('https://a.com/x'), urlKey('https://a.com/x/'));
});
