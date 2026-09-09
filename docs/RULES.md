# 检查规则清单与取舍记录

> 当前生效：**12 类 findingType**。最后审核：2026-09-09。
> 规则代码在 `src/rules/`，占位模式表在 `src/extract/html.ts`。
> 严重度含义：`critical` 优先处理 · `warning` 建议检查 · `info` 信息。

## 1. 当前会报的问题

| findingType | 触发条件 | 严重度 | 置信度 / 方法 |
|---|---|---|---|
| `page_unreachable` | 4xx / 5xx、超时、DNS 失败、重定向循环或过多、robots 禁止、非文本内容、响应过大、网络错误 | 提交页·首页·价格页 critical，其余 warning | 1 · 确定性 |
| `cross_domain_redirect` | 提交的网址最终跳到站外域名 | warning | 1 · 确定性 |
| `broken_internal_link` | 站内链接目标 ≥400，或超时 / 重定向循环 / 重定向过多。同目标合并一条，最多列 6 个来源页；不查外链 | 404·410 且来源含首页/价格页/提交页 critical，其余 warning | 1 · 确定性 |
| `placeholder_content` | high 档全站报：`{{...}}`、`[product_name]` 类占位、`lorem ipsum`、「此处填写 / 待补充 / 示例文本」、「under construction / 网站建设中」。low 档只在首页 / 价格页报：`${...}`、`<%= ... %>`、`TODO` / `FIXME` | 模板变量 + high 档 + 关键页 critical，其余 warning | 1 · 确定性 |
| `contact_phone_mismatch` | 全站 ≥2 个不同号码（按后 8 位判同号），且至少两组出现在重要页或联系页 | warning | 0.6 · 启发式 |
| `contact_email_domain_mismatch` | 邮箱域名 ≠ 站点域名，且不在 20 个免费邮箱白名单内；非重要页只在联系页报 | **info** | 0.55 · 启发式 |
| `mailto_mismatch` | `mailto:` 地址 ≠ 页面展示的邮箱 | warning | 0.75 · 启发式 |
| `expired_date` | 日期已过去，且出现在 title / H1（0.85）或周边有「截止 / 报名 / 限时 / 今年 / 最新 / 即将」（0.6）。排除与 `article:published_time` 相同的日期、博客页非促销日期 | warning | 0.6 – 0.85 · 启发式 |
| `conflict_price` | 同实体、同币种、同计费周期出现不同价格 | warning | 0.8（涉博客 0.6）· AI 复核 |
| `conflict_trial_days` | 同实体出现不同免费试用天数 | warning | 0.78（涉博客 0.6）· AI 复核 |
| `conflict_refund_days` | 同实体出现不同退款期限 | warning | 0.78（涉博客 0.6）· AI 复核 |
| `conflict_quota` | 同实体出现不同使用额度 | **info** | 0.5 · AI 复核 |

冲突类共同排除条件：日期类事实、博客作唯一来源、起步价与示例语境（`起 / from / 低至 / 原价 / 示例 / 例如 / 曾为`）、单位或币种不同、同页同值。
只有冲突类会调用 AI 复核；AI 不可用时 `conflict_quota` 直接丢弃，其余保留并标注「未完成复核」。

页面重要性（决定严重度与排序）：首页 1.0、价格 0.95、政策 0.90、功能 0.85、帮助 0.78、联系 0.70、关于 0.62、其它 0.45、博客 0.30。
「关键页」= 提交页或重要性 ≥0.7。

## 2. 2026-09-09 审核：删除与降级

判断标准是「这条是否指向内容过期或出错」。偏 SEO 建议、偏抓取侧限制、置信度撑不起严重度的一律让位。

| 原规则 | 决定 | 理由 | 改动位置 |
|---|---|---|---|
| `empty_title` | **删除** | 属于 SEO 建议，与内容是否准确无关 | `src/rules/content.ts` |
| `empty_h1` | **删除** | 同上，噪音 | `src/rules/content.ts` |
| `thin_content` | **删除** | 正文 <150 字符多数是我们抓不到（SPA 未渲染、需登录），报给站长等于误伤；该情况已由结果页「本次检查限制」说明覆盖 | `src/rules/content.ts` |
| `placeholder_content` low 档中的 `localhost` / `127.0.0.1` / `staging.` / `test environment` | **删除模式** | 技术文档与帮助页里是正常内容 | `src/extract/html.ts` |
| `placeholder_content` low 档中的 `XXX` | **删除模式** | 会误伤「XXX 公司」「XXX 元」这类正常写法 | `src/extract/html.ts` |
| `conflict_availability` | **删除** | 置信度仅 0.35，本就只报 info，AI 不可用时还会整条丢弃 | `src/rules/conflicts.ts` |
| `contact_email_domain_mismatch` | **降为 info** | 集团邮箱、外包客服邮箱很常见，0.55 撑不起 warning | `src/rules/contact.ts` |
| `conflict_quota` | **降为 info** | 不同套餐额度天然不同 | `src/rules/conflicts.ts` |

保持不变（照原样报告）：`page_unreachable`、`cross_domain_redirect`、`broken_internal_link`、
`placeholder_content` high 档、`contact_phone_mismatch`、`mailto_mismatch`、`expired_date`、
`conflict_price`、`conflict_trial_days`、`conflict_refund_days`。

`availability` 事实抽取器（`src/extract/facts.ts`）保留并仍有单元测试覆盖，只是不再生成冲突候选，
需要时把 `conflicts.ts` 里那一行 `continue` 去掉即可恢复。

上述决定已由 `tests/unit/rules.test.ts` 中 5 条回归测试锁定，避免被无意改回。
