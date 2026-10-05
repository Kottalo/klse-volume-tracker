import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  trendMetrics,
  observationDays,
  compareSnapshots,
  explainStock,
  formatReport,
  sessionStart,
  volumeSignal,
  consolidationSetup,
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
  volume: 500000,
  high: 11 + i / 10,
  low: 9 + i / 10,
}));

test('historical calculations use only bars before the reference day', () => {
  const reference = history[22].date;
  const before = trendMetrics(history, history[22].close, 1000000, reference);
  const laterChanged = history.map((row) =>
    row.date >= reference ? { ...row, close: row.close * 10, volume: 30000 } : row,
  );
  assert.deepEqual(trendMetrics(laterChanged, history[22].close, 1000000, reference), before);
  assert.equal(before.vr, 2);
  assert.equal(before.previous_date, history[21].date);
  assert.equal(before.gain20, (history[22].close / history[2].close - 1) * 100);
});

const cnergen = JSON.parse(
  fs.readFileSync(new URL('./fixtures/cnergen-2026.json', import.meta.url), 'utf8'),
).bars;
function cnergenReport(date, overrides = {}) {
  const bar = cnergen.find((r) => r.date === date);
  const rows = cnergen.filter((r) => r.date <= date);
  const reviewNow = Date.parse(date + 'T17:30:00+08:00') / 1000;
  return explainStock({
    stock: {
      stock: 'CNERGEN',
      name: 'Cnergenz',
      price: bar.close,
      volume: bar.volume,
      prevClose: rows.at(-2).close,
      session_date: date,
      mtime: reviewNow,
      ...overrides,
    },
    rows,
    pattern: null,
    cfg: { ...cfg, min_average_daily_value: 200000 },
    now: reviewNow,
  });
}

test('CNERGEN is a pre-breakout setup on Oct 2 using only then-available data, and extended after its rally', () => {
  const report = cnergenReport('2026-10-02');
  assert.equal(report.stage, 'coiled');
  assert.equal(report.volume_signal.current, 2168900);
  assert.ok(Math.abs(report.volume_signal.multiple - 2.23713254) < 0.000001);
  assert.equal(report.volume_setup.resistance, 0.98);
  assert.equal(report.volume_setup.support, 0.89);
  assert.equal(report.volume_setup.events[0].date, '2026-09-22');
  assert.equal(report.volume_setup.events[0].change_pct, 0);
  assert.equal(report.volume_setup.base_end, '2026-10-01');
  assert.ok(Math.abs(report.volume_setup.average_multiple - 1.19996127) < 0.000001);
  assert.match(report.entry_plan, /尚未突破/);
  assert.match(formatReport(report), /放量蓄势/);
  const rallied = cnergenReport('2026-10-05');
  assert.equal(rallied.stage, 'extended');
  assert.equal(rallied.volume_setup.qualified, false);
  assert.equal(rallied.change_pct, 31.87);
  assert.match(rallied.conclusion, /不列入提前布局精选/);
});

test('later rally bars cannot change the earlier consolidation or its volume baseline', () => {
  const before = cnergen.filter((r) => r.date < '2026-10-02');
  const expected = consolidationSetup(before, 0.91, 2168900, '2026-10-02');
  const altered = cnergen.map((r) =>
    r.date >= '2026-10-02' ? { ...r, high: 100, low: 0.01, close: 90, volume: 999999999 } : r,
  );
  assert.deepEqual(consolidationSetup(altered, 0.91, 2168900, '2026-10-02'), expected);
});

test('flat-price setups still require both volume gates, current support and usable quotes', () => {
  const rows = cnergen.filter((r) => r.date < '2026-10-02');
  for (const [price, volume] of [
    [0.91, 999999],
    [0.91, 1938999],
    [0.88, 3000000],
    [1.1, 3000000],
  ])
    assert.equal(consolidationSetup(rows, price, volume, '2026-10-02').qualified, false);
  assert.equal(consolidationSetup(rows, 0.91, 1939000, '2026-10-02').qualified, true);
  const reviewNow = Date.parse('2026-10-02T10:30:00+08:00') / 1000;
  assert.equal(
    explainStock({
      stock: {
        stock: 'OLD',
        price: 0.91,
        volume: 2168900,
        session_date: '2026-10-02',
        mtime: reviewNow - 86400,
      },
      rows,
      pattern: null,
      cfg,
      now: reviewNow,
    }).stage,
    'stale',
  );
});

