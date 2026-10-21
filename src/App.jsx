import React, { useEffect, useState, useRef } from 'react';
import './styles.css';
import { formatMultiple } from '../lib/volume.js';

const shares = (value) =>
  Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : '—';
const time = (value) =>
  value
    ? new Date(value * 1000).toLocaleString('zh-CN', {
        timeZone: 'Asia/Kuala_Lumpur',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '等待更新';
async function request(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
}
export default function App() {
  const [state, setState] = useState(null),
    [error, setError] = useState(''),
    [connected, setConnected] = useState(false);
  const [tab, setTab] = useState('qualified'),
    [query, setQuery] = useState(''),
    [settings, setSettings] = useState(false);
  useEffect(() => {
    let active = true;
    const accept = (data) => {
      if (active) {
        setState(data);
        setError('');
      }
    };
    const refresh = () =>
      request('/api/state')
        .then(accept)
        .catch(() => {
          if (active) setError('暂时无法连接，请稍后重试。');
        });
    refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => {
      if (active) setConnected(true);
    };
    events.onmessage = (event) => {
      try {
        accept(JSON.parse(event.data));
      } catch {}
    };
    events.onerror = () => {
      if (active) setConnected(false);
    };
    const timer = setInterval(refresh, 60000);
    return () => {
      active = false;
      events.close();
      clearInterval(timer);
    };
  }, []);
  const stocks = state?.stocks || [],
    qualified = stocks.filter((s) => s.qualified);
  const rows = (
    tab === 'alerts' ? state?.alerts || [] : tab === 'qualified' ? qualified : stocks
  ).filter((s) =>
    [s.code || s.stock, s.name, s.numeric_code].some((v) =>
      String(v || '')
        .toLowerCase()
        .includes(query.toLowerCase()),
    ),
  );
  return (
    <main>
      <header>
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            Ⅲ
          </span>
          <div>
            <strong>KLSE</strong>
            <span>成交量提醒</span>
          </div>
        </div>
        <button className="quiet" onClick={() => setSettings(true)}>
          通知设置
        </button>
      </header>
      <section className="intro">
        <div className="eyebrow">只看成交量</div>
        <h1>
          达到昨日 <em>3倍</em>，就提醒。
        </h1>
        <p>今日累计成交量 ÷ 上一有成交交易日全天量 ≥ 3。同一只股票每天提醒一次。</p>
        <div className="status">
          <span className={connected ? 'dot online' : 'dot'} />
          {state?.status.market_open ? '开市中 · 每5分钟扫描' : '休市中 · 显示最近快照'}
          <span>更新于 {time(state?.status.last_poll)}</span>
        </div>
      </section>
      {(error || state?.status.error) && (
        <p className="notice" role="alert">
          {error || state.status.error}
        </p>
      )}
      {state && !state.settings.telegram_ready && (
        <p className="notice">Telegram 尚未配置，达标提醒会保存在网页。</p>
      )}
      {state && state.settings.telegram_ready && !state.settings.potential_alerts_telegram && (
        <p className="notice">Telegram 通知已关闭，达标提醒会保存在网页。</p>
      )}
      <section className="stats" aria-label="市场概况">
        <div>
          <span>三倍以上</span>
          <strong>
            {qualified.length}
            <small>只</small>
          </strong>
        </div>
        <div>
          <span>已扫描</span>
          <strong>
            {state?.coverage.total ?? '—'}
            <small>只</small>
          </strong>
        </div>
        <div>
          <span>可对比</span>
          <strong>
            {state?.coverage.comparable ?? '—'}
            <small>只</small>
          </strong>
        </div>
      </section>
      <section className="panel">
        <div className="toolbar">
          <div className="tabs" role="tablist" aria-label="成交量列表">
            {[
              ['qualified', '三倍以上'],
              ['all', '全部股票'],
              ['alerts', '通知记录'],
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className="search"
            aria-label="搜索股票"
            placeholder="搜索名称或代码"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>股票</th>
                <th>今日量（股）</th>
                <th>昨日量（股）</th>
                <th>倍数</th>
                <th>{tab === 'alerts' ? '通知状态' : '资料'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={(s.code || s.stock) + (s.date || '')}>
                  <td>
                    <strong>{s.code || s.stock}</strong>
                    {s.numeric_code && <span className="code">{s.numeric_code}</span>}
                    <span className="company">{s.name}</span>
                  </td>
                  <td>{shares(s.volume)}</td>
                  <td>{shares(s.previous_volume)}</td>
                  <td>
                    <span className={s.multiple >= 3 ? 'multiple pass' : 'multiple'}>
                      {s.multiple != null ? `${formatMultiple(s.multiple)}×` : '—'}
                    </span>
                  </td>
                  <td className="muted">
                    {tab === 'alerts' ? (
                      <>
                        {s.sent_at
                          ? '已发送'
                          : s.cancelled_at
                            ? s.last_error || '已停止'
                            : '等待发送'}
                        <span className="company">{time(s.ts)}</span>
                      </>
                    ) : (
                      <>
                        {s.issue ||
                          (s.date ===
                          new Date(state.status.now * 1000 + 8 * 3600000).toISOString().slice(0, 10)
                            ? '今日快照'
                            : '历史快照')}
                        <span className="company">
                          {s.date || '—'}
                          {s.previous_date && ` / 对比 ${s.previous_date}`}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <div className="empty">
            {!state
              ? '正在读取成交量…'
              : query
                ? '没有找到这只股票。'
                : tab === 'qualified'
                  ? '目前没有达到昨日3倍量的股票。'
                  : tab === 'alerts'
                    ? '暂时没有通知记录。'
                    : '正在补齐市场资料。'}
          </div>
        )}
      </section>
      <footer>成交量单位为股。免费行情可能延迟；缺少昨日量时，补齐后再判断。</footer>
      {settings && state && <Settings state={state} close={() => setSettings(false)} />}
    </main>
  );
}
function Settings({ state, close }) {
  const [token, setToken] = useState(''),
    [bot, setBot] = useState(''),
    [chat, setChat] = useState('');
  const [enabled, setEnabled] = useState(state.settings.potential_alerts_telegram);
  const [holidays, setHolidays] = useState(state.settings.market_holidays.join('\n'));
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const patch = {
      potential_alerts_telegram: enabled,
      market_holidays: holidays.split(/[\s,，]+/).filter(Boolean),
    };
    if (bot.trim()) patch.telegram_bot_token = bot.trim();
    if (chat.trim()) patch.telegram_chat_id = chat.trim();
    try {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      setBot('');
      setMessage('已保存。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="settings-title"
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-head">
        <h2 id="settings-title">通知设置</h2>
        <button onClick={close} aria-label="关闭设置">
          关闭
        </button>
      </div>
      <p>达到昨日3倍即提醒。仅发送股票代码、今日量、昨日量和倍数。</p>
      {!state.admin_enabled && <p className="notice">请先在服务器配置 ADMIN_TOKEN。</p>}
      <form onSubmit={submit}>
        <label>
          管理员令牌
          <input
            autoFocus
            required
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          开启 Telegram 通知
        </label>
        <label>
          Bot Token
          <input
            type="password"
            autoComplete="off"
            placeholder="留空保留现有设置"
            value={bot}
            onChange={(e) => setBot(e.target.value)}
          />
        </label>
        <label>
          Chat ID
          <input
            placeholder="留空保留现有设置"
            value={chat}
            onChange={(e) => setChat(e.target.value)}
          />
        </label>
        <label>
          休市日期
          <textarea
            placeholder="每行一个 YYYY-MM-DD"
            rows={3}
            value={holidays}
            onChange={(e) => setHolidays(e.target.value)}
          />
        </label>
        <p role="status">{message}</p>
        <button className="primary" disabled={busy || !state.admin_enabled}>
          {busy ? '保存中…' : '保存设置'}
        </button>
      </form>
    </dialog>
  );
}
