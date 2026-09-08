/** 极简结构化日志：绝不记录网页正文或用户敏感数据。 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'warn' : 'info')).toLowerCase();
  return LEVELS[(raw as Level) in LEVELS ? (raw as Level) : 'info'];
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta } : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
