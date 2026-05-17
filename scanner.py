"""
Confluence Screener — GitHub Actions Scanner
Runs automatically:
  6:00 AM ET  → Pre-market scan
  9:45 AM ET  → Market open scan
  Every 30min → JAX monitor (9:30am-4pm ET)

Pushes results to Firebase → phone gets notified
"""

import os, time, json, requests
from datetime import datetime
import pytz

# ── Config ────────────────────────────────────────────────────────────────────
TD_KEYS   = os.environ.get("TD_KEYS", "").split(",")
FH_KEY    = os.environ.get("FH_KEY", "")
DB_URL    = os.environ.get("FIREBASE_DB_URL", "").rstrip("/")
SCAN_TYPE = os.environ.get("SCAN_TYPE", "jax_monitor")
ET        = pytz.timezone("America/New_York")

print(f"=== Confluence Screener [{SCAN_TYPE.upper()}] ===")
print(f"Time: {datetime.now(ET).strftime('%Y-%m-%d %H:%M ET')}")
print(f"Keys: {len(TD_KEYS)} Twelve Data keys")

# ── Watchlist & Universe ──────────────────────────────────────────────────────
WATCHLIST = [
    "SOFI","NKE","AAPL","NVDA","AMD","TSLA","META","GOOGL",
    "MSFT","AMZN","JPM","BAC","PLTR","CRWD","UBER","HOOD",
    "INTC","NOK","CELH","F","NOW","UPST","OUST","VNET"
]

CATALYST_UNIVERSE = [
    # Quantum/AI
    "QUBT","IONQ","RGTI","SOUN","BBAI","ARQQ","QBTS","CRKN",
    # Defense/Gov
    "MRAM","KTOS","AVAV","RCAT","ACHR","JOBY","ASTS","LUNR",
    # Biotech
    "MGNX","RXRX","DNLI","BEAM","EDIT","CRSP","NTLA","VERV","NUVL","HIMS",
    "OCGN","NVAX","VXRT","INO","BLUE","ARVN","TGTX","IOVA","APLS","FOLD",
    # Semiconductors
    "NVTS","AMPX","AAOI","COHU","FORM","ONTO","ACMR","POWI","AEVA","OUST",
    # Clean Energy
    "BLNK","CHPT","EVGO","STEM","ARRY","NOVA","FLNC","FCEL","PLUG","CLSK",
    # Fintech
    "SOFI","HOOD","AFRM","UPST","DAVE","LMND","ROOT","DKNG","MSTR","IREN",
    # Mid-Cap
    "CRWD","DDOG","GTLB","BILL","DOCS","BRZE","CFLT","TDOC","TMDX","NVCR",
    # Comm Services
    "DISH","LUMN","VSAT","IRDM","GSAT","OOMA","GOGO","CLFD",
    # Fiber/Optical
    "LITE","CIEN","INFN","CRDO","POET","ADTN","FYBR","CALX","VIAV","AAOI",
]

# ── API helpers ───────────────────────────────────────────────────────────────
key_idx = [0]

def get_candles(sym, retries=3):
    for attempt in range(retries):
        key = TD_KEYS[key_idx[0] % len(TD_KEYS)]
        url = f"https://api.twelvedata.com/time_series?symbol={sym}&interval=1day&outputsize=120&apikey={key}"
        try:
            r = requests.get(url, timeout=10)
            d = r.json()
            if d.get("status") == "error":
                msg = d.get("message","")
                if "credits" in msg:
                    key_idx[0] += 1
                    time.sleep(2)
                    continue
                return None
            vals = list(reversed(d.get("values", [])))
            if not vals:
                return None
            return {
                "closes":  [float(v["close"])  for v in vals],
                "highs":   [float(v["high"])   for v in vals],
                "lows":    [float(v["low"])    for v in vals],
                "volumes": [float(v.get("volume",0)) for v in vals],
            }
        except Exception as e:
            print(f"  Candle error {sym}: {e}")
            time.sleep(1)
    return None

def get_quote(sym):
    try:
        url = f"https://finnhub.io/api/v1/quote?symbol={sym}&token={FH_KEY}"
        r = requests.get(url, timeout=8)
        d = r.json()
        if not d or not d.get("c"):
            return None
        return {
            "price":    d["c"],
            "prev":     d["pc"],
            "change":   d.get("d", 0),
            "changePct": d.get("dp", 0),
            "high":     d.get("h", 0),
            "low":      d.get("l", 0),
        }
    except:
        return None

