// KLSE Volume Tracker — 马来西亚股票成交量异动追踪
// Node.js + Express + 内置 node:sqlite + SSE 推送
// 数据源: Yahoo Finance 免费盘中接口(无需 key)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  marketDate,
  sessionStart,
  compareSnapshots,
  trendMetrics,
  screenMatches,
  observationDays,
  explainStock,
  formatReport,
  isLunchBreak,
} from './lib/analysis.js';
import { validateSettings, parameterPatch, ValidationError } from './lib/settings.js';
import { protectApi } from './lib/security.js';
import {
  BRIEFING_SLOTS,
  HALF_HOUR_SLOTS,
  dueBriefingSlots,
  dueHalfHourSlots,
  finalCandidates,
  halfHourCandidates,
  conciseReason,
  formatBriefing,
  formatHalfHourBriefing,
  nextTradingDate,
  slotTimestamp,
  tradingDay,
} from './lib/briefings.js';

const IS_ENTRY =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_ENTRY) await import('dotenv/config');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname; // 持久化目录(Render 磁盘挂载点), 默认同代码目录
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DB_PATH = path.join(DATA_DIR, 'data.db');
const DIST = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 8080;
const VERSION = 'v2.5.1-unified-briefings';
let analysisCache = null;

const DEFAULTS = {
  poll_interval_minutes: 5, // 开市时段每 5 分钟轮询
  window: '1d', // 新用户默认比较本交易日与上一交易日成交量
  cooldown_minutes: 30, // 盘中提醒重复间隔(分)
  telegram_bot_token: '',
  telegram_chat_id: '',
  twilio_sid: '',
  twilio_auth_token: '',
  twilio_from: '',
  twilio_to: '',
  whatsapp_recipients: [],
  twilio_content_sid: '',
  price_thresholds: [], // 按股价范围设提醒阈值: [{max, threshold}], max=null=无限; 空=不通知
  price_drop_threshold: 40, // 股价较昨收跌幅 >= 此% 时提醒
  gap_up_threshold: 5, // 急涨区间下限% (相对开盘)
  gap_up_threshold_high: 7, // 急涨区间上限% (只推这个区间内的)
  price_drop_threshold_high: 50, // 暴跌区间上限%(相对开盘)
  // ---- 双底(W底/N字底)识别参数 ----
  db_min_score: 70, // 评分门槛(0~100), 越高越严、通知越少
  db_tol: 5, // 两个低点价格相差容忍 %
  db_min_gap: 15, // 两底最少间隔(交易日)
  db_max_gap: 80, // 两底最多间隔
  db_min_neck: 5, // 颈线相对低点至少高 %
  db_fresh: 2, // 突破必须发生在最近 N 个交易日内(越小越新鲜、越接近买点)
  db_min_rr: 1.0, // 最小盈亏比(低于此值不通知, 1.0 = 赚的空间至少是亏的1倍)
  llm_api_key: '', // DeepSeek API key(留空则只支持斜杠命令, 不支持自然语言)
  pick_count: 3, // 每日精选几只(宁少勿多, 别让用户被一堆票淹没)
  min_average_daily_value: 200000, // 最近20个完整交易日平均成交额估算下限(RM)
  final_briefing_on: true,
  half_hour_briefing_on: true,
  final_briefing_telegram: true,
  win_pct: 8, // 观察名单里涨到这个幅度算「应证」
  loss_pct: 5, // 跌到这个幅度算「证伪」
  watch_days: 15, // 观察多少天后没动静就归档
  // ---- 强势筛选(20日涨幅 / 放量 / 站上MA5 / 四线多头排列) ----
  // 口径: 放量=今日量÷昨日量; 站上MA5=收盘>MA5; 四线=只要 MA5>MA10>MA15>MA20 顺序
  screen_on: true, // 是否把筛选结果放进每日广播
  screen_min_gain: 15, // 20 交易日涨幅下限 %
  screen_max_gain: 25, // 20 交易日涨幅上限 %
  screen_vol_mult: 2, // 放量倍数(今日量 ÷ 昨日量)
  screen_min_volume: 1000000, // 精选成交量至少100万股
  screen_above_ma5: true, // 要求收盘站上 5 日均线
  screen_bullish: true, // 要求四线多头排列
  oanor_api_key: '', // oanor 备份数据源 key(可选)
  market_holidays: [], // 交易所休市日期 YYYY-MM-DD；常规时段不能自动识别节假日
};

const DEFAULT_WATCHLIST = [
  ['1155', 'Maybank'],
  ['1295', 'Public Bank'],
  ['1023', 'CIMB'],
  ['5347', 'Tenaga'],
  ['5183', 'Petronas Chemicals'],
  ['6033', 'Petronas Gas'],
  ['5681', 'Petronas Dagangan'],
  ['5225', 'IHH Healthcare'],
  ['6012', 'Maxis'],
  ['6888', 'Axiata'],
  ['6947', 'CelcomDigi'],
  ['3182', 'Genting'],
  ['4715', 'Genting Malaysia'],
  ['3816', 'MISC'],
  ['4197', 'Sime Darby'],
  ['5285', 'SD Guthrie'],
  ['2445', 'KLK'],
  ['1961', 'IOI Corp'],
  ['8869', 'Press Metal'],
  ['7084', 'QL Resources'],
  ['4707', 'Nestle Malaysia'],
  ['3034', 'Hap Seng'],
  ['5398', 'Gamuda'],
  ['3336', 'IJM'],
  ['5819', 'Hong Leong Bank'],
  ['1082', 'Hong Leong Financial'],
  ['1066', 'RHB Bank'],
  ['1015', 'AMMB'],
  ['4863', 'Telekom Malaysia'],
  ['5296', 'MR D.I.Y.'],
  ['7277', 'Dialog'],
  ['0166', 'Inari Amertron'],
  ['4677', 'YTL Corp'],
  ['6742', 'YTL Power'],
  ['5211', 'Sunway'],
  ['5246', 'Westports'],
  ['5168', 'Hartalega'],
  ['7113', 'Top Glove'],
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
  if (!Array.isArray(cfg.watchlist)) {
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
  if (process.env.LLM_API_KEY) cfg.llm_api_key = process.env.LLM_API_KEY;
  // Long legacy intervals can miss the entire early breakout window.
  cfg.poll_interval_minutes = Math.min(5, Math.max(1, Number(cfg.poll_interval_minutes) || 5));
  return cfg;
}

function saveConfig(cfg) {
  analysisCache = null;
  const temporary = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, CONFIG_PATH);
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
for (const [table, column, type] of [
  ['universe', 'active', 'INTEGER DEFAULT 1'],
  ['universe', 'last_seen', 'REAL'],
  ['universe', 'history_attempt', 'REAL'],
  ['universe', 'history_success', 'REAL'],
  ['universe', 'history_error', 'TEXT'],
  ['live', 'high', 'REAL'],
  ['live', 'low', 'REAL'],
]) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch {}
}
db.exec(`CREATE TABLE IF NOT EXISTS potential_events (
  stock TEXT, date TEXT, kind TEXT, first_seen REAL, last_seen REAL, signal TEXT,
  PRIMARY KEY(stock,date,kind));`);
// 迁移: 旧库 live 表补 prevClose / open 列
try {
  db.exec('ALTER TABLE live ADD COLUMN prevClose REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE live ADD COLUMN open REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE live ADD COLUMN volume INTEGER');
} catch (e) {}
try {
  db.exec('ALTER TABLE live ADD COLUMN avg10d REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE live ADD COLUMN avg30d REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE universe ADD COLUMN code TEXT');
} catch (e) {}
try {
  db.exec('ALTER TABLE live ADD COLUMN avg4w REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE live ADD COLUMN avg5d REAL');
} catch (e) {}
// 迁移: daily_vol 补 OHLC 列(双底/N字底形态识别需要)
// 通用键值表(存 telegram offset / bot 用户名等)
try {
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
} catch (e) {}

// 观察名单: 精选出来的股票持续跟踪, 用实际表现应证系统判断
try {
  db.exec(`CREATE TABLE IF NOT EXISTS watchlist (
  stock TEXT PRIMARY KEY, name TEXT, added_date TEXT, entry_price REAL,
  signal TEXT, score REAL, best_pct REAL, days INTEGER,
  outcome TEXT, note TEXT, resolved_date TEXT
)`);
} catch (e) {}
try {
  db.exec('ALTER TABLE daily_vol ADD COLUMN open REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE daily_vol ADD COLUMN high REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE daily_vol ADD COLUMN low REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE daily_vol ADD COLUMN close REAL');
} catch (e) {}
try {
  db.exec('ALTER TABLE live ADD COLUMN session_date TEXT');
} catch (e) {}
try {
  db.exec('ALTER TABLE alerts ADD COLUMN kind TEXT');
} catch (e) {}
try {
  db.exec('ALTER TABLE alerts ADD COLUMN message TEXT');
} catch (e) {}
try {
  db.exec('ALTER TABLE watchlist ADD COLUMN last_checked_date TEXT');
} catch (e) {}
db.exec(`CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, text TEXT, attempts INTEGER DEFAULT 0,
  sent_at INTEGER, last_error TEXT
);`);
db.exec(`CREATE TABLE IF NOT EXISTS closing_briefings (
  date TEXT,slot TEXT,created_at REAL,quote_at REAL,status TEXT,items TEXT,text TEXT,outbox_id INTEGER,
  minimum_multiple REAL DEFAULT 3,
  PRIMARY KEY(date,slot));`);
if (
  !db
    .prepare('PRAGMA table_info(closing_briefings)')
    .all()
    .some((c) => c.name === 'minimum_multiple')
)
  db.exec('ALTER TABLE closing_briefings ADD COLUMN minimum_multiple REAL DEFAULT 3');
for (const [table, column, type] of [
  ['closing_briefings', 'updates', "TEXT DEFAULT '{}'"],
  ['watchlist', 'resolved_pct', 'REAL'],
  ['notification_outbox', 'cancelled_at', 'INTEGER'],
]) {
  if (
    !db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column)
  )
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
// Retain the audit trail, but do not send legacy immediate notices after upgrading.
db.prepare(
  `UPDATE notification_outbox SET cancelled_at=?,last_error=?
  WHERE sent_at IS NULL AND cancelled_at IS NULL
  AND id NOT IN (SELECT outbox_id FROM closing_briefings WHERE outbox_id IS NOT NULL)`,
).run(Math.floor(Date.now() / 1000), '即时通报已取消，改为半小时合并通报');
// Earlier versions counted polls as days. Recalculate surviving observations from stored trading dates.
if (!db.prepare("SELECT 1 FROM kv WHERE k='observation_days_v2'").get()) {
  db.prepare(
    `UPDATE watchlist SET days=(SELECT COUNT(DISTINCT date) FROM daily_vol
    WHERE daily_vol.stock=watchlist.stock AND date>watchlist.added_date AND date<=?),
    note=CASE WHEN outcome='expired' THEN '旧版按扫描轮次计天，到期记录不可用于策略验证' ELSE note END`,
  ).run(marketDate());
  db.prepare("INSERT INTO kv(k,v) VALUES('observation_days_v2','1')").run();
}

function storeCandles(code, candles) {
  if (!candles.length) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO samples(stock, ts, vol) VALUES(?,?,?)');
  for (const [t, v] of candles) stmt.run(code, Math.floor(t / 300) * 300, v);
}

function storeDaily(code, rows) {
  if (!rows.length) return;
  const stmt = db.prepare(
    'INSERT INTO daily(stock, date, volume) VALUES(?,?,?) ON CONFLICT(stock, date) DO UPDATE SET volume=excluded.volume',
  );
  for (const [date, volume] of rows) stmt.run(code, date, volume);
}

function updateLive(code, name, price, prevClose, open, mtime) {
  db.prepare(
    `INSERT INTO live(stock, name, price, prevClose, open, mtime) VALUES(?,?,?,?,?,?)
    ON CONFLICT(stock) DO UPDATE SET name=excluded.name, price=excluded.price, prevClose=excluded.prevClose, open=excluded.open, mtime=excluded.mtime`,
  ).run(code, name, price, prevClose, open, mtime);
}

function prune() {
  db.prepare('DELETE FROM volume_ts WHERE ts < ?').run(Math.floor(Date.now() / 1000) - 3 * 86400);
  db.prepare(
    'DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY id DESC LIMIT 500)',
  ).run();
  db.prepare('DELETE FROM notification_outbox WHERE sent_at IS NOT NULL AND sent_at<?').run(
    Math.floor(Date.now() / 1000) - 30 * 86400,
  );
}

// ---------------- Yahoo 数据 ----------------
async function yahooGet(url) {
  let error;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const res = await fetch(url.replace('query1.finance.yahoo.com', host), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      error = e;
    }
  }
  throw error;
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
    if (v != null && v > 0) candles.push([ts[i], v]); // 过滤午休/停牌的 0 量占位
  }
  return { meta, candles };
}

async function fetchIntraday(code) {
  const d = await yahooGet(
    `https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=5m&range=1d`,
  );
  const { meta, candles } = parseChart(d);
  // 当天开盘价 = 第一个非空的 open(5m candle, 即 9:00 开盘价)
  const openArr = d.chart?.result?.[0]?.indicators?.quote?.[0]?.open || [];
  let open = null;
  for (const o of openArr) {
    if (o != null && o > 0) {
      open = o;
      break;
    }
  }
  return {
    code,
    name: meta.longName || meta.shortName || code,
    price: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose,
    open,
    mtime: meta.regularMarketTime,
    candles,
  };
}

async function fetchBackfill(code) {
  const d = await yahooGet(
    `https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=5m&range=5d`,
  );
  return parseChart(d).candles;
}

// 日线数据(用于「天」时段): interval=1d + 大 range 拿长期历史
async function fetchDaily(code, range = '1y') {
  const d = await yahooGet(
    `https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=1d&range=${range}`,
  );
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
const TV_COLUMNS =
  'name,description,open,close,volume,change,change_abs,average_volume_10d_calc,average_volume_30d_calc,high,low,isin';

async function tvScan(range) {
  const res = await fetch('https://scanner.tradingview.com/malaysia/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      columns: TV_COLUMNS.split(','),
      filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }],
      range,
      sort: { sortBy: 'name', sortOrder: 'asc' },
    }),
  });
  if (!res.ok) throw new Error(`TV HTTP ${res.status}`);
  return res.json();
}

