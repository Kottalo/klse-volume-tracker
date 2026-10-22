// KLSE: notify once per stock/day when today's volume reaches three times yesterday's.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  marketDate,
  sessionStart,
  previousTradingDate,
  volumeSignal,
  formatVolumeAlert,
  VOLUME_MULTIPLE,
  MINIMUM_VOLUME,
} from './lib/volume.js';
import { validateSettings, ValidationError } from './lib/settings.js';
import { protectApi } from './lib/security.js';

const IS_ENTRY =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_ENTRY) await import('dotenv/config');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULTS = {
  potential_alerts_telegram: true,
  telegram_bot_token: '',
  telegram_chat_id: '',
  market_holidays: [],
};
function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  const cfg = Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, value]) => [key, raw[key] ?? value]),
  );
  if (process.env.TELEGRAM_BOT_TOKEN) cfg.telegram_bot_token = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegram_chat_id = process.env.TELEGRAM_CHAT_ID;
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
}
const db = new DatabaseSync(path.join(DATA_DIR, 'data.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS universe(stock TEXT PRIMARY KEY,name TEXT,code TEXT,active INTEGER DEFAULT 1,last_seen REAL,history_attempt REAL,history_success REAL,history_error TEXT);
  CREATE TABLE IF NOT EXISTS live(stock TEXT PRIMARY KEY,name TEXT,volume INTEGER,mtime REAL,session_date TEXT);
  CREATE TABLE IF NOT EXISTS daily_vol(stock TEXT,date TEXT,volume INTEGER,PRIMARY KEY(stock,date));
  CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT);
  CREATE TABLE IF NOT EXISTS notification_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,text TEXT,attempts INTEGER DEFAULT 0,sent_at INTEGER,last_error TEXT,cancelled_at INTEGER,kind TEXT);
  CREATE TABLE IF NOT EXISTS volume_alerts(stock TEXT,date TEXT,name TEXT,numeric_code TEXT,volume INTEGER,previous_volume INTEGER,previous_date TEXT,multiple REAL,ts REAL,outbox_id INTEGER,PRIMARY KEY(stock,date));
