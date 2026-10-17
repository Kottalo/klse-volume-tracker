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
  assert.ok(svg.includes('TEST&lt;&amp;'));
  assert.ok(!svg.includes('2026-10-19'));
  assert.ok(svg.includes('策略买点 RM 1.05'));
  assert.ok(svg.includes('止损参考 0.9'));
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