test('a large selloff or wide-range spike is not counted as quiet-volume buildup', () => {
  const rows = cnergen
    .filter((r) => r.date < '2026-10-02')
    .map((r) => (r.date === '2026-09-22' ? { ...r, low: 0.85, high: 1.05, close: 0.87 } : r));
  const result = consolidationSetup(rows, 0.91, 2168900, '2026-10-02');
  assert.equal(result.events.length, 0);
  assert.equal(result.qualified, false);
  assert.equal(
    consolidationSetup(
      rows.map((r) => ({ ...r, high: null })),
      0.91,
      2168900,
      '2026-10-02',
    ).available,
    false,
  );
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
      volume: 1000000,
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
    { screen_min_volume: 999999 },
    { screen_vol_mult: 1.9 },
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
  const rows = [...history, { date: '2026-10-02', close: 13, volume: 1000000 }];
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
  assert.equal(report.volume_signal.current, 1000000);
  assert.equal(report.volume_signal.previous, 500000);
  assert.match(report.sources.quotes, /完成交易日快照/);
});

test('low turnover cannot be promoted even with million-share double volume', () => {
  const stock = {
    stock: 'TEST',
    price: 0.065,
    volume: 1000000,
    session_date: '2026-10-05',
    mtime: now,
  };
  const report = explainStock({
    stock,
    rows: history.map((r) => ({ ...r, close: r.close / 200 })),
    pattern: null,
    cfg: { ...cfg, min_average_daily_value: 200000 },
    now,
  });
  assert.equal(report.stage, 'watch');
  assert.match(report.label, /成交/);
});

test('million-share and double-volume gates both apply inclusively, even with a valid pattern', () => {
  const pattern = {
    neck: 12.9,
    stop: 12.5,
    target1: 15,
    score: 95,
    breakDate: '2026-10-01',
    vr: 3,
    gap: 20,
  };
  for (const [current, previous, pass] of [
    [1000000, 500000, true],
    [999999, 400000, false],
    [1000000, 500001, false],
    [2000000, 0, false],
  ]) {
    const rows = history.map((r) => ({ ...r, volume: previous }));
    const report = explainStock({
      stock: {
        stock: 'TEST',
        price: 13,
        prevClose: 12,
        volume: current,
        session_date: '2026-10-05',
        mtime: now,
      },
      rows,
      pattern,
      cfg,
      now,
    });
    assert.equal(report.volume_signal.pass, pass);
    assert.equal(report.stage === 'confirmed', pass);
    assert.equal(report.volume_signal.current, current);
  }
  assert.equal(volumeSignal(999999, 400000, { minVolume: 0, minMultiple: 0 }).pass, false);
  assert.equal(volumeSignal(1000000, 500001).pass, false);
  assert.equal(volumeSignal(0, 500000).shortfall, 1000000);
  assert.equal(volumeSignal(2000000, 0).multiple, null);
});

test('early volume expansion can qualify before 15 percent gain, while falling prices do not', () => {
  const rows = history.map((r, i) => ({ ...r, close: 12 + i * 0.01 }));
  const stock = {
    stock: 'EARLY',
    price: 12.3,
    prevClose: 12.24,
    volume: 1200000,
    session_date: '2026-10-05',
    mtime: now,
  };
  const report = explainStock({ stock, rows, pattern: null, cfg, now });
  assert.ok(report.metrics.gain20 < 15);
  assert.equal(report.screen_pass, false);
  assert.equal(report.stage, 'confirmed');
  assert.match(report.conclusion, /1,200,000 股/);
  const down = explainStock({
    stock: { ...stock, price: 12, prevClose: 12.24 },
    rows,
    pattern: null,
    cfg,
    now,
  });
  assert.equal(down.volume_signal.pass, true);
  assert.equal(down.stage, 'watch');
  assert.match(down.label, /量价/);
});
