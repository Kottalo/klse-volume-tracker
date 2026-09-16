// KLSE Volume Tracker — 马来西亚股票成交量异动追踪
// Node.js + Express + 内置 node:sqlite + SSE 推送
// 数据源: Yahoo Finance 免费盘中接口(无需 key)
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;  // 持久化目录(Render 磁盘挂载点), 默认同代码目录
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DB_PATH = path.join(DATA_DIR, 'data.db');
const DIST = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 8080;
const VERSION = 'v9.09-emoji3';  // 部署版本探针

const DEFAULTS = {
  poll_interval_minutes: 5,   // 开市时段每 5 分钟轮询
  window: '1h',               // 时段间隔: 30m/1h/2h/5h/1d
  cooldown_minutes: 30,       // 盘中提醒重复间隔(分)
  telegram_bot_token: '',
  telegram_chat_id: '',
  twilio_sid: '',
  twilio_auth_token: '',
  twilio_from: '+15594914664',
  twilio_to: '+601118930633',
  whatsapp_recipients: [],
  twilio_content_sid: '',
  price_thresholds: [],   // 按股价范围设提醒阈值: [{max, threshold}], max=null=无限; 空=不通知
  price_drop_threshold: 40,  // 股价较昨收跌幅 >= 此% 时提醒
  gap_up_threshold: 7,       // 股价较开盘涨幅 >= 此% 时提醒 (只限当日成交量 top 30)
  oanor_api_key: '',          // oanor 备份数据源 key(可选)
};

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
  // 环境变量覆盖(用于 Render 部署, 避免把凭据写进代码库)
  if (process.env.TWILIO_SID) cfg.twilio_sid = process.env.TWILIO_SID;
  if (process.env.TWILIO_AUTH_TOKEN) cfg.twilio_auth_token = process.env.TWILIO_AUTH_TOKEN;
  if (process.env.TWILIO_FROM) cfg.twilio_from = process.env.TWILIO_FROM;
  if (process.env.TWILIO_TO) cfg.twilio_to = process.env.TWILIO_TO;
  if (process.env.TWILIO_CONTENT_SID) cfg.twilio_content_sid = process.env.TWILIO_CONTENT_SID;
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegram_bot_token = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegram_chat_id = process.env.TELEGRAM_CHAT_ID;
  if (process.env.OANOR_KLSE_API_KEY) cfg.oanor_api_key = process.env.OANOR_KLSE_API_KEY;
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
  CREATE TABLE IF NOT EXISTS daily(
    stock TEXT, date TEXT, volume INTEGER, PRIMARY KEY(stock, date));
  CREATE INDEX IF NOT EXISTS idx_daily ON daily(stock, date);
  CREATE TABLE IF NOT EXISTS live(
    stock TEXT PRIMARY KEY, name TEXT, price REAL, prevClose REAL, open REAL, mtime INTEGER);
  CREATE TABLE IF NOT EXISTS alerts(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, stock TEXT, name TEXT,
    window TEXT, current INTEGER, previous INTEGER, ratio REAL, direction TEXT);
  CREATE TABLE IF NOT EXISTS state(
    stock TEXT PRIMARY KEY, above INTEGER, last_alert INTEGER);
  CREATE TABLE IF NOT EXISTS daily_alert(
    stock TEXT, date TEXT, ts INTEGER, PRIMARY KEY(stock, date));
  CREATE TABLE IF NOT EXISTS price_drop_alert(
    stock TEXT, date TEXT, ts INTEGER, PRIMARY KEY(stock, date));
  CREATE TABLE IF NOT EXISTS gap_up_alert(
    stock TEXT, date TEXT, ts INTEGER, PRIMARY KEY(stock, date));
  CREATE TABLE IF NOT EXISTS universe(
    stock TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS volume_ts(
    stock TEXT, ts INTEGER, cum_volume INTEGER, PRIMARY KEY(stock, ts));
  CREATE INDEX IF NOT EXISTS idx_volume_ts ON volume_ts(stock, ts);
  CREATE TABLE IF NOT EXISTS daily_vol(
    stock TEXT, date TEXT, volume INTEGER, PRIMARY KEY(stock, date));
`);
// 迁移: 旧库 live 表补 prevClose / open 列
try { db.exec('ALTER TABLE live ADD COLUMN prevClose REAL'); } catch (e) {}
try { db.exec('ALTER TABLE live ADD COLUMN open REAL'); } catch (e) {}
try { db.exec('ALTER TABLE live ADD COLUMN volume INTEGER'); } catch (e) {}
try { db.exec('ALTER TABLE live ADD COLUMN avg10d REAL'); } catch (e) {}
try { db.exec('ALTER TABLE live ADD COLUMN avg30d REAL'); } catch (e) {}
try { db.exec('ALTER TABLE universe ADD COLUMN code TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE live ADD COLUMN avg4w REAL'); } catch (e) {}
try { db.exec('ALTER TABLE live ADD COLUMN avg5d REAL'); } catch (e) {}

function storeCandles(code, candles) {
  if (!candles.length) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO samples(stock, ts, vol) VALUES(?,?,?)');
  for (const [t, v] of candles) stmt.run(code, Math.floor(t / 300) * 300, v);
}

function storeDaily(code, rows) {
  if (!rows.length) return;
  const stmt = db.prepare('INSERT INTO daily(stock, date, volume) VALUES(?,?,?) ON CONFLICT(stock, date) DO UPDATE SET volume=excluded.volume');
  for (const [date, volume] of rows) stmt.run(code, date, volume);
}

function updateLive(code, name, price, prevClose, open, mtime) {
  db.prepare(`INSERT INTO live(stock, name, price, prevClose, open, mtime) VALUES(?,?,?,?,?,?)
    ON CONFLICT(stock) DO UPDATE SET name=excluded.name, price=excluded.price, prevClose=excluded.prevClose, open=excluded.open, mtime=excluded.mtime`)
    .run(code, name, price, prevClose, open, mtime);
}

function prune() {
  db.prepare('DELETE FROM volume_ts WHERE ts < ?').run(Math.floor(Date.now() / 1000) - 3 * 86400);
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
  // 当天开盘价 = 第一个非空的 open(5m candle, 即 9:00 开盘价)
  const openArr = d.chart?.result?.[0]?.indicators?.quote?.[0]?.open || [];
  let open = null;
  for (const o of openArr) { if (o != null && o > 0) { open = o; break; } }
  return { code, name: meta.longName || meta.shortName || code,
    price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose, open, mtime: meta.regularMarketTime, candles };
}

async function fetchBackfill(code) {
  const d = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=5m&range=5d`);
  return parseChart(d).candles;
}

