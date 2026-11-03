import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { previousTradingDate } from '../lib/volume.js';
import {
  recordPeriodGainNotifications,
  periodGainNotificationState,
} from '../lib/period-gain-notifications.js';
import { validateSettings } from '../lib/settings.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-period-gain-'));
process.env.DATA_DIR = root;
process.env.ADMIN_TOKEN = 'test-admin';
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LLM_API_KEY'])
  delete process.env[key];
const { app, db, DEFAULTS, deliverOutbox, runBroadcast } = await import('../server.js');
const realNow = Date.now,
  realFetch = globalThis.fetch;
const fixed = Date.parse('2026-10-26T10:30:00+08:00');
const cfg = {
  ...DEFAULTS,
  telegram_bot_token: 'FAKE',
  telegram_chat_id: '123',
  potential_alerts_telegram: false,
  volume_alerts_telegram: false,
  gain_alerts_telegram: false,
};
const dates = [];
for (let day = '2026-10-26'; dates.length < 21;) {
  day = previousTradingDate(day);
  dates.push(day);
}
beforeEach(() => {
  Date.now = () => fixed;
  globalThis.fetch = realFetch;
  for (const table of [
    'period_gain_alerts',
    'notification_outbox',
    'live',
    'universe',
    'daily_vol',
    'kv',
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("INSERT INTO kv(k,v) VALUES('market_scan_coverage',?)").run(
    JSON.stringify({ at: fixed / 1000, expected: 1, received: 1 }),
  );
});
after(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function stock(code, gain5 = 10, gain20 = 10) {
  const price = 1.2;
  db.prepare('INSERT INTO universe(stock,name,code,active) VALUES(?,?,?,1)').run(
    code,
    code,
    '0123',
  );
  db.prepare(
    'INSERT INTO live(stock,name,price,prevClose,open,high,low,volume,mtime,session_date) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(code, code, price, 1.19, 1.19, 1.21, 1.18, 9000000, fixed / 1000, '2026-10-26');
  for (const [i, date] of dates.entries()) {
    const close =
      i === 4 ? price / (1 + gain5 / 100) : i === 19 ? price / (1 + gain20 / 100) : 1.19;
    db.prepare(
      'INSERT INTO daily_vol(stock,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)',
    ).run(code, date, close, close + 0.01, close - 0.01, close, 100);
  }
}

test('both rolling ranges include boundaries, use dated closes, exclude future data and remain independent of volume filters', () => {
  stock('LOWER', 7, 7);
  stock('UPPER', 15, 15);
  stock('BELOW', 6.999, 6.999);
  stock('ABOVE', 15.001, 15.001);
  db.prepare(
    "INSERT INTO daily_vol(stock,date,close,volume) VALUES('LOWER','2026-10-27',999,100)",
  ).run();
  const matches = recordPeriodGainNotifications(db, {
    ...cfg,
    screen_min_volume: 1e12,
    screen_vol_mult: 99,
  });
  assert.deepEqual(matches.map((s) => `${s.code}:${s.days}`).sort(), [
    'LOWER:20',
    'LOWER:5',
    'UPPER:20',
    'UPPER:5',
  ]);
  const row = db.prepare("SELECT * FROM period_gain_alerts WHERE stock='LOWER' AND days=5").get();
  assert.equal(row.reference_date, dates[4]);
  assert.ok(Math.abs(row.gain - 7) < 1e-9);
  const notice = db.prepare('SELECT * FROM notification_outbox WHERE id=?').get(row.outbox_id);
  assert.match(notice.text, /股票代号：LOWER/);
  const chart = JSON.parse(notice.charts)[0];
  assert.equal(chart.gain_days, 5);
  assert.equal(chart.rows.at(-1).date, '2026-10-26');
  assert.ok(!chart.rows.some((r) => r.date > '2026-10-26'));
});

test('missing trading dates, stale/future/inactive quotes, invalid OHLC and incomplete scans cannot trigger notifications', () => {
  for (const code of ['GAP', 'STALE', 'FUTURE', 'INACTIVE', 'OHLC', 'SHORT']) stock(code);
  db.prepare("DELETE FROM daily_vol WHERE stock='GAP' AND date=?").run(dates[2]);
  db.prepare("UPDATE live SET mtime=mtime-181 WHERE stock='STALE'").run();
  db.prepare("UPDATE live SET mtime=mtime+1 WHERE stock='FUTURE'").run();
  db.prepare("UPDATE universe SET active=0 WHERE stock='INACTIVE'").run();
  db.prepare("UPDATE live SET high=NULL WHERE stock='OHLC'").run();
  db.prepare("DELETE FROM daily_vol WHERE stock='SHORT' AND date<=?").run(dates[3]);
  assert.equal(recordPeriodGainNotifications(db, cfg).length, 0);
  stock('VALID');
  db.prepare("UPDATE kv SET v=? WHERE k='market_scan_coverage'").run(
    JSON.stringify({ at: fixed / 1000, expected: 2, received: 1 }),
  );
  assert.equal(recordPeriodGainNotifications(db, cfg).length, 0);
});

test('daily dedup survives restart, rolls back atomically, and allows a separate notice for each period', () => {
  stock('BOTH');
  db.exec(
    "CREATE TRIGGER fail_period BEFORE INSERT ON period_gain_alerts BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  assert.throws(() => recordPeriodGainNotifications(db, cfg), /test rollback/);
  db.exec('DROP TRIGGER fail_period');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n, 0);
  assert.equal(recordPeriodGainNotifications(db, cfg).length, 2);
  assert.equal(recordPeriodGainNotifications(db, cfg).length, 0);
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `Date.now=()=>${fixed};const s=await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});const m=await import(${JSON.stringify(new URL('../lib/period-gain-notifications.js', import.meta.url).href)});console.log(m.recordPeriodGainNotifications(s.db,s.DEFAULTS).length);s.db.close();`,
    ],
    { env: { ...process.env, DATA_DIR: root }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), '0');
  Date.now = () => fixed + 86400000;
  db.prepare("UPDATE live SET session_date='2026-10-27',mtime=?").run(Date.now() / 1000);
  db.prepare(
    "INSERT INTO daily_vol(stock,date,open,high,low,close,volume) VALUES('BOTH','2026-10-26',1.19,1.21,1.18,1.2,100)",
  ).run();
  for (const [date, close] of [
    [dates[3], 1.2 / 1.1],
    [dates[18], 1.2 / 1.1],
  ])
    db.prepare(
      "UPDATE daily_vol SET open=?,high=?,low=?,close=? WHERE stock='BOTH' AND date=?",
    ).run(close, close + 0.01, close - 0.01, close, date);
  db.prepare("UPDATE kv SET v=? WHERE k='market_scan_coverage'").run(
    JSON.stringify({ at: Date.now() / 1000, expected: 1, received: 1 }),
  );
  assert.equal(recordPeriodGainNotifications(db, cfg).length, 2);
});

test('five-day alerts do not require twenty-day history, and weekends/holidays use the configured trading calendar', () => {
  stock('SHORT');
  db.prepare("DELETE FROM daily_vol WHERE stock='SHORT' AND date<=?").run(dates[5]);
  assert.deepEqual(
    recordPeriodGainNotifications(db, cfg).map((s) => s.days),
    [5],
  );
  stock('HOLIDAY', 10, 10);
  const close = 1.2 / 1.1;
  db.prepare(
    "UPDATE daily_vol SET open=?,high=?,low=?,close=? WHERE stock='HOLIDAY' AND date=?",
  ).run(close, close + 0.01, close - 0.01, close, dates[5]);
  const matches = recordPeriodGainNotifications(db, { ...cfg, market_holidays: [dates[0]] });
  assert.deepEqual(
    matches.map((s) => `${s.code}:${s.days}`),
    ['HOLIDAY:5'],
  );
  assert.equal(
    db
      .prepare("SELECT reference_date FROM period_gain_alerts WHERE stock='HOLIDAY' AND days=5")
      .get().reference_date,
    dates[5],
  );
  assert.equal(
    recordPeriodGainNotifications(db, { ...cfg, market_holidays: ['2026-10-26'] }).length,
    0,
  );
  Date.now = () => Date.parse('2026-10-25T10:30:00+08:00');
  assert.equal(recordPeriodGainNotifications(db, cfg).length, 0);
});

test('each period has its own switch and queue; failures retry identical frozen PNGs, and stale notices expire', async () => {
  stock('BOTH');
  recordPeriodGainNotifications(db, cfg);
  let calls = [];
  globalThis.fetch = async (url, options) => {
    assert.match(url, /sendPhoto$/);
    const caption = options.body.get('caption');
    const png = Buffer.from(await options.body.get('photo').arrayBuffer());
    calls.push({ caption, png });
    return Response.json({ ok: caption.includes('近20个') });
  };
  await deliverOutbox(cfg);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.png.readUInt32BE(20) === 620));
  db.prepare('UPDATE live SET price=1.201').run();
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.body.get('caption'), calls[0].caption);
    assert.deepEqual(Buffer.from(await options.body.get('photo').arrayBuffer()), calls[0].png);
    return Response.json({ ok: true });
  };
  await deliverOutbox(cfg);
  assert.ok(periodGainNotificationState(db, cfg).alerts.every((s) => s.sent_at));
  db.prepare('UPDATE notification_outbox SET sent_at=NULL').run();
  Date.now = () => fixed + 901000;
  globalThis.fetch = async () => {
    throw new Error('expired notices must not send');
  };
  await deliverOutbox(cfg);
  assert.ok(periodGainNotificationState(db, cfg).alerts.every((s) => s.cancelled_at));
  Date.now = () => fixed;
  stock('WEB');
  recordPeriodGainNotifications(db, { ...cfg, gain_5d_alerts_telegram: false });
  const saved = db
    .prepare(
      "SELECT o.* FROM notification_outbox o JOIN period_gain_alerts a ON a.outbox_id=o.id WHERE a.stock='WEB' AND a.days=5",
    )
    .get();
  assert.equal(saved.last_error, '仅网页');
  assert.equal(
    validateSettings({ gain_20d_alerts_telegram: false }, cfg).gain_5d_alerts_telegram,
    true,
  );
  assert.throws(() => validateSettings({ gain_5d_alerts_telegram: 'yes' }, cfg));
});

