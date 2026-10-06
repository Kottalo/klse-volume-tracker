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
    current_volume: volume,
  };
}

export function screenMatches(metrics, options = {}) {
  return (
    !!metrics &&
    metrics.gain20 >= (options.min_gain ?? 15) &&
    metrics.gain20 <= (options.max_gain ?? 25) &&
    metrics.vr != null &&
    metrics.vr >= Math.max(2, options.vol_mult ?? 2) &&
    metrics.current_volume >= Math.max(1000000, options.min_volume ?? 1000000) &&
    (options.above_ma5 === false || metrics.above_ma5) &&
    (options.bullish_stack === false || metrics.bull)
  );
}

export function observationDays(rows, addedDate, today) {
  return new Set(rows.filter((r) => r.date > addedDate && r.date <= today).map((r) => r.date)).size;
}

const round = (v, digits = 2) => (Number.isFinite(v) ? +v.toFixed(digits) : null);
const shares = (v) => `${Math.round(v).toLocaleString('zh-CN')} 股`;

export function volumeSignal(current, previous, { minVolume = 1000000, minMultiple = 2 } = {}) {
  const minimum = Math.max(1000000, minVolume),
    multiple = Math.max(2, minMultiple);
  const currentAvailable = Number.isFinite(current) && current >= 0;
  const previousAvailable = Number.isFinite(previous) && previous > 0;
  const ratio = currentAvailable && previousAvailable ? current / previous : null;
  const amountPass = currentAvailable && current >= minimum;
  const multiplePass = ratio != null && ratio >= multiple;
  return {
    current: currentAvailable ? current : null,
    previous: previousAvailable ? previous : null,
    multiple: ratio,
    minimum_volume: minimum,
    minimum_multiple: multiple,
    amount_pass: amountPass,
    multiple_pass: multiplePass,
    pass: amountPass && multiplePass,
    extra_volume: ratio == null ? null : current - previous,
    increase_pct: ratio == null ? null : (ratio - 1) * 100,
    required_volume: previousAvailable ? Math.max(minimum, previous * multiple) : minimum,
    shortfall:
      currentAvailable && previousAvailable
        ? Math.max(0, minimum - current, previous * multiple - current)
        : null,
    summary:
      !currentAvailable || !previousAvailable
        ? '成交量对比资料不足，暂时不能确认放量。'
        : `本次成交 ${shares(current)}，上一交易日 ${shares(previous)}，达到昨日的 ${round(ratio, 4)} 倍（${ratio >= 1 ? '增加' : '减少'} ${round(Math.abs((ratio - 1) * 100))}%）。`,
    title:
      amountPass && multiplePass
        ? '明显放量，两个门槛均已达标'
        : !currentAvailable || !previousAvailable
          ? '等待成交量资料'
          : !amountPass
            ? '成交量还未达到百万股'
            : '成交量还未达到昨日两倍',
  };
}