def get_earnings(sym):
    try:
        today = datetime.now(ET).strftime("%Y-%m-%d")
        future = datetime.now(ET)
        future = future.replace(day=min(future.day+30, 28))
        future_str = future.strftime("%Y-%m-%d")
        url = f"https://finnhub.io/api/v1/calendar/earnings?from={today}&to={future_str}&symbol={sym}&token={FH_KEY}"
        r = requests.get(url, timeout=8)
        d = r.json()
        earnings = d.get("earningsCalendar", [])
        if earnings:
            e = earnings[0]
            days = (datetime.strptime(e["date"], "%Y-%m-%d") - datetime.now(ET).replace(tzinfo=None)).days
            return {"date": e["date"], "daysUntil": max(0, days)}
        return None
    except:
        return None

# ── Indicators ────────────────────────────────────────────────────────────────
def calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    ag = al = 0
    for i in range(1, period + 1):
        d = closes[i] - closes[i-1]
        if d >= 0: ag += d
        else: al -= d
    ag /= period
    al /= period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i-1]
        ag = (ag * (period - 1) + max(d, 0)) / period
        al = (al * (period - 1) + max(-d, 0)) / period
    return 100 - 100 / (1 + ag / al) if al != 0 else 100

def calc_ema(closes, period=21):
    if len(closes) < period:
        return closes[-1] if closes else 0
    k = 2 / (period + 1)
    e = sum(closes[:period]) / period
    for c in closes[period:]:
        e = c * k + e * (1 - k)
    return e

def calc_atr(highs, lows, closes, period=14):
    if len(closes) < period + 1:
        return {"currentATR": 0, "avgATR20": 0, "isCoiling": False}
    trs = []
    for i in range(1, len(closes)):
        tr = max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
        trs.append(tr)
    if len(trs) < period:
        return {"currentATR": 0, "avgATR20": 0, "isCoiling": False}
    current_atr = sum(trs[-period:]) / period
    avg_atr = sum(trs[-20:]) / min(len(trs), 20) if len(trs) >= 20 else current_atr
    return {
        "currentATR": current_atr,
        "avgATR20": avg_atr,
        "isCoiling": current_atr < avg_atr
    }

def calc_supertrend(highs, lows, closes, factor=1.5, period=10):
    if len(closes) < period + 2:
        return {"bullish": False, "flipped": False}
    trs = [max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
           for i in range(1, len(closes))]
    def get_atr(idx):
        sl = trs[max(0, idx-period):idx]
        return sum(sl)/len(sl) if sl else 0
    trail, tdir = closes[0], 0
    history = []
    for i in range(1, len(closes)):
        atr = get_atr(i)
        hl2 = (highs[i] + lows[i]) / 2
        ub = hl2 + factor * atr
        lb = hl2 - factor * atr
        prev_trail = trail
        if tdir == 1:
            trail = max(trail, lb)
            if closes[i] < trail:
                tdir = -1
                trail = ub
        else:
            trail = min(trail, ub)
            if closes[i] > trail:
                tdir = 1
                trail = lb
        history.append({"dir": tdir})
    bullish = history[-1]["dir"] == 1 if history else False
    flipped = len(history) >= 2 and history[-1]["dir"] == 1 and history[-2]["dir"] == -1
    return {"bullish": bullish, "flipped": flipped}

def calc_atr_trail(highs, lows, closes, period=10, mult=3.5):
    if len(closes) < period + 2:
        return {"utBuy": False, "utSell": False, "dir": 0}
    trs = [max(highs[i]-lows[i], abs(highs[i]-closes[i-1]), abs(lows[i]-closes[i-1]))
           for i in range(1, len(closes))]
    def get_atr(idx):
        sl = trs[max(0, idx-period):idx]
        return sum(sl)/len(sl) if sl else 0
    trail, tdir = closes[0], 0
    prev_tdir = 0
    for i in range(1, len(closes)):
        atr_v = get_atr(i)
        nl = mult * atr_v
        prev = trail
        if closes[i] > trail and closes[i-1] > trail:
            trail = max(trail, closes[i] - nl)
        elif closes[i] < trail and closes[i-1] < trail:
            trail = min(trail, closes[i] + nl)
        elif closes[i] > trail:
            trail = closes[i] - nl
        else:
            trail = closes[i] + nl
        prev_tdir = tdir
        tdir = 1 if trail > prev else (-1 if trail < prev else tdir)
    ut_buy  = tdir == 1  and prev_tdir == -1
    ut_sell = tdir == -1 and prev_tdir == 1
    return {"utBuy": ut_buy, "utSell": ut_sell, "dir": tdir}

