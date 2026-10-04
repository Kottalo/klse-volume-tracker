import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trendMetrics,
  observationDays,
  compareSnapshots,
  explainStock,
  formatReport,
  sessionStart,
} from '../lib/analysis.js';
import { validateSettings, ValidationError } from '../lib/settings.js';

const now = Date.parse('2026-10-05T10:30:00+08:00') / 1000;
const cfg = {
  poll_interval_minutes: 5,
  screen_min_gain: 15,
  screen_max_gain: 25,
  screen_vol_mult: 2,
  db_min_score: 70,
  db_min_rr: 1,
  market_holidays: [],
};
const history = Array.from({ length: 25 }, (_, i) => ({
  date: new Date(Date.parse('2026-09-07') + i * 86400000).toISOString().slice(0, 10),
  close: 10 + i / 10,
  volume: 100,
  high: 11 + i / 10,
  low: 9 + i / 10,
}));

test('historical calculations use only bars before the reference day', () => {
  const reference = history[22].date;
  const before = trendMetrics(history, history[22].close, 200, reference);
  const laterChanged = history.map((row) =>
    row.date >= reference ? { ...row, close: row.close * 10, volume: 30000 } : row,
  );
  assert.deepEqual(trendMetrics(laterChanged, history[22].close, 200, reference), before);
  assert.equal(before.vr, 2);
  assert.equal(before.previous_date, history[21].date);
  assert.equal(before.gain20, (history[22].close / history[2].close - 1) * 100);
});

test('observation days count distinct available trading dates after entry', () => {
  assert.equal(
    observationDays(
      [{ date: '2026-10-02' }, { date: '2026-10-05' }, { date: '2026-10-05' }],
      '2026-10-02',
      '2026-10-05',
    ),
    1,
  );
  assert.equal(observationDays([{ date: '2026-10-05' }], '2026-10-05', '2026-10-05'), 0);
});

test('intraday comparison requires complete, monotonic snapshots in one session', () => {
  const rows = [
    { ts: now - 3600, cum_volume: 100 },
    { ts: now - 1800, cum_volume: 200 },
    { ts: now, cum_volume: 400 },
  ];
  assert.deepEqual(compareSnapshots(rows, 1800, now), { current: 200, previous: 100 });
  assert.equal(compareSnapshots(rows, 3600, now), null);
  const afternoon = Date.parse('2026-10-05T15:00:00+08:00') / 1000;
  assert.equal(
    compareSnapshots(rows.concat({ ts: afternoon, cum_volume: 500 }), 1800, afternoon),
    null,
  );
  assert.equal(
    compareSnapshots(
      rows.map((r, i) => (i === 2 ? { ...r, cum_volume: 50 } : r)),
      1800,
      now,
    ),
    null,
  );
  assert.equal(compareSnapshots(rows, 1800, now + 900, 300), null);
  assert.equal(sessionStart(now, ['2026-10-05']), null);
});

test('zero current volume is valid; a zero previous volume cannot produce a ratio', () => {
  const rows = [
    { ts: now - 3600, cum_volume: 100 },
    { ts: now - 1800, cum_volume: 200 },
    { ts: now, cum_volume: 200 },
  ];
  assert.deepEqual(compareSnapshots(rows, 1800, now), { current: 0, previous: 100 });
  assert.equal(
    compareSnapshots(
      rows.map((r) => ({ ...r, cum_volume: 200 })),
      1800,
      now,
    ),
    null,
  );
});

test('reports explain measured evidence without converting it into a winning probability', () => {
  const report = explainStock({
    stock: {
      stock: 'TEST',
      name: 'Test',
      price: 13,
      prevClose: 12,
      volume: 200,
      session_date: '2026-10-05',
      mtime: now,
    },
    rows: history,
    pattern: null,
    cfg,
    now,
  });
  assert.equal(report.stage, 'confirmed');
  assert.equal(report.evidence_count, 2);
  assert.equal(report.levels, null);
  assert.match(formatReport(report), /不是上涨概率/);
  assert.match(report.checks[1].detail, /尚未收盘/);
  assert.ok(report.risks.some((risk) => risk.includes('财报')));
});

test('stale quotes and missing history are not presented as current confirmations', () => {
  const stock = {
    stock: 'TEST',
    price: 13,
    volume: 200,
    mtime: now - 86400,
    session_date: '2026-10-02',
  };
  assert.equal(explainStock({ stock, rows: history, pattern: null, cfg, now }).stage, 'stale');
  assert.equal(explainStock({ stock, rows: [], pattern: null, cfg, now }).stage, 'insufficient');
});

test('a target already reached is not moved upward to manufacture attractive upside', () => {
  const pattern = {
    neck: 12,
    stop: 11.5,
    target1: 13,
    score: 90,
    breakDate: '2026-10-01',
    vr: 2,
    gap: 20,
  };
  const report = explainStock({
    stock: { stock: 'TEST', price: 13.5, volume: 200, mtime: now, session_date: '2026-10-05' },
    rows: history,
    pattern,
    cfg,
    now,
  });
  assert.equal(report.stage, 'extended');
  assert.equal(report.levels.target, 13);
  assert.ok(report.levels.reward_pct < 0);
});

test('settings reject nonfinite values, malformed ranges and member credential changes', () => {
  const defaults = {
    ...cfg,
    screen_on: true,
    screen_min_gain: 15,
    screen_max_gain: 25,
    db_min_gap: 15,
    db_max_gap: 80,
    gap_up_threshold: 5,
    gap_up_threshold_high: 7,
    price_drop_threshold: 40,
    price_drop_threshold_high: 50,
  };
  for (const patch of [
    { poll_interval_minutes: 0 },
    { db_tol: 0 },
    { screen_min_gain: 30 },
    { screen_on: 'false' },
    { pick_count: 1.5 },
    { watchlist: 'broken' },
    { llm_api_key: 'secret' },
    { market_holidays: ['2026-02-30'] },
    { price_thresholds: [{ max: 2, threshold: 200 }] },
  ])
    assert.throws(() => validateSettings(patch, defaults), ValidationError);
  assert.equal(validateSettings({ screen_on: false }, defaults).screen_on, false);
  assert.equal(
    validateSettings({ llm_api_key: 'test' }, defaults, { allowSecrets: true }).llm_api_key,
    'test',
  );
});

test('a recent closed-session report uses the completed daily bar rather than an old intraday quote', () => {
  const closedNow = Date.parse('2026-10-03T12:00:00+08:00') / 1000;
  const rows = [...history, { date: '2026-10-02', close: 13, volume: 200 }];
  const report = explainStock({
    stock: {
      stock: 'TEST',
      price: 99,
      volume: 500,
      mtime: closedNow - 86400,
      session_date: '2026-10-02',
    },
    rows,
    pattern: null,
    cfg,
    now: closedNow,
  });
  assert.equal(report.snapshot, true);
  assert.equal(report.price, 13);
  assert.equal(report.metrics.vr, 2);
  assert.match(report.sources.quotes, /完成交易日快照/);
});

test('low turnover or no current trades cannot be promoted into the shortlist', () => {
  const stock = { stock: 'TEST', price: 13, volume: 200, session_date: '2026-10-05', mtime: now };
  const report = explainStock({
    stock,
    rows: history,
    pattern: null,
    cfg: { ...cfg, min_average_daily_value: 200000 },
    now,
  });
  assert.equal(report.stage, 'watch');
  assert.match(report.label, /成交/);
});