// A setup is measured before the quote date. The later rally never defines its base.
export function consolidationSetup(rows, price, currentVolume, referenceDate, options = {}) {
  const history = [
    ...new Map(
      rows
        .filter((r) => r.date < referenceDate && r.close > 0 && r.volume > 0)
        .map((r) => [
          r.date,
          { ...r, close: round(r.close, 6), high: round(r.high, 6), low: round(r.low, 6) },
        ]),
    ).values(),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const base = history.slice(-10),
    baseline = history.slice(-20);
  if (
    baseline.length < 20 ||
    base.some((r) => !(r.high >= r.close && r.low > 0 && r.low <= r.close))
  )
    return {
      available: false,
      qualified: false,
      events: [],
      summary: '至少需要20个有成交的完整交易日，以及整理区间的高低价资料。',
    };
  const support = Math.min(...base.map((r) => r.low));
  const resistance = Math.max(...base.map((r) => r.high));
  const closeLow = Math.min(...base.map((r) => r.close));
  const closeHigh = Math.max(...base.map((r) => r.close));
  const rangePct = (resistance / support - 1) * 100;
  const closeRangePct = (closeHigh / closeLow - 1) * 100;
  const netChange = (base.at(-1).close / base[0].close - 1) * 100;
  const averageVolume = baseline.reduce((s, r) => s + r.volume, 0) / baseline.length;
  const events = [];
  for (let i = Math.max(1, history.length - 10); i < history.length; i++) {
    const bar = history[i],
      previous = history[i - 1];
    const signal = volumeSignal(bar.volume, previous.volume, options);
    const change = (bar.close / previous.close - 1) * 100;
    const dayRange = bar.high > bar.low ? (bar.close - bar.low) / (bar.high - bar.low) : 1;
    if (
      signal.pass &&
      change >= -1.5 &&
      change <= 3 &&
      (bar.high / bar.low - 1) * 100 <= 8 &&
      dayRange >= 0.45
    )
      events.push({
        date: bar.date,
        previous_date: previous.date,
        volume: bar.volume,
        previous_volume: previous.volume,
        multiple: signal.multiple,
        change_pct: round(change),
        close: round(bar.close, 3),
      });
  }
  const change = (price / history.at(-1).close - 1) * 100;
  const averageMultiple = currentVolume / averageVolume;
  const basePass = rangePct <= 12 && closeRangePct <= 8 && Math.abs(netChange) <= 8;
  const holding = price >= support && price >= closeHigh * 0.92;
  const extended = basePass && (price > resistance * 1.03 || change >= 8);
  const quiet = change >= -1.5 && change <= 3 && price <= resistance;
  const earlyBreakout =
    price > resistance + 0.000001 && price <= resistance * 1.03 && change > 0.0001 && change < 8;
  const repeated = events.length > 0 || averageMultiple >= 1.5;
  const currentPass = volumeSignal(currentVolume, history.at(-1).volume, options).pass;
  const qualified =
    currentPass && basePass && holding && repeated && !extended && (quiet || earlyBreakout);
  return {
    available: true,
    qualified,
    base_pass: basePass,
    holding,
    quiet,
    early_breakout: earlyBreakout,
    extended,
    base_start: base[0].date,
    base_end: base.at(-1).date,
    base_days: base.length,
    support: round(support, 3),
    resistance: round(resistance, 3),
    range_pct: round(rangePct),
    close_range_pct: round(closeRangePct),
    net_change_pct: round(netChange),
    average_volume: round(averageVolume, 0),
    average_multiple: averageMultiple,
    current_change_pct: round(change),
    distance_to_breakout_pct: round((resistance / price - 1) * 100),
    events,
    summary: `此前10个有成交交易日的收盘价区间宽度 ${round(closeRangePct)}%，高低价区间 RM ${round(support, 3)}–${round(resistance, 3)}；其中 ${events.length} 天达到百万股、两倍放量而价格仍平稳。本次成交量为此前20日均量的 ${round(averageMultiple, 2)} 倍。`,
  };
}

// Recovery and breakout are separate paths; a narrow ten-day base is not universal.
export function potentialSignal(rows, price, volume, date, options = {}) {
  const history = rows
    .filter((r) => r.date < date && r.close > 0 && r.volume > 0)
    .map((r) => ({ ...r, close: round(r.close, 6), high: round(r.high, 6), low: round(r.low, 6) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const metrics = trendMetrics(history, price, volume, date);
  if (!metrics || !history.length) return null;
  const previous = history.at(-1),
    evidence = volumeSignal(volume, previous.volume, options);
  if (!evidence.pass) return null;
  const average = history.slice(-20).reduce((sum, r) => sum + r.volume, 0) / 20;
  const meanValue = history.slice(-20).reduce((sum, r) => sum + r.volume * r.close, 0) / 20;
  if (meanValue < (options.minAverageValue || 0)) return null;
  // Apply observable candle strength to every path, including consolidation.
  const quoteBar = rows.find((r) => r.date === date);
  if (
    quoteBar?.high > quoteBar?.low &&
    (price - quoteBar.low) / (quoteBar.high - quoteBar.low) < 0.45
  )
    return null;
  const change = (price / previous.close - 1) * 100;
  const setup = consolidationSetup(history, price, volume, date, options);
  const common = {
    date,
    price: round(price, 6),
    volume,
    previous_volume: previous.volume,
    previous_date: previous.date,
    multiple: evidence.multiple,
    average_multiple: volume / average,
    change_pct: round(change),
    average_daily_value: round(meanValue, 0),
  };
  if (setup.qualified)
    return {
      ...common,
      kind: setup.early_breakout ? 'breakout' : 'coiled',
      eligible: true,
      resistance: setup.resistance,
      support: setup.support,
      base_days: 10,
      summary: setup.summary,
    };
  const recent = history.slice(-5),
    longer = history.slice(-10);
  if (recent.some((r) => !(r.high >= r.close && r.low > 0 && r.low <= r.close))) return null;
  const support = Math.min(...recent.map((r) => r.low)),
    resistance = Math.max(...longer.map((r) => r.high));
  if (!Number.isFinite(resistance)) return null;
  const positive = change > 0.0001 && metrics.above_ma5 && metrics.ma5 >= metrics.ma10;
  const above = price > resistance + 0.000001;
  const closeRange =
    (Math.max(...recent.map((r) => r.close)) / Math.min(...recent.map((r) => r.close)) - 1) * 100;
  const wickRange = (Math.max(...recent.map((r) => r.high)) / support - 1) * 100;
  const building =
    !above &&
    closeRange <= 12 &&
    wickRange <= 20 &&
    price >= support &&
    (resistance / price - 1) * 100 <= 10;
  if (!positive || volume / average < 1.2 || !(above || building)) return null;
  return {
    ...common,
    kind: above ? 'breakout' : 'building',
    eligible: change < 8 && price <= resistance * 1.03,
    support: round(support, 3),
    resistance: round(resistance, 3),
    base_days: 5,
    summary: above
      ? `放量越过此前10日高点 RM ${round(resistance, 3)}，本次为20日均量的 ${round(volume / average)} 倍。`
      : `最近5个交易日收盘价区间宽度 ${round(closeRange)}%，价格高于5日均价、短期均价回升；成交量达到昨日 ${round(evidence.multiple)} 倍。`,
  };
}

export function recentPotentialSignals(rows, referenceDate, options = {}) {
  const history = rows
    .filter((r) => r.date < referenceDate && r.close > 0 && r.volume > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return history
    .slice(-10)
    .flatMap((bar) => {
      const signal = potentialSignal(rows, bar.close, bar.volume, bar.date, options);
      return signal
        ? [{ ...signal, age: history.filter((r) => r.date > bar.date).length + 1 }]
        : [];
    })
    .reverse();
}

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
      high: rows.at(-1).high,
      low: rows.at(-1).low,
    };
  const metrics = quoteDate ? trendMetrics(rows, stock.price, stock.volume, quoteDate) : null;
  const options = {
    min_gain: cfg.screen_min_gain,
    max_gain: cfg.screen_max_gain,
    vol_mult: cfg.screen_vol_mult,
    min_volume: cfg.screen_min_volume,
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
  const previousBar = rows.filter((r) => r.date < quoteDate).at(-1);
  const volumeEvidence = volumeSignal(stock.volume, previousBar?.volume, {
    minVolume: cfg.screen_min_volume,
    minMultiple: cfg.screen_vol_mult,
  });
  const volumePass = volumeEvidence.pass;
  const previousClose = stock.prevClose > 0 ? stock.prevClose : previousBar?.close;
  const priceSupport = !!metrics?.above_ma5 && previousClose > 0 && stock.price > previousClose;
  const setup = consolidationSetup(rows, stock.price, stock.volume, quoteDate, {
    minVolume: cfg.screen_min_volume,
    minMultiple: cfg.screen_vol_mult,
  });
  const signalOptions = {
    minVolume: cfg.screen_min_volume,
    minMultiple: cfg.screen_vol_mult,
    minAverageValue: cfg.min_average_daily_value,
  };
  const signalRows =
    stock.high > 0 && stock.low > 0
      ? [
          ...rows.filter((r) => r.date !== quoteDate),
          {
            date: quoteDate,
            high: stock.high,
            low: stock.low,
            close: stock.price,
            volume: stock.volume,
          },
        ]
      : rows;
  const currentSignal = potentialSignal(
    signalRows,
    stock.price,
    stock.volume,
    quoteDate,
    signalOptions,
  );
  const recentSignals = recentPotentialSignals(rows, quoteDate, signalOptions);
  const latestSignal = recentSignals[0];
  // A broken newer signal cannot revive an older signal with a lower support.
  const trackingSignal = currentSignal
    ? { ...currentSignal, age: 0 }
    : latestSignal?.age <= 5 && stock.price >= latestSignal.support
      ? latestSignal
      : null;
  volumeEvidence.previous_date = previousBar?.date || null;
  volumeEvidence.current_date = quoteDate;
  volumeEvidence.current_label = unfinishedDay
    ? '今日累计成交量'
    : historicalSnapshot
      ? '本日收盘成交量'
      : '本次成交量';
  volumeEvidence.unfinished = unfinishedDay;
  volumeEvidence.price_support = priceSupport;
  volumeEvidence.interpretation = volumePass
    ? priceSupport
      ? '成交量明显放大，股价也高于昨收和5日均价，量价共同支持转强信号。接下来关注价格能否守住参考位。'
      : '成交量明显放大，但价格尚未同步转强。放量也可能来自卖出，暂不列入优先参与名单。'
    : '两个放量门槛尚未同时满足，暂不列入精选。';
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
      label: '百万股与两倍放量是否同时达标',
      pass: volumePass,
      available: volumeEvidence.multiple != null,
      detail:
        volumeEvidence.multiple != null
          ? `${volumeEvidence.summary}要求至少 ${shares(volumeEvidence.minimum_volume)}，且至少昨日 ${volumeEvidence.minimum_multiple} 倍；${volumePass ? '两项均达标' : '尚未同时达标'}。${unfinishedDay ? '今日尚未收盘，累计成交量还会增加。' : ''}`
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
  checks.push({
    key: 'setup',
    label: '是否符合蓄势、转强或突破路径',
    pass: !!currentSignal?.eligible,
    available: setup.available,
    detail: currentSignal
      ? currentSignal.summary +
        (currentSignal.eligible
          ? ' 当前价格仍在参与条件内。'
          : ' 价格已明显拉升，保留信号但不列入当前精选。')
      : setup.summary + ' 转强与突破路径也尚未同时满足价格、均价和量能条件。',
  });
  let stage = 'watch',
    label = '等待确认',
    conclusion = metrics
      ? `近20个交易日价格变化 ${round(metrics.gain20)}%，${trendPass ? '趋势已转强' : '趋势还不够稳定'}；${volumePass ? '成交量达到筛选门槛' : '成交量暂未达到筛选门槛'}。当前依据不够一致，先等新的确认。`
      : '资料尚未完整，暂时无法形成参与判断。';
  if (!metrics) {
    stage = 'insufficient';
    label = '资料待补齐';
    conclusion = '历史资料不足，暂时无法形成完整的技术分析。';
  } else if (volumePass && priceSupport) {
    stage = 'confirmed';
    label = '可重点考虑';
    conclusion = `${volumeEvidence.summary}百万股与两倍放量门槛均已达标，股价同时高于昨收和5日均价。${patternPass ? `日线双底突破也得到量能支持，现价仍守住 RM ${round(pattern.neck, 3)} 的突破位。` : trendPass ? '短期均线排列也保持向上，量价支持转强信号。' : '价格开始转强，完整均线排列仍需继续确认。'}可重点考虑参考位附近的机会。`;
  }
  if (metrics && !volumePass) {
    stage = 'watch';
    label = '等待放量';
    conclusion = `${volumeEvidence.summary}${volumeEvidence.title}，${volumeEvidence.shortfall != null ? `还需增加至少 ${shares(volumeEvidence.shortfall)} 才能同时过线。` : ''}即使形态出现积极信号，成交量未达标也暂不入选。`;
  } else if (metrics && !priceSupport) {
    stage = 'watch';
    label = '等待量价配合';
    conclusion = `${volumeEvidence.summary}成交量已达标，但价格尚未同时高于昨收和5日均价。当前无法确认放量推动上涨，先等价格转强。`;
  }
  if (metrics && volumePass && setup.qualified && currentSignal) {
    stage = setup.early_breakout ? 'confirmed' : 'coiled';
    label = setup.early_breakout ? '蓄势后初步突破' : '放量蓄势 · 尚未突破';
    conclusion = setup.early_breakout
      ? `成交量过线，价格刚越过整理上沿 RM ${setup.resistance}，优先核对能否守住；跌破 RM ${setup.support} 时蓄势依据失效。`
      : `量已放大，股价较昨收仅变化 ${setup.current_change_pct}%，仍在整理区间。优先关注放量突破 RM ${setup.resistance}；跌破 RM ${setup.support} 时蓄势依据失效。尚未突破不代表随后一定上涨。`;
    volumeEvidence.interpretation = setup.early_breakout
      ? '前期量增价稳，本次放量伴随初步突破；继续核对收盘是否守住整理上沿。'
      : '成交量先放大，价格还没有大幅拉升，符合放量蓄势观察条件；突破整理上沿才是下一步确认。';
  }
  if (setup.extended) {
    stage = 'extended';
    label = '已经拉升 · 等待回踩';
    conclusion = `${setup.summary}股价较前一交易日变化 ${setup.current_change_pct}%，已离开早期蓄势条件，不列入提前布局精选；关注回踩 RM ${setup.resistance} 后是否站稳。`;
    volumeEvidence.interpretation =
      '成交量伴随价格明显拉升，早期蓄势阶段已结束；当前不作为尚未大涨的精选。';
  }
  if (extended && !setup.qualified && !setup.extended) {
    stage = 'extended';
    label = '等待回踩';
    conclusion = `突破结构仍需跟踪，但现价 RM ${round(stock.price, 3)} 已超过 RM ${round(pattern.neck * 1.03, 3)} 的形态参考区间上限。当前更适合等待回踩后重新确认，直接追价的风险空间更大。`;
  }
  if (currentSignal && !setup.qualified) {
    if (currentSignal.eligible) {
      stage = currentSignal.kind === 'building' ? 'building' : 'confirmed';
      label = currentSignal.kind === 'building' ? '放量转强 · 接近突破' : '放量突破 · 继续确认';
      conclusion = `${currentSignal.summary}${currentSignal.kind === 'building' ? `价格正在转强，关注能否突破 RM ${currentSignal.resistance}。` : `价格已越过 RM ${currentSignal.resistance}，关注能否守住。`}跌破 RM ${currentSignal.support} 时依据失效。`;
      volumeEvidence.interpretation =
        '百万股与两倍量均达标，价格和短期均价开始转强；此路径不要求此前10日完全横盘。';
    } else {
      stage = 'extended';
      label = '突破后拉升 · 持续追踪';
      conclusion = `${currentSignal.summary}股价本次变化 ${currentSignal.change_pct}%，已经明显拉升；保留突破信号，等待回踩 RM ${currentSignal.resistance}，不列入提前布局精选。`;
      volumeEvidence.interpretation = '放量突破已出现，但价格已明显拉升；继续追踪，等回踩条件。';
    }
  }
  if (stage === 'confirmed' && !currentSignal) {
    stage = 'watch';
    label = '量价转强 · 等待结构确认';
    conclusion =
      volumeEvidence.summary +
      '量价有转强迹象，但尚未通过蓄势、转强或突破路径的全部条件，暂不列入当前精选。';
  }
  if (trackingSignal && !currentSignal && !['coiled', 'building', 'confirmed'].includes(stage)) {
    stage = 'tracking';
    label =
      stock.price > trackingSignal.resistance * 1.03
        ? '突破后拉升 · 持续追踪'
        : '已有放量信号 · 持续追踪';
    conclusion = `${trackingSignal.date} 曾成交 ${shares(trackingSignal.volume)}，达到前一交易日 ${round(trackingSignal.multiple)} 倍，出现${trackingSignal.kind === 'coiled' ? '蓄势' : trackingSignal.kind === 'building' ? '转强' : '突破'}信号。${volumePass ? '本次成交量也已达标。' : '今天量倍数尚未达标，保留历史信号但不列入当前精选。'}关注 RM ${trackingSignal.resistance}；跌破 RM ${trackingSignal.support} 时原依据失效。`;
  }
  if (metrics && (!historyRecent || !usableSnapshot)) {
    stage = 'stale';
    label = '等待数据更新';
    conclusion = '当前资料尚不能代表最新交易情况；等行情与日线更新后再判断参与条件。';
  }
  const risks = ['技术信号只描述价格与成交量，没有评估公司财报、估值和最新公告。'];
  if (
    metrics &&
    volumePass &&
    !['stale', 'insufficient', 'extended', 'tracking'].includes(stage) &&
    !liquid
  ) {
    stage = 'watch';
    label = '等待有效成交';
    conclusion = `价格形态或趋势有积极信号，但最近20个交易日平均成交额估算约 RM ${round(averageDailyValue, 0)}，或本次尚无有效成交。成交活跃度没有通过精选条件，暂不列入优先参与名单。`;
  }
  if (unfinishedDay) risks.push('盘中价格、成交量和均线还会变化，收盘后可能不再满足条件。');
  if (extended && !setup.qualified && !setup.extended && !currentSignal)
    risks.push('现价已高于形态参考区间，不宜把过去的突破位置当作当前价格。');
  if (pattern && !setup.qualified && !setup.extended && !currentSignal)
    risks.push(
      `若价格跌回压力位 ${round(pattern.neck, 3)} 下方，突破依据会减弱；${round(pattern.stop, 3)} 是形态失效参考位。`,
    );
  if (!historyRecent) risks.push('日线资料较旧，需要补齐历史数据后重新分析。');
  const reasons = checks.filter((c) => c.pass).map((c) => c.detail);
  const signalPlan = currentSignal || trackingSignal;
  const setupPlan = setup.qualified || setup.extended || !!signalPlan;
  const referenceSupport = signalPlan?.support ?? setup.support;
  const referenceResistance = signalPlan?.resistance ?? setup.resistance;
  const entryPlan = setupPlan
    ? `参考支撑 RM ${referenceSupport}，突破关注 RM ${referenceResistance}；${['coiled', 'building'].includes(stage) ? `当前尚未突破，优先等放量越过参考位并守住后再评估参与。` : `核对突破参考位能否成为支撑，已明显拉升时等待回踩。`}`
    : levels
      ? stage === 'confirmed'
        ? `现价位于 RM ${levels.zone_low}–${levels.zone_high} 参考区间内，可在守住突破位的前提下考虑参与；超过区间上限后重新评估。`
        : `优先观察 RM ${levels.zone_low}–${levels.zone_high}，回到区间后仍需守住突破位。`
      : metrics
        ? `先看价格能否在近5日平均价 RM ${round(metrics.ma5, 3)} 附近获得支撑，再核对成交量是否继续配合。`
        : '等待补齐资料，暂不提供参考价位。';
  const invalidationPlan = setupPlan
    ? `跌破参考支撑 RM ${referenceSupport} 时，原有量价信号失效；跌破后即使放量也不作为原信号的参与机会。`
    : levels
      ? `跌回 RM ${levels.neck} 下方时原有突破依据减弱；RM ${levels.invalidation} 是形态失效参考位。`
      : metrics
        ? `若价格跌回近5日平均价 RM ${round(metrics.ma5, 3)} 下方，或均线排列转弱，需要重新评估当前趋势判断。`
        : '资料不足，暂时无法判断失效条件。';
  return {
    code: stock.code || stock.stock,
    name: stock.name,
    price: stock.price,
    change_pct: previousClose > 0 ? round((stock.price / previousClose - 1) * 100) : null,
    stage,
    label,
    conclusion,
    checks,
    reasons,
    risks,
    levels: setupPlan ? null : levels,
    entry_plan: entryPlan,
    invalidation_plan: invalidationPlan,
    monitor_plan: ['coiled', 'building', 'tracking'].includes(stage)
      ? `关注 RM ${referenceResistance} 是否突破或站稳，同时守住 RM ${referenceSupport} 的参考支撑。`
      : stage === 'confirmed'
        ? '下一步看能否继续守住参考位；盘中信号要再核对收盘后的结果。'
        : stage === 'extended'
          ? '等待回踩时价格守住原突破位，再检查成交量与最新公告。'
          : '等待趋势与成交量进一步配合，或出现新的有效突破。',
    evidence_count: checks.filter((c) => c.pass).length,
    screen_pass: screen,
    pattern_pass: patternPass,
    average_daily_value: round(averageDailyValue, 0),
    volume: stock.volume,
    volume_signal: volumeEvidence,
    volume_setup: setup,
    potential_signal: currentSignal,
    recent_signals: recentSignals,
    tracking_signal: trackingSignal,
    potential_eligible:
      ['coiled', 'building', 'confirmed'].includes(stage) &&
      !!currentSignal?.eligible &&
      volumePass &&
      liquid &&
      usableSnapshot &&
      historyRecent,
    priority_score: currentSignal?.eligible
      ? round(
          Math.min(currentSignal.average_multiple, 5) * 10 +
            Math.min(currentSignal.multiple, 5) * 4 +
            Math.min(setup.events.length, 3) * 3 +
            Math.max(0, 10 - Math.max(0, (currentSignal.resistance / stock.price - 1) * 100)) *
              1.5 +
            (metrics?.ma5 >= metrics?.ma10 ? 8 : 0) +
            (stage === 'confirmed' ? 5 : stage === 'building' ? 3 : 0),
        )
      : 0,
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
    next_step: ['coiled', 'building', 'tracking'].includes(stage)
      ? entryPlan
      : stage === 'confirmed'
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
    '成交量：' + (report.volume_signal?.summary || '资料待补齐'),
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