// 一次拿全市场(约1130只)快照
async function fetchMarket() {
  const out = [],
    symbols = [],
    seen = new Set();
  let expected = null,
    received = 0;
  for (let start = 0; ; start += 500) {
    const d = await tvScan([start, start + 500]);
    const data = d.data || [];
    if (!Number.isInteger(d.totalCount) || d.totalCount <= 0)
      throw new Error('行情接口缺少完整市场数量');
    if (expected != null && d.totalCount !== expected)
      throw new Error('扫描期间股票池数量变化，保留此前完整快照');
    expected = d.totalCount;
    if (!data.length && received < expected) throw new Error('全市场扫描提前结束');
    for (const row of data) {
      const [
        ticker,
        name,
        open,
        close,
        volume,
        changePct,
        changeAbs,
        avg10d,
        avg30d,
        high,
        low,
        isin,
      ] = row.d;
      if (!ticker || seen.has(ticker)) throw new Error('分页出现缺失或重复股票代码');
      seen.add(ticker);
      received++;
      // Main/ACE codes have four digits; LEAP codes have five digits and one O.
      const isinCode =
        typeof isin === 'string' ? isin.match(/^MY[A-Z](?:(\d{4})OO|(\d{5})O)\d{3}$/) : null;
      const numericCode = isinCode?.[1] || isinCode?.[2] || null;
      symbols.push({ ticker, name, numericCode });
      if (!(close > 0)) continue;
      out.push({
        ticker,
        name,
        price: close,
        open,
        volume,
        change_pct: changePct,
        change_abs: changeAbs,
        prevClose: close != null && changeAbs != null ? close - changeAbs : null,
        avg10d,
        avg30d,
        high,
        low,
        numericCode,
      });
    }
    if (received === expected) break;
    if (data.length < 500 || received > expected) throw new Error('行情分页不完整');
  }
  Object.defineProperty(out, 'coverage', {
    value: { expected, received, valid: out.length, symbols },
  });
  return out;
}

