import React, { useEffect, useRef, useState } from 'react';

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

const WINDOW_LABELS = { '10m': '10分钟', '30m': '30分钟', '1h': '1小时', '2h': '2小时', '5h': '5小时', '1d': '1天' };

export default function App() {
  const [state, setState] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [addCode, setAddCode] = useState('');
  const [thr, setThr] = useState('200');
  const lastAlertId = useRef(0);
  const thrFocused = useRef(false);

  // 初始快照 + SSE 订阅
  useEffect(() => {
    fetch('/api/state').then((r) => r.json()).then(setState).catch(() => {});
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const s = JSON.parse(e.data);
        setState(s);
        checkNewAlerts(s);
      } catch {}
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (state) setThr(String(state.settings.threshold_percent));
  }, [state?.settings.threshold_percent]);

  function checkNewAlerts(s) {
    if (!s.alerts?.length) return;
    const newest = s.alerts[0];
    if (newest.id > lastAlertId.current) {
      if (lastAlertId.current !== 0) notify(newest);
      lastAlertId.current = newest.id;
    }
  }

  function notify(a) {
    const dir = a.direction === 'surge' ? '📈 放量' : '📉 缩量';
    const title = `${dir}提醒 — ${a.name} (${a.stock}.KL)`;
    const body = `时段 ${a.window}: 当前 ${fmt(a.current)} / 上一时段 ${fmt(a.previous)} = ${a.ratio.toFixed(1)}%`;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
    beep();
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      o.start(); o.stop(ctx.currentTime + 0.3);
    } catch {}
  }

  async function setSetting(patch) {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    lastAlertId.current = 0;
  }

  async function addStock() {
    if (!addCode.trim()) return;
    await fetch('/api/watchlist/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: addCode.trim() }),
    });
    setAddCode('');
  }

  function requestNotify() {
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission();
  }

  const s = state;
  const open = s?.status.market_open;

  return (
    <>
      <style>{css}</style>
      <div className="wrap">
        <header>
          <h1><span className={`dot ${open ? 'open' : 'closed'}`}></span> KLSE 成交量异动追踪</h1>
          <div className="meta">
            {s ? (
              <>
                {open ? '🟢 市场开市' : '⚪ 市场休市'} · 最后更新 {fmtTime(s.status.last_poll)}
                {s.status.polling ? ' · <span class="spark">抓取中…</span>' : ''}
              </>
            ) : '载入中…'}
          </div>
          <div className="row">
            <button className="ghost" onClick={() => setShowSettings((v) => !v)}>⚙ 高级设置</button>
            <button className="ghost" onClick={requestNotify}>🔔 通知</button>
          </div>
        </header>

        {/* 快捷控制条 */}
        <div className="panel">
          <div className="quick">
            <span className="qlabel">对比时段</span>
            <div className="seg">
              {Object.keys(WINDOW_LABELS).map((w) => (
                <button key={w} className={s?.settings.window === w ? 'on' : ''}
                  onClick={() => setSetting({ window: w })}>{WINDOW_LABELS[w]}</button>
              ))}
            </div>
            <span className="qlabel">阈值</span>
            <input type="number" min="0" step="5" value={thr}
              onFocus={() => (thrFocused.current = true)}
              onBlur={() => { thrFocused.current = false; }}
              onChange={(e) => setThr(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
              style={{ width: 88 }} />
            <span style={{ color: 'var(--dim)' }}>%</span>
            <span className="qlabel">方向</span>
            <div className="seg">
              <button className={s?.settings.direction === 'surge' ? 'on' : ''}
                onClick={() => setSetting({ direction: 'surge' })}>📈 放量 ≥</button>
              <button className={s?.settings.direction === 'drop' ? 'on' : ''}
                onClick={() => setSetting({ direction: 'drop' })}>📉 缩量 ≤</button>
            </div>
          </div>
          <div className="muted" style={{ marginTop: 10 }}>
            当「当前时段量」达到「上一时段量」的阈值 % 时提醒。1 天模式 = 今日累计 vs 前一交易日。
          </div>
        </div>

        {/* 高级设置 */}
        {showSettings && (
          <div className="panel">
            <h2>高级设置</h2>
            <div className="settings">
              <Field label="轮询间隔(分)" def={s?.settings.poll_interval_minutes} save={(v) => setSetting({ poll_interval_minutes: +v })} />
              <Field label="上一时段最小量" def={s?.settings.min_previous_volume} save={(v) => setSetting({ min_previous_volume: +v })} />
              <Field label="重复提醒间隔(分)" def={s?.settings.cooldown_minutes} save={(v) => setSetting({ cooldown_minutes: +v })} />
              <Field label="Telegram Bot Token" def={s?.settings.telegram_bot_token} save={(v) => setSetting({ telegram_bot_token: v })} />
              <Field label="Telegram Chat ID" def={s?.settings.telegram_chat_id} save={(v) => setSetting({ telegram_chat_id: v })} />
            </div>
          </div>
        )}

        {/* 自选股 */}
        <div className="panel">
          <h2>自选股 <span className="muted">({s?.watchlist.length ?? 0} 只, 按增长倍率排序)</span></h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <input placeholder="股票代码, 如 1155" style={{ width: 160 }} value={addCode}
              onChange={(e) => setAddCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addStock()} />
            <button onClick={addStock}>添加</button>
            <span className="muted">马股代码纯数字, 自动加 .KL 后缀</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th>代码</th><th>名称</th><th>现价</th>
                <th>当前时段量</th><th>上一时段量</th><th>比率</th>
              </tr></thead>
              <tbody>
                {s?.stocks.map((st) => {
                  const ratioHtml = st.ratio == null ? '—' : (
                    <span className={s.settings.direction === 'surge'
                      ? (st.ratio >= s.settings.threshold_percent ? 'up' : '')
                      : (st.ratio <= s.settings.threshold_percent ? 'down' : '')}>
                      {st.ratio.toFixed(1)}%
                    </span>
                  );
                  return (
                    <tr key={st.code}>
                      <td><span className="code">{st.code}.KL</span></td>
                      <td>{st.name}</td>
                      <td>{st.price != null ? st.price.toFixed(3) : '—'}</td>
                      <td>{fmt(st.current)}</td>
                      <td>{fmt(st.previous)}</td>
                      <td>{ratioHtml}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* 告警记录 */}
        <div className="panel">
          <h2>告警记录</h2>
          <div className="alerts">
            {s?.alerts.length ? s.alerts.map((a) => (
              <div className="alert-item" key={a.id}>
                <span className="t">{fmtTime(a.ts)}</span>
                <span className="code">{a.stock}.KL</span>
                <span>{a.name}</span>
                <span className="grow muted">时段 {a.window} · {fmt(a.current)} / {fmt(a.previous)}</span>
                <span className="spark">{a.ratio.toFixed(1)}%</span>
                <span>{a.direction === 'surge' ? '📈 放量' : '📉 缩量'}</span>
              </div>
            )) : <div className="muted">暂无告警</div>}
          </div>
        </div>
      </div>
    </>
  );
}

function Field({ label, def, save }) {
  const [v, setV] = useState(def ?? '');
  useEffect(() => { setV(def ?? ''); }, [def]);
  return (
    <div className="field">
      <label>{label}</label>
      <input type="text" value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => save(v)} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
    </div>
  );
}

const css = `
  :root{--bg:#0b0f17;--panel:#131a26;--panel2:#0f1621;--border:#1f2a3a;--text:#e6edf3;--dim:#8b98a9;--accent:#3b82f6;--green:#22c55e;--red:#ef4444;--amber:#f59e0b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI","Microsoft YaHei",Roboto,sans-serif;font-size:14px}
  .wrap{max-width:1200px;margin:0 auto;padding:20px}
  h1{font-size:20px;margin:0;display:flex;align-items:center;gap:10px}
  .dot{width:9px;height:9px;border-radius:50%;background:#555;display:inline-block}
  .dot.open{background:var(--green);box-shadow:0 0 8px var(--green)}
  .dot.closed{background:#555}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px}
  .meta{color:var(--dim);font-size:13px}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px}
  .panel h2{font-size:14px;margin:0 0 12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
  button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px}
  button.ghost{background:var(--panel2);border:1px solid var(--border);color:var(--text)}
  button.danger{background:transparent;border:1px solid var(--border);color:var(--dim);padding:2px 8px;font-size:12px}
  button.danger:hover{color:var(--red);border-color:var(--red)}
  button:hover{opacity:.9}
  input,select{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px;outline:none}
  input:focus,select:focus{border-color:var(--accent)}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px 12px;text-align:right;border-bottom:1px solid var(--border);white-space:nowrap}
  th{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.3px}
  th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
  tr:hover td{background:var(--panel2)}
  .code{font-family:ui-monospace,Consolas,monospace;color:var(--accent)}
  .up{color:var(--green)}.down{color:var(--red)}
  .badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:600}
  .badge.alert{background:rgba(239,68,68,.15);color:var(--red)}
  .badge.ok{background:rgba(34,197,94,.12);color:var(--green)}
  .badge.low,.badge.nodata{background:var(--panel2);color:var(--dim)}
  .settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;align-items:end}
  .field label{display:block;font-size:12px;color:var(--dim);margin-bottom:5px}
  .field input,.field select{width:100%}
  .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .alerts{max-height:260px;overflow-y:auto}
  .alert-item{display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border);font-size:13px}
  .alert-item .t{color:var(--dim);font-size:12px;min-width:70px}
  .spark{color:var(--amber);font-weight:600}
  .grow{flex:1}
  .muted{color:var(--dim);font-size:12px}
  .quick{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .qlabel{color:var(--dim);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
  .seg{display:inline-flex;background:var(--panel2);border:1px solid var(--border);border-radius:9px;padding:3px;gap:2px}
  .seg button{background:transparent;color:var(--dim);border:0;border-radius:7px;padding:6px 13px;cursor:pointer;font-size:13px}
  .seg button:hover{color:var(--text)}
  .seg button.on{background:var(--accent);color:#fff}
`;