def calc_jax(closes, highs, lows):
    if len(closes) < 70:
        return None
    ema20 = calc_ema(closes, 20)
    ema40 = calc_ema(closes, 40)
    ema60 = calc_ema(closes, 60)
    price = closes[-1]
    rsi   = calc_rsi(closes, 14)
    hh = max(highs[-14:])
    ll = min(lows[-14:])
    wr = ((hh - price) / (hh - ll)) * -100 if hh != ll else -50
    macd_fast = calc_ema(closes, 12)
    macd_slow = calc_ema(closes, 26)
    macd_hist = macd_fast - macd_slow
    st  = calc_supertrend(highs, lows, closes, 1.5, 10)
    atr = calc_atr_trail(highs, lows, closes, 10, 3.5)

    ema_stack  = ema20 > ema40 and ema40 > ema60 and price > ema20
    macd_bull  = macd_hist > 0
    rsi_bull   = rsi > 50
    wr_bull    = wr > -50
    st_bull    = st["bullish"]
    bull_score = sum([ema_stack, macd_bull, rsi_bull, wr_bull, st_bull])

    green_arrow = (atr["utBuy"] or st["flipped"]) and bull_score >= 1 and rsi < 70
    return {
        "greenArrow": green_arrow,
        "bullScore":  bull_score,
        "utBuy":      atr["utBuy"],
        "stFlipped":  st["flipped"],
        "emaStack":   ema_stack,
        "macdBull":   macd_bull,
        "rsiBull":    rsi_bull,
        "wrBull":     wr_bull,
        "stBull":     st_bull,
        "rsi":        rsi,
    }

# ── Firebase push ─────────────────────────────────────────────────────────────
def fb_push(path, data):
    try:
        url = f"{DB_URL}/{path}.json"
        r = requests.put(url, json=data, timeout=10)
        return r.status_code == 200
    except Exception as e:
        print(f"Firebase error: {e}")
        return False

def fb_get(path):
    try:
        url = f"{DB_URL}/{path}.json"
        r = requests.get(url, timeout=10)
        return r.json()
    except:
        return None

# ── Notification via Firebase ─────────────────────────────────────────────────
def send_alert(sym, title, body, alert_type="jax"):
    alert = {
        "sym":       sym,
        "title":     title,
        "body":      body,
        "type":      alert_type,
        "timestamp": datetime.now(ET).isoformat(),
        "read":      False
    }
    key = f"alerts/{sym}_{int(time.time())}"
    fb_push(f"screener/{key}", alert)
    print(f"🔔 ALERT: {title}")

# ══════════════════════════════════════════════════════════════════════════════
# SCAN FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

def run_jax_monitor():
    """Check Catalyst Universe for JAX green arrow signals"""
    print(f"\n── JAX MONITOR ({len(CATALYST_UNIVERSE)} stocks) ──")
    alerts_fired = []

    for sym in CATALYST_UNIVERSE:
        print(f"  Checking {sym}...", end=" ")
        candles = get_candles(sym)
        if not candles:
            print("skip")
            continue

        jax = calc_jax(candles["closes"], candles["highs"], candles["lows"])
        if not jax:
            print("need more data")
            continue

        if jax["greenArrow"]:
            quote = get_quote(sym)
            price = quote["price"] if quote else candles["closes"][-1]
            print(f"🟢 GREEN ARROW! bull:{jax['bullScore']}/5 ${price:.2f}")
            send_alert(
                sym,
                f"🟢 {sym} JAX GREEN ARROW — Enter Now",
                f"${price:.2f} · Bull {jax['bullScore']}/5 · {'UTBuy' if jax['utBuy'] else 'ST Flip'}",
                "jax"
            )
            alerts_fired.append(sym)
        else:
            print(f"bull:{jax['bullScore']}/5 RSI:{jax['rsi']:.0f}")

        time.sleep(1.5)  # rate limit

    print(f"\nJAX monitor complete — {len(alerts_fired)} signals: {alerts_fired}")
    fb_push("screener/jax_last_run", {
        "time":    datetime.now(ET).isoformat(),
        "signals": alerts_fired,
        "scanned": len(CATALYST_UNIVERSE),
        "scanType": SCAN_TYPE
    })

