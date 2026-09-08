import './../setup-secure';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { initInMemory } from '../../src/db/sqlite';
import { createApp } from '../../src/api/routes';
import { validateTarget } from '../../src/security/ssrf';
import { config } from '../../src/config';

let server: http.Server;
let base = '';

before(async () => {
  initInMemory();
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return { status: res.status, body: await res.json() };
}

test('SSRF：禁止回环 / 私网 / metadata / 保留地址', async () => {
  const blocked = [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://10.0.0.1/',
    'http://172.16.5.4/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://metadata.google.internal/',
    'http://foo.internal/',
    'http://printer.local/',
  ];
  for (const url of blocked) {
    const res = await post(url);
    assert.equal(res.status, 400, `${url} 应被拒绝`);
    assert.equal(res.body.error, 'BLOCKED_ADDRESS', `${url} 应返回 BLOCKED_ADDRESS`);
  }
});

test('SSRF：非标准端口被拒绝', async () => {
  const res = await post('http://example.com:22/');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'BLOCKED_PORT');
});

test('validateTarget 拒绝解析到私网的域名', async () => {
  const r = await validateTarget('localhost', '80');
  assert.equal(r.ok, false);
  assert.equal(config.allowPrivateTargets, false, '安全测试必须禁用私网放行');
});

test('公网地址通过校验（example.com 解析结果非私网）', async () => {
  const r = await validateTarget('example.com', '80');
  // 在离线环境下允许 DNS 失败，但不能返回「私网」判定
  if (!r.ok) assert.ok(['dns_failure'].includes(r.reason ?? ''), `意外拒绝: ${r.reason}`);
  else assert.ok(r.pinnedIp);
});
