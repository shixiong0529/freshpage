# 遗留问题清单

> 最后更新：2026-09-08。以下均为**已确认存在但当前未处理**的问题，按影响程度排序。
> 与产品定位无关的设计取舍见 [`LIMITATIONS.md`](LIMITATIONS.md)，本文件只记录「应该做但还没做」的事项。

---

## 1. 前端埋点未实现（影响验证指标）

- **现状**：`docs/VALIDATION.md` 第 2 节规划的 `/api/telemetry` 接口与 8 个前端事件
  （`home_view`、`input_valid`、`scan_created`、`progress_view`、`finding_expand`、
  `copy_link`、`rescan_click`、`monitor_intent`）**均不存在**，`src/` 与 `public/` 中无相关代码。
- **影响**：方案 §19 的两项验证目标无法自动统计——
  「≥30% 用户展开证据」与「≥20% 用户分享或询问持续监控」只能靠人工访谈。
  其余三项指标（完成率、页面数、反馈计数）已由数据库落库，可用。
- **处理建议**：如进入第 4 周人工验证阶段再补；若不做，需在 VALIDATION.md 中把这两项改为人工统计口径。

## 2. 多 Worker 任务抢占非原子（仅多实例部署时会遇到）

- **现状**：`src/scan/queue.ts` 的 `startWorkerPolling()` 先用 `repo.getQueuedScans()` 读取，
  再 `repo.updateScan(row.id, { status: 'running' })` 标记。这是「读—改—写」而非条件更新，
  多 Worker 同时轮询时存在极小概率重复领取同一任务。
- **影响**：单实例部署**无影响**（进程内 `claimed` 集合已防重）。多实例时最坏情况是同一扫描被执行两次；
  `page_results` 上有 `UNIQUE(scan_id, normalized_url)` 约束，不会重复创建页面数据，但会浪费抓取配额。
- **处理建议**：把认领改成原子条件更新
  （`UPDATE scans SET status='running' WHERE id=? AND status='queued'`，按影响行数判断是否抢到）。约 5 行改动。

## 3. 重试失败页面时未做 429 退避

- **现状**：`429` 退避只在主抓取循环（`runScan`）中生效；
  `retryFailedPages()` 逐个重发请求时没有检测 429，会继续请求剩余失败页面。
- **影响**：站点正在限流时点「重试」，反而会继续加压。
- **处理建议**：把 `rateLimited` 判定抽成共用逻辑，在 `retryFailedPages()` 循环中同样中断。

## 4. 本机未安装 Playwright 浏览器

- **现状**：`playwright` 是可选依赖，浏览器二进制未下载（`~/.cache/ms-playwright` 为空）。
- **影响**：`FP_BROWSER_FALLBACK` 虽为 `true`，JS 渲染回退实际不会触发，
  纯前端渲染的站点（SPA）正文可能读不全。已验证降级路径不崩溃，仅功能缺失。
- **处理建议**：`npx playwright install chromium`（约 150 MB）后即自动启用。

---

## 已修复，不需再处理

| 问题 | 处理 |
|---|---|
| `docs/SSRF.md` 声称「429 立即退避」但代码未实现 | 已在 `src/scan/pipeline.ts` 实现（中断抓取 + 事件 + 域名限流计数 + 截断说明），并补集成测试 |
| `.env.example` 遗漏 16 个真实生效的环境变量 | 已补全 |
| `docs/VALIDATION.md` 未标注埋点未实现 | 已在第 2 节开头明确标注 |
| README / ACCEPTANCE 落后于实现 | 已同步到 63 个测试、8 个 API、22 项环境变量 |