// 日线数据(用于「天」时段): interval=1d + 大 range 拿长期历史
async function fetchDaily(code, range = '1y') {
  const d = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=1d&range=${range}`);
  const r = d.chart.result[0];
  const ts = r.timestamp || [];
  const vol = r.indicators?.quote?.[0]?.volume || [];
  const out = [];
  const n = Math.min(ts.length, vol.length);
  for (let i = 0; i < n; i++) {
    const v = vol[i];
    if (v != null && v > 0) out.push([mytDate(ts[i]), v]);
  }
  return out;
}

// ---------------- TradingView scanner 数据源(全市场, 免费无 key) ----------------
const TV_COLUMNS = 'name,description,open,close,volume,change,change_abs,average_volume_10d_calc,average_volume_30d_calc';

async function tvScan(range) {
  const res = await fetch('https://scanner.tradingview.com/malaysia/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({
      columns: TV_COLUMNS.split(','),
      filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }],
      range, sort: { sortBy: 'volume', sortOrder: 'desc' },
    }),
  });
  if (!res.ok) throw new Error(`TV HTTP ${res.status}`);
  return res.json();
}

// 一次拿全市场(约1130只)快照
async function fetchMarket() {
  const out = [];
  for (let start = 0; start < 5000; start += 500) {
    const d = await tvScan([start, start + 500]);
    const data = d.data || [];
    for (const row of data) {
      const [ticker, name, open, close, volume, changePct, changeAbs, avg10d, avg30d] = row.d;
      if (!ticker || close == null) continue;
      out.push({
        ticker, name,
        price: close, open, volume,
        change_pct: changePct, change_abs: changeAbs,
        prevClose: (close != null && changeAbs != null) ? close - changeAbs : null,
        avg10d, avg30d,
      });
    }
    if (data.length < 500) break;
  }
  return out;
}

function storeUniverse(quotes) {
  const stmt = db.prepare('INSERT INTO universe(stock, name) VALUES(?,?) ON CONFLICT(stock) DO UPDATE SET name=excluded.name');
  for (const q of quotes) stmt.run(q.ticker, q.name);
}

function updateQuote(q) {
  db.prepare(`INSERT INTO live(stock, name, price, prevClose, open, volume, avg10d, avg30d, mtime) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(stock) DO UPDATE SET name=excluded.name, price=excluded.price, prevClose=excluded.prevClose, open=excluded.open, volume=excluded.volume, avg10d=excluded.avg10d, avg30d=excluded.avg30d, mtime=excluded.mtime`)
    .run(q.ticker, q.name, q.price, q.prevClose, q.open, q.volume, q.avg10d, q.avg30d, Date.now() / 1000);
}

// 记录今日累计量快照(用于时段对比差值法)
function recordVolume(code, cumVolume) {
  if (cumVolume == null) return;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT OR REPLACE INTO volume_ts(stock, ts, cum_volume) VALUES(?,?,?)').run(code, ts, cumVolume);
}

// 记录每日总量(用于自己算4周/5天均量; 收盘后=最终总量)
function recordDailyVolume(code, volume) {
  if (volume == null) return;
  const date = mytDate(Date.now() / 1000);
  db.prepare('INSERT INTO daily_vol(stock, date, volume) VALUES(?,?,?) ON CONFLICT(stock, date) DO UPDATE SET volume=excluded.volume').run(code, date, volume);
}

// 字母 ticker → 数字代码 (Yahoo search, 用于日线历史)
// 短 ticker(如 QL/G3/NEXG)直接搜会被外国股票淹没, 所以搜不到时改用「公司名」再搜一次
async function mapCodeToNumeric(ticker, desc) {
  const trySearch = async (q) => {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) return null;
      const d = await res.json();
      const hit = (d.quotes || []).find((x) => x.symbol && x.symbol.endsWith('.KL') && (x.shortname || '').toUpperCase() === ticker.toUpperCase());
      return hit ? hit.symbol.replace('.KL', '') : null;
    } catch { return null; }
  };
  let c = await trySearch(ticker);
  if (c || !desc) return c;
  // 用公司名前两个词再试 (e.g. 'QL Resources Bhd.' → 'QL Resources')
  const short = String(desc).replace(/\b(Bhd|Berhad|BHD|SDN|Sdn)\.?/gi, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
  if (short && short.toUpperCase() !== ticker.toUpperCase()) {
    c = await trySearch(short);
    if (c) return c;
  }
  c = await trySearch(desc);
  return c;
}

// 回填每日量历史(Yahoo 日线 API 直接拿, 不用自己记录快照): 供「昨日量」对比 + 4W/5D均量
async function backfillDailyVol() {
  // 1. 先给没映射的股票补「字母→数字」映射
  const unmapped = db.prepare('SELECT stock, name FROM universe WHERE code IS NULL').all();
  if (unmapped.length) {
    log(`映射 ${unmapped.length} 只股票的数字代码(Yahoo search)...`);
    for (const u of unmapped) {
      const c = await mapCodeToNumeric(u.stock, u.name);
      if (c) db.prepare('UPDATE universe SET code=? WHERE stock=?').run(c, u.stock);
      await sleep(250);
    }
  }
  // 2. 回填日线历史到 daily_vol
  const rows = db.prepare('SELECT stock, code FROM universe WHERE code IS NOT NULL').all();
  log(`回填 ${rows.length} 只股票日线历史(Yahoo)...`);
  let done = 0;
  for (const u of rows) {
    try {
      const d = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${u.code}.KL?interval=1d&range=3mo`);
      const r = d.chart.result[0];
      const ts = r.timestamp || [];
      const vol = r.indicators?.quote?.[0]?.volume || [];
      const n = Math.min(ts.length, vol.length);
      for (let i = 0; i < n; i++) {
        if (vol[i] != null && vol[i] > 0) {
          db.prepare('INSERT INTO daily_vol(stock, date, volume) VALUES(?,?,?) ON CONFLICT(stock, date) DO UPDATE SET volume=excluded.volume')
            .run(u.stock, mytDate(ts[i]), vol[i]);
        }
      }
      done++;
    } catch {}
    await sleep(300);
  }
  log(`日线回填完成 ${done}/${rows.length} 只`);
}

