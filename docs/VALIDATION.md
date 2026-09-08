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
| 匿名前端行为事件 | `telemetry_events` | 展开证据率、分享 / 持续监控意向（见第 2 节） |

`feedback_events.voter_hash` 由浏览器 Cookie（`fp_voter`，HttpOnly，180 天）或 IP 哈希生成，
不保存原始 IP 文本。

## 2. 前端埋点

> **已实现。** 前端通过 `POST /api/telemetry` 上报 9 个匿名事件，服务端按「会话 + 扫描 + 事件」去重，
> 数据落在 `telemetry_events` 表，随扫描一起在 7 天后删除。开关：`FP_TELEMETRY_ENABLED`（默认开）。

### 2.1 接口

`POST /api/telemetry`，请求体 `{ "event": "<事件名>", "token": "<结果 token，可选>" }`。

- 事件名必须在白名单内，否则返回 `400 INVALID_EVENT`；
- `token` 只用于把事件归到某次扫描，无效或已过期时按「未绑定扫描」记录；
- 会话标识复用结果反馈用的 `fp_voter` Cookie（HttpOnly，180 天）哈希，无 Cookie 时退化为 IP 哈希，**不保存原文**；
- 单会话每日上限 `FP_TELEMETRY_MAX_PER_SESSION_DAY`（默认 200）条，超出返回 `429`；
- 重复上报返回 `{ ok: true, duplicate: true }`，不会重复计数。

### 2.2 事件清单（`public/app.js`）

| 事件 | 触发时机 | 带 token |
|---|---|---|
| `home_view` | 渲染首页 | 否 |
| `input_valid` | 输入框内容像一个网址 | 否 |
| `scan_created` | 创建扫描成功 | 是 |
| `progress_view` | 进入进度页（含直接打开结果链接） | 是 |
| `progress_return` | 直接打开结果链接，或从后台切回该标签页 | 是 |
| `finding_expand` | 展开某条问题里的证据折叠块，或点击该条问题的证据页面链接 | 是 |
| `copy_link` | 点击复制结果链接（进度页或结果页） | 是 |
| `rescan_click` | 点击「重新检查」 | 是 |
| `monitor_intent` | 点击结果页底部「希望持续监控」 | 是 |

两处口径需要注意：

- **`finding_expand`**：结果页的主要证据是**默认展开**的，所以该事件统计的是「进一步查看证据」的动作
  （展开「查看出现该链接的 N 个页面」等折叠块，或点开证据所在页面），而非「从零展开证据」。
  解读「≥30% 用户展开证据」时按这个口径理解，必要时结合人工访谈。
- **`monitor_intent`**：结果页新增了一个「希望持续监控」按钮，只记录一次匿名点击，不收集联系方式；
  访谈中口头表达的意向仍需人工另记。

### 2.3 查看统计

```bash
npm run stats
```

输出扫描完成率、反馈分布，以及按会话去重的埋点漏斗与两项转化率。

### 2.4 示例报告不计入

`/example` 页面的所有交互都不上报，避免演示数据污染指标。

## 3. 目标阈值（方案第 19 节）

- 有效扫描完成率 ≥ 70%：由 `scans.status` 统计；
- ≥ 50% 的完成报告包含用户认可的问题：由 `helpful_count` 与人工访谈统计；
- 高优先级问题中 ≥ 80% 被认为值得查看：`severity='critical'` 的 `not_helpful / (helpful + not_helpful)`；
- 每份报告无意义问题 ≤ 3 条：`not_helpful_count` 之和 + 人工标注；
- ≥ 30% 用户展开证据、≥ 20% 用户分享或询问持续监控：前端埋点（`finding_expand`；`copy_link` + `monitor_intent`），
  用 `npm run stats` 查看，口径见第 2.2 节。

## 4. 隐私约束

- 埋点只包含事件名、结果 token 与会话哈希：不含网页正文、网址、URL 查询串、Cookie 原文或 IP 原文；
- 所有统计与 `public_token` 绑定，7 天后随扫描数据一起删除；
- 不接入第三方统计脚本时，以上数据仅落在本库。
