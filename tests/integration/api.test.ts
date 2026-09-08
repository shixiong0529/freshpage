import './../setup';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { initInMemory } from '../../src/db/sqlite';
import * as repo from '../../src/db/repository';
import { createApp } from '../../src/api/routes';
import { runScan, retryFailedPages } from '../../src/scan/pipeline';
import { startFixtureServer, type FixtureServer } from '../../src/fixtures/server';
import { config } from '../../src/config';

let fixture: FixtureServer;
let server: http.Server;
let base = '';

before(async () => {
  initInMemory();
  fixture = await startFixtureServer();
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.close();
});

async function createScan(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ url }),
  });
  return { status: res.status, body: await res.json() };
}

async function createAndRun(url: string): Promise<any> {
  const created = await createScan(url);
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const scan = repo.getScanByToken(created.body.token)!;
  await runScan(scan.id);
  const res = await fetch(`${base}/api/scans/${created.body.token}`);
  return { payload: await res.json(), token: created.body.token, scanId: scan.id };
}

test('健康检查返回运行参数', async () => {
  const res = await fetch(`${base}/api/health`);
  const body = (await res.json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.maxPages, config.maxPages);
  assert.equal(body.retentionDays, 7);
});

test('提交非法地址会被拒绝', async () => {
  for (const bad of ['', 'ftp://example.com', 'javascript:alert(1)', 'mailto:a@b.com', '   ']) {
    const res = await createScan(bad);
    assert.equal(res.status, 400, `${bad} 应被拒绝`);
  }
});

test('提交 localhost 会被拒绝', async () => {
  const res = await createScan('http://localhost/');
  assert.equal(res.status, 400);
  // 详细的私网 / metadata 拦截见 security.test.ts（生产配置下运行）
});

test('结果 ID 不可预测且不可枚举', async () => {
  const { token } = await createAndRun(fixture.url);
  assert.ok(token.length >= 20, 'token 长度不足');
  assert.ok(!/^\d+$/.test(token), 'token 不能是数字');
  const missing = await fetch(`${base}/api/scans/${'a'.repeat(24)}`);
  assert.equal(missing.status, 404);
  const sequential = await fetch(`${base}/api/scans/1`);
  assert.equal(sequential.status, 404);
});

test('完整扫描：固定测试网站的关键问题都能被发现', async () => {
  const { payload } = await createAndRun(fixture.url);
  const scan = payload.scan;
  const types = (payload.findings as any[]).map((f) => f.type);

  assert.ok(['complete', 'partial'].includes(scan.status), `扫描状态异常: ${scan.status}`);
  assert.ok(scan.scannedCount >= 8, `抓取页面过少: ${scan.scannedCount}`);
  assert.ok(scan.scannedCount <= config.maxPages, '超过 25 页上限');

  // 失效站内链接 / 无法访问页面
  assert.ok(
    types.some((t) => t === 'page_unreachable' || t === 'broken_internal_link'),
    '应发现失效页面或失效链接'
  );
  // 过期活动日期
  assert.ok(types.includes('expired_date'), '应发现已过期的活动日期');
  // 未替换模板变量
  assert.ok(types.includes('placeholder_content'), '应发现未替换的模板变量');
  // 价格冲突（pricing 299 vs help 399）
  assert.ok(types.includes('conflict_price'), '应发现价格冲突');
  // 试用期冲突（14 天 vs 30 天）
  assert.ok(types.includes('conflict_trial_days'), '应发现试用期冲突');
  // 联系信息不一致
  assert.ok(
    types.some((t) => t.startsWith('contact_') || t === 'mailto_mismatch'),
    '应发现联系信息候选'
  );

  // 每条问题都必须带原文证据
  for (const f of payload.findings as any[]) {
    assert.ok(f.evidence && (f.evidence.side_a || f.evidence.sources), `${f.type} 缺少证据`);
    assert.ok(f.recommendation, `${f.type} 缺少建议操作`);
  }

  // 冲突类问题必须并排展示双方原文
  const conflict = (payload.findings as any[]).find((f) => f.type.startsWith('conflict_'));
  assert.ok(conflict.evidence.side_a && conflict.evidence.side_b, '冲突问题必须展示双方原文');
});

test('robots.txt 禁止的页面不会被扫描', async () => {
  const { payload } = await createAndRun(fixture.url);
  const urls = (payload.pages as any[]).map((p) => String(p.url));
  assert.ok(!urls.some((u) => u.includes('secret.html')), 'robots 禁止页面不应被抓取');
});

