import { signalReferences } from './analysis.js';

const escape = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
const price = (v) => Number(v.toFixed(3));
const validBar = (r) =>
  [r.open, r.high, r.low, r.close].every((v) => Number.isFinite(v) && v > 0) &&
  r.high >= Math.max(r.open, r.close) &&
  r.low <= Math.min(r.open, r.close);

export function chartModel(report, live = {}) {
  const date = report.quote_date;
  const rows = (report.history || []).filter((r) => r.date <= date && validBar(r)).slice(-39);
  const current = {
    date,
    open: live.open,
    high: live.high,
    low: live.low,
    close: report.price,
    volume: report.volume,
    provisional: true,
  };
  // Never invent OHLC values from a last price. A quote without OHLC is a dot.
  if (!report.snapshot && date && validBar(current)) {
    const index = rows.findIndex((r) => r.date === date);
    if (index >= 0) rows.splice(index, 1);
    rows.push(current);
  }
  const eligible = report.potential_eligible && !report.snapshot;
  const refs = signalReferences(report);
  const buy = eligible && report.stage === 'confirmed' && report.price > refs?.resistance;
  return {
    code: report.code,
    date,
    fetched_at: report.fetched_at,
    price: report.price,
    rows,
    resistance: refs?.resistance,
    support: refs?.support,
    marker: eligible ? (buy ? '策略买点' : '突破后买点') : null,
    marker_price: eligible ? (buy ? report.price : refs?.resistance) : null,
    confirmed: buy,
    snapshot: report.snapshot,
    volume: report.volume,
    multiple: report.volume_signal?.multiple,
  };
}

export function volumeChartModel(stock, history, live = {}) {
  return {
    ...chartModel(
      {
        code: stock.code,
        quote_date: stock.date,
        price: live.price ?? null,
        fetched_at: stock.ts ?? stock.fetched_at,
        volume: stock.volume,
        volume_signal: { multiple: stock.multiple },
        history: history.filter((row) => row.date < stock.date),
      },
      live,
    ),
    kind: 'volume',
    previous_volume: stock.previous_volume,
    previous_date: stock.previous_date,
  };
}

function volumeComparison(model, x, y, width) {
  const maximum = Math.max(model.volume, model.previous_volume, 1);
  return (
    [
      [model.volume, '成交量', '#52d8ad'],
      [model.previous_volume, `昨日 ${model.previous_date || ''}`, '#a4b6c7'],
    ]
      .map(([value, label, color], index) => {
        const top = y + index * 90;
        return `<text x="${x}" y="${top}" fill="#c9d5df" font-size="16">${escape(label)}</text><rect x="${x}" y="${top + 12}" width="${(width * value) / maximum}" height="18" rx="3" fill="${color}"/><text x="${x}" y="${top + 56}" fill="${color}" font-size="17">${Math.round(value).toLocaleString('en-US')} 股</text>`;
      })
      .join('') +
    `<text x="${x}" y="${y + 220}" fill="#52d8ad" font-size="26">${model.multiple.toFixed(2)}倍</text>`
  );
}

