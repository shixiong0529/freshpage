# V0 验收清单

对照方案第 18 节，逐条给出实现方式与验证结果。

## 产品验收

| 标准 | 实现 | 验证 |
|---|---|---|
| 首页无需登录 | `public/index.html` | 手工 / 集成测试 |
| 只输入一个网址即可开始 | 单输入框 + 自动补全 `https://` | 单元测试 `url.test.ts` |
| 提交 2 秒内返回任务与结果链接 | 创建扫描只做校验与一次数据库写入，抓取异步进行 | 集成测试（202） |
| 50 页以内通常 10 分钟内完成 | 单页超时 12s、并发 3、总预算 8 分钟 | 演示站点约 10 秒内完成 |
| 扫描中可查看进度 | 4 阶段 + 已发现/已检查计数 + 事件流 | `GET /api/scans/:token` |
| 刷新后不会丢失任务 | 进度与结果全部落库，按 token 恢复 | 集成测试（重新 GET 同一 token） |
| 结果页直接展示问题，不要求注册 | 结果页由随机 token 访问 | 集成测试 |
| 每条问题包含页面和原文证据 | `evidence.side_a / side_b / sources` | 集成测试逐条断言 |
| 可以复制结果链接 | 前端「复制结果链接」 | 前端实现 |
| 可以立即删除结果 | `DELETE /api/scans/:token` | 集成测试（删除后 404） |
| 结果 7 天自动失效 | `expires_at` + 每小时清理任务 | 集成测试（`purgeExpired`） |

## 检测验收

| 标准 | 实现 | 验证 |
|---|---|---|
| 能发现固定测试网站的 404 和失效链接 | `page_unreachable` / `broken_internal_link` | 集成测试 |
| 能发现明显占位内容 | `placeholder_content`（模板变量判为严重） | 集成 + 单元测试 |
| 能生成价格和试用期冲突候选 | `conflict_price` / `conflict_trial_days` | 集成测试 |
| 能区分确定问题和疑似问题 | 结果分「优先处理 / 建议检查 / 信息」三组 | 前端分组 |
| 博客发布时间不会被直接当作过期问题 | 与 `article:published_time` 相同则跳过；博客默认不报过期日期 | 集成 + 单元测试 |
| 同一根因不会重复显示 | fingerprint 合并；失效目标合并为一条；内容相同页面只分析一次 | 集成测试 |
| AI 失败不影响确定性检查 | `applyAiReview` 安全降级 | 集成测试（AI 关闭时仍有报告） |
| 部分抓取失败不导致整个报告失败 | 状态 `partial`，仍展示已有结果 | 集成测试 |
| 可只重试失败页面且保留已有结果 | `POST /api/scans/:token/retry-failed` + `retryFailedPages()`，失败页数 2 → 1，已有结果全部保留 | 集成测试 + 端到端冒烟 |

## 安全验收

| 标准 | 验证 |
|---|---|
| 无法访问私网、localhost 和 metadata | `security.test.ts` 15 个地址全部 400 |
| 所有重定向都重新校验 | `fetcher.ts` 逐跳校验 + 单元测试 |
| 请求数量、页面数量和响应大小均有限制 | 400 请求 / 50 页 / 2 MB |
| 扫描任务有频率限制 | 集成测试（429） |
| 结果 ID 不可预测 | 160 bit `base64url`，集成测试断言不可枚举 |
| 过期数据能够清理 | `purgeExpired` + 定时清理任务 |
| 浏览器任务无法访问内部基础设施 | `context.route` 逐请求复用 SSRF 校验 |

## 自动化测试

```
npm test
```

- 单元测试 38 条：URL 标准化、SSRF / IP 解析、robots、页面发现、抽取、事实、规则、排序合并。
- 集成测试 24 条：完整扫描流程、误报控制、部分失败、完全失败、robots 禁止、重复提交、频率限制、
  反馈、删除、清理、失败页重试、SSRF 拦截。
- 合计 **62 条，全部通过**。

## 端到端冒烟

真实 HTTP 服务 + 真实抓取管道（非 apiOnly 模式）验证结果：

```
ok  /  /privacy.html  /styles.css  /app.js  /result/:token      全部 200
ok  /api/health -> {ok:true, retentionDays:7, maxPages:50}
ok  创建检查 -> 202，终态 partial（9 页 / 9 问题 / 2 失败页）
    严重度分布：critical 1，warning 8
ok  反馈接口 -> 200
ok  重试失败页 -> 200，恢复 1 个（失败页 2 → 1，已有结果 8 条全部保留）
ok  删除后结果立即失效 -> 404
```

另校验：前端 `app.js` 引用的 14 个 DOM id 均由自身模板或 `index.html` 提供，无悬空引用；
`node --check public/app.js` 通过。