function storeUniverse(quotes) {
  const stmt = db.prepare(
    `INSERT INTO universe(stock,name,code,active,last_seen) VALUES(?,?,?,1,?) ON CONFLICT(stock) DO UPDATE SET name=excluded.name,
    history_attempt=CASE WHEN universe.code IS NULL AND excluded.code IS NOT NULL THEN NULL ELSE universe.history_attempt END,
    history_error=CASE WHEN universe.code IS NULL AND excluded.code IS NOT NULL THEN NULL ELSE universe.history_error END,
    code=COALESCE(excluded.code,universe.code),active=1,last_seen=excluded.last_seen`,
  );
  db.exec('BEGIN');
  try {
    if (quotes.coverage) db.prepare('UPDATE universe SET active=0').run();
    for (const q of quotes.coverage?.symbols || quotes)
      stmt.run(q.ticker, q.name, q.numericCode || null, Date.now() / 1000);
    if (quotes.coverage) {
      const valid = new Set(quotes.map((q) => q.ticker));
      const clear = db.prepare(
        'UPDATE live SET price=NULL,volume=NULL,mtime=NULL,session_date=NULL WHERE stock=?',
      );
      for (const q of quotes.coverage.symbols) if (!valid.has(q.ticker)) clear.run(q.ticker);
    }
    if (quotes.coverage)
      kvSet(
        'market_scan_coverage',
        JSON.stringify({ ...quotes.coverage, symbols: undefined, at: Date.now() / 1000 }),
      );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  analysisCache = null;
}

function updateQuote(q, cfg = loadConfig()) {
  analysisCache = null;
  const now = Date.now() / 1000;
  const local = new Date((now + 8 * 3600) * 1000);
  const today = mytDate(now);
  const regularDay =
    ![0, 6].includes(local.getUTCDay()) &&
    local.getUTCHours() >= 9 &&
    !(cfg.market_holidays || []).includes(today);
  const historicalDate = db
    .prepare('SELECT MAX(date) date FROM daily_vol WHERE stock=? AND date<?')
    .get(q.ticker, today)?.date;
  const date = regularDay ? today : historicalDate || null;
  db.prepare(
    `INSERT INTO live(stock, name, price, prevClose, open, volume, avg10d, avg30d, mtime, session_date,high,low) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(stock) DO UPDATE SET name=excluded.name, price=excluded.price, prevClose=excluded.prevClose, open=excluded.open, volume=excluded.volume, avg10d=excluded.avg10d, avg30d=excluded.avg30d, mtime=excluded.mtime, session_date=excluded.session_date,high=excluded.high,low=excluded.low`,
  ).run(
    q.ticker,
    q.name,
    q.price,
    q.prevClose,
    q.open,
    q.volume,
    q.avg10d,
    q.avg30d,
    now,
    date,
    q.high ?? null,
    q.low ?? null,
  );
}

// 记录今日累计量快照(用于时段对比差值法)
function recordVolume(code, cumVolume) {
  if (cumVolume == null || !isMarketOpen()) return;
  const ts = Math.floor(Date.now() / 1000);
  db.prepare('INSERT OR REPLACE INTO volume_ts(stock, ts, cum_volume) VALUES(?,?,?)').run(
    code,
    ts,
    cumVolume,
  );
}

// 记录每日总量(用于自己算4周/5天均量; 收盘后=最终总量)
function recordDailyVolume(code, volume) {
  if (volume == null) return;
  const date = mytDate(Date.now() / 1000);
  db.prepare(
    'INSERT INTO daily_vol(stock, date, volume) VALUES(?,?,?) ON CONFLICT(stock, date) DO UPDATE SET volume=excluded.volume',
  ).run(code, date, volume);
}

// pickastock 榜单(候选池): type=0 成交量榜 / type=5 跌幅%榜
// 失败时返回 null, 调用方回退到用我们自己的数据算 top30
async function fetchPickTop(type) {
  try {
    const res = await fetch(
      `https://app.pickastock.info/api/Top10?type=${type}&top=30&isSyariah=false&excludeWarrant=true&period=0`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.pickastock.info/top10' },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const n = Object.keys(d).filter((k) => /^s\d+$/.test(k)).length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const code = d[`s${i}`],
        price = d[`c${i}`],
        ref = d[`r${i}`],
        vol = d[`v${i}`];
      if (!code || ref == null || ref <= 0) continue;
      out.push({ code, price, ref, volume: vol, pct: ((price - ref) / ref) * 100 }); // pct = 相对开盘涨跌%
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// 字母 ticker → 数字代码 (Yahoo search, 用于日线历史)
// 短 ticker(如 QL/G3/NEXG)直接搜会被外国股票淹没, 所以搜不到时改用「公司名」再搜一次
async function mapCodeToNumeric(ticker, desc) {
  const trySearch = async (q) => {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(12000),
        },
      );
      if (!res.ok) return null;
      const d = await res.json();
      const hit = (d.quotes || []).find(
        (x) =>
          x.symbol &&
          x.symbol.endsWith('.KL') &&
          (x.shortname || '').toUpperCase() === ticker.toUpperCase(),
      );
      return hit ? hit.symbol.replace('.KL', '') : null;
    } catch {
      return null;
    }
  };
  let c = await trySearch(ticker);
  if (c || !desc) return c;
  // 用公司名前两个词再试 (e.g. 'QL Resources Bhd.' → 'QL Resources')
  const short = String(desc)
    .replace(/\b(Bhd|Berhad|BHD|SDN|Sdn)\.?/gi, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  if (short && short.toUpperCase() !== ticker.toUpperCase()) {
    c = await trySearch(short);
    if (c) return c;
  }
  c = await trySearch(desc);
  return c;
}

// 回填每日量历史(Yahoo 日线 API 直接拿, 不用自己记录快照): 供「昨日量」对比 + 4W/5D均量
let backfillPromise = null;
function backfillDailyVol(options = {}) {
  if (backfillPromise) return backfillPromise;
  backfillPromise = performBackfill(options).finally(() => {
    backfillPromise = null;
  });
  return backfillPromise;
}
function completedMarketDate(cfg = loadConfig()) {
  const day = new Date(Date.now() + 8 * 3600 * 1000);
  if (day.getUTCHours() < 17) day.setUTCDate(day.getUTCDate() - 1);
  while (
    [0, 6].includes(day.getUTCDay()) ||
    (cfg.market_holidays || []).includes(day.toISOString().slice(0, 10))
  )
    day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
function historyRefreshQueue(force = false) {
  const expected = completedMarketDate(),
    now = Date.now() / 1000;
  return db
    .prepare(
      `SELECT u.*,h.latest,h.complete,l.volume FROM universe u
    LEFT JOIN (SELECT stock,MAX(date) latest,MAX(CASE WHEN close>0 AND high>=close AND low>0 AND low<=close THEN date END) complete_latest,SUM(CASE WHEN close>0 AND high>=close AND low>0 AND low<=close THEN 1 ELSE 0 END) complete FROM daily_vol GROUP BY stock) h ON h.stock=u.stock
    LEFT JOIN live l ON l.stock=u.stock WHERE u.active=1`,
    )
    .all()
    .filter(
      (u) =>
        force ||
        ((!u.history_attempt || now - u.history_attempt >= 600) &&
          (!u.code ||
            !u.latest ||
            u.latest < expected ||
            !u.complete ||
            u.complete_latest < u.latest ||
            u.history_error)),
    )
    .sort((a, b) => Number(!b.latest) - Number(!a.latest) || (b.volume || 0) - (a.volume || 0));
}
async function performBackfill({ force = false } = {}) {
  const rows = historyRefreshQueue(force);
  if (!rows.length) return { done: 0, total: 0 };
  log(`回填 ${rows.length} 只股票日线历史(Yahoo)...`);
  let done = 0,
    index = 0;
  const worker = async () => {
    while (index < rows.length) {
      const u = rows[index++];
      db.prepare('UPDATE universe SET history_attempt=? WHERE stock=?').run(
        Date.now() / 1000,
        u.stock,
      );
      try {
        if (!u.code) {
          u.code = await mapCodeToNumeric(u.stock, u.name);
          if (!u.code) throw new Error('Yahoo 暂无匹配的数字代码');
          db.prepare('UPDATE universe SET code=? WHERE stock=?').run(u.code, u.stock);
        }
        const d = await yahooGet(
          `https://query1.finance.yahoo.com/v8/finance/chart/${u.code}.KL?interval=1d&range=6mo`,
        );
        const r = d.chart?.result?.[0];
        if (!r || (r.meta?.symbol && r.meta.symbol !== u.code + '.KL'))
          throw new Error('日线接口没有返回匹配的股票资料');
        const ts = r.timestamp || [];
        const q = r.indicators?.quote?.[0] || {};
        const vol = q.volume || [],
          oArr = q.open || [],
          hArr = q.high || [],
          lArr = q.low || [],
          cArr = q.close || [];
        const n = Math.min(ts.length, vol.length);
        let inserted = 0;
        for (let i = 0; i < n; i++) {
          // Do not treat an unfinished daily bar as a completed breakout candle.
          const date = mytDate(ts[i]);
          const local = new Date(Date.now() + 8 * 3600 * 1000);
          if (date === mytDate(Date.now() / 1000) && local.getUTCHours() < 17) continue;
          if (
            vol[i] > 0 &&
            cArr[i] > 0 &&
            hArr[i] >= cArr[i] &&
            lArr[i] > 0 &&
            lArr[i] <= cArr[i]
          ) {
            db.prepare(
              `INSERT INTO daily_vol(stock, date, volume, open, high, low, close) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(stock, date) DO UPDATE SET volume=excluded.volume, open=excluded.open,
              high=excluded.high, low=excluded.low, close=excluded.close`,
            ).run(
              u.stock,
              mytDate(ts[i]),
              vol[i],
              oArr[i] ?? null,
              hArr[i] ?? null,
              lArr[i] ?? null,
              cArr[i] ?? null,
            );
            if (cArr[i] > 0) inserted++;
          }
        }
        if (!inserted) throw new Error('暂未取得完整日线');
        db.prepare('UPDATE universe SET history_success=?,history_error=NULL WHERE stock=?').run(
          Date.now() / 1000,
          u.stock,
        );
        done++;
      } catch (e) {
        log(`日线回填失败 ${u.stock}: ${e.message}`);
        db.prepare('UPDATE universe SET history_error=? WHERE stock=?').run(
          String(e.message).slice(0, 160),
          u.stock,
        );
      }
      analysisCache = null;
      await sleep(80);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, () => worker()));
  log(`日线回填完成 ${done}/${rows.length} 只`);
  analysisCache = null;
  persistPotentialEvents();
  return { done, total: rows.length };
}

// 从 daily_vol 算 4W/5D 均量(同步, 回填后即有数据)
function getAvgVolumes(code) {
  const todayStr = mytDate(Date.now() / 1000);
  const d5 = db
    .prepare(
      'SELECT AVG(volume) a FROM (SELECT volume FROM daily_vol WHERE stock=? AND date < ? ORDER BY date DESC LIMIT 5)',
    )
    .get(code, todayStr);
  const d20 = db
    .prepare(
      'SELECT AVG(volume) a FROM (SELECT volume FROM daily_vol WHERE stock=? AND date < ? ORDER BY date DESC LIMIT 20)',
    )
    .get(code, todayStr);
  return { avg4w: d20?.a ?? null, avg5d: d5?.a ?? null };
}

// ---------------- 成交量计算 ----------------
function mytDate(tsSec) {
  // 马来西亚时区(UTC+8)的日期字符串
  return marketDate(tsSec);
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
  const r = db
    .prepare('SELECT cum_volume FROM volume_ts WHERE stock=? AND ts <= ? ORDER BY ts DESC LIMIT 1')
    .get(code, targetTs);
  return r ? r.cum_volume : null;
}
function computeVolumes(code, window) {
  const pw = parseWindow(window);
  if (!pw) return null;
  if (pw.unit === 'd') {
    // 日线对比: 「最近 N 天」vs「前 N 天」(N = window 的天数, 不 hard code)
    //   N=1 → 今日 vs 昨日       N=2 → (今日+昨日) vs (前天+大前天)
    const N = pw.value;
    const live = db.prepare('SELECT volume, session_date FROM live WHERE stock=?').get(code);
    if (!live || live.volume == null || !live.session_date) return null;
    const todayStr = live.session_date;
    const rows = db
      .prepare(
        'SELECT date, volume FROM daily_vol WHERE stock=? AND date < ? ORDER BY date DESC LIMIT ?',
      )
      .all(code, todayStr, 2 * N - 1);
    if (rows.length < 2 * N - 1) return null; // 历史不够(冷启动)
    const sum = (a) => a.reduce((s, r) => s + (r.volume || 0), 0);
    const current = live.volume + sum(rows.slice(0, N - 1)); // 今天 + 前 N-1 天
    const previous = sum(rows.slice(N - 1, 2 * N - 1)); // 再往前 N 天
    if (current < 0 || previous <= 0) return null;
    // 日期标签: 单日就写日期, 多日写「起 ~ 止」
    const rng = (arr) => (arr.length <= 1 ? arr[0] || '' : `${arr[0]} ~ ${arr[arr.length - 1]}`);
    const curDates = [todayStr, ...rows.slice(0, N - 1).map((r) => r.date)].sort();
    const prevDates = rows
      .slice(N - 1, 2 * N - 1)
      .map((r) => r.date)
      .sort();
    return { current, previous, curLabel: rng(curDates), prevLabel: rng(prevDates) };
  }
  // 天内时段对比: volume_ts 累计量差值(同一天内累计单调递增)
  const minutes = pw.unit === 'h' ? pw.value * 60 : pw.value;
  const wSec = minutes * 60;
  const now = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare('SELECT ts, cum_volume FROM volume_ts WHERE stock=? AND ts>=? ORDER BY ts')
    .all(code, now - 2 * wSec - 3600);
  const cfg = loadConfig();
  const result = compareSnapshots(
    rows,
    wSec,
    now,
    Math.max(300, cfg.poll_interval_minutes * 120),
    cfg.market_holidays,
  );
  if (!result) return null;
  const { current, previous } = result;
  const hm = (ts) => {
    const d = new Date((ts + 8 * 3600) * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  return {
    current,
    previous,
    curLabel: `${hm(now - wSec)}~${hm(now)}`,
    prevLabel: `${hm(now - 2 * wSec)}~${hm(now - wSec)}`,
  };
}

// 今日成交量 vs 昨日成交量(日线数据)
function computeDaily(code) {
  const rows = db
    .prepare('SELECT volume FROM daily WHERE stock=? ORDER BY date DESC LIMIT 2')
    .all(code);
  if (rows.length < 2) return null;
  return { today: rows[0].volume, yesterday: rows[1].volume };
}

function computeMetrics(cfg) {
  const out = [];
  const universe = db.prepare('SELECT stock, name FROM universe WHERE active=1').all();
  for (const w of universe) {
    const code = w.stock;
    const live =
      db
        .prepare(
          'SELECT name, price, open, prevClose, volume, mtime, session_date FROM live WHERE stock=?',
        )
        .get(code) || {};
    const vol = computeVolumes(code, cfg.window);
    let current = null,
      previous = null,
      ratio = null,
      status = 'nodata';
    if (vol) {
      current = vol.current;
      previous = vol.previous;
      if (previous > 0) {
        ratio = (current / previous) * 100;
        const threshold = getThresholdForPrice(live.price, cfg.price_thresholds);
        status = threshold != null && ratio >= threshold ? 'alert' : 'ok';
      } else {
        status = 'low';
      }
    }
    const av = getAvgVolumes(code);
    out.push({
      code,
      name: live.name || w.name || code,
      price: live.price,
      open: live.open,
      prevClose: live.prevClose,
      volume: live.volume,
      avg4w: av.avg4w,
      avg5d: av.avg5d,
      mtime: live.mtime,
      session_date: live.session_date,
      current,
      previous,
      ratio,
      status,
      curLabel: vol ? vol.curLabel : null,
      prevLabel: vol ? vol.prevLabel : null,
    });
  }
  // 按增长倍率从大到小排列
  out.sort((a, b) => {
    const ra = a.ratio,
      rb = b.ratio;
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

// ---------------- Telegram 对话层 ----------------
// 同一个 bot 既推送又收消息: 因为收(getUpdates)和发(sendMessage)都在本进程内, 不会互相抢
// offset 持久化在 kv 表, 避免重启后重复处理旧消息
function tgCall(cfg, method, params, timeoutMs = 35000) {
  const token = (cfg.telegram_bot_token || '').trim();
  if (!token) return Promise.resolve(null);
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: ctl.signal,
  })
    .then((r) => r.json())
    .catch(() => null)
    .finally(() => clearTimeout(t));
}

function kvGet(k, dflt) {
  try {
    const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k);
    return r ? r.v : dflt;
  } catch (e) {
    return dflt;
  }
}
function kvSet(k, v) {
  try {
    db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(
      k,
      String(v),
    );
  } catch (e) {}
}

function num(n, dp = 3) {
  return n == null ? '—' : Number(n).toFixed(dp);
}
function vol(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// 单只股票详情
function cmdStock(arg) {
  const report = getStockReport(String(arg || '').trim());
  return report ? formatReport(report) : '找不到这只股票。用法：/stock MAYBANK 或 /stock 1155';
}

// 今日精选
function cmdTop() {
  const shortlist = getAnalysisOverview(loadConfig());
  if (!shortlist.candidates.length)
    return '已扫描全市场，当前没有同时满足参与条件与资料要求的股票。没有为了凑数而补入较弱信号。';
  return (
    '🔎 全市场筛选 · 优先考虑 ' +
    shortlist.candidates.length +
    '只\n按依据完整度、形态匹配度与参考空间排序。\n\n' +
    shortlist.candidates.map((report) => formatReport(report)).join('\n\n')
  );
}

// 强势筛选: 20日涨幅 + 放量 + 站上MA5 + 四线多头排列
// 用法: /screen            用当前参数
//       /screen 10 30 3    临时改 涨幅下限 上限 放量倍数
function cmdScreen(arg) {
  const cfg = loadConfig();
  const nums = String(arg || '').match(/-?\d+(?:\.\d+)?/g) || [];
  const opts = {
    min_gain: cfg.screen_min_gain,
    max_gain: cfg.screen_max_gain,
    vol_mult: cfg.screen_vol_mult,
    min_volume: cfg.screen_min_volume,
    above_ma5: cfg.screen_above_ma5,
    bullish_stack: cfg.screen_bullish,
  };
  if (nums.length >= 1) opts.min_gain = Number(nums[0]);
  if (nums.length >= 2) opts.max_gain = Number(nums[1]);
  if (nums.length >= 3) opts.vol_mult = Number(nums[2]);
  const r = runScreen(opts);
  const head = `📐 强势筛选 · ${r.date}`;
  const cond = `成交至少 ${r.params.min_volume.toLocaleString('zh-CN')} 股、至少昨日 ${r.params.vol_mult} 倍 · ${r.params.min_gain}~${r.params.max_gain}% (20交易日) · 站上MA5 · 四线多头排列`;
  if (!r.hits.length) {
    return [
      head,
      `条件: ${cond}`,
      '',
      '今天没有完全符合的股票。',
      `（扫了 ${r.screened} 只：涨幅不符 ${r.funnel.not_gain} · 放量不足 ${r.funnel.not_vol} · 未站上MA5 ${r.funnel.not_ma5} · 非多头排列 ${r.funnel.not_bull}）`,
    ].join('\n');
  }
  const out = [head, `条件: ${cond}`, '', `命中 ${r.hits.length} 只`, ''];
  for (const h of r.hits.slice(0, 10)) {
    out.push(`${h.name} (${h.stock})   收 ${num(h.close)}`);
    out.push(`   20日 +${h.gain20}% · 放量 ${h.vr}x · 四线多头排列`);
    out.push(
      `   本次 ${h.current_volume.toLocaleString('zh-CN')} 股 / ${h.previous_date} 全天 ${h.previous_volume.toLocaleString('zh-CN')} 股`,
    );
    out.push(
      `   MA5 ${num(h.ma5)} > MA10 ${num(h.ma10)} > MA15 ${num(h.ma15)} > MA20 ${num(h.ma20)}`,
    );
    out.push('');
  }
  return out.join('\n');
}

// 观察名单
function cmdWatch(arg) {
  const all = String(arg || '').toLowerCase() === 'all';
  const rows = all
    ? db.prepare('SELECT * FROM watchlist ORDER BY outcome, added_date DESC').all()
    : db
        .prepare("SELECT * FROM watchlist WHERE outcome='observing' ORDER BY added_date DESC")
        .all();
  const tally = db.prepare('SELECT outcome, COUNT(*) c FROM watchlist GROUP BY outcome').all();
  if (!rows.length) return '观察名单是空的。';
  const mark = { observing: '👀', win: '✅', loss: '❌', expired: '⏱' };
  const out = [`📈 观察名单${all ? '(全部)' : '(跟踪中)'} · ${rows.length} 只`, ''];
  for (const w of rows) {
    const l = db.prepare('SELECT price FROM live WHERE stock=?').get(w.stock) || {};
    const pct = l.price && w.entry_price ? ((l.price - w.entry_price) / w.entry_price) * 100 : null;
    out.push(
      `${mark[w.outcome] || '•'} ${w.name || w.stock} (${w.stock})  ${pct == null ? '—' : (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'}  入场 ${num(w.entry_price)}  第${w.days}天`,
    );
  }
  const nm = { observing: '跟踪中', win: '涨幅达标', loss: '跌幅触发', expired: '到期' };
  out.push('', '累计: ' + tally.map((x) => `${nm[x.outcome] || x.outcome} ${x.c}`).join(' · '));
  return out.join('\n');
}

// 规则观察结果，不是实盘战绩
function cmdStats() {
  const tally = db.prepare('SELECT outcome, COUNT(*) c FROM watchlist GROUP BY outcome').all();
  const t = {};
  tally.forEach((x) => {
    t[x.outcome] = x.c;
  });
  const u = db.prepare('SELECT COUNT(*) c FROM universe').get().c;
  const withCode = db.prepare('SELECT COUNT(*) c FROM universe WHERE code IS NOT NULL').get().c;
  const hist = db.prepare('SELECT COUNT(DISTINCT stock) c FROM daily_vol').get().c;
  return [
    `📊 规则观察结果`,
    ``,
    `涨幅达标 ${t.win || 0}  ·  跌幅触发 ${t.loss || 0}  ·  跟踪中 ${t.observing || 0}  ·  到期 ${t.expired || 0}`,
    `这是规则触发记录，未模拟成交、费用和滑点，不代表实盘收益。`,
    ``,
    `股票池 ${u} 只(已映射 ${withCode})`,
    `有日线历史 ${hist} 只`,
  ].join('\n');
}

function cmdHelp() {
  return [
    '🤖 KLSE Tracker 指令',
    '',
    '/bot <任何话>   直接跟 AI 对话, 例: /bot 你好 或 /bot MAYBANK 值得买吗',
    '/stock <代码>   查单只股票现在的完整情况',
    '/screen         强势筛选: 20日涨15-25% + 放量2倍 + 站上MA5 + 四线多头排列',
    '/top            只看今日精选',
    '/watch [all]    观察名单及成绩',
    '/stats          规则观察结果',
    '/set <项> <值>  改参数, 例: /set pick_count 2',
    '/params         查看当前所有参数',
    '/scan           手动重新扫描一轮',
    '/help           显示这条帮助',
  ].join('\n');
}

function cmdParams() {
  const cfg = loadConfig();
  const keys = [
    'poll_interval_minutes',
    'window',
    'price_drop_threshold',
    'gap_up_threshold',
    'db_min_score',
    'db_min_rr',
    'db_fresh',
    'pick_count',
    'win_pct',
    'loss_pct',
    'watch_days',
    'screen_min_gain',
    'screen_max_gain',
    'screen_vol_mult',
    'screen_min_volume',
  ];
  return '⚙️ 当前参数\n\n' + keys.map((k) => `${k} = ${cfg[k] ?? '(默认)'}`).join('\n');
}

// ---------------- 自然语言层 (DeepSeek function calling) ----------------
// 分工: LLM 只负责"听懂人话 + 决定调哪个接口 + 把结果说成人话"
//       所有数字都由本地计算给出, 不让模型自己编
const LLM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_stock',
      description: '查某只股票当前完整情况(现价/成交量/放量对比/均量/双底形态/观察状态)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '股票代码, 字母如 MAYBANK 或数字如 1155' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_picks',
      description: '今日达标的精选股票列表',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_watchlist',
      description: '观察名单——系统推荐过、正在跟踪的股票及它们的表现',
      parameters: {
        type: 'object',
        properties: {
          include_archived: {
            type: 'boolean',
            description: 'true 时包含已归档(涨幅达标/跌幅触发/到期)的记录',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stats',
      description: '规则观察统计(涨幅达标/跌幅触发/到期)，不代表实盘收益',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_params',
      description: '查看当前所有可调参数',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_param',
      description: '修改一个系统参数',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '参数名, 如 pick_count / db_min_score / poll_interval_minutes',
          },
          value: { type: 'string', description: '新值' },
        },
        required: ['name', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_stock',
      description: '不知道代码时, 用公司名/关键词搜索股票',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string' } },
        required: ['keyword'],
      },
    },
  },
];

const LLM_SYSTEM = [
  '你是 KLSE Tracker 助手, 服务对象是马来西亚散户, 数据源是本地股票数据库。',
  '',
  '规则:',
  '1. 需要数据时必须调用工具, 绝对不要凭记忆编造任何数字或价格。',
  '2. 用简洁中文回答, 适当换行, 不要长篇大论, 不要客套话。',
  '3. 你只陈述数据与事实, 不做"必涨/稳赚"这类承诺, 也不给仓位建议。',
  '4. 工具返回的数据就是全部事实, 不要自行推测补充(例如不要编造新闻)。',
  '5. 如果没有任何工具能回答用户的问题, 就直接说这个系统目前查不了, 不要硬答。',
  '6. 用户是市场参与者, 直接给结论和数据, 不要说"建议咨询专业人士"这类废话。',
].join('\n');

function llmKey(cfg) {
  return (cfg.llm_api_key || '').trim();
}

async function llmChat(key, messages) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages,
        tools: LLM_TOOLS,
        temperature: 0,
        max_tokens: 800,
      }),
      signal: ctl.signal,
    });
    const j = await r.json();
    if (!r.ok) {
      log('LLM 错误: ' + JSON.stringify(j).slice(0, 300));
      return null;
    }
    return j;
  } catch (e) {
    log('LLM 请求失败: ' + e);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function searchStock(keyword) {
  const k = '%' + String(keyword || '').trim() + '%';
  const rows = db
    .prepare('SELECT stock, name FROM universe WHERE name LIKE ? OR UPPER(stock) LIKE ? LIMIT 8')
    .all(k, k.toUpperCase());
  if (!rows.length) return `没有找到匹配「${keyword}」的股票。`;
  return '匹配到:\n' + rows.map((r) => `  ${r.stock}  ${r.name}`).join('\n');
}

function runTool(name, args, cfg) {
  try {
    if (name === 'set_param' && cfg.allow_mutation !== true) return '只有管理员能修改系统参数。';
    if (name === 'get_stock') return cmdStock(args.query);
    if (name === 'list_picks') return cmdTop();
    if (name === 'list_watchlist') return cmdWatch(args.include_archived ? 'all' : '');
    if (name === 'get_stats') return cmdStats();
    if (name === 'get_params') return cmdParams();
    if (name === 'search_stock') return searchStock(args.keyword);
    if (name === 'set_param') {
      const c = loadConfig();
      saveConfig(validateSettings(parameterPatch(args.name, args.value), c));
      return `已设置 ${args.name} = ${loadConfig()[args.name]}`;
    }
  } catch (e) {
    return '执行出错: ' + String(e.message || e);
  }
  return '未知工具: ' + name;
}

async function handleWithLLM(text, cfg) {
  const key = llmKey(cfg);
  if (!key) return null;
  const msgs = [
    { role: 'system', content: LLM_SYSTEM },
    { role: 'user', content: text },
  ];
  const toolsCfg = { ...cfg, allow_mutation: cfg.allow_mutation === true };
  for (let round = 0; round < 4; round++) {
    const r = await llmChat(key, msgs);
    if (!r || !r.choices || !r.choices[0]) return null;
    const msg = r.choices[0].message;
    msgs.push(msg);
    const calls = msg.tool_calls || [];
    if (calls.length) {
      for (const tc of calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {}
        const out =
          tc.function.name === 'set_param' && !toolsCfg.allow_mutation
            ? '只有管理员能修改系统参数。'
            : runTool(tc.function.name, args, cfg);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
      }
      continue;
    }
    return (msg.content || '').trim() || null;
  }
  return '这个问题要查的东西太多轮了，换个说法再问一次吧。';
}

// 处理一条收到的消息
async function handleTelegramMessage(msg, cfg) {
  const text = (msg.text || '').trim();
  if (!text) return null;
  const chatId = String(msg.chat && msg.chat.id);
  const chatType = (msg.chat && msg.chat.type) || '';
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const botName = kvGet('bot_username', '');
  const mentioned = !!botName && text.includes('@' + botName);
  let isAdmin = false;

  if (isGroup) {
    // 群里: 只认配置的那个群。
    // 响应条件放宽为「以 / 开头的命令」或「@ 了机器人」—— privacy mode 下 Telegram
    // 本来就只会把这两类消息送过来, 所以直接打 /stats 或 /bot 你好 就行, 不必先 @。
    if (String(cfg.telegram_chat_id || '') !== chatId) return null;
    if (!text.startsWith('/') && !mentioned) return null;
    if (msg.from?.id) {
      const member = await tgCall(cfg, 'getChatMember', {
        chat_id: Number(cfg.telegram_chat_id),
        user_id: msg.from.id,
      });
      isAdmin = member?.ok && ['creator', 'administrator'].includes(member.result?.status);
    }
  } else {
    // 私聊: Telegram 不受 privacy mode 限制, 说什么都收得到, 可以随便聊。
    // 但只放行群主/管理员 —— 否则任何知道 bot 用户名的人都能私聊它刷你的 API 额度。
    const uid = msg.from && msg.from.id;
    if (!uid) return null;
    {
      const m2 = await tgCall(cfg, 'getChatMember', {
        chat_id: Number(cfg.telegram_chat_id),
        user_id: uid,
      });
      const st = m2 && m2.ok && m2.result ? m2.result.status : '';
      // 放行: 群主/管理员/普通成员 —— 只有「知道这个群」的人才可能私聊到 bot,
      // 仍会挡住完全的外人(不在群里 => 通常 Telegram 查不到身份)
      if (
        !['creator', 'administrator', 'member'].includes(st) &&
        !(st === 'restricted' && m2?.result?.is_member)
      ) {
        kvSet('tg_denied_id', String(uid));
        kvSet('tg_denied_reason', '不在群里或身份异常 status=' + JSON.stringify(st));
        log('私聊被拒(非群管理员): ' + uid + ' status=' + st);
        return null;
      }
      isAdmin = ['creator', 'administrator'].includes(st);
    }
  }
  const clean = text.replace(new RegExp('@' + (botName || '') + '\\b', 'g'), '').trim();
  const [cmdRaw, ...rest] = clean.split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase().replace(/^\//, '');
  const arg = rest.join(' ');
  cfg = { ...cfg, allow_mutation: isAdmin };
  try {
    // /bot 你好吗  → 直接跟 AI 对话(不用记具体命令)
    if (cmd === 'bot' || cmd === 'ai' || cmd === 'ask') {
      const q = (arg || '').trim() || '你好';
      const ai = await handleWithLLM(q, cfg);
      return ai || '（AI 没有回应——可能是没配 key，或者请求失败了）';
    }
    if (cmd === 'stock' || cmd === 's') return await cmdStock(arg);
    if (cmd === 'top' || cmd === 'picks') return cmdTop();
    if (cmd === 'screen' || cmd === 'scr') return cmdScreen(arg);
    if (cmd === 'watch' || cmd === 'w') return cmdWatch(arg);
    if (cmd === 'stats') return cmdStats();
    if (cmd === 'params') return cmdParams();
    if (cmd === 'help' || cmd === 'start') return cmdHelp();
    if (cmd === 'scan') {
      maybePoll();
      return '已触发一轮重新扫描，结果稍后到。';
    }
    if (cmd === 'set') {
      if (!isAdmin) return '只有群主或管理员能修改系统参数。';
      const [k, v] = arg.split(/\s+/);
      if (!k || v == null)
        return '用法: /set <参数名> <值>   例: /set pick_count 2\n用 /params 查看可用参数';
      const cfg2 = loadConfig();
      saveConfig(validateSettings(parameterPatch(k, v), cfg2));
      return `✅ ${k} = ${loadConfig()[k]}`;
    }
    // 不是已知命令 -> 交给 LLM 理解人话(前提是配了 key)
    const ai = await handleWithLLM(clean, cfg);
    return ai || null;
  } catch (e) {
    return '处理出错: ' + String(e.message || e).slice(0, 200);
  }
}

// getUpdates 长轮询
let tgPolling = false;
async function pollTelegram() {
  if (tgPolling) return;
  tgPolling = true;
  try {
    const cfg0 = loadConfig();
    if (!(cfg0.telegram_bot_token && cfg0.telegram_chat_id)) return;
    // 取一次 bot 用户名(用于判断群里是否 @ 了它)
    if (!kvGet('bot_username', '')) {
      const me = await tgCall(cfg0, 'getMe', {});
      if (me && me.ok && me.result) kvSet('bot_username', me.result.username || '');
    }
    // 注册命令菜单(让群里输入 / 时有提示; Telegram 会自动补成 /cmd@botname)
    if (!kvGet('cmds_registered', '')) {
      const cmds = [
        { command: 'stock', description: '查单只股票(例 /stock MAYBANK)' },
        { command: 'top', description: '今日达标精选' },
        { command: 'watch', description: '观察名单及成绩' },
        { command: 'stats', description: '规则观察结果' },
        { command: 'params', description: '查看当前所有参数' },
        { command: 'screen', description: '强势筛选(20日涨幅+放量+站上MA5+四线多头排列)' },
        { command: 'set', description: '改参数(例 /set pick_count 2)' },
        { command: 'scan', description: '手动重新扫描一轮' },
        { command: 'help', description: '显示帮助' },
      ];
      const r0 = await tgCall(cfg0, 'setMyCommands', {
        commands: cmds,
        scope: { type: 'chat', chat_id: Number(cfg0.telegram_chat_id) },
      });
      if (r0 && r0.ok) kvSet('cmds_registered', '1');
    }
    const cfg = loadConfig();
    let offset = Number(kvGet('tg_offset', 0)) || 0;
    kvSet('tg_poll_count', (Number(kvGet('tg_poll_count', 0)) || 0) + 1);
    kvSet(
      'tg_last_poll_at',
      mytDate(Date.now() / 1000) +
        ' ' +
        new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 19),
    );
    const r = await tgCall(
      cfg,
      'getUpdates',
      { offset, timeout: 25, allowed_updates: ['message'] },
      35000,
    );
    if (!r || !r.ok) {
      kvSet('tg_last_error', JSON.stringify(r).slice(0, 300));
    } else {
      kvSet('tg_last_error', '');
    }
    if (r && r.ok && Array.isArray(r.result)) {
      for (const upd of r.result) {
        offset = upd.update_id + 1;
        if (upd.message) {
          kvSet('tg_last_msg_at', new Date().toISOString().slice(11, 19));
          kvSet(
            'tg_last_msg_chat',
            JSON.stringify({
              id: upd.message.chat && upd.message.chat.id,
              type: upd.message.chat && upd.message.chat.type,
              text: (upd.message.text || '').slice(0, 120),
            }),
          );
          const reply = await handleTelegramMessage(upd.message, cfg);
          if (reply)
            await sendTelegramText(reply, {
              ...cfg,
              telegram_chat_id: String(upd.message.chat.id),
            });
        }
      }
      if (r.result.length) kvSet('tg_offset', offset);
    }
  } catch (e) {
    try {
      log('telegram 轮询异常: ' + e);
    } catch (_) {}
  } finally {
    tgPolling = false;
  }
}

// ---------------- 广播队列: 一轮轮询内收集所有信号, 合并成一条发出 ----------------
let bcastQueue = [];

function pushBroadcast(icon, title, body, count) {
  bcastQueue.push({ icon, title, body, count });
}

// ---------------- 每日精选 + 观察名单 ----------------
// 精选: 只挑出评分最高、盈亏比达标的极少数(默认3只), 不让用户被一堆股票淹没
function pickDailyPicks(cfg, limit = 3) {
  // ① 推荐过的票(不论结果)都不再重复推
  const seen = new Set(
    db
      .prepare('SELECT stock FROM watchlist')
      .all()
      .map((x) => x.stock),
  );
  // ② 名额只被「跟踪中」的占着; 应证/证伪/归档的会腾出名额, 补给新票
  const busy = db.prepare("SELECT COUNT(*) c FROM watchlist WHERE outcome='observing'").get().c;
  const slots = Math.max(0, limit - busy);
  if (slots === 0) return [];
  return getAnalysisOverview(cfg)
    .candidates.filter((r) => !seen.has(r.code) && !r.snapshot && r.quote_date === marketDate())
    .slice(0, slots)
    .map((r) => ({
      code: r.code,
      name: r.name,
      price: r.price,
      score: r.pattern?.score ?? null,
      signal:
        r.stage === 'coiled' ? '放量蓄势' : r.stage === 'building' ? '放量转强' : '蓄势后初步突破',
    }));
}

// 观察名单: 精选出来的票持续跟踪, 用真实涨跌给系统的判断打分
// win = 达到目标区 / loss = 跌破止损 / expired = 观察太久没动静
function updateWatchlist(cfg) {
  const today = mytDate(Date.now() / 1000);
  const picks = pickDailyPicks(cfg, Number(cfg.pick_count ?? 3));
  for (const p of picks) {
    const ex = db.prepare('SELECT stock, outcome FROM watchlist WHERE stock=?').get(p.code);
    if (!ex) {
      db.prepare(
        `INSERT INTO watchlist(stock, name, added_date, entry_price, signal, score, best_pct, days, outcome)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        p.code,
        p.name,
        today,
        Number(p.price.toFixed(4)),
        p.signal,
        p.score,
        0,
        0,
        'observing',
      );
    }
  }
  const list = db.prepare("SELECT * FROM watchlist WHERE outcome='observing'").all();
  const updates = [];
  for (const w of list) {
    const lv = db
      .prepare('SELECT name, price, session_date, mtime FROM live WHERE stock=?')
      .get(w.stock);
    if (
      !lv ||
      !lv.price ||
      lv.session_date !== today ||
      Date.now() / 1000 - lv.mtime > Math.max(15, cfg.poll_interval_minutes * 3) * 60
    )
      continue;
    const pct = Number((((lv.price - w.entry_price) / w.entry_price) * 100).toFixed(2));
    const best = Number(Math.max(Number(w.best_pct) || 0, pct).toFixed(2));
    const dates = db
      .prepare('SELECT date FROM daily_vol WHERE stock=? AND date>? AND date<=?')
      .all(w.stock, w.added_date, today);
    if (isMarketOpen()) dates.push({ date: today });
    const days = observationDays(dates, w.added_date, today);
    let outcome = 'observing';
    if (pct >= Number(cfg.win_pct ?? 8)) outcome = 'win';
    else if (pct <= -Number(cfg.loss_pct ?? 5)) outcome = 'loss';
    else if (days >= Number(cfg.watch_days ?? 15)) outcome = 'expired';
    db.prepare(
      'UPDATE watchlist SET best_pct=?, days=?, outcome=?, resolved_date=?, last_checked_date=?, resolved_pct=? WHERE stock=?',
    ).run(
      best,
      days,
      outcome,
      outcome === 'observing' ? null : today,
      today,
      outcome === 'observing' ? null : pct,
      w.stock,
    );
    updates.push({
      code: w.stock,
      name: lv.name || w.name || w.stock,
      entry: w.entry_price,
      price: lv.price,
      pct,
      best,
      days,
      outcome,
      added: w.added_date,
    });
  }
  updates.sort((a, b) => b.pct - a.pct);
  const tally = db.prepare('SELECT outcome, COUNT(*) c FROM watchlist GROUP BY outcome').all();
  return { picks, updates, tally };
}

let deliveryPromise = null;
function deliverOutbox(cfg) {
  if (deliveryPromise) return deliveryPromise;
  deliveryPromise = (async () => {
    if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
    const pending = db
      .prepare(
        'SELECT * FROM notification_outbox WHERE sent_at IS NULL AND cancelled_at IS NULL ORDER BY id LIMIT 5',
      )
      .all();
    for (const item of pending) {
      const result = await sendTelegramText(item.text, cfg);
      db.prepare(
        'UPDATE notification_outbox SET attempts=attempts+1,sent_at=?,last_error=? WHERE id=?',
      ).run(result.ok ? Math.floor(Date.now() / 1000) : null, result.error || null, item.id);
      if (!result.ok) break;
    }
    if (pending.length && clients.size) broadcast();
  })().finally(() => {
    deliveryPromise = null;
  });
  return deliveryPromise;
}

let broadcastPromise = null;
function runBroadcast(cfg) {
  if (broadcastPromise) return broadcastPromise;
  broadcastPromise = (async () => {
    const [dropPool, gapPool] = await Promise.all([fetchPickTop(5), fetchPickTop(3)]);
    db.exec('BEGIN IMMEDIATE');
    try {
      await evaluateAlerts(cfg);
      await evaluatePriceDrop(cfg, dropPool);
      await evaluateGapUp(cfg, gapPool);
      await evaluateDoubleBottom(cfg);
      updateWatchlist(cfg);
      bcastQueue = [];
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      bcastQueue = [];
      throw e;
    }
    await deliverOutbox(cfg);
  })().finally(() => {
    broadcastPromise = null;
  });
  return broadcastPromise;
}

async function sendTelegramText(text, cfg) {
  const token = (cfg.telegram_bot_token || '').trim();
  const chat = (cfg.telegram_chat_id || '').trim();
  if (!token || !chat) return { ok: false, error: 'Telegram 未配置' };
  try {
    // Keep a normal bulletin in one message, below Telegram's 4096-character limit.
    const chunks = [];
    let current = '';
    for (const paragraph of text.split('\n')) {
      for (let offset = 0; offset < paragraph.length || offset === 0; offset += 4000) {
        const line = paragraph.slice(offset, offset + 4000);
        if (current.length + line.length + 1 > 4000) {
          chunks.push(current);
          current = '';
        }
        current += (current ? '\n' : '') + line;
      }
    }
    if (current) chunks.push(current);
    for (const chunk of chunks) {
      const result = await tgCall(cfg, 'sendMessage', { chat_id: chat, text: chunk }, 15000);
      if (!result?.ok) return { ok: false, error: result?.description || 'Telegram 发送失败' };
    }
    return { ok: true };
  } catch (e) {
    log(`telegram 失败: ${e.message}`);
    return { ok: false, error: '网络或上游服务异常' };
  }
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
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      log(`whatsapp 失败(${to}): HTTP ${res.status} ${j.message || j.code || ''}`);
    } else {
      log(`whatsapp 已发送 → ${to}`);
    }
  } catch (e) {
    log(`whatsapp 失败(${to}): ${e.message}`);
  }
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
  const window = cfg.window;
  const nowS = Math.floor(Date.now() / 1000);
  const cooldown = Math.max(1, cfg.cooldown_minutes || 30) * 60;
  const fired = [];
  for (const m of computeMetrics(cfg)) {
    if (m.status !== 'alert') {
      db.prepare(
        'INSERT INTO state(stock, above, last_alert) VALUES(?,0,0) ON CONFLICT(stock) DO UPDATE SET above=0',
      ).run(m.code);
      continue;
    }
    const st = db.prepare('SELECT above, last_alert FROM state WHERE stock=?').get(m.code);
    const wasAbove = st?.above || 0;
    let lastAlert = st?.last_alert || 0;
    let should = false;
    if (!wasAbove && nowS - lastAlert >= cooldown) {
      should = true;
      lastAlert = nowS;
    }
    const above = should || wasAbove ? 1 : 0;
    db.prepare(
      'INSERT INTO state(stock, above, last_alert) VALUES(?,?,?) ON CONFLICT(stock) DO UPDATE SET above=excluded.above, last_alert=excluded.last_alert',
    ).run(m.code, above, lastAlert);
    if (should) {
      fired.push(m);
      recordAlert(
        m.code,
        m.name,
        'volume',
        `时段成交量是上一时段的 ${(m.ratio / 100).toFixed(2)} 倍。`,
        m,
      );
    }
  }
  if (fired.length) {
    const lines = fired
      .slice(0, 30)
      .map(
        (m) =>
          `• ${m.name} (${m.code}) 价 ${m.price ?? '-'} · 放量 ${m.ratio.toFixed(1)}%\n  ${m.curLabel} ${fmtNum(m.current)} vs ${m.prevLabel} ${fmtNum(m.previous)} · 4W ${fmtNum(m.avg4w)} / 5D ${fmtNum(m.avg5d)}`,
      );
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    pushBroadcast('📊', '放量异动', lines.slice(0, 12).join('\n\n'), fired.length);
  }
}

// ---------------- 双底(W底/N字底)形态识别 ----------------
// 结构: A(低点1) → B(颈线, A~C之间最高) → C(低点2, 不深破A) → 突破B = 买点
// 参考经典 W 底定义(Bulkowski) + 突破放量确认 + 峰谷宽度/高度约束(李进财N字理论)
function findDoubleBottom(code, cfg, suppliedRows) {
  const rows = (
    suppliedRows ||
    db
      .prepare(
        `SELECT date, open, high, low, close, volume FROM daily_vol
    WHERE stock=? AND low IS NOT NULL AND high IS NOT NULL AND close IS NOT NULL
    ORDER BY date ASC`,
      )
      .all(code)
  ).filter((r) => r.low > 0 && r.high > 0 && r.close > 0 && r.date <= marketDate());
  if (rows.length < 45) return null;

  const k = 3; // 摆动点判定窗口(左右各3根)
  const tolPct = Number(cfg.db_tol ?? 5); // 两底价格相近容忍 %
  const minGap = Number(cfg.db_min_gap ?? 15); // 两底最少间隔(交易日)
  const maxGap = Number(cfg.db_max_gap ?? 80); // 最多间隔
  const minNeck = Number(cfg.db_min_neck ?? 5); // 颈线相对低点至少高 %
  const freshDays = Number(cfg.db_fresh ?? 5); // 突破要在最近 N 天内

  // 1. 找摆动低点/高点(局部极值)
  const lows = [];
  for (let i = k; i < rows.length - k; i++) {
    const w = rows.slice(i - k, i + k + 1);
    if (rows[i].low === Math.min(...w.map((x) => x.low)))
      lows.push({ i, p: rows[i].low, d: rows[i].date });
  }
  if (lows.length < 2) return null;

  const last = rows.length - 1;

  // 2. 从最近的摆动低点开始配对(C = 较近的低点)
  for (let ci = lows.length - 1; ci >= 1; ci--) {
    const C = lows[ci];
    if (last - C.i > maxGap) break; // C 太老就不必再往前
    for (let ai = ci - 1; ai >= 0; ai--) {
      const A = lows[ai];
      const gap = C.i - A.i;
      if (gap < minGap) continue;
      if (gap > maxGap) break;
      const diffPct = (Math.abs(C.p - A.p) / A.p) * 100; // 两底价差
      if (diffPct > tolPct) continue;
      // 颈线 B = A、C 之间的最高点
      const between = rows.slice(A.i + 1, C.i);
      if (!between.length) continue;
      const B = between.reduce((mx, x) => (x.high > mx.high ? x : mx), between[0]);
      const base = Math.min(A.p, C.p);
      const neckUp = ((B.high - base) / base) * 100;
      if (neckUp < minNeck) continue;
      // 突破: C 之后出现收盘价站上颈线
      const after = rows.slice(C.i + 1);
      const bIdx = after.findIndex((x) => x.close > B.high * 1.005);
      if (bIdx < 0) continue;
      const barsSince = after.length - 1 - bIdx;
      if (barsSince > freshDays) continue; // 只要新鲜突破
      // 关键: 现价必须仍站在颈线上方, 否则就是「突破后回落」的假信号
      const nowClose = rows[rows.length - 1].close;
      if (nowClose < B.high) continue;

      // 3. 评分(0~100) —— 容错靠这里
      const brk = after[bIdx];
      const pre = rows.slice(Math.max(0, C.i + 1 + bIdx - 5), C.i + 1 + bIdx);
      const avg5 = pre.length ? pre.reduce((s, x) => s + (x.volume || 0), 0) / pre.length : 0;
      const vr = avg5 > 0 ? (brk.volume || 0) / avg5 : 0; // 突破放量倍数
      const brkPct = ((today_close_last(rows) - B.high) / B.high) * 100; // 现价超出颈线 %

      let score = 0;
      score += 30 * Math.max(0, 1 - diffPct / tolPct); // 两底越接近越好 (30)
      score += 20 * Math.min(1, neckUp / 15); // 颈线越高越好 (20)
      score += 15 * (gap >= 20 && gap <= 60 ? 1 : Math.max(0, 1 - Math.abs(gap - 40) / 40)); // 间隔合理 (15)
      score += 25 * Math.min(1, vr / 1.5); // 突破放量 (25)
      score += 10 * Math.min(1, Math.max(0, brkPct) / 3); // 突破幅度 (10)
      score = Math.round(score);

      const hgt = B.high - base; // 形态高度
      // 止损: 形态低点下方2% 与 颈线下方3% 取更近者(实盘用颈部破位止损更好执行)
      const stop = Math.max(base * 0.98, B.high * 0.97);
      // 量度目标固定为颈线 + 形态高度，达到后不再向上延伸
      const target1 = B.high + hgt;
      return {
        A,
        B,
        C,
        breakDate: brk.date,
        breakClose: brk.close,
        price: rows[last].close,
        neck: B.high,
        score,
        diffPct,
        gap,
        neckUp,
        vr,
        brkPct,
        stop,
        target1,
        barsSince,
      };
    }
  }
  return null;
}
function today_close_last(rows) {
  return rows[rows.length - 1].close;
}

// 双底突破通知: 只在开市时段, 每只股票每个颈线只报一次
async function evaluateDoubleBottom(cfg) {
  if (!isMarketOpen()) return;
  const minScore = Number(cfg.db_min_score ?? 70);
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  const list = db.prepare('SELECT stock FROM universe WHERE code IS NOT NULL').all();
  const fired = [];
  for (const r of list) {
    let pat;
    try {
      pat = findDoubleBottom(r.stock, cfg);
    } catch {
      pat = null;
    }
    if (!pat || pat.score < minScore) continue;
    const live = db.prepare('SELECT price,session_date,mtime FROM live WHERE stock=?').get(r.stock);
    if (
      !live ||
      live.session_date !== marketDate() ||
      Date.now() / 1000 - live.mtime > Math.max(15, cfg.poll_interval_minutes * 3) * 60 ||
      live.price < pat.neck
    )
      continue;
    pat.price = live.price;
    const rr = pat.price > pat.stop ? (pat.target1 - pat.price) / (pat.price - pat.stop) : 0;
    if (rr < Number(cfg.db_min_rr ?? 1.0)) continue; // 盈亏比不达标不推
    const key = `${r.stock}|${pat.neck.toFixed(3)}|${pat.breakDate}`;
    if (db.prepare('SELECT 1 FROM db_bottom_alert WHERE key=?').get(key)) continue;
    db.prepare(
      'INSERT INTO db_bottom_alert(key, stock, date, ts) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING',
    ).run(key, r.stock, date, nowS);
    const nm =
      db.prepare('SELECT name FROM live WHERE stock=?').get(r.stock)?.name ||
      db.prepare('SELECT name FROM universe WHERE stock=?').get(r.stock)?.name;
    fired.push({ ...pat, code: r.stock, name: nm || r.stock });
    recordAlert(
      r.stock,
      nm || r.stock,
      'pattern',
      `近期日线越过压力位 RM ${pat.neck.toFixed(3)}；继续观察能否守住。`,
    );
  }
  if (fired.length) {
    fired.sort((a, b) => b.score - a.score);
    const blocks = fired.slice(0, 15).map((x) => {
      const risk = ((x.price - x.stop) / x.price) * 100; // 到止损的空间
      const rew = ((x.target1 - x.price) / x.price) * 100; // 到目标的空门
      const rr = risk > 0 ? rew / risk : 0; // 盈亏比
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
    pushBroadcast('🎯', '双底突破 · 观察信号', blocks.slice(0, 6).join('\n\n'), fired.length);
  }
}

// 股价暴跌提醒: 当日跌幅 top 30 里, 现价较昨收跌幅 >= 阈值% → Telegram 群 (开市时段, 每天每只最多一次)
async function evaluatePriceDrop(cfg, suppliedPool) {
  if (!isMarketOpen()) return;
  const lo = Number(cfg.price_drop_threshold ?? 40); // 区间下限
  const hi = Number(cfg.price_drop_threshold_high ?? 50); // 区间上限
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  // 候选池 = pickastock 的 Loss% 榜 top30 (拿不到就退回用自己数据按跌幅排序)
  let pool = suppliedPool === undefined ? await fetchPickTop(5) : suppliedPool;
  if (!pool) {
    pool = db
      .prepare(
        `SELECT stock AS code, price, open AS ref, volume,
        (price - open) * 100.0 / open AS pct
      FROM live WHERE price IS NOT NULL AND open IS NOT NULL AND open > 0
      ORDER BY pct ASC LIMIT 30`,
      )
      .all();
  }
  const fired = [];
  for (const l of pool) {
    const drop = -l.pct; // 取正数跌幅
    if (drop < lo || drop > hi) continue; // 只推 [下限, 上限] 区间内
    const nm =
      db.prepare('SELECT name FROM live WHERE stock=?').get(l.code)?.name ||
      db.prepare('SELECT name FROM universe WHERE stock=?').get(l.code)?.name;
    const sent = db
      .prepare('SELECT 1 FROM price_drop_alert WHERE stock=? AND date=?')
      .get(l.code, date);
    if (sent) continue;
    db.prepare(
      'INSERT INTO price_drop_alert(stock, date, ts) VALUES(?,?,?) ON CONFLICT(stock, date) DO NOTHING',
    ).run(l.code, date, nowS);
    const av = getAvgVolumes(l.code);
    fired.push({
      name: nm || l.code,
      stock: l.code,
      price: l.price,
      ref: l.ref,
      drop,
      avg4w: av.avg4w,
      avg5d: av.avg5d,
    });
    recordAlert(
      l.code,
      nm || l.code,
      'drop',
      `相对开盘价下跌 ${drop.toFixed(1)}%；下跌本身不是买入依据。`,
    );
  }
  if (fired.length) {
    const lines = fired
      .slice(0, 30)
      .map(
        (x) =>
          `• ${x.name} (${x.stock}) 现价 ${x.price} · 跌 ${x.drop.toFixed(1)}%\n  开盘 ${x.ref} · 4W ${fmtNum(x.avg4w)} / 5D ${fmtNum(x.avg5d)}`,
      );
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    pushBroadcast('🔴', '暴跌异动', lines.slice(0, 10).join('\n'), fired.length);
  }
}

// 开盘急涨提醒: pickastock 成交量榜 top30 里, 相对开盘涨幅落在 [下限, 上限] 区间 → Telegram 群
async function evaluateGapUp(cfg, suppliedPool) {
  if (!isMarketOpen()) return;
  const lo = Number(cfg.gap_up_threshold ?? 5); // 区间下限%
  const hi = Number(cfg.gap_up_threshold_high ?? 7); // 区间上限%
  const date = mytDate(Date.now() / 1000);
  const nowS = Math.floor(Date.now() / 1000);
  // 候选池 = pickastock 的 Gain% 涨幅榜 top30 (拿不到就退回用自己数据按涨幅排序)
  let pool = suppliedPool === undefined ? await fetchPickTop(3) : suppliedPool;
  if (!pool) {
    pool = db
      .prepare(
        `SELECT stock AS code, price, open AS ref, volume,
        CASE WHEN open > 0 THEN (price - open) * 100.0 / open ELSE NULL END AS pct
      FROM live WHERE open IS NOT NULL AND open > 0 ORDER BY pct DESC LIMIT 30`,
      )
      .all();
  }
  const fired = [];
  for (const l of pool) {
    if (l.pct == null) continue;
    const gain = l.pct;
    if (gain < lo || gain > hi) continue; // 只推 [下限, 上限] 区间内
    const nm =
      db.prepare('SELECT name FROM live WHERE stock=?').get(l.code)?.name ||
      db.prepare('SELECT name FROM universe WHERE stock=?').get(l.code)?.name;
    const sent = db
      .prepare('SELECT 1 FROM gap_up_alert WHERE stock=? AND date=?')
      .get(l.code, date);
    if (sent) continue;
    db.prepare(
      'INSERT INTO gap_up_alert(stock, date, ts) VALUES(?,?,?) ON CONFLICT(stock, date) DO NOTHING',
    ).run(l.code, date, nowS);
    const av = getAvgVolumes(l.code);
    fired.push({
      name: nm || l.code,
      stock: l.code,
      price: l.price,
      open: l.ref,
      gain,
      avg4w: av.avg4w,
      avg5d: av.avg5d,
    });
    recordAlert(
      l.code,
      nm || l.code,
      'rise',
      `相对开盘价上涨 ${gain.toFixed(1)}%；需要继续核对成交量和公司公告。`,
    );
  }
  if (fired.length) {
    const lines = fired
      .slice(0, 30)
      .map(
        (x) =>
          `• ${x.name} (${x.stock}) 现价 ${x.price} · 涨 ${x.gain.toFixed(1)}%\n  开盘 ${x.open} · 4W ${fmtNum(x.avg4w)} / 5D ${fmtNum(x.avg5d)}`,
      );
    const more = fired.length > 30 ? `\n…等共 ${fired.length} 只` : '';
    pushBroadcast('🟢', '急涨异动', lines.slice(0, 10).join('\n'), fired.length);
  }
}

// ---------------- 市场时段 ----------------
function isMarketOpen() {
  return sessionStart(Date.now() / 1000, loadConfig().market_holidays || []) != null;
}

// ---------------- 调度 ----------------
let backfilled = false;
let lastPoll = Number(kvGet('last_successful_poll', 0)) || null;
let lastPollError = null;
let pollPromise = null;

function poll(backfill = false) {
  if (pollPromise) return pollPromise; // 复用进行中的抓取
  pollPromise = (async () => {
    try {
      const cfg = loadConfig();
      const quotes = await fetchMarket();
      if (!quotes.length) throw new Error('行情接口没有返回有效股票数据');
      storeUniverse(quotes);
      for (const q of quotes) {
        updateQuote(q, cfg);
        recordVolume(q.ticker, q.volume);
        // 注意: 不再调用 recordDailyVolume —— 它写的是「盘中某刻的累计量」而非收盘总量,
        // 会污染 daily_vol 的昨日量(导致放量对比失真)。daily_vol 只由 Yahoo 回填(backfillDailyVol)写入。
      }
      const cnt = db.prepare('SELECT COUNT(*) c FROM universe').get().c;
      persistPotentialEvents();
      if (historyRefreshQueue().length)
        backfillDailyVol()
          .then(broadcast)
          .catch((e) => log('补齐缺失日线失败: ' + e.message));
      if (isMarketOpen()) await runBroadcast(cfg);
      prune();
      lastPoll = Date.now() / 1000;
      kvSet('last_successful_poll', lastPoll);
      lastPollError = null;
      log(`全市场抓取完成 (${cnt} 只)`);
      broadcast();
    } catch (e) {
      lastPollError = '行情更新失败，正在保留最近的快照。';
      log(`轮询失败: ${e.message}`);
    } finally {
      pollPromise = null;
    }
  })();
  return pollPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 节流即时抓取: 数据陈旧(超过轮询间隔)才真正抓 Yahoo, 否则直接用缓存
async function maybePoll() {
  if (pollPromise) await pollPromise; // 正在抓, 等它完成
  const cfg = loadConfig();
  const interval = Math.max(1, cfg.poll_interval_minutes || 5) * 60;
  if (lastPoll && Date.now() / 1000 - lastPoll < interval) return;
  if (!isMarketOpen() && lastPoll) return; // 休市且已抓过, 不重复抓
  await poll();
}

// 后台定时抓取(开市时段): 无人值守也能自动追踪 + 提醒
let pollTimer = null;
let lastBackfillDate = null;
function maybeBackfill() {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // UTC+8
  const hm = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);
  if (hm >= 17 * 60 && lastBackfillDate !== dateStr) {
    // 每天 17:00(收盘后)回填昨日量
    lastBackfillDate = dateStr;
    backfillDailyVol()
      .then(broadcast)
      .catch((e) => log('自动回填失败: ' + e.message));
  }
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (isMarketOpen()) maybePoll(); // 内部有节流, 数据陈旧才真抓
    maybeBackfill(); // 收盘后回填昨日量
    deliverOutbox(loadConfig()).catch((e) => log('通知重试失败: ' + e.message));
  }, 60 * 1000);
  // Telegram 指令轮询: 独立 5 秒 tick, 内部是 25 秒长轮询(有锁防重入), 所以收消息很跟手
  // 不受开市时间限制 —— 用户随时都能问
  setInterval(() => {
    pollTelegram();
  }, 5000);
  pollTelegram();
  setInterval(() => {
    maybeFinalBriefings().catch((e) => log('定时通报失败: ' + e.message));
  }, 15000);
  maybeFinalBriefings().catch((e) => log('定时通报启动检查失败: ' + e.message));
}

function recordFinalBriefing(slot, cfg = loadConfig(), now = Date.now() / 1000) {
  return recordScheduledBriefing(slot, cfg, now, true);
}

function recordHalfHourBriefing(slot, cfg = loadConfig(), now = Date.now() / 1000) {
  return recordScheduledBriefing(slot, cfg, now, false);
}

function pendingBriefingUpdates(date, items) {
  const saved = JSON.parse(kvGet('briefing_update_cursor', '{}'));
  const cursor = saved.date === date ? saved : { date, alert_id: 0, observations: [] };
  const reported = new Set(cursor.observations);
  const observations = db
    .prepare(
      "SELECT stock,outcome,added_date,resolved_pct FROM watchlist WHERE resolved_date=? AND outcome<>'observing'",
    )
    .all(date)
    .filter((r) => !reported.has(r.stock + '|' + r.added_date + '|' + r.outcome));
  const alerts = db
    .prepare('SELECT id,stock,kind,message FROM alerts WHERE ts>=? AND id>? ORDER BY id DESC')
    .all(slotTimestamp(date, '00:00'), cursor.alert_id);
  const selected = new Set(items.map((r) => r.code));
  const extraAlerts = alerts.filter((r) => !selected.has(r.stock));
  const labels = { win: '涨幅达标', loss: '跌幅触发', expired: '观察到期' };
  return {
    updates: {
      observations: observations
        .slice(0, 3)
        .map((r) => ({ code: r.stock, label: labels[r.outcome], pct: r.resolved_pct })),
      observation_count: observations.length,
      alerts: extraAlerts
        .slice(0, 3)
        .map((r) => ({ code: r.stock, message: String(r.message || '').slice(0, 100) })),
      alert_count: extraAlerts.length,
    },
    cursor: {
      date,
      alert_id: alerts[0]?.id || cursor.alert_id,
      observations: [
        ...reported,
        ...observations.map((r) => r.stock + '|' + r.added_date + '|' + r.outcome),
      ],
    },
  };
}

function recordScheduledBriefing(slot, cfg, now, closing) {
  const date = marketDate(now);
  const completed = db
    .prepare('SELECT slot FROM closing_briefings WHERE date=?')
    .all(date)
    .map((r) => r.slot);
  const due = closing ? dueBriefingSlots : dueHalfHourSlots;
  if (!due(cfg, completed, now).includes(slot)) return null;
  getAnalysisOverview(cfg);
  const scan = analysisCache.data.coverage;
  // A complete scan fetched after this slot is required, even for an empty bulletin.
  if (
    !scan.scan_at ||
    scan.scan_at < slotTimestamp(date, slot) ||
    scan.scan_at > now ||
    now - scan.scan_at > 180 ||
    scan.expected !== scan.received
  )
    return null;
  const pick = closing ? finalCandidates : halfHourCandidates;
  const items = pick(analysisCache.ranked, cfg, slot, now).map((r) => ({
    code: r.code,
    name: r.name,
    price: r.price,
    volume: r.volume,
    previous_volume: r.volume_signal.previous,
    previous_date: r.volume_signal.previous_date,
    multiple: r.volume_signal.multiple,
    stage: r.stage,
    reason: conciseReason(r),
    resistance: r.potential_signal.resistance,
    support: r.potential_signal.support,
    quote_at: r.fetched_at,
  }));
  const record = {
    date,
    slot,
    created_at: now,
    quote_at: scan.scan_at,
    status: items.length ? 'ready' : 'empty',
    items,
    minimum_multiple: Math.max(closing ? 3 : 2, cfg.screen_vol_mult || 2),
  };
  const pending = pendingBriefingUpdates(date, items);
  record.updates = pending.updates;
  const format = closing ? formatBriefing : formatHalfHourBriefing;
  const text = format(record, process.env.PUBLIC_URL || 'https://synthe-fantasia.site/');
  db.exec('BEGIN IMMEDIATE');
  try {
    let outboxId = null;
    if (cfg.final_briefing_telegram !== false && cfg.telegram_bot_token && cfg.telegram_chat_id) {
      outboxId = Number(
        db
          .prepare('INSERT INTO notification_outbox(ts,text) VALUES(?,?)')
          .run(Math.floor(now), text).lastInsertRowid,
      );
    }
    db.prepare(
      'INSERT INTO closing_briefings(date,slot,created_at,quote_at,status,items,text,outbox_id,minimum_multiple,updates) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      date,
      slot,
      now,
      scan.scan_at,
      record.status,
      JSON.stringify(items),
      text,
      outboxId,
      record.minimum_multiple,
      JSON.stringify(record.updates),
    );
    kvSet('briefing_update_cursor', JSON.stringify(pending.cursor));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return record;
}

let finalBriefingPromise = null;
function maybeFinalBriefings() {
  if (finalBriefingPromise) return finalBriefingPromise;
  finalBriefingPromise = (async () => {
    const cfg = loadConfig(),
      date = marketDate();
    const done = db
      .prepare('SELECT slot FROM closing_briefings WHERE date=?')
      .all(date)
      .map((r) => r.slot);
    const slots = [...dueHalfHourSlots(cfg, done), ...dueBriefingSlots(cfg, done)];
    if (!slots.length) return;
    await poll(); // force a fresh whole-market scan at the slot, independent of normal polling.
    let recorded = false;
    const currentCfg = loadConfig();
    for (const slot of slots) {
      const record = BRIEFING_SLOTS.includes(slot) ? recordFinalBriefing : recordHalfHourBriefing;
      if (record(slot, currentCfg)) recorded = true;
    }
    if (recorded) broadcast();
    await deliverOutbox(currentCfg);
  })().finally(() => {
    finalBriefingPromise = null;
  });
  return finalBriefingPromise;
}

function closingBriefingState(cfg = loadConfig()) {
  const date = marketDate(),
    now = Date.now() / 1000;
  const records = db
    .prepare(
      "SELECT * FROM closing_briefings WHERE slot IN ('16:00','16:30') ORDER BY date DESC,slot DESC LIMIT 12",
    )
    .all()
    .map((r) => ({
      ...r,
      items: JSON.parse(r.items),
      updates: JSON.parse(r.updates || '{}'),
      text: undefined,
      outbox_id: undefined,
    }));
  const today = records.filter((r) => r.date === date);
  const previous = records.filter((r) => r.date < date);
  const seen = new Set(),
    follow = [];
  for (const record of previous)
    for (const item of record.items) {
      const key = record.date + '|' + item.code;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = nextTradingDate(record.date, cfg.market_holidays || []);
      const completed = target < date || (target === date && now >= slotTimestamp(date, '17:00'));
      const bar = completed
        ? db
            .prepare('SELECT close FROM daily_vol WHERE stock=? AND date=? AND close>0')
            .get(item.code, target)
        : null;
      const live = db
        .prepare('SELECT price,session_date,mtime FROM live WHERE stock=?')
        .get(item.code);
      const intraday =
        !bar &&
        target === date &&
        live?.session_date === date &&
        live.price > 0 &&
        now - live.mtime <= 900;
      const observed = bar?.close || (intraday ? live.price : null);
      follow.push({
        code: item.code,
        date: record.date,
        slot: record.slot,
        reference_price: item.price,
        next_date: target,
        price: observed,
        change_pct: observed ? +((observed / item.price - 1) * 100).toFixed(2) : null,
        status: bar
          ? '次日收盘'
          : intraday
            ? '次日盘中'
            : target > date
              ? '等待次日'
              : '资料待更新',
      });
    }
  const windows = Object.fromEntries(
    BRIEFING_SLOTS.map((slot) => [
      slot,
      cfg.final_briefing_on === false
        ? '已暂停'
        : !tradingDay(date, cfg.market_holidays || [])
          ? '休市'
          : today.some((r) => r.slot === slot)
            ? '已通报'
            : now < slotTimestamp(date, slot)
              ? '待通报'
              : now < slotTimestamp(date, slot) + 600
                ? '正在准备'
                : '已过时点',
    ]),
  );
  return {
    date,
    slots: BRIEFING_SLOTS,
    windows,
    minimum_multiple: Math.max(3, cfg.screen_vol_mult || 2),
    enabled: cfg.final_briefing_on !== false,
    telegram:
      cfg.final_briefing_telegram !== false && !!(cfg.telegram_bot_token && cfg.telegram_chat_id),
    today,
    latest: records[0] || null,
    follow: follow.slice(0, 12),
  };
}

function halfHourBriefingState(cfg = loadConfig()) {
  const date = marketDate(),
    now = Date.now() / 1000;
  const row = db
    .prepare(
      `SELECT b.*,o.sent_at,o.attempts FROM closing_briefings b
    LEFT JOIN notification_outbox o ON o.id=b.outbox_id
    ORDER BY b.date DESC,b.slot DESC LIMIT 1`,
    )
    .get();
  const latest = row
    ? {
        date: row.date,
        slot: row.slot,
        quote_at: row.quote_at,
        status: row.status,
        items: JSON.parse(row.items),
        updates: JSON.parse(row.updates || '{}'),
        minimum_multiple: row.minimum_multiple,
        delivery: row.outbox_id
          ? row.sent_at
            ? 'Telegram已发送'
            : row.attempts
              ? '发送重试中'
              : '等待发送'
          : '仅网页',
      }
    : null;
  const enabled = cfg.half_hour_briefing_on !== false;
  const schedule = [
    ...(enabled ? HALF_HOUR_SLOTS : []),
    ...(cfg.final_briefing_on !== false ? BRIEFING_SLOTS : []),
  ];
  const next = tradingDay(date, cfg.market_holidays || [])
    ? schedule.find((slot) => slotTimestamp(date, slot) > now) || null
    : null;
  return { date, enabled, next_slot: next, latest };
}

// ---------------- SSE ----------------
const clients = new Set();

function broadcast() {
  const data = `data: ${JSON.stringify(buildState())}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {}
  }
}

// ---------------- State ----------------
function recordAlert(stock, name, kind, message, metrics = {}) {
  db.prepare(
    'INSERT INTO alerts(ts,stock,name,window,current,previous,ratio,direction,kind,message) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    Math.floor(Date.now() / 1000),
    stock,
    name,
    loadConfig().window,
    metrics.current ?? null,
    metrics.previous ?? null,
    metrics.ratio ?? null,
    'surge',
    kind,
    message,
  );
}

function getStockReport(query, cfg = loadConfig()) {
  const upper = String(query).toUpperCase();
  const live = db
    .prepare(
      `SELECT live.*,universe.stock,universe.name,universe.code AS numeric_code FROM universe LEFT JOIN live ON universe.stock=live.stock
    WHERE UPPER(universe.stock)=? OR universe.code=? LIMIT 1`,
    )
    .get(upper, upper);
  if (!live) return null;
  const rows = db
    .prepare(
      'SELECT date,open,high,low,close,volume FROM daily_vol WHERE stock=? AND date<=? AND close>0 ORDER BY date',
    )
    .all(live.stock, marketDate());
  const pattern = findDoubleBottom(live.stock, cfg, rows);
  const report = {
    ...explainStock({ stock: live, rows, pattern, cfg }),
    numeric_code: live.numeric_code,
    history: rows.slice(-90),
  };
  getAnalysisOverview(cfg);
  return {
    ...report,
    selection: analysisCache.decisions.get(report.code) || {
      eligible: false,
      selected: false,
      reason: '当前股票池没有这只股票的有效行情。',
    },
  };
}

function getAnalysisOverview(cfg) {
  if (analysisCache && Date.now() - analysisCache.ts < 60000) return analysisCache.data;
  const rows = db
    .prepare(
      'SELECT stock,date,open,high,low,close,volume FROM daily_vol WHERE close>0 AND date<=? ORDER BY stock,date',
    )
    .all(marketDate());
  const by = new Map();
  for (const row of rows) {
    if (!by.has(row.stock)) by.set(row.stock, []);
    by.get(row.stock).push(row);
  }
  const reports = db
    .prepare(
      'SELECT live.*,universe.stock,universe.name,universe.code AS numeric_code,universe.history_error,universe.history_success FROM universe LEFT JOIN live ON universe.stock=live.stock WHERE universe.active=1',
    )
    .all()
    .map((stock) => {
      const history = by.get(stock.stock) || [];
      return explainStock({
        stock,
        rows: history,
        pattern: findDoubleBottom(stock.stock, cfg, history),
        cfg,
      });
    });
  const snapshotDate =
    reports
      .map((r) => r.quote_date)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  // The shortlist uses one market date; old or delisted quotes must not fill current slots.
  const candidates = reports
    .filter((r) => r.potential_eligible && r.quote_date === snapshotDate)
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        (b.potential_signal?.average_multiple || 0) - (a.potential_signal?.average_multiple || 0) ||
        (b.volume_signal.multiple || 0) - (a.volume_signal.multiple || 0) ||
        b.evidence_count - a.evidence_count ||
        (b.pattern?.score || 0) - (a.pattern?.score || 0) ||
        (b.levels?.rr || 0) - (a.levels?.rr || 0) ||
        (b.metrics?.vr || 0) - (a.metrics?.vr || 0),
    );
  const limit = Math.max(1, Math.min(5, Number(cfg.pick_count) || 3));
  const rank = new Map(candidates.map((r, i) => [r.code, i + 1]));
  const decisions = new Map(
    reports.map((r) => [
      r.code,
      {
        eligible: rank.has(r.code),
        rank: rank.get(r.code) || null,
        selected: (rank.get(r.code) || Infinity) <= limit,
        reason: rank.has(r.code)
          ? rank.get(r.code) <= limit
            ? '已进入当前重点精选。'
            : `信号达标，当前排名第${rank.get(r.code)}，首页只显示前${limit}只；仍持续跟踪。`
          : ['stale', 'insufficient'].includes(r.stage)
            ? r.conclusion
            : !r.volume_signal.pass
              ? `${r.volume_signal.title}。${r.tracking_signal ? '此前信号仍在重点追踪池。' : ''}`
              : ['extended', 'tracking'].includes(r.stage)
                ? '信号已经出现，但价格已明显拉升或本次条件未全部满足；保留追踪，等待新的参与条件。'
                : '放量已达标，但尚未满足蓄势、转强或突破路径的价格与资料条件。',
      },
    ]),
  );
  const tracking = reports
    .filter(
      (r) =>
        r.quote_date === snapshotDate &&
        r.tracking_signal &&
        !['stale', 'insufficient'].includes(r.stage) &&
        r.price >= r.tracking_signal.support,
    )
    .sort(
      (a, b) =>
        Number(b.tracking_signal.kind === 'breakout') -
          Number(a.tracking_signal.kind === 'breakout') ||
        (b.change_pct || 0) - (a.change_pct || 0) ||
        a.tracking_signal.age - b.tracking_signal.age ||
        b.tracking_signal.average_multiple - a.tracking_signal.average_multiple,
    );
  const follow = tracking.filter((r) => !candidates.slice(0, limit).some((c) => c.code === r.code));
  const universe = db
    .prepare(
      'SELECT universe.*,live.price,live.mtime FROM universe LEFT JOIN live ON live.stock=universe.stock WHERE universe.active=1',
    )
    .all();
  const staleCodes = new Set(reports.filter((r) => r.stage === 'stale').map((r) => r.code));
  const scan = JSON.parse(kvGet('market_scan_coverage', 'null') || 'null');
  const expectedHistory = completedMarketDate(cfg);
  const health = universe.map((u) => {
    const bars = by.get(u.stock) || [],
      prior = bars.filter((r) => r.date < snapshotDate && r.volume > 0),
      latest = bars.at(-1)?.date || null;
    return {
      code: u.stock,
      name: u.name,
      mapped: !!u.code,
      bars: prior.length,
      last_date: latest,
      error: u.history_error,
      reason: !u.price
        ? '缺少有效行情'
        : !u.code
          ? '数字代码待映射'
          : !bars.length
            ? '日线待回填'
            : prior.length < 20
              ? '完整交易日不足20个'
              : staleCodes.has(u.stock)
                ? '行情或日线已过期'
                : !bars.slice(-10).every((r) => r.high >= r.close && r.low > 0 && r.low <= r.close)
                  ? '高低价资料待补齐'
                  : u.history_error
                    ? '最近回填失败，正在重试'
                    : latest < expectedHistory
                      ? '近期日线有缺口或无成交'
                      : null,
    };
  });
  const coverage = {
    expected: scan?.expected || universe.length,
    received: scan?.received || universe.length,
    quoted: scan?.valid ?? universe.filter((u) => u.price > 0).length,
    analyzed: reports.length,
    history_ready: health.filter((h) => h.bars >= 20).length,
    ready: health.filter((h) => !h.reason).length,
    unmapped: health.filter((h) => !h.mapped).length,
    missing_history: health.filter((h) => !h.last_date).length,
    insufficient_history: health.filter((h) => h.bars > 0 && h.bars < 20).length,
    inactive: db.prepare('SELECT COUNT(*) c FROM universe WHERE active=0').get().c,
    scan_at: scan?.at || null,
    stale_quotes: staleCodes.size,
    expected_history_date: expectedHistory,
    issues: health.filter((h) => h.reason),
    history_errors: health.filter((h) => h.error).length,
  };
  const data = {
    candidates: candidates.slice(0, limit),
    limit,
    confirmed: candidates.length,
    coiled: candidates.filter((r) => r.stage === 'coiled').length,
    breakout: candidates.filter((r) => r.stage === 'confirmed').length,
    building: candidates.filter((r) => r.stage === 'building').length,
    tracking: follow.slice(0, 3),
    tracking_count: tracking.length,
    coverage,
    volume_qualified: reports.filter(
      (r) =>
        r.volume_signal.pass &&
        r.quote_date === snapshotDate &&
        !['stale', 'insufficient'].includes(r.stage),
    ).length,
    scanned: reports.length,
    snapshot_date: snapshotDate,
    historical: reports.filter((r) => r.stage === 'stale').length,
    covered: reports.filter((r) => !!r.metrics).length,
    rule: '分别识别放量蓄势、回调整理后的放量转强、放量突破三条路径。当前精选须百万股及昨日两倍量同时达标，价格未明显拉升。过去已达标的信号另行持续追踪，不因今天量倍数下降而消失。',
  };
  analysisCache = { ts: Date.now(), data, reports, decisions, tracking, ranked: candidates };
  return data;
}

function persistPotentialEvents(cfg = loadConfig()) {
  getAnalysisOverview(cfg);
  const insert =
    db.prepare(`INSERT INTO potential_events(stock,date,kind,first_seen,last_seen,signal) VALUES(?,?,?,?,?,?)
    ON CONFLICT(stock,date,kind) DO UPDATE SET last_seen=excluded.last_seen,signal=excluded.signal`);
  const now = Date.now() / 1000;
  db.exec('BEGIN');
  try {
    for (const report of analysisCache.reports) {
      for (const signal of [report.potential_signal, ...report.recent_signals].filter(Boolean))
        insert.run(report.code, signal.date, signal.kind, now, now, JSON.stringify(signal));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function observationState() {
  const list = db
    .prepare(
      `SELECT w.*,l.price,l.session_date FROM watchlist w LEFT JOIN live l ON l.stock=w.stock ORDER BY w.added_date DESC`,
    )
    .all();
  return {
    list: list.map((w) => ({
      ...w,
      pct:
        w.price > 0 && w.entry_price > 0 ? +((w.price / w.entry_price - 1) * 100).toFixed(2) : null,
    })),
    tally: db.prepare('SELECT outcome,COUNT(*) c FROM watchlist GROUP BY outcome').all(),
    note: '规则观察记录不等于实盘收益；未计费用和滑点，旧版记录可能受计天错误影响。',
  };
}

function buildState() {
  // 安全: settings 里永远不含 api key
  const cfg = loadConfig();
  const universeCount = db.prepare('SELECT COUNT(*) c FROM universe WHERE active=1').get().c;
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
      llm_ready: !!(cfg.llm_api_key || '').trim(),
      pick_count: cfg.pick_count ?? 3,
      min_average_daily_value: cfg.min_average_daily_value ?? 200000,
      final_briefing_on: cfg.final_briefing_on !== false,
      half_hour_briefing_on: cfg.half_hour_briefing_on !== false,
      final_briefing_telegram: cfg.final_briefing_telegram !== false,
      win_pct: cfg.win_pct ?? 8,
      loss_pct: cfg.loss_pct ?? 5,
      watch_days: cfg.watch_days ?? 15,
      screen_on: cfg.screen_on !== false,
      screen_min_gain: cfg.screen_min_gain ?? 15,
      screen_max_gain: cfg.screen_max_gain ?? 25,
      screen_vol_mult: Math.max(2, cfg.screen_vol_mult ?? 2),
      screen_min_volume: Math.max(1000000, cfg.screen_min_volume ?? 1000000),
    },
    watchlist: cfg.watchlist,
    price_thresholds: cfg.price_thresholds || [],
    stocks: computeMetrics(cfg),
    insights: getAnalysisOverview(cfg),
    observations: observationState(),
    closing_briefings: closingBriefingState(cfg),
    half_hour_briefing: halfHourBriefingState(cfg),
    alerts: db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 50').all(),
    admin_enabled: !!process.env.ADMIN_TOKEN,
    status: {
      market_open: isMarketOpen(),
      lunch_break: isLunchBreak(Date.now() / 1000, cfg.market_holidays || []),
      last_poll: lastPoll || Number(kvGet('last_successful_poll', 0)) || null,
      polling: !!pollPromise,
      backfilling: !!backfillPromise,
      error: lastPollError,
      pending_notifications: db
        .prepare(
          'SELECT COUNT(*) c FROM notification_outbox WHERE sent_at IS NULL AND cancelled_at IS NULL',
        )
        .get().c,
      calendar_note: '按马来西亚常规交易时段判断；节假日需维护休市日期。',
      now: Math.floor(Date.now() / 1000),
    },
  };
}

// ---------------- HTTP ----------------
const app = express();
// Express 4 does not forward rejected async handlers automatically.
for (const method of ['get', 'post']) {
  const register = app[method].bind(app);
  app[method] = (route, ...handlers) =>
    register(
      route,
      ...handlers.map((handler) =>
        typeof handler === 'function'
          ? (req, res, next) =>
              Promise.resolve()
                .then(() => handler(req, res, next))
                .catch(next)
          : handler,
      ),
    );
}
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use('/api', protectApi);
app.use(express.static(DIST));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/state', (req, res) => {
  res.json(buildState());
});
app.get('/api/coverage', (req, res) => res.json(getAnalysisOverview(loadConfig()).coverage));
app.get('/api/signals', (req, res) => {
  getAnalysisOverview(loadConfig());
  const query = String(req.query.q || '').toUpperCase();
  const pool = analysisCache.tracking.filter((r) =>
    (r.code + ' ' + r.name).toUpperCase().includes(query),
  );
  const page = Math.max(1, Math.min(10000, Math.floor(Number(req.query.page) || 1)));
  res.json({
    total: pool.length,
    page,
    limit: 20,
    items: pool
      .slice((page - 1) * 20, page * 20)
      .map((r) => ({ ...r, selection: analysisCache.decisions.get(r.code) })),
    history: query
      ? db
          .prepare(
            'SELECT stock,date,kind,first_seen,last_seen,signal FROM potential_events WHERE UPPER(stock)=? ORDER BY date DESC LIMIT 30',
          )
          .all(query)
          .map((r) => ({ ...r, signal: JSON.parse(r.signal) }))
      : [],
    note: '历史规则命中不代表当时已实盘推荐；首次发现时间单独记录。',
  });
});
app.get('/api/stocks/:code', (req, res) => {
  const report = getStockReport(req.params.code);
  if (!report) return res.status(404).json({ error: '这只股票尚无行情资料。' });
  res.json(report);
});

// 观察名单全量(含战绩统计): /api/watchlist
app.get('/api/watchlist', (req, res) => {
  const all = db.prepare('SELECT * FROM watchlist ORDER BY outcome, added_date DESC').all();
  const tally = db.prepare('SELECT outcome, COUNT(*) c FROM watchlist GROUP BY outcome').all();
  res.json({ count: all.length, tally, list: all });
});

// 查某个用户在群里的身份: /api/tg-member-check?user_id=7014820861
app.get('/api/tg-member-check', async (req, res) => {
  const cfg = loadConfig();
  const uid = Number(req.query.user_id || 0);
  if (!uid) return res.json({ error: '需要 user_id' });
  const m2 = await tgCall(cfg, 'getChatMember', {
    chat_id: Number(cfg.telegram_chat_id),
    user_id: uid,
  });
  const admins = await tgCall(cfg, 'getChatAdministrators', {
    chat_id: Number(cfg.telegram_chat_id),
  });
  res.json({
    user_id: uid,
    member_raw: m2,
    admins:
      admins && admins.ok
        ? admins.result.map((a) => ({
            id: a.user.id,
            name: a.user.username || a.user.first_name,
            status: a.status,
          }))
        : admins,
  });
});

// 原始 getUpdates(诊断用): /api/tg-raw?offset=0
app.get('/api/tg-raw', async (req, res) => {
  const cfg = loadConfig();
  const off = Number(req.query.offset || 0);
  const r0 = await tgCall(cfg, 'getUpdates', { offset: off, timeout: 0, limit: 20 }, 40000);
  const list = (r0 && r0.result) || [];
  res.json({
    ok: r0 && r0.ok,
    raw_error: r0 && !r0.ok ? r0 : null,
    count: list.length,
    updates: list.slice(0, 8).map((u) => ({
      id: u.update_id,
      kind: Object.keys(u)
        .filter((k) => k !== 'update_id')
        .join(','),
      chat:
        u.message && u.message.chat
          ? { id: u.message.chat.id, type: u.message.chat.type, title: u.message.chat.title }
          : null,
      from: u.message && u.message.from ? u.message.from.username || u.message.from.id : null,
      text: u.message ? (u.message.text || '').slice(0, 100) : null,
    })),
  });
});

// 选股筛选器: 20日涨幅 / 放量倍数 / 站上MA5 / 5-10-15-20均线多头排列
// 用法: /api/screen?min_gain=15&max_gain=25&vol=2&ma5=1&bull=1
function runScreen(opts = {}) {
  const minGain = opts.min_gain ?? 15,
    maxGain = opts.max_gain ?? 25,
    volMult = Math.max(2, opts.vol_mult ?? 2),
    minVolume = Math.max(1000000, opts.min_volume ?? 1000000);
  if (![minGain, maxGain, volMult, minVolume].every(Number.isFinite) || minGain > maxGain)
    throw new ValidationError('筛选参数需要有效数值，涨幅下限不能高于上限。');
  const asof = opts.asof ? String(opts.asof) : null;
  if (
    asof &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(asof) ||
      !Number.isFinite(Date.parse(asof)) ||
      new Date(asof).toISOString().slice(0, 10) !== asof ||
      asof > marketDate())
  )
    throw new ValidationError('参考日应是有效的历史日期 YYYY-MM-DD。');
  const rows = db
    .prepare('SELECT stock,date,volume,close FROM daily_vol WHERE close>0 ORDER BY stock,date')
    .all();
  const by = new Map();
  for (const row of rows) {
    if (!by.has(row.stock)) by.set(row.stock, []);
    by.get(row.stock).push(row);
  }
  const liveMap = new Map(
    db
      .prepare('SELECT stock,price,name,volume,session_date FROM live')
      .all()
      .map((r) => [r.stock, r]),
  );
  const hits = [],
    stat = { no_hist: 0, no_price: 0, not_gain: 0, not_vol: 0, not_ma5: 0, not_bull: 0, pass: 0 };
  for (const [stock, history] of by) {
    const live = liveMap.get(stock),
      bar = asof ? history.find((r) => r.date === asof) : null;
    const date = asof || live?.session_date;
    const price = asof ? bar?.close : live?.price,
      volume = asof ? bar?.volume : live?.volume;
    if (!(price > 0) || !date) {
      stat.no_price++;
      continue;
    }
    const m = trendMetrics(history, price, volume, date);
    if (!m) {
      stat.no_hist++;
      continue;
    }
    if (m.gain20 < minGain || m.gain20 > maxGain) {
      stat.not_gain++;
      continue;
    }
    if (volume < minVolume || m.vr == null || m.vr < volMult) {
      stat.not_vol++;
      continue;
    }
    if (opts.above_ma5 !== false && !m.above_ma5) {
      stat.not_ma5++;
      continue;
    }
    if (opts.bullish_stack !== false && !m.bull) {
      stat.not_bull++;
      continue;
    }
    stat.pass++;
    hits.push({
      stock,
      name: live?.name || stock,
      date,
      close: +price.toFixed(3),
      ...m,
      gain20: +m.gain20.toFixed(2),
      vr: +m.vr.toFixed(2),
      ma5: +m.ma5.toFixed(3),
      ma10: +m.ma10.toFixed(3),
      ma15: +m.ma15.toFixed(3),
      ma20: +m.ma20.toFixed(3),
    });
  }
  hits.sort((a, b) => b.gain20 - a.gain20);
  return {
    date: asof || marketDate(),
    asof: !!asof,
    screened: by.size,
    count: hits.length,
    funnel: stat,
    params: {
      min_gain: minGain,
      max_gain: maxGain,
      vol_mult: volMult,
      min_volume: minVolume,
      above_ma5: opts.above_ma5 !== false,
      bullish_stack: opts.bullish_stack !== false,
    },
    hits,
  };
}

