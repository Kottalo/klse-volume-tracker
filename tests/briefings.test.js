import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dueBriefingSlots,
  finalCandidates,
  nextTradingDate,
  formatBriefing,
  dueHalfHourSlots,
  halfHourCandidates,
  formatHalfHourBriefing,
} from '../lib/briefings.js';

const at = (s) => Date.parse(s + '+08:00') / 1000;
test('half-hour slots repeat unchanged lists, stop for lunch, and reserve the two final slots', () => {
  for (const slot of ['09:30', '10:00', '11:30', '12:30', '14:30', '15:30']) {
    const now = at('2026-10-07T' + slot + ':20');
    assert.deepEqual(dueHalfHourSlots({}, [], now), [slot]);
    assert.deepEqual(dueHalfHourSlots({}, [slot], now), []);
  }
  for (const time of [
    '09:00:00',
    '13:00:00',
    '13:30:00',
    '14:00:00',
    '16:00:00',
    '16:30:00',
    '17:00:00',
  ])
    assert.deepEqual(dueHalfHourSlots({}, [], at('2026-10-07T' + time)), []);
  assert.deepEqual(dueHalfHourSlots({}, [], at('2026-10-10T10:00:00')), []);
  assert.deepEqual(
    dueHalfHourSlots({ market_holidays: ['2026-10-07'] }, [], at('2026-10-07T10:00:00')),
    [],
  );
  assert.deepEqual(
    dueHalfHourSlots({ half_hour_briefing_on: false }, [], at('2026-10-07T10:00:00')),
    [],
  );
  assert.deepEqual(dueHalfHourSlots({}, [], at('2026-10-07T10:10:00')), []);
  const now = at('2026-10-07T10:00:20');
  const r = {
    potential_eligible: true,
    quote_date: '2026-10-07',
    fetched_at: now,
    volume: 1000000,
    volume_signal: { multiple: 2 },
  };
  assert.equal(halfHourCandidates([r], {}, '10:00', now).length, 1);
  assert.equal(finalCandidates([r], {}, '10:00', now).length, 0);
  assert.equal(halfHourCandidates([{ ...r, fetched_at: now - 21 }], {}, '10:00', now).length, 0);
  assert.match(
    formatHalfHourBriefing(
      { date: '2026-10-07', slot: '10:00', quote_at: now, minimum_multiple: 2, items: [] },
      'https://example.test',
    ),
    /半小时精选.*10:00/,
  );
});
test('MYT slot windows survive restart, skip weekends/holidays and never backdate a missed bulletin', () => {
  const cfg = { final_briefing_on: true, market_holidays: ['2026-10-07'] };
  assert.deepEqual(dueBriefingSlots(cfg, [], at('2026-10-06T15:59:59')), []);
  assert.deepEqual(dueBriefingSlots(cfg, [], at('2026-10-06T16:00:00')), ['16:00']);
  assert.deepEqual(dueBriefingSlots(cfg, ['16:00'], at('2026-10-06T16:05:00')), []);
  assert.deepEqual(dueBriefingSlots(cfg, [], at('2026-10-06T16:30:00')), ['16:30']);
  assert.deepEqual(dueBriefingSlots(cfg, [], at('2026-10-06T16:40:00')), []);
  assert.deepEqual(dueBriefingSlots(cfg, [], at('2026-10-06T18:00:00')), []);
  assert.deepEqual(dueBriefingSlots(cfg, [], at('2026-10-07T16:00:00')), []);
  assert.deepEqual(dueBriefingSlots(cfg, [], at('2026-10-10T16:00:00')), []);
  assert.deepEqual(
    dueBriefingSlots({ ...cfg, final_briefing_on: false }, [], at('2026-10-06T16:00:00')),
    [],
  );
  assert.equal(nextTradingDate('2026-10-09', ['2026-10-12']), '2026-10-13');
});

test('three picks and concise updates fit a single Telegram message', () => {
  const text = formatHalfHourBriefing(
    {
      date: '2026-10-07',
      slot: '10:00',
      quote_at: at('2026-10-07T10:00:20'),
      minimum_multiple: 2,
      items: Array.from({ length: 3 }, (_, i) => ({
        code: 'STOCK' + i,
        price: 1.234,
        volume: 1500000,
        multiple: 3.456,
        resistance: 1.3,
        support: 1.1,
        reason: '量价证据'.repeat(150),
      })),
      updates: {
        observations: Array.from({ length: 3 }, (_, i) => ({
          code: 'FOLLOW' + i,
          label: '涨幅达标',
          pct: 8.12,
        })),
        observation_count: 8,
        alerts: Array.from({ length: 3 }, (_, i) => ({
          code: 'ALERT' + i,
          message: '异动证据'.repeat(25),
        })),
        alert_count: 50,
      },
    },
    'https://example.test',
  );
  assert.ok(text.length < 4000);
  assert.match(text, /共8只/);
  assert.match(text, /共50条/);
});

test('closing picks filter the full ranked pool using strict million-share, inclusive three-times and fresh slot quotes', () => {
  const now = at('2026-10-06T16:00:30');
  const base = {
    potential_eligible: true,
    quote_date: '2026-10-06',
    fetched_at: now,
    volume: 1500000,
    volume_signal: { multiple: 3 },
  };
  const pool = [
    { ...base, code: 'TOP1', volume_signal: { multiple: 2.9 } },
    { ...base, code: 'TOP2', volume: 1000000 },
    { ...base, code: 'TOP3', snapshot: true },
    { ...base, code: 'FOURTH' },
  ];
  assert.deepEqual(
    finalCandidates(pool, {}, '16:00', now).map((r) => r.code),
    ['FOURTH'],
  );
  for (const change of [
    { volume_signal: { multiple: 2.999999 } },
    { fetched_at: at('2026-10-06T15:59:59') },
    { fetched_at: now + 1 },
    { quote_date: '2026-10-05' },
    { potential_eligible: false },
  ])
    assert.equal(finalCandidates([{ ...base, ...change }], {}, '16:00', now).length, 0);
  assert.equal(finalCandidates([base], { screen_vol_mult: 4 }, '16:00', now).length, 0);
  assert.equal(finalCandidates([base], { screen_min_volume: 2000000 }, '16:00', now).length, 0);
  assert.equal(finalCandidates([base], {}, '16:00', now + 181).length, 0);
});

test('the short bulletin states actual evidence and absence of eligible stocks without a next-day promise', () => {
  const record = {
    date: '2026-10-06',
    slot: '16:00',
    minimum_multiple: 3,
    quote_at: at('2026-10-06T16:01:00'),
    items: [],
  };
  const empty = formatBriefing(record, 'https://example.test');
  assert.match(empty, /没有符合完整条件/);
  assert.match(empty, /16:01/);
  assert.match(empty, /不保证上涨/);
  const text = formatBriefing(
    {
      ...record,
      items: [
        {
          code: 'TEST',
          price: 1,
          volume: 1500000,
          multiple: 3,
          resistance: 1.01,
          support: 0.95,
          reason: '量价转强',
        },
      ],
    },
    'https://example.test',
  );
  assert.match(text, /150万股/);
  assert.match(text, /昨日3倍/);
  assert.match(text, /跌破 RM 0.95/);
  assert.ok(text.length < 350);
});
