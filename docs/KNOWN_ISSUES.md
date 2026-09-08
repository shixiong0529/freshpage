# 遗留问题清单

> 最后更新：2026-09-08。本文件只记录「应该做但还没做」的事项；
> 与产品定位无关的设计取舍见 [`LIMITATIONS.md`](LIMITATIONS.md)。
>
> **本轮（2026-09-08 第二次）已把清单里的 4 项全部处理完，当前无未处理项。**
> 下面先列仍需注意的口径与前提，再列本轮处理明细。

---

## 仍需注意（不是缺陷，但会影响解读）

- **`finding_expand` 的口径与方案原文不同。** 结果页的主要证据是默认展开的，
  所以该事件统计的是「进一步查看证据」（展开折叠块或点开证据所在页面），
  而不是「从零展开证据」。解读「≥30% 用户展开证据」时按此口径，必要时结合人工访谈。
  详见 [`VALIDATION.md`](VALIDATION.md) 第 2.2 节。
- **`monitor_intent` 只统计结果页按钮点击。** 访谈中口头表达的持续监控意向仍需人工另记。
- **埋点会话标识在无 Cookie 时退化为 IP 哈希。** 同一 NAT 出口的多个用户可能被算作同一会话，
  小样本验证阶段可接受，规模化统计前需换成更可靠的匿名标识。
- **浏览器回退依赖本机已下载的 Chromium。** 换机器或换 CI 环境需重新执行
  `npx playwright install chromium`；未下载时仍会静默降级（不崩溃，只是抓不到 SPA 正文）。

---

## 本轮处理明细

### 1. 前端埋点已实现（原第 1 条）

- 新增 `POST /api/telemetry`：白名单 9 个事件名，非白名单一律 `400`；
  只落库「事件名 + 扫描 id + 会话哈希」，不接受网址与正文；单会话每日 200 条上限。
- 新增 `telemetry_events` 表，`(event_type, session_hash, IFNULL(scan_id,0))` 唯一索引做去重；
  随扫描一起清理，未绑定扫描的事件按同样的保留期清理。
- `public/app.js` 上报 9 个事件（`home_view`、`input_valid`、`scan_created`、`progress_view`、
  `progress_return`、`finding_expand`、`copy_link`、`rescan_click`、`monitor_intent`），
  用 `sendBeacon`（不可用时 `fetch keepalive`）发送，失败静默忽略，示例报告页不上报。
- 结果页新增「希望持续监控」按钮，使方案 §19 的「≥20% 询问持续监控」可自动统计。
- 新增 `npm run stats` 打印完成率、反馈分布与按会话去重的埋点漏斗。
- 开关 `FP_TELEMETRY_ENABLED`（默认开）；隐私说明页已同步。

### 2. 多 Worker 任务抢占已改为原子认领（原第 2 条）

`repo.claimQueuedScan(id)` 用 `UPDATE scans SET status='running' WHERE id=? AND status='queued'`
并按影响行数判断是否抢到；`startWorkerPolling()` 抢不到就跳过。集成测试断言同一任务只能被认领一次。

### 3. 重试失败页面已做 429 退避（原第 3 条）

`isRateLimited()` 抽为主抓取与重试共用的判定。`retryFailedPages()` 命中 429 时立即停止，
当前页与**所有未重试的剩余页面**保持失败状态，写入 `rate_limited` 事件与截断说明。
集成测试构造「第一个失败页返回 429、其余页面已修好」的场景，断言 `recovered === 0`。

### 4. 本机已安装 Playwright Chromium（原第 4 条）

已执行 `npx playwright install chromium`（macOS 的实际缓存目录是 `~/Library/Caches/ms-playwright`，
原清单里写的 `~/.cache/ms-playwright` 只适用于 Linux，所以当时判断为「未安装」）。

安装后又发现一个真实问题：Playwright 1.63 的 `chromium.launch()` **默认启动 chrome-headless-shell**，
而 `playwright install chromium` 装的是完整 Chromium，于是回退依然失败。
`src/crawl/browser.ts` 已改为失败后用 `channel: 'chromium'` 重试完整 Chromium，
两者都没有时仍按原逻辑静默降级。

实测（纯 JS 渲染的页面）：静态解析正文 0 字 → 渲染后 213 字，标题与 h1 均正确抽出。
`.env.example` 的 `FP_BROWSER_FALLBACK` 已从 0 改为 1。

---

## 更早一轮已修复

| 问题 | 处理 |
|---|---|
| `docs/SSRF.md` 声称「429 立即退避」但代码未实现 | 已在 `src/scan/pipeline.ts` 实现（中断抓取 + 事件 + 域名限流计数 + 截断说明），并补集成测试 |
| `.env.example` 遗漏 16 个真实生效的环境变量 | 已补全 |
| `docs/VALIDATION.md` 未标注埋点未实现 | 埋点本轮已实现，该标注已删除 |
| README / ACCEPTANCE 落后于实现 | 已同步到 68 个测试、9 个 API、24 项环境变量 |
