# FreshPage V0

> 用户打开 FreshPage 首页，无需登录，只输入一个公开网站网址；后台自动检查最多 50 个页面，
> 并在前端直接展示失效链接、明确内容异常以及疑似过期或冲突的内容，结果匿名保存 7 天。

对应方案文档：`FreshPage-V0极简验证版方案.md`

**当前状态：方案 §1–§24 全部落地，68/68 自动化测试通过，端到端冒烟全绿。**

---

## 1. 快速开始

```bash
npm install
npm run build
npm start            # 默认 http://localhost:3000
```

首次运行会自动在 `data/freshpage.db` 创建 SQLite 数据库。

可选：

```bash
npm test             # 编译 + 运行 68 个测试（38 单元 + 30 集成）
npm run gen:sample   # 生成「示例报告」所需的数据文件 data/sample-report.json
npm run worker       # 以独立 Worker 进程模式启动（配合 FP_API_ONLY=1 的 Web 进程）
npm run cleanup      # 手动执行一次过期数据清理
npm run stats        # 打印验证指标（完成率 / 反馈 / 埋点漏斗）
```

浏览器打开 `http://localhost:3000`，输入任意公开网址即可开始检查。

> 本地想扫描演示站点或内网地址时，需加 `FP_ALLOW_PRIVATE_TARGETS=1`（生产环境请勿开启）。

## 2. 技术选型与决策说明

| 项 | 选择 | 说明 |
|---|---|---|
| 语言 / 运行时 | TypeScript + Node.js ≥ 22.5 | 全栈同语言 |
| Web | Express（仅提供 JSON API + 静态资源） | V0 不需要 SSR，前端无构建步骤 |
| 前端 | 原生 HTML / CSS / JS（`public/`） | 降低构建复杂度，轮询更新进度 |
| 存储 | `node:sqlite`（SQLite） | 本机无 PostgreSQL；SQL 全部集中在 `src/db/sqlite.ts` 与 `src/db/repository.ts`，迁移 Postgres 只需替换这两处（布尔与 JSON 以 TEXT 存储，时间统一 ISO8601） |
| HTML 解析 | cheerio | 不执行页面脚本 |
| 浏览器回退 | Playwright（可选依赖） | 仅在正文极少时尝试使用；未安装则静默降级 |
| AI 复核 | OpenAI 兼容接口（DeepSeek 等） | 未配置 Key 或服务失败时自动降级为纯规则报告 |
| 队列 | 进程内队列 + 数据库轮询 | 支持 Web/Worker 分离部署，也支持单进程运行 |

## 3. 能查出什么问题

### 3.1 确定性检查（不依赖 AI，可复现）

| 检查项 | 规则文件 | 严重度 |
|---|---|---|
| 页面无法访问（4xx / 5xx / 超时） | `src/rules/pageAccess.ts` | 关键页 critical，其余 warning |
| 站内链接失效 | `src/rules/brokenLinks.ts` | warning |
| 疑似过期日期（促销 / 截止时间） | `src/rules/dates.ts` | warning |
| 联系方式异常（电话不一致 / 邮箱域名不符 / mailto 不符） | `src/rules/contact.ts` | warning |
| 占位内容（未替换模板变量 / Lorem ipsum / 在建提示） | `src/rules/content.ts` | 模板变量 + 关键页 = critical，其余 warning |

### 3.2 跨页面事实冲突

`src/rules/conflicts.ts` 从各页抽取价格、免费试用天数、退款天数、配额等事实，按实体键比对**单位一致**的冲突，结果页以左右并排形式展示两处原文证据与链接。冲突为「候选」，需人工确认——不同套餐价格不同属正常业务差异。

### 3.3 AI 辅助复核（安全降级）

`src/ai/review.ts`，OpenAI 兼容协议（默认 DeepSeek）。未配 Key、超时、返回非法 JSON 时**自动丢弃 AI 结论，仅保留确定性结果**，结果页通过 `aiStatus` 字段标注本次状态（`ok` / `disabled` / `no_key` / `timeout` / `error` / `invalid_response`）。

### 3.4 部分失败与重试

页面抓取失败不会中断整次检查：成功页面的结果照常输出，失败页面单列并在结果页提示。**用户可点击「重试 N 个失败页面」只重跑失败项，已成功的结果原样保留。**

## 4. 目录结构

```
src/
  config.ts              全局配置（全部可用环境变量覆盖）
  index.ts / worker.ts   进程入口 / 独立 Worker 入口
  api/                   Express 路由、服务端、限流
  crawl/                 安全抓取器、robots、sitemap、页面发现、浏览器回退
  extract/               HTML 抽取与结构化事实抽取
  rules/                 确定性规则与跨页面冲突候选
  ai/                    AI 复核（严格受限 + 安全降级）
  scan/                  扫描主流程、失败页重试、任务队列
  security/              URL 标准化、IP 解析、SSRF 防护
  db/                    SQLite 连接、迁移、仓储层
  util/                  日志与通用工具
  fixtures/              固定测试网站服务（本地演示用）
  scripts/               示例报告生成、验证指标统计脚本
public/                  前端页面（首页 / 进度 / 结果 / 隐私说明）
fixtures/demo-site/      受控演示网站（方案第 16 节要求的全部场景）
tests/                   单元测试与集成测试
docs/                    SSRF、验收清单、已知限制、验证记录
```

