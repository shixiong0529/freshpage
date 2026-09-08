/**
 * 浏览器渲染回退（可选）。
 * 仅在页面正文极少、疑似依赖 JavaScript 渲染时使用。
 * Playwright 未安装或启动失败时静默降级，绝不影响主流程。
 */
import { config } from '../config';
import { logger } from '../util/logger';

let availability: 'unknown' | 'available' | 'unavailable' = 'unknown';

async function loadPlaywright(): Promise<any | null> {
  if (availability === 'unavailable') return null;
  try {
    const mod = await import('playwright');
    availability = 'available';
    return mod;
  } catch {
    availability = 'unavailable';
    logger.info('playwright unavailable, browser fallback disabled');
    return null;
  }
}

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-proxy-server'];

/**
 * 启动 Chromium。
 * 新版 Playwright 默认用 chrome-headless-shell 启动，只执行过
 * `playwright install chromium` 的机器上没有这个二进制，因此失败后再用完整
 * Chromium（channel: 'chromium'）重试一次；两者都没有时交给调用方降级。
 */
async function launchChromium(pw: any): Promise<any> {
  try {
    return await pw.chromium.launch({ args: LAUNCH_ARGS });
  } catch (err) {
    logger.debug('headless shell launch failed, retrying with full chromium', {
      message: (err as Error).message,
    });
    return pw.chromium.launch({ channel: 'chromium', args: LAUNCH_ARGS });
  }
}

export async function renderPage(url: string): Promise<{ html: string; finalUrl: string } | null> {
  if (!config.browserFallback.enabled) return null;
  const pw = await loadPlaywright();
  if (!pw) return null;

  let browser: any = null;
  try {
    browser = await launchChromium(pw);
    const context = await browser.newContext({
      userAgent: config.userAgent,
      javaScriptEnabled: true,
      bypassCSP: false,
    });
    // 浏览器不得访问内部网络：拦截所有请求并复用 SSRF 校验
    const { validateTarget } = await import('../security/ssrf');
    const { isPortAllowed } = await import('../security/url');
    await context.route('**/*', async (route: any) => {
      const request = route.request();
      try {
        const u = new URL(request.url());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort();
        if (!isPortAllowed(u)) return route.abort();
        const check = await validateTarget(u.hostname.replace(/^\[|\]$/g, ''), u.port);
        if (!check.ok) return route.abort();
        return route.continue();
      } catch {
        return route.abort();
      }
    });

    const page = await context.newPage();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.browserFallback.timeoutMs,
    });
    await page.waitForTimeout(600);
    const html = await page.content();
    const finalUrl = page.url();
    void response;
    await browser.close();
    return { html, finalUrl };
  } catch (err) {
    logger.debug('browser render failed', { url, message: (err as Error).message });
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}