// HTTP 入口(薄壳): /api/screen?min_gain=15&max_gain=25&vol=2&ma5=1&bull=1&asof=YYYY-MM-DD
app.get('/api/screen', (req, res) => {
  const q = req.query;
  const num = (v) => (v != null && v !== '' ? Number(v) : undefined);
  res.json({
    ok: true,
    ...runScreen({
      min_gain: num(q.min_gain),
      max_gain: num(q.max_gain),
      vol_mult: num(q.vol),
      min_volume: num(q.min_volume),
      above_ma5: q.ma5 !== '0',
      bullish_stack: q.bull !== '0',
      asof: q.asof || null,
    }),
  });
});

// Telegram 接收链路诊断: /api/tg-diag
app.get('/api/tg-diag', async (req, res) => {
  const cfg = loadConfig();
  let webhook = null,
    me = null,
    err = null;
  try {
    const w = await tgCall(cfg, 'getWebhookInfo', {});
    webhook =
      w && w.ok
        ? {
            url: w.result.url || '(未设置)',
            pending: w.result.pending_update_count,
            last_error: w.result.last_error_message || null,
          }
        : { raw: JSON.stringify(w).slice(0, 200) };
  } catch (e) {
    err = 'webhook: ' + e;
  }
  let chat = null,
    member = null;
  try {
    const mm = await tgCall(cfg, 'getMe', {});
    me = mm && mm.ok ? mm.result : null;
  } catch (e) {
    err = (err || '') + ' me: ' + e;
  }
  try {
    const c = await tgCall(cfg, 'getChat', { chat_id: Number(cfg.telegram_chat_id) });
    chat =
      c && c.ok
        ? { id: c.result.id, type: c.result.type, title: c.result.title }
        : JSON.stringify(c).slice(0, 200);
  } catch (e) {
    err = (err || '') + ' chat: ' + e;
  }
  try {
    if (me && me.id) {
      const m2 = await tgCall(cfg, 'getChatMember', {
        chat_id: Number(cfg.telegram_chat_id),
        user_id: me.id,
      });
      member =
        m2 && m2.ok
          ? { status: m2.result.status, can_read_all: me.can_read_all_group_messages }
          : JSON.stringify(m2).slice(0, 200);
    }
  } catch (e) {
    err = (err || '') + ' member: ' + e;
  }
  res.json({
    bot: me && me.username ? me.username : me,
    bot_id: me && me.id ? me.id : null,
    privacy_mode_off: me ? !!me.can_read_all_group_messages : null,
    chat,
    member,
    webhook,
    bot_username_saved: kvGet('bot_username', ''),
    offset: kvGet('tg_offset', 0),
    poll_count: kvGet('tg_poll_count', 0),
    last_poll_at: kvGet('tg_last_poll_at', ''),
    last_error: kvGet('tg_last_error', ''),
    last_msg_at: kvGet('tg_last_msg_at', ''),
    last_msg: kvGet('tg_last_msg_chat', ''),
    owner_id: kvGet('tg_owner_id', '(未记录, 私聊一次即可绑定)'),
    denied_id: kvGet('tg_denied_id', ''),
    denied_reason: kvGet('tg_denied_reason', ''),
    our_chat_id: cfg.telegram_chat_id,
    error: err,
  });
});