test('normal broadcast evaluates both periods; public state and image endpoints expose the matching frozen chart', async () => {
  stock('BOTH');
  globalThis.fetch = async () => Response.json({});
  await runBroadcast({
    ...DEFAULTS,
    potential_alerts_telegram: false,
    volume_alerts_telegram: false,
  });
  assert.equal(periodGainNotificationState(db, cfg).alerts.length, 2);
  const http = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => http.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${http.address().port}`;
    const state = await (await realFetch(base + '/api/state')).json();
    assert.equal(state.period_gain_notifications.rules.length, 2);
    const image = await realFetch(base + state.period_gain_notifications.alerts[0].image);
    assert.equal(image.status, 200);
    assert.equal(Buffer.from(await image.arrayBuffer()).readUInt32BE(20), 620);
    const id = state.period_gain_notifications.alerts[0].outbox_id;
    assert.equal((await realFetch(base + `/api/potential-alerts/${id}/chart.png`)).status, 404);
    assert.equal((await realFetch(base + `/api/gain-alerts/${id}/chart.png`)).status, 404);
  } finally {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
});

test('queued period notices stop if current price/volume fails and can re-arm after recovery without blocking the other period', async () => {
  stock('RULES');
  recordPeriodGainNotifications(db, cfg);
  db.prepare('UPDATE live SET volume=8000000').run();
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(options.body.get('caption'));
    return Response.json({ ok: true });
  };
  await deliverOutbox(cfg);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /近5个/);
  db.prepare('UPDATE live SET volume=8000001').run();
  assert.deepEqual(
    recordPeriodGainNotifications(db, cfg).map((row) => row.days),
    [20],
  );
  db.prepare('UPDATE live SET price=1.18').run();
  await deliverOutbox(cfg);
  assert.equal(sent.length, 1);
  db.prepare('UPDATE live SET price=1.2').run();
  assert.deepEqual(
    recordPeriodGainNotifications(db, cfg).map((row) => row.days),
    [20],
  );
  await deliverOutbox(cfg);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /近20个/);
});
