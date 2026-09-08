import { config } from './config';
import { startServer } from './api/server';
import { startCleanupJob, startWorkerPolling } from './scan/queue';
import { getDb } from './db/sqlite';
import { logger } from './util/logger';

function main(): void {
  getDb();
  if (config.workerOnly) {
    logger.info('freshpage worker started (worker only)');
    startWorkerPolling();
    startCleanupJob();
    return;
  }
  startServer();
}

process.on('SIGTERM', () => {
  logger.info('shutting down');
  process.exit(0);
});

main();