// 删掉 webhook(如果之前设过, 它会挡住 getUpdates): /api/tg-del-webhook
app.post('/api/tg-del-webhook', async (req, res) => {
  const cfg = loadConfig();
  const r = await tgCall(cfg, 'deleteWebhook', { drop_pending_updates: false });
  res.json({ ok: !!(r && r.ok), raw: JSON.stringify(r).slice(0, 200) });
});

// 设置/查询 LLM key(只回传是否已配置, 绝不回显 key 本身)
app.get('/api/llm-key', (req, res) => res.json({ configured: !!llmKey(loadConfig()) }));
app.post('/api/llm-key', (req, res) => {
  const cfg = validateSettings({ llm_api_key: req.body.key }, loadConfig(), { allowSecrets: true });
  saveConfig(cfg);
  res.json({ configured: !!llmKey(cfg) });
});

// 直接测试自然语言(不经过 telegram): /api/llm-test?q=帮我看看MAYBANK
app.get('/api/llm-test', async (req, res) => {
  const cfg = loadConfig();
  const q = String(req.query.q || '');
  const t0 = Date.now();
  let out = null,
    err = null;
  try {
    out = await handleWithLLM(q, cfg);
  } catch (e) {
    err = String(e);
  }
  res.json({ q, ms: Date.now() - t0, reply: out, error: err });
});