// 从 daily_vol 算 4W/5D 均量(同步, 回填后即有数据)
function getAvgVolumes(code) {
  const todayStr = mytDate(Date.now() / 1000);
  const d5 = db.prepare('SELECT AVG(volume) a FROM (SELECT volume FROM daily_vol WHERE stock=? AND date < ? ORDER BY date DESC LIMIT 5)').get(code, todayStr);
  const d20 = db.prepare('SELECT AVG(volume) a FROM (SELECT volume FROM daily_vol WHERE stock=? AND date < ? ORDER BY date DESC LIMIT 20)').get(code, todayStr);
  return { avg4w: d20?.a ?? null, avg5d: d5?.a ?? null };
}

// ---------------- 成交量计算 ----------------
function mytDate(tsSec) {  // 马来西亚时区(UTC+8)的日期字符串
  return new Date(tsSec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 解析时段: '10m' | '2h' | '3d' → { value, unit }  (m=分钟 h=小时 d=天)
function parseWindow(window) {
  const m = /^(\d{1,4})([mhd])$/.exec(String(window));
  if (!m) return null;
  const value = parseInt(m[1], 10);
  if (value <= 0) return null;
  return { value, unit: m[2] };
}

// 盘中时段对比: 用 volume_ts 累计量差值(当前时段 vs 上一时段)
function cumAt(code, targetTs) {
  const r = db.prepare('SELECT cum_volume FROM volume_ts WHERE stock=? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(code, targetTs);
  return r ? r.cum_volume : null;
}
function computeVolumes(code, window) {
  const pw = parseWindow(window);
  if (!pw) return null;
  if (pw.unit === 'd') {
    // 日线对比: 「最近 N 天」vs「前 N 天」(N = window 的天数, 不 hard code)
    //   N=1 → 今日 vs 昨日       N=2 → (今日+昨日) vs (前天+大前天)
    const N = pw.value;
    const todayStr = mytDate(Date.now() / 1000);
    const live = db.prepare('SELECT volume FROM live WHERE stock=?').get(code);
    if (!live || !live.volume) return null;
    const rows = db.prepare('SELECT volume FROM daily_vol WHERE stock=? AND date < ? ORDER BY date DESC LIMIT ?')
      .all(code, todayStr, 2 * N - 1);
    if (rows.length < 2 * N - 1) return null;  // 历史不够(冷启动)
    const sum = (a) => a.reduce((s, r) => s + (r.volume || 0), 0);
    const current = live.volume + sum(rows.slice(0, N - 1));   // 今天 + 前 N-1 天
    const previous = sum(rows.slice(N - 1, 2 * N - 1));        // 再往前 N 天
    if (current <= 0 || previous <= 0) return null;
    return { current, previous };
  }
  // 天内时段对比: volume_ts 累计量差值(同一天内累计单调递增)
  const minutes = pw.unit === 'h' ? pw.value * 60 : pw.value;
  const wSec = minutes * 60;
  const now = Math.floor(Date.now() / 1000);
  const cNow = cumAt(code, now);
  const cPrev = cumAt(code, now - wSec);
  const cPrev2 = cumAt(code, now - 2 * wSec);
  if (cNow == null || cPrev == null || cPrev2 == null) return null;
  const current = cNow - cPrev;
  const previous = cPrev - cPrev2;
  if (current <= 0 || previous <= 0) return null;
  return { current, previous };
}

// 今日成交量 vs 昨日成交量(日线数据)
function computeDaily(code) {
  const rows = db.prepare('SELECT volume FROM daily WHERE stock=? ORDER BY date DESC LIMIT 2').all(code);
  if (rows.length < 2) return null;
  return { today: rows[0].volume, yesterday: rows[1].volume };
}

function computeMetrics(cfg) {
  const out = [];
  const universe = db.prepare('SELECT stock, name FROM universe').all();
  for (const w of universe) {
    const code = w.stock;
    const live = db.prepare('SELECT name, price, open, prevClose, volume, mtime FROM live WHERE stock=?').get(code);
    if (!live) continue;
    const vol = computeVolumes(code, cfg.window);
    let current = null, previous = null, ratio = null, status = 'nodata';
    if (vol) {
      current = vol.current; previous = vol.previous;
      if (previous > 0) {
        ratio = current / previous * 100;
        const threshold = getThresholdForPrice(live.price, cfg.price_thresholds);
        status = (threshold != null && ratio >= threshold) ? 'alert' : 'ok';
      } else {
        status = 'low';
      }
    }
    const av = getAvgVolumes(code);
    out.push({ code, name: live.name || w.name || code, price: live.price, open: live.open, prevClose: live.prevClose,
      volume: live.volume, avg4w: av.avg4w, avg5d: av.avg5d, mtime: live.mtime,
      current, previous, ratio, status });
  }
  // 按增长倍率从大到小排列
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
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

async function sendTelegramText(text, cfg) {
  const token = (cfg.telegram_bot_token || '').trim();
  const chat = (cfg.telegram_chat_id || '').trim();
  if (!token || !chat) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    if (!res.ok) log(`telegram 失败: HTTP ${res.status}`);
    else log('telegram 已发送');
  } catch (e) { log(`telegram 失败: ${e.message}`); }
}

// ---------------- WhatsApp (Twilio) ----------------
// 马来西亚手机号 01xxxxxxxxx → +60xxxxxxxxx (国际格式); 无效返回 null
function toWhatsApp(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (/^01\d{8,9}$/.test(p)) return '+60' + p.slice(1);
  return null;
}

async function sendWhatsAppTemplate(to, contentSid, variables, cfg) {
  const sid = (cfg.twilio_sid || '').trim();
  const token = (cfg.twilio_auth_token || '').trim();
  const from = (cfg.twilio_from || '').trim();
  if (!sid || !token || !from || !to || !contentSid) return;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const body = new URLSearchParams({
    From: 'whatsapp:' + from.replace(/^whatsapp:/, ''),
    To: 'whatsapp:' + to.replace(/^whatsapp:/, ''),
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(variables),
  });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
      body: body.toString(),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      log(`whatsapp 失败(${to}): HTTP ${res.status} ${j.message || j.code || ''}`);
    } else {
      log(`whatsapp 已发送 → ${to}`);
    }
  } catch (e) { log(`whatsapp 失败(${to}): ${e.message}`); }
}

// 日线放量提醒: 今日成交量 >= 价位阈值 → Telegram 群 (开市时段, 每天每只最多一次)
// 按股价返回提醒阈值%; 无规则或价格不在段内返回 null(不通知)
function getThresholdForPrice(price, rules) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  for (const r of rules) {
    if (r.max == null || p <= r.max) return r.threshold;
  }
  return null;
}