def run_premarket_scan():
    """6am pre-market scan — check Catalyst Universe for movers"""
    print(f"\n── PRE-MARKET SCAN 6AM ({len(CATALYST_UNIVERSE)} stocks) ──")
    alerts = []
    MIN_MOVE = 3.0  # 3%+ pre-market move

    for sym in CATALYST_UNIVERSE:
        print(f"  {sym}...", end=" ")
        quote = get_quote(sym)
        if not quote or not quote["price"]:
            print("skip")
            continue

        change_pct = quote.get("changePct", 0)
        price      = quote["price"]

        if abs(change_pct) >= MIN_MOVE:
            direction = "▲" if change_pct > 0 else "▼"
            print(f"🔔 {direction}{abs(change_pct):.1f}% ${price:.2f}")

            # Get earnings
            earnings = get_earnings(sym)
            earn_str = f" · 📅 earnings {earnings['daysUntil']}d" if earnings else ""

            send_alert(
                sym,
                f"🌅 {sym} {direction}{abs(change_pct):.1f}% PRE-MARKET",
                f"${price:.2f} (prev ${quote['prev']:.2f}){earn_str}",
                "premarket"
            )
            alerts.append({
                "sym": sym, "price": price,
                "changePct": change_pct,
                "prev": quote["prev"],
                "earnings": earnings
            })
        else:
            print(f"{change_pct:+.1f}%")

        time.sleep(0.5)

    # Save session to Firebase
    fb_push("screener/alerts_premarket", {
        "data":    json.dumps(alerts),
        "savedAt": datetime.now(ET).isoformat(),
        "device":  "github-actions"
    })
    print(f"\nPre-market scan complete — {len(alerts)} movers")

def run_market_open_scan():
    """9:45am market open scan — check for volume + momentum confirmation"""
    print(f"\n── MARKET OPEN SCAN 9:45AM ({len(CATALYST_UNIVERSE)} stocks) ──")
    alerts = []
    MIN_MOVE = 4.0

    for sym in CATALYST_UNIVERSE:
        print(f"  {sym}...", end=" ")
        quote = get_quote(sym)
        if not quote:
            print("skip")
            continue

        change_pct = quote.get("changePct", 0)
        price      = quote["price"]

        if abs(change_pct) >= MIN_MOVE:
            direction = "▲" if change_pct > 0 else "▼"
            print(f"🟢 {direction}{abs(change_pct):.1f}% ${price:.2f}")

            # Also get JAX for this stock
            candles = get_candles(sym)
            jax_str = ""
            if candles:
                jax = calc_jax(candles["closes"], candles["highs"], candles["lows"])
                if jax and jax["greenArrow"]:
                    jax_str = " · 🟢 JAX CONFIRMED"

            send_alert(
                sym,
                f"🟢 {sym} {direction}{abs(change_pct):.1f}% MARKET OPEN{jax_str}",
                f"${price:.2f} · hi ${quote['high']:.2f} · lo ${quote['low']:.2f}",
                "market_open"
            )
            alerts.append({
                "sym": sym, "price": price,
                "changePct": change_pct,
                "high": quote["high"], "low": quote["low"]
            })
        else:
            print(f"{change_pct:+.1f}%")

        time.sleep(0.5)

    # Save to Firebase
    fb_push("screener/alerts_open", {
        "data":    json.dumps(alerts),
        "savedAt": datetime.now(ET).isoformat(),
        "device":  "github-actions"
    })
    print(f"\nMarket open scan complete — {len(alerts)} movers")

