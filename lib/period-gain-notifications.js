import { marketDate, sessionStart, previousTradingDate } from './volume.js';
import { chartModel } from './stock-chart.js';

export const PERIOD_GAIN_RULES = [
  { days: 5, min: 7, max: 15, kind: 'gain_5d', setting: 'gain_5d_alerts_telegram' },
  { days: 20, min: 15, max: 25, kind: 'gain_20d', setting: 'gain_20d_alerts_telegram' },
];

export function recordPeriodGainNotifications(db, cfg) {
  const now = Date.now() / 1000,
    date = marketDate(now);
  if (sessionStart(now, cfg.market_holidays) == null) return [];
  const scan = JSON.parse(
    db.prepare("SELECT v FROM kv WHERE k='market_scan_coverage'").get()?.v || 'null',
  );
  if (
    !scan ||
    !Number.isFinite(scan.at) ||
    scan.at > now ||
    now - scan.at > 180 ||
    !(scan.expected > 0) ||
    scan.expected !== scan.received
  )
    return [];
  const dates = [];
  for (let cursor = date; dates.length < 20;) {
    cursor = previousTradingDate(cursor, cfg.market_holidays);
    dates.push(cursor);
  }
  const stocks = db
    .prepare(
      `SELECT l.* FROM live l JOIN universe u ON u.stock=l.stock
    WHERE u.active=1 AND l.session_date=? AND l.mtime>=? AND l.mtime<=? AND l.price>0`,
    )
    .all(date, now - 180, now);
  const matches = [];
  db.exec('SAVEPOINT period_gain_notification');
  try {
    for (const live of stocks) {
      const history = db
        .prepare(
          'SELECT date,open,high,low,close,volume FROM daily_vol WHERE stock=? AND date<? ORDER BY date',
        )
        .all(live.stock, date);
      const closes = new Map(history.map((row) => [row.date, row.close]));
      for (const rule of PERIOD_GAIN_RULES) {
        // Missing trading dates must not silently extend a 5/20-day window.
        if (
          dates
            .slice(0, rule.days)
            .some((day) => !Number.isFinite(closes.get(day)) || closes.get(day) <= 0)
        )
          continue;
        const referenceDate = dates[rule.days - 1],
          reference = closes.get(referenceDate);
        const gain = (live.price / reference - 1) * 100;
        if (
          gain < rule.min - 1e-9 ||
          gain > rule.max + 1e-9 ||
          db
            .prepare('SELECT 1 FROM period_gain_alerts WHERE stock=? AND date=? AND days=?')
            .get(live.stock, date, rule.days)
        )
          continue;
        const chart = chartModel(
          {
            code: live.stock,
            quote_date: date,
            fetched_at: live.mtime,
            price: live.price,
            volume: live.volume,
            history,
          },
          live,
        );
        if (
          chart.rows.at(-1)?.date !== date ||
          dates.slice(0, rule.days).some((day) => !chart.rows.some((row) => row.date === day))
        )
          continue;
        Object.assign(chart, {
          kind: 'gain',
          gain,
          gain_days: rule.days,
          reference,
          reference_date: referenceDate,
        });
        const text = `📈 近${rule.days}个交易日涨幅 ${rule.min}%–${rule.max}% · ${date}\n\n股票代号：${live.stock}\n现价 RM ${live.price} · 涨幅 +${gain.toFixed(2)}%\n基准：${referenceDate} 收盘 RM ${reference}\n现价 / 基准收盘价 − 1；含区间边界。\n来源：TradingView 市场快照 / Yahoo Finance 日线\n盘中K线尚未收盘；涨幅筛选不代表买入建议。`;
        const webOnly =
          cfg[rule.setting] === false || !(cfg.telegram_bot_token && cfg.telegram_chat_id);
        const id = Number(
          db
            .prepare(
              'INSERT INTO notification_outbox(ts,text,kind,charts,cancelled_at,last_error) VALUES(?,?,?,?,?,?)',
            )
            .run(
              now,
              text,
              rule.kind,
              JSON.stringify([chart]),
              webOnly ? now : null,
              webOnly ? '仅网页' : null,
            ).lastInsertRowid,
        );
        db.prepare(
          'INSERT INTO period_gain_alerts(stock,date,days,price,reference,reference_date,gain,ts,outbox_id) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(live.stock, date, rule.days, live.price, reference, referenceDate, gain, now, id);
        matches.push({ code: live.stock, days: rule.days, gain });
      }
    }
    db.exec('RELEASE period_gain_notification');
  } catch (error) {
    db.exec('ROLLBACK TO period_gain_notification');
    db.exec('RELEASE period_gain_notification');
    throw error;
  }
  return matches;
}

export function periodGainNotificationState(db, cfg) {
  return {
    rules: PERIOD_GAIN_RULES.map((rule) => ({
      ...rule,
      telegram_enabled: cfg[rule.setting] !== false,
    })),
    alerts: db
      .prepare(
        `SELECT a.*,o.sent_at,o.cancelled_at,o.last_error,
      '/api/period-gain-alerts/' || o.id || '/chart.png' image FROM period_gain_alerts a
      JOIN notification_outbox o ON o.id=a.outbox_id ORDER BY a.ts DESC,a.days,a.stock LIMIT 200`,
      )
      .all(),
  };
}