// 盘中放量提醒: 当前时段量 vs 上一时段量达到阈值% → Telegram (边沿触发 + cooldown 去重)
async function evaluateAlerts(cfg) {
  if (!isMarketOpen()) return;
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
  const window = cfg.window;
  const nowS = Math.floor(Date.now() / 1000);
  const cooldown = Math.max(1, cfg.cooldown_minutes || 30) * 60;
  const fired = [];
  for (const m of computeMetrics(cfg)) {
    if (m.status !== 'alert') {
      db.prepare('INSERT INTO state(stock, above, last_alert) VALUES(?,0,0) ON CONFLICT(stock) DO UPDATE SET above=0').run(m.code);
      continue;
    }
    const st = db.prepare('SELECT above, last_alert FROM state WHERE stock=?').get(m.code);
    const wasAbove = st?.above || 0;
    let lastAlert = st?.last_alert || 0;
    let should = false;
    if (!wasAbove && (nowS - lastAlert) >= cooldown) { should = true; lastAlert = nowS; }
    db.prepare('INSERT INTO state(stock, above, last_alert) VALUES(?,1,?) ON CONFLICT(stock) DO UPDATE SET above=1, last_alert=excluded.last_alert').run(m.code, lastAlert);
    if (should) fired.push(m);
  }
  if (fired.length) {
    const lines = fired.slice(0, 30).map((m) => `• ${m.name} (${m.code}) 价 ${m.price ?? '-'} · 放量 ${m.ratio.toFixed(1)}%\n  今日 ${fmtNum(m.current)} vs 昨日 ${fmtNum(m.previous)} · 4W ${fmtNum(m.avg4w)} / 5D ${fmtNum(m.avg5d)}`);
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    const text = `📊 放量提醒 ${fired.length} 只\n\n${lines.join('\n\n')}${more}\n\n👉 https://www.synthe-fantasia.site`;
    sendTelegramText(text, cfg);
  }
}


