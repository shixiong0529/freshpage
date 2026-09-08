/**
 * 固定测试网站服务（方案第 16 节）。
 * 仅用于本地测试与演示，监听 127.0.0.1。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRoot } from '../util/misc';

const ROOT = path.join(projectRoot(), 'fixtures', 'demo-site');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
  port: number;
  /** 运行时替换异常行为，用于测试「修复后重试」 */
  setBehavior: (behavior: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>) => void;
}

/** 启动演示站点。behavior 可覆盖特定路径的响应，用于测试异常场景。 */
export function startFixtureServer(
  initialBehavior: Record<string, { status?: number; body?: string; headers?: Record<string, string> }> = {}
): Promise<FixtureServer> {
  let behavior: Record<string, { status?: number; body?: string; headers?: Record<string, string> }> = {
    ...initialBehavior,
  };
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (behavior[urlPath]) {
      const b = behavior[urlPath];
      res.writeHead(b.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8', ...(b.headers ?? {}) });
      res.end(b.body ?? '');
      return;
    }

    // 故意失效的站内链接目标
    if (urlPath === '/old-page.html' || urlPath === '/missing-doc.html') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>页面不存在</p>');
      return;
    }

    const resolved = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(ROOT, path.normalize(resolved).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1>');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        port: addr.port,
        setBehavior: (next) => {
          behavior = { ...next };
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
