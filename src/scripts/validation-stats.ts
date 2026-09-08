/**
 * 验证指标汇总：node dist/src/scripts/validation-stats.js
 *
 * 输出 docs/VALIDATION.md 第 3 节的可自动统计项：扫描完成率、反馈情况、前端埋点漏斗。
 * 只读取聚合结果，不打印任何网址或页面正文。
 */
import { config } from '../config';
import { getDb } from '../db/sqlite';
import { telemetryFunnel, telemetrySessionsForAny } from '../db/repository';

function pct(part: number, total: number): string {
  if (total <= 0) return '-';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function main(): void {
  const db = getDb();

  const statuses = db
    .prepare('SELECT status, COUNT(*) AS n FROM scans WHERE deleted_at IS NULL GROUP BY status')
    .all() as unknown as Array<{ status: string; n: number }>;
  const total = statuses.reduce((sum, r) => sum + Number(r.n), 0);
  const done = statuses
    .filter((r) => r.status === 'complete' || r.status === 'partial')
    .reduce((sum, r) => sum + Number(r.n), 0);

  console.log(`# 扫描（保留期 ${config.retentionDays} 天内）`);
  for (const r of statuses) console.log(`  ${r.status.padEnd(10)} ${r.n}`);
  console.log(`  合计 ${total}，完成（complete+partial）${done}，完成率 ${pct(done, total)}（目标 ≥ 70%）`);

  const fb = db
    .prepare(
      `SELECT COALESCE(SUM(helpful_count), 0) AS helpful,
              COALESCE(SUM(not_helpful_count), 0) AS not_helpful
       FROM findings`
    )
    .get() as unknown as { helpful: number; not_helpful: number };
  const crit = db
    .prepare(
      `SELECT COALESCE(SUM(helpful_count), 0) AS helpful,
              COALESCE(SUM(not_helpful_count), 0) AS not_helpful
       FROM findings WHERE severity = 'critical'`
    )
    .get() as unknown as { helpful: number; not_helpful: number };

  console.log('\n# 结果反馈');
  console.log(`  有帮助 ${fb.helpful} / 不是问题 ${fb.not_helpful}`);
  console.log(
    `  高优先级问题被认为值得查看：${pct(Number(crit.helpful), Number(crit.helpful) + Number(crit.not_helpful))}（目标 ≥ 80%）`
  );

  const funnel = telemetryFunnel();
  console.log('\n# 前端埋点（按会话去重）');
  if (funnel.length === 0) {
    console.log('  暂无埋点数据' + (config.telemetry.enabled ? '' : '（FP_TELEMETRY_ENABLED=0，埋点已关闭）'));
    return;
  }
  const by = new Map(funnel.map((r) => [r.event_type, Number(r.sessions)]));
  for (const r of funnel) console.log(`  ${r.event_type.padEnd(16)} 会话 ${r.sessions}\t事件 ${r.events}`);

  // 分母为「看过进度或结果的会话」，分子按会话去重（同一会话做两件事只算一次）
  const viewers = by.get('progress_view') ?? 0;
  const shared = telemetrySessionsForAny(['copy_link', 'monitor_intent']);
  console.log(
    `\n  展开证据率 ${pct(by.get('finding_expand') ?? 0, viewers)}（目标 ≥ 30%）` +
      `\n  分享或询问持续监控 ${pct(shared, viewers)}（目标 ≥ 20%）`
  );
}

main();