// 股价暴跌提醒: 当日跌幅 top 30 里, 现价较昨收跌幅 >= 阈值% → Telegram 群 (开市时段, 每天每只最多一次)
async function evaluatePriceDrop(cfg) {
  if (!isMarketOpen()) return;
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
  const threshold = Number(cfg.price_drop_threshold ?? 40);
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  // 只限「当日跌幅 top 30 losers」(口径同 pickastock 的 Loss% 榜: 按跌幅%降序)
  const universe = db.prepare(`SELECT stock, name, price, prevClose, (prevClose - price) * 100.0 / prevClose AS drop_pct
    FROM live WHERE price IS NOT NULL AND prevClose IS NOT NULL AND prevClose > 0
    ORDER BY drop_pct DESC LIMIT 30`).all();
  const fired = [];
  for (const l of universe) {
    const drop = l.drop_pct;
    if (drop < threshold) continue;
    const sent = db.prepare('SELECT 1 FROM price_drop_alert WHERE stock=? AND date=?').get(l.stock, date);
    if (sent) continue;
    db.prepare('INSERT INTO price_drop_alert(stock, date, ts) VALUES(?,?,?) ON CONFLICT(stock, date) DO NOTHING')
      .run(l.stock, date, nowS);
    const av = getAvgVolumes(l.stock);
    fired.push({ name: l.name || l.stock, stock: l.stock, price: l.price, prevClose: l.prevClose, drop, avg4w: av.avg4w, avg5d: av.avg5d });
  }
  if (fired.length) {
    const lines = fired.slice(0, 30).map((x) => `• ${x.name} (${x.stock}) 现价 ${x.price} · 跌 ${x.drop.toFixed(1)}%\n  昨收 ${x.prevClose} · 4W ${fmtNum(x.avg4w)} / 5D ${fmtNum(x.avg5d)}`);
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    const text = `🔴 暴跌提醒 ${fired.length} 只\n\n${lines.join('\n\n')}${more}\n\n👉 https://www.synthe-fantasia.site`;
    sendTelegramText(text, cfg);
  }
}

