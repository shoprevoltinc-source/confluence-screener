// breakout-classify.js
// LAYER 1 — Daily Breakout Setup Scorer (GitHub Actions)
// Reads screener/* sources (same universe as weinstein-classify) → fetches daily candles
// per ticker → scores the SETUP per breakout-scanner-spec.md → writes breakout/setups +
// breakout/watchlist. The 4H trigger (breakout-trigger.js) consumes the watchlist later.
//
// Mirrors weinstein-classify.js conventions exactly: fbRequest/parseFirebaseNode/readSources,
// TwelveData via TD_KEYS, --source/--top/--dry-run args, Telegram summary.
//
// Usage:
//   node breakout-classify.js                 ← full universe (recovery+catalyst+jax+weekly)
//   node breakout-classify.js --top 50        ← cap universe (testing — fewer candle fetches)
//   node breakout-classify.js --source jax    ← single source
//   node breakout-classify.js --dry-run       ← score but don't write

"use strict";

const https = require("https");

// ── Config (identical env contract to weinstein-classify) ─────────────────────
const FIREBASE_URL   = process.env.FIREBASE_URL;
const FIREBASE_TOKEN = process.env.FIREBASE_TOKEN || "";
const TD_KEY         = process.env.TD_KEYS ? process.env.TD_KEYS.split(",")[0].trim()
                                           : "c05d8242562f496e8709d5c9e0ce4109";

// ── Args ──────────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i+1] ? args[i+1] : def; };
const hasArg = (flag)      => args.includes(flag);

const SOURCE  = getArg("--source", "all");
const TOP_RAW = (getArg("--top", "all") || "all").trim();
// 'all' or any non-numeric (e.g. NaN from a stray space) → whole universe
const TOP_N   = (TOP_RAW.toLowerCase() === "all" || isNaN(parseInt(TOP_RAW, 10)))
                  ? 9999 : parseInt(TOP_RAW, 10);
const DRY_RUN = hasArg("--dry-run");
const DELAY   = 300; // ms between candle fetches — your standard Grow-plan delay

if (!FIREBASE_URL) { console.error("❌ FIREBASE_URL env var not set"); process.exit(1); }

// ── Spec constants (must match breakout-scanner-spec.md + breakout-tab.html) ───
const K = {
  PRICE_FLOOR:10, FRESH_MAX_ATR:2.5, RVOL_FULL:2.5, WATCHLIST_MIN_SCORE:60,
  WATCHLIST_CAP:40, MIN_BASE_WEEKS:5, BASE_DEPTH_TIGHT:0.15, CONTRACTION_STRONG:0.60,
  DOLLARVOL_MIN:5e6, VOL_MIN:500000
  // NOTE: MCAP_MIN gate is intentionally omitted — market cap needs the TwelveData
  // fundamentals endpoint (build-queue #11), not yet wired. Dollar-volume gate covers
  // liquidity in the meantime. Add the mcap gate once fundamentals are live.
};
const clamp = x => Math.max(0, Math.min(1, x));