// 模拟一条 Telegram 消息, 验证指令解析: /api/tg-test?text=/stock+MAYBANK&send=1
app.get('/api/tg-test', async (req, res) => {
  const cfg = loadConfig();
  const text = String(req.query.text || '/help');
  const fake = { text, chat: { id: Number(cfg.telegram_chat_id), type: 'supergroup' } };
  let reply = null,
    err = null;
  try {
    reply = await handleTelegramMessage(fake, cfg);
  } catch (e) {
    err = String(e);
  }
  if (reply && req.query.send === '1') {
    try {
      await sendTelegramText(reply, cfg);
    } catch (e) {}
  }
  res.json({
    input: text,
    replied: reply != null,
    sentToGroup: reply != null && req.query.send === '1',
    reply,
    error: err,
  });
});

// getUpdates offset / bot 用户名等状态: /api/tg-status
app.get('/api/tg-status', (req, res) => {
  const cfg = loadConfig();
  res.json({
    has_token: !!(cfg.telegram_bot_token || '').trim(),
    chat_id: cfg.telegram_chat_id || null,
    bot_username: kvGet('bot_username', ''),
    offset: kvGet('tg_offset', 0),
  });
});

// 清空观察名单重新开始: /api/watchlist/reset
app.post('/api/watchlist/reset', (req, res) => {
  const before = db.prepare('SELECT COUNT(*) c FROM watchlist').get().c;
  db.prepare('DELETE FROM watchlist').run();
  res.json({ ok: true, cleared: before });
});

