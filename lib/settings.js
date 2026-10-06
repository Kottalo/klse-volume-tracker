export class ValidationError extends Error {}

const ranges = {
  poll_interval_minutes: [1, 5],
  cooldown_minutes: [1, 1440],
  price_drop_threshold: [0, 100],
  price_drop_threshold_high: [0, 100],
  gap_up_threshold: [0, 1000],
  gap_up_threshold_high: [0, 1000],
  db_min_score: [0, 100],
  db_tol: [0.1, 30],
  db_min_gap: [7, 120],
  db_max_gap: [7, 250],
  db_min_neck: [0.1, 100],
  db_fresh: [0, 30],
  db_min_rr: [0.1, 20],
  pick_count: [1, 20],
  min_average_daily_value: [0, 1000000000],
  win_pct: [0.1, 1000],
  loss_pct: [0.1, 100],
  watch_days: [1, 250],
  screen_min_gain: [-100, 1000],
  screen_max_gain: [-100, 1000],
  screen_vol_mult: [2, 100],
  screen_min_volume: [1000000, 1000000000000],
};
const integers = new Set(['db_min_gap', 'db_max_gap', 'db_fresh', 'pick_count', 'watch_days']);
const booleans = new Set(['screen_on', 'screen_above_ma5', 'screen_bullish']);
const secrets = new Set([
  'telegram_bot_token',
  'telegram_chat_id',
  'twilio_sid',
  'twilio_auth_token',
  'twilio_from',
  'twilio_to',
  'twilio_content_sid',
  'llm_api_key',
  'oanor_api_key',
]);

export function validateSettings(patch, current, { allowSecrets = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new ValidationError('设置必须是对象。');
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (ranges[key]) {
      const [min, max] = ranges[key];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integers.has(key) && !Number.isInteger(value))
      )
        throw new ValidationError(
          `${key} 需要${integers.has(key) ? '整数' : '数值'} ${min}–${max}。`,
        );
    } else if (booleans.has(key)) {
      if (typeof value !== 'boolean') throw new ValidationError(`${key} 需要 true 或 false。`);
    } else if (key === 'window') {
      if (typeof value !== 'string' || !/^(?:[1-9]\d{0,2})(?:m|h|d)$/.test(value))
        throw new ValidationError('时段格式应为 30m、1h 或 1d。');
      const n = parseInt(value, 10),
        unit = value.at(-1);
      if (
        (unit === 'm' && (n < 5 || n > 120)) ||
        (unit === 'h' && n > 5) ||
        (unit === 'd' && n > 20)
      )
        throw new ValidationError('分钟范围5–120，小时1–5，交易日1–20。');
    } else if (key === 'price_thresholds') {
      if (!Array.isArray(value) || value.length > 20)
        throw new ValidationError('价格规则最多20项。');
      let previous = 0;
      for (const [i, rule] of value.entries()) {
        if (
          !rule ||
          typeof rule.threshold !== 'number' ||
          !Number.isFinite(rule.threshold) ||
          rule.threshold <= 0 ||
          rule.threshold > 100000
        )
          throw new ValidationError('成交量阈值需大于0且不超过100000%。');
        if (rule.max === null) {
          if (i !== value.length - 1) throw new ValidationError('无上限规则必须放在最后。');
        } else if (
          typeof rule.max !== 'number' ||
          !Number.isFinite(rule.max) ||
          rule.max <= previous
        )
          throw new ValidationError('价格上限必须递增且大于0。');
        previous = rule.max;
      }
      if (value.length && value.at(-1).max !== null)
        throw new ValidationError('最后一项价格规则应为无上限。');
    } else if (key === 'market_holidays') {
      if (
        !Array.isArray(value) ||
        value.some(
          (v) =>
            typeof v !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
            !Number.isFinite(Date.parse(v)) ||
            new Date(v).toISOString().slice(0, 10) !== v,
        )
      )
        throw new ValidationError('休市日期必须是有效 YYYY-MM-DD 数组。');
    } else if (allowSecrets && secrets.has(key)) {
      if (typeof value !== 'string' || value.length > 512)
        throw new ValidationError('凭据格式不正确。');
    } else throw new ValidationError(`不允许修改参数 ${key}。`);
    next[key] = value;
  }
  for (const [low, high] of [
    ['screen_min_gain', 'screen_max_gain'],
    ['price_drop_threshold', 'price_drop_threshold_high'],
    ['gap_up_threshold', 'gap_up_threshold_high'],
    ['db_min_gap', 'db_max_gap'],
  ]) {
    if (next[low] > next[high]) throw new ValidationError(`${low} 不能大于 ${high}。`);
  }
  return next;
}

export function parameterPatch(name, value) {
  return {
    [name]: booleans.has(name)
      ? value === 'true'
        ? true
        : value === 'false'
          ? false
          : value
      : ranges[name]
        ? Number(value)
        : value,
  };
}
