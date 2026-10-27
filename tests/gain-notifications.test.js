import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordGainNotifications, gainNotificationState } from '../lib/gain-notifications.js';

test('Pick A Stock daily gain notifications: boundaries, fresh OHLC, dedup and independent image delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-gain-'));
  process.env.DATA_DIR = root;
  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LLM_API_KEY'])
    delete process.env[key];
  const { app, db, DEFAULTS, deliverOutbox } = await import('../server.js');
  const realNow = Date.now,
    realFetch = globalThis.fetch;
  Date.now = () => Date.parse('2026-10-05T10:30:00+08:00');
  const cfg = {
    ...DEFAULTS,
    telegram_bot_token: 'FAKE',
    telegram_chat_id: '123',
    potential_alerts_telegram: false,
    volume_alerts_telegram: false,
  };
  const pool = [];
  function stock(code, price, extra = {}) {
    pool.push({ code, price, ref: 1 });
    db.prepare(
      'INSERT INTO live(stock,name,price,prevClose,open,high,low,volume,mtime,session_date) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(code, code, price, 1, 1, price + 0.01, 0.99, 100, Date.now() / 1000, '2026-10-05');
    if (!extra.noHistory)
      db.prepare(
        'INSERT INTO daily_vol(stock,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)',
      ).run(code, '2026-10-02', 1, 1.01, 0.99, 1, 100);
  }
  try {
    stock('FIVE', 1.05);
    stock('TEN', 1.1);
    stock('LOW', 1.0499);
    stock('HIGH', 1.1001);
    stock('MISSING', 1.07, { noHistory: true });
    stock('STALE', 1.07);
    stock('MISMATCH', 1.07);
    db.prepare("UPDATE live SET mtime=mtime-181 WHERE stock='STALE'").run();
    db.prepare("UPDATE live SET price=1.08 WHERE stock='MISMATCH'").run();
    assert.equal(recordGainNotifications(db, cfg, null).length, 0);
    assert.deepEqual(
      recordGainNotifications(db, cfg, pool).map((s) => s.code),
      ['FIVE', 'TEN'],
    );
    assert.equal(recordGainNotifications(db, cfg, pool).length, 0);
    const rows = db.prepare("SELECT * FROM notification_outbox WHERE kind='gain'").all();
    assert.equal(rows.length, 2);
    assert.equal(JSON.parse(rows[0].charts)[0].rows.length, 2);
    assert.match(rows[0].text, /参考昨收/);
    assert.match(rows[0].text, /股票代号：FIVE/);
    const http = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => http.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${http.address().port}`;
      const image = await realFetch(base + `/api/gain-alerts/${rows[0].id}/chart.png`);
      assert.equal(image.status, 200);
      const bytes = Buffer.from(await image.arrayBuffer());
      assert.equal(bytes.readUInt32BE(20), 620);
      assert.equal(
        (await realFetch(base + `/api/potential-alerts/${rows[0].id}/chart.png`)).status,
        404,
      );
      const state = await (await realFetch(base + '/api/state')).json();
      assert.equal(state.gain_notifications.alerts.length, 2);
    } finally {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
    let attempts = 0;
    globalThis.fetch = async (url, options) => {
      assert.match(url, /sendPhoto$/);
      assert.ok(options.body.get('photo').size > 1000);
      attempts++;
      return { ok: true, json: async () => ({ ok: attempts > 1 }) };
    };
    await deliverOutbox(cfg);
    assert.equal(gainNotificationState(db, cfg).alerts.filter((s) => s.sent_at).length, 1);
    await deliverOutbox(cfg);
    assert.equal(gainNotificationState(db, cfg).alerts.filter((s) => s.sent_at).length, 2);
    assert.equal(attempts, 3);
    stock('WEB', 1.06);
    assert.equal(
      recordGainNotifications(db, { ...cfg, gain_alerts_telegram: false }, pool).length,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT last_error FROM notification_outbox WHERE id=(SELECT outbox_id FROM gain_alerts WHERE stock='WEB')",
        )
        .get().last_error,
      '仅网页',
    );
    Date.now = () => Date.parse('2026-10-06T10:30:00+08:00');
    db.prepare("UPDATE live SET session_date='2026-10-06',mtime=?").run(Date.now() / 1000);
    assert.ok(recordGainNotifications(db, cfg, pool).some((s) => s.code === 'FIVE'));
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
