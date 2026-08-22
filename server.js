// KLSE Volume Tracker — 马来西亚股票成交量异动追踪
// Node.js + Express + 内置 node:sqlite + SSE 推送
// 数据源: Yahoo Finance 免费盘中接口(无需 key)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DB_PATH = path.join(__dirname, 'data.db');
const DIST = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 8080;

const DEFAULTS = {
  poll_interval_minutes: 10,
  window: '1h',               // 10m | 30m | 1h | 2h | 5h | 1d
  threshold_percent: 200,     // 当前时段量 >= 上一时段量的 n% 时提醒
  direction: 'surge',         // surge=放量 | drop=缩量
  min_previous_volume: 100000,
  cooldown_minutes: 30,
  telegram_bot_token: '',
  telegram_chat_id: '',
};

// 解析时段: '10m' | '2h' | '3d' → { value, unit }  (m=分钟 h=小时 d=天)
function parseWindow(window) {
  const m = /^(\d{1,4})([mhd])$/.exec(String(window));
  if (!m) return null;
  const value = parseInt(m[1], 10);
  if (value <= 0) return null;
  return { value, unit: m[2] };
}

const DEFAULT_WATCHLIST = [
  ['1155', 'Maybank'], ['1295', 'Public Bank'], ['1023', 'CIMB'],
  ['5347', 'Tenaga'], ['5183', 'Petronas Chemicals'], ['6033', 'Petronas Gas'],
  ['5681', 'Petronas Dagangan'], ['5225', 'IHH Healthcare'], ['6012', 'Maxis'],
  ['6888', 'Axiata'], ['6947', 'CelcomDigi'], ['3182', 'Genting'],
  ['4715', 'Genting Malaysia'], ['3816', 'MISC'], ['4197', 'Sime Darby'],
  ['5285', 'SD Guthrie'], ['2445', 'KLK'], ['1961', 'IOI Corp'],
  ['8869', 'Press Metal'], ['7084', 'QL Resources'], ['4707', 'Nestle Malaysia'],
  ['3034', 'Hap Seng'], ['5398', 'Gamuda'], ['3336', 'IJM'],
  ['5819', 'Hong Leong Bank'], ['1082', 'Hong Leong Financial'], ['1066', 'RHB Bank'],
  ['1015', 'AMMB'], ['4863', 'Telekom Malaysia'], ['5296', 'MR D.I.Y.'],
  ['7277', 'Dialog'], ['0166', 'Inari Amertron'], ['4677', 'YTL Corp'],
  ['6742', 'YTL Power'], ['5211', 'Sunway'], ['5246', 'Westports'],
  ['5168', 'Hartalega'], ['7113', 'Top Glove'],
];

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${msg}`;
  console.log(line);
}

// ---------------- 配置 ----------------
function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg = { ...cfg, ...raw };
  } catch {}
  if (!Array.isArray(cfg.watchlist) || cfg.watchlist.length === 0) {
    cfg.watchlist = DEFAULT_WATCHLIST.map(([code, name]) => ({ code, name }));
  }
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------------- 数据库 ----------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS samples(
    stock TEXT, ts INTEGER, vol INTEGER, PRIMARY KEY(stock, ts));
  CREATE INDEX IF NOT EXISTS idx_samples ON samples(stock, ts);
  CREATE TABLE IF NOT EXISTS live(
    stock TEXT PRIMARY KEY, name TEXT, price REAL, mtime INTEGER);
  CREATE TABLE IF NOT EXISTS alerts(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, stock TEXT, name TEXT,
    window TEXT, current INTEGER, previous INTEGER, ratio REAL, direction TEXT);
  CREATE TABLE IF NOT EXISTS state(
    stock TEXT PRIMARY KEY, above INTEGER, last_alert INTEGER);
`);

function storeCandles(code, candles) {
  if (!candles.length) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO samples(stock, ts, vol) VALUES(?,?,?)');
  for (const [t, v] of candles) stmt.run(code, Math.floor(t / 300) * 300, v);
}