// 开盘急涨提醒: 现价较开盘涨幅 >= 阈值% → Telegram 群 (开市时段, 每天每只最多一次)
async function evaluateGapUp(cfg) {
  if (!isMarketOpen()) return;
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
  const threshold = Number(cfg.gap_up_threshold ?? 7);
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  // 只限「当日成交量 top 30」(口径同 pickastock 榜单: 今日成交量降序)
  const universe = db.prepare('SELECT stock, name, price, open FROM live WHERE volume IS NOT NULL ORDER BY volume DESC LIMIT 30').all();
  const fired = [];
  for (const l of universe) {
    if (l.price == null || l.open == null || l.open <= 0) continue;
    const gain = (l.price - l.open) / l.open * 100;
    if (gain < threshold) continue;
    const sent = db.prepare('SELECT 1 FROM gap_up_alert WHERE stock=? AND date=?').get(l.stock, date);
    if (sent) continue;
    db.prepare('INSERT INTO gap_up_alert(stock, date, ts) VALUES(?,?,?) ON CONFLICT(stock, date) DO NOTHING')
      .run(l.stock, date, nowS);
    const av = getAvgVolumes(l.stock);
    fired.push({ name: l.name || l.stock, stock: l.stock, price: l.price, open: l.open, gain, avg4w: av.avg4w, avg5d: av.avg5d });
  }
  if (fired.length) {
    const lines = fired.slice(0, 30).map((x) => `• ${x.name} (${x.stock}) 现价 ${x.price} · 涨 ${x.gain.toFixed(1)}%\n  开盘 ${x.open} · 4W ${fmtNum(x.avg4w)} / 5D ${fmtNum(x.avg5d)}`);
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    const text = `🟢 急涨提醒 ${fired.length} 只\n\n${lines.join('\n\n')}${more}\n\n👉 https://www.synthe-fantasia.site`;
    sendTelegramText(text, cfg);
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
  if (pollPromise) return pollPromise;  // 复用进行中的抓取
  pollPromise = (async () => {
    try {
      const cfg = loadConfig();
      const quotes = await fetchMarket();
      storeUniverse(quotes);
      for (const q of quotes) {
        updateQuote(q);
        recordVolume(q.ticker, q.volume);
        // 注意: 不再调用 recordDailyVolume —— 它写的是「盘中某刻的累计量」而非收盘总量,
        // 会污染 daily_vol 的昨日量(导致放量对比失真)。daily_vol 只由 Yahoo 回填(backfillDailyVol)写入。
      }
      const cnt = db.prepare('SELECT COUNT(*) c FROM universe').get().c;
      await evaluateAlerts(cfg);
      await evaluatePriceDrop(cfg);
      await evaluateGapUp(cfg);
      prune();
      lastPoll = Date.now() / 1000;
      log(`全市场抓取完成 (${cnt} 只)`);
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
  const interval = Math.max(1, cfg.poll_interval_minutes || 5) * 60;
  if (lastPoll && (Date.now() / 1000 - lastPoll) < interval) return;
  if (!isMarketOpen() && lastPoll) return;  // 休市且已抓过, 不重复抓
  await poll();
}

// 后台定时抓取(开市时段): 无人值守也能自动追踪 + 提醒
let pollTimer = null;
let lastBackfillDate = null;
function maybeBackfill() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);  // UTC+8
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);
  if (hm >= 17 * 60 && lastBackfillDate !== dateStr) {  // 每天 17:00(收盘后)回填昨日量
    lastBackfillDate = dateStr;
    backfillDailyVol();
  }
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (isMarketOpen()) maybePoll();  // 内部有节流, 数据陈旧才真抓
    maybeBackfill();                  // 收盘后回填昨日量
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
  const universeCount = db.prepare('SELECT COUNT(*) c FROM universe').get().c;
  return {
    version: VERSION,
    universe_count: universeCount,
    settings: {
      poll_interval_minutes: cfg.poll_interval_minutes,
      window: cfg.window,
      price_drop_threshold: cfg.price_drop_threshold,
      gap_up_threshold: cfg.gap_up_threshold ?? 7,
    },
    watchlist: cfg.watchlist,
    whatsapp_recipients: cfg.whatsapp_recipients || [],
    price_thresholds: cfg.price_thresholds || [],
    stocks: computeMetrics(cfg),
    alerts: [],
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

app.get('/healthz', (req, res) => res.json({ ok: true }));

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

// 手动触发 Yahoo 日线回填(修正 daily_vol 的昨日量)
app.post('/api/backfill', async (req, res) => {
  res.json({ ok: true, msg: '回填已启动, 约需 3-10 分钟, 完成后自动刷新' });
  try { await backfillDailyVol(); broadcast(); } catch (e) { log('手动回填失败: ' + e.message); }
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
  if (!/^[A-Z0-9][A-Z0-9-]{1,14}$/.test(code)) {
    return res.status(400).json({ error: '股票代码格式不对 (字母 ticker, 如 MAYBANK)' });
  }
  const cfg = loadConfig();
  if (cfg.watchlist.some((w) => w.code === code)) return res.json({ ok: true, dup: true });
  cfg.watchlist.push({ code, name: code });
  saveConfig(cfg);
  broadcast();
  res.json({ ok: true, name: code });
});

app.post('/api/watchlist/remove', (req, res) => {
  const code = String(req.body.code || '').trim();
  const cfg = loadConfig();
  cfg.watchlist = cfg.watchlist.filter((w) => w.code !== code);
  saveConfig(cfg);
  db.prepare('DELETE FROM volume_ts WHERE stock=?').run(code);
  db.prepare('DELETE FROM state WHERE stock=?').run(code);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/poll', (req, res) => {
  poll();  // fire-and-forget
  res.json({ ok: true });
});

app.post('/api/test-telegram', async (req, res) => {
  const cfg = loadConfig();
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) {
    return res.status(400).json({ error: '未配置 Telegram Bot Token / Chat ID' });
  }
  await sendTelegramText('✅ KLSE Volume Tracker 测试 — Telegram 通知已接通', cfg);
  res.json({ ok: true });
});

app.post('/api/recipients/add', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  if (!/^01\d{8,9}$/.test(phone)) {
    return res.status(400).json({ error: '马来西亚手机号格式不对 (01 开头, 10-11 位)' });
  }
  const cfg = loadConfig();
  if (!Array.isArray(cfg.whatsapp_recipients)) cfg.whatsapp_recipients = [];
  if (cfg.whatsapp_recipients.includes(phone)) return res.json({ ok: true, dup: true });
  cfg.whatsapp_recipients.push(phone);
  saveConfig(cfg);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/recipients/remove', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const cfg = loadConfig();
  cfg.whatsapp_recipients = (cfg.whatsapp_recipients || []).filter((p) => p !== phone);
  saveConfig(cfg);
  broadcast();
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
poll();          // 启动时立即抓全市场
startPolling();  // 开市时段后台定时抓取(无人值守追踪)
// 后台: 回填每日量历史(Yahoo日线), 供放量「昨日量」对比 + 4W/5D均量
(async () => {
  await sleep(5000);
  await backfillDailyVol();
  broadcast();
})();