test('博客发布日期不会被当作过期内容', async () => {
  const { payload } = await createAndRun(fixture.url);
  const expired = (payload.findings as any[]).filter((f) => f.type === 'expired_date');
  for (const f of expired) {
    for (const p of f.pages as any[]) {
      assert.ok(!String(p.url).includes('blog'), `博客不应被判为过期: ${p.url}`);
    }
  }
});

test('同一个失效目标只产生一条结果', async () => {
  const { payload } = await createAndRun(fixture.url);
  const linkFindings = (payload.findings as any[]).filter((f) => f.type === 'broken_internal_link');
  const targets = linkFindings.map((f) => f.evidence.side_a.quote);
  assert.equal(new Set(targets).size, targets.length, '失效目标重复出现');
});

test('部分页面失败不会导致整份报告失败', async () => {
  const partial = await startFixtureServer({ '/features.html': { status: 500, body: '<h1>error</h1>' } });
  const res = await createScan(partial.url);
  const scan = repo.getScanByToken(res.body.token)!;
  await runScan(scan.id);
  const payload: any = await (await fetch(`${base}/api/scans/${res.body.token}`)).json();
  assert.ok(['complete', 'partial'].includes(payload.scan.status));
  assert.ok(payload.findings.length > 0, '部分失败仍应展示已有结果');
  assert.ok(payload.scan.failedCount >= 1);
  await partial.close();
});

test('网站完全无法访问时给出可理解原因', async () => {
  const down = await startFixtureServer({ '/': { status: 503, body: 'down' } });
  const res = await createScan(down.url);
  const scan = repo.getScanByToken(res.body.token)!;
  await runScan(scan.id);
  const payload: any = await (await fetch(`${base}/api/scans/${res.body.token}`)).json();
  assert.equal(payload.scan.status, 'failed');
  assert.ok(payload.scan.failureReason, '需要给出失败原因');
  assert.ok(payload.scan.failureHint, '需要给出用户能理解的说明');
  await down.close();
});

test('robots.txt 全站禁止时明确说明', async () => {
  const blocked = await startFixtureServer({
    '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
  });
  const res = await createScan(blocked.url);
  const scan = repo.getScanByToken(res.body.token)!;
  await runScan(scan.id);
  const payload: any = await (await fetch(`${base}/api/scans/${res.body.token}`)).json();
  assert.equal(payload.scan.status, 'failed');
  assert.equal(payload.scan.failureCode, 'ROBOTS_DISALLOWED');
  await blocked.close();
});

test('同一域名重复提交不会创建多个任务', async () => {
  const unique = await startFixtureServer();
  const first = await createScan(unique.url);
  assert.equal(first.status, 202);
  const second = await createScan(unique.url);
  assert.equal(second.status, 200);
  assert.equal(second.body.reused, true);
  assert.equal(second.body.token, first.body.token);
  // 清理，避免影响后续测试（同主机共享域名）
  await fetch(`${base}/api/scans/${first.body.token}`, { method: 'DELETE' });
  await unique.close();
});

test('频率限制生效（后台强制，不依赖前端）', async () => {
  const ip = '198.51.100.7';
  let limited = false;
  for (let i = 0; i < config.abuse.maxScansPerIpPerWindow + 3; i++) {
    const res = await createScan(`https://rate-limit-test-${i}.example.com`, { 'X-Forwarded-For': ip });
    if (res.status === 429) {
      limited = true;
      assert.equal(res.body.error, 'RATE_LIMITED');
      break;
    }
  }
  assert.equal(limited, true, '超过配额后应返回 429');
});

test('反馈会被记录，重复投票不重复计数', async () => {
  const { payload, token } = await createAndRun(fixture.url);
  const finding = (payload.findings as any[])[0];
  assert.ok(finding, '需要至少一条结果');

  const first = await fetch(`${base}/api/findings/${finding.id}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote: 'helpful', token }),
  });
  const firstBody: any = await first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.helpful_count, 1);

  const second = await fetch(`${base}/api/findings/${finding.id}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote: 'helpful', token }),
  });
  const secondBody: any = await second.json();
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.helpful_count, 1, '重复投票不应重复计数');

  const notHelpful = await fetch(`${base}/api/findings/${finding.id}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote: 'not_helpful', token, 'x-voter': 'other' }),
  });
  const nhBody: any = await notHelpful.json();
  assert.equal(nhBody.duplicate, true, '同一投票者改票后仍只记一次');
});

test('反馈接口校验 token，不能给别人的结果投票', async () => {
  const { payload } = await createAndRun(fixture.url);
  const finding = (payload.findings as any[])[0];
  const res = await fetch(`${base}/api/findings/${finding.id}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote: 'helpful', token: 'wrong-token' }),
  });
  assert.equal(res.status, 403);
});

