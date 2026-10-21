import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-tests-'));
process.env.DATA_DIR = root;
process.env.ADMIN_TOKEN = 'test-admin';
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LLM_API_KEY'])
  delete process.env[key];
const server = await import('../server.js');
const { app, db, DEFAULTS, saveConfig, recordVolumeAlerts, getStocks, deliverOutbox } = server;
const realFetch = globalThis.fetch,
  realNow = Date.now;
const fixed = Date.parse('2026-10-05T10:30:00+08:00');
Date.now = () => fixed;
let http, base;
before(async () => {
  http = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => http.once('listening', resolve));
  base = 'http://127.0.0.1:' + http.address().port;
});
after(async () => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
function reset() {
  Date.now = () => fixed;
  globalThis.fetch = realFetch;
  for (const table of [
    'volume_alerts',
    'notification_outbox',
    'live',
    'universe',
    'daily_vol',
    'kv',
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  saveConfig(DEFAULTS);
}
function scan(at = Date.now() / 1000, expected = 1, received = expected) {
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(
    'market_scan_coverage',
    JSON.stringify({ at, expected, received }),
  );
}
function stock(code = 'TEST', volume = 300, previous = 100, extra = {}) {
  db.prepare('INSERT INTO universe(stock,name,code,active) VALUES(?,?,?,1)').run(
    code,
    code + ' Company',
    extra.numeric_code || '0123',
  );
  db.prepare('INSERT INTO live(stock,name,volume,mtime,session_date) VALUES(?,?,?,?,?)').run(
    code,
    code,
    volume,
    Date.now() / 1000,
    '2026-10-05',
  );
  if (previous != null)
    db.prepare('INSERT INTO daily_vol(stock,date,volume) VALUES(?,?,?)').run(
      code,
      '2026-10-02',
      previous,
    );
}
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' };
const post = (url, body, auth = headers) =>
  realFetch(base + url, { method: 'POST', headers: auth, body: JSON.stringify(body) });
const telegram = { ...DEFAULTS, telegram_bot_token: 'FAKE', telegram_chat_id: '123' };

test('public volume queries work; settings require admin and never expose credentials', async () => {
  reset();
  stock();
  scan();
  saveConfig({
    ...telegram,
    pick_count: 1,
    screen_on: false,
    screen_min_volume: 999999999,
    screen_vol_mult: 10,
  });
  const state = await (await realFetch(base + '/api/state')).json();
  assert.equal(state.stocks[0].qualified, true);
  assert.equal(state.minimum_multiple, 3);
  assert.equal(state.settings.telegram_ready, true);
  assert.doesNotMatch(
    JSON.stringify(state),
    /FAKE|test-admin|pick_count|screen_min_volume|chart|entry_plan/,
  );
  assert.equal((await post('/api/settings', {}, {})).status, 401);
  assert.equal((await post('/api/settings', { pick_count: 3 })).status, 400);
  assert.equal((await post('/api/settings', { potential_alerts_telegram: false })).status, 200);
  assert.equal((await realFetch(base + '/api/stocks/0123')).status, 200);
  const screen = await (await realFetch(base + '/api/screen?vol=1&min_volume=0')).json();
  assert.equal(screen.minimum_multiple, 3);
  assert.equal(screen.stocks.length, 1);
});
test('low-volume stocks, one prior bar, no OHLC and old restrictive settings cannot block notifications', () => {
  reset();
  const config = {
    ...DEFAULTS,
    screen_on: false,
    screen_vol_mult: 99,
    screen_min_volume: 1e12,
    min_average_daily_value: 1e12,
    pick_count: 1,
  };
  stock('TINY', 300, 100);
  stock('OTHER', 600, 100);
  stock('THIRD', 900, 100);
  stock('FOURTH', 1200, 100);
  stock('BELOW', 299, 100);
  stock('ZERO', 100, 0);
  stock('MISSING', 100, null);
  scan(fixed / 1000, 7);
  const matches = recordVolumeAlerts(config);
  assert.deepEqual(matches.map((s) => s.code).sort(), ['FOURTH', 'OTHER', 'THIRD', 'TINY']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM volume_alerts').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n, 1);
  const text = db.prepare('SELECT text FROM notification_outbox').get().text;
  assert.match(text, /TINY/);
  assert.match(text, /FOURTH/);
  assert.doesNotMatch(text, /买点|支撑|PNG|精选|突破/);
});
test('ratio boundary is exact and threshold crossing alerts once per stock/date, including after restart', () => {
  reset();
  stock('TEST', 299);
  scan();
  assert.equal(recordVolumeAlerts().length, 0);
  db.prepare('UPDATE live SET volume=300').run();
  assert.equal(recordVolumeAlerts().length, 1);
  db.prepare('UPDATE live SET volume=500').run();
  assert.equal(recordVolumeAlerts().length, 0);
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `Date.now=()=>${fixed};const s=await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});console.log(s.recordVolumeAlerts().length);s.db.close();`,
    ],
    { env: { ...process.env, DATA_DIR: root }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), '0');
  Date.now = () => fixed + 86400000;
  db.prepare("UPDATE live SET session_date='2026-10-06',mtime=?").run(Date.now() / 1000);
  db.prepare("INSERT INTO daily_vol(stock,date,volume) VALUES('TEST','2026-10-05',100)").run();
  scan();
  assert.equal(recordVolumeAlerts().length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM volume_alerts').get().n, 2);
});
test('absent, stale, future, incomplete, inactive and lunch snapshots cannot masquerade as current alerts', () => {
  reset();
  stock();
  assert.equal(recordVolumeAlerts().length, 0);
  for (const [at, expected, received] of [
    [fixed / 1000 - 181, 1, 1],
    [fixed / 1000 + 1, 1, 1],
    [fixed / 1000, 2, 1],
  ]) {
    scan(at, expected, received);
    assert.equal(recordVolumeAlerts().length, 0);
  }
  scan();
  for (const mtime of [fixed / 1000 - 181, fixed / 1000 + 1]) {
    db.prepare('UPDATE live SET mtime=?').run(mtime);
    assert.equal(recordVolumeAlerts().length, 0);
  }
  db.prepare('UPDATE live SET mtime=?').run(fixed / 1000);
  db.prepare('UPDATE universe SET active=0').run();
  assert.equal(recordVolumeAlerts().length, 0);
  db.prepare('UPDATE universe SET active=1').run();
  Date.now = () => Date.parse('2026-10-05T13:00:00+08:00');
  scan();
  assert.equal(recordVolumeAlerts().length, 0);
});
test('an older traded-day baseline needs a completed refresh to avoid treating missing yesterday data as zero', () => {
  reset();
  stock();
  db.prepare("UPDATE daily_vol SET date='2026-10-01'").run();
  scan();
  assert.equal(getStocks()[0].multiple, null);
  assert.equal(recordVolumeAlerts().length, 0);
  db.prepare('UPDATE universe SET history_success=?').run(fixed / 1000);
  assert.equal(recordVolumeAlerts().length, 1);
});
test('all matches are batched as short plain text, without image calls or a top-three limit', async () => {
  reset();
  for (let i = 0; i < 100; i++) stock('STOCK' + String(i).padStart(3, '0'));
  scan(fixed / 1000, 100);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/sendMessage'));
    const body = JSON.parse(options.body);
    assert.ok(body.text.length <= 4000);
    assert.equal(body.photo, undefined);
    calls.push(body.text);
    return Response.json({ ok: true });
  };
  assert.equal(recordVolumeAlerts(telegram).length, 100);
  await deliverOutbox(telegram);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE sent_at IS NULL').get().n,
    0,
  );
  for (let i = 0; i < 100; i++)
    assert.ok(calls.join('\n').includes('STOCK' + String(i).padStart(3, '0')));
  assert.equal(recordVolumeAlerts(telegram).length, 0);
});
test('text failures retry the frozen notice and old notices expire; disabling Telegram retains web records', async () => {
  reset();
  stock();
  scan();
  recordVolumeAlerts(telegram);
  const original = db.prepare('SELECT text FROM notification_outbox').get().text;
  globalThis.fetch = async () => Response.json({ ok: false });
  await deliverOutbox(telegram);
  assert.equal(db.prepare('SELECT attempts FROM notification_outbox').get().attempts, 1);
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).text, original);
    return Response.json({ ok: true });
  };
  db.prepare('UPDATE live SET volume=900').run();
  await deliverOutbox(telegram);
  assert.ok(db.prepare('SELECT sent_at FROM notification_outbox').get().sent_at);
  db.prepare('UPDATE notification_outbox SET sent_at=NULL').run();
  Date.now = () => fixed + 901000;
  globalThis.fetch = async () => {
    throw new Error('expired text must not send');
  };
  await deliverOutbox(telegram);
  assert.ok(db.prepare('SELECT cancelled_at FROM notification_outbox').get().cancelled_at);
  reset();
  stock();
  scan();
  recordVolumeAlerts({ ...telegram, potential_alerts_telegram: false });
  const row = db.prepare('SELECT * FROM notification_outbox').get();
  assert.equal(row.last_error, '仅网页');
  assert.ok(row.cancelled_at);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM volume_alerts').get().n, 1);
});
test('an interrupted transaction consumes neither daily deduplication nor outbox records', () => {
  reset();
  stock();
  scan();
  db.exec(
    "CREATE TRIGGER fail_volume BEFORE INSERT ON volume_alerts BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  try {
    assert.throws(() => recordVolumeAlerts(), /test rollback/);
  } finally {
    db.exec('DROP TRIGGER fail_volume');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM volume_alerts').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n, 0);
  assert.equal(recordVolumeAlerts().length, 1);
});
function pageRows(start, count) {
  return Array.from({ length: count }, (_, i) => ({
    d: ['STOCK' + (start + i), 'Company', 300, 'MYL1155OO000'],
  }));
}
test('market scanning verifies every sorted page, maps four/five digit ISINs and does not require prices', async () => {
  reset();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.sort.sortBy, 'name');
    assert.deepEqual(body.columns, ['name', 'description', 'volume', 'isin']);
    const start = body.range[0];
    calls++;
    return Response.json({ totalCount: 501, data: pageRows(start, start === 0 ? 500 : 1) });
  };
  const quotes = await server.fetchMarket();
  assert.equal(calls, 2);
  assert.equal(quotes.length, 501);
  assert.equal(quotes[0].numericCode, '1155');
  server.storeUniverse(quotes);
  assert.equal(getStocks().length, 501);
  globalThis.fetch = async () =>
    Response.json({ totalCount: 1, data: [{ d: ['LEAP', 'Leap', 300, 'MYL03031O001'] }] });
  const leap = await server.fetchMarket();
  assert.equal(leap[0].numericCode, '03031');
  server.storeUniverse(leap);
  assert.equal(getStocks().length, 1);
  assert.equal(db.prepare('SELECT active FROM universe WHERE stock=?').get('STOCK0').active, 0);
});
test('incomplete and duplicate market pages cannot replace the current universe', async () => {
  reset();
  stock();
  scan();
  for (const data of [
    { totalCount: 2, data: pageRows(0, 1) },
    { totalCount: 2, data: [...pageRows(0, 1), ...pageRows(0, 1)] },
  ]) {
    globalThis.fetch = async () => Response.json(data);
    await assert.rejects(server.fetchMarket());
    assert.equal(getStocks()[0].code, 'TEST');
  }
});
test('polling keeps a five-minute interval and preserves the last good snapshot on failure', async () => {
  reset();
  stock();
  let scans = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('tradingview.com')) {
      scans++;
      return Response.json({ totalCount: 1, data: [{ d: ['TEST', 'Test', 300, 'MYL0123OO000'] }] });
    }
    return Response.json({
      chart: {
        result: [
          {
            meta: { symbol: '0123.KL' },
            timestamp: [Date.parse('2026-10-02T09:00:00+08:00') / 1000],
            indicators: { quote: [{ volume: [100] }] },
          },
        ],
      },
    });
  };
  await server.poll();
  await server.performBackfill();
  assert.equal(scans, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM volume_alerts').get().n, 1);
  Date.now = () => fixed + 299000;
  await server.maybePoll();
  assert.equal(scans, 1);
  Date.now = () => fixed + 300000;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  await server.maybePoll();
  assert.equal(getStocks()[0].volume, 300);
  assert.match(server.buildState().status.error, /保留最近/);
});
test('backfill needs only volume, excludes unfinished/future days and recovers after upstream failure', async () => {
  reset();
  stock('TEST', 300, null);
  scan();
  let fail = true;
  globalThis.fetch = async () => {
    if (fail) return new Response('unavailable', { status: 503 });
    return Response.json({
      chart: {
        result: [
          {
            meta: { symbol: '0123.KL' },
            timestamp: ['2026-10-02', '2026-10-05', '2026-10-06'].map(
              (d) => Date.parse(d + 'T09:00:00+08:00') / 1000,
            ),
            indicators: { quote: [{ volume: [100, 999999, 999999] }] },
          },
        ],
      },
    });
  };
  assert.equal((await server.performBackfill()).done, 0);
  assert.ok(db.prepare('SELECT history_error FROM universe').get().history_error);
  fail = false;
  assert.equal((await server.performBackfill({ force: true })).done, 1);
  const bars = db.prepare('SELECT date,volume FROM daily_vol').all();
  assert.equal(bars.length, 1);
  assert.equal(bars[0].volume, 100);
  assert.equal(bars[0].date, '2026-10-02');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM volume_alerts').get().n, 1);
});
test('SSE supplies state immediately and Telegram commands only return simple volume data in the configured chat', async () => {
  reset();
  stock();
  scan();
  const controller = new AbortController();
  const response = await realFetch(base + '/api/events', { signal: controller.signal });
  const { value } = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(value), /"minimum_multiple":3/);
  controller.abort();
  assert.match(
    server.handleTelegramMessage({ chat: { id: 123 }, text: '/top' }, telegram),
    /TEST.*昨日 3.00 倍/,
  );
  assert.equal(server.handleTelegramMessage({ chat: { id: 999 }, text: '/top' }, telegram), null);
  assert.equal(
    server.handleTelegramMessage({ chat: { id: 123 }, text: '/set screen_vol_mult 2' }, telegram),
    null,
  );
});
test('migration keeps old data but cancels unsent strategy/image notifications once', () => {
  const migration = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-migrate-'));
  const old = new DatabaseSync(path.join(migration, 'data.db'));
  old.exec(
    "CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,text TEXT,attempts INTEGER DEFAULT 0,sent_at INTEGER,last_error TEXT,cancelled_at INTEGER,charts TEXT); INSERT INTO notification_outbox(ts,text,charts) VALUES(1,'old photo','[]'); CREATE TABLE daily_vol(stock TEXT,date TEXT,volume INTEGER,close REAL,PRIMARY KEY(stock,date)); INSERT INTO daily_vol VALUES('KEEP','2026-10-02',100,1.2);",
  );
  old.exec(`CREATE TABLE universe(stock TEXT PRIMARY KEY,name TEXT,code TEXT,active INTEGER DEFAULT 1,last_seen REAL,history_attempt REAL,history_success REAL,history_error TEXT);
    INSERT INTO universe(stock,name,code) VALUES('KEEP','Kept company','0123');
    CREATE TABLE live(stock TEXT PRIMARY KEY,name TEXT,price REAL,volume INTEGER,mtime REAL,session_date TEXT);
    INSERT INTO live VALUES('KEEP','Kept company',1.2,300,${fixed / 1000},'2026-10-05');`);
  old.close();
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `Date.now=()=>${fixed};const s=await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)}); console.log(JSON.stringify({old:s.db.prepare('SELECT * FROM notification_outbox').get(),bar:s.db.prepare('SELECT * FROM daily_vol').get(),stock:s.buildState().stocks[0]}));s.db.close();`,
      ],
      { env: { ...process.env, DATA_DIR: migration }, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.ok(result.old.cancelled_at);
    assert.equal(result.bar.close, 1.2);
    assert.equal(result.bar.volume, 100);
    assert.equal(result.stock.qualified, true);
  } finally {
    fs.rmSync(migration, { recursive: true, force: true });
  }
});
