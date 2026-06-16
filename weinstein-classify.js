// weinstein-classify.js
// Manual-trigger Weinstein Stage classifier
// Reads Firebase → classifies deterministically → Anthropic API for ENTER summaries → writes screener/weinstein
//
// Usage:
//   node weinstein-classify.js                        ← all sources (recovery + catalyst + jax + weekly)
//   node weinstein-classify.js --source jax           ← JAX only (green arrows)
//   node weinstein-classify.js --source weekly        ← weekly monitor only
//   node weinstein-classify.js --source jax,weekly    ← combined
//   node weinstein-classify.js --top 20               ← how many tickers to classify (default 25)
//   node weinstein-classify.js --dry-run              ← classify but don't write to Firebase

"use strict";

const https = require("https");

// ── Config ────────────────────────────────────────────────────────────────────
const FIREBASE_URL   = process.env.FIREBASE_URL;   // https://YOUR-PROJECT-default-rtdb.firebaseio.com
const FIREBASE_TOKEN = process.env.FIREBASE_TOKEN || ""; // optional — only needed if rules require auth
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

// ── Args ──────────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i+1] ? args[i+1] : def; };
const hasArg = (flag)      => args.includes(flag);

const SOURCE   = getArg("--source", "all");   // all | jax | weekly | recovery | catalyst | jax,weekly etc.
const TOP_N    = parseInt(getArg("--top", "25"), 10);
const DRY_RUN  = hasArg("--dry-run");

