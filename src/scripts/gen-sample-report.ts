/**
 * 生成示例报告（首页「查看示例报告」入口使用）。
 * 数据来源是 fixtures/demo-site 这个受控演示网站。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config';
import { initInMemory, getDb } from '../db/sqlite';
import * as repo from '../db/repository';
import { runScan } from '../scan/pipeline';
import { startFixtureServer } from '../fixtures/server';
import { buildScanPayload } from '../api/routes';

async function main(): Promise<void> {
  process.env.FP_ALLOW_PRIVATE_TARGETS = '1';
  initInMemory();
  getDb();

  const fixture = await startFixtureServer();
  const scan = repo.createScan({
    publicToken: 'sample',
    submittedUrl: 'https://demo.freshpage.example/',
    normalizedUrl: fixture.url,
    normalizedDomain: 'demo.freshpage.example',
    expiresAt: new Date(Date.now() + 86400000 * 365).toISOString(),
    abuseFingerprintHash: 'sample',
    clientIpHashes: 'sample',
  });

  await runScan(scan.id);
  const payload = buildScanPayload(repo.getScanById(scan.id)!);

  // 把结果里的本地地址替换为演示域名，避免出现 127.0.0.1
  const raw = JSON.stringify(payload).split(fixture.url.replace(/\/$/, '')).join('https://demo.freshpage.example');
  const parsed = JSON.parse(raw);
  parsed.scan.submittedUrl = 'https://demo.freshpage.example/';
  parsed.scan.normalizedUrl = 'https://demo.freshpage.example/';
  parsed.scan.domain = 'demo.freshpage.example';
  parsed.scan.token = 'sample';
  parsed.pages = (parsed.pages ?? []).map((p: Record<string, unknown>) => ({
    ...p,
    requestedUrl: String(p.requestedUrl ?? '').replace(fixture.url.replace(/\/$/, ''), 'https://demo.freshpage.example'),
  }));

  const outDir = path.join(config.root, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'sample-report.json'), JSON.stringify(parsed, null, 2));
  await fixture.close();

  const summary = parsed.summary as { critical: number; warning: number; info: number };
  console.log(
    `示例报告已生成：data/sample-report.json（页面 ${parsed.scan.scannedCount} 个，问题 ${parsed.findings.length} 条；严重 ${summary.critical} / 建议 ${summary.warning} / 信息 ${summary.info}）`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
