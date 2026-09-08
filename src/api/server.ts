import * as http from 'node:http';
import { config } from '../config';
import { createApp } from './routes';
import { recoverStaleScans, startCleanupJob, startWorkerPolling } from '../scan/queue';
import { getDb } from '../db/sqlite';
import { logger } from '../util/logger';

export function startServer(port = config.port): http.Server {
  getDb();
  const app = createApp();
  const server = http.createServer(app);
  server.listen(port, () => {
    logger.info('freshpage web listening', { port, mode: config.workerOnly ? 'worker' : 'web+worker' });
  });
  startCleanupJob();
  recoverStaleScans();
  if (!config.apiOnly) startWorkerPolling();
  return server;
}
