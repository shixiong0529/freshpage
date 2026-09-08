/** 测试环境初始化：必须在所有其他 import 之前被引入。 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.FP_ALLOW_PRIVATE_TARGETS = '1';
process.env.FP_AI_ENABLED = '0';
process.env.FP_BROWSER_FALLBACK = process.env.FP_BROWSER_FALLBACK ?? '0';
process.env.FP_CRAWL_DELAY_MS = '0';
process.env.FP_RETENTION_DAYS = process.env.FP_RETENTION_DAYS ?? '7';
process.env.FP_MAX_SCANS_PER_IP = process.env.FP_MAX_SCANS_PER_IP ?? '1000';
process.env.FP_MAX_SCANS_PER_IP_DAY = process.env.FP_MAX_SCANS_PER_IP_DAY ?? '1000';
process.env.FP_DAILY_PAGE_BUDGET = process.env.FP_DAILY_PAGE_BUDGET ?? '100000';
process.env.FP_IP_SALT = 'test-salt';
process.env.FP_API_ONLY = '1'; // 测试中手动驱动 runScan，保证确定性
process.env.FP_MAX_SCANS_PER_IP = process.env.FP_MAX_SCANS_PER_IP ?? '10';
process.env.FP_MAX_SCANS_PER_IP_DAY = process.env.FP_MAX_SCANS_PER_IP_DAY ?? '40';

export {};