// ── Validation ────────────────────────────────────────────────────────────────
if (!FIREBASE_URL) { console.error("❌ FIREBASE_URL env var not set"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.warn("⚠️  ANTHROPIC_API_KEY not set — summaries will be skipped"); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const base = FIREBASE_URL.replace(/\/$/, "");
    const auth = FIREBASE_TOKEN ? `?auth=${FIREBASE_TOKEN}` : "";
    const url  = new URL(`${base}/${path}.json${auth}`);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  { "Content-Type": "application/json", ...(data && { "Content-Length": Buffer.byteLength(data) }) }
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", c => raw += c);
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

function fbRead(path)        { return fbRequest("GET",  path, null); }
function fbWrite(path, body) { return fbRequest("PUT",  path, body); }

function anthropicCall(messages, system, maxTokens = 1000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers:  {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length":    Buffer.byteLength(body)
      }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`Anthropic ${res.statusCode}: ${raw.slice(0,300)}`));
        try {
          const d = JSON.parse(raw);
          resolve(d.content?.[0]?.text || "");
        } catch { resolve(""); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Stage classification logic ─────────────────────────────────────────────────
// Deterministic from existing Firebase fields — no extra API calls needed.
//
// WEEKLY STAGE — driven by weeklyBullish, weeklyRsi, weeklyJAX, weeklyJAXRecent
//   Stage 2 (breakout): weeklyBullish=true, weeklyRsi 50-72, weeklyJAX or weeklyJAXRecent
//   Stage 1 (base):     weeklyBullish=false, weeklyRsi 42-54 (coiling)
//   Stage 3 (markup):   weeklyBullish=true, weeklyRsi >72 (extended)
//   Stage 4 (distrib):  weeklyBullish weakening — trail still up but RSI rolling over
//   Stage 5/6:          weeklyBullish=false, weeklyRsi <45

function classifyWeeklyStage(s) {
  const wRsi  = s.weeklyRsi  || 0;
  const wBull = s.weeklyBullish  === true || s.weeklyBullish  === 1;
  const wJAX  = s.weeklyJAX     === true || s.weeklyJAX     === 1;
  const wJAXr = s.weeklyJAXRecent === true || s.weeklyJAXRecent === 1;

  if (wBull && wRsi > 74)                                    return 3; // extended markup
  if (wBull && (wJAX || wJAXr) && wRsi >= 48 && wRsi <= 74) return 2; // JAX-confirmed Stage 2
  if (wBull && wRsi >= 48 && wRsi <= 74)                    return 2; // trail-only Stage 2 — trail IS the signal
  if (wBull && wRsi >= 40 && wRsi < 48)                     return 1; // basing, weekly not ignited yet
  if (!wBull && wRsi >= 44 && wRsi <= 56)                   return 1; // base / coiling
  if (!wBull && wRsi < 44)                                  return 5; // breakdown
  if (!wBull && wRsi < 36)                                  return 6; // markdown
  return wBull ? 2 : 1; // fallback
}

// DAILY STAGE — driven by dailyJAX, rsi, emaRising, dailyAbove200, dailyTrail
//   Stage 2: dailyJAX active, RSI 50-70, emaRising, above 200
//   Stage 1: !dailyJAX, RSI 45-55, emaRising=false/neutral
//   Stage 3: RSI >70, above 200 but extended
//   Stage 4: trail flattening — RSI 55-65, no fresh JAX
//   Stage 5/6: below 200, RSI declining

function classifyDailyStage(s) {
  const rsi       = s.rsi           || 0;
  const dJAX      = s.dailyJAX      === true || s.dailyJAX    === 1 || s.greenArrow === true || s.greenArrow === 1;
  const emaRising = s.emaRising     === true || s.emaRising   === 1;
  const above200  = s.dailyAbove200 === true || s.dailyAbove200 === 1;
  const price     = s.price || 0;
  const trail     = s.dailyTrail || s.trailVal || 0;
  const trailBull = trail > 0 && trail < price; // ATR trail below price = bullish trend

  if (dJAX && rsi >= 48 && rsi <= 70 && (emaRising || trailBull)) return 2; // breakout — emaRising OR trail confirms
  if (above200 && rsi > 70 && (emaRising || trailBull))            return 3; // extended
  if (!dJAX && rsi >= 44 && rsi <= 58 && emaRising)               return 1; // basing, ema rising but no JAX yet
  if (above200 && rsi >= 55 && !dJAX && !emaRising)               return 4; // distribution risk
  if (above200 && rsi >= 44 && rsi < 55 && !dJAX)                 return 1; // coiling above 200
  if (!above200 && rsi >= 40)                                      return 5; // breakdown
  if (!above200 && rsi < 40)                                       return 6; // markdown
  return above200 ? 1 : 5;
}

// ALIGNMENT
function classifyAlignment(dailyStage, weeklyStage, s) {
  const bothAligned = s.bothAligned === true || s.bothAligned === 1;
  if (dailyStage === 2 && weeklyStage === 2) return "CONFIRMED";
  if (dailyStage === 2 && weeklyStage === 1) return "WAIT";       // daily ready, weekly still basing
  if (dailyStage === 1 && weeklyStage === 2) return "WAIT";       // weekly leading, daily lagging
  if (dailyStage >= 4 || weeklyStage >= 4)   return "BEARISH";
  return "CONFLICT";
}

// ACTION
function classifyAction(dailyStage, weeklyStage, alignment) {
  if (alignment === "CONFIRMED")                            return "ENTER";
  if (alignment === "WAIT")                                 return "WAIT";
  if (alignment === "BEARISH")                              return "AVOID";
  if (dailyStage === 3 && weeklyStage === 2)                return "WAIT";  // late daily, still ok weekly
  if (dailyStage === 2 && weeklyStage === 3)                return "WAIT";  // extended weekly
  return "AVOID";
}

// TRIGGER text for WAIT
function buildTrigger(s, dailyStage, weeklyStage) {
  if (dailyStage === 1 && weeklyStage === 2) return "Wait for daily Stage 2 breakout — JAX green arrow + RSI cross 50";
  if (dailyStage === 2 && weeklyStage === 1) return "Wait for weekly to confirm Stage 2 — weekly JAX fire or RSI > 50";
  if (dailyStage === 3)                      return "Pullback entry only — wait for RSI reset to 50-55 zone";
  return "Wait for Stage 2 alignment on both timeframes";
}

// ── Stop calculation — options-aware ─────────────────────────────────────────
// Rules:
//  1. Raw stop = dailyTrail or trailVal
//  2. SANITY CHECK: trail must be BELOW price. If trail >= price (bearish trail
//     still above price), it is NOT a valid stop — fall back to swing low or 8%.
//  3. OPTIONS CAP: stop must be within 8% of entry. If ATR trail is wider, cap it.
//  4. Swing low fallback: use weeklyTrail if tighter than the 8% cap.
function calcStop(s) {
  const price = s.price || 0;
  if (!price) return 0;

  const rawTrail  = s.dailyTrail || s.trailVal || 0;
  const weekTrail = s.weeklyTrail || 0;

  // Max allowed distance below entry for options (8%)
  const maxStopPct = 0.08;
  const floorPrice = parseFloat((price * (1 - maxStopPct)).toFixed(2));

  // Step 1: is the daily trail valid (below price)?
  let stop = 0;
  if (rawTrail > 0 && rawTrail < price) {
    stop = rawTrail;
  } else {
    // Trail is above price or missing: bearish / unreliable, use 5% default
    stop = parseFloat((price * 0.95).toFixed(2));
  }

  // Step 2: apply weekly trail as swing low if tighter than floorPrice
  if (weekTrail > 0 && weekTrail < price && weekTrail > floorPrice) {
    stop = weekTrail;
  }

  // Step 3: cap stop to options max (8% below entry)
  if (stop < floorPrice) stop = floorPrice;

  return parseFloat(stop.toFixed(2));
}

// ── Classify a single ticker ──────────────────────────────────────────────────
function classifyTicker(s) {
  const weeklyStage = classifyWeeklyStage(s);
  const dailyStage  = classifyDailyStage(s);
  const alignment   = classifyAlignment(dailyStage, weeklyStage, s);
  const action      = classifyAction(dailyStage, weeklyStage, alignment);

  return {
    sym:               s.sym,
    price:             s.price   || 0,
    change:            s.change  || 0,
    taScore:           s.taScore || 0,
    dailyStage,
    weeklyStage,
    alignment,
    action,
    trigger:           action === "WAIT"  ? buildTrigger(s, dailyStage, weeklyStage) : null,
    entryZone:         action === "ENTER" ? s.price  || 0  : null,
    stop:              action === "ENTER" ? calcStop(s) : null,
    target:            action === "ENTER" ? parseFloat(((s.price || 0) * 1.15).toFixed(2)) : null,
    keyRisk:           buildKeyRisk(s, dailyStage, weeklyStage),
    dailyRSI:          s.rsi         || 0,
    weeklyRSI:         s.weeklyRsi   || 0,
    dailyTrail:        s.dailyTrail  || s.trailVal || 0,
    weeklyTrail:       s.weeklyTrail || 0,
    trailBullishDaily:  (s.dailyTrail || s.trailVal || 0) > 0 && (s.dailyTrail || s.trailVal) < (s.price || Infinity),
    trailBullishWeekly: s.weeklyBullish === true || s.weeklyBullish === 1,
    jaxActiveDaily:    s.dailyJAX    === true || s.dailyJAX    === 1 || s.greenArrow === true,
    jaxActiveWeekly:   s.weeklyJAX   === true || s.weeklyJAX   === 1 || s.weeklyJAXRecent === true,
    taIgniting:        s.taIgniting  === true || s.taIgniting  === 1,
    summary:           null  // filled by Anthropic call below for ENTER only
  };
}

function buildKeyRisk(s, dailyStage, weeklyStage) {
  const risks = [];
  if (weeklyStage >= 3) risks.push("Weekly extended — late markup");
  if ((s.rsi || 0) > 68) risks.push(`Daily RSI ${s.rsi} — overbought`);
  if (s.taExtended)      risks.push("taScore flags extended");
  if ((s.pctHi || 0) > -3) risks.push("Near 52w high — limited upside");
  if (s.weeksAgo && s.weeksAgo > 8) risks.push(`Weekly flip ${s.weeksAgo}w ago — may be Stage 3`);
  return risks.length ? risks.join("; ") : "Confirm position sizing before entry";
}

// ── Anthropic summaries for ENTER tickers only ───────────────────────────────
async function generateSummaries(enters) {
  if (!ANTHROPIC_KEY || !enters.length) return;

  const tickerList = enters.map(t =>
    `${t.sym}: daily Stage ${t.dailyStage}, weekly Stage ${t.weeklyStage}, RSI ${t.dailyRSI}/${t.weeklyRSI}, taScore ${t.taScore}, JAX daily=${t.jaxActiveDaily} weekly=${t.jaxActiveWeekly}, risk="${t.keyRisk}"`
  ).join("\n");

  const system = `You are a concise trading analyst. For each ticker given, write ONE sentence (max 18 words) describing the setup quality and what makes it actionable. Focus on the stage alignment and momentum confirmation. No fluff, no disclaimers. Return JSON only: {"SYM": "one sentence", ...}`;

  const userMsg = `Write one-sentence summaries for these ENTER setups:\n${tickerList}`;

  console.log(`📝 Generating Anthropic summaries for ${enters.length} ENTER tickers...`);
  try {
    const raw = await anthropicCall([{ role: "user", content: userMsg }], system, 400);
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    enters.forEach(t => { if (parsed[t.sym]) t.summary = parsed[t.sym]; });
    console.log(`   ✅ Summaries generated`);
  } catch (e) {
    console.warn(`   ⚠️  Summary generation failed: ${e.message} — continuing without`);
  }
}

// ── Firebase read helpers ─────────────────────────────────────────────────────
function parseFirebaseNode(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (val.data) {
    try {
      const d = typeof val.data === "string" ? JSON.parse(val.data) : val.data;
      return Array.isArray(d) ? d : Object.values(d).filter(Boolean);
    } catch { return []; }
  }
  const keys = Object.keys(val);
  const numKeys = keys.filter(k => !isNaN(k));
  if (numKeys.length) return numKeys.map(k => val[k]).filter(Boolean);
  // keyed by sym
  return Object.values(val).filter(v => v && typeof v === "object" && v.sym);
}

async function readSources(sourceArg) {
  const sources = sourceArg === "all"
    ? ["recovery", "catalyst", "jax_scan", "weekly_monitor"]
    : sourceArg.split(",").map(s => s.trim()).map(s => {
        // normalize shorthand
        if (s === "jax")     return "jax_scan";       // now includes weekly fields
        if (s === "weekly")  return "weekly_monitor";
        if (s === "recovery") return "recovery";
        if (s === "catalyst") return "catalyst";
        if (s === "jax_live") return "jax_cron_alerts";  // alias
        return s;
      });

  const combined = [];
  const seen = new Set();

  for (const node of sources) {
    console.log(`📡 Reading screener/${node}...`);
    try {
      const val = await fbRead(`screener/${node}`);
      const items = parseFirebaseNode(val);
      let added = 0;
      for (const item of items) {
        if (!item.sym) continue;
        if (seen.has(item.sym)) continue; // dedupe — first source wins
        seen.add(item.sym);
        combined.push(item);
        added++;
      }
      console.log(`   ✅ ${node}: ${items.length} items, ${added} new after dedup`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to read ${node}: ${e.message}`);
    }
  }

  return combined;
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Send Telegram notification ────────────────────────────────────────────────
function sendTelegram(text){
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if(!token || !chatId){
    console.log("ℹ️  No Telegram credentials — skipping notification");
    return Promise.resolve();
  }
  return new Promise((res, rej) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${token}/sendMessage`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>res(d)); });
    req.on("error", rej);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`\n🏗️  Weinstein Classifier`);
  console.log(`   Source:  ${SOURCE}`);
  console.log(`   Top N:   ${TOP_N}`);
  console.log(`   Dry run: ${DRY_RUN}`);
  console.log(`   Time:    ${new Date().toISOString()}\n`);

  // 1 — Read Firebase
  const allItems = await readSources(SOURCE);
  if (!allItems.length) { console.error("❌ No tickers read from Firebase. Exiting."); process.exit(1); }
  console.log(`\n📊 Total unique tickers: ${allItems.length}`);

  // 2 — Sort by taScore, take top N
  const ranked = allItems
    .filter(s => s.sym)
    .sort((a, b) => (b.taScore || 0) - (a.taScore || 0))
    .slice(0, TOP_N);
  console.log(`🎯 Classifying top ${ranked.length} by taScore (min: ${ranked.at(-1)?.taScore || 0}, max: ${ranked[0]?.taScore || 0})\n`);

  // 3 — Classify each ticker deterministically
  const classified = ranked.map(s => {
    const result = classifyTicker(s);
    const icon = result.action === "ENTER" ? "🟢" : result.action === "WAIT" ? "🟡" : "🔴";
    console.log(`   ${icon} ${result.sym.padEnd(6)} D${result.dailyStage}/W${result.weeklyStage} ${result.alignment.padEnd(9)} ${result.action}`);
    return result;
  });

  const enters = classified.filter(t => t.action === "ENTER");
  const waits  = classified.filter(t => t.action === "WAIT");
  const avoids = classified.filter(t => t.action === "AVOID");
  console.log(`\n   Summary: ${enters.length} ENTER · ${waits.length} WAIT · ${avoids.length} AVOID`);

  // 4 — Anthropic summaries for ENTER only (single API call)
  await generateSummaries(enters);

  // 5 — Build payload
  const payload = {
    data:            JSON.stringify(classified),
    savedAt:         new Date().toISOString(),
    device:          "github-actions-classify",
    source:          SOURCE,
    tickersAnalyzed: classified.length,
    topAction:       enters.map(t => t.sym).slice(0, 5).join(", ") || "none",
    enterCount:      enters.length,
    waitCount:       waits.length,
    avoidCount:      avoids.length
  };

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN — payload preview (not writing):");
    console.log(JSON.stringify(payload, null, 2).slice(0, 800));
    return;
  }

  // 6 — Write to Firebase
  console.log(`\n💾 Writing to screener/weinstein...`);
  try {
    await fbWrite("screener/weinstein", payload);
    console.log(`✅ Done — ${classified.length} tickers written`);
    console.log(`   ENTER: ${enters.map(t => t.sym).join(", ") || "none"}`);

    // ── Send Telegram summary ───────────────────────────────────────────────
    const today   = new Date().toLocaleDateString("en-US",{timeZone:"America/New_York",weekday:"short",month:"short",day:"numeric"});
    const enterDetails = enters.slice(0,5).map(t => {
      const stop   = t.stop   ? ` | Stop $${Number(t.stop).toFixed(2)}`     : "";
      const target = t.target ? ` | Target $${Number(t.target).toFixed(2)}` : "";
      const price  = t.price  ? ` $${Number(t.price).toFixed(2)}`           : "";
      const summ   = t.summary ? `\n   <i>${t.summary.slice(0,100)}</i>`   : "";
      return `• <b>${t.sym}</b>${price} D${t.dailyStage}/W${t.weeklyStage}${stop}${target}${summ}`;
    }).join("\n");

    const waitList  = waits.slice(0,8).map(t=>`${t.sym}(D${t.dailyStage}/W${t.weeklyStage})`).join(", ");
    const avoidList = avoids.slice(0,5).map(t=>t.sym).join(", ");

    const msg = `📊 <b>WEINSTEIN CLASSIFIER — ${today}</b>\n`
      + `${classified.length} tickers analyzed · Source: ${SOURCE}\n\n`
      + (enters.length > 0
        ? `🟢 <b>ENTER (${enters.length}):</b>\n${enterDetails}`
        : `🟢 <b>ENTER:</b> none`)
      + (waits.length > 0  ? `\n\n🟡 <b>WAIT (${waits.length}):</b> ${waitList}${waits.length>8?" +more":""}` : "")
      + (avoids.length > 0 ? `\n🔴 <b>AVOID (${avoids.length}):</b> ${avoidList}${avoids.length>5?" +more":""}` : "");

    try{
      await sendTelegram(msg);
      console.log("✅ Telegram notification sent");
    }catch(e){
      console.warn("⚠️  Telegram failed:", e.message);
    }

  } catch (e) {
    console.error(`❌ Firebase write failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