function updateLive(code, name, price, mtime) {
  db.prepare(`INSERT INTO live(stock, name, price, mtime) VALUES(?,?,?,?)
    ON CONFLICT(stock) DO UPDATE SET name=excluded.name, price=excluded.price, mtime=excluded.mtime`)
    .run(code, name, price, mtime);
}

function prune() {
  db.prepare('DELETE FROM samples WHERE ts < ?').run(Math.floor(Date.now() / 1000) - 8 * 86400);
}

// ---------------- Yahoo 数据 ----------------
async function yahooGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseChart(d) {
  const r = d.chart.result[0];
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const vol = r.indicators?.quote?.[0]?.volume || [];
  const candles = [];
  const n = Math.min(ts.length, vol.length);
  for (let i = 0; i < n; i++) {
    const v = vol[i];
    if (v != null && v > 0) candles.push([ts[i], v]);  // 过滤午休/停牌的 0 量占位
  }
  return { meta, candles };
}

async function fetchIntraday(code) {
  const d = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=5m&range=1d`);
  const { meta, candles } = parseChart(d);
  return { code, name: meta.longName || meta.shortName || code,
    price: meta.regularMarketPrice, mtime: meta.regularMarketTime, candles };
}

async function fetchBackfill(code) {
  const d = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=5m&range=5d`);
  return parseChart(d).candles;
}

// ---------------- 成交量计算 ----------------
function mytDate(tsSec) {  // 马来西亚时区(UTC+8)的日期字符串
  return new Date(tsSec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function computeVolumes(code, window) {
  const pw = parseWindow(window);
  const row = db.prepare('SELECT MAX(ts) m FROM samples WHERE stock=?').get(code);
  if (!pw || !row || row.m == null) return null;
  const now = row.m;

  if (pw.unit === 'd') {
    // n 天 = 最近 n 个交易日累计 vs 前 n 个交易日累计(按马来西亚自然日分桶)
    const n = pw.value;
    const rows = db.prepare('SELECT ts, vol FROM samples WHERE stock=? AND ts > ? ORDER BY ts')
      .all(code, now - (2 * n + 7) * 86400);
    const buckets = {};
    for (const r of rows) {
      const d = mytDate(r.ts);
      buckets[d] = (buckets[d] || 0) + r.vol;
    }
    const dates = Object.keys(buckets).sort();
    if (dates.length < 2 * n) return null;
    const current = dates.slice(-n).reduce((s, d) => s + buckets[d], 0);
    const previous = dates.slice(-2 * n, -n).reduce((s, d) => s + buckets[d], 0);
    return { current, previous };
  }

  // 分钟/小时 -> 5 分钟 candle 数量(交易时段滚动, 自动跳过午休/隔夜)
  const minutes = pw.unit === 'h' ? pw.value * 60 : pw.value;
  const n = Math.max(1, Math.round(minutes / 5));
  const rows = db.prepare('SELECT vol FROM samples WHERE stock=? ORDER BY ts DESC LIMIT ?')
    .all(code, 2 * n);
  const current = rows.slice(0, n).reduce((s, r) => s + r.vol, 0);
  const previous = rows.slice(n, 2 * n).reduce((s, r) => s + r.vol, 0);
  return { current, previous };
}

function computeMetrics(cfg) {
  const out = [];
  for (const w of cfg.watchlist) {
    const code = w.code;
    let name = w.name || code;
    const live = db.prepare('SELECT name, price, mtime FROM live WHERE stock=?').get(code);
    if (live) name = live.name || name;
    const vol = computeVolumes(code, cfg.window);
    let current = null, previous = null, ratio = null, status = 'nodata';
    if (vol) {
      current = vol.current; previous = vol.previous;
      if (previous != null && previous >= cfg.min_previous_volume) {
        ratio = current / previous * 100;
        status = (cfg.direction === 'surge'
          ? ratio >= cfg.threshold_percent
          : ratio <= cfg.threshold_percent) ? 'alert' : 'ok';
      } else {
        status = 'low';
      }
    }
    out.push({ code, name, price: live?.price ?? null, mtime: live?.mtime ?? null,
      current, previous, ratio, status });
  }
  // 按增长倍率从大到小排列(无数据的排最后)
  out.sort((a, b) => {
    const ra = a.ratio, rb = b.ratio;
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  });
  return out;
}

// ---------------- 告警引擎 ----------------
function fmtNum(n) {
  if (n == null) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

async function sendTelegram(m, window, cfg) {
  const token = (cfg.telegram_bot_token || '').trim();
  const chat = (cfg.telegram_chat_id || '').trim();
  if (!token || !chat) return;
  const arrow = cfg.direction === 'surge' ? '📈 放量' : '📉 缩量';
  const text = `${arrow}提醒 — ${m.name} (${m.code}.KL)\n` +
    `时段: ${window} | 当前 ${fmtNum(m.current)} vs 上一时段 ${fmtNum(m.previous)} (${m.ratio.toFixed(1)}%)\n` +
    `现价 ${m.price ?? '-'}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch (e) { log(`telegram failed: ${e.message}`); }
}

function evaluateAlerts(cfg) {
  const w = cfg.window;
  const nowS = Math.floor(Date.now() / 1000);
  const cooldown = Math.max(1, cfg.cooldown_minutes || 30) * 60;
  for (const m of computeMetrics(cfg)) {
    if (m.status !== 'alert') {
      db.prepare(`INSERT INTO state(stock, above, last_alert) VALUES(?,0,0)
        ON CONFLICT(stock) DO UPDATE SET above=0`).run(m.code);
      continue;
    }
    const st = db.prepare('SELECT above, last_alert FROM state WHERE stock=?').get(m.code);
    const wasAbove = st?.above || 0;
    let lastAlert = st?.last_alert || 0;
    let should = false;
    if (!wasAbove && (nowS - lastAlert) >= cooldown) { should = true; lastAlert = nowS; }
    db.prepare(`INSERT INTO state(stock, above, last_alert) VALUES(?,1,?)
      ON CONFLICT(stock) DO UPDATE SET above=1, last_alert=excluded.last_alert`).run(m.code, lastAlert);
    if (should) {
      db.prepare(`INSERT INTO alerts(ts, stock, name, window, current, previous, ratio, direction)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(nowS, m.code, m.name, w, m.current, m.previous, Math.round(m.ratio * 10) / 10, cfg.direction);
      sendTelegram(m, w, cfg);
    }
  }
}

// ---------------- 市场时段 ----------------
function isMarketOpen() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);  // UTC+8
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (9 * 60 <= hm && hm < 12 * 60 + 30) || (14 * 60 + 30 <= hm && hm < 16 * 60 + 50);
}

