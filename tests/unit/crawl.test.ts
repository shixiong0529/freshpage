import './../setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed } from '../../src/crawl/robots';
import { classifyPageType, isExcludedUrl, scoreUrl } from '../../src/crawl/discovery';

test('robots.txt 解析 User-agent * 与 Sitemap', () => {
  const rules = parseRobots(
    ['User-agent: *', 'Disallow: /admin', 'Disallow: /secret', 'Allow: /public', 'Sitemap: https://a.com/sitemap.xml'].join('\n'),
    'FreshPageBot/0.1'
  );
  assert.equal(rules.disallowAll, false);
  assert.deepEqual(rules.disallowPatterns, ['/admin', '/secret']);
  assert.deepEqual(rules.sitemaps, ['https://a.com/sitemap.xml']);
  assert.equal(isAllowed(rules, new URL('https://a.com/secret')), false);
  assert.equal(isAllowed(rules, new URL('https://a.com/ok')), true);
});

test('robots.txt Disallow: / 表示完全禁止', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /', 'FreshPageBot/0.1');
  assert.equal(rules.disallowAll, true);
  assert.equal(isAllowed(rules, new URL('https://a.com/anything')), false);
});

test('针对本站 UA 的规则优先生效', () => {
  const rules = parseRobots(
    ['User-agent: BadBot', 'Disallow: /', '', 'User-agent: FreshPageBot', 'Allow: /'].join('\n'),
    'FreshPageBot/0.1'
  );
  assert.equal(rules.disallowAll, false);
  assert.equal(isAllowed(rules, new URL('https://a.com/pricing')), true);
});

test('默认排除：文件、搜索、标签、登出、外链', () => {
  const base = new URL('https://a.com/');
  assert.equal(isExcludedUrl('https://a.com/logo.png', base), true);
  assert.equal(isExcludedUrl('https://a.com/app.js', base), true);
  assert.equal(isExcludedUrl('https://a.com/search?q=1', base), true);
  assert.equal(isExcludedUrl('https://a.com/tag/news', base), true);
  assert.equal(isExcludedUrl('https://a.com/logout', base), true);
  assert.equal(isExcludedUrl('https://a.com/page/3', base), true);
  assert.equal(isExcludedUrl('https://b.com/x', base), true);
  assert.equal(isExcludedUrl('https://a.com/pricing', base), false);
  assert.equal(isExcludedUrl('https://a.com/help/faq', base), false);
});

test('页面类型识别覆盖中英文', () => {
  assert.equal(classifyPageType(new URL('https://a.com/')), 'home');
  assert.equal(classifyPageType(new URL('https://a.com/pricing')), 'pricing');
  assert.equal(classifyPageType(new URL('https://a.com/plans')), 'pricing');
  assert.equal(classifyPageType(new URL('https://a.com/docs')), 'help');
  assert.equal(classifyPageType(new URL('https://a.com/退款政策')), 'policy');
  assert.equal(classifyPageType(new URL('https://a.com/关于我们')), 'about');
});

test('价格页优先级高于博客页', () => {
  const pricing = scoreUrl(new URL('https://a.com/pricing'), 'pricing', 1, 'link');
  const blog = scoreUrl(new URL('https://a.com/blog/a'), 'blog', 1, 'link');
  assert.ok(pricing > blog);
});
