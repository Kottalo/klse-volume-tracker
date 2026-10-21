export class ValidationError extends Error {}

export function validateSettings(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new ValidationError('设置格式不正确。');
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'potential_alerts_telegram') {
      if (typeof value !== 'boolean') throw new ValidationError('通知开关需要 true 或 false。');
    } else if (['telegram_bot_token', 'telegram_chat_id'].includes(key)) {
      if (typeof value !== 'string' || value.length > 512)
        throw new ValidationError('Telegram 设置格式不正确。');
    } else if (key === 'market_holidays') {
      if (
        !Array.isArray(value) ||
        value.length > 366 ||
        value.some(
          (v) =>
            typeof v !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
            !Number.isFinite(Date.parse(v)) ||
            new Date(v).toISOString().slice(0, 10) !== v,
        )
      )
        throw new ValidationError('休市日期应为 YYYY-MM-DD。');
    } else throw new ValidationError(`不允许修改参数 ${key}。`);
    next[key] = value;
  }
  return next;
}
