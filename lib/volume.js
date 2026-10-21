export const VOLUME_MULTIPLE = 3;

export function marketDate(ts = Date.now() / 1000) {
  return new Date(ts * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function sessionStart(ts, holidays = []) {
  const local = new Date((ts + 8 * 3600) * 1000);
  if ([0, 6].includes(local.getUTCDay()) || holidays.includes(marketDate(ts))) return null;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = minute >= 540 && minute < 750 ? 540 : minute >= 870 && minute < 1020 ? 870 : null;
  return start == null ? null : Date.parse(`${marketDate(ts)}T00:00:00+08:00`) / 1000 + start * 60;
}

export function previousTradingDate(date, holidays = []) {
  const day = new Date(date + 'T00:00:00Z');
  do {
    day.setUTCDate(day.getUTCDate() - 1);
  } while ([0, 6].includes(day.getUTCDay()) || holidays.includes(day.toISOString().slice(0, 10)));
  return day.toISOString().slice(0, 10);
}

export function volumeSignal(current, previous) {
  const multiple =
    Number.isFinite(current) && current >= 0 && Number.isFinite(previous) && previous > 0
      ? current / previous
      : null;
  return { multiple, pass: multiple != null && multiple >= VOLUME_MULTIPLE };
}

export function formatMultiple(value) {
  return value < 3 && value >= 2.995 ? '<3.00' : value.toFixed(2);
}

export function formatVolumeAlert(stock) {
  const shares = (value) => Math.round(value).toLocaleString('zh-CN');
  return `${stock.code}${stock.numeric_code ? ` (${stock.numeric_code})` : ''} · 昨日 ${formatMultiple(stock.multiple)} 倍\n今日 ${shares(stock.volume)} 股｜昨日 ${shares(stock.previous_volume)} 股`;
}
