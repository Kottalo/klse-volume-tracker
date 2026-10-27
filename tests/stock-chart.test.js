import test from 'node:test';
import assert from 'node:assert/strict';
import { chartModel, chartSvg, combinedChartSvg } from '../lib/stock-chart.js';
import { chartPng } from '../lib/chart-image.js';

const report = {
  code: 'TEST<&',
  quote_date: '2026-10-16',
  price: 1.05,
  volume: 2000000,
  volume_signal: { multiple: 3 },
  stage: 'confirmed',
  potential_eligible: true,
  potential_signal: { resistance: 1, support: 0.9 },
  history: [
    { date: '2026-10-14', open: 0.95, high: 1, low: 0.9, close: 0.98, volume: 500000 },
    { date: '2026-10-15', open: 0.98, high: 1, low: 0.96, close: 0.97, volume: 600000 },
    { date: '2026-10-19', open: 2, high: 3, low: 1, close: 2, volume: 800000 },
  ],
};
test('candles use real OHLC, exclude future bars and reserve confirmed markers for actual eligible breakouts', () => {
  const model = chartModel(report, { open: 0.98, high: 1.06, low: 0.97 });
  assert.equal(model.rows.length, 3);
  assert.equal(model.rows.at(-1).provisional, true);
  assert.equal(model.marker, '策略买点');
  assert.equal(chartModel({ ...report, stage: 'coiled' }).marker, '突破后买点');
  assert.equal(chartModel({ ...report, potential_eligible: false }).marker, null);
  assert.equal(chartModel({ ...report, snapshot: true }).marker, null);
  assert.equal(chartModel(report, { open: 0.98, high: 0.9, low: 1.1 }).rows.length, 2);
  const svg = chartSvg(model);
  assert.ok(svg.includes('Stock code: TEST&lt;&amp;'));
  assert.ok(!svg.includes('2026-10-19'));
  assert.ok(svg.includes('策略买点 RM 1.05'));
  assert.ok(svg.includes('止损参考 0.9'));
  assert.match(chartSvg(chartModel({ ...report, price: 0.904999979 })), /RM 0.905/);
  assert.ok(!chartSvg(chartModel({ ...report, price: 0.904999979 })).includes('0.904999979'));
});
test('the same chart renders to a real, portable PNG with the bundled Chinese font', () => {
  const models = [
    chartModel(report, { open: 0.98, high: 1.06, low: 0.97 }),
    chartModel({ ...report, stage: 'coiled' }),
  ];
  const png = Buffer.from(chartPng(models));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1240);
  assert.match(combinedChartSvg(models), /translate\(0,620\)/);
});

test('volume analysis uses real candles when available and always compares today with yesterday', async () => {
  const { volumeChartModel } = await import('../lib/stock-chart.js');
  const stock = {
    code: 'VOLUME<&',
    date: '2026-10-16',
    volume: 1500000,
    previous_volume: 500000,
    previous_date: '2026-10-15',
    multiple: 3,
  };
  const model = volumeChartModel(stock, report.history, {
    price: 1.05,
    open: 0.98,
    high: 1.06,
    low: 0.97,
  });
  assert.equal(model.rows.length, 3);
  assert.equal(model.marker, null);
  const svg = chartSvg(model);
  assert.match(svg, /1,500,000 股/);
  assert.match(svg, /500,000 股/);
  assert.match(svg, /3.00倍/);
  assert.match(svg, /VOLUME&lt;&amp;/);
  assert.doesNotMatch(svg, /2026-10-19|NaN|Infinity/);
  const fallback = volumeChartModel(stock, [], {});
  assert.equal(fallback.rows.length, 0);
  const fallbackSvg = chartSvg(fallback);
  assert.match(fallbackSvg, /1,500,000 股/);
  assert.match(fallbackSvg, /500,000 股/);
  assert.match(fallbackSvg, /完整OHLC不足/);
  assert.doesNotMatch(fallbackSvg, /NaN|Infinity/);
  assert.doesNotMatch(chartSvg(volumeChartModel(stock, report.history, {})), /NaN|Infinity/);
  const png = Buffer.from(chartPng([fallback]));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(20), 620);
});
