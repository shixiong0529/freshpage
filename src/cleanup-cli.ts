/** 手动执行数据清理：node dist/cleanup-cli.js */
import { config } from './config';
import { purgeExpired } from './db/repository';
import { getDb } from './db/sqlite';

function main(): void {
  getDb();
  const removed = purgeExpired(config.retentionDays);
  console.log(`purged ${removed} expired scans (retention ${config.retentionDays} days)`);
}

main();