## 5. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回保留天数与页面上限 |
| POST | `/api/scans` | 提交检查，返回 `202` + `token` |
| GET | `/api/scans/:token` | 查询进度与结果（前端轮询） |
| POST | `/api/scans/:token/cancel` | 取消进行中的检查 |
| POST | `/api/scans/:token/retry-failed` | 只重试失败页面，保留已有结果 |
| DELETE | `/api/scans/:token` | 立即删除结果（链接随即 404） |
| POST | `/api/findings/:id/feedback` | 对单条结果投票「有用 / 没用」，需携带正确 token |
| POST | `/api/telemetry` | 匿名行为埋点（白名单事件名 + 可选 token），用于验证指标 |
| GET | `/api/example` | 示例报告数据（未生成时返回 404） |

页面路由：`/`、`/privacy`、`/example`、`/result/:token`（均为 SPA 入口）。

## 6. 主要环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | HTTP 端口 |
| `DB_PATH` | `data/freshpage.db` | SQLite 文件位置 |
| `FP_MAX_PAGES` | 50 | 每次扫描最多页面数（V0 不对用户开放修改） |
| `FP_MAX_DEPTH` | 2 | 链接遍历深度 |
| `FP_SCAN_CONCURRENCY` | 3 | 单扫描并发数 |
| `FP_REQUEST_TIMEOUT_MS` | 12000 | 单页超时 |
| `FP_MAX_RESPONSE_BYTES` | 2000000 | 单页响应上限 |
| `FP_MAX_REDIRECTS` | 5 | 最大重定向次数 |
| `FP_SCAN_BUDGET_MS` | 480000 | 单次扫描总时间预算 |
| `FP_RETENTION_DAYS` | 7 | 结果保存天数 |
| `FP_ALLOWED_PORTS` | 80,443 | 允许访问的目标端口 |
| `FP_ALLOW_PRIVATE_TARGETS` | false | **仅测试夹具使用**，允许抓取私网 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | DeepSeek 默认值 | 不配置则跳过 AI 复核 |
| `FP_AI_ENABLED` | true | 关闭后只输出规则结果 |
| `FP_AI_MIN_CONFIDENCE` | 0.55 | 低于该置信度的 AI 判断不展示 |
| `FP_BROWSER_FALLBACK` | true | JS 渲染回退开关（需 `npx playwright install chromium`；缺少 headless shell 时自动改用完整 Chromium） |
| `FP_TELEMETRY_ENABLED` | true | 匿名前端埋点开关 |
| `FP_TELEMETRY_MAX_PER_SESSION_DAY` | 200 | 单会话每日埋点条数上限 |
| `FP_MAX_SCANS_PER_IP` | 6 / 10 分钟 | 单 IP 频率限制 |
| `FP_MAX_SCANS_PER_IP_DAY` | 30 | 单 IP 每日上限 |
| `FP_DAILY_PAGE_BUDGET` | 5000 | 全局每日页面预算 |
| `FP_API_ONLY` | false | 只提供 API，不消费队列（配合独立 Worker） |
| `FP_WORKER_ONLY` | false | 只消费队列，不监听 HTTP |

完整说明见 `.env.example`。启动时会自动加载项目根目录的 `.env`（Node 内置 `process.loadEnvFile`，无额外依赖）；
已经注入的真实环境变量优先级更高，`.env` 不会覆盖它们，测试环境不加载 `.env`。

## 7. 安全与数据保留

- SSRF 防护细节见 [`docs/SSRF.md`](docs/SSRF.md)：协议 + 端口白名单、DNS 解析后逐 IP 校验、pin 住 lookup 防 DNS rebinding、每次重定向重新校验、IPv4/IPv6 各类字面量与隧道地址拆解。
- 结果链接使用 160 bit 随机 token，不可枚举；7 天后自动失效，用户可在结果页立即删除。
- 日志不记录网页正文，IP 只保存哈希值。
- 匿名埋点只记录事件名、结果 token 与会话哈希，随结果一起 7 天后删除，可用 `FP_TELEMETRY_ENABLED=0` 关闭。
- 防滥用全部在后台强制，不依赖前端限制。
- 抓取遵循 `robots.txt`；站点全站 `Disallow` 时直接失败退出。

## 8. 测试与验收

```bash
npm test    # 68 个用例：38 单元 + 30 集成
```

覆盖范围：URL 归一化、SSRF 拦截（15 个危险地址）、robots / sitemap 解析、页面发现优先级、事实抽取、各规则命中与误报抑制、AI 降级、API 全流程、限流、数据清理、失败页重试（含 429 退避）、任务原子认领、匿名埋点。

误报收敛已用真实站点 `neovim.io` 回归验证：首轮 11 条误报 → 修复后 **0 条**。

- 验收清单见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。
- 已知限制见 [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md)。
- 用户验证数据记录方式见 [`docs/VALIDATION.md`](docs/VALIDATION.md)。
- **遗留问题处理记录见 [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md)：原清单 4 项已全部处理，其中埋点口径与浏览器回退前提有需要注意的地方。**
