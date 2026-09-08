# 用户验证数据记录方式

V0 不登录，因此验证数据必须与匿名结果绑定，不采集个人身份信息。

## 1. 已落库的行为数据

| 数据 | 位置 | 用途 |
|---|---|---|
| 扫描创建数 / 完成数 / 失败数 | `scans`（`status`、`failure_code`） | 完成率漏斗 |
| 每日页面数与扫描数 | `daily_usage` | 成本与容量 |
| 每条结果的「有帮助 / 不是问题」计数 | `findings.helpful_count` / `not_helpful_count` | 误报率 |
| 逐条反馈事件（匿名投票者哈希） | `feedback_events` | 去重与按问题类型统计 |
| 扫描事件流 | `scan_events` | 排查卡点与阶段耗时 |

`feedback_events.voter_hash` 由浏览器 Cookie（`fp_voter`，HttpOnly，180 天）或 IP 哈希生成，
不保存原始 IP 文本。

## 2. 建议补充的前端埋点（第 4 周人工验证阶段）

> **现状：V0 尚未实现。** 下面列出的 `/api/telemetry` 接口与 8 个事件目前都不存在，
> 第 1 节中已落库的数据（完成率、页面数、反馈计数、事件流）才是当前真实可用的验证数据。
> 缺少前端埋点时，「展开证据率」「分享/持续监控意向」两项指标无法自动统计，只能靠人工访谈。

在 `public/app.js` 中增加以下事件（POST 到 `/api/telemetry`，与扫描 token 一起上报）：

1. `home_view`：打开首页；
2. `input_valid`：输入了合法网址；
3. `scan_created`：成功创建扫描；
4. `progress_view` / `progress_return`：等待中 / 离开后返回；
5. `finding_expand`：展开至少一条问题的证据；
6. `copy_link`：点击复制结果链接；
7. `rescan_click`：点击重新检查；
8. `monitor_intent`：结果页出现「希望持续监控」表达（人工访谈记录）。

## 3. 目标阈值（方案第 19 节）

- 有效扫描完成率 ≥ 70%：由 `scans.status` 统计；
- ≥ 50% 的完成报告包含用户认可的问题：由 `helpful_count` 与人工访谈统计；
- 高优先级问题中 ≥ 80% 被认为值得查看：`severity='critical'` 的 `not_helpful / (helpful + not_helpful)`；
- 每份报告无意义问题 ≤ 3 条：`not_helpful_count` 之和 + 人工标注；
- ≥ 30% 用户展开证据、≥ 20% 用户分享或询问持续监控：前端埋点。

## 4. 隐私约束

- 埋点不得包含网页正文、完整 URL 查询串、Cookie 原文或 IP 原文；
- 所有统计与 `public_token` 绑定，7 天后随扫描数据一起删除；
- 不接入第三方统计脚本时，以上数据仅落在本库。