export function chartSvg(model) {
  const { rows, code, resistance, support } = model;
  const w = 1080,
    h = 620,
    left = 72,
    right = 840,
    top = 130,
    bottom = 430;
  const text = (x, y, value, color = '#c9d5df', size = 17, extra = '') =>
    `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" ${extra}>${escape(value)}</text>`;
  const start = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(code)} 蜡烛K线与策略买点"><rect width="${w}" height="${h}" rx="18" fill="#101b25"/><g font-family="Noto Sans SC, sans-serif">`;
  const title =
    text(
      28,
      38,
      `${code} · ${model.kind === 'volume' ? '成交量 / 日K线' : model.kind === 'gain' ? `涨幅 +${model.gain.toFixed(2)}% / 日K线` : '日K线'}`,
      '#f1f6fa',
      27,
    ) +
    text(
      28,
      68,
      `${model.date || ''} · RM ${Number.isFinite(model.price) ? price(model.price) : '—'} · ${model.snapshot ? '历史收盘' : '盘中，未收盘'}`,
      '#9baebe',
    );
  if (rows.length < 2)
    return (
      start +
      title +
      (model.kind === 'volume'
        ? volumeComparison(model, 72, 180, 850) +
          text(28, 520, '完整OHLC不足，暂不绘制蜡烛图。') +
          text(28, 609, '成交量条件达标；不视为确认买点。', '#9baebe', 16)
        : text(28, 180, '完整OHLC不足，暂不绘制蜡烛图。')) +
      '</g></svg>'
    );
  const levels = [resistance, support, model.price].filter((v) => Number.isFinite(v) && v > 0);
  let min = Math.min(...rows.map((r) => r.low), ...levels),
    max = Math.max(...rows.map((r) => r.high), ...levels);
  const padding = Math.max((max - min) * 0.16, max * 0.015);
  min -= padding;
  max += padding;
  const y = (v) => top + ((max - v) / (max - min)) * (bottom - top);
  const quoteOnly = !model.snapshot && rows.at(-1).date !== model.date && model.price > 0;
  const step = (right - left) / (rows.length + (quoteOnly ? 1 : 0));
  const x = (i) => left + step * (i + 0.5);
  const parts = [
    start,
    title,
    text(28, 100, '绿蜡烛：上涨   红蜡烛：下跌   下方柱：成交量', '#9baebe', 16),
  ];
  if (model.kind === 'volume') parts.push(volumeComparison(model, 872, 150, 168));
  for (let i = 0; i < 4; i++) {
    const v = min + ((max - min) * i) / 3;
    parts.push(
      `<path d="M${left} ${y(v)}H${right}" stroke="#293b49" stroke-dasharray="4 6"/>`,
      text(12, y(v) + 5, price(v), '#9baebe', 14),
    );
  }
  const maxVolume = Math.max(1, ...rows.map((r) => r.volume || 0), model.volume || 0);
  rows.forEach((r, i) => {
    const color = r.close >= r.open ? '#52d8ad' : '#f27d88';
    const width = Math.max(3, Math.min(13, step * 0.65));
    parts.push(
      `<g><title>${escape(`${r.date} 开${r.open} 高${r.high} 低${r.low} 收${r.close} 量${r.volume}${r.provisional ? '（盘中）' : ''}`)}</title><path d="M${x(i)} ${y(r.high)}V${y(r.low)}" stroke="${color}" stroke-width="2"/><rect x="${x(i) - width / 2}" y="${Math.min(y(r.open), y(r.close))}" width="${width}" height="${Math.max(2, Math.abs(y(r.open) - y(r.close)))}" fill="${color}"/><rect x="${x(i) - width / 2}" y="${525 - ((r.volume || 0) / maxVolume) * 62}" width="${width}" height="${Math.max(1, ((r.volume || 0) / maxVolume) * 62)}" fill="${color}" opacity=".7"/></g>`,
    );
  });
  for (const [value, label, color] of [
    [resistance, '突破位', '#eebf68'],
    [support, '止损参考', '#f27d88'],
  ]) {
    if (!(value > 0)) continue;
    parts.push(
      `<path d="M${left} ${y(value)}H${right}" stroke="${color}" stroke-dasharray="7 5"/>`,
      text(right + 16, y(value) + 5, `${label} ${price(value)}`, color, 17),
    );
  }
  const latestX = x(quoteOnly ? rows.length : rows.length - 1);
  if (quoteOnly)
    parts.push(
      `<circle cx="${latestX}" cy="${y(model.price)}" r="5" fill="#a4b6c7"/>`,
      text(right - 160, 452, '报价：OHLC不全', '#9baebe', 14),
    );
  if (model.marker && model.marker_price > 0) {
    const markerY = y(model.marker_price),
      color = model.confirmed ? '#52d8ad' : '#eebf68';
    const labelY = Math.max(top + 22, markerY - 48);
    parts.push(
      `<path d="M${latestX} ${markerY - 3}l-8 -15h16Z" fill="${model.confirmed ? color : '#101b25'}" stroke="${color}" stroke-width="2"/><path d="M${latestX} ${markerY - 20}V${labelY + 7}" stroke="${color}"/>`,
      text(
        Math.max(left + 10, latestX - 175),
        labelY,
        `${model.marker} RM ${price(model.marker_price)}`,
        color,
        20,
        'font-weight="700"',
      ),
    );
  }
  parts.push(
    text(left, 552, rows[0].date, '#9baebe', 14),
    text(right, 552, model.date, '#9baebe', 14, 'text-anchor="end"'),
  );
  const volume = Number.isFinite(model.volume) ? `${+(model.volume / 10000).toFixed(2)}万股` : '—';
  parts.push(
    text(
      28,
      584,
      `成交量 ${volume} · 昨日 ${Number.isFinite(model.multiple) ? +model.multiple.toFixed(2) : '—'}倍`,
      '#e4edf4',
      19,
    ),
  );
  parts.push(
    text(
      28,
      609,
      model.kind === 'volume'
        ? '成交量条件达标；不视为确认买点。'
        : model.marker
          ? model.confirmed
            ? '实心箭头：策略条件达标；跌破止损参考位则失效，不保证上涨。'
            : '空心箭头：待突破并站稳后才考虑；未突破不视为确认买点。'
          : '暂未出现当前买点；历史走势不代表未来收益。',
      '#9baebe',
      16,
    ),
  );
  return parts.join('') + '</g></svg>';
}

export function combinedChartSvg(models) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${620 * models.length}">${models.map((m, i) => `<g transform="translate(0,${620 * i})">${chartSvg(m)}</g>`).join('')}</svg>`;
}
