// Offline UI acceptance fixture. Never reads .env or production data, never sends notifications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { marketDate } from '../lib/analysis.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klse-preview-'));
process.env.DATA_DIR = root;
process.env.ADMIN_TOKEN = 'preview-only-token';
for (const key of [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'LLM_API_KEY',
  'TWILIO_SID',
  'TWILIO_AUTH_TOKEN',
])
  delete process.env[key];
globalThis.fetch = async () => {
  throw new Error('External network disabled in preview fixture');
};
const reviewDate = marketDate();
const fixed = Date.parse(reviewDate + 'T10:30:00+08:00');
Date.now = () => fixed;
const { app, db, DEFAULTS, saveConfig } = await import('../server.js');
saveConfig({ ...DEFAULTS, watchlist: [] });
const dates = [],
  cursor = new Date(marketDate());
cursor.setUTCDate(cursor.getUTCDate() - 1);
while (dates.length < 64) {
  if (![0, 6].includes(cursor.getUTCDay())) dates.unshift(cursor.toISOString().slice(0, 10));
  cursor.setUTCDate(cursor.getUTCDate() - 1);
}
const samples = [
  ['EXAMPLE1', '示例 · Meridian 科技', 1, 11.8],
  ['EXAMPLE2', '示例 · Harbor 工业', 0.7, 8.25],
  ['EXAMPLE3', '示例 · Cedar 消费', 1.3, 15.4],
  ['EXAMPLE4', '示例 · Atlas 能源', 0.5, 5.6],
  ['EXAMPLE5', '示例 · River 物流', 0.9, 11.2],
  ['EXAMPLE6', '示例 · Grove 医疗', 1.1, 13.1],
];
const insert = db.prepare(
  'INSERT INTO daily_vol(stock,date,volume,open,high,low,close) VALUES(?,?,?,?,?,?,?)',
);
for (const [code, name, scale, current] of samples) {
  const previousPrice = current / (code === 'EXAMPLE3' ? 1.02 : code === 'EXAMPLE4' ? 1.2 : 1.006);
  db.prepare('INSERT INTO universe(stock,name,code) VALUES(?,?,?)').run(
    code,
    name,
    String(1000 + samples.findIndex((s) => s[0] === code)),
  );
  db.prepare(
    'INSERT INTO live(stock,name,price,prevClose,open,volume,mtime,session_date) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    code,
    name,
    current,
    previousPrice,
    current * 0.98,
    code === 'EXAMPLE5' ? 500000 : code === 'EXAMPLE6' ? 1500000 * scale : 6400000 * scale,
    Date.now() / 1000,
    marketDate(),
  );
  for (let i = 0; i < dates.length; i++) {
    const base =
      i <= 20
        ? 11.6 - i * 0.08
        : i <= 35
          ? 10 + (i - 20) * 0.1
          : i <= 55
            ? 11.5 - (i - 35) * 0.0725
            : i <= 60
              ? 10.05 + (i - 55) * 0.27
              : 11.9 + (i - 61) * 0.04;
    const close = i >= 50 ? previousPrice : base * scale;
    insert.run(
      code,
      dates[i],
      (i === 56 ? 2800000 : 1000000) * scale,
      close * 0.99,
      close * 1.015,
      close * 0.985,
      close,
    );
  }
}
db.prepare('INSERT INTO alerts(ts,stock,name,kind,message) VALUES(?,?,?,?,?)').run(
  Math.floor(Date.now() / 1000),
  'EXAMPLE1',
  '示例 · Meridian 科技',
  'pattern',
  '日线越过前期压力位，继续观察能否守住。此记录仅用于界面验收。',
);
db.prepare("INSERT INTO kv(k,v) VALUES('last_successful_poll',?)").run(String(fixed / 1000));
const port = Number(process.env.PREVIEW_PORT || 8091);
// An explicitly labelled historical replay for the BUSCAP acceptance case.
const buscap = JSON.parse(
  fs.readFileSync(new URL('../tests/fixtures/buscap-2026.json', import.meta.url), 'utf8'),
);
if (reviewDate === buscap.snapshot.date) {
  db.prepare('INSERT INTO universe(stock,name,code) VALUES(?,?,?)').run(
    'BUSCAP',
    '示例 · BUSCAP 历史回放',
    '0455',
  );
  db.prepare(
    'INSERT INTO live(stock,name,price,prevClose,volume,mtime,session_date) VALUES(?,?,?,?,?,?,?)',
  ).run('BUSCAP', '示例 · BUSCAP 历史回放', 0.785, 0.66, 6855800, fixed / 1000, reviewDate);
  for (const b of buscap.bars)
    insert.run('BUSCAP', b.date, b.volume, b.open, b.high, b.low, b.close);
}
const httpServer = app.listen(port, '127.0.0.1', () =>
  console.log('Offline fixture: http://localhost:' + port + ' — all stock data is synthetic.'),
);
function cleanup() {
  httpServer.closeAllConnections();
  httpServer.close(() => {
    db.close();
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'klse-preview-'))
      fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
