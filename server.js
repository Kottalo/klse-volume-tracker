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
  gap_up_threshold: 5,       // 急涨区间下限% (相对开盘)
  gap_up_threshold_high: 7,  // 急涨区间上限% (只推这个区间内的)
  price_drop_threshold_high: 50,  // 暴跌区间上限%(相对开盘)
  // ---- 双底(W底/N字底)识别参数 ----
  db_min_score: 70,   // 评分门槛(0~100), 越高越严、通知越少
  db_tol: 5,          // 两个低点价格相差容忍 %
  db_min_gap: 15,     // 两底最少间隔(交易日)
  db_max_gap: 80,     // 两底最多间隔
  db_min_neck: 5,     // 颈线相对低点至少高 %
  db_fresh: 2,        // 突破必须发生在最近 N 个交易日内(越小越新鲜、越接近买点)
  db_min_rr: 1.0,     // 最小盈亏比(低于此值不通知, 1.0 = 赚的空间至少是亏的1倍)
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
  CREATE TABLE IF NOT EXISTS db_bottom_alert(
  key TEXT PRIMARY KEY, stock TEXT, date TEXT, ts INTEGER);
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
// 迁移: daily_vol 补 OHLC 列(双底/N字底形态识别需要)
try { db.exec('ALTER TABLE daily_vol ADD COLUMN open REAL'); } catch (e) {}
try { db.exec('ALTER TABLE daily_vol ADD COLUMN high REAL'); } catch (e) {}
try { db.exec('ALTER TABLE daily_vol ADD COLUMN low REAL'); } catch (e) {}
try { db.exec('ALTER TABLE daily_vol ADD COLUMN close REAL'); } catch (e) {}

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

