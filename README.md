# KLSE Volume Tracker — 马来西亚股票成交量异动追踪

追踪马股（Bursa Malaysia / KLSE）盘中成交量，当「当前时段成交量」达到「上一时段成交量」的 n% 时提醒你。

- **数据源**：Yahoo Finance 免费盘中接口（无需 key）
- **前端**：React + Vite，通过 **SSE（Server-Sent Events）** 实时接收后端推送，后端数据一更新前端就自动刷新
- **后端**：Node.js + Express，内置 `node:sqlite`（零原生依赖），每 N 分钟轮询 Yahoo
- **提醒**：网页内通知 + 告警列表；可选 Telegram

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 18 + Vite 6 |
| 后端 | Express 4 + SSE 推送 |
| 存储 | SQLite（Node 内置 `node:sqlite`，无需编译） |
| 数据源 | Yahoo Finance（`.KL` 后缀，5 分钟 candle） |

## 本地运行

要求 Node.js ≥ 22.5（`node:sqlite` 需要）。

```bash
npm install
npm run build      # 构建前端 → dist/
npm start          # 启动服务 → http://localhost:8080
```

开发模式（热更新）：

```bash
npm run dev        # Vite dev server（/api 自动代理到 8080 后端）
# 另开一个终端: node server.js
```

首次运行自动生成 `config.json`（含默认 38 只马股自选列表）。

## 部署到 Render

### 方式 A：Blueprint 一键部署（推荐）

1. 把本仓库 push 到 GitHub（已包含 `render.yaml`）
2. 打开 [render.com](https://render.com) → 登录 → **New + → Blueprint**
3. 连接 GitHub，选择 `klse-volume-tracker` 仓库
4. Render 自动读取 `render.yaml`，点 **Apply** 即创建服务并部署

### 方式 B：手动创建 Web Service

1. Render → **New + → Web Service** → 连接 GitHub 仓库
2. 配置：
   - **Runtime**：Node
   - **Build Command**：`npm install && npm run build`
   - **Start Command**：`node server.js`
   - **Environment Variable**：`NODE_VERSION` = `24`
3. 点 **Create Web Service**，等构建部署完成

部署后 Render 会分配一个 `xxx.onrender.com` 域名，直接访问即可。

> **注意**：Render 免费档的磁盘是临时的（重启/部署会清空），所以 SQLite 里的数据（candle 缓存、告警历史）会丢。启动后会自动重新抓取回填，功能不受影响；只是告警历史不跨重启保留。如需持久保留，可挂载 Render Disk（付费）。

## 配置

在网页顶部快捷条直接改「对比时段 / 阈值 % / 方向」，高级设置里改轮询间隔、最小量、冷却、Telegram。或手动编辑 `config.json`：

| 字段 | 说明 | 默认 |
|------|------|------|
| `window` | 对比时段：`10m/30m/1h/2h/5h/1d` | `1h` |
| `threshold_percent` | 提醒阈值 %（当前/上一时段） | `200` |
| `direction` | `surge` 放量 / `drop` 缩量 | `surge` |
| `min_previous_volume` | 上一时段量低于此值不提醒 | `100000` |
| `cooldown_minutes` | 同一只股票两次提醒最短间隔 | `30` |
| `poll_interval_minutes` | 轮询间隔（分钟） | `10` |
| `telegram_bot_token` / `telegram_chat_id` | Telegram 推送（可选） | 空 |

`watchlist` 是自选股（`code` 纯数字，自动加 `.KL`），网页可直接增删。

## 提醒语义

- 滚动时段（10m~5h）：按「交易 candle」滚动（5 分钟一根，1 小时 = 最近 12 根），`当前 = 最近 N 根 candle 量之和`，`上一 = 再往前 N 根`，**自动跳过午休(12:30–14:30)与隔夜**
- 1 天模式：`当前 = 今日累计量`，`上一 = 前一交易日全天量`
- 每只股票「跌破阈值 → 再次突破」之间只提醒一次（配合冷却时间防抖）
- 列表按**增长倍率从大到小**排序，异动最明显的排最前

## 目录结构

```
server.js          # 后端：Express + SSE + SQLite + Yahoo 轮询 + 告警引擎
src/App.jsx        # 前端：React 单组件（UI + SSE 订阅）
src/main.jsx       # React 入口
index.html         # Vite 入口
vite.config.js     # Vite 配置（dev 代理 /api → 8080）
render.yaml        # Render Blueprint 部署配置
config.json        # 运行时生成（设置 + 自选股）
data.db            # 运行时生成（SQLite）
```

> 注意：Yahoo 是**非官方**接口，免费但请控制自选股数量（几十到几百只）与轮询频率，避免被限流。追踪「全部 1082 只马股 + 盘中 + 批量」需用付费数据源（如 EODHD 付费套餐）。