// 手动触发一轮完整广播(验证用): /api/broadcast-test
app.get('/api/broadcast-test', async (req, res) => {
  const cfg = loadConfig();
  const preview = getAnalysisOverview(cfg);
  return res.json({
    ok: true,
    dry_run: true,
    summary: { confirmed: preview.confirmed, candidates: preview.candidates },
    note: '仅预览当前分析，不写入去重记录，也不发送消息。',
  });
});
app.post('/api/broadcast', async (req, res) => {
  const cfg = loadConfig();
  if (pollPromise || broadcastPromise)
    return res.status(409).json({ error: '扫描或广播进行中，请稍后再试。' });
  await runBroadcast(cfg);
  broadcast();
  res.json({
    ok: true,
    pending: db
      .prepare(
        'SELECT COUNT(*) c FROM notification_outbox WHERE sent_at IS NULL AND cancelled_at IS NULL',
      )
      .get().c,
  });
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
      if (p) {
        withOhlc++;
        if (p.score >= minScore) out.push({ code: r.stock, ...p });
      }
    } catch (e) {}
  }
  out.sort((a, b) => b.score - a.score);
  res.json({
    scanned: list.length,
    matched: withOhlc,
    aboveThreshold: out.length,
    minScore,
    results: out.slice(0, 40),
  });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  res.write(`data: ${JSON.stringify(buildState())}\n\n`);
  // 心跳: 每 30s 发一个注释帧, 防止代理层在两次数据间(最长 10 分钟)把连接当空闲断掉
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

