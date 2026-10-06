import { marketDate } from './analysis.js';

export const BRIEFING_SLOTS = ['16:00', '16:30'];
export const BRIEFING_WINDOW_MINUTES = 10;

export function tradingDay(date, holidays = []) {
  return ![0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay()) && !holidays.includes(date);
}

export function nextTradingDate(date, holidays = []) {
  const cursor = new Date(date + 'T00:00:00Z');
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  } while (!tradingDay(cursor.toISOString().slice(0, 10), holidays));
  return cursor.toISOString().slice(0, 10);
}

export function slotTimestamp(date, slot) {
  return Date.parse(date + 'T' + slot + ':00+08:00') / 1000;
}

export function dueBriefingSlots(cfg, completed = [], now = Date.now() / 1000) {
  const date = marketDate(now);
  if (cfg.final_briefing_on === false || !tradingDay(date, cfg.market_holidays || [])) return [];
  return BRIEFING_SLOTS.filter(
    (slot) =>
      !completed.includes(slot) &&
      now >= slotTimestamp(date, slot) &&
      now < slotTimestamp(date, slot) + BRIEFING_WINDOW_MINUTES * 60,
  );
}

// Filter the entire ranked pool, before the homepage's three-stock cap.
export function finalCandidates(ranked, cfg, slot, now = Date.now() / 1000) {
  const date = marketDate(now),
    start = slotTimestamp(date, slot);
  const minimumVolume = Math.max(1000000, cfg.screen_min_volume || 1000000);
  const minimumMultiple = Math.max(3, cfg.screen_vol_mult || 2);
  return ranked
    .filter(
      (r) =>
        r.potential_eligible &&
        !r.snapshot &&
        r.quote_date === date &&
        r.fetched_at >= start &&
        r.fetched_at <= now &&
        now - r.fetched_at <= 180 &&
        r.volume > 1000000 &&
        r.volume >= minimumVolume &&
        r.volume_signal.multiple >= minimumMultiple,
    )
    .slice(0, Math.max(1, Math.min(3, Number(cfg.pick_count) || 3)));
}

const n = (v) => (Number.isFinite(v) ? +v.toFixed(2) : '—');
export function conciseReason(report) {
  return report.stage === 'coiled'
    ? '量先放大，价格仍在整理。'
    : report.stage === 'building'
      ? '量价转强，接近前期高点。'
      : '放量突破，观察能否守住。';
}

export function formatBriefing(record, url) {
  const lines = [
    `📌 尾盘精选 · ${record.date} ${record.slot} MYT`,
    `成交量 >100万股、≥${record.minimum_multiple}倍昨日量；最多3只。`,
  ];
  if (!record.items.length) lines.push('本次没有符合完整条件的股票，不凑数。');
  for (const item of record.items)
    lines.push(
      '',
      `${item.code} · RM ${item.price}`,
      `${n(item.volume / 10000)}万股 · 昨日${n(item.multiple)}倍`,
      item.reason,
      `关注 RM ${item.resistance} · 跌破 RM ${item.support} 失效`,
    );
  const fetched = new Date(record.quote_at * 1000).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  lines.push('', `行情抓取 ${fetched}；盘中量未定稿。次日涨跌另行追踪，不保证上涨。`, url);
  return lines.join('\n');
}
