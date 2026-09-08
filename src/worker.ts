/** 独立 Worker 进程入口：node dist/worker.js */
process.env.FP_WORKER_ONLY = '1';
import './index';