`);
// Additive migration keeps existing prices, history and old notification records intact.
for (const [column, type] of [
  ['cancelled_at', 'INTEGER'],
  ['kind', 'TEXT'],
]) {
  if (
    !db
      .prepare('PRAGMA table_info(notification_outbox)')
      .all()
      .some((c) => c.name === column)
  )
    db.exec(`ALTER TABLE notification_outbox ADD COLUMN ${column} ${type}`);
}
db.prepare(
  'UPDATE notification_outbox SET cancelled_at=?,last_error=? WHERE sent_at IS NULL AND cancelled_at IS NULL AND kind IS NULL',
).run(Math.floor(Date.now() / 1000), '旧策略通知已取消');
function kvGet(key, fallback = null) {
  return db.prepare('SELECT v FROM kv WHERE k=?').get(key)?.v ?? fallback;
}
function kvSet(key, value) {
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(
    key,
    String(value),
  );
}
const log = (text) => console.log(text);
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

async function fetchMarket() {
  const quotes = [],
    symbols = [],
    seen = new Set();
  let expected = null,
    received = 0;
  for (let start = 0; ; start += 500) {
    const response = await fetch('https://scanner.tradingview.com/malaysia/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        columns: ['name', 'description', 'volume', 'isin'],
        filter: [{ left: 'type', operation: 'in_range', right: ['stock', 'dr'] }],
        range: [start, start + 500],
        sort: { sortBy: 'name', sortOrder: 'asc' },
      }),
    });
    if (!response.ok) throw new Error(`行情接口 HTTP ${response.status}`);
    const data = await response.json();
    if (
      !Number.isInteger(data.totalCount) ||
      data.totalCount <= 0 ||
      (expected != null && expected !== data.totalCount)
    )
      throw new Error('股票池数量不完整');
    expected = data.totalCount;
    for (const row of data.data || []) {
      const [ticker, name, volume, isin] = row.d;
      if (!ticker || seen.has(ticker)) throw new Error('行情分页缺失或重复');
      seen.add(ticker);
      received++;
      const match =
        typeof isin === 'string' ? isin.match(/^MY[A-Z](?:(\d{4})OO|(\d{5})O)\d{3}$/) : null;
      const stock = { ticker, name, numericCode: match?.[1] || match?.[2] || null };
      symbols.push(stock);
      if (Number.isFinite(volume) && volume >= 0) quotes.push({ ...stock, volume });
    }
    if (received === expected) break;
    if ((data.data || []).length < 500 || received > expected) throw new Error('行情分页提前结束');
  }
  Object.defineProperty(quotes, 'coverage', {
    value: { expected, received, valid: quotes.length, symbols },
  });
  return quotes;
}
function completedMarketDate(cfg = loadConfig(), now = Date.now() / 1000) {
  const date = marketDate(now),
    local = new Date((now + 8 * 3600) * 1000);
  return local.getUTCHours() >= 17 &&
    ![0, 6].includes(local.getUTCDay()) &&
    !cfg.market_holidays.includes(date)
    ? date
    : previousTradingDate(date, cfg.market_holidays);
}
function storeUniverse(quotes, cfg = loadConfig()) {
  const now = Date.now() / 1000;
  const local = new Date((now + 8 * 3600) * 1000);
  const date =
    ![0, 6].includes(local.getUTCDay()) &&
    !cfg.market_holidays.includes(marketDate(now)) &&
    local.getUTCHours() >= 9
      ? marketDate(now)
      : completedMarketDate(cfg, now);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE universe SET active=0').run();
    db.prepare('UPDATE live SET volume=NULL,mtime=NULL,session_date=NULL').run();
    for (const q of quotes.coverage.symbols) {
      db.prepare(
        `INSERT INTO universe(stock,name,code,active,last_seen) VALUES(?,?,?,1,?) ON CONFLICT(stock) DO UPDATE SET name=excluded.name,code=COALESCE(excluded.code,universe.code),active=1,last_seen=excluded.last_seen,history_attempt=CASE WHEN universe.code IS NULL AND excluded.code IS NOT NULL THEN NULL ELSE universe.history_attempt END`,
      ).run(q.ticker, q.name, q.numericCode, now);
    }
    for (const q of quotes)
      db.prepare(
        'INSERT INTO live(stock,name,volume,mtime,session_date) VALUES(?,?,?,?,?) ON CONFLICT(stock) DO UPDATE SET name=excluded.name,volume=excluded.volume,mtime=excluded.mtime,session_date=excluded.session_date',
      ).run(q.ticker, q.name, q.volume, now, date);
    kvSet(
      'market_scan_coverage',
      JSON.stringify({
        expected: quotes.coverage.expected,
        received: quotes.coverage.received,
        valid: quotes.length,
        at: now,
      }),
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function historyRefreshQueue(force = false) {
  const expected = completedMarketDate(),
    cutoff = Date.parse(`${expected}T17:00:00+08:00`) / 1000,
    now = Date.now() / 1000;
  return db
    .prepare(
      'SELECT u.*,MAX(d.date) latest FROM universe u LEFT JOIN daily_vol d ON d.stock=u.stock WHERE u.active=1 GROUP BY u.stock',
    )
    .all()
    .filter(
      (u) =>
        force ||
        ((!u.history_attempt || now - u.history_attempt >= 600) &&
          (!u.code ||
            !u.latest ||
            !u.history_success ||
            u.history_success < cutoff ||
            u.history_error)),
    );
}
let backfillPromise = null;
function performBackfill({ force = false } = {}) {
  if (backfillPromise) return backfillPromise;
  backfillPromise = (async () => {
    const queue = historyRefreshQueue(force);
    let index = 0,
      done = 0;
    const cfg = loadConfig(),
      expected = completedMarketDate(cfg);
    const worker = async () => {
      while (index < queue.length) {
        const stock = queue[index++];
        db.prepare('UPDATE universe SET history_attempt=? WHERE stock=?').run(
          Date.now() / 1000,
          stock.stock,
        );
        try {
          const code = stock.code || (await mapCodeToNumeric(stock.stock, stock.name));
          if (!code) throw new Error('暂无数字代码映射');
          db.prepare('UPDATE universe SET code=? WHERE stock=?').run(code, stock.stock);
          const data = await yahooGet(
            `https://query1.finance.yahoo.com/v8/finance/chart/${code}.KL?interval=1d&range=6mo`,
          );
          const result = data.chart?.result?.[0];
          if (!result || (result.meta?.symbol && result.meta.symbol !== code + '.KL'))
            throw new Error('日成交量代码不匹配');
          const rows = (result.timestamp || [])
            .map((ts, i) => ({
              date: marketDate(ts),
              volume: result.indicators?.quote?.[0]?.volume?.[i],
            }))
            .filter((r) => r.date <= expected && Number.isFinite(r.volume) && r.volume > 0);
          if (!rows.length) throw new Error('暂无完整交易日成交量');
          db.exec('BEGIN');
          try {
            for (const r of rows)
              db.prepare(
                'INSERT INTO daily_vol(stock,date,volume) VALUES(?,?,?) ON CONFLICT(stock,date) DO UPDATE SET volume=excluded.volume',
              ).run(stock.stock, r.date, r.volume);
            db.prepare(
              'UPDATE universe SET history_success=?,history_error=NULL WHERE stock=?',
            ).run(Date.now() / 1000, stock.stock);
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
          done++;
        } catch (e) {
          db.prepare('UPDATE universe SET history_error=? WHERE stock=?').run(
            String(e.message).slice(0, 160),
            stock.stock,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    recordVolumeAlerts();
    await deliverOutbox();
    broadcast();
    return { done, total: queue.length };
  })().finally(() => {
    backfillPromise = null;
  });
  return backfillPromise;
}

