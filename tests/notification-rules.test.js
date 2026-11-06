import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationSignal, frozenNotificationSignal } from '../lib/notification-rules.js';
import { previousTradingDate } from '../lib/volume.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chartModel } from '../lib/stock-chart.js';

const cfg = { market_holidays: [] };
const dates = [];
for (let date = '2026-10-26'; dates.length < 21;) {
  date = previousTradingDate(date);
  dates.push(date);
}
const history = dates.map((date) => ({ date, close: 1 }));
const live = { price: 1.1, prevClose: 1, volume: 9000001, session_date: '2026-10-26' };

test('each notification uses its own 7–15% window and the current price plus four completed closes for MA5', () => {
  for (const kind of ['potential', 'volume', 'gain', 'gain_5d', 'gain_20d']) {
    const signal = notificationSignal(live, history, kind, cfg);
    assert.equal(signal.pass, true, kind);
    assert.ok(Math.abs(signal.gain - 10) < 1e-9);
    assert.ok(Math.abs(signal.ma5 - 1.02) < 1e-12);
    for (const [price, pass] of [
      [1.07, true],
      [1.15, true],
      [1.06999, false],
      [1.15001, false],
    ])
      assert.equal(
        notificationSignal({ ...live, price }, history, kind, cfg).pass,
        pass,
        `${kind}:${price}`,
      );
  }
  const distinct = history.map((row, i) => ({
    ...row,
    close: i === 4 ? 1.1 / 1.08 : i === 19 ? 1.1 / 1.14 : 1,
  }));
  assert.ok(Math.abs(notificationSignal(live, distinct, 'gain_5d', cfg).gain - 8) < 1e-9);
  assert.ok(Math.abs(notificationSignal(live, distinct, 'gain_20d', cfg).gain - 14) < 1e-9);
});

test('5-day and 20-day current-day volumes must be strictly greater than 3m and 8m shares', () => {
  for (const [kind, limit] of [
    ['gain_5d', 3000000],
    ['gain_20d', 8000000],
  ])
    for (const [volume, pass] of [
      [limit - 1, false],
      [limit, false],
      [limit + 1, true],
      [null, false],
      [Infinity, false],
    ])
      assert.equal(
        notificationSignal({ ...live, volume }, history, kind, cfg).pass,
        pass,
        `${kind}:${volume}`,
      );
});

test('all stock notices require both the current and frozen price to be below RM 3', () => {
  const priceHistory = history.map((row) => ({ ...row, close: 2.7 }));
  for (const kind of ['potential', 'volume', 'gain', 'gain_5d', 'gain_20d']) {
    for (const [price, pass] of [
      [2.99, true],
      [3, false],
      [3.01, false],
    ]) {
      const quote = { ...live, price, prevClose: 2.7 };
      const chart = {
        price,
        previous_close: quote.prevClose,
        volume: quote.volume,
        date: quote.session_date,
        close_history: priceHistory,
      };
      assert.equal(notificationSignal(quote, priceHistory, kind, cfg).pass, pass, kind);
      assert.equal(frozenNotificationSignal(chart, kind, cfg).pass, pass, kind);
    }
  }
});

test('all types reject a currently falling/flat price, missing MA history, and equality/below MA5', () => {
  for (const kind of ['potential', 'volume', 'gain', 'gain_5d', 'gain_20d']) {
    for (const prevClose of [live.price, live.price + 0.01, null, 0])
      assert.equal(
        notificationSignal({ ...live, prevClose }, history, kind, cfg).pass,
        false,
        kind,
      );
    assert.equal(
      notificationSignal(
        live,
        history.filter((row) => row.date !== dates[2]),
        kind,
        cfg,
      ).pass,
      false,
    );
  }
  assert.equal(
    notificationSignal(
      live,
      history.map((row) => ({ ...row, close: 1.1 })),
      'gain',
      cfg,
    ).pass,
    false,
  );
  assert.equal(
    notificationSignal(
      live,
      history.map((row) => ({ ...row, close: 1.2 })),
      'gain',
      cfg,
    ).pass,
    false,
  );
  assert.equal(
    notificationSignal(live, [...history, { date: '2026-10-27', close: 999 }], 'gain', cfg).pass,
    true,
  );
});

