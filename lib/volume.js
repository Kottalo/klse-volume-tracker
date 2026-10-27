export const VOLUME_MULTIPLE = 3;
export const MINIMUM_VOLUME = 1000000;

export { marketDate, sessionStart } from './analysis.js';

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
  return {
    multiple,
    pass: multiple != null && multiple >= VOLUME_MULTIPLE && current >= MINIMUM_VOLUME,
  };
}

export function formatMultiple(value) {
  return value < 3 && value >= 2.995 ? '<3.00' : value.toFixed(2);
}

export function formatVolumeAlert(stock) {
  const shares = (value) => Math.round(value).toLocaleString('zh-CN');
  return `股票代号：${stock.code}${stock.numeric_code ? ` (${stock.numeric_code})` : ''} · 昨日 ${formatMultiple(stock.multiple)} 倍\n今日 ${shares(stock.volume)} 股｜昨日 ${shares(stock.previous_volume)} 股`;
}
