/**
 * 任务队列。
 *
 * 同一进程内：Web 与 Worker 一起运行时直接消费内存队列；
 * 独立 Worker 进程（FP_API_ONLY=1 / FP_WORKER_ONLY=1）通过轮询数据库领取任务。
 * 两种模式下「同一扫描重复执行不会重复创建页面」，由数据库唯一约束保证。
 */
import { config } from '../config';
import * as repo from '../db/repository';
import { runScan } from './pipeline';
import { logger } from '../util/logger';

class ScanQueue {
  private pending: number[] = [];
  /** 本进程已认领的任务，防止同一进程内内存队列与数据库轮询重复执行 */
  private claimed = new Set<number>();
  private active = 0;
  private draining = false;

  enqueue(scanId: number): void {
    this.claimed.add(scanId);
    if (this.pending.includes(scanId)) return;
    this.pending.push(scanId);
    void this.drain();
  }

  isClaimed(scanId: number): boolean {
    return this.claimed.has(scanId);
  }

  get size(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.active;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0 && this.active < config.abuse.globalConcurrentScans) {
        const id = this.pending.shift();
        if (id === undefined) break;
        this.active++;
        void runScan(id)
          .catch((e) => logger.error('scan rejected', { scanId: id, message: (e as Error).message }))
          .finally(() => {
            this.active--;
            if (this.pending.length > 0) void this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }
}

export const scanQueue = new ScanQueue();

/** 独立 Worker 进程：轮询数据库领取 queued 任务。 */
export function startWorkerPolling(intervalMs = 2000): NodeJS.Timeout {
  const timer = setInterval(async () => {
    if (scanQueue.activeCount >= config.abuse.globalConcurrentScans) return;
    const rows = repo.getQueuedScans(config.abuse.globalConcurrentScans - scanQueue.activeCount);
    for (const row of rows) {
      if (scanQueue.isClaimed(row.id)) continue;
      // 原子认领：条件更新（queued -> running），没抢到说明已被其它 Worker 领走
      if (!repo.claimQueuedScan(row.id)) continue;
      scanQueue.enqueue(row.id);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** 进程重启后，把卡在 running 状态的任务标记为失败，避免永久停留在「扫描中」。 */
export function recoverStaleScans(staleMinutes = 30): number {
  try {
    return repo.markStaleRunningFailed(staleMinutes);
  } catch (e) {
    logger.error('stale scan recovery failed', { message: (e as Error).message });
    return 0;
  }
}

export function startCleanupJob(intervalMs = config.cleanupIntervalMs): NodeJS.Timeout {
  const run = (): void => {
    try {
      const removed = repo.purgeExpired(config.retentionDays);
      if (removed > 0) logger.info('retention purge', { removed });
      const stale = repo.markStaleRunningFailed(30);
      if (stale > 0) logger.info('stale scans recovered', { stale });
      repo.pruneAbuseCounters();
    } catch (e) {
      logger.error('cleanup failed', { message: (e as Error).message });
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