test('删除结果后链接立即失效', async () => {
  const { token } = await createAndRun(fixture.url);
  const del = await fetch(`${base}/api/scans/${token}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await fetch(`${base}/api/scans/${token}`);
  assert.equal(after.status, 404);
});

test('可以只重试失败的页面，并保留已有结果', async () => {
  const broken = await startFixtureServer({ '/help.html': { status: 500, body: '<h1>err</h1>' } });
  const res = await createScan(broken.url);
  const scan = repo.getScanByToken(res.body.token)!;
  await runScan(scan.id);
  const before: any = await (await fetch(`${base}/api/scans/${res.body.token}`)).json();
  assert.ok(before.scan.failedCount >= 1);

  // 修好页面后重试
  broken.setBehavior({});
  const retry = await fetch(`${base}/api/scans/${res.body.token}/retry-failed`, { method: 'POST' });
  let recovered = 0;
  if (config.apiOnly) {
    // 测试环境为 apiOnly：接口只入队（202），由测试手动驱动，保证确定性
    assert.equal(retry.status, 202);
    const retryBody: any = await retry.json();
    assert.ok(retryBody.queued >= 1, '应有失败页面被入队');
    recovered = await retryFailedPages(scan.id);
  } else {
    assert.equal(retry.status, 200);
    const retryBody: any = await retry.json();
    recovered = Number(retryBody.recovered) || 0;
  }
  assert.ok(recovered >= 1, '至少应恢复一个页面');

  const after: any = await (await fetch(`${base}/api/scans/${res.body.token}`)).json();
  assert.ok(after.scan.failedCount < before.scan.failedCount, '失败页面数应减少');
  assert.ok(after.findings.length > 0, '已有结果必须保留');
  await broken.close();
});

test('目标站点返回 429 时立即停止抓取，已完成部分仍可用', async () => {
  const limited = await startFixtureServer({
    '/pricing.html': { status: 429, body: 'too many requests' },
    '/features.html': { status: 429, body: 'too many requests' },
    '/help.html': { status: 429, body: 'too many requests' },
    '/contact.html': { status: 429, body: 'too many requests' },
  });
  const res = await createScan(limited.url);
  const scan = repo.getScanByToken(res.body.token)!;
  await runScan(scan.id);
  const payload: any = await (await fetch(`${base}/api/scans/${res.body.token}`)).json();
  assert.ok(payload.scan.truncationNote, '应给出截断说明');
  assert.ok(
    String(payload.scan.truncationNote).includes('429'),
    `截断说明应提到 429，实际：${payload.scan.truncationNote}`
  );
  // 首页之后第一个命中 429 的页面即中断；此处不写死具体页数，只断言远小于全站规模
  assert.ok(payload.scan.scannedCount < 5, `429 后不应继续抓取，实际检查 ${payload.scan.scannedCount} 页`);
  await limited.close();
});

test('取消检查', async () => {
  const res = await createScan(fixture.url);
  const cancelled = await fetch(`${base}/api/scans/${res.body.token}/cancel`, { method: 'POST' });
  assert.equal(cancelled.status, 200);
  const payload: any = await (await fetch(`${base}/api/scans/${res.body.token}`)).json();
  assert.equal(payload.scan.status, 'cancelled');
});

test('过期数据可被清理', async () => {
  const { token } = await createAndRun(fixture.url);
  const scan = repo.getScanByToken(token)!;
  assert.ok(scan);
  const removed = repo.purgeExpired(0);
  assert.ok(removed > 0, '应有过期数据被清理');
  const after = await fetch(`${base}/api/scans/${token}`);
  assert.equal(after.status, 404);
});

test('示例报告接口可用', async () => {
  const res = await fetch(`${base}/api/example`);
  if (res.status === 404) return; // 未生成示例报告时跳过
  const body: any = await res.json();
  assert.ok(body.scan && Array.isArray(body.findings));
});
