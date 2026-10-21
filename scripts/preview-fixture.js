// Offline preview: isolated data, no credentials and no network notifications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { marketDate, previousTradingDate } from '../lib/volume.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-preview-'));
process.env.DATA_DIR = root;
process.env.ADMIN_TOKEN = 'preview-only-token';
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) delete process.env[key];
globalThis.fetch = async () => {
  throw new Error('Offline preview');
};
const date = process.env.PREVIEW_DATE || marketDate();
const fixed = Date.parse(`${date}T10:30:00+08:00`);
Date.now = () => fixed;
const { app, db, DEFAULTS, saveConfig, recordVolumeAlerts } = await import('../server.js');
saveConfig({ ...DEFAULTS, potential_alerts_telegram: false });
for (const [code, volume, previous] of [
  ['EXAMPLE1', 30000, 10000],
  ['EXAMPLE2', 50000, 10000],
  ['EXAMPLE3', 29999, 10000],
  ['EXAMPLE4', 10000, null],
]) {
  db.prepare('INSERT INTO universe(stock,name,code) VALUES(?,?,?)').run(
    code,
    '示例 · ' + code,
    code.slice(-1).padStart(4, '0'),
  );
  db.prepare('INSERT INTO live(stock,name,volume,mtime,session_date) VALUES(?,?,?,?,?)').run(
    code,
    '示例 · ' + code,
    volume,
    fixed / 1000,
    date,
  );
  if (previous)
    db.prepare('INSERT INTO daily_vol(stock,date,volume) VALUES(?,?,?)').run(
      code,
      previousTradingDate(date),
      previous,
    );
}
for (const [key, value] of [
  ['last_successful_poll', String(fixed / 1000)],
  [
    'market_scan_coverage',
    JSON.stringify({ at: fixed / 1000, expected: 4, received: 4, valid: 4 }),
  ],
])
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?)').run(key, value);
recordVolumeAlerts();
const http = app.listen(Number(process.env.PREVIEW_PORT || 8091), '127.0.0.1', () =>
  console.log('Offline preview: http://localhost:' + (process.env.PREVIEW_PORT || 8091)),
);
function stop() {
  http.closeAllConnections();
  http.close(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
