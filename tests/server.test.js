import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-tests-'));
process.env.DATA_DIR = root;
process.env.ADMIN_TOKEN = 'isolated-test-token';
for (const key of [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'LLM_API_KEY',
  'TWILIO_SID',
  'TWILIO_AUTH_TOKEN',
])
  delete process.env[key];
const server = await import('../server.js');
const {
  app,
  db,
  DEFAULTS,
  saveConfig,
  runScreen,
  updateWatchlist,
  evaluateAlerts,
  evaluateGapUp,
  prepareBroadcast,
  deliverOutbox,
  findDoubleBottom,
} = server;
const realFetch = globalThis.fetch;
const actualNow = Date.now;
const fixed = Date.parse('2026-10-05T10:30:00+08:00');
Date.now = () => fixed;
let httpServer, base;
before(async () => {
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  base = 'http://127.0.0.1:' + httpServer.address().port;
});
after(async () => {
  globalThis.fetch = realFetch;
  Date.now = actualNow;
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'klse-tests-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-test-token' };
const post = (url, body, headers = admin) =>
  realFetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
function reset() {
  for (const table of [
    'live',
    'universe',
    'daily_vol',
    'state',
    'alerts',
    'gap_up_alert',
    'price_drop_alert',
    'db_bottom_alert',
    'watchlist',
    'notification_outbox',
    'kv',
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  saveConfig({ ...DEFAULTS, watchlist: [] });
}
function quote(code = 'TEST', price = 12, volume = 200) {
  db.prepare(
    'INSERT INTO live(stock,name,price,prevClose,open,volume,mtime,session_date) VALUES(?,?,?,?,?,?,?,?)',
  ).run(code, code, price, 11, 11, volume, fixed / 1000, '2026-10-05');
  db.prepare('INSERT INTO universe(stock,name,code) VALUES(?,?,?)').run(code, code, '0001');
}

test('public state is readable, private diagnostics and writes require the admin token', async () => {
  reset();
  const state = await realFetch(base + '/api/state');
  assert.equal(state.status, 200);
  const payload = await state.json();
  assert.ok(payload.insights);
  assert.ok(!JSON.stringify(payload).includes('isolated-test-token'));
  assert.equal(
    (await post('/api/settings', { window: '1d' }, { 'Content-Type': 'application/json' })).status,
    401,
  );
  for (const url of ['/api/tg-diag', '/api/tg-raw', '/api/llm-test?q=test', '/api/watchlist/reset'])
    assert.equal((await realFetch(base + url)).status, 401);
  assert.equal((await post('/api/settings', { window: '1d' })).status, 200);
  assert.equal((await post('/api/settings', { poll_interval_minutes: 'broken' })).status, 400);
});

test('screen asof is invariant to changes in later bars', () => {
  reset();
  quote();
  const insert = db.prepare('INSERT INTO daily_vol(stock,date,volume,close) VALUES(?,?,?,?)');
  for (let i = 0; i < 35; i++)
    insert.run(
      'TEST',
      new Date(Date.parse('2026-08-01') + i * 86400000).toISOString().slice(0, 10),
      i === 22 ? 1200000 : 500000,
      10 + i,
    );
  const opts = {
    asof: '2026-08-23',
    min_gain: -100,
    max_gain: 10000,
    vol_mult: 0,
    above_ma5: false,
    bullish_stack: false,
  };
  const first = runScreen(opts);
  assert.equal(first.count, 1);
  db.prepare('UPDATE daily_vol SET close=close*10,volume=volume*3 WHERE date>?').run(opts.asof);
  assert.deepEqual(runScreen(opts), first);
});

test('fifteen polls on entry day do not expire an observation', () => {
  reset();
  quote('OBS', 10, 100);
  db.prepare(
    'INSERT INTO watchlist(stock,name,added_date,entry_price,best_pct,days,outcome) VALUES(?,?,?,?,?,?,?)',
  ).run('OBS', 'Observe', '2026-10-05', 10, 0, 0, 'observing');
  for (let i = 0; i < 15; i++) updateWatchlist(DEFAULTS);
  const result = db.prepare('SELECT days,outcome FROM watchlist WHERE stock=?').get('OBS');
  assert.equal(result.days, 0);
  assert.equal(result.outcome, 'observing');
});

test('broadcast preview does not consume notification deduplication', async () => {
  reset();
  quote('GAP', 11.6, 100);
  const before = db.prepare('SELECT COUNT(*) c FROM gap_up_alert').get().c;
  const response = await realFetch(base + '/api/broadcast-test', { headers: admin });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).dry_run, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM gap_up_alert').get().c, before);
  await evaluateGapUp(DEFAULTS, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM gap_up_alert').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts').get().c, 1);
});

test('web alerts work without Telegram; cooldown crossing eventually fires', async () => {
  reset();
  quote('VOL', 12, 300);
  db.prepare('INSERT INTO daily_vol(stock,date,volume,close) VALUES(?,?,?,?)').run(
    'VOL',
    '2026-10-02',
    100,
    11,
  );
  const cfg = {
    ...DEFAULTS,
    window: '1d',
    price_thresholds: [{ max: null, threshold: 200 }],
    cooldown_minutes: 30,
  };
  db.prepare('INSERT INTO state(stock,above,last_alert) VALUES(?,?,?)').run(
    'VOL',
    0,
    fixed / 1000 - 60,
  );
  await evaluateAlerts(cfg);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts').get().c, 0);
  db.prepare('UPDATE state SET last_alert=?').run(fixed / 1000 - 1900);
  await evaluateAlerts(cfg);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts').get().c, 1);
  const state = await (await realFetch(base + '/api/state')).json();
  assert.equal(state.alerts.length, 1);
});

test('failed Telegram deliveries remain in the outbox and can be retried', async () => {
  reset();
  db.prepare('INSERT INTO notification_outbox(ts,text) VALUES(?,?)').run(
    fixed / 1000,
    'Isolated test',
  );
  const cfg = { ...DEFAULTS, telegram_bot_token: 'FAKE_TEST_TOKEN', telegram_chat_id: 'TEST_CHAT' };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, description: 'temporary failure' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  await deliverOutbox(cfg);
  let row = db.prepare('SELECT * FROM notification_outbox').get();
  assert.equal(row.sent_at, null);
  assert.equal(row.attempts, 1);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { 'Content-Type': 'application/json' },
    });
  await deliverOutbox(cfg);
  row = db.prepare('SELECT * FROM notification_outbox').get();
  assert.ok(row.sent_at);
  assert.equal(row.attempts, 2);
  globalThis.fetch = realFetch;
});

