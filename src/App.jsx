import React, { useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';

const number = (v, d = 2) =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-MY', { maximumFractionDigits: d });
const price = (v) => (v == null ? '—' : `RM ${number(v, 3)}`);
const volume = (v) =>
  v == null
    ? '—'
    : v >= 1e8
      ? `${number(v / 1e8)} 亿股`
      : v >= 1e4
        ? `${number(v / 1e4)} 万股`
        : `${number(v, 0)} 股`;
const percent = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${number(v)}%`);
const time = (v) =>
  v
    ? new Date(v * 1000).toLocaleString('zh-CN', {
        timeZone: 'Asia/Kuala_Lumpur',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '等待首次更新';
const change = (s) => (s.prevClose > 0 ? (s.price / s.prevClose - 1) * 100 : null);
const navItems = [
  ['overview', 'grid', '机会解读'],
  ['market', 'chart', '全市场'],
  ['watch', 'star', '我的关注'],
  ['alerts', 'bell', '异动提醒'],
];

function Icon({ name, size = 20 }) {
  const paths = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    chart: <path d="M3 3v18h18M7 15l4-5 4 3 6-8" />,
    star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L3.2 9.7l6.4-.9Z" />,
    bell: <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" />,
    book: <path d="M12 5v16M12 5C8 2 3 3 3 3v15s5-1 9 3c4-4 9-3 9-3V3s-5-1-9 2Z" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2 4h4l2-4 3-2-1-3 2-2-2-3-3-1-1-3Z" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.chart}
    </svg>
  );
}

async function request(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || '请求未完成，请稍后再试。');
  return json;
}
function initialFavorites() {
  try {
    const v = JSON.parse(localStorage.getItem('klse-favorites') || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [state, setState] = useState(null),
    [error, setError] = useState(''),
    [connected, setConnected] = useState(false);
  const [page, setPage] = useState('overview'),
    [filter, setFilter] = useState('all'),
    [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(initialFavorites),
    [selected, setSelected] = useState(null),
    [admin, setAdmin] = useState(false),
    [notice, setNotice] = useState('');
  const lastAlert = useRef(null);
  const fetchState = () =>
    request('/api/state')
      .then((next) => {
        setState(next);
        setError('');
      })
      .catch(() => setError('暂时无法取得行情。请检查连接，或稍后重试。'));
  useEffect(() => {
    let active = true;
    const accept = (next) => {
      if (!active) return;
      setState(next);
      setError('');
      const latest = next.alerts?.[0];
      if (
        latest &&
        lastAlert.current != null &&
        latest.id > lastAlert.current &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      )
        new Notification(`${latest.name} · 新异动`, { body: latest.message });
      if (latest) lastAlert.current = latest.id;
      else if (lastAlert.current === null) lastAlert.current = 0;
    };
    request('/api/state')
      .then(accept)
      .catch(() => {
        if (active) setError('暂时无法取得行情，请重试。');
      });
    const events = new EventSource('/api/events');
    events.onopen = () => {
      if (active) setConnected(true);
    };
    events.onmessage = (e) => {
      try {
        accept(JSON.parse(e.data));
      } catch {
        if (active) setError('数据格式异常，正在等待下次更新。');
      }
    };
    events.onerror = () => {
      if (active) setConnected(false);
    };
    const timer = setInterval(() => {
      if (active)
        request('/api/state')
          .then(accept)
          .catch(() => {});
    }, 60000);
    return () => {
      active = false;
      events.close();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('klse-favorites', JSON.stringify(favorites));
    } catch {
      setNotice('浏览器未允许保存关注，刷新后可能丢失。');
    }
  }, [favorites]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(id);
  }, [notice]);
  const toggle = (code) =>
    setFavorites((prev) =>
      prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code],
    );
  const notify = async () => {
    if (typeof Notification === 'undefined') return setNotice('此浏览器不支持桌面通知。');
    if (!window.isSecureContext) return setNotice('桌面通知需要 HTTPS；页面内仍会显示异动。');
    const permission = await Notification.requestPermission();
    setNotice(
      permission === 'granted'
        ? '已开启新异动通知，保持页面打开即可接收。'
        : '未开启桌面通知，仍可在异动提醒页查看。',
    );
  };
  const insights = state?.insights,
    stocks = state?.stocks || [];
  const candidates = (insights?.candidates || []).filter(
    (r) => filter === 'all' || r.stage === filter,
  );
  const watched = stocks.filter((s) => favorites.includes(s.code));
  const stale =
    state?.status.last_poll &&
    state.status.now - state.status.last_poll >
      Math.max(15, state.settings.poll_interval_minutes * 3) * 60;
  const navigate = (next) => {
    setPage(next);
    setQuery('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const titles = {
    overview: '成交量明显放大，优先看这几只。',
    market: '从全市场找到你的关注。',
    watch: '关注之后，继续核对。',
    alerts: '市场有变化，依据要更新。',
    method: '每个信号，都有它的边界。',
  };
  const subtitles = {
    overview: '扫描全市场，精选百万股以上、至少昨日两倍成交量，并有价格转强支持的少数股票。',
    market: '搜索公司或代码，点开股票查看分析依据。',
    watch: '你的关注保存在当前浏览器；系统观察记录用于跟踪规则表现。',
    alerts: '异动是研究的起点。价格变化本身不等于买入理由。',
    method: '先理解证据，再判断是否适合你。',
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <span className="brand-mark">
            <Icon name="chart" size={25} />
          </span>
          <span>
            KLSE<span className="brand-sub">机会观察</span>
          </span>
        </a>
        <div className="nav-caption">研究工作台</div>
        <nav aria-label="主要导航">
          {navItems.map(([id, icon, label]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => navigate(id)}
            >
              <Icon name={icon} />
              {label}
              {id === 'watch' && favorites.length > 0 && (
                <span className="nav-count">{favorites.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <Icon name="shield" />
          <p>
            判断来自具体的数据<span>分析结论与参与条件，一起呈现。</span>
          </p>
          <button className="admin-link" onClick={() => setAdmin(true)}>
            <Icon name="settings" size={16} /> 管理设置
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            马来西亚股票 <span>/</span> {navItems.find(([id]) => id === page)?.[2]}
          </div>
          <div className="topbar-tools">
            <span className="connection">
              <i className={connected ? 'online' : ''} />
              {connected ? '自动更新已连接' : '正在重新连接'}
            </span>
            <button
              className="icon-button mobile-admin"
              aria-label="管理设置"
              onClick={() => setAdmin(true)}
            >
              <Icon name="settings" />
            </button>
            <button
              className="icon-button"
              aria-label="开启桌面通知"
              title="开启桌面通知"
              onClick={notify}
            >
              <Icon name="bell" />
            </button>
          </div>
        </header>
        <div className="content">
          {error && (
            <div className="banner error" role="alert">
              {error}
              <button onClick={fetchState}>重试</button>
            </div>
          )}
          {(state?.status.error || stale) && (
            <div className="banner warning">
              {state.status.error || '行情快照较旧，交易前请核对最新报价。'}
              <span>最近抓取 {time(state.status.last_poll)}</span>
            </div>
          )}
          {!state && !error ? (
            <div className="loading-state">
              <span className="spinner" />
              <h2>正在整理市场资料</h2>
              <p>为你准备趋势、成交量与形态依据。</p>
            </div>
          ) : (
            state && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">BURSA MALAYSIA · MYT</div>
                    <h1>{titles[page]}</h1>
                    <p>{subtitles[page]}</p>
                  </div>
                  <span className="session-badge">
                    <i className={state.status.market_open ? 'online' : ''} />
                    {state.status.market_open ? '常规交易时段' : '常规休市时段'}
                  </span>
                </div>
                <div className="data-caption">
                  行情快照 {time(state.status.last_poll)} <span>·</span> 免费行情可能延迟{' '}
                  <span>·</span> {state.status.backfilling ? '正在补齐日线资料' : '分析随数据更新'}{' '}
                  <span>·</span> 节假日以交易所安排为准
                </div>
                {page === 'overview' && (
                  <>
                    <section className="stats-grid" aria-label="市场概况">
                      <Stat
                        label="市场覆盖"
                        value={number(state.universe_count, 0)}
                        unit="只股票"
                        note="当前已取得的股票池"
                      />
                      <Stat
                        label="明显放量"
                        value={number(insights?.volume_qualified || 0, 0)}
                        unit="只"
                        note="百万股以上，且至少昨日两倍"
                      />
                      <Stat
                        label="可重点考虑"
                        value={number(insights?.confirmed || 0, 0)}
                        unit="只"
                        note="全市场符合条件的候选"
                        accent
                      />
                      <Stat
                        label="我的关注"
                        value={favorites.length}
                        unit="只"
                        note="保存在当前浏览器"
                      />
                    </section>
                    <section className="opportunities">
                      <div className="section-heading">
                        <div>
                          <h2>放量潜力精选</h2>
                          <p>{`按放量倍数优先排序，最多 ${insights?.limit || 3} 只。量价不配合的股票不入选，入选不足不凑数。`}</p>
                        </div>
                        <div className="tabs" aria-label="候选筛选">
                          {[['all', '优先考虑']].map(([id, label]) => (
                            <button
                              key={id}
                              className={filter === id ? 'selected' : ''}
                              onClick={() => setFilter(id)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="volume-criteria" aria-label="成交量入选条件">
                        <span>每只精选必须同时满足</span>
                        <strong>
                          本次成交量 ≥ {volume(state.settings.screen_min_volume ?? 1000000)}
                        </strong>
                        <strong>
                          至少上一交易日全天的 {number(state.settings.screen_vol_mult ?? 2)} 倍
                        </strong>
                        <span>成交量以股数计；盘中使用累计成交量</span>
                      </div>
                      {candidates.length ? (
                        <div className="card-grid">
                          {candidates.map((r) => (
                            <Opportunity
                              key={r.code}
                              report={r}
                              favorite={favorites.includes(r.code)}
                              toggle={() => toggle(r.code)}
                              open={() => setSelected(r.code)}
                            />
                          ))}
                        </div>
                      ) : (
                        <Empty
                          title="暂时没有符合当前筛选的候选"
                          text={
                            state.status.backfilling
                              ? '正在补齐历史资料，完成后会自动重新分析。'
                              : '尚无股票同时满足百万股、两倍放量及价格转强条件。继续扫描，不用较弱信号凑数。'
                          }
                          action={() => navigate('market')}
                          actionLabel="查看全市场"
                        />
                      )}
                    </section>
                    <div className="bottom-grid">
                      <section className="panel">
                        <div className="section-heading">
                          <h2>最近异动</h2>
                          <button className="text-button" onClick={() => navigate('alerts')}>
                            查看全部 <Icon name="arrow" size={16} />
                          </button>
                        </div>
                        <Alerts alerts={state.alerts.slice(0, 3)} open={setSelected} />
                      </section>
                      <section className="guide-card">
                        <span className="guide-icon">
                          <Icon name="chart" size={26} />
                        </span>
                        <h2>你的关注，持续更新分析</h2>
                        <p>
                          保存有兴趣的股票，随时查看当前判断是否仍成立、价格是否接近参与参考位。
                        </p>
                        <button className="text-button" onClick={() => navigate('watch')}>
                          查看我的关注 <Icon name="arrow" size={16} />
                        </button>
                      </section>
                    </div>
                  </>
                )}
                {page === 'market' && (
                  <MarketTable
                    stocks={stocks}
                    query={query}
                    setQuery={setQuery}
                    favorites={favorites}
                    toggle={toggle}
                    open={setSelected}
                    window={state.settings.window}
                  />
                )}
                {page === 'watch' && (
                  <>
                    <MarketTable
                      stocks={watched}
                      query={query}
                      setQuery={setQuery}
                      favorites={favorites}
                      toggle={toggle}
                      open={setSelected}
                      window={state.settings.window}
                      empty="还没有关注的股票"
                    />
                    <Observations observations={state.observations} open={setSelected} />
                  </>
                )}
                {page === 'alerts' && (
                  <section className="panel">
                    <div className="section-heading">
                      <h2>近期异动记录</h2>
                      <span className="muted">最多展示最近50条</span>
                    </div>
                    <Alerts alerts={state.alerts} open={setSelected} />
                  </section>
                )}
                {page === 'method' && <Method />}
                <footer className="footer">
                  <span>
                    KLSE 机会观察 <span className="version">{state.version}</span>
                  </span>
                  <button className="text-button" onClick={() => navigate('method')}>
                    分析口径与资料来源
                  </button>
                </footer>
              </>
            )
          )}
        </div>
      </main>
      {selected && (
        <StockDetail
          code={selected}
          close={() => setSelected(null)}
          favorite={favorites.includes(selected)}
          toggle={() => toggle(selected)}
        />
      )}{' '}
      {admin && <AdminSettings state={state} close={() => setAdmin(false)} updated={fetchState} />}{' '}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, unit, note, accent }) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <span>{label}</span>
      <div className="stat-value">
        {value}
        <small>{unit}</small>
      </div>
      <p>{note}</p>
    </div>
  );
}
function Empty({ title, text, action, actionLabel }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="search" size={28} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button className="secondary-button" onClick={action}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
function Status({ report }) {
  return <span className={`status-pill ${report.stage}`}>{report.label}</span>;
}
function Opportunity({ report: r, favorite, toggle, open }) {
  return (
    <article className="opportunity-card">
      <div className="card-top">
        <span className="ticker">{r.code}</span>
        <button
          className={'icon-button favorite ' + (favorite ? 'saved' : '')}
          aria-label={(favorite ? '取消关注' : '关注') + ' ' + r.code}
          aria-pressed={favorite}
          onClick={toggle}
        >
          <Icon name="star" size={18} />
        </button>
      </div>
      <div className="stock-heading">
        <h3>{r.name}</h3>
        <Status report={r} />
      </div>
      <div className="card-price">
        {price(r.price)}
        <span className={r.change_pct >= 0 ? 'up' : 'down'}>
          {percent(r.change_pct)} <small>较昨收</small>
        </span>
      </div>
      <VolumePanel report={r} compact />
      <p className="conclusion">{r.conclusion}</p>
      <div className="entry-summary">
        <span>参与参考</span>
        <strong>
          {r.levels
            ? price(r.levels.zone_low) + '–' + number(r.levels.zone_high, 3)
            : r.metrics
              ? '关注 ' + price(r.metrics.ma5) + ' 附近的支撑'
              : '等待资料更新'}
        </strong>
      </div>
      <div className="evidence-chips">
        {r.checks
          .filter((c) => c.pass)
          .map((c) => (
            <span key={c.key}>
              <Icon name="check" size={12} />
              {c.key === 'trend' ? '趋势支持' : c.key === 'volume' ? '量能支持' : '突破支持'}
            </span>
          ))}
      </div>
      <div className="card-bottom">
        <span>
          {r.snapshot ? '收盘快照 · ' : '行情日期 · '}
          {r.quote_date || '资料待补齐'}
        </span>
        <button className="text-button" onClick={open}>
          完整分析 <Icon name="arrow" size={16} />
        </button>
      </div>
    </article>
  );
}

function VolumePanel({ report, compact = false }) {
  const signal = report.volume_signal;
  if (!signal) return <div className="volume-panel">正在等待成交量对比资料。</div>;
  const barMaximum = Math.max(signal.current || 0, signal.previous || 0, 1);
  const bars = [
    [signal.current_label, signal.current, 'current'],
    ['上一交易日全天', signal.previous, 'previous'],
  ];
  return (
    <section className={`volume-panel ${compact ? 'compact' : ''}`} aria-label="成交量解读">
      <div className="volume-panel-heading">
        <h3>成交量重点</h3>
        <span className={signal.pass ? 'volume-pass' : 'volume-wait'}>
          {signal.pass ? '放量已达标' : '放量待确认'}
        </span>
      </div>
      <div className="volume-numbers">
        <div>
          <span>{signal.current_label}</span>
          <strong>{volume(signal.current)}</strong>
          <small>{signal.current_date || '资料待补齐'}</small>
        </div>
        <div>
          <span>上一交易日全天</span>
          <strong>{volume(signal.previous)}</strong>
          <small>{signal.previous_date || '资料待补齐'}</small>
        </div>
        <div className="volume-multiple">
          <span>达到昨日的</span>
          <strong>
            {signal.multiple == null ? '—' : number(signal.multiple, 4)}
            <small>倍</small>
          </strong>
          <small>
            {signal.increase_pct == null
              ? '无法比较'
              : `较昨日${signal.increase_pct >= 0 ? '增加' : '减少'} ${number(Math.abs(signal.increase_pct))}%`}
          </small>
        </div>
      </div>
      {!compact && (
        <div className="volume-comparison" aria-label="本次与昨日成交量对比">
          {bars.map(([label, value, type]) => (
            <div className="volume-bar-row" key={type}>
              <span>{label}</span>
              <div className="volume-bar-track">
                <i className={type} style={{ width: `${((value || 0) / barMaximum) * 100}%` }} />
              </div>
              <strong>{value == null ? '—' : `${number(value, 0)} 股`}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="volume-gates">
        <span className={signal.amount_pass ? 'passed' : ''}>
          {signal.amount_pass ? '✓' : '○'} 至少 {volume(signal.minimum_volume)}
        </span>
        <span className={signal.multiple_pass ? 'passed' : ''}>
          {signal.multiple_pass ? '✓' : '○'} 至少昨日 {number(signal.minimum_multiple)} 倍
        </span>
      </div>
      <p className="volume-reading">{signal.interpretation}</p>
      {signal.shortfall > 0 && (
        <p className="volume-shortfall">
          距两个门槛同时达标，还差至少 {volume(signal.shortfall)}。
        </p>
      )}
      <p className="volume-timing">
        {signal.unfinished
          ? '盘中累计量，对比上一交易日全天；今日尚未收盘。'
          : `按 ${signal.current_date || '所示日期'} 成交量对比；不代表当前盘中成交。`}
      </p>
    </section>
  );
}

function MarketTable({
  stocks,
  query,
  setQuery,
  favorites,
  toggle,
  open,
  window,
  empty = '没有找到匹配的股票',
}) {
  const [sort, setSort] = useState('volume'),
    [page, setPage] = useState(0);
  const filtered = useMemo(
    () =>
      stocks
        .filter((s) => `${s.code} ${s.name}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) =>
          sort === 'volume'
            ? (b.volume || 0) - (a.volume || 0)
            : sort === 'change'
              ? (change(b) ?? -Infinity) - (change(a) ?? -Infinity)
              : (b.ratio ?? -Infinity) - (a.ratio ?? -Infinity),
        ),
    [stocks, query, sort],
  );
  useEffect(() => setPage(0), [query, sort, stocks.length]);
  const pages = Math.max(1, Math.ceil(filtered.length / 30)),
    p = Math.min(page, pages - 1);
  return (
    <section className="panel market-panel">
      <div className="market-toolbar">
        <label className="search">
          <Icon name="search" size={18} />
          <input
            aria-label="搜索股票"
            placeholder="搜索股票代码或公司名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="sort-label">
          排序
          <select aria-label="股票排序" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="volume">今日成交量</option>
            <option value="change">相对昨收涨幅</option>
            <option value="ratio">时段成交量倍数</option>
          </select>
        </label>
      </div>
      {filtered.length ? (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>股票 / 公司</th>
                  <th>现价</th>
                  <th>较昨收</th>
                  <th>成交量</th>
                  <th>时段量 / 前时段</th>
                  <th>数据日期</th>
                  <th>
                    <span className="sr-only">关注</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(p * 30, (p + 1) * 30).map((s) => (
                  <tr key={s.code}>
                    <td>
                      <button className="stock-link" onClick={() => open(s.code)}>
                        <strong>{s.code}</strong>
                        <span>{s.name}</span>
                      </button>
                    </td>
                    <td>{price(s.price)}</td>
                    <td className={change(s) >= 0 ? 'up' : 'down'}>{percent(change(s))}</td>
                    <td>{volume(s.volume)}</td>
                    <td>{s.ratio != null ? `${number(s.ratio / 100)}x` : '资料不足'}</td>
                    <td className="muted">{s.session_date || '待核对'}</td>
                    <td>
                      <button
                        className={`icon-button favorite ${favorites.includes(s.code) ? 'saved' : ''}`}
                        aria-label={`${favorites.includes(s.code) ? '取消关注' : '关注'} ${s.code}`}
                        aria-pressed={favorites.includes(s.code)}
                        onClick={() => toggle(s.code)}
                      >
                        <Icon name="star" size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span>
              共 {filtered.length} 只 · 对比时段 {window} · 盘中量未收盘定稿
            </span>
            <div className="pagination">
              <button disabled={p === 0} onClick={() => setPage(p - 1)}>
                上一页
              </button>
              <span>
                {p + 1} / {pages}
              </span>
              <button disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>
                下一页
              </button>
            </div>
          </div>
        </>
      ) : (
        <Empty title={empty} text="在机会卡片或全市场列表中点击星标，就能保存关注。" />
      )}
    </section>
  );
}
function Alerts({ alerts, open }) {
  return alerts.length ? (
    <div className="alert-list">
      {alerts.map((a) => (
        <button className="alert-row" key={a.id} onClick={() => open(a.stock)}>
          <span className={`alert-icon ${a.kind === 'drop' ? 'negative' : ''}`}>
            <Icon
              name={a.kind === 'volume' ? 'chart' : a.kind === 'pattern' ? 'grid' : 'bell'}
              size={18}
            />
          </span>
          <span className="alert-copy">
            <strong>
              {a.name} <small>{a.stock}</small>
            </strong>
            <span>{a.message || `时段成交量比率 ${number(a.ratio)}%`}</span>
          </span>
          <time>{time(a.ts)}</time>
          <Icon name="arrow" size={16} />
        </button>
      ))}
    </div>
  ) : (
    <Empty title="还没有新的异动记录" text="出现符合规则的新信号时，这里会自动更新。" />
  );
}
function Observations({ observations: o, open }) {
  const labels = { observing: '跟踪中', win: '涨幅达标', loss: '跌幅触发', expired: '到期' };
  return (
    <section className="panel observations">
      <div className="section-heading">
        <div>
          <h2>系统观察记录</h2>
          <p>系统曾经入选的标的，按预设涨跌幅与交易日数跟踪。</p>
        </div>
      </div>
      <div className="observation-tally">
        {Object.entries(labels).map(([id, label]) => (
          <span key={id}>
            {label}
            <strong>{o?.tally.find((i) => i.outcome === id)?.c || 0}</strong>
          </span>
        ))}
      </div>
      {o?.list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>股票</th>
                <th>观察起始价</th>
                <th>当前变化</th>
                <th>交易日</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {o.list.slice(0, 100).map((w) => (
                <tr key={w.stock}>
                  <td>
                    <button className="stock-link" onClick={() => open(w.stock)}>
                      <strong>{w.stock}</strong>
                      <span>{w.name}</span>
                    </button>
                  </td>
                  <td>{price(w.entry_price)}</td>
                  <td className={w.pct >= 0 ? 'up' : 'down'}>{percent(w.pct)}</td>
                  <td>{w.days}</td>
                  <td>{labels[w.outcome] || w.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">系统还没有记录新的观察标的。资料和信号达标后会自动入选。</p>
      )}
      <p className="data-note">
        {o?.note} 当前变化按最新快照计算，归档后的变化也不代表当时结束的收益。
      </p>
    </section>
  );
}

function Modal({ title, close, children, wide = false }) {
  const panel = useRef(null),
    headingId = React.useId(),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector('button')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key !== 'Tab') return;
      const elements = [
          ...panel.current.querySelectorAll(
            'button:not(:disabled),input,select,a[href],[tabindex="0"]',
          ),
        ].filter((el) => el.getClientRects().length),
        first = elements[0],
        last = elements.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={panel}
      >
        <header className="modal-header">
          <h2 id={headingId}>{title}</h2>
          <button className="icon-button" aria-label="关闭详情" onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function StockDetail({ code, close, favorite, toggle }) {
  const [report, setReport] = useState(null),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setReport(null);
    setError('');
    const load = () =>
      request(`/api/stocks/${encodeURIComponent(code)}`)
        .then((v) => {
          if (active) {
            setReport(v);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    load();
    const timer = setInterval(load, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [code, attempt]);
  const r = report;
  return (
    <Modal title={`${code} · 股票解读`} close={close} wide>
      {error ? (
        <div className="empty" role="alert">
          <p>{error}</p>
          <button onClick={() => setAttempt((v) => v + 1)}>重试</button>
        </div>
      ) : !r ? (
        <div className="loading-state compact">
          <span className="spinner" />
          正在读取分析依据…
        </div>
      ) : (
        <div className="detail-body">
          <div className="detail-top">
            <div>
              <span className="eyebrow">{r.numeric_code || r.code} · BURSA MALAYSIA</span>
              <h3>{r.name}</h3>
              <div className="detail-price">
                {price(r.price)}
                <span className={r.change_pct >= 0 ? 'up' : 'down'}>{percent(r.change_pct)}</span>
              </div>
            </div>
            <button className={`secondary-button ${favorite ? 'saved' : ''}`} onClick={toggle}>
              <Icon name="star" size={16} />
              {favorite ? '已关注' : '加入关注'}
            </button>
          </div>
          <VolumePanel report={r} />
          <div className={`verdict ${r.stage}`}>
            <Status report={r} />
            {r.snapshot && (
              <span className="snapshot-label">按 {r.quote_date} 最近交易日快照分析</span>
            )}
            <h3>{r.conclusion}</h3>
            <div className="analyst-plan">
              <p>
                <strong>参与参考</strong>
                {r.entry_plan}
              </p>
              <p>
                <strong>接下来关注</strong>
                {r.monitor_plan}
              </p>
            </div>
          </div>
          <PriceChart history={r.history} levels={r.levels} />
          <section className="detail-section">
            <div className="section-heading">
              <h3>支持这个判断的依据</h3>
              <span className="muted">{r.evidence_count}/3 项依据满足 · 非上涨概率</span>
            </div>
            <div className="detail-checks">
              {r.checks.map((c) => (
                <div key={c.key}>
                  <span className={`check-icon ${c.pass ? 'passed' : ''}`}>
                    <Icon name={c.pass ? 'check' : 'search'} size={18} />
                  </span>
                  <div>
                    <h4>
                      {c.label}
                      <span>{c.pass ? '已满足' : c.available ? '待确认' : '资料不足'}</span>
                    </h4>
                    <p>{c.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
          {r.levels && (
            <section className="detail-section">
              <h3>形态的关键价位</h3>
              <div className="levels-grid">
                <div>
                  <span>形态参考区间</span>
                  <strong>
                    {price(r.levels.zone_low)}–{number(r.levels.zone_high, 3)}
                  </strong>
                  <p>从突破位到其上方3%，仅作观察</p>
                </div>
                <div className="risk-level">
                  <span>形态失效参考</span>
                  <strong>{price(r.levels.invalidation)}</strong>
                  <p>跌破后需要重新评估原有依据</p>
                </div>
                <div>
                  <span>形态量度目标</span>
                  <strong>{price(r.levels.target)}</strong>
                  <p>按形态高度推算，可能无法达到</p>
                </div>
              </div>
              <p className="data-note">
                按现价估算：到失效参考位 {number(r.levels.risk_pct)}%，到量度目标{' '}
                {number(r.levels.reward_pct)}%。空间比 {number(r.levels.rr)}
                ，未计费用与滑点。跳空可能越过参考价。
              </p>
              {r.pattern && (
                <p className="data-note">
                  形态匹配度 {r.pattern.score}/100 · 日线突破日期 {r.pattern.date} · 不是预测胜率。
                </p>
              )}
            </section>
          )}
          <section className="risk-box">
            <h3>
              <Icon name="shield" size={18} /> 什么时候放弃原有判断
            </h3>
            <p>{r.invalidation_plan}</p>
            <ul>
              {r.risks.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </section>
          <details className="method-details">
            <summary>查看具体指标与计算口径</summary>
            {r.metrics ? (
              <dl>
                <div>
                  <dt>20个交易日价格变化</dt>
                  <dd>{percent(r.metrics.gain20)}</dd>
                </div>
                <div>
                  <dt>累计量 / 上一交易日全天量</dt>
                  <dd>{number(r.metrics.vr)}x</dd>
                </div>
                {[5, 10, 15, 20].map((n) => (
                  <div key={n}>
                    <dt>近{n}日平均价（含本次现价）</dt>
                    <dd>{price(r.metrics[`ma${n}`])}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p>指标资料不足。</p>
            )}
          </details>
          <div className="detail-source">
            <h4>资料来源与时间</h4>
            <p>
              {r.sources.quotes} · 数据日期 {r.quote_date || '待核对'} · 抓取 {time(r.fetched_at)}
            </p>
            <p>
              {r.sources.history} · 最新日线 {r.history_date || '待补齐'}
            </p>
            <p>{r.sources.timing}</p>
          </div>
        </div>
      )}
    </Modal>
  );
}
function PriceChart({ history, levels }) {
  if (history.length < 2)
    return <div className="chart-empty">历史资料不足，暂时无法绘制价格走势。</div>;
  const rows = history.slice(-60),
    w = 720,
    h = 220,
    p = 24,
    values = rows.map((r) => r.close),
    max = Math.max(...values, levels?.neck || 0) * 1.03,
    min = Math.min(...values) * 0.97;
  const x = (i) => p + (i * (w - p * 2)) / (rows.length - 1),
    y = (v) => p + ((max - v) / (max - min)) * (h - p * 2),
    points = rows.map((r, i) => `${x(i)},${y(r.close)}`).join(' '),
    maxVol = Math.max(1, ...rows.map((r) => r.volume || 0));
  return (
    <section className="price-chart">
      <div className="section-heading">
        <h3>近{rows.length}个交易日走势</h3>
        <span className="muted">日线收盘价 · RM</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h + 70}`}
        role="img"
        aria-label={`${rows[0].date}至${rows.at(-1).date}的日线收盘价和成交量`}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#54d6ba" stopOpacity=".22" />
            <stop offset="100%" stopColor="#54d6ba" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2].map((i) => {
          const v = min + ((max - min) * i) / 2;
          return (
            <g key={i}>
              <line x1={p} y1={y(v)} x2={w - p} y2={y(v)} stroke="#27313d" strokeDasharray="3 5" />
              <text x={p} y={y(v) - 7} fill="#7b8b9b" fontSize="10">
                {number(v, 3)}
              </text>
            </g>
          );
        })}
        <polygon points={`${p},${h - p} ${points} ${w - p},${h - p}`} fill="url(#chart-fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="#54d6ba"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {levels?.neck && levels.neck >= min && levels.neck <= max && (
          <g>
            <line
              x1={p}
              x2={w - p}
              y1={y(levels.neck)}
              y2={y(levels.neck)}
              stroke="#f5bb67"
              strokeDasharray="6 4"
            />
            <text x={w - p} y={y(levels.neck) - 7} textAnchor="end" fill="#f5bb67" fontSize="11">
              突破位 {number(levels.neck, 3)}
            </text>
          </g>
        )}
        {rows.map((r, i) => (
          <rect
            key={r.date}
            x={x(i) - 2}
            y={h + 40 - ((r.volume || 0) / maxVol) * 35}
            width="4"
            height={((r.volume || 0) / maxVol) * 35}
            fill="#3e766e"
          >
            <title>
              {r.date} · 收盘 RM {r.close} · 成交量 {volume(r.volume)}
            </title>
          </rect>
        ))}
        <text x={p} y={h + 62} fill="#7b8b9b" fontSize="11">
          {rows[0].date}
        </text>
        <text x={w - p} y={h + 62} textAnchor="end" fill="#7b8b9b" fontSize="11">
          {rows.at(-1).date}
        </text>
      </svg>
    </section>
  );
}
function Method() {
  const items = [
    [
      '01',
      '趋势：价格是否持续转强',
      '近5日平均价高于10日，10日高于15日，15日高于20日，说明短期价格比长期更强。现价还需要高于5日均价。它描述已经发生的走势，不能保证继续上涨。',
    ],
    [
      '02',
      '成交量：百万股与两倍放量',
      '所有精选都需本次成交量至少100万股，且至少上一交易日全天的2倍，并有价格高于昨收和5日均价的支持。盘中以累计量对比昨日全天，不做全天成交量外推。放量而价格走弱时等待量价配合。',
    ],
    [
      '03',
      '双底：两次低点之后，是否越过压力',
      '系统寻找两个相近低点，检查中间的压力位是否被日线收盘价突破。形态评分是规则匹配程度。评分80分不代表80%的赚钱概率。',
    ],
    [
      '04',
      '价位：判断何时需要重来',
      '突破位上方3%只是形态参考区间。失效位与量度目标是技术参考值；成交价、跳空、交易费用和流动性都会影响结果。离开参考区间时，需要重新评估。',
    ],
  ];
  return (
    <div className="method-page">
      <section className="method-intro">
        <Icon name="book" size={30} />
        <div>
          <h2>先问三个问题</h2>
          <p>为什么入选？依据是否完整？什么情况会失效？</p>
        </div>
      </section>
      <div className="method-grid">
        {items.map(([id, title, text]) => (
          <article className="panel" key={id}>
            <span className="method-number">{id}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </div>
      <section className="panel">
        <h2>如何读首页的结论</h2>
        <dl className="glossary">
          <div>
            <dt>可重点考虑</dt>
            <dd>
              百万股与两倍放量同时达标，价格也转强，资料与成交活跃度符合要求。仍需核对价格、财报和公告。
            </dd>
          </div>
          <div>
            <dt>等待放量 / 等待量价配合</dt>
            <dd>成交量尚未同时达标，或成交量放大但价格没有转强。暂不列入精选。</dd>
          </div>
          <div>
            <dt>等待回踩</dt>
            <dd>现价已离开形态参考区间或越过量度目标，需要重新评估风险与空间。</dd>
          </div>
          <div>
            <dt>资料待补齐 / 历史快照</dt>
            <dd>资料不足或时间较旧，不能把显示的信号当作当前判断。</dd>
          </div>
        </dl>
      </section>
      <section className="risk-box">
        <h3>观察记录怎样理解</h3>
        <p>
          “涨幅达标”与“跌幅触发”只记录观察规则是否触发。起始价来自系统入选时的快照，未模拟真实成交、滑点与费用。旧版天数曾按扫描次数计数，相关记录不可用于证明选股效果。
        </p>
        <p>
          价格与成交量分析没有覆盖公司的盈利、估值和新闻。历史表现不能推导未来收益。
          <a
            href="https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-47"
            target="_blank"
            rel="noreferrer"
          >
            了解如何判断历史表现说明 ↗
          </a>
        </p>
      </section>
    </div>
  );
}
function AdminSettings({ state, close, updated }) {
  const [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [draft, setDraft] = useState(() => ({ ...state?.settings }));
  const fields = [
    ['pick_count', '最多精选几只', 1, 5],
    ['min_average_daily_value', '20日平均成交额下限（RM，估算）', 0, 1000000000],
    ['screen_min_volume', '精选成交量下限（股，至少100万）', 1000000, 1000000000000],
    ['poll_interval_minutes', '更新间隔（分钟）', 1, 60],
    ['screen_min_gain', '20日涨幅下限（%）', -100, 1000],
    ['screen_max_gain', '20日涨幅上限（%）', -100, 1000],
    ['screen_vol_mult', '本次 / 上一交易日全天量（至少2倍）', 2, 100],
    ['db_min_score', '形态评分门槛', 0, 100],
    ['db_min_rr', '最小目标 / 风险空间比', 0.1, 20],
  ];
  const mutate = async (url, body) => {
    setBusy(true);
    setMessage('');
    try {
      await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      setMessage('操作已完成。');
      updated();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    const patch = Object.fromEntries(fields.map(([key]) => [key, Number(draft[key])]));
    patch.window = draft.window;
    patch.screen_on = draft.screen_on;
    mutate('/api/settings', patch);
  };
  return (
    <Modal title="管理员设置" close={close}>
      <form className="admin-form" onSubmit={submit}>
        <p>公开用户可以查看分析；修改全站参数需要管理员令牌。</p>
        {!state?.admin_enabled && (
          <div className="banner warning">
            服务尚未启用管理员操作，请在部署环境配置 ADMIN_TOKEN。
          </div>
        )}
        <label>
          管理员令牌
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            placeholder="令牌仅保留在当前设置窗口"
          />
        </label>
        <div className="settings-grid">
          {fields.map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
                step={key === 'screen_vol_mult' || key === 'db_min_rr' ? 0.1 : 1}
                value={draft[key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                required
              />
            </label>
          ))}
          <label>
            看板成交量对比时段
            <select
              value={draft.window || '1d'}
              onChange={(e) => setDraft({ ...draft, window: e.target.value })}
            >
              <option value="1d">本交易日 / 上一交易日</option>
              <option value="30m">最近30分钟 / 前30分钟</option>
              <option value="1h">最近1小时 / 前1小时</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.screen_on !== false}
              onChange={(e) => setDraft({ ...draft, screen_on: e.target.checked })}
            />{' '}
            将达标筛选加入每日广播
          </label>
        </div>
        <p className="data-note">
          分钟和小时对比只在同一连续交易时段内资料充足时计算；午休与跨日不会拼接成有效窗口。
        </p>
        {message && (
          <p role="status" className="form-message">
            {message}
          </p>
        )}
        <button className="primary-button" disabled={busy || !state?.admin_enabled}>
          {busy ? '处理中…' : '保存分析设置'}
        </button>
        <div className="admin-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!token || busy || !state?.admin_enabled}
            onClick={() => mutate('/api/poll', {})}
          >
            刷新市场快照
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!token || busy || !state?.admin_enabled}
            onClick={() => mutate('/api/backfill', {})}
          >
            补齐日线资料
          </button>
        </div>
      </form>
    </Modal>
  );
}
