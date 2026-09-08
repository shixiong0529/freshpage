/**
 * 安全测试专用环境：关闭「允许私网」开关，模拟生产配置。
 * 必须在所有其他 import 之前被引入。
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.FP_ALLOW_PRIVATE_TARGETS = '0';
process.env.FP_API_ONLY = '1';
process.env.FP_AI_ENABLED = '0';
process.env.FP_BROWSER_FALLBACK = '0';
process.env.FP_CRAWL_DELAY_MS = '0';
process.env.FP_ALLOWED_PORTS = '80,443';
process.env.FP_IP_SALT = 'test-secure-salt';

export {};
