# KLSE 潜力精选

扫描马来西亚全市场，把符合条件的少数股票直接解读给用户：**现在是否值得考虑、为什么入选、参考哪个价位、什么时候放弃原有判断**。首页默认最多3只，不用较弱信号凑数。

React + Vite 前端，Express + SQLite 后端，SSE 自动推送。行情来自 TradingView 马来西亚全市场快照，日线与数字代码映射来自 Yahoo Finance。免费接口可能延迟或限流；抓取时间不是交易所行情时间。

## 用户看到什么

- **潜力精选**：先扫描股票池，再按依据完整度、形态匹配度、目标/风险参考空间和量能排序，展示最多 `pick_count` 只（首页上限5只）。
- **成交活跃度**：精选还需通过最近20个完整交易日平均成交额下限（默认估算 RM 200,000，按每日收盘价乘成交量计算），并有本次有效成交。
- **直接分析**：给出“可重点考虑”“等待回踩”“等待确认”“资料待补齐”等结论，附具体数值支持。
- **单股详情**：参与参考、失效条件、60个交易日价格和成交量图、形态关键价位、资料时间。
- **我的关注**：用户自己的星标保存在浏览器；与系统的策略观察记录分开。
- **异动记录**：无需 Telegram，也能在网页看到放量、急涨、暴跌和形态异动。
- **Telegram**：`/top` 与网页共用精选和解释，自动广播只给少数精选与观察结果变化。

趋势、量能和双底仅是技术条件，没有覆盖财报、估值和公司公告。形态评分不是上涨概率；量度目标不保证达到。系统观察记录未模拟真实成交、费用与滑点，不能作为实盘收益。详见 [Investor.gov 历史表现说明](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-47)。

## 本地运行

推荐 Node.js 24（使用内置 `node:sqlite`）。

```sh
npm ci
cp .env.example .env
# 编辑 .env，填写随机的 ADMIN_TOKEN；Telegram 与 LLM 均可留空。
npm test
npm run build
npm start
```

访问 `http://localhost:8080`。Windows PowerShell 可用 `Copy-Item .env.example .env`。前端开发使用 `npm run dev`，另一个终端运行 `npm start`；Vite 将 `/api` 代理至8080。

服务会自动创建 `DATA_DIR`、`config.json` 与 SQLite 数据库；启动先返回已有缓存，后台扫描市场并补齐日线。冷启动的代码映射与历史回填可能需要较长时间，界面会显示资料状态。

### 离线界面验收

```sh
npm run build
npm run preview:fixture
```

访问 `http://localhost:8091`。所有股票明确标记为示例，固定到本地日期的10:30测试时钟，使用独立临时数据库，不读取 `.env` 或真实数据，也不能向外网发送通知。管理员测试令牌是 `preview-only-token`。这是验收工具，不是生产启动方式。

## 部署

Render Blueprint 使用 `render.yaml`：Node24、`npm ci && npm test && npm run build`、`node server.js`、`/healthz`，并将数据库与配置写入 `/var/data` 持久盘。

在服务环境变量设置：

| 变量                                      | 用途                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `ADMIN_TOKEN`                             | 随机管理员令牌；未设置时所有管理写操作锁定，公开分析仍可访问 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 可选，Telegram 通知与指令                                    |
| `LLM_API_KEY`                             | 可选，自然语言查询使用 DeepSeek                              |
| `PUBLIC_URL`                              | Telegram 内指向网站的地址                                    |
| `DATA_DIR`                                | 持久化目录；默认为项目目录                                   |
| `PORT`                                    | 服务端口，默认8080                                           |

已有服务升级到2.0后，需要配置 `ADMIN_TOKEN` 才能修改网页设置。令牌通过 Authorization Bearer 请求头提交，设置窗口关闭后不保留。密钥不再通过 URL 参数写入或回显。真实 `.env`、配置和数据库不得提交到 Git。

## 筛选与时间口径

