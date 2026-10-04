// Deterministic explanations: every claim comes from a measured value.
export const SOURCES = {
  quotes: 'TradingView 市场快照',
  history: 'Yahoo Finance 日线',
  performance:
    'https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-47',
};

export function marketDate(ts = Date.now() / 1000) {
  return new Date(ts * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function sessionStart(ts, holidays = []) {
  const local = new Date((ts + 8 * 3600) * 1000);
  if ([0, 6].includes(local.getUTCDay()) || holidays.includes(marketDate(ts))) return null;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = minute >= 540 && minute < 750 ? 540 : minute >= 870 && minute < 1020 ? 870 : null;
  if (start == null) return null;
  return Date.parse(`${marketDate(ts)}T00:00:00+08:00`) / 1000 + start * 60;
}

export function compareSnapshots(rows, seconds, now, tolerance = 600, holidays = []) {
  const start = sessionStart(now, holidays);
  if (start == null || now - 2 * seconds < start) return null;
  const at = (target) =>
    [...rows].reverse().find((r) => r.ts <= target && r.ts >= start && target - r.ts <= tolerance);
  const a = at(now),
    b = at(now - seconds),
    c = at(now - 2 * seconds);
  if (!a || !b || !c || a.cum_volume < b.cum_volume || b.cum_volume < c.cum_volume) return null;
  const current = a.cum_volume - b.cum_volume,
    previous = b.cum_volume - c.cum_volume;
  if (previous <= 0) return null;
  return { current, previous };
}

export function trendMetrics(rows, price, volume, referenceDate) {
  const history = rows
    .filter((r) => r.date < referenceDate && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (history.length < 20 || !(price > 0)) return null;
  const sequence = [...history.map((r) => r.close), price];
  const ma = (n) => sequence.slice(-n).reduce((sum, value) => sum + value, 0) / n;
  const ma5 = ma(5),
    ma10 = ma(10),
    ma15 = ma(15),
    ma20 = ma(20);
  const previousVolume = history.at(-1).volume;
  return {
    gain20: (price / history.at(-20).close - 1) * 100,
    vr:
      previousVolume > 0 && Number.isFinite(volume) && volume >= 0 ? volume / previousVolume : null,
    ma5,
    ma10,
    ma15,
    ma20,
    above_ma5: price > ma5,
    bull: ma5 > ma10 && ma10 > ma15 && ma15 > ma20,
    previous_date: history.at(-1).date,
    previous_volume: previousVolume,
  };
}

export function screenMatches(metrics, options = {}) {
  return (
    !!metrics &&
    metrics.gain20 >= (options.min_gain ?? 15) &&
    metrics.gain20 <= (options.max_gain ?? 25) &&
    metrics.vr != null &&
    metrics.vr >= (options.vol_mult ?? 2) &&
    (options.above_ma5 === false || metrics.above_ma5) &&
    (options.bullish_stack === false || metrics.bull)
  );
}

export function observationDays(rows, addedDate, today) {
  return new Set(rows.filter((r) => r.date > addedDate && r.date <= today).map((r) => r.date)).size;
}

const round = (v, digits = 2) => (Number.isFinite(v) ? +v.toFixed(digits) : null);

export function explainStock({ stock, rows, pattern, cfg, now = Date.now() / 1000 }) {
  const today = marketDate(now);
  const quoteDate = stock.session_date || rows.at(-1)?.date || null;
  const sessionOpen = sessionStart(now, cfg.market_holidays || []) != null;
  const latestBar = rows.at(-1)?.date || null;
  const historyAge = latestBar ? (Date.parse(today) - Date.parse(latestBar)) / 86400000 : Infinity;
  const historyRecent = historyAge >= 0 && historyAge <= 4;
  const historicalSnapshot = !sessionOpen && historyRecent && quoteDate === latestBar;
  if (historicalSnapshot)
    stock = {
      ...stock,
      price: rows.at(-1).close,
      volume: rows.at(-1).volume,
      prevClose: rows.at(-2)?.close,
    };
  const metrics = quoteDate ? trendMetrics(rows, stock.price, stock.volume, quoteDate) : null;
  const options = {
    min_gain: cfg.screen_min_gain,
    max_gain: cfg.screen_max_gain,
    vol_mult: cfg.screen_vol_mult,
    above_ma5: cfg.screen_above_ma5,
    bullish_stack: cfg.screen_bullish,
  };
  const screen = screenMatches(metrics, options);
  // A historical pattern must not masquerade as a live confirmation.
  const fresh =
    stock.mtime != null && now - stock.mtime <= Math.max(15, cfg.poll_interval_minutes * 3) * 60;
  const quoteCurrent = quoteDate === today;
  const usableSnapshot = (fresh && quoteCurrent) || historicalSnapshot;
  const unfinishedDay = quoteCurrent && new Date((now + 8 * 3600) * 1000).getUTCHours() < 17;
  const valueRows = rows.filter((row) => row.date < quoteDate).slice(-20);
  const averageDailyValue = valueRows.length
    ? valueRows.reduce((sum, row) => sum + row.close * (row.volume || 0), 0) / valueRows.length
    : 0;
  const liquid = averageDailyValue >= (cfg.min_average_daily_value || 0) && stock.volume > 0;
  const levels = pattern
    ? {
        neck: round(pattern.neck, 3),
        zone_low: round(pattern.neck, 3),
        zone_high: round(pattern.neck * 1.03, 3),
        invalidation: round(pattern.stop, 3),
        target: round(pattern.target1, 3),
        risk_pct:
          stock.price > 0 ? round(((stock.price - pattern.stop) / stock.price) * 100) : null,
        reward_pct:
          stock.price > 0 ? round(((pattern.target1 - stock.price) / stock.price) * 100) : null,
        rr:
          stock.price > pattern.stop
            ? round((pattern.target1 - stock.price) / (stock.price - pattern.stop))
            : null,
      }
    : null;
  const patternPass =
    !!pattern &&
    historyRecent &&
    pattern.score >= cfg.db_min_score &&
    stock.price >= pattern.neck &&
    levels.rr >= cfg.db_min_rr;
  const extended =
    !!pattern && (stock.price > pattern.neck * 1.03 || stock.price >= pattern.target1);
  const trendPass = !!metrics?.bull && !!metrics?.above_ma5;
  const volumePass = metrics?.vr != null && metrics.vr >= cfg.screen_vol_mult;
  const checks = [
    {
      key: 'trend',
      label: '走势是否转强',
      pass: trendPass,
      available: !!metrics,
      detail: metrics
        ? `现价${metrics.above_ma5 ? '高于' : '未高于'}近5日平均价 ${round(metrics.ma5, 3)}；短期均线${metrics.bull ? '依次高于' : '尚未依次高于'}长期均线。`
        : '至少需要20个交易日的完整收盘数据。',
    },
    {
      key: 'volume',
      label: '成交是否更活跃',
      pass: volumePass,
      available: metrics?.vr != null,
      detail:
        metrics?.vr != null
          ? `本次累计成交量是 ${metrics.previous_date} 全天的 ${round(metrics.vr)} 倍。${unfinishedDay ? '今日尚未收盘，这个比值还会变化。' : ''}`
          : '缺少可比较的当日量或上一交易日量。',
    },
    {
      key: 'pattern',
      label: '形态是否已突破',
      pass: patternPass,
      available: rows.length >= 45,
      detail: pattern
        ? `日线在 ${pattern.breakDate} 越过前期压力位 ${round(pattern.neck, 3)}；现价${stock.price >= pattern.neck ? '仍在其上方' : '已回到其下方'}。`
        : '当前没有符合参数的近期双底突破；不等于股票一定会下跌。',
    },
  ];
  let stage = 'watch',
    label = '等待确认',
    conclusion = metrics
      ? `近20个交易日价格变化 ${round(metrics.gain20)}%，${trendPass ? '趋势已转强' : '趋势还不够稳定'}；${volumePass ? '成交量达到筛选门槛' : '成交量暂未达到筛选门槛'}。当前依据不够一致，先等新的确认。`
      : '资料尚未完整，暂时无法形成参与判断。';
  if (!metrics) {
    stage = 'insufficient';
    label = '资料待补齐';
    conclusion = '历史资料不足，暂时无法形成完整的技术分析。';
  } else if (screen || patternPass) {
    stage = 'confirmed';
    label = '可重点考虑';
    conclusion = patternPass
      ? `日线已在 ${pattern.breakDate} 完成双底突破，现价 RM ${round(stock.price, 3)} 仍守在 RM ${round(pattern.neck, 3)} 上方。形态${volumePass ? '与本次放量互相支持' : '具备参与依据，但本次量能仍需跟踪'}，可重点考虑参考区间内的机会。`
      : `近20个交易日上涨 ${round(metrics.gain20)}%，本次成交量达到上一交易日的 ${round(metrics.vr)} 倍，短期趋势也保持向上。趋势与量能同时支持，可以列入优先考虑的标的。`;
  }
  if (extended) {
    stage = 'extended';
    label = '等待回踩';
    conclusion = `突破结构仍需跟踪，但现价 RM ${round(stock.price, 3)} 已超过 RM ${round(pattern.neck * 1.03, 3)} 的形态参考区间上限。当前更适合等待回踩后重新确认，直接追价的风险空间更大。`;
  }
  if (metrics && (!historyRecent || !usableSnapshot)) {
    stage = 'stale';
    label = '等待数据更新';
    conclusion = '当前资料尚不能代表最新交易情况；等行情与日线更新后再判断参与条件。';
  }
  const risks = ['技术信号只描述价格与成交量，没有评估公司财报、估值和最新公告。'];
  if (stage === 'confirmed' && !liquid) {
    stage = 'watch';
    label = '等待有效成交';
    conclusion = `价格形态或趋势有积极信号，但最近20个交易日平均成交额估算约 RM ${round(averageDailyValue, 0)}，或本次尚无有效成交。成交活跃度没有通过精选条件，暂不列入优先参与名单。`;
  }
  if (unfinishedDay) risks.push('盘中价格、成交量和均线还会变化，收盘后可能不再满足条件。');
  if (extended) risks.push('现价已高于形态参考区间，不宜把过去的突破位置当作当前价格。');
  if (pattern)
    risks.push(
      `若价格跌回压力位 ${round(pattern.neck, 3)} 下方，突破依据会减弱；${round(pattern.stop, 3)} 是形态失效参考位。`,
    );
  if (!historyRecent) risks.push('日线资料较旧，需要补齐历史数据后重新分析。');
  const reasons = checks.filter((c) => c.pass).map((c) => c.detail);
  const entryPlan = levels
    ? stage === 'confirmed'
      ? `现价位于 RM ${levels.zone_low}–${levels.zone_high} 参考区间内，可在守住突破位的前提下考虑参与；超过区间上限后重新评估。`
      : `优先观察 RM ${levels.zone_low}–${levels.zone_high}，回到区间后仍需守住突破位。`
    : metrics
      ? `先看价格能否在近5日平均价 RM ${round(metrics.ma5, 3)} 附近获得支撑，再核对成交量是否继续配合。`
      : '等待补齐资料，暂不提供参考价位。';
  const invalidationPlan = levels
    ? `跌回 RM ${levels.neck} 下方时原有突破依据减弱；RM ${levels.invalidation} 是形态失效参考位。`
    : metrics
      ? `若价格跌回近5日平均价 RM ${round(metrics.ma5, 3)} 下方，或均线排列转弱，需要重新评估当前趋势判断。`
      : '资料不足，暂时无法判断失效条件。';
  return {
    code: stock.code || stock.stock,
    name: stock.name,
    price: stock.price,
    change_pct: stock.prevClose > 0 ? round((stock.price / stock.prevClose - 1) * 100) : null,
    stage,
    label,
    conclusion,
    checks,
    reasons,
    risks,
    levels,
    entry_plan: entryPlan,
    invalidation_plan: invalidationPlan,
    monitor_plan:
      stage === 'confirmed'
        ? '下一步看能否继续守住参考位；盘中信号要再核对收盘后的结果。'
        : stage === 'extended'
          ? '等待回踩时价格守住原突破位，再检查成交量与最新公告。'
          : '等待趋势与成交量进一步配合，或出现新的有效突破。',
    evidence_count: checks.filter((c) => c.pass).length,
    screen_pass: screen,
    pattern_pass: patternPass,
    average_daily_value: round(averageDailyValue, 0),
    metrics: metrics
      ? Object.fromEntries(
          Object.entries(metrics).map(([k, v]) => [
            k,
            typeof v === 'number' ? round(v, k.startsWith('ma') ? 3 : 2) : v,
          ]),
        )
      : null,
    pattern: pattern
      ? { score: pattern.score, date: pattern.breakDate, vr: round(pattern.vr), gap: pattern.gap }
      : null,
    quote_date: quoteDate,
    history_date: latestBar,
    fetched_at: stock.mtime,
    snapshot: historicalSnapshot,
    sources: {
      quotes: historicalSnapshot ? SOURCES.history + ' 完成交易日快照' : SOURCES.quotes,
      history: SOURCES.history,
      timing: '快照抓取时间不代表交易所实时行情时间；免费接口可能延迟。',
    },
    next_step:
      stage === 'confirmed'
        ? entryPlan
        : stage === 'extended'
          ? '等待价格回到参考区间后，再确认突破仍有效。'
          : stage === 'insufficient' || stage === 'stale'
            ? '等资料更新，再判断是否具备参与条件。'
            : '等待趋势、成交量或形态出现进一步确认。',
  };
}

export function formatReport(report) {
  const lines = [
    `📌 ${report.name} (${report.code})`,
    `现价 RM ${report.price ?? '—'} · ${report.label}`,
    '',
    '分析结论：' + report.conclusion,
    '',
    '支持这个判断的依据：',
  ];
  for (const check of report.checks)
    lines.push(`${check.pass ? '✓' : '○'} ${check.label}：${check.detail}`);
  if (report.levels)
    lines.push(
      '',
      `形态参考区间 RM ${report.levels.zone_low}–${report.levels.zone_high}`,
      `失效参考 RM ${report.levels.invalidation} · 量度目标 RM ${report.levels.target}`,
      '目标是形态推算值，不是收益承诺。',
    );
  lines.push(
    '',
    '参与参考：' + report.entry_plan,
    '失效条件：' + report.invalidation_plan,
    '',
    `下一步：${report.monitor_plan}`,
    ...report.risks.map((r) => `• ${r}`),
    `资料：行情 ${report.quote_date || '待补齐'} / 日线 ${report.history_date || '待补齐'}`,
    '依据满足数和形态评分都不是上涨概率。',
  );
  return lines.join('\n');
}