test('frozen charts must independently prove their original range, MA5 and volume qualification', () => {
  const chart = {
    code: 'TEST',
    date: live.session_date,
    price: live.price,
    previous_close: live.prevClose,
    volume: live.volume,
    close_history: history,
  };
  for (const kind of ['potential', 'volume', 'gain', 'gain_5d', 'gain_20d'])
    assert.equal(frozenNotificationSignal(chart, kind, cfg).pass, true);
  assert.equal(
    frozenNotificationSignal({ ...chart, previous_close: null }, 'gain', cfg).pass,
    false,
  );
  assert.equal(
    frozenNotificationSignal({ ...chart, volume: 8000000 }, 'gain_20d', cfg).pass,
    false,
  );
});

test('the shared sender enforces current and frozen conditions for every stock notification kind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-notification-policy-'));
  process.env.DATA_DIR = root;
  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LLM_API_KEY'])
    delete process.env[key];
  const { db, DEFAULTS, deliverOutbox, recordVolumeAlerts } = await import('../server.js');
  const realNow = Date.now,
    realFetch = globalThis.fetch;
  const fixed = Date.parse('2026-10-26T10:30:00+08:00');
  Date.now = () => fixed;
  const telegram = { ...DEFAULTS, telegram_bot_token: 'FAKE', telegram_chat_id: '123' };
  try {
    db.prepare("INSERT INTO universe(stock,name,active) VALUES('UP','UP',1)").run();
    db.prepare(
      "INSERT INTO live(stock,name,price,prevClose,open,high,low,volume,mtime,session_date) VALUES('UP','UP',1.1,1,1,1.12,.99,9000001,?,'2026-10-26')",
    ).run(fixed / 1000);
    for (const day of dates)
      db.prepare(
        "INSERT INTO daily_vol(stock,date,close,open,high,low,volume) VALUES('UP',?,1,1,1.01,.99,100000)",
      ).run(day);
    db.prepare("INSERT INTO kv(k,v) VALUES('market_scan_coverage',?)").run(
      JSON.stringify({ at: fixed / 1000, expected: 1, received: 1 }),
    );
    const snapshot = chartModel(
      {
        code: 'UP',
        quote_date: '2026-10-26',
        price: 1.1,
        volume: 9000001,
        history: history
          .map((row) => ({ ...row, open: 1, high: 1.01, low: 0.99, volume: 100000 }))
          .reverse(),
      },
      { prevClose: 1, open: 1, high: 1.12, low: 0.99 },
    );
    function queue() {
      db.prepare('DELETE FROM volume_alerts').run();
      db.prepare('DELETE FROM notification_outbox').run();
      assert.equal(recordVolumeAlerts(telegram).length, 1);
      for (const kind of [null, 'gain', 'gain_5d', 'gain_20d'])
        db.prepare('INSERT INTO notification_outbox(ts,text,kind,charts) VALUES(?,?,?,?)').run(
          fixed / 1000,
          `queue-${kind || 'potential'}`,
          kind,
          JSON.stringify([snapshot]),
        );
    }
    const sent = [];
    globalThis.fetch = async (_url, options) => {
      sent.push(options.body.get('caption'));
      return Response.json({ ok: true });
    };
    queue();
    await deliverOutbox(telegram);
    assert.equal(sent.length, 5);
    queue();
    db.prepare('UPDATE live SET price=.99').run();
    sent.length = 0;
    await deliverOutbox(telegram);
    assert.equal(sent.length, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE cancelled_at IS NOT NULL').get()
        .n,
      5,
    );
    db.prepare('UPDATE live SET price=1.1').run();
    queue();
    for (const day of dates.slice(0, 4))
      db.prepare('UPDATE daily_vol SET close=1.2 WHERE date=?').run(day);
    await deliverOutbox(telegram);
    assert.equal(sent.length, 0);
    for (const day of dates.slice(0, 4))
      db.prepare('UPDATE daily_vol SET close=1 WHERE date=?').run(day);
    queue();
    db.prepare("UPDATE notification_outbox SET charts=? WHERE kind='gain_20d'").run(
      JSON.stringify([{ ...snapshot, volume: 8000000 }]),
    );
    await deliverOutbox(telegram);
    assert.equal(sent.length, 4);
    assert.ok(!sent.includes('queue-gain_20d'));
    queue();
    db.prepare('UPDATE live SET price=3, prevClose=2.7').run();
    db.prepare('UPDATE daily_vol SET close=2.7').run();
    sent.length = 0;
    await deliverOutbox(telegram);
    assert.equal(sent.length, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM notification_outbox WHERE cancelled_at IS NOT NULL').get()
        .n,
      5,
    );
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