- 强势条件：20个交易日涨幅范围、当前累计量/上一交易日全天量、现价高于 MA5、MA5 > MA10 > MA15 > MA20。
- 形态条件：两个相近低点、间隔与颈线高度约束、近期**完成日线**突破、当前报价守住颈线、评分和参考空间比达标。
- 首页只保留“可重点考虑”的候选。已离开形态参考区间、数据不足或过期的股票不会补入精选。
- 形态目标固定为“颈线 + 形态高度”，达到目标后不会把目标向上移动以制造更好的空间。
- 日线回填在收盘前排除当天未完成 candle。盘中均线使用历史收盘加当前价格，成交量尚未定稿，结论会变化。
- 历史 `asof` 的涨幅、均线和昨日量都只使用参考日之前的数据，防止未来数据泄漏。
- 分钟/小时量采用累计快照差值，只在**同一连续交易时段**内覆盖足够历史且快照未过期时计算。午休、跨日或数据不足返回缺少资料，不进行错误拼接。新配置默认 `1d`，旧配置保留原时段。
- 常规时段使用 MYT 09:00–12:30、14:30–17:00；通过 `market_holidays` 配置交易所休市日期。这里不提供自动节假日日历，半日交易安排也需单独维护。[Bursa 交易手册](https://www.bursamalaysia.com/sites/5d809dcf39fba22790cad230/assets/6322ac3b5b711a2a5e7772a7/TradingManual_v5.2_final.pdf)。
- 休市时可保留最近完成交易日的精选，明确显示数据日期和快照状态；陈旧资料不作当前参与判断。

## 可靠性与管理权限

- 公共只读接口：`GET /api/state`、`/api/events`、`/api/stocks/:code`、`/api/watchlist`、`/api/screen`。
- 其余接口需 `Authorization: Bearer <ADMIN_TOKEN>`。管理员设置限制数值类型与范围；Telegram 普通群成员只能查询，群主/管理员才可改非敏感参数。
- `GET /api/broadcast-test` 永远只预览，不写告警去重、观察名单或发送队列；实际广播使用管理员 `POST /api/broadcast`。
- 信号去重、观察记录与 Telegram 发送队列在同一 SQLite 事务内提交；发送失败保留到队列，后续重试。Telegram 多段消息在部分发送成功后重试可能重复已送达的段落，不提供恰好一次交付保证。
- 每个新告警先写入网页历史。SSE 首次连接立即返回状态，并有心跳、重连与浏览器缓存恢复。
- 观察天数按存储的真实交易日期计算，同一天扫描多次不增加天数。旧版受计天错误影响的到期记录会加注说明，不将其包装成策略胜率。
- 上游请求有超时；行情失败保留最近快照并显示错误。日线回填与通知发送有锁防止重入。

## 配置

在网页的管理设置修改常用选项，或编辑持久目录中的 `config.json`。敏感凭据优先用环境变量。

| 参数                                  | 默认    | 含义                                               |
| ------------------------------------- | ------- | -------------------------------------------------- |
| `pick_count`                          | 3       | 精选和同时观察的目标数量，首页最多5只              |
| `min_average_daily_value`             | 200000  | 最近20个完整交易日平均成交额估算下限，RM           |
| `poll_interval_minutes`               | 5       | 市场快照更新间隔                                   |
| `window`                              | `1d`    | 看板成交量对比时段                                 |
| `screen_min_gain` / `screen_max_gain` | 15 / 25 | 20交易日涨幅范围，%                                |
| `screen_vol_mult`                     | 2       | 累计量与上一交易日全天量倍数                       |
| `db_min_score` / `db_min_rr`          | 70 / 1  | 形态匹配度和最小参考空间比                         |
| `db_fresh`                            | 2       | 突破允许的日线新鲜度                               |
| `price_thresholds`                    | `[]`    | 按价格范围设置网页放量告警阈值，空数组关闭该类提醒 |
| `cooldown_minutes`                    | 30      | 同股票放量告警冷却                                 |
| `watch_days`                          | 15      | 策略观察交易日数                                   |
| `market_holidays`                     | `[]`    | YYYY-MM-DD 休市日期列表                            |

Telegram：`/stock MAYBANK` 或 `/stock 1155` 查看直接分析，`/top` 查看当前少数精选，`/screen` 查看规则筛选，`/watch` 查看观察记录，`/stats` 查看规则结果，`/params` 查看设置，管理员 `/set pick_count 3` 修改参数。自然语言工具只能使用本地资料，不会自行补写新闻与财报。

## 开发与验证

```sh
npm test
npm run build
npm run format:check
npm audit
```

回归测试使用独立临时 SQLite 和模拟上游，涵盖历史日期无未来数据、午休/跨日快照、观察计天、接口权限、告警冷却、干跑无副作用、通知重试、SSE 首次快照及分析口径。GitHub Actions 对 push/PR 执行测试与构建。

```
server.js                 HTTP、SQLite、数据源、后台调度和通知
lib/analysis.js           时间口径、筛选计算与直接中文分析
lib/settings.js           设置校验与参数转换
lib/security.js           公开查询/管理员操作权限
src/App.jsx               精选、单股分析、关注、观察记录与设置
src/styles.css            桌面与手机布局
tests/                    核心算法与接口回归测试
scripts/preview-fixture.js 离线界面验收
render.yaml               部署配置
```
