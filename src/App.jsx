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

export default function App() {
  const [state, setState] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [addCode, setAddCode] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [showRecipients, setShowRecipients] = useState(false);
  const [sortBy, setSortBy] = useState('ratio');
  const [priceRules, setPriceRules] = useState(null);
  const [pollVal, setPollVal] = useState('5');
  const lastAlertId = useRef(0);

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
    if (state?.settings.poll_interval_minutes) setPollVal(String(state.settings.poll_interval_minutes));
  }, [state?.settings.poll_interval_minutes]);

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

  useEffect(() => {
    if (priceRules == null && state?.price_thresholds) {
      setPriceRules(state.price_thresholds.map((r) => ({ ...r })));
    }
  }, [state, priceRules]);

  function handleRulesChange(next, save) {
    setPriceRules(next);
    if (save) setSetting({ price_thresholds: next });
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

  async function addPhoneHandler() {
    const p = addPhone.trim().replace(/\D/g, '');
    if (!/^01\d{8,9}$/.test(p)) { alert('手机号格式不对 (01 开头, 10-11 位)'); return; }
    const r = await fetch('/api/recipients/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: p }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) alert(j.error);
    setAddPhone('');
  }

  async function removePhone(p) {
    await fetch('/api/recipients/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: p }),
    });
  }

  const s = state;
  const open = s?.status.market_open;

  // 初始载入中(尚未拿到数据)显示旋转 loader
  if (!s) {
    return (
      <>
        <style>{css}</style>
        <div className="loader-wrap">
          <div className="spinner"></div>
          <div className="loader-text">正在载入数据…</div>
        </div>
      </>
    );
  }

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

        {/* 快捷控制条: 轮询间隔 */}
        <div className="panel">
          <div className="quick">
            <span className="qlabel">轮询间隔</span>
            <input type="number" min="1" value={pollVal} style={{ width: 70 }}
              onChange={(e) => setPollVal(e.target.value)}
              onBlur={() => { const n = +pollVal; if (n > 0) setSetting({ poll_interval_minutes: n }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
            <span className="muted">分钟 (多久抓一次数据)</span>
          </div>
        </div>

        {/* 高级设置 */}
        {showSettings && (
          <div className="panel">
            <h2>高级设置</h2>
            <h2 style={{ marginTop: 4 }}>价格阈值规则 <span className="muted">(按股价范围设提醒阈值)</span></h2>
            <ThresholdEditor rules={priceRules || state?.price_thresholds || []} onChange={handleRulesChange} />
          </div>
        )}

        {/* 自选股 */}
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>自选股 <span className="muted">({s?.watchlist.length ?? 0} 只)</span></h2>
            <div className="seg">
              <button className={sortBy === 'ratio' ? 'on' : ''} onClick={() => setSortBy('ratio')}>按倍率</button>
              <button className={sortBy === 'code' ? 'on' : ''} onClick={() => setSortBy('code')}>按代码</button>
            </div>
          </div>
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
                <th>今日量</th><th>昨日量</th><th>4周/5天均量</th><th>比率</th>
              </tr></thead>
              <tbody>
                {(sortBy === 'code'
                  ? [...(s?.stocks || [])].sort((a, b) => String(a.code).localeCompare(String(b.code)))
                  : (s?.stocks || [])).map((st) => {
                  const ratioHtml = st.ratio == null ? '—' : (
                    <span className={st.status === 'alert' ? 'up' : ''}>
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
                      <td>{fmt(st.avg4w)} / {fmt(st.avg5d)}</td>
                      <td>{ratioHtml}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </>
  );
}

const AXIS_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6'];

function ThresholdEditor({ rules, onChange }) {
  const axisRef = useRef(null);
  const [dragIdx, setDragIdx] = useState(null);
  const rulesRef = useRef(rules || []);
  rulesRef.current = rules || [];
  const maxPRef = useRef(5);

  const finite = (rules || []).filter((r) => r.max != null);
  // 拖动中固定 maxP(比例尺); 非拖动时按最大分割点自适应(不强制下限10, 方便设小价格如1.50)
  if (dragIdx == null) {
    const m = finite.length ? finite[finite.length - 1].max : 5;
    maxPRef.current = Math.max(1, Math.ceil(m * 1.5 * 100) / 100);
  }
  const maxP = maxPRef.current;
  const pct = (p) => (p / maxP) * 100;

  const segs = [];
  let prev = 0;
  (rules || []).forEach((r, i) => {
    const end = r.max == null ? maxP : r.max;
    const label = r.max == null
      ? `${prev.toFixed(2)}+`
      : (i === 0 ? `0 – ${r.max.toFixed(2)}` : `${(prev + 0.01).toFixed(2)} – ${r.max.toFixed(2)}`);
    segs.push({ start: prev, end, widthPct: ((end - prev) / maxP) * 100, label });
    prev = end;
  });

  function priceAt(e) {
    const rect = axisRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let p = (x / rect.width) * maxP;
    p = Math.max(0.01, Math.min(maxP - 0.01, p));
    return Math.round(p * 100) / 100;
  }

  function onMove(e) {
    if (dragIdx == null || !axisRef.current) return;
    let p = priceAt(e);
    const cur = rulesRef.current.map((r) => ({ ...r }));
    const fin = cur.filter((r) => r.max != null).map((r) => r.max);
    if (dragIdx > 0) p = Math.max(p, fin[dragIdx - 1] + 0.01);
    if (dragIdx < fin.length - 1) p = Math.min(p, fin[dragIdx + 1] - 0.01);
    cur[dragIdx].max = p;
    rulesRef.current = cur;
    onChange(cur, false);
  }

  function onUp() {
    if (dragIdx != null) { onChange(rulesRef.current, true); setDragIdx(null); }
  }

  function onAxisClick(e) {
    if (dragIdx != null) return;
    if (e.target.closest('.split') || e.target.closest('.axis-thr')) return;
    const p = priceAt(e);
    const cur = (rules || []).map((r) => ({ ...r }));
    const fin = cur.filter((r) => r.max != null);
    if (fin.some((m) => Math.abs(m - p) < 0.02)) return;
    cur.pop();
    cur.push({ max: p, threshold: 200 });
    cur.push({ max: null, threshold: 200 });
    cur.sort((a, b) => (a.max == null ? 1e9 : a.max) - (b.max == null ? 1e9 : b.max));
    onChange(cur, true);
  }

  if (!(rules || []).length) {
    return (
      <div>
        <div className="muted" style={{ marginBottom: 8 }}>还没有阈值规则 → 不会发提醒。</div>
        <button onClick={() => onChange([{ max: 1.5, threshold: 200 }, { max: null, threshold: 200 }], true)}>+ 添加第一个分割点 (默认 1.50)</button>
      </div>
    );
  }

  const setMaxRaw = (i, v) => onChange((rules || []).map((x, j) => j === i ? { ...x, max: v } : x), false);
  const setMaxCommit = (i, v) => {
    let val = Math.max(0.01, Math.round((+v || 0) * 100) / 100);
    const cur = (rules || []).map((r) => ({ ...r }));
    const fin = cur.filter((r) => r.max != null);
    if (i > 0) val = Math.max(val, fin[i - 1] + 0.01);
    if (i < fin.length - 1) val = Math.min(val, fin[i + 1] - 0.01);
    cur[i].max = val;
    onChange(cur, true);
  };
  const setThrRaw = (i, v) => onChange((rules || []).map((x, j) => j === i ? { ...x, threshold: v } : x), false);
  const setThrCommit = (i, v) => onChange((rules || []).map((x, j) => j === i ? { ...x, threshold: Math.max(0, Math.round(+v || 200)) } : x), true);
  const rmSplit = (i) => onChange((rules || []).filter((_, j) => j !== i), true);
  const addSplit = () => {
    const cur = (rules || []).map((r) => ({ ...r }));
    const fin = cur.filter((r) => r.max != null);
    const lastMax = fin.length ? fin[fin.length - 1].max : 0;
    const newMax = Math.round((lastMax + 1) * 100) / 100;
    cur.pop();
    cur.push({ max: newMax, threshold: 200 });
    cur.push({ max: null, threshold: 200 });
    onChange(cur, true);
  };

  return (
    <div>
      <div className="axis" ref={axisRef} onClick={onAxisClick}
        onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
        {segs.map((s, i) => (
          <div key={i} className="axis-seg" style={{ left: pct(s.start) + '%', width: s.widthPct + '%', background: AXIS_COLORS[i % AXIS_COLORS.length] }} />
        ))}
        {finite.map((r, i) => (
          <div key={'s' + i} className="split" style={{ left: pct(r.max) + '%' }}
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setDragIdx(i); }}>
            <span className="split-dot" />
            <span className="split-label">{r.max.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="thr-rows">
        {(rules || []).map((r, i) => (
          <div key={'row' + i} className="thr-row">
            <span className="thr-range">{segs[i].label}</span>
            {r.max != null ? (
              <>
                <span className="muted">上限</span>
                <input type="number" step="0.01" value={r.max}
                  onChange={(e) => setMaxRaw(i, e.target.value)}
                  onBlur={(e) => setMaxCommit(i, e.target.value)} />
              </>
            ) : (
              <span className="muted">无上限</span>
            )}
            <span className="muted">阈值</span>
            <input type="number" value={r.threshold}
              onChange={(e) => setThrRaw(i, e.target.value)}
              onBlur={(e) => setThrCommit(i, e.target.value)} />
            <span className="muted">%</span>
            {r.max != null && <button className="chip-x" onClick={() => rmSplit(i)}>✕</button>}
          </div>
        ))}
      </div>
      <button onClick={addSplit}>+ 添加分割点</button>
      <div className="muted">拖动圆点粗调 · 列表里输入框精确改价格</div>
    </div>
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
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--border);border-radius:20px;padding:5px 12px;font-size:13px;font-family:ui-monospace,Consolas,monospace}
  .chip-x{background:transparent;border:0;color:var(--dim);padding:0;cursor:pointer;font-size:13px;line-height:1}
  .chip-x:hover{color:var(--red)}
  .axis{position:relative;height:56px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;margin:18px 0 10px;touch-action:none;cursor:copy}
  .axis-empty{height:56px;display:flex;align-items:center;justify-content:center;margin-top:2px}
  .axis-hint{color:var(--dim);font-size:12px}
  .axis-seg{position:absolute;top:0;height:56px;opacity:.6;border-right:1px solid var(--bg)}
  .split{position:absolute;top:0;height:56px;width:2px;background:var(--text);cursor:ew-resize;z-index:2}
  .split-dot{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:16px;height:16px;border-radius:50%;background:var(--text);border:3px solid var(--panel)}
  .split-label{position:absolute;top:-22px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--text);white-space:nowrap;font-family:ui-monospace,Consolas,monospace;background:var(--panel);padding:1px 6px;border-radius:4px;border:1px solid var(--border)}
  .split-x{position:absolute;top:-20px;left:50%;transform:translateX(20px);font-size:11px;color:var(--dim);cursor:pointer;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:0 4px;line-height:1.4}
  .split-x:hover{color:var(--red)}
  .thr-rows{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
  .thr-row{display:flex;align-items:center;gap:8px;font-size:13px}
  .thr-range{flex:1;font-size:12px;color:var(--dim);font-family:ui-monospace,Consolas,monospace}
  .thr-row input{width:80px;padding:4px 6px}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px;width:min(440px,92vw);box-shadow:0 16px 48px rgba(0,0,0,.4)}
  .modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .modal-head h2{margin:0;font-size:15px;color:var(--text);text-transform:none;letter-spacing:0}
  .loader-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}
  .spinner{width:44px;height:44px;border:4px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
  .loader-text{color:var(--dim);font-size:14px}
  @keyframes spin{to{transform:rotate(360deg)}}
`;
