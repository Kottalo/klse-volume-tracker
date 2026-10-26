import { marketDate, sessionStart } from './volume.js';
import { chartModel } from './stock-chart.js';

export function recordGainNotifications(db, cfg, pool) {
  const now = Date.now() / 1000,
    date = marketDate(now);
  if (sessionStart(now, cfg.market_holidays) == null || !Array.isArray(pool)) return [];
  const matches = [];
  db.exec('SAVEPOINT gain_notification');
  try {
    for (const stock of pool) {
      if (![stock.price, stock.ref].every((v) => Number.isFinite(v) && v > 0)) continue;
      const gain = (stock.price / stock.ref - 1) * 100;
      if (
        gain < 5 - 1e-9 ||
        gain > 10 + 1e-9 ||
        db.prepare('SELECT 1 FROM gain_alerts WHERE stock=? AND date=?').get(stock.code, date)
      )
        continue;
      const live = db.prepare('SELECT * FROM live WHERE stock=?').get(stock.code);
      // The source has no quote timestamp. Cross-check today's fresh quote before sending.
      if (
        !live ||
        live.session_date !== date ||
        live.mtime > now ||
        now - live.mtime > 180 ||
        !Number.isFinite(live.mtime) ||
        Math.abs(live.price - stock.price) > 1e-8 ||
        !(live.prevClose > 0) ||
        Math.abs(live.prevClose - stock.ref) > 1e-8
      )
        continue;
      const history = db
        .prepare(
          'SELECT date,open,high,low,close,volume FROM daily_vol WHERE stock=? AND date<? ORDER BY date',
        )
        .all(stock.code, date);
      const chart = chartModel(
        {
          code: stock.code,
          quote_date: date,
          fetched_at: now,
          price: stock.price,
          volume: live.volume,
          history,
        },
        live,
      );
      chart.kind = 'gain';
      chart.gain = gain;
      if (chart.rows.length < 2 || chart.rows.at(-1).date !== date) continue;
      const text = `📈 当日涨幅 5%–10% · ${date}\n\n${live.name || stock.code} (${stock.code})\n现价 RM ${stock.price} · 参考昨收 RM ${stock.ref}\n涨幅 +${gain.toFixed(2)}%\n来源：Pick A Stock Gain% Top 30\nhttps://www.pickastock.info/top10#30\n盘中K线尚未收盘；涨幅筛选不代表买入建议。`;
      const webOnly =
        cfg.gain_alerts_telegram === false || !(cfg.telegram_bot_token && cfg.telegram_chat_id);
      const id = Number(
        db
          .prepare(
            "INSERT INTO notification_outbox(ts,text,kind,charts,cancelled_at,last_error) VALUES(?,?,'gain',?,?,?)",
          )
          .run(now, text, JSON.stringify([chart]), webOnly ? now : null, webOnly ? '仅网页' : null)
          .lastInsertRowid,
      );
      db.prepare(
        'INSERT INTO gain_alerts(stock,date,price,reference,gain,ts,outbox_id) VALUES(?,?,?,?,?,?,?)',
      ).run(stock.code, date, stock.price, stock.ref, gain, now, id);
      matches.push({ ...stock, gain });
    }
    db.exec('RELEASE gain_notification');
  } catch (error) {
    db.exec('ROLLBACK TO gain_notification');
    db.exec('RELEASE gain_notification');
    throw error;
  }
  return matches;
}

export function gainNotificationState(db, cfg) {
  return {
    telegram_enabled: cfg.gain_alerts_telegram !== false,
    alerts: db
      .prepare(
        `SELECT a.*,o.sent_at,o.cancelled_at,o.last_error,
      '/api/gain-alerts/' || o.id || '/chart.png' image FROM gain_alerts a
      JOIN notification_outbox o ON o.id=a.outbox_id ORDER BY a.ts DESC LIMIT 200`,
      )
      .all(),
  };
}