function getStocks(cfg = loadConfig()) {
  const now = Date.now() / 1000,
    today = marketDate(now);
  return db
    .prepare(
      `SELECT u.stock code,u.name,u.code numeric_code,u.history_success,u.history_error,l.volume,l.mtime fetched_at,l.session_date date,
    d.date previous_date,d.volume previous_volume FROM universe u LEFT JOIN live l ON l.stock=u.stock
    LEFT JOIN daily_vol d ON d.stock=u.stock AND d.date=(SELECT MAX(p.date) FROM daily_vol p WHERE p.stock=u.stock AND p.date<l.session_date AND p.volume>0)
    WHERE u.active=1 ORDER BY u.stock`,
    )
    .all()
    .map((row) => {
      const expected = row.date ? previousTradingDate(row.date, cfg.market_holidays) : null;
      const ready =
        !!row.previous_date &&
        (row.previous_date === expected ||
          row.history_success >= Date.parse(`${expected}T17:00:00+08:00`) / 1000);
      const signal = volumeSignal(row.volume, ready ? row.previous_volume : null);
      return {
        code: row.code,
        name: row.name,
        numeric_code: row.numeric_code,
        date: row.date,
        volume: row.volume,
        previous_date: row.previous_date,
        previous_volume: row.previous_volume,
        multiple: signal.multiple,
        qualified: signal.pass,
        fresh: row.date === today && row.fetched_at <= now && now - row.fetched_at <= 180,
        fetched_at: row.fetched_at,
        issue: !Number.isFinite(row.volume) ? '缺少今日量' : !ready ? '等待昨日量' : null,
      };
    });
}
function recordVolumeAlerts(cfg = loadConfig()) {
  const now = Date.now() / 1000,
    date = marketDate(now);
  if (sessionStart(now, cfg.market_holidays) == null) return [];
  const scan = JSON.parse(kvGet('market_scan_coverage', 'null'));
  if (!scan || scan.at > now || now - scan.at > 180 || scan.expected !== scan.received) return [];
  const matches = getStocks(cfg).filter(
    (s) =>
      s.qualified &&
      s.fresh &&
      !db
        .prepare('SELECT 1 FROM volume_alerts WHERE stock=? AND date=? AND volume>=?')
        .get(s.code, date, MINIMUM_VOLUME),
  );
  if (!matches.length) return [];
  // Batch by Telegram's text limit, never by rank or a maximum number of stocks.
  const batches = [];
  for (const stock of matches) {
    const text = formatVolumeAlert(stock);
    let batch = batches.at(-1);
    if (!batch || batch.text.length + text.length + 2 > 3500) {
      batch = { text: `📊 三倍放量提醒 · ${date}`, stocks: [] };
      batches.push(batch);
    }
    batch.text += '\n\n' + text;
    batch.stocks.push(stock);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const batch of batches) {
      const webOnly =
        cfg.potential_alerts_telegram === false ||
        !(cfg.telegram_bot_token && cfg.telegram_chat_id);
      const id = Number(
        db
          .prepare(
            "INSERT INTO notification_outbox(ts,text,kind,cancelled_at,last_error) VALUES(?,?,'volume',?,?)",
          )
          .run(
            Math.floor(now),
            batch.text,
            webOnly ? Math.floor(now) : null,
            webOnly ? '仅网页' : null,
          ).lastInsertRowid,
      );
      for (const s of batch.stocks)
        db.prepare(
          `INSERT INTO volume_alerts(stock,date,name,numeric_code,volume,previous_volume,previous_date,multiple,ts,outbox_id) VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(stock,date) DO UPDATE SET name=excluded.name,numeric_code=excluded.numeric_code,
          volume=excluded.volume,previous_volume=excluded.previous_volume,previous_date=excluded.previous_date,
          multiple=excluded.multiple,ts=excluded.ts,outbox_id=excluded.outbox_id`,
        ).run(
          s.code,
          date,
          s.name,
          s.numeric_code,
          s.volume,
          s.previous_volume,
          s.previous_date,
          s.multiple,
          now,
          id,
        );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return matches;
}
async function tgCall(cfg, method, params, timeoutMs = 15000) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${cfg.telegram_bot_token.trim()}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return await response.json();
  } catch {
    return { ok: false };
  }
}
async function sendTelegramText(text, cfg = loadConfig()) {
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id))
    return { ok: false, error: 'Telegram 未配置' };
  // Queries may contain the entire market; every chunk remains a plain text message.
  const chunks = [];
  let chunk = '';
  for (const line of text.split('\n')) {
    if (chunk.length + line.length + 1 > 4000) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) chunks.push(chunk);
  for (const part of chunks) {
    const result = await tgCall(cfg, 'sendMessage', {
      chat_id: cfg.telegram_chat_id.trim(),
      text: part,
      link_preview_options: { is_disabled: true },
    });
    if (!result.ok) return { ok: false, error: 'Telegram 发送失败，稍后重试' };
  }
  return { ok: true };
}
let deliveryPromise = null;
function deliverOutbox(cfg = loadConfig()) {
  if (deliveryPromise) return deliveryPromise;
  deliveryPromise = (async () => {
    if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
    const now = Date.now() / 1000;
    const pending = db
      .prepare(
        "SELECT * FROM notification_outbox WHERE kind='volume' AND sent_at IS NULL AND cancelled_at IS NULL ORDER BY id LIMIT 5",
      )
      .all();
    for (const item of pending) {
      const cancelled =
        cfg.potential_alerts_telegram === false
          ? '仅网页'
          : now - item.ts > 900 || marketDate(item.ts) !== marketDate(now)
            ? '提醒已过期'
            : null;
      if (cancelled) {
        db.prepare('UPDATE notification_outbox SET cancelled_at=?,last_error=? WHERE id=?').run(
          Math.floor(now),
          cancelled,
          item.id,
        );
        continue;
      }
      const records = db
        .prepare('SELECT *,stock AS code FROM volume_alerts WHERE outbox_id=?')
        .all(item.id);
      const eligible = records.filter(
        (stock) => volumeSignal(stock.volume, stock.previous_volume).pass,
      );
      if (!eligible.length) {
        db.prepare('UPDATE notification_outbox SET cancelled_at=?,last_error=? WHERE id=?').run(
          Math.floor(now),
          '未达百万股及三倍量门槛',
          item.id,
        );
        continue;
      }
      if (eligible.length !== records.length) {
        item.text = [
          `📊 三倍放量提醒 · ${eligible[0].date}`,
          ...eligible.map(formatVolumeAlert),
        ].join('\n\n');
        db.prepare('UPDATE notification_outbox SET text=? WHERE id=?').run(item.text, item.id);
      }
      const result = await sendTelegramText(item.text, cfg);
      db.prepare(
        'UPDATE notification_outbox SET attempts=attempts+1,sent_at=?,last_error=? WHERE id=?',
      ).run(result.ok ? Math.floor(Date.now() / 1000) : null, result.error || null, item.id);
      if (!result.ok) break;
    }
  })().finally(() => {
    deliveryPromise = null;
  });
  return deliveryPromise;
}
async function runBroadcast(cfg = loadConfig()) {
  const matches = recordVolumeAlerts(cfg);
  await deliverOutbox(cfg);
  return matches;
}
function handleTelegramMessage(message, cfg = loadConfig()) {
  if (String(message.chat?.id) !== String(cfg.telegram_chat_id)) return null;
  const [command, arg] = String(message.text || '')
    .trim()
    .split(/\s+/);
  const cmd = command?.split('@')[0].toLowerCase();
  if (['/top', '/screen'].includes(cmd)) {
    const stocks = getStocks(cfg).filter((s) => s.qualified);
    return stocks.length
      ? '三倍放量 · ' + stocks[0].date + '\n\n' + stocks.map(formatVolumeAlert).join('\n\n')
      : '目前没有同时达到100万股及昨日3倍量的股票。';
  }
  if (cmd === '/stock') {
    const stock = getStocks(cfg).find(
      (s) => s.code === arg?.toUpperCase() || s.numeric_code === arg,
    );
    return !stock
      ? '请输入股票代码，例如 /stock MAYBANK'
      : stock.multiple == null
        ? `${stock.code}：等待成交量资料。`
        : stock.date + '\n' + formatVolumeAlert(stock);
  }
  if (['/start', '/help'].includes(cmd))
    return '今日量满100万股且达到昨日3倍就提醒，同一只股票每天一次。\n/top 查看达标股票\n/stock 代码 查看成交量';
  return null;
}
let telegramPolling = false;
async function pollTelegram() {
  if (telegramPolling) return;
  const cfg = loadConfig();
  if (!(cfg.telegram_bot_token && cfg.telegram_chat_id)) return;
  telegramPolling = true;
  try {
    if (!kvGet('volume_commands_v1')) {
      const result = await tgCall(cfg, 'setMyCommands', {
        scope: { type: 'chat', chat_id: cfg.telegram_chat_id },
        commands: [
          { command: 'top', description: '查看三倍放量股票' },
          { command: 'stock', description: '查看股票成交量' },
          { command: 'help', description: '帮助' },
        ],
      });
      if (result.ok) kvSet('volume_commands_v1', '1');
    }
    const result = await tgCall(
      cfg,
      'getUpdates',
      { offset: Number(kvGet('tg_offset', 0)), timeout: 25, allowed_updates: ['message'] },
      35000,
    );
    if (!result.ok || !Array.isArray(result.result)) return;
    for (const update of result.result) {
      const reply = update.message && handleTelegramMessage(update.message, cfg);
      if (reply) await sendTelegramText(reply, cfg);
      kvSet('tg_offset', update.update_id + 1);
    }
  } finally {
    telegramPolling = false;
  }
}
const clients = new Set();
function broadcast() {
  if (!clients.size) return;
  const data = `data: ${JSON.stringify(buildState())}\n\n`;
  for (const client of clients) client.write(data);
}
let pollPromise = null,
  lastPollError = null;
