#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KLSE Volume Tracker — 马来西亚股票成交量异动追踪
数据源: Yahoo Finance 免费盘中接口 (无需 key)
依赖: 仅 Python 标准库 (无第三方依赖)

运行:  python server.py      →  http://localhost:8080

功能:
  · 每 N 分钟轮询自选股的盘中成交量 (5 分钟粒度 candle)
  · 可选对比时段 (10m/30m/1h/2h/5h/1d)，当「当前时段量」达到「上一时段量」的 n% 时提醒
  · 网页实时展示成交量、对比比率、告警记录
  · 提醒: 网页内通知 + 告警列表; 可选 Telegram
"""
import json, os, re, sqlite3, threading, time, urllib.request, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
DB_PATH = os.path.join(BASE, "data.db")
PUBLIC_DIR = os.path.join(BASE, "public")
PORT = int(os.environ.get("PORT", "8080"))

MYT = timezone(timedelta(hours=8))  # 马来西亚时间

DEFAULTS = {
    "poll_interval_minutes": 10,
    "window": "1h",               # 10m | 30m | 1h | 2h | 5h | 1d
    "threshold_percent": 200.0,   # 当前时段量 >= 上一时段量的 n% 时提醒
    "direction": "surge",         # surge=放量提醒 | drop=缩量提醒
    "min_previous_volume": 100000,  # 上一时段量低于此值则不提醒(过滤冷门股)
    "cooldown_minutes": 30,       # 同一只股票两次提醒的最短间隔
    "telegram_bot_token": "",
    "telegram_chat_id": "",
}

# 对比时段 → 5 分钟 candle 数量。用「交易时段滚动」而非时钟滚动：
# 自动跳过午休(12:30-14:30)与隔夜, 使「上一时段」= 上一段有交易的时段。
WINDOW_CANDLES = {"10m": 2, "30m": 6, "1h": 12, "2h": 24, "5h": 60}

# 默认自选股 (FBM KLCI 30 成分股 + 活跃中大盘股, 代码已对 Yahoo 验证)
DEFAULT_WATCHLIST = [
    ("1155", "Maybank"), ("1295", "Public Bank"), ("1023", "CIMB"),
    ("5347", "Tenaga"), ("5183", "Petronas Chemicals"), ("6033", "Petronas Gas"),
    ("5681", "Petronas Dagangan"), ("5225", "IHH Healthcare"), ("6012", "Maxis"),
    ("6888", "Axiata"), ("6947", "CelcomDigi"), ("3182", "Genting"),
    ("4715", "Genting Malaysia"), ("3816", "MISC"), ("4197", "Sime Darby"),
    ("5285", "SD Guthrie"), ("2445", "KLK"), ("1961", "IOI Corp"),
    ("8869", "Press Metal"), ("7084", "QL Resources"), ("4707", "Nestle Malaysia"),
    ("3034", "Hap Seng"), ("5398", "Gamuda"), ("3336", "IJM"),
    ("5819", "Hong Leong Bank"), ("1082", "Hong Leong Financial"), ("1066", "RHB Bank"),
    ("1015", "AMMB"), ("4863", "Telekom Malaysia"), ("5296", "MR D.I.Y."),
    ("7277", "Dialog"), ("0166", "Inari Amertron"), ("4677", "YTL Corp"),
    ("6742", "YTL Power"), ("5211", "Sunway"), ("5246", "Westports"),
    ("5168", "Hartalega"), ("7113", "Top Glove"),
]

LOG_FILE = os.path.join(BASE, "server.log")

def log(msg):
    line = f"[{datetime.now(MYT).strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------------- 配置 ----------------
def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    if not cfg.get("watchlist"):
        cfg["watchlist"] = [{"code": c, "name": n} for c, n in DEFAULT_WATCHLIST]
    return cfg


def save_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


# ---------------- 数据库 ----------------
_conn = None
_db_lock = threading.Lock()

def get_db():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript("""
        CREATE TABLE IF NOT EXISTS samples(
            stock TEXT, ts INTEGER, vol INTEGER, PRIMARY KEY(stock, ts));
        CREATE INDEX IF NOT EXISTS idx_samples ON samples(stock, ts);
        CREATE TABLE IF NOT EXISTS live(
            stock TEXT PRIMARY KEY, name TEXT, price REAL, mtime INTEGER);
        CREATE TABLE IF NOT EXISTS alerts(
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, stock TEXT, name TEXT,
            window TEXT, current INTEGER, previous INTEGER, ratio REAL, direction TEXT);
        CREATE TABLE IF NOT EXISTS state(
            stock TEXT PRIMARY KEY, above INTEGER, last_alert INTEGER);
        """)
        _conn.commit()
    return _conn


def q(sql, args=()):
    with _db_lock:
        return get_db().execute(sql, args).fetchall()


def qone(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def execw(sql, args=()):
    with _db_lock:
        c = get_db()
        c.execute(sql, args)
        c.commit()


def store_candles(code, candles):
    if not candles:
        return
    with _db_lock:
        c = get_db()
        # ts 归一化到 5 分钟边界, 消除 range=1d / range=5d 的秒级微差导致的重复
        c.executemany(
            "INSERT OR IGNORE INTO samples(stock, ts, vol) VALUES(?,?,?)",
            [(code, (t // 300) * 300, v) for t, v in candles])
        c.commit()


def update_live(code, name, price, mtime):
    execw("INSERT INTO live(stock, name, price, mtime) VALUES(?,?,?,?) "
          "ON CONFLICT(stock) DO UPDATE SET name=excluded.name, "
          "price=excluded.price, mtime=excluded.mtime",
          (code, name, price, mtime))


def prune():
    cutoff = int(time.time()) - 8 * 86400
    execw("DELETE FROM samples WHERE ts < ?", (cutoff,))


# ---------------- Yahoo 数据 ----------------
def yahoo_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def _parse_chart(d):
    r = d["chart"]["result"][0]
    meta = r.get("meta", {})
    ts = r.get("timestamp") or []
    vol = []
    if r.get("indicators"):
        vol = (r["indicators"]["quote"][0].get("volume") or [])
    # 过滤 vol<=0 的假 candle(午休/停牌时 Yahoo 返回连续 0 量占位),
    # 否则它们会污染「最近 N 根」的滚动窗口
    candles = [(t, v) for t, v in zip(ts, vol) if v is not None and v > 0]
    return meta, candles


def fetch_intraday(code):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.KL?interval=5m&range=1d"
    meta, candles = _parse_chart(yahoo_get(url))
    return {
        "code": code,
        "name": meta.get("longName") or meta.get("shortName") or code,
        "price": meta.get("regularMarketPrice"),
        "mtime": meta.get("regularMarketTime"),
        "candles": candles,
    }


def fetch_backfill(code):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.KL?interval=5m&range=5d"
    _, candles = _parse_chart(yahoo_get(url))
    return candles


# ---------------- 成交量计算 ----------------
def compute_volumes(code, window):
    """返回 (当前时段量, 上一时段量) 或 None (数据不足)."""
    row = qone("SELECT MAX(ts) m FROM samples WHERE stock=?", (code,))
    if not row or row["m"] is None:
        return None
    now = row["m"]

    if window == "1d":
        rows = q("SELECT ts, vol FROM samples WHERE stock=? AND ts > ? ORDER BY ts",
                 (code, now - 12 * 86400))
        buckets = {}
        for t, v in rows:
            d = datetime.fromtimestamp(t, MYT).strftime("%Y-%m-%d")
            buckets[d] = buckets.get(d, 0) + v
        dates = sorted(buckets.keys())
        if len(dates) < 2:
            return None
        current = buckets[dates[-1]]
        previous = buckets[dates[-2]]
        return current, previous

    n = WINDOW_CANDLES[window]  # 一个时段 = n 根 5 分钟 candle
    rows = q("SELECT vol FROM samples WHERE stock=? ORDER BY ts DESC LIMIT ?",
             (code, 2 * n))
    current = sum(r["vol"] for r in rows[:n])
    previous = sum(r["vol"] for r in rows[n:2 * n])
    return current, previous


def compute_metrics(cfg):
    out = []
    for w in cfg.get("watchlist", []):
        code = w["code"]
        name = w.get("name", code)
        live = qone("SELECT name, price, mtime FROM live WHERE stock=?", (code,))
        if live:
            name = live["name"] or name
        vol = compute_volumes(code, cfg["window"])
        cur = prev = ratio = None
        status = "nodata"
        if vol:
            cur, prev = vol
            if prev is not None and prev >= cfg["min_previous_volume"]:
                ratio = cur / prev * 100.0
                if cfg["direction"] == "surge":
                    status = "alert" if ratio >= cfg["threshold_percent"] else "ok"
                else:
                    status = "alert" if ratio <= cfg["threshold_percent"] else "ok"
            else:
                status = "low"
        out.append({
            "code": code, "name": name,
            "price": live["price"] if live else None,
            "mtime": live["mtime"] if live else None,
            "current": cur, "previous": prev, "ratio": ratio, "status": status,
        })
    return out


# ---------------- 告警引擎 ----------------
def evaluate_alerts(cfg):
    w = cfg["window"]
    now_s = int(time.time())
    cooldown = max(1, int(cfg["cooldown_minutes"])) * 60
    for m in compute_metrics(cfg):
        if m["status"] != "alert":
            execw("INSERT INTO state(stock, above, last_alert) VALUES(?,0,0) "
                  "ON CONFLICT(stock) DO UPDATE SET above=0", (m["code"],))
            continue
        st = qone("SELECT above, last_alert FROM state WHERE stock=?", (m["code"],))
        was_above = st["above"] if st else 0
        last_alert = st["last_alert"] if st else 0
        should = False
        if not was_above and (now_s - last_alert) >= cooldown:
            should = True
            last_alert = now_s
        execw("INSERT INTO state(stock, above, last_alert) VALUES(?,1,?) "
              "ON CONFLICT(stock) DO UPDATE SET above=1, last_alert=excluded.last_alert",
              (m["code"], last_alert))
        if should:
            insert_alert(m, w, cfg)
            send_telegram_alert(m, w, cfg)


def insert_alert(m, window, cfg):
    execw("INSERT INTO alerts(ts, stock, name, window, current, previous, ratio, direction) "
          "VALUES(?,?,?,?,?,?,?,?)",
          (int(time.time()), m["code"], m["name"], window, m["current"],
           m["previous"], round(m["ratio"], 1), cfg["direction"]))


def fmt_num(n):
    if n is None:
        return "0"
    if n >= 1e9:
        return f"{n/1e9:.2f}B"
    if n >= 1e6:
        return f"{n/1e6:.2f}M"
    if n >= 1e3:
        return f"{n/1e3:.1f}K"
    return str(int(n))


def send_telegram_alert(m, window, cfg):
    token = (cfg.get("telegram_bot_token") or "").strip()
    chat = (cfg.get("telegram_chat_id") or "").strip()
    if not token or not chat:
        return
    arrow = "📈 放量" if cfg["direction"] == "surge" else "📉 缩量"
    text = (f"{arrow}提醒 — {m['name']} ({m['code']}.KL)\n"
            f"时段: {window}  |  当前 {fmt_num(m['current'])} vs 上一时段 {fmt_num(m['previous'])}"
            f"  ({m['ratio']:.1f}%)\n"
            f"现价 {m['price'] if m['price'] else '-'}")
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        req = urllib.request.Request(url, data=data)
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log(f"telegram failed: {e}")


# ---------------- 市场时段 ----------------
def is_market_open():
    now = datetime.now(MYT)
    if now.weekday() >= 5:  # 周末
        return False
    hm = now.hour * 60 + now.minute
    return (9 * 60 <= hm < 12 * 60 + 30) or (14 * 60 + 30 <= hm < 16 * 60 + 50)


# ---------------- 调度线程 ----------------
class Scheduler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self._stop = threading.Event()
        self._polling = False
        self._backfilled = False
        self.last_poll = None

    def run(self):
        log("调度线程启动, 首次抓取数据...")
        self.do_poll(backfill=True)
        while not self._stop.is_set():
            cfg = load_config()
            interval = max(1, int(cfg.get("poll_interval_minutes", 10))) * 60
            if is_market_open():
                self.do_poll()
            self._stop.wait(interval)

    def do_poll(self, backfill=False):
        if self._polling:
            return
        self._polling = True
        try:
            cfg = load_config()
            watchlist = cfg.get("watchlist", [])
            if backfill and not self._backfilled:
                log(f"回填 5 日 candle ({len(watchlist)} 只)...")
                for w in watchlist:
                    try:
                        store_candles(w["code"], fetch_backfill(w["code"]))
                        time.sleep(0.25)
                    except Exception as e:
                        log(f"backfill {w['code']} 失败: {e}")
                self._backfilled = True
            for w in watchlist:
                try:
                    d = fetch_intraday(w["code"])
                    store_candles(w["code"], d["candles"])
                    if d["name"]:
                        update_live(w["code"], d["name"], d["price"], d["mtime"])
                    time.sleep(0.2)
                except Exception as e:
                    log(f"poll {w['code']} 失败: {e}")
            evaluate_alerts(cfg)
            prune()
            self.last_poll = time.time()
            log(f"轮询完成 ({len(watchlist)} 只)  {datetime.now(MYT).strftime('%H:%M:%S')}")
        finally:
            self._polling = False


scheduler = Scheduler()


# ---------------- HTTP ----------------
def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def build_state():
    cfg = load_config()
    metrics = compute_metrics(cfg)
    alerts = [dict(r) for r in q(
        "SELECT id, ts, stock, name, window, current, previous, ratio, direction "
        "FROM alerts ORDER BY id DESC LIMIT 100")]
    return {
        "settings": {k: cfg[k] for k in
                     ("poll_interval_minutes", "window", "threshold_percent",
                      "direction", "min_previous_volume", "cooldown_minutes",
                      "telegram_bot_token", "telegram_chat_id")},
        "watchlist": cfg.get("watchlist", []),
        "stocks": metrics,
        "alerts": alerts,
        "status": {
            "market_open": is_market_open(),
            "last_poll": scheduler.last_poll,
            "polling": scheduler._polling,
            "now": int(time.time()),
            "windows": list(WINDOW_CANDLES.keys()) + ["1d"],
        },
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        try:
            self._get()
        except Exception as e:
            log(f"GET {self.path} 错误: {e}")
            self._send(500, json_bytes({"error": str(e)}))

    def _get(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            try:
                with open(os.path.join(PUBLIC_DIR, "index.html"), "rb") as f:
                    self._send(200, f.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                self._send(404, b"index.html not found", "text/plain")
            return
        if path == "/api/state":
            self._send(200, json_bytes(build_state()))
            return
        self._send(404, json_bytes({"error": "not found"}))

    def do_POST(self):
        try:
            self._post()
        except Exception as e:
            log(f"POST {self.path} 错误: {e}")
            self._send(500, json_bytes({"error": str(e)}))

    def _post(self):
        path = self.path.split("?")[0]
        body = self._read_json()

        if path == "/api/settings":
            cfg = load_config()
            for k in DEFAULTS:
                if k in body and body[k] is not None:
                    cfg[k] = body[k]
            save_config(cfg)
            # 阈值/窗口变了, 重置告警状态以免误报
            execw("DELETE FROM state")
            self._send(200, json_bytes({"ok": True}))
            return

        if path == "/api/watchlist/add":
            code = str(body.get("code", "")).strip().upper().replace(".KL", "")
            if not re.match(r"^\d{1,5}$", code):
                self._send(400, json_bytes({"error": "股票代码格式不对 (纯数字, 如 1155)"}))
                return
            cfg = load_config()
            if any(w["code"] == code for w in cfg["watchlist"]):
                self._send(200, json_bytes({"ok": True, "dup": True}))
                return
            name = code
            try:
                d = fetch_intraday(code)
                name = d["name"]
                store_candles(code, d["candles"])
                update_live(code, name, d["price"], d["mtime"])
            except Exception:
                # 抓不到数据也先加入(可能代码有误, 稍后可删)
                name = code
            cfg["watchlist"].append({"code": code, "name": name})
            save_config(cfg)
            self._send(200, json_bytes({"ok": True, "name": name}))
            return

        if path == "/api/watchlist/remove":
            code = str(body.get("code", "")).strip()
            cfg = load_config()
            cfg["watchlist"] = [w for w in cfg["watchlist"] if w["code"] != code]
            save_config(cfg)
            execw("DELETE FROM samples WHERE stock=?", (code,))
            execw("DELETE FROM state WHERE stock=?", (code,))
            self._send(200, json_bytes({"ok": True}))
            return

        if path == "/api/poll":
            threading.Thread(target=scheduler.do_poll, daemon=True).start()
            self._send(200, json_bytes({"ok": True}))
            return

        self._send(404, json_bytes({"error": "not found"}))


def main():
    # 首次运行生成 config.json
    if not os.path.exists(CONFIG_PATH):
        save_config(dict(DEFAULTS, watchlist=[{"code": c, "name": n} for c, n in DEFAULT_WATCHLIST]))
    scheduler.start()
    # 禁用端口复用: Windows 下 SO_REUSEADDR 会让多个实例同时监听同一端口,
    # 导致旧进程(旧代码)继续响应请求。关闭后才能让重复启动真正 bind 失败。
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError as e:
        log(f"端口 {PORT} 已被占用(可能已在运行), 本实例退出: {e}")
        return
    log(f"KLSE Volume Tracker 已启动 → http://localhost:{PORT}")
    log(f"自选股 {len(load_config()['watchlist'])} 只, 轮询间隔 {load_config()['poll_interval_minutes']} 分钟")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("已停止")


if __name__ == "__main__":
    main()