def run_full_catalyst():
    """Full catalyst scan with ATR + RVOL scoring"""
    print(f"\n── FULL CATALYST SCAN ({len(CATALYST_UNIVERSE)} stocks) ──")
    results = []

    for i, sym in enumerate(CATALYST_UNIVERSE):
        print(f"  [{i+1}/{len(CATALYST_UNIVERSE)}] {sym}...", end=" ")
        candles = get_candles(sym)
        if not candles:
            print("skip")
            time.sleep(1)
            continue

        closes  = candles["closes"]
        highs   = candles["highs"]
        lows    = candles["lows"]
        volumes = candles["volumes"]

        if len(closes) < 30:
            print("not enough data")
            continue

        price    = closes[-1]
        prev     = closes[-2]
        change   = (price - prev) / prev * 100
        avg_vol  = sum(volumes[-21:-1]) / 20 if len(volumes) > 21 else 0
        today_vol= volumes[-1]
        vol_spike= today_vol / avg_vol if avg_vol > 0 else 0
        vol_dry  = (sum(volumes[-6:-1]) / 5) < avg_vol * 0.6

        atr_data = calc_atr(highs, lows, closes)
        rsi      = calc_rsi(closes, 14)
        high52   = max(highs)
        low52    = min(lows)
        pct_hi   = (price - high52) / high52 * 100

        # ATR coiling
        atr_coiling = atr_data["isCoiling"]

        # Flat days
        flat_days = 0
        for j in range(len(closes)-2, -1, -1):
            if abs(closes[j] - price) / price < 0.06:
                flat_days += 1
            else:
                break

        # Breakout
        high20   = max(highs[-21:-1]) if len(highs) > 21 else high52
        breakout = price > high20 * 1.02

        # Earnings
        earnings = get_earnings(sym)
        has_earn = earnings and earnings["daysUntil"] <= 14

        # JAX
        jax = calc_jax(closes, highs, lows)
        green_arrow = jax["greenArrow"] if jax else False

        # Score
        c1 = 2 <= price <= 150
        c2 = atr_coiling or (flat_days >= 8)
        c3 = vol_dry or vol_spike >= 2
        c4 = has_earn or breakout or change > 8
        c5 = pct_hi < -20
        c6 = rsi < 55
        score = sum([c1, c2, c3, c4, c5, c6])

        heat = score
        if green_arrow: heat += 3
        if atr_coiling and vol_dry: heat += 2
        if has_earn: heat += 1

        status = "ok" if score >= 3 else "skip"
        print(f"score:{score}/6 heat:{heat} {'🟢 JAX' if green_arrow else ''}")

        if score >= 3 or green_arrow:
            result = {
                "sym": sym, "price": price, "change": change,
                "score": score, "heat": heat,
                "atrCoiling": atr_coiling, "volDryUp": vol_dry,
                "volSpike": round(vol_spike, 2), "flatDays": flat_days,
                "breakout": breakout, "rsi": round(rsi, 1),
                "hasEarnings": has_earn,
                "earningsDays": earnings["daysUntil"] if earnings else 999,
                "pctFromHigh": round(pct_hi, 1),
                "greenArrow": green_arrow,
                "bullScore": jax["bullScore"] if jax else 0,
                "status": "🚀🟢 IGNITION+JAX" if green_arrow and vol_spike >= 2 else
                         "🟢 JAX" if green_arrow else
                         "🔥🔥🔥 FIRE" if heat >= 8 else
                         "🔥🔥 HOT" if heat >= 6 else "🔥 WARM"
            }
            results.append(result)

            # Fire alert for high conviction
            if heat >= 7 or green_arrow:
                send_alert(
                    sym,
                    f"{result['status']} {sym} — Score {score}/6 Heat {heat}",
                    f"${price:.2f} · {'📅 earnings '+str(earnings['daysUntil'])+'d · ' if has_earn else ''}{'🔇 vol dry · ' if vol_dry else ''}{'🔄 coiling' if atr_coiling else ''}",
                    "catalyst"
                )

        key_idx[0] = (key_idx[0] + 1) % len(TD_KEYS)
        time.sleep(2)

    # Sort by heat
    results.sort(key=lambda x: x["heat"], reverse=True)

    # Save to Firebase
    fb_push("screener/catalyst", {
        "data":    json.dumps(results),
        "savedAt": datetime.now(ET).isoformat(),
        "device":  "github-actions"
    })
    print(f"\nCatalyst scan complete — {len(results)} setups found")
    print("Top 5:")
    for r in results[:5]:
        print(f"  {r['sym']:6} {r['status']} score:{r['score']}/6 heat:{r['heat']}")

# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Clean keys — strip whitespace and filter empty
    TD_KEYS[:] = [k.strip() for k in TD_KEYS if k.strip()]
    if not TD_KEYS:
        print("ERROR: TD_KEYS secret not set or empty")
        print("Expected: key1,key2,key3 (no spaces)")
        exit(1)
    if not FH_KEY.strip():
        print("ERROR: FH_KEY secret not set")
        exit(1)
    if not DB_URL.strip():
        print("ERROR: FIREBASE_DB_URL secret not set")
        exit(1)
    print(f"Keys loaded: {len(TD_KEYS)}")
    print(f"Firebase: {DB_URL[:40]}...")

    print(f"Scan type: {SCAN_TYPE}")
    print(f"Firebase: {DB_URL}")

    if SCAN_TYPE == "premarket":
        run_premarket_scan()
    elif SCAN_TYPE == "market_open":
        run_market_open_scan()
    elif SCAN_TYPE == "full_catalyst":
        run_full_catalyst()
    else:
        run_jax_monitor()

    print("\n=== Done ===")