function poll() {
  if (pollPromise) return pollPromise;
  pollPromise = (async () => {
    try {
      const quotes = await fetchMarket();
      storeUniverse(quotes);
      kvSet('last_successful_poll', Date.now() / 1000);
      lastPollError = null;
      await runBroadcast();
      performBackfill().catch(() => {
        lastPollError = '昨日成交量更新失败，稍后重试。';
      });
    } catch {
      lastPollError = '行情更新失败，保留最近一次数据。';
    }
    broadcast();
  })().finally(() => {
    pollPromise = null;
  });
  return pollPromise;
}
function maybePoll() {
  if (pollPromise) return pollPromise;
  return Date.now() / 1000 - Number(kvGet('last_successful_poll', 0)) >= 300
    ? poll()
    : Promise.resolve();
}
function buildState() {
  const cfg = loadConfig(),
    stocks = getStocks(cfg),
    scan = JSON.parse(kvGet('market_scan_coverage', 'null'));
  const alerts = db
    .prepare(
      `SELECT a.*,o.sent_at,o.cancelled_at,o.last_error FROM volume_alerts a LEFT JOIN notification_outbox o ON o.id=a.outbox_id ORDER BY a.ts DESC,a.multiple DESC LIMIT 200`,
    )
    .all();
  return {
    version: '3.0.0',
    minimum_multiple: VOLUME_MULTIPLE,
    minimum_volume: MINIMUM_VOLUME,
    stocks,
    alerts,
    coverage: {
      expected: scan?.expected || stocks.length,
      received: scan?.received || 0,
      comparable: stocks.filter((s) => s.multiple != null).length,
      total: stocks.length,
    },
    settings: {
      potential_alerts_telegram: cfg.potential_alerts_telegram,
      telegram_ready: !!(cfg.telegram_bot_token && cfg.telegram_chat_id),
      market_holidays: cfg.market_holidays,
    },
    status: {
      market_open: sessionStart(Date.now() / 1000, cfg.market_holidays) != null,
      last_poll: Number(kvGet('last_successful_poll', 0)) || null,
      polling: !!pollPromise,
      backfilling: !!backfillPromise,
      error: lastPollError,
      now: Date.now() / 1000,
    },
    admin_enabled: !!process.env.ADMIN_TOKEN,
  };
}
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use('/api', protectApi);
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/api/state', (_req, res) => res.json(buildState()));
app.get('/api/coverage', (_req, res) => res.json(buildState().coverage));
app.get('/api/screen', (_req, res) =>
  res.json({
    minimum_multiple: VOLUME_MULTIPLE,
    minimum_volume: MINIMUM_VOLUME,
    stocks: getStocks().filter((s) => s.qualified),
  }),
);
app.get('/api/stocks/:code', (req, res) => {
  const code = req.params.code.toUpperCase(),
    stock = getStocks().find((s) => s.code === code || s.numeric_code === code);
  res.status(stock ? 200 : 404).json(stock || { error: '没有这只股票。' });
});
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\ndata: ${JSON.stringify(buildState())}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});
app.post('/api/settings', (req, res) => {
  saveConfig(validateSettings(req.body, loadConfig()));
  broadcast();
  res.json({ ok: true });
});
app.post('/api/poll', (_req, res) => {
  poll().catch(() => {});
  res.json({ ok: true });
});
app.post('/api/backfill', (_req, res) => {
  performBackfill({ force: true }).catch(() => {});
  res.json({ ok: true });
});
app.use('/api', (_req, res) => res.status(404).json({ error: '没有此接口。' }));
app.use(express.static(path.join(ROOT, 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'dist/index.html')));
app.use((err, _req, res, _next) =>
  res
    .status(
      err instanceof ValidationError || err.type === 'entity.parse.failed'
        ? 400
        : err.status || 500,
    )
    .json({ error: err instanceof ValidationError ? err.message : '请求未完成。' }),
);

export {
  app,
  db,
  DEFAULTS,
  loadConfig,
  saveConfig,
  fetchMarket,
  storeUniverse,
  historyRefreshQueue,
  performBackfill,
  getStocks,
  recordVolumeAlerts,
  deliverOutbox,
  sendTelegramText,
  runBroadcast,
  handleTelegramMessage,
  poll,
  maybePoll,
  buildState,
};
if (IS_ENTRY) {
  app.listen(process.env.PORT || 8080, () => log('KLSE 三倍放量提醒已启动'));
  poll();
  pollTelegram();
  setInterval(() => {
    if (sessionStart(Date.now() / 1000, loadConfig().market_holidays) != null) maybePoll();
  }, 15000);
  setInterval(() => {
    performBackfill().catch(() => {});
    deliverOutbox().catch(() => {});
  }, 60000);
  setInterval(pollTelegram, 5000);
}
