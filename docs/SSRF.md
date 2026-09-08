# SSRF 防护说明

公开 URL 输入是 FreshPage V0 最大的安全风险。以下是实现方式与保证。

## 1. 校验时机

| 阶段 | 校验 |
|---|---|
| 提交时 | URL 语法、协议白名单、端口白名单、主机名黑名单（`src/api/routes.ts` + `src/security/url.ts`） |
| 每次请求前 | 重新解析目标、重新执行 SSRF 校验（`src/crawl/fetcher.ts`） |
| 每次重定向后 | 对新地址重新执行完整校验，包括 DNS 解析（`src/crawl/fetcher.ts` 的 `safeFetch`） |
| 浏览器渲染时 | 每个子请求都经过 `context.route` 拦截并复用同一套校验（`src/crawl/browser.ts`） |

## 2. 具体措施

1. **协议白名单**：只允许 `http` / `https`。`ftp:`、`file:`、`javascript:`、`data:`、`mailto:` 在提交阶段即被拒绝
   （`detectScheme()` 专门区分「自带协议」与「裸域名:端口」）。
2. **端口限制**：默认只允许 80 / 443；`http://host:22/` 等直接拒绝（可用 `FP_ALLOWED_PORTS` 扩展）。
3. **主机名黑名单**：`localhost`、`*.local`、`*.internal`、`*.localdomain`、`*.home.arpa`、
   云厂商 metadata 主机名一律拒绝。
4. **IP 字面量解析**：不依赖字符串判断。`src/security/ip.ts` 支持：
   - 十进制 / 八进制 / 十六进制写法（`2130706433`、`0x7f000001`、`0177.0.0.1` 都被识别为 `127.0.0.1`）；
   - 1~4 段简写（`127.1`）；
   - IPv6 全解析，并对 `::ffff:`（IPv4-mapped）、`64:ff9b::/96`（NAT64）、`2002::/16`（6to4）、
     `2001:0::/32`（Teredo）解出内嵌 IPv4 后再次判断。
5. **DNS 解析后校验实际 IP**：`validateTarget()` 对域名做 `dns.lookup(all)`，只要任一解析结果落在
   私网 / 回环 / 链路本地 / 保留网段 / 组播范围，即拒绝（对应「DNS 指向私网」攻击）。
6. **DNS rebinding 防护**：解析通过后，把已校验的 IP 通过自定义 `lookup` 回调固定连接
   （`pinnedLookup`），连接阶段不再重新解析域名。
7. **重定向逐跳校验**：最多 5 跳，超出报 `TOO_MANY_REDIRECTS`；出现重复地址报 `REDIRECT_LOOP`；
   跳转到其他域名会在结果中提示。
8. **响应体限制**：单页 2 MB，超出即断开（`RESPONSE_TOO_LARGE`）；sitemap 限制 5 MB / 5000 条。
9. **请求量限制**：每次扫描最多 400 个请求、50 个页面、深度 2、最长 8 分钟；
   单站并发 3；全局每日页面预算 5000。
10. **不下载、不执行**：只接受 `text/html`、`application/xhtml+xml`、`text/xml` 等文本类型；
    不提交表单、不带 Cookie、不执行页面脚本（浏览器模式下也只读取 DOM）。
11. **遵守 robots.txt**：`Disallow` 命中即跳过；全站 `Disallow: /` 直接终止扫描并给出说明。
12. **遇到 429 立即退避**：抓取过程中任一页面返回 429，立刻中断后续请求（`src/scan/pipeline.ts`
    的 `rateLimited` 标志），已完成的页面结果照常保留，并在「本次检查限制」中说明原因；
    同时对该域名累加限流计数。首页本身返回 429 时直接判定整站不可用。

## 3. 未覆盖 / 需要部署层配合的部分

- Worker 与内部网络的隔离依赖部署方式（建议 Worker 单独部署，禁止访问内网网段与云 metadata）。
- 未做验证码 / 风险验证，V0 仅用 IP 哈希限流 + 域名冷却 + 全局预算；生产建议前置 WAF 或验证码。
- 浏览器模式下 Chromium 以 `--no-sandbox --no-proxy-server` 启动，仍建议运行在独立容器 / 网络命名空间中。

## 4. 测试覆盖

`tests/integration/security.test.ts` 在「关闭私网放行」的生产配置下验证以下地址全部返回 400：

`localhost`、`127.0.0.1`、`127.1`、`2130706433`、`0x7f000001`、`10.0.0.1`、`172.16.5.4`、
`192.168.1.1`、`169.254.169.254`、`100.64.0.1`、`[::1]`、`[fd00::1]`、`metadata.google.internal`、
`foo.internal`、`printer.local`，以及非标准端口 `example.com:22`。
