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
    'potential_events',
    'closing_briefings',
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
  const cfg = {
    ...DEFAULTS,
    final_briefing_on: false,
    telegram_bot_token: 'FAKE_TEST_TOKEN',
    telegram_chat_id: 'TEST_CHAT',
  };
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
    assert.equal(server.getStockReport('OLD').potential_eligible, false);
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

test('setup shortlist ranks evidence across paths and excludes already-rallied stocks', async () => {
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
      ['STRONG1', 'confirmed'],
      ['STRONG0', 'coiled'],
    ],
  );
  assert.equal(state.insights.coiled, 1);
  assert.equal(state.insights.breakout, 1);
  assert.equal(server.getStockReport('STRONG2').stage, 'extended');
  assert.equal(server.getStockReport('GENERIC').stage, 'watch');
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
  const cfg = {
    ...DEFAULTS,
    final_briefing_on: false,
    telegram_bot_token: 'FAKE_TEST_TOKEN',
    telegram_chat_id: 'TEST_CHAT',
  };
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

test('incomplete or duplicate source pagination cannot replace the complete stock pool', async () => {
  reset();
  quote('KEEP');
  for (const scenario of ['short', 'duplicate', 'changed']) {
    globalThis.fetch = async (url, options) => {
      const start = JSON.parse(options.body).range[0];
      const data = Array.from(
        { length: start === 0 ? 500 : scenario === 'short' ? 0 : 1 },
        (_, i) => ({
          d: [
            start === 500 && scenario === 'duplicate' ? 'S0' : 'S' + (start + i),
            'Example',
            1,
            1,
            100,
            0,
            0,
            100,
            100,
          ],
        }),
      );
      return Response.json({
        totalCount: start === 500 && scenario === 'changed' ? 502 : 501,
        data,
      });
    };
    try {
      await assert.rejects(server.fetchMarket(), /提前结束|重复|数量变化/);
      assert.equal(db.prepare('SELECT active FROM universe WHERE stock=?').get('KEEP').active, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test('complete universe refresh keeps invalid quotes visible, maps ISIN and retires obsolete entries', async () => {
  reset();
  quote('OLD');
  quote('INVALID');
  globalThis.fetch = async () =>
    Response.json({
      totalCount: 2,
      data: [
        {
          d: [
            'BUSCAP',
            'Bus Cap Berhad',
            0.7,
            0.785,
            6855800,
            18.94,
            0.125,
            2000000,
            2000000,
            0.8,
            0.665,
            'MYQ0455OO004',
          ],
        },
        {
          d: [
            'INVALID',
            'Missing current quote',
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
          ],
        },
      ],
    });
  try {
    const quotes = await server.fetchMarket();
    server.storeUniverse(quotes);
    quotes.forEach((q) => server.updateQuote(q));
    assert.equal(db.prepare('SELECT code FROM universe WHERE stock=?').get('BUSCAP').code, '0455');
    assert.equal(db.prepare('SELECT active FROM universe WHERE stock=?').get('OLD').active, 0);
    assert.equal(db.prepare('SELECT price FROM live WHERE stock=?').get('INVALID').price, null);
    const state = await (await realFetch(base + '/api/state')).json();
    assert.equal(state.insights.scanned, 2);
    assert.equal(state.stocks.length, 2);
    const c = await (await realFetch(base + '/api/coverage')).json();
    assert.equal(c.expected, 2);
    assert.equal(c.received, 2);
    assert.equal(c.quoted, 1);
    assert.equal(c.analyzed, 2);
    assert.ok(c.issues.some((i) => i.code === 'INVALID' && i.reason === '缺少有效行情'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('history failure preserves existing bars, records the gap and retry recovers incomplete OHLC', async () => {
  reset();
  quote('RETRY');
  db.prepare('INSERT INTO daily_vol(stock,date,volume,close) VALUES(?,?,?,?)').run(
    'RETRY',
    '2026-10-02',
    1200000,
    1,
  );
  globalThis.fetch = async () => new Response('temporary', { status: 503 });
  try {
    assert.deepEqual(await server.performBackfill(), { done: 0, total: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM daily_vol').get().c, 1);
    assert.ok(db.prepare('SELECT history_error FROM universe').get().history_error);
    assert.equal(server.historyRefreshQueue().length, 0); // ten-minute retry backoff
    globalThis.fetch = async () =>
      Response.json({
        chart: {
          result: [
            {
              meta: { symbol: '0001.KL' },
              timestamp: [Date.parse('2026-10-02T09:00:00+08:00') / 1000],
              indicators: {
                quote: [{ volume: [1200000], open: [0.95], high: [1.05], low: [0.94], close: [1] }],
              },
            },
          ],
        },
      });
    assert.deepEqual(await server.performBackfill({ force: true }), { done: 1, total: 1 });
    assert.equal(db.prepare('SELECT high FROM daily_vol').get().high, 1.05);
    assert.equal(db.prepare('SELECT history_error FROM universe').get().history_error, null);
    assert.equal(server.historyRefreshQueue().length, 0);
    const c = await (await realFetch(base + '/api/coverage')).json();
    assert.equal(c.insufficient_history, 1); // One repaired bar is not invented as twenty bars.
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('qualified signals outside the top three remain queryable and ledger deduplication preserves discovery time', async () => {
  reset();
  seedTrendMarket(5);
  let r = server.getStockReport('STRONG0');
  assert.equal(r.selection.selected, false);
  assert.equal(r.selection.rank, 5);
  assert.match(r.selection.reason, /排名第5/);
  server.persistPotentialEvents();
  const first = db
    .prepare('SELECT first_seen FROM potential_events WHERE stock=? ORDER BY date DESC')
    .get('STRONG0').first_seen;
  const count = db.prepare('SELECT COUNT(*) c FROM potential_events').get().c;
  server.persistPotentialEvents();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM potential_events').get().c, count);
  assert.equal(
    db
      .prepare('SELECT first_seen FROM potential_events WHERE stock=? ORDER BY date DESC')
      .get('STRONG0').first_seen,
    first,
  );
  const signals = await (await realFetch(base + '/api/signals?q=STRONG0')).json();
  assert.equal(signals.total, 1);
  assert.equal(signals.items[0].code, 'STRONG0');
  assert.ok(signals.history.length > 0);
  assert.match(signals.note, /不代表当时/);
});

test('BUSCAP historical breakout is tracked by public APIs even though current double-volume fails', async () => {
  reset();
  const fixture = JSON.parse(
    fs.readFileSync(new URL('./fixtures/buscap-2026.json', import.meta.url), 'utf8'),
  );
  const current = Date.parse('2026-10-06T11:35:00+08:00');
  Date.now = () => current;
  try {
    quote('BUSCAP', 0.785, 6855800);
    db.prepare('UPDATE live SET session_date=?,mtime=?,prevClose=? WHERE stock=?').run(
      '2026-10-06',
      current / 1000,
      0.66,
      'BUSCAP',
    );
    const insert = db.prepare(
      'INSERT INTO daily_vol(stock,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)',
    );
    for (const b of fixture.bars)
      insert.run('BUSCAP', b.date, b.open, b.high, b.low, b.close, b.volume);
    const report = await (await realFetch(base + '/api/stocks/BUSCAP')).json();
    assert.equal(report.stage, 'tracking');
    assert.equal(report.selection.selected, false);
    assert.match(report.selection.reason, /追踪池/);
    assert.equal(report.tracking_signal.date, '2026-10-02');
    assert.equal(report.volume_signal.pass, false);
    server.persistPotentialEvents();
    const signals = await (await realFetch(base + '/api/signals?q=BUSCAP')).json();
    assert.equal(signals.total, 1);
    assert.ok(signals.history.some((s) => s.date === '2026-09-25' && s.kind === 'building'));
    assert.ok(signals.history.every((s) => s.first_seen === current / 1000));
  } finally {
    Date.now = () => fixed;
  }
});

test('legacy slow polling is capped at five minutes and settings reject slower intervals', async () => {
  reset();
  saveConfig({ ...DEFAULTS, poll_interval_minutes: 30 });
  assert.equal(server.loadConfig().poll_interval_minutes, 5);
  assert.equal((await post('/api/settings', { poll_interval_minutes: 30 })).status, 400);
});

test('five-digit LEAP ISIN codes repair mapping and immediately retry a previous mapping failure', async () => {
  reset();
  quote('POLYDM');
  db.prepare('UPDATE universe SET code=NULL,history_attempt=?,history_error=? WHERE stock=?').run(
    fixed / 1000,
    'Yahoo 暂无匹配的数字代码',
    'POLYDM',
  );
  globalThis.fetch = async () =>
    Response.json({
      totalCount: 1,
      data: [
        {
          d: [
            'POLYDM',
            'Polydamic Group Bhd.',
            0.45,
            0.45,
            0,
            0,
            0,
            100000,
            100000,
            0.45,
            0.45,
            'MYL03031O001',
          ],
        },
      ],
    });
  try {
    const quotes = await server.fetchMarket();
    assert.equal(quotes[0].numericCode, '03031');
    server.storeUniverse(quotes);
    const u = db.prepare('SELECT * FROM universe WHERE stock=?').get('POLYDM');
    assert.equal(u.code, '03031');
    assert.equal(u.history_attempt, null);
    assert.equal(u.history_error, null);
    assert.equal(server.historyRefreshQueue().length, 1);
    const unknown = await (await realFetch(base + '/api/stocks/POLYDM')).json();
    assert.equal(unknown.stage, 'insufficient');
  } finally {
    globalThis.fetch = realFetch;
  }
});

function briefingClock(time, count = 1) {
  const current = Date.parse('2026-10-05T' + time + '+08:00');
  Date.now = () => current;
  db.prepare('UPDATE live SET mtime=?,session_date=?').run(current / 1000, '2026-10-05');
  db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)').run(
    'market_scan_coverage',
    JSON.stringify({ expected: count, received: count, valid: count, at: current / 1000 }),
  );
  return current / 1000;
}

test('two closing slots use the full pool, freeze snapshot prices and atomically deduplicate the website and notification queue', async () => {
  reset();
  seedTrendMarket(5);
  const cfg = { ...DEFAULTS, telegram_bot_token: 'FAKE_TEST_TOKEN', telegram_chat_id: 'TEST_CHAT' };
  for (let i = 1; i < 5; i++) {
    db.prepare('UPDATE live SET volume=2000000 WHERE stock=?').run('STRONG' + i);
    db.prepare('UPDATE daily_vol SET volume=900000 WHERE stock=? AND date=?').run(
      'STRONG' + i,
      '2026-10-02',
    );
  }
  db.prepare('UPDATE live SET volume=1500000 WHERE stock=?').run('STRONG0');
  try {
    briefingClock('16:00:30', 5);
    saveConfig(cfg);
    const state = server.buildState();
    assert.ok(!state.insights.candidates.some((r) => r.code === 'STRONG0'));
    const first = server.recordFinalBriefing('16:00', cfg);
    assert.deepEqual(
      first.items.map((r) => r.code),
      ['STRONG0'],
    );
    assert.equal(server.recordFinalBriefing('16:00', cfg), null);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM closing_briefings').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_outbox').get().c, 1);
    briefingClock('16:30:30', 5);
    db.prepare('UPDATE live SET price=11.04,volume=1600000 WHERE stock=?').run('STRONG0');
    saveConfig(cfg);
    assert.equal(server.recordFinalBriefing('16:30', cfg).items[0].price, 11.04);
    const snapshot = JSON.parse(
      db.prepare('SELECT items FROM closing_briefings WHERE slot=?').get('16:00').items,
    );
    assert.equal(snapshot[0].price, 11.02);
    assert.equal(snapshot[0].volume, 1500000);
    assert.equal(
      server.closingBriefingState({ ...cfg, screen_vol_mult: 4 }).latest.minimum_multiple,
      3,
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_outbox').get().c, 2);
    globalThis.fetch = async () => Response.json({ ok: false, description: 'temporary failure' });
    await deliverOutbox(cfg);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM notification_outbox WHERE sent_at IS NULL').get().c,
      2,
    );
    assert.equal(server.recordFinalBriefing('16:30', cfg), null);
    globalThis.fetch = async () => Response.json({ ok: true, result: {} });
    await deliverOutbox(cfg);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM notification_outbox WHERE sent_at IS NULL').get().c,
      0,
    );
  } finally {
    Date.now = () => fixed;
    globalThis.fetch = realFetch;
  }
});

test('late-day scans cannot substitute stale data; a completed empty scan is reported honestly', () => {
  reset();
  seedTrendMarket(1);
  try {
    const now = briefingClock('16:00:20');
    db.prepare('UPDATE kv SET v=? WHERE k=?').run(
      JSON.stringify({ expected: 1, received: 1, valid: 1, at: now - 21 }),
      'market_scan_coverage',
    );
    saveConfig(DEFAULTS);
    assert.equal(server.recordFinalBriefing('16:00'), null);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM closing_briefings').get().c, 0);
    briefingClock('16:00:40');
    saveConfig(DEFAULTS);
    const r = server.recordFinalBriefing('16:00');
    assert.equal(r.status, 'empty');
    assert.deepEqual(r.items, []);
    assert.match(db.prepare('SELECT text FROM closing_briefings').get().text, /没有符合完整条件/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_outbox').get().c, 0);
  } finally {
    Date.now = () => fixed;
  }
});

test('a failing transaction leaves neither a published closing bulletin nor a notification', () => {
  reset();
  seedTrendMarket(2);
  const cfg = { ...DEFAULTS, telegram_bot_token: 'FAKE_TEST_TOKEN', telegram_chat_id: 'TEST_CHAT' };
  try {
    briefingClock('16:00:20', 2);
    saveConfig(cfg);
    db.exec(
      "CREATE TRIGGER fail_briefing BEFORE INSERT ON closing_briefings BEGIN SELECT RAISE(ABORT,'simulated'); END;",
    );
    assert.throws(() => server.recordFinalBriefing('16:00', cfg), /simulated/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM closing_briefings').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_outbox').get().c, 0);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_briefing');
    Date.now = () => fixed;
  }
});

test('next-day tracking waits for the next trading date, distinguishes intraday and close, and shows losses', () => {
  reset();
  quote('FOLLOW', 0.97, 2000000);
  const item = {
    code: 'FOLLOW',
    price: 1,
    volume: 2000000,
    multiple: 3,
    resistance: 1.02,
    support: 0.95,
  };
  db.prepare(
    'INSERT INTO closing_briefings(date,slot,created_at,quote_at,status,items,text) VALUES(?,?,?,?,?,?,?)',
  ).run(
    '2026-10-02',
    '16:30',
    fixed / 1000,
    fixed / 1000,
    'ready',
    JSON.stringify([item]),
    'fixture',
  );
  let follow = server.closingBriefingState().follow[0];
  assert.equal(follow.next_date, '2026-10-05');
  assert.equal(follow.status, '次日盘中');
  assert.equal(follow.change_pct, -3);
  db.prepare('INSERT INTO daily_vol(stock,date,close,volume) VALUES(?,?,?,?)').run(
    'FOLLOW',
    '2026-10-05',
    0.96,
    2000000,
  );
  // A partially stored current-day bar cannot be labelled a close before market close.
  assert.equal(server.closingBriefingState().follow[0].status, '次日盘中');
  try {
    Date.now = () => Date.parse('2026-10-05T17:30:00+08:00');
    follow = server.closingBriefingState().follow[0];
    assert.equal(follow.status, '次日收盘');
    assert.equal(follow.change_pct, -4);
    const cfg = { ...DEFAULTS, market_holidays: ['2026-10-05'] };
    assert.equal(server.closingBriefingState(cfg).follow[0].status, '等待次日');
  } finally {
    Date.now = () => fixed;
  }
});

test('scheduled mode suppresses intraday shortlist pushes while settings can switch to website-only notices', async () => {
  reset();
  seedTrendMarket(2);
  assert.equal(prepareBroadcast(DEFAULTS, { includeShortlist: false }), null);
  assert.equal(
    (await post('/api/settings', { final_briefing_on: true, final_briefing_telegram: false }))
      .status,
    200,
  );
  assert.equal(server.loadConfig().final_briefing_telegram, false);
  assert.equal((await post('/api/settings', { final_briefing_telegram: 'false' })).status, 400);
  try {
    briefingClock('16:00:30', 2);
    const cfg = {
      ...DEFAULTS,
      final_briefing_telegram: false,
      telegram_bot_token: 'FAKE_TEST_TOKEN',
      telegram_chat_id: 'TEST_CHAT',
    };
    saveConfig(cfg);
    assert.ok(server.recordFinalBriefing('16:00', cfg));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_outbox').get().c, 0);
  } finally {
    Date.now = () => fixed;
  }
});

test('the automatic closing scheduler forces a complete fresh scan, serializes ticks and retries a failed second slot', async () => {
  reset();
  seedTrendMarket(2);
  let scans = 0,
    fail = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('scanner.tradingview.com')) {
      scans++;
      if (fail) return new Response('temporary', { status: 503 });
      return Response.json({
        totalCount: 2,
        data: [0, 1].map((i) => ({
          d: [
            'STRONG' + i,
            'Example ' + i,
            11,
            11.02,
            2000000,
            0.18,
            0.02,
            500000,
            500000,
            11.1,
            10.9,
            'MYQ0001OO001',
          ],
        })),
      });
    }
    return new Response('no fixture data', { status: 404 });
  };
  try {
    Date.now = () => Date.parse('2026-10-05T16:00:20+08:00');
    await Promise.all([
      server.maybeFinalBriefings(),
      server.maybeFinalBriefings(),
      server.maybeFinalBriefings(),
    ]);
    assert.equal(scans, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM closing_briefings').get().c, 1);
    assert.equal(server.closingBriefingState().today[0].slot, '16:00');
    await server.maybeFinalBriefings();
    assert.equal(scans, 1);
    Date.now = () => Date.parse('2026-10-05T16:30:20+08:00');
    fail = true;
    await server.maybeFinalBriefings();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM closing_briefings').get().c, 1);
    Date.now = () => Date.parse('2026-10-05T16:30:40+08:00');
    fail = false;
    await server.maybeFinalBriefings();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM closing_briefings').get().c, 2);
    assert.equal(server.closingBriefingState().today[0].slot, '16:30');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM notification_outbox').get().c, 0);
  } finally {
    Date.now = () => fixed;
    globalThis.fetch = realFetch;
  }
});