// 手动触发 Yahoo 日线回填(修正 daily_vol 的昨日量)
app.post('/api/backfill', async (req, res) => {
  res.json({ ok: true, msg: '回填已启动, 约需 3-10 分钟, 完成后自动刷新' });
  broadcast();
  try {
    await backfillDailyVol({ force: true });
    broadcast();
  } catch (e) {
    log('手动回填失败: ' + e.message);
  }
});

app.post('/api/settings', (req, res) => {
  const cfg = validateSettings(req.body, loadConfig(), { allowSecrets: true });
  saveConfig(cfg);
  if (req.body.window != null || req.body.price_thresholds != null)
    db.prepare('UPDATE state SET above=0').run();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/watchlist/add', async (req, res) => {
  const code = String(req.body.code || '')
    .trim()
    .toUpperCase()
    .replace(/\.KL$/, '');
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
  poll(); // fire-and-forget
  res.json({ ok: true });
});

app.post('/api/test-telegram', async (req, res) => {
  const cfg = loadConfig();
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) {
    return res.status(400).json({ error: '未配置 Telegram Bot Token / Chat ID' });
  }
  const result = await sendTelegramText('✅ KLSE 机会观察 — Telegram 通知测试', cfg);
  res.status(result.ok ? 200 : 502).json(result);
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

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err instanceof ValidationError || err.type === 'entity.parse.failed' ? 400 : err.status || 500;
  res
    .status(status)
    .json({ error: status === 400 ? err.message : '服务暂时无法完成请求，请稍后再试。' });
});

// Importing the server for tests never loads local credentials or starts polling.
export {
  app,
  db,
  DEFAULTS,
  loadConfig,
  saveConfig,
  runScreen,
  fetchMarket,
  storeUniverse,
  performBackfill,
  historyRefreshQueue,
  persistPotentialEvents,
  getStockReport,
  buildState,
  updateWatchlist,
  evaluateAlerts,
  evaluateGapUp,
  evaluatePriceDrop,
  evaluateDoubleBottom,
  recordFinalBriefing,
  recordHalfHourBriefing,
  maybeFinalBriefings,
  closingBriefingState,
  halfHourBriefingState,
  deliverOutbox,
  runBroadcast,
  findDoubleBottom,
  updateQuote,
  computeVolumes,
  handleTelegramMessage,
  sendTelegramText,
};

if (IS_ENTRY) {
  if (!fs.existsSync(CONFIG_PATH))
    saveConfig({
      ...DEFAULTS,
      watchlist: DEFAULT_WATCHLIST.map(([code, name]) => ({ code, name })),
    });
  app.listen(PORT, () => log('KLSE 机会观察已启动 → http://localhost:' + PORT));
  if (!process.env.ADMIN_TOKEN) log('ADMIN_TOKEN 未配置：管理员写操作已锁定。');
  poll()
    .then(async () => {
      await backfillDailyVol();
      broadcast();
    })
    .catch((e) => log('启动回填失败: ' + e.message));
  startPolling();
}