// ── HTTP helpers (verbatim from weinstein-classify) ───────────────────────────
function fbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const base = FIREBASE_URL.replace(/\/$/, "");
    const auth = FIREBASE_TOKEN ? `?auth=${FIREBASE_TOKEN}` : "";
    const url  = new URL(`${base}/${path}.json${auth}`);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname, path: url.pathname + url.search, method,
      headers: { "Content-Type": "application/json", ...(data && { "Content-Length": Buffer.byteLength(data) }) }
    };
    const req = https.request(opts, res => {
      let raw = ""; res.on("data", c => raw += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0,200)}`));
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const fbRead  = p      => fbRequest("GET", p, null);
const fbWrite = (p, b) => fbRequest("PUT", p, b);

// ── TwelveData: one daily series per ticker (oldest→newest) ───────────────────
// outputsize 160 covers: ATR-then (~60 bars ago), 6-month RS, base window, 20/50 SMA.
function fetchDailySeries(sym) {
  return new Promise(resolve => {
    const path = `/v1/time_series?symbol=${encodeURIComponent(sym)}&interval=1day&outputsize=160&apikey=${TD_KEY}`;
    const req = https.request({ hostname: "api.twelvedata.com", path, method: "GET",
      headers: { "Content-Type": "application/json" } }, res => {
      let raw = ""; res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const d = JSON.parse(raw);
          if (d.status === "error" || !d.values || !d.values.length) return resolve(null);
          // TD returns newest-first → reverse to oldest-first
          const bars = d.values.slice().reverse().map(v => ({
            open:+v.open, high:+v.high, low:+v.low, close:+v.close, volume:+v.volume
          })).filter(b => b.close > 0);
          resolve(bars.length >= 60 ? bars : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ── Indicator math ────────────────────────────────────────────────────────────
const sma = (arr, n) => arr.slice(-n).reduce((a,b)=>a+b,0) / Math.min(n, arr.length);
function ema(closes, n) {
  const k = 2/(n+1); let e = closes[0];
  for (let i=1;i<closes.length;i++) e = closes[i]*k + e*(1-k);
  return e;
}
function atrSeries(bars, n=14) {
  const tr = [];
  for (let i=1;i<bars.length;i++) {
    const h=bars[i].high, l=bars[i].low, pc=bars[i-1].close;
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  const out=[]; let prev=null;
  for (let i=0;i<tr.length;i++){
    if (i < n) { if (i===n-1){ prev = tr.slice(0,n).reduce((a,b)=>a+b,0)/n; out[i]=prev; } else out[i]=null; }
    else { prev = (prev*(n-1) + tr[i]) / n; out[i]=prev; }
  }
  return out; // aligned to bars[1..]
}
const perf = (closes, back) => closes.length>back ? (closes.at(-1)-closes.at(-1-back))/closes.at(-1-back) : 0;

// ── Reuse your exact stage logic for the Stage-2 gate ─────────────────────────
function classifyWeeklyStage(s) {
  const wRsi=s.weeklyRsi||0, wBull=s.weeklyBullish===true||s.weeklyBullish===1,
        wJAX=s.weeklyJAX===true||s.weeklyJAX===1, wJAXr=s.weeklyJAXRecent===true||s.weeklyJAXRecent===1;
  if (wBull && wRsi>74) return 3;
  if (wBull && (wJAX||wJAXr) && wRsi>=48 && wRsi<=74) return 2;
  if (wBull && wRsi>=48 && wRsi<=74) return 2;
  if (wBull && wRsi>=40 && wRsi<48) return 1;
  if (!wBull && wRsi>=44 && wRsi<=56) return 1;
  if (!wBull && wRsi<44) return 5;
  if (!wBull && wRsi<36) return 6;
  return wBull ? 2 : 1;
}
function classifyDailyStage(s) {
  const rsi=s.rsi||0, dJAX=s.dailyJAX===true||s.dailyJAX===1||s.greenArrow===true||s.greenArrow===1,
        emaRising=s.emaRising===true||s.emaRising===1, above200=s.dailyAbove200===true||s.dailyAbove200===1,
        price=s.price||0, trail=s.dailyTrail||s.trailVal||0, trailBull=trail>0&&trail<price;
  if (dJAX && rsi>=48 && rsi<=70 && (emaRising||trailBull)) return 2;
  if (above200 && rsi>70 && (emaRising||trailBull)) return 3;
  if (!dJAX && rsi>=44 && rsi<=58 && emaRising) return 1;
  if (above200 && rsi>=55 && !dJAX && !emaRising) return 4;
  if (above200 && rsi>=44 && rsi<55 && !dJAX) return 1;
  if (!above200 && rsi>=40) return 5;
  if (!above200 && rsi<40) return 6;
  return above200 ? 1 : 5;
}

// ── Build the metric bundle the scorer needs ──────────────────────────────────
function buildMetrics(bars, spyCloses, s) {
  const closes = bars.map(b=>b.close), vols = bars.map(b=>b.volume);
  const close  = closes.at(-1);
  const sma20=sma(closes,20), sma50=sma(closes,50), ema200=ema(closes,200);
  const atr = atrSeries(bars,14);
  const atrDaily = atr.at(-1) || 0;
  const atrThenIdx = atr.length-1-60;
  const atrThen = atrThenIdx>0 ? atr[atrThenIdx] : atr.find(x=>x!=null) || atrDaily;
  const atrRatio = atrThen ? atrDaily/atrThen : 1;

  // base window — last ~40 bars (≈8 weeks)
  const baseN = Math.min(40, bars.length);
  const baseBars = bars.slice(-baseN);
  const hi = Math.max(...baseBars.map(b=>b.high)), lo = Math.min(...baseBars.map(b=>b.low));
  const depth = lo>0 ? (hi-lo)/lo : 1;
  const baseWeeks = baseN/5;
  // successive contraction across the base (first third vs recent third)
  const third = Math.floor(baseN/3);
  const atrFirstThird  = sma(atr.slice(-baseN, -baseN+third).filter(x=>x!=null)||[atrDaily], third) || atrDaily;
  const atrRecentThird = sma(atr.slice(-third).filter(x=>x!=null)||[atrDaily], third) || atrDaily;

  // volume dry-up + accumulation over the base
  const baseVols = vols.slice(-baseN);
  const dryRatio = (sma(baseVols.slice(-10),10) || 1) / (sma(baseVols,baseN) || 1);
  let upVol=0, downVol=0;
  for (let i=bars.length-baseN+1; i<bars.length; i++){
    if (closes[i] >= closes[i-1]) upVol += vols[i]; else downVol += vols[i];
  }
  const accumRatio = downVol>0 ? upVol/downVol : 2;

  // relative strength vs SPY (uses existing pctHi for proximity)
  const rs1 = perf(closes,21)  - perf(spyCloses,21);
  const rs3 = perf(closes,63)  - perf(spyCloses,63);
  const rs6 = perf(closes,126) - perf(spyCloses,126);
  let rsLineHigh = false;
  if (spyCloses.length >= 60) {
    const n = Math.min(60, closes.length, spyCloses.length);
    const ratio = []; for (let i=1;i<=n;i++) ratio.push(closes.at(-i)/spyCloses.at(-i));
    rsLineHigh = ratio[0] >= Math.max(...ratio)*0.995;
  }

  // distance to pivot — prefer your existing % from 52w high (pctHi), else proxy
  const distPct = (s.pctHi!=null) ? Math.abs(s.pctHi) : Math.max(0,(hi-close)/hi*100);

  return { close, sma20, sma50, ema200, atrDaily, atrRatio, atrFirstThird, atrRecentThird,
           depth, baseWeeks, dryRatio, accumRatio, rs1, rs3, rs6, rsLineHigh, distPct,
           avg20Vol: sma(vols,20) };
}

// ── Layer 1 score (identical formulas to the spec + tab) ──────────────────────
function setupScore(m, stage) {
  const depthPts = clamp((0.35-m.depth)/(0.35-K.BASE_DEPTH_TIGHT))*10;
  const durPts   = clamp((m.baseWeeks-K.MIN_BASE_WEEKS)/(20-K.MIN_BASE_WEEKS))*4;
  const coilPts  = clamp((1.0-m.atrRatio)/(1.0-K.CONTRACTION_STRONG))*11;
  const tightPts = clamp((m.atrFirstThird-m.atrRecentThird)/(m.atrFirstThird||1)/0.30)*5;
  const base = depthPts+durPts+coilPts+tightPts;
  const dryPts   = clamp((1.0-m.dryRatio)/(1.0-0.6))*13;
  const accumPts = clamp((m.accumRatio-1.0)/(2.0-1.0))*12;
  const vol = dryPts+accumPts;
  const stagePts = (stage.weekly===2||stage.daily===2)?10:((stage.weekly===1||stage.daily===1)?5:0);
  let emaPts = (m.close>m.sma20 && m.close>m.sma50)?6:(m.close>m.sma50?3:0);
  emaPts += (m.sma50>m.ema200)?2:0;
  const trailPts = stage.weeklyTrailBull?2:0;
  const trend = Math.min(20, stagePts+emaPts+trailPts);
  const rs = (m.rs1>0?3:0)+(m.rs3>0?4:0)+(m.rs6>0?4:0)+(m.rsLineHigh?4:0);
  const prox = m.distPct<=0?10:clamp((10-m.distPct)/10)*10;
  return { total: base+vol+trend+rs+prox, base, vol, trend, rs, prox };
}
const starCount = s => s>=90?5:s>=75?4:s>=60?3:s>=45?2:1;

// ── Source reading (verbatim shape from weinstein-classify) ───────────────────
function parseFirebaseNode(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (val.data) {
    try { const d = typeof val.data==="string"?JSON.parse(val.data):val.data;
      return Array.isArray(d)?d:Object.values(d).filter(Boolean); } catch { return []; }
  }
  const keys=Object.keys(val), numKeys=keys.filter(k=>!isNaN(k));
  if (numKeys.length) return numKeys.map(k=>val[k]).filter(Boolean);
  return Object.values(val).filter(v=>v&&typeof v==="object"&&v.sym);
}
async function readSources(sourceArg) {
  const sources = sourceArg==="all"
    ? ["recovery","catalyst","jax_scan","weekly_monitor"]
    : sourceArg.split(",").map(s=>s.trim()).map(s=>
        s==="jax"?"jax_scan":s==="weekly"?"weekly_monitor":s);
  const combined=[], seen=new Set();
  for (const node of sources) {
    console.log(`📡 Reading screener/${node}...`);
    try {
      const items = parseFirebaseNode(await fbRead(`screener/${node}`));
      let added=0;
      for (const it of items){ if(!it.sym||seen.has(it.sym))continue; seen.add(it.sym); combined.push(it); added++; }
      console.log(`   ✅ ${node}: ${items.length} items, ${added} new`);
    } catch(e){ console.warn(`   ⚠️  ${node}: ${e.message}`); }
  }
  return combined;
}

// ── Telegram (verbatim) ───────────────────────────────────────────────────────
function sendTelegram(text){
  const token=process.env.TELEGRAM_BOT_TOKEN, chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId){ console.log("ℹ️  No Telegram credentials — skipping"); return Promise.resolve(); }
  return new Promise((res,rej)=>{
    const body=JSON.stringify({chat_id:chatId,text,parse_mode:"HTML"});
    const req=https.request({hostname:"api.telegram.org",path:`/bot${token}/sendMessage`,method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},
      r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(d));});
    req.on("error",rej); req.write(body); req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Breakout Classifier (Layer 1 — daily setup)`);
  console.log(`   Source: ${SOURCE} · Top: ${TOP_N===9999?"all":TOP_N} · Dry: ${DRY_RUN}\n`);

  // 1 — universe + your pre-computed fields
  const universe = (await readSources(SOURCE)).filter(s=>s.sym).slice(0, TOP_N);
  if (!universe.length) { console.error("❌ No tickers from Firebase."); process.exit(1); }
  console.log(`\n📊 Universe: ${universe.length} tickers`);

  // 2 — SPY once for relative strength
  console.log(`📡 Fetching SPY for relative strength...`);
  const spyBars = await fetchDailySeries("SPY");
  const spyCloses = spyBars ? spyBars.map(b=>b.close) : [];
  if (!spyCloses.length) console.warn("   ⚠️  SPY fetch failed — RS scores will be 0");

  // 3 — score each ticker from one candle fetch
  const setups = {};      // keyed by sym — shape the breakout tab reads directly
  let scored=0, gated=0;
  for (const s of universe) {
    const bars = await fetchDailySeries(s.sym);
    await new Promise(r=>setTimeout(r, DELAY));
    if (!bars) { continue; }

    const m = buildMetrics(bars, spyCloses, s);
    const stage = {
      weekly: classifyWeeklyStage(s), daily: classifyDailyStage(s),
      weeklyTrailBull: s.weeklyBullish===true||s.weeklyBullish===1
    };

    // gates
    const dollarVol = m.avg20Vol * m.close;
    const gateFail = m.close < K.PRICE_FLOOR || dollarVol < K.DOLLARVOL_MIN
                  || m.avg20Vol < K.VOL_MIN || m.close <= m.ema200 || stage.daily===4 || stage.weekly===4;
    if (gateFail) { gated++; continue; }

    const sc = setupScore(m, stage);
    if (sc.total < K.WATCHLIST_MIN_SCORE) continue; // below ★★★ — not a watch-list setup

    const stars = starCount(sc.total);
    const extended = m.close > m.sma20*1.20 || m.close > m.sma50*1.25;
    const tags = [];
    if (m.distPct <= 1) tags.push("52W_HIGH");
    tags.push("RANGE_BREAK");
    if (stage.weekly===2 && stage.daily<=1) tags.push("STAGE_1_2");
    const warnings = []; if (extended) warnings.push("EXTENDED");
    // earnings + OI warnings are added by the tab/trigger layer (need Finnhub/TD earnings, build-queue #4)

    const stack = [
      {k:"COIL",  on: m.atrRatio<=0.80},
      {k:"VOL",   on: m.dryRatio<1.0 && m.accumRatio>1.2},
      {k:"RS",    on: m.rs3>0},
      {k:"FRESH", on: !extended && m.distPct<=2},
      {k:"CLOSE", on: false},   // set by the 4H trigger when it fires
      {k:"TREND", on: (stage.weekly===2||stage.daily===2) && m.close>m.ema200},
      {k:"DAILY", on: false}    // set on daily-close confirmation
    ];

    setups[s.sym] = {
      sym: s.sym, close: +m.close.toFixed(2),
      tier: "WATCH",            // Layer 1 only produces WATCH; 4H trigger upgrades to EARLY/A+
      stars, setupScore: Math.round(sc.total),
      parts: { base:+sc.base.toFixed(1), vol:+sc.vol.toFixed(1), trend:+sc.trend.toFixed(1),
               rs:+sc.rs.toFixed(1), prox:+sc.prox.toFixed(1) },
      tags, warnings, stack,
      distPct:+m.distPct.toFixed(1), atr:+m.atrDaily.toFixed(2), extended,
      stage:`D${stage.daily}/W${stage.weekly}`
    };
    scored++;
    console.log(`   ⭐ ${s.sym.padEnd(6)} setup ${Math.round(sc.total)}  ${"★".repeat(stars)} ${tags.join(",")}`);
  }

  // 4 — watch list: top setups by score (what breakout-trigger.js will scan on 4H)
  const ranked = Object.values(setups).sort((a,b)=>b.setupScore-a.setupScore);
  const watchlist = ranked.slice(0, K.WATCHLIST_CAP).map(r=>r.sym);

  console.log(`\n📊 Scored ${scored} setups · ${gated} gated out · watchlist ${watchlist.length}`);

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN — top 10 setups:");
    ranked.slice(0,10).forEach(r=>console.log(`   ${r.sym.padEnd(6)} ${r.setupScore} ${r.tags.join(",")}`));
    return;
  }

  // 5 — write (keyed setups for the tab; watchlist for the trigger; meta separate)
  console.log(`\n💾 Writing breakout/setups, watchlist, meta...`);
  try {
    await fbWrite("breakout/setups", setups);
    await fbWrite("breakout/watchlist", { data: watchlist, updatedAt: new Date().toISOString() });
    await fbWrite("breakout/meta", {
      savedAt: new Date().toISOString(), device: "github-actions-breakout-classify",
      source: SOURCE, scored, gated, watchlistCount: watchlist.length
    });
    console.log(`✅ Done — ${scored} setups written`);

    const today = new Date().toLocaleDateString("en-US",{timeZone:"America/New_York",weekday:"short",month:"short",day:"numeric"});
    const top = ranked.slice(0,6).map(r=>`• <b>${r.sym}</b> $${r.close} · ${r.setupScore} ${"★".repeat(r.stars)} ${r.tags.join(",")}`).join("\n");
    const msg = `🚀 <b>BREAKOUT SETUPS — ${today}</b>\n`
      + `${scored} setups · ${gated} gated · watchlist ${watchlist.length}\n\n`
      + (top || "No qualifying setups today.");
    try { await sendTelegram(msg); console.log("✅ Telegram sent"); }
    catch(e){ console.warn("⚠️  Telegram failed:", e.message); }
  } catch(e) {
    console.error(`❌ Firebase write failed: ${e.message}`); process.exit(1);
  }
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