// pickastock 榜单(候选池): type=0 成交量榜 / type=5 跌幅%榜
// 失败时返回 null, 调用方回退到用我们自己的数据算 top30
async function fetchPickTop(type) {
  try {
    const res = await fetch(`https://app.pickastock.info/api/Top10?type=${type}&top=30&isSyariah=false&excludeWarrant=true&period=0`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.pickastock.info/top10' },
    });
    if (!res.ok) return null;
    const d = await res.json();
    const n = Object.keys(d).filter((k) => /^s\d+$/.test(k)).length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const code = d[`s${i}`], price = d[`c${i}`], ref = d[`r${i}`], vol = d[`v${i}`];
      if (!code || ref == null || ref <= 0) continue;
      out.push({ code, price, ref, volume: vol, pct: (price - ref) / ref * 100 });  // pct = 相对开盘涨跌%
    }
    return out.length ? out : null;
  } catch { return null; }
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
      const d = await yahooGet(`https://query1.finance.yahoo.com/v8/finance/chart/${u.code}.KL?interval=1d&range=6mo`);
      const r = d.chart.result[0];
      const ts = r.timestamp || [];
      const q = r.indicators?.quote?.[0] || {};
      const vol = q.volume || [], oArr = q.open || [], hArr = q.high || [], lArr = q.low || [], cArr = q.close || [];
      const n = Math.min(ts.length, vol.length);
      for (let i = 0; i < n; i++) {
        if (vol[i] != null && vol[i] > 0) {
          db.prepare(`INSERT INTO daily_vol(stock, date, volume, open, high, low, close) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(stock, date) DO UPDATE SET volume=excluded.volume, open=excluded.open,
              high=excluded.high, low=excluded.low, close=excluded.close`)
            .run(u.stock, mytDate(ts[i]), vol[i], oArr[i] ?? null, hArr[i] ?? null, lArr[i] ?? null, cArr[i] ?? null);
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
    const rows = db.prepare('SELECT date, volume FROM daily_vol WHERE stock=? AND date < ? ORDER BY date DESC LIMIT ?')
      .all(code, todayStr, 2 * N - 1);
    if (rows.length < 2 * N - 1) return null;  // 历史不够(冷启动)
    const sum = (a) => a.reduce((s, r) => s + (r.volume || 0), 0);
    const current = live.volume + sum(rows.slice(0, N - 1));   // 今天 + 前 N-1 天
    const previous = sum(rows.slice(N - 1, 2 * N - 1));        // 再往前 N 天
    if (current <= 0 || previous <= 0) return null;
    // 日期标签: 单日就写日期, 多日写「起 ~ 止」
    const rng = (arr) => (arr.length <= 1 ? (arr[0] || '') : `${arr[0]} ~ ${arr[arr.length - 1]}`);
    const curDates = [todayStr, ...rows.slice(0, N - 1).map((r) => r.date)].sort();
    const prevDates = rows.slice(N - 1, 2 * N - 1).map((r) => r.date).sort();
    return { current, previous, curLabel: rng(curDates), prevLabel: rng(prevDates) };
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
  const hm = (ts) => { const d = new Date((ts + 8 * 3600) * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  return {
    current, previous,
    curLabel: `${hm(now - wSec)}~${hm(now)}`,
    prevLabel: `${hm(now - 2 * wSec)}~${hm(now - wSec)}`,
  };
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
      current, previous, ratio, status,
      curLabel: vol ? vol.curLabel : null, prevLabel: vol ? vol.prevLabel : null });
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

// ---------------- 广播队列: 一轮轮询内收集所有信号, 合并成一条发出 ----------------
let bcastQueue = [];

function pushBroadcast(icon, title, body, count) {
  bcastQueue.push({ icon, title, body, count });
}

async function flushBroadcast(cfg) {
  if (!bcastQueue.length) return;                    // 没有任何信号 -> 静默, 不推空消息
  const date = mytDate(Date.now() / 1000);
  const total = bcastQueue.reduce((s, x) => s + x.count, 0);
  // 买入信号优先展示 (先排序, 再拼装)
  const order = { '🎯': 0, '🟢': 1, '🔴': 2, '📊': 3 };
  bcastQueue.sort((a, b) => (order[a.icon] ?? 9) - (order[b.icon] ?? 9));
  const parts = bcastQueue.map((s) => `${s.icon} ${s.title} · ${s.count} 只\n${s.body}`);
  const text = `📡 KLSE 盘面广播 · ${date}\n共 ${total} 条信号\n\n${parts.join('\n\n')}\n\n👉 https://www.synthe-fantasia.site`;
  bcastQueue = [];
  await sendTelegramText(text, cfg);
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
    const lines = fired.slice(0, 30).map((m) => `• ${m.name} (${m.code}) 价 ${m.price ?? '-'} · 放量 ${m.ratio.toFixed(1)}%\n  ${m.curLabel} ${fmtNum(m.current)} vs ${m.prevLabel} ${fmtNum(m.previous)} · 4W ${fmtNum(m.avg4w)} / 5D ${fmtNum(m.avg5d)}`);
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    pushBroadcast('📊', '放量异动', lines.slice(0, 12).join('\n\n'), fired.length);
  }
}



// ---------------- 双底(W底/N字底)形态识别 ----------------
// 结构: A(低点1) → B(颈线, A~C之间最高) → C(低点2, 不深破A) → 突破B = 买点
// 参考经典 W 底定义(Bulkowski) + 突破放量确认 + 峰谷宽度/高度约束(李进财N字理论)
function findDoubleBottom(code, cfg) {
  const rows = db.prepare(`SELECT date, open, high, low, close, volume FROM daily_vol
    WHERE stock=? AND low IS NOT NULL AND high IS NOT NULL AND close IS NOT NULL
    ORDER BY date ASC`).all(code);
  if (rows.length < 45) return null;

  const k = 3;                                                        // 摆动点判定窗口(左右各3根)
  const tolPct = Number(cfg.db_tol ?? 5);                             // 两底价格相近容忍 %
  const minGap = Number(cfg.db_min_gap ?? 15);                        // 两底最少间隔(交易日)
  const maxGap = Number(cfg.db_max_gap ?? 80);                        // 最多间隔
  const minNeck = Number(cfg.db_min_neck ?? 5);                       // 颈线相对低点至少高 %
  const freshDays = Number(cfg.db_fresh ?? 5);                        // 突破要在最近 N 天内

  // 1. 找摆动低点/高点(局部极值)
  const lows = [];
  for (let i = k; i < rows.length - k; i++) {
    const w = rows.slice(i - k, i + k + 1);
    if (rows[i].low === Math.min(...w.map((x) => x.low))) lows.push({ i, p: rows[i].low, d: rows[i].date });
  }
  if (lows.length < 2) return null;

  const last = rows.length - 1;

  // 2. 从最近的摆动低点开始配对(C = 较近的低点)
  for (let ci = lows.length - 1; ci >= 1; ci--) {
    const C = lows[ci];
    if (last - C.i > maxGap) break;                                   // C 太老就不必再往前
    for (let ai = ci - 1; ai >= 0; ai--) {
      const A = lows[ai];
      const gap = C.i - A.i;
      if (gap < minGap) continue;
      if (gap > maxGap) break;
      const diffPct = Math.abs(C.p - A.p) / A.p * 100;                // 两底价差
      if (diffPct > tolPct) continue;
      // 颈线 B = A、C 之间的最高点
      const between = rows.slice(A.i + 1, C.i);
      if (!between.length) continue;
      const B = between.reduce((mx, x) => (x.high > mx.high ? x : mx), between[0]);
      const base = Math.min(A.p, C.p);
      const neckUp = (B.high - base) / base * 100;
      if (neckUp < minNeck) continue;
      // 突破: C 之后出现收盘价站上颈线
      const after = rows.slice(C.i + 1);
      const bIdx = after.findIndex((x) => x.close > B.high * 1.005);
      if (bIdx < 0) continue;
      const barsSince = after.length - 1 - bIdx;
      if (barsSince > freshDays) continue;                            // 只要新鲜突破
      // 关键: 现价必须仍站在颈线上方, 否则就是「突破后回落」的假信号
      const nowClose = rows[rows.length - 1].close;
      if (nowClose < B.high) continue;

      // 3. 评分(0~100) —— 容错靠这里
      const brk = after[bIdx];
      const pre = rows.slice(Math.max(0, C.i + 1 + bIdx - 5), C.i + 1 + bIdx);
      const avg5 = pre.length ? pre.reduce((s, x) => s + (x.volume || 0), 0) / pre.length : 0;
      const vr = avg5 > 0 ? (brk.volume || 0) / avg5 : 0;             // 突破放量倍数
      const brkPct = (today_close_last(rows) - B.high) / B.high * 100; // 现价超出颈线 %

      let score = 0;
      score += 30 * Math.max(0, 1 - diffPct / tolPct);                // 两底越接近越好 (30)
      score += 20 * Math.min(1, neckUp / 15);                         // 颈线越高越好 (20)
      score += 15 * (gap >= 20 && gap <= 60 ? 1 : Math.max(0, 1 - Math.abs(gap - 40) / 40)); // 间隔合理 (15)
      score += 25 * Math.min(1, vr / 1.5);                            // 突破放量 (25)
      score += 10 * Math.min(1, Math.max(0, brkPct) / 3);             // 突破幅度 (10)
      score = Math.round(score);

      const hgt = B.high - base;                                      // 形态高度
      // 止损: 形态低点下方2% 与 颈线下方3% 取更近者(实盘用颈部破位止损更好执行)
      const stop = Math.max(base * 0.98, B.high * 0.97);
      // 量度目标: 颈线 + 形态高度; 若已被越过则从现价再延伸一个形态高度
      let target1 = B.high + hgt;
      if (target1 <= rows[last].close) target1 = rows[last].close + hgt;
      return {
        A, B, C, breakDate: brk.date, breakClose: brk.close,
        price: rows[last].close, neck: B.high, score,
        diffPct, gap, neckUp, vr, brkPct, stop, target1,
        barsSince,
      };
    }
  }
  return null;
}
function today_close_last(rows) { return rows[rows.length - 1].close; }

// 双底突破通知: 只在开市时段, 每只股票每个颈线只报一次
async function evaluateDoubleBottom(cfg) {
  if (!isMarketOpen()) return;
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
  const minScore = Number(cfg.db_min_score ?? 70);
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  const list = db.prepare('SELECT stock FROM universe WHERE code IS NOT NULL').all();
  const fired = [];
  for (const r of list) {
    let pat;
    try { pat = findDoubleBottom(r.stock, cfg); } catch { pat = null; }
    if (!pat || pat.score < minScore) continue;
    const rr = pat.price > pat.stop ? ((pat.target1 - pat.price) / (pat.price - pat.stop)) : 0;
    if (rr < Number(cfg.db_min_rr ?? 1.0)) continue;      // 盈亏比不达标不推
    const key = `${r.stock}|${pat.neck.toFixed(3)}|${pat.breakDate}`;
    if (db.prepare('SELECT 1 FROM db_bottom_alert WHERE key=?').get(key)) continue;
    db.prepare('INSERT INTO db_bottom_alert(key, stock, date, ts) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING')
      .run(key, r.stock, date, nowS);
    const nm = db.prepare('SELECT name FROM live WHERE stock=?').get(r.stock)?.name
      || db.prepare('SELECT name FROM universe WHERE stock=?').get(r.stock)?.name;
    fired.push({ ...pat, code: r.stock, name: nm || r.stock });
  }
  if (fired.length) {
    fired.sort((a, b) => b.score - a.score);
    const blocks = fired.slice(0, 15).map((x) => {
      const risk = (x.price - x.stop) / x.price * 100;                 // 到止损的空间
      const rew = (x.target1 - x.price) / x.price * 100;               // 到目标的空门
      const rr = risk > 0 ? (rew / risk) : 0;                          // 盈亏比
      const when = x.barsSince === 0 ? '今天刚突破' : `${x.barsSince} 天前突破`;
      return [
        `• ${x.name} (${x.code})  评分 ${x.score}/100   [${when}]`,
        `  两底    ${x.A.p.toFixed(3)} (${x.A.d}) / ${x.C.p.toFixed(3)} (${x.C.d})   相差 ${x.diffPct.toFixed(1)}%`,
        `  颈线    ${x.neck.toFixed(3)}  →  现价 ${x.price}  (已突破 +${x.brkPct.toFixed(1)}%)`,
        `  买入区  ${x.neck.toFixed(3)} ~ ${(x.neck * 1.03).toFixed(3)}`,
        `  止损    ${x.stop.toFixed(3)}   (-${risk.toFixed(1)}%)`,
        `  目标    ${x.target1.toFixed(3)}   (+${rew.toFixed(1)}%)   盈亏比 ${rr.toFixed(2)}`,
        `  突破量  ${x.vr.toFixed(1)}x 5日均量 · 形态跨度 ${x.gap} 个交易日`,
      ].join('\n');
    });
    const more = fired.length > 15 ? `\n\n…等共 ${fired.length} 只` : '';
    pushBroadcast('🎯', '双底突破 · 买入信号', blocks.slice(0, 6).join('\n\n'), fired.length);
  }
}

// 股价暴跌提醒: 当日跌幅 top 30 里, 现价较昨收跌幅 >= 阈值% → Telegram 群 (开市时段, 每天每只最多一次)
async function evaluatePriceDrop(cfg) {
  if (!isMarketOpen()) return;
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
  const lo = Number(cfg.price_drop_threshold ?? 40);           // 区间下限
  const hi = Number(cfg.price_drop_threshold_high ?? 50);      // 区间上限
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  // 候选池 = pickastock 的 Loss% 榜 top30 (拿不到就退回用自己数据按跌幅排序)
  let pool = await fetchPickTop(5);
  if (!pool) {
    pool = db.prepare(`SELECT stock AS code, price, open AS ref, volume,
        (price - open) * 100.0 / open AS pct
      FROM live WHERE price IS NOT NULL AND open IS NOT NULL AND open > 0
      ORDER BY pct ASC LIMIT 30`).all();
  }
  const fired = [];
  for (const l of pool) {
    const drop = -(l.pct);                    // 取正数跌幅
    if (drop < lo || drop > hi) continue;     // 只推 [下限, 上限] 区间内
    const nm = db.prepare('SELECT name FROM live WHERE stock=?').get(l.code)?.name
      || db.prepare('SELECT name FROM universe WHERE stock=?').get(l.code)?.name;
    const sent = db.prepare('SELECT 1 FROM price_drop_alert WHERE stock=? AND date=?').get(l.code, date);
    if (sent) continue;
    db.prepare('INSERT INTO price_drop_alert(stock, date, ts) VALUES(?,?,?) ON CONFLICT(stock, date) DO NOTHING')
      .run(l.code, date, nowS);
    const av = getAvgVolumes(l.code);
    fired.push({ name: nm || l.code, stock: l.code, price: l.price, ref: l.ref, drop, avg4w: av.avg4w, avg5d: av.avg5d });
  }
  if (fired.length) {
    const lines = fired.slice(0, 30).map((x) => `• ${x.name} (${x.stock}) 现价 ${x.price} · 跌 ${x.drop.toFixed(1)}%\n  开盘 ${x.ref} · 4W ${fmtNum(x.avg4w)} / 5D ${fmtNum(x.avg5d)}`);
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    pushBroadcast('🔴', '暴跌异动', lines.slice(0, 10).join('\n'), fired.length);
  }
}

// 开盘急涨提醒: pickastock 成交量榜 top30 里, 相对开盘涨幅落在 [下限, 上限] 区间 → Telegram 群
async function evaluateGapUp(cfg) {
  if (!isMarketOpen()) return;
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
  const lo = Number(cfg.gap_up_threshold ?? 5);           // 区间下限%
  const hi = Number(cfg.gap_up_threshold_high ?? 7);      // 区间上限%
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  // 候选池 = pickastock 的 Gain% 涨幅榜 top30 (拿不到就退回用自己数据按涨幅排序)
  let pool = await fetchPickTop(3);   // 候选池 = pickastock 涨幅榜(Gain%)
  if (!pool) {
    pool = db.prepare(`SELECT stock AS code, price, open AS ref, volume,
        CASE WHEN open > 0 THEN (price - open) * 100.0 / open ELSE NULL END AS pct
      FROM live WHERE open IS NOT NULL AND open > 0 ORDER BY pct DESC LIMIT 30`).all();
  }
  const fired = [];
  for (const l of pool) {
    if (l.pct == null) continue;
    const gain = l.pct;
    if (gain < lo || gain > hi) continue;     // 只推 [下限, 上限] 区间内
    const nm = db.prepare('SELECT name FROM live WHERE stock=?').get(l.code)?.name
      || db.prepare('SELECT name FROM universe WHERE stock=?').get(l.code)?.name;
    const sent = db.prepare('SELECT 1 FROM gap_up_alert WHERE stock=? AND date=?').get(l.code, date);
    if (sent) continue;
    db.prepare('INSERT INTO gap_up_alert(stock, date, ts) VALUES(?,?,?) ON CONFLICT(stock, date) DO NOTHING')
      .run(l.code, date, nowS);
    const av = getAvgVolumes(l.code);
    fired.push({ name: nm || l.code, stock: l.code, price: l.price, open: l.ref, gain, avg4w: av.avg4w, avg5d: av.avg5d });
  }
  if (fired.length) {
    const lines = fired.slice(0, 30).map((x) => `• ${x.name} (${x.stock}) 现价 ${x.price} · 涨 ${x.gain.toFixed(1)}%\n  开盘 ${x.open} · 4W ${fmtNum(x.avg4w)} / 5D ${fmtNum(x.avg5d)}`);
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    pushBroadcast('🟢', '急涨异动', lines.slice(0, 10).join('\n'), fired.length);
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
      await evaluateDoubleBottom(cfg);   // 双底突破买入信号
      await flushBroadcast(cfg);         // 把本轮所有信号合并成一条发出
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
      price_drop_threshold_high: cfg.price_drop_threshold_high ?? 50,
      gap_up_threshold: cfg.gap_up_threshold ?? 5,
      gap_up_threshold_high: cfg.gap_up_threshold_high ?? 7,
      db_min_score: cfg.db_min_score ?? 70,
      db_tol: cfg.db_tol ?? 5,
      db_fresh: cfg.db_fresh ?? 2,
      db_min_rr: cfg.db_min_rr ?? 1.0,
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

// 双底形态扫描(验证/调试用): /api/db-scan?min=70
app.get('/api/db-scan', (req, res) => {
  const cfg = loadConfig();
  const minScore = Number(req.query.min ?? cfg.db_min_score ?? 70);
  const list = db.prepare('SELECT stock FROM universe WHERE code IS NOT NULL').all();
  const out = [];
  let withOhlc = 0;
  for (const r of list) {
    try {
      const p = findDoubleBottom(r.stock, cfg);
      if (p) { withOhlc++; if (p.score >= minScore) out.push({ code: r.stock, ...p }); }
    } catch (e) {}
  }
  out.sort((a, b) => b.score - a.score);
  res.json({ scanned: list.length, matched: withOhlc, aboveThreshold: out.length, minScore, results: out.slice(0, 40) });
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

