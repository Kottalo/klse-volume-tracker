import { marketDate, previousTradingDate } from './volume.js';

export const NOTIFICATION_MIN_GAIN = 7;
export const NOTIFICATION_MAX_GAIN = 15;
export const NOTIFICATION_PRICE_LIMIT = 3;
export const NOTIFICATION_RULE_REJECTED = '未满足7%–15%涨幅、MA5及对应成交量条件';

export function notificationSignal(live, history, kind, cfg) {
  const days = kind === 'gain_5d' ? 5 : kind === 'gain_20d' ? 20 : 1;
  const minimumVolume = days === 5 ? 3000000 : days === 20 ? 8000000 : 0;
  const dates = [];
  for (let day = live?.session_date; day && dates.length < Math.max(days, 4);) {
    day = previousTradingDate(day, cfg.market_holidays);
    dates.push(day);
  }
  const closes = new Map(history.map((row) => [row.date, row.close]));
  const ready =
    dates.length >= Math.max(days, 4) &&
    dates.every((day) => Number.isFinite(closes.get(day)) && closes.get(day) > 0);
  const reference = days === 1 ? live?.prevClose : closes.get(dates[days - 1]);
  const price = live?.price;
  const gain =
    Number.isFinite(price) && Number.isFinite(reference) && reference > 0
      ? (price / reference - 1) * 100
      : null;
  const ma5 =
    ready && Number.isFinite(price)
      ? (price + dates.slice(0, 4).reduce((sum, day) => sum + closes.get(day), 0)) / 5
      : null;
  return {
    days,
    gain,
    ma5,
    reference,
    reference_date: days === 1 ? dates[0] : dates[days - 1],
    minimum_gain: NOTIFICATION_MIN_GAIN,
    maximum_gain: NOTIFICATION_MAX_GAIN,
    minimum_volume_exclusive: minimumVolume,
    pass:
      ready &&
      price < NOTIFICATION_PRICE_LIMIT &&
      Number.isFinite(live?.prevClose) &&
      live.prevClose > 0 &&
      price > live.prevClose &&
      gain >= NOTIFICATION_MIN_GAIN - 1e-9 &&
      gain <= NOTIFICATION_MAX_GAIN + 1e-9 &&
      price > ma5 + Math.max(1e-12, Math.abs(ma5) * 1e-12) &&
      (!minimumVolume || (Number.isFinite(live.volume) && live.volume > minimumVolume)),
  };
}

export function readNotificationSignal(db, code, kind, cfg) {
  const live = db.prepare('SELECT * FROM live WHERE stock=?').get(code);
  const history = live
    ? db
        .prepare(
          'SELECT date,close FROM daily_vol WHERE stock=? AND date<? ORDER BY date DESC LIMIT 40',
        )
        .all(code, live.session_date)
    : [];
  const signal = notificationSignal(live, history, kind, cfg);
  const now = Date.now() / 1000;
  return {
    ...signal,
    pass:
      signal.pass &&
      live.session_date === marketDate(now) &&
      Number.isFinite(live.mtime) &&
      live.mtime <= now &&
      now - live.mtime <= 900,
  };
}

export function frozenNotificationSignal(chart, kind, cfg) {
  return notificationSignal(
    {
      price: chart.price,
      prevClose: chart.previous_close,
      volume: chart.volume,
      session_date: chart.date,
    },
    chart.close_history || chart.rows || [],
    kind,
    cfg,
  );
}