// ---------------- 调度 ----------------
let backfilled = false;
let lastPoll = null;
let pollPromise = null;

function poll(backfill = false) {
  if (pollPromise) return pollPromise;  // 复用进行中的抓取, 避免并发打 Yahoo
  pollPromise = (async () => {
    try {
      const cfg = loadConfig();
      const watchlist = cfg.watchlist;
      if (backfill && !backfilled) {
        log(`回填 5 日 candle (${watchlist.length} 只)...`);
        for (const w of watchlist) {
          try { storeCandles(w.code, await fetchBackfill(w.code)); }
          catch (e) { log(`backfill ${w.code} 失败: ${e.message}`); }
          await sleep(250);
        }
        backfilled = true;
      }
      for (const w of watchlist) {
        try {
          const d = await fetchIntraday(w.code);
          storeCandles(w.code, d.candles);
          if (d.name) updateLive(w.code, d.name, d.price, d.mtime);
        } catch (e) { log(`poll ${w.code} 失败: ${e.message}`); }
        await sleep(200);
      }
      evaluateAlerts(cfg);
      prune();
      lastPoll = Date.now() / 1000;
      log(`即时抓取完成 (${watchlist.length} 只)`);
      broadcast();
    } finally {
      pollPromise = null;
    }
  })();
  return pollPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 节流即时抓取: 数据陈旧(超过轮询间隔)才真正抓 Yahoo, 否则直接用缓存
async function maybePoll() {
  if (pollPromise) await pollPromise;  // 正在抓, 等它完成
  const cfg = loadConfig();
  const interval = Math.max(1, cfg.poll_interval_minutes || 10) * 60;
  if (lastPoll && (Date.now() / 1000 - lastPoll) < interval) return;
  if (!isMarketOpen() && backfilled) return;  // 休市且已回填, 不抓
  await poll();
}

// 有客户端连接时定时抓取推送; 无客户端则跳过(省请求)
let pollTimer = null;
function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (clients.size > 0) maybePoll();
  }, 60 * 1000);
}

