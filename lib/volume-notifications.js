import {
  marketDate,
  previousTradingDate,
  sessionStart,
  volumeSignal,
  formatVolumeAlert,
  MINIMUM_VOLUME,
  VOLUME_MULTIPLE,
} from './volume.js';
import { volumeChartModel } from './stock-chart.js';

function savedVolumeChart(db, stock) {
  const quote = db.prepare('SELECT * FROM live WHERE stock=?').get(stock.code);
  const live =
    quote?.session_date === stock.date && quote.mtime <= (stock.ts ?? stock.fetched_at)
      ? quote
      : {};
  const history = db
    .prepare(
      'SELECT date,open,high,low,close,volume FROM daily_vol WHERE stock=? AND date<? ORDER BY date',
    )
    .all(stock.code, stock.date);
  return volumeChartModel(stock, history, live);
}

export function volumeStocks(db, cfg) {
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
export function recordVolumeNotifications(db, cfg) {
  const now = Date.now() / 1000,
    date = marketDate(now);
  if (sessionStart(now, cfg.market_holidays) == null) return [];
  const scan = JSON.parse(
    db.prepare("SELECT v FROM kv WHERE k='market_scan_coverage'").get()?.v || 'null',
  );
  if (!scan || scan.at > now || now - scan.at > 180 || scan.expected !== scan.received) return [];
  const matches = volumeStocks(db, cfg).filter(
    (s) =>
      s.qualified &&
      s.fresh &&
      !db
        .prepare('SELECT 1 FROM volume_alerts WHERE stock=? AND date=? AND volume>=?')
        .get(s.code, date, MINIMUM_VOLUME),
  );
  if (!matches.length) return [];
  db.exec('SAVEPOINT volume_notification');
  try {
    for (const s of matches) {
      const webOnly =
        cfg.volume_alerts_telegram === false || !(cfg.telegram_bot_token && cfg.telegram_chat_id);
      const id = Number(
        db
          .prepare(
            "INSERT INTO notification_outbox(ts,text,kind,charts,cancelled_at,last_error) VALUES(?,?,'volume',?,?,?)",
          )
          .run(
            Math.floor(now),
            `📊 三倍量＋100万股 · ${date}\n\n${formatVolumeAlert(s)}`,
            JSON.stringify([savedVolumeChart(db, s)]),
            webOnly ? Math.floor(now) : null,
            webOnly ? '仅网页' : null,
          ).lastInsertRowid,
      );
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
    db.exec('RELEASE volume_notification');
  } catch (e) {
    db.exec('ROLLBACK TO volume_notification');
    db.exec('RELEASE volume_notification');
    throw e;
  }
  return matches;
}

export function prepareVolumeNotice(db, item) {
  const records = db
    .prepare('SELECT *,stock AS code FROM volume_alerts WHERE outbox_id=?')
    .all(item.id);
  const eligible = records.filter(
    (stock) => volumeSignal(stock.volume, stock.previous_volume).pass,
  );
  if (!eligible.length) return false;
  if (item.charts && eligible.length === records.length && eligible.length === 1) return true;
  const frozen = item.charts ? JSON.parse(item.charts) : [];
  // Split pending batches without dropping matches or changing their frozen signal data.
  db.exec('SAVEPOINT volume_image_upgrade');
  try {
    for (let offset = 0; offset < eligible.length; offset++) {
      const stock = eligible[offset];
      const text = `📊 三倍量＋100万股 · ${stock.date}\n\n${formatVolumeAlert(stock)}`;
      const charts = JSON.stringify([
        frozen.find((chart) => chart.code === stock.code) || savedVolumeChart(db, stock),
      ]);
      if (offset === 0) {
        item.text = text;
        item.charts = charts;
        db.prepare('UPDATE notification_outbox SET text=?,charts=? WHERE id=?').run(
          text,
          charts,
          item.id,
        );
      } else {
        const id = Number(
          db
            .prepare("INSERT INTO notification_outbox(ts,text,kind,charts) VALUES(?,?,'volume',?)")
            .run(item.ts, text, charts).lastInsertRowid,
        );
        db.prepare(
          'UPDATE volume_alerts SET outbox_id=? WHERE stock=? AND date=? AND outbox_id=?',
        ).run(id, stock.code, stock.date, item.id);
      }
    }
    db.exec('RELEASE volume_image_upgrade');
  } catch (error) {
    db.exec('ROLLBACK TO volume_image_upgrade');
    db.exec('RELEASE volume_image_upgrade');
    throw error;
  }
  return true;
}

export function volumeNotificationState(db, cfg) {
  const stocks = volumeStocks(db, cfg);
  const alerts = db
    .prepare(
      `SELECT a.*,o.sent_at,o.cancelled_at,o.last_error,CASE WHEN o.charts IS NOT NULL THEN '/api/volume-alerts/' || o.id || '/chart.png' ELSE NULL END image FROM volume_alerts a LEFT JOIN notification_outbox o ON o.id=a.outbox_id ORDER BY a.ts DESC,a.multiple DESC LIMIT 200`,
    )
    .all();
  return {
    minimum_multiple: VOLUME_MULTIPLE,
    minimum_volume: MINIMUM_VOLUME,
    stocks,
    alerts,
    telegram_enabled: cfg.volume_alerts_telegram !== false,
    coverage: { total: stocks.length, comparable: stocks.filter((s) => s.multiple != null).length },
  };
}
