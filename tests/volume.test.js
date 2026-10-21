import test from 'node:test';
import assert from 'node:assert/strict';
import {
  volumeSignal,
  formatVolumeAlert,
  formatMultiple,
  sessionStart,
  previousTradingDate,
} from '../lib/volume.js';
import { validateSettings, ValidationError } from '../lib/settings.js';

test('only the inclusive three-times ratio decides eligibility, without a volume floor', () => {
  for (const [current, previous, pass] of [
    [300, 100, true],
    [299, 100, false],
    [3000000, 1000000, true],
    [2999999, 1000000, false],
    [10, 1, true],
    [0, 100, false],
    [300, 0, false],
    [300, null, false],
    [null, 100, false],
    [NaN, 100, false],
    [Infinity, 100, false],
    [-1, 100, false],
  ]) {
    assert.equal(volumeSignal(current, previous).pass, pass, `${current}/${previous}`);
  }
});
test('messages contain just code, volumes and ratio', () => {
  const text = formatVolumeAlert({
    code: 'TEST',
    numeric_code: '0123',
    volume: 300,
    previous_volume: 100,
    multiple: 3,
  });
  assert.equal(text, 'TEST (0123) · 昨日 3.00 倍\n今日 300 股｜昨日 100 股');
  assert.doesNotMatch(text, /买点|支撑|目标|精选|突破|https:/);
  assert.equal(formatMultiple(2.999999), '<3.00');
  assert.equal(formatMultiple(3), '3.00');
});
test('MYT trading dates skip weekends and configured holidays; lunch never generates alerts', () => {
  assert.equal(previousTradingDate('2026-10-05'), '2026-10-02');
  assert.equal(previousTradingDate('2026-10-05', ['2026-10-02']), '2026-10-01');
  for (const time of ['08:59', '12:30', '14:29', '17:00'])
    assert.equal(sessionStart(Date.parse(`2026-10-05T${time}:00+08:00`) / 1000), null);
  for (const time of ['09:00', '12:29', '14:30', '16:59'])
    assert.ok(sessionStart(Date.parse(`2026-10-05T${time}:00+08:00`) / 1000));
});
test('settings retain notification controls and reject removed strategy parameters', () => {
  assert.equal(
    validateSettings({ potential_alerts_telegram: false }, {}).potential_alerts_telegram,
    false,
  );
  for (const patch of [
    { screen_vol_mult: 4 },
    { screen_min_volume: 1000000 },
    { pick_count: 3 },
    { llm_api_key: 'x' },
    { potential_alerts_telegram: 'yes' },
    { market_holidays: ['2026-02-30'] },
    { telegram_bot_token: 123 },
  ])
    assert.throws(() => validateSettings(patch, {}), ValidationError);
});