// ---------------- SSE ----------------
const clients = new Set();

function broadcast() {
  const data = `data: ${JSON.stringify(buildState())}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch {}
  }
}

// ---------------- State ----------------
function buildState() {
  const cfg = loadConfig();
  return {
    settings: {
      poll_interval_minutes: cfg.poll_interval_minutes,
      window: cfg.window,
      threshold_percent: cfg.threshold_percent,
      direction: cfg.direction,
      min_previous_volume: cfg.min_previous_volume,
      cooldown_minutes: cfg.cooldown_minutes,
      telegram_bot_token: cfg.telegram_bot_token,
      telegram_chat_id: cfg.telegram_chat_id,
    },
    watchlist: cfg.watchlist,
    stocks: computeMetrics(cfg),
    alerts: db.prepare(`SELECT id, ts, stock, name, window, current, previous, ratio, direction
      FROM alerts ORDER BY id DESC LIMIT 100`).all(),
    status: {
      market_open: isMarketOpen(),
      last_poll: lastPoll,
      polling: !!pollPromise,
      now: Math.floor(Date.now() / 1000),
    },
  };
}

// ---------------- HTTP ----------------
const app = express();
app.use(express.json());
app.use(express.static(DIST));

app.get('/api/state', async (req, res) => {
  await maybePoll();  // 数据陈旧则即时抓取, 否则用缓存
  res.json(buildState());
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  ensurePolling();
  maybePoll();  // 连接建立时即时刷新
  // 心跳: 每 30s 发一个注释帧, 防止代理层在两次数据间(最长 10 分钟)把连接当空闲断掉
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post('/api/settings', (req, res) => {
  const cfg = loadConfig();
  for (const k of Object.keys(DEFAULTS)) {
    if (req.body[k] != null) cfg[k] = req.body[k];
  }
  saveConfig(cfg);
  db.exec('DELETE FROM state');  // 阈值/窗口变了, 重置告警状态
  broadcast();
  res.json({ ok: true });
});

app.post('/api/watchlist/add', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\.KL$/, '');
  if (!/^\d{1,5}$/.test(code)) {
    return res.status(400).json({ error: '股票代码格式不对 (纯数字, 如 1155)' });
  }
  const cfg = loadConfig();
  if (cfg.watchlist.some((w) => w.code === code)) return res.json({ ok: true, dup: true });
  let name = code;
  try {
    const d = await fetchIntraday(code);
    name = d.name;
    storeCandles(code, d.candles);
    updateLive(code, name, d.price, d.mtime);
  } catch {}
  cfg.watchlist.push({ code, name });
  saveConfig(cfg);
  broadcast();
  res.json({ ok: true, name });
});

app.post('/api/watchlist/remove', (req, res) => {
  const code = String(req.body.code || '').trim();
  const cfg = loadConfig();
  cfg.watchlist = cfg.watchlist.filter((w) => w.code !== code);
  saveConfig(cfg);
  db.prepare('DELETE FROM samples WHERE stock=?').run(code);
  db.prepare('DELETE FROM state WHERE stock=?').run(code);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/poll', (req, res) => {
  poll();  // fire-and-forget
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'), (err) => {
    if (err) res.status(404).send('Not found (run `npm run build` first)');
  });
});

// ---------------- 启动 ----------------
if (!fs.existsSync(CONFIG_PATH)) {
  saveConfig({ ...DEFAULTS, watchlist: DEFAULT_WATCHLIST.map(([code, name]) => ({ code, name })) });
}
app.listen(PORT, () => {
  log(`KLSE Volume Tracker 已启动 → http://localhost:${PORT}`);
  log(`自选股 ${loadConfig().watchlist.length} 只, 轮询间隔 ${loadConfig().poll_interval_minutes} 分钟`);
});
poll(true);  // 启动时回填历史