test('SSE sends an initial snapshot without waiting for a market poll', async () => {
  reset();
  const controller = new AbortController();
  const response = await realFetch(base + '/api/events', { signal: controller.signal });
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /data:.*"insights"/);
  controller.abort();
});

function seedTrendMarket(count = 5) {
  const dates = [],
    day = new Date('2026-10-02');
  while (dates.length < 25) {
    if (![0, 6].includes(day.getUTCDay())) dates.unshift(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  const insert = db.prepare(
    'INSERT INTO daily_vol(stock,date,volume,close,high,low) VALUES(?,?,?,?,?,?)',
  );
  for (let i = 0; i < count; i++) {
    const code = 'STRONG' + i;
    quote(code, 11.02, 500000 * (i + 2));
    dates.forEach((date, index) =>
      insert.run(code, date, index === 19 ? 1500000 : 500000, 11, 11.1, 10.9),
    );
  }
}

test('the whole universe is analyzed but only the strongest few are returned, without filling weak slots', async () => {
  reset();
  seedTrendMarket(5);
  quote('WEAK', 8, 20);
  quote('MISSING', 12, 100);
  let state = await (await realFetch(base + '/api/state')).json();
  assert.equal(state.stocks.length, 7);
  assert.equal(state.insights.scanned, 7);
  assert.equal(state.insights.confirmed, 5);
  assert.equal(state.insights.candidates.length, 3);
  assert.ok(state.insights.candidates.every((report) => report.stage === 'coiled'));
  assert.equal(state.insights.coiled, 5);
  assert.equal(state.insights.candidates[0].code, 'STRONG4');
  assert.ok(
    state.insights.candidates.every(
      (r) => r.volume_signal.current >= 1000000 && r.volume_signal.multiple >= 2,
    ),
  );
  updateWatchlist(DEFAULTS);
  assert.deepEqual(
    db
      .prepare('SELECT stock FROM watchlist ORDER BY stock')
      .all()
      .map((r) => r.stock),
    state.insights.candidates.map((r) => r.code).sort(),
  );
  assert.ok(
    db
      .prepare('SELECT signal FROM watchlist')
      .all()
      .every((r) => r.signal === '放量蓄势'),
  );
  for (const code of ['STRONG2', 'STRONG3', 'STRONG4'])
    db.prepare('DELETE FROM live WHERE stock=?').run(code);
  saveConfig({ ...DEFAULTS, watchlist: [] });
  state = await (await realFetch(base + '/api/state')).json();
  assert.equal(state.insights.candidates.length, 2);
  assert.ok(!state.insights.candidates.some((report) => ['WEAK', 'MISSING'].includes(report.code)));
});

test('lunch-break shortlist does not mix older-session or orphaned high-volume snapshots', async () => {
  reset();
  seedTrendMarket(1);
  quote('OLD', 15, 9000000);
  quote('ORPHAN', 13, 12000000);
  db.prepare(
    'INSERT INTO daily_vol(stock,date,volume,close) SELECT ?,date,volume,close FROM daily_vol WHERE stock=?',
  ).run('OLD', 'STRONG0');
  db.prepare(
    'INSERT INTO daily_vol(stock,date,volume,close) SELECT ?,date,volume,close FROM daily_vol WHERE stock=?',
  ).run('ORPHAN', 'STRONG0');
  db.prepare('UPDATE daily_vol SET close=15,volume=9000000 WHERE stock=? AND date=?').run(
    'OLD',
    '2026-10-02',
  );
  db.prepare('UPDATE live SET session_date=? WHERE stock=?').run('2026-10-02', 'OLD');
  db.prepare('DELETE FROM universe WHERE stock=?').run('ORPHAN');
  const lunch = fixed + 145 * 60000;
  db.prepare('UPDATE live SET mtime=?').run(lunch / 1000);
  Date.now = () => lunch;
  try {
    assert.equal(server.getStockReport('OLD').stage, 'confirmed');
    const state = await (await realFetch(base + '/api/state')).json();
    assert.equal(state.insights.scanned, 2);
    assert.equal(state.insights.volume_qualified, 1);
    assert.equal(state.insights.snapshot_date, '2026-10-05');
    assert.deepEqual(
      state.insights.candidates.map((r) => r.code),
      ['STRONG0'],
    );
  } finally {
    Date.now = () => fixed;
  }
});

test('setup shortlist prioritizes unbroken bases over early breakouts and excludes already-rallied stocks', async () => {
  reset();
  seedTrendMarket(3);
  db.prepare('UPDATE live SET price=?,prevClose=? WHERE stock=?').run(11.12, 11, 'STRONG1');
  db.prepare('UPDATE live SET price=?,prevClose=? WHERE stock=?').run(13, 11, 'STRONG2');
  quote('GENERIC', 13, 3000000);
  db.prepare(
    'INSERT INTO daily_vol(stock,date,volume,close) SELECT ?,date,volume,close FROM daily_vol WHERE stock=?',
  ).run('GENERIC', 'STRONG0');
  const state = await (await realFetch(base + '/api/state')).json();
  assert.deepEqual(
    state.insights.candidates.map((r) => [r.code, r.stage]),
    [
      ['STRONG0', 'coiled'],
      ['STRONG1', 'confirmed'],
    ],
  );
  assert.equal(state.insights.coiled, 1);
  assert.equal(state.insights.breakout, 1);
  assert.equal(server.getStockReport('STRONG2').stage, 'extended');
  assert.equal(server.getStockReport('GENERIC').stage, 'confirmed');
  assert.equal(server.getStockReport('GENERIC').volume_setup.qualified, false);
  updateWatchlist(DEFAULTS);
  assert.deepEqual(
    db
      .prepare('SELECT stock,signal FROM watchlist ORDER BY stock')
      .all()
      .map((r) => [r.stock, r.signal]),
    [
      ['STRONG0', '放量蓄势'],
      ['STRONG1', '蓄势后初步突破'],
    ],
  );
});

test('market pagination scans beyond the old fixed cap and sorts by a stable symbol', async () => {
  const ranges = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://scanner.tradingview.com/malaysia/scan');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.sort, { sortBy: 'name', sortOrder: 'asc' });
    const start = body.range[0];
    ranges.push(start);
    const count = Math.min(500, 5501 - start);
    return new Response(
      JSON.stringify({
        totalCount: 5501,
        data: Array.from({ length: count }, (_, i) => ({
          d: ['STOCK' + (start + i), 'Example', 1, 1, 100, 0, 0, 100, 100],
        })),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    const quotes = await server.fetchMarket();
    assert.equal(quotes.length, 5501);
    assert.equal(ranges.at(-1), 5500);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('deduplication and outbox survive a failed broadcast without creating a second copy', async () => {
  reset();
  seedTrendMarket(1);
  const cfg = { ...DEFAULTS, telegram_bot_token: 'FAKE_TEST_TOKEN', telegram_chat_id: 'TEST_CHAT' };
  saveConfig(cfg);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, description: 'temporary failure' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  await server.runBroadcast(cfg);
  let outbox = db.prepare('SELECT * FROM notification_outbox').all();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].sent_at, null);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { 'Content-Type': 'application/json' },
    });
  await server.runBroadcast(cfg);
  outbox = db.prepare('SELECT * FROM notification_outbox').all();
  assert.equal(outbox.length, 1);
  assert.ok(outbox[0].sent_at);
  globalThis.fetch = realFetch;
});

test('ordinary Telegram members cannot change settings or credentials', async () => {
  reset();
  const cfg = { ...DEFAULTS, telegram_bot_token: 'FAKE_TEST_TOKEN', telegram_chat_id: '-123' };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  const reply = await server.handleTelegramMessage(
    { text: '/set pick_count 5', chat: { id: -123, type: 'supergroup' }, from: { id: 1 } },
    cfg,
  );
  assert.match(reply, /只有群主或管理员/);
  assert.equal(server.loadConfig().pick_count, 3);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: { status: 'administrator' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  const secretReply = await server.handleTelegramMessage(
    { text: '/set llm_api_key stolen', chat: { id: -123, type: 'supergroup' }, from: { id: 1 } },
    cfg,
  );
  assert.match(secretReply, /不允许修改/);
  assert.equal(server.loadConfig().llm_api_key, '');
  globalThis.fetch = realFetch;
});
