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
const FIREBASE_URL   = process.env.FIREBASE_URL;
const FIREBASE_TOKEN = process.env.FIREBASE_TOKEN || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

// ── Args ──────────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i+1] ? args[i+1] : def; };
const hasArg = (flag)      => args.includes(flag);

const SOURCE  = getArg("--source", "all");
const TOP_N   = parseInt(getArg("--top", "25"), 10);
const DRY_RUN = hasArg("--dry-run");

// ── Validation ────────────────────────────────────────────────────────────────
if (!FIREBASE_URL) { console.error("❌ FIREBASE_URL env var not set"); process.exit(1); }
if (isNaN(TOP_N) || TOP_N < 1) { console.error("❌ --top must be a positive integer"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.warn("⚠️  ANTHROPIC_API_KEY not set — summaries will be skipped"); }

// ── Bool coercion helper — handles string "true"/"1", boolean true, number 1 ──
const bool = v => v === true || v === 1 || v === "true" || v === "1";

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

function fbRead(path)        { return fbRequest("GET", path, null); }
function fbWrite(path, body) { return fbRequest("PUT", path, body); }

function anthropicCall(messages, system, maxTokens = 1000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      "claude-sonnet-4-5",
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

// ── Stage classification logic ────────────────────────────────────────────────

// WEEKLY STAGE
function classifyWeeklyStage(s) {
  const wRsi  = s.weeklyRsi || 0;
  const wBull = bool(s.weeklyBullish);
  const wJAX  = bool(s.weeklyJAX);
  const wJAXr = bool(s.weeklyJAXRecent);

  if (wBull && (wJAX || wJAXr) && wRsi >= 48 && wRsi <= 74) return 2; // breakout zone
  if (wBull && wRsi > 74)                                    return 3; // extended markup
  if (wBull && wRsi >= 45 && !(wJAX || wJAXr))              return 4; // distribution risk
  if (!wBull && wRsi < 36)                                   return 6; // markdown  ← FIXED: was after < 44
  if (!wBull && wRsi < 44)                                   return 5; // breakdown
  if (!wBull && wRsi >= 44 && wRsi <= 56)                   return 1; // base / coiling
  return wBull ? 3 : 1; // fallback
}

// DAILY STAGE
function classifyDailyStage(s) {
  const rsi       = s.rsi || 0;
  const dJAX      = bool(s.dailyJAX) || bool(s.greenArrow);
  const emaRising = bool(s.emaRising);
  const above200  = bool(s.dailyAbove200);

  if (dJAX && rsi >= 48 && rsi <= 70 && emaRising)       return 2; // breakout
  if (above200 && rsi > 70 && emaRising)                  return 3; // extended
  if (!dJAX && rsi >= 44 && rsi <= 58 && emaRising)      return 1; // basing, ema rising
  if (above200 && rsi >= 55 && !dJAX && !emaRising)      return 4; // distribution risk
  if (above200 && rsi >= 44 && rsi < 55 && !dJAX)        return 1; // basing above 200
  if (!above200 && rsi >= 40)                             return 5; // breakdown
  if (!above200 && rsi < 40)                              return 6; // markdown
  return above200 ? 1 : 5; // fallback
}

// ALIGNMENT
function classifyAlignment(dailyStage, weeklyStage) {
  if (dailyStage === 2 && weeklyStage === 2) return "CONFIRMED";
  if (dailyStage === 2 && weeklyStage === 1) return "WAIT";
  if (dailyStage === 1 && weeklyStage === 2) return "WAIT";
  if (dailyStage >= 4 || weeklyStage >= 4)   return "BEARISH";
  return "CONFLICT";
}

// ACTION
function classifyAction(dailyStage, weeklyStage, alignment) {
  if (alignment === "CONFIRMED")             return "ENTER";
  if (alignment === "WAIT")                  return "WAIT";
  if (alignment === "BEARISH")               return "AVOID";
  if (dailyStage === 3 && weeklyStage === 2) return "WAIT";
  if (dailyStage === 2 && weeklyStage === 3) return "WAIT";
  return "AVOID";
}

// TRIGGER text for WAIT
function buildTrigger(s, dailyStage, weeklyStage) {
  if (dailyStage === 1 && weeklyStage === 2) return "Wait for daily Stage 2 breakout — JAX green arrow + RSI cross 50";
  if (dailyStage === 2 && weeklyStage === 1) return "Wait for weekly to confirm Stage 2 — weekly JAX fire or RSI > 50";
  if (dailyStage === 3)                      return "Pullback entry only — wait for RSI reset to 50-55 zone";
  return "Wait for Stage 2 alignment on both timeframes";
}

// KEY RISK
function buildKeyRisk(s, dailyStage, weeklyStage) {
  const risks = [];
  if (weeklyStage >= 3)                                        risks.push("Weekly extended — late markup");
  if ((s.rsi || 0) > 68)                                      risks.push(`Daily RSI ${s.rsi} — overbought`);
  if (s.taExtended)                                            risks.push("taScore flags extended");
  if (typeof s.pctHi === "number" && s.pctHi > -3)            risks.push("Near 52w high — limited upside"); // FIXED: was (s.pctHi || 0) > -3
  if (s.weeksAgo && s.weeksAgo > 8)                           risks.push(`Weekly flip ${s.weeksAgo}w ago — may be Stage 3`);
  return risks.length ? risks.join("; ") : "Confirm position sizing before entry";
}

// ── Classify a single ticker ──────────────────────────────────────────────────
function classifyTicker(s) {
  const weeklyStage = classifyWeeklyStage(s);
  const dailyStage  = classifyDailyStage(s);
  const alignment   = classifyAlignment(dailyStage, weeklyStage);
  const action      = classifyAction(dailyStage, weeklyStage, alignment);

  // Stop: prioritize dailyTrail → trailVal → weeklyTrail → 95% of price
  // FIXED: coerce to Number() first to avoid .toFixed crash on string values from Firebase
  const stopRaw = Number(s.dailyTrail) || Number(s.trailVal) || Number(s.weeklyTrail) || (s.price * 0.95) || 0;

  return {
    sym:                s.sym,
    price:              s.price  || 0,
    change:             s.change || 0,
    taScore:            s.taScore || s.bullScore || 0,
    dailyStage,
    weeklyStage,
    alignment,
    action,
    trigger:            action === "WAIT"  ? buildTrigger(s, dailyStage, weeklyStage) : null,
    entryZone:          action === "ENTER" ? (s.price || 0)                           : null,
    stop:               action === "ENTER" ? parseFloat(stopRaw.toFixed(2))           : null,
    target:             action === "ENTER" ? parseFloat(((s.price || 0) * 1.15).toFixed(2)) : null,
    keyRisk:            buildKeyRisk(s, dailyStage, weeklyStage),
    dailyRSI:           s.rsi         || 0,
    weeklyRSI:          s.weeklyRsi   || 0,
    dailyTrail:         Number(s.dailyTrail)  || Number(s.trailVal)   || 0,
    weeklyTrail:        Number(s.weeklyTrail) || 0,
    trailBullishDaily:  bool(s.dailyJAX)  || bool(s.greenArrow),
    trailBullishWeekly: bool(s.weeklyBullish),
    jaxActiveDaily:     bool(s.dailyJAX)  || bool(s.greenArrow),
    jaxActiveWeekly:    bool(s.weeklyJAX) || bool(s.weeklyJAXRecent),
    taIgniting:         bool(s.taIgniting),
    summary:            null  // filled by Anthropic for ENTER only
  };
}

// ── Anthropic summaries for ENTER tickers only ────────────────────────────────
async function generateSummaries(enters) {
  if (!ANTHROPIC_KEY || !enters.length) return;

  const tickerList = enters.map(t =>
    `${t.sym}: daily Stage ${t.dailyStage}, weekly Stage ${t.weeklyStage}, RSI ${t.dailyRSI}/${t.weeklyRSI}, taScore ${t.taScore}, JAX daily=${t.jaxActiveDaily} weekly=${t.jaxActiveWeekly}, risk="${t.keyRisk}"`
  ).join("\n");

  const system  = `You are a concise trading analyst. For each ticker given, write ONE sentence (max 18 words) describing the setup quality and what makes it actionable. Focus on the stage alignment and momentum confirmation. No fluff, no disclaimers. Return JSON only: {"SYM": "one sentence", ...}`;
  const userMsg = `Write one-sentence summaries for these ENTER setups:\n${tickerList}`;

  console.log(`📝 Generating Anthropic summaries for ${enters.length} ENTER tickers...`);
  try {
    const raw    = await anthropicCall([{ role: "user", content: userMsg }], system, 400);
    const clean  = raw.replace(/```json|```/g, "").trim();
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
  const keys    = Object.keys(val);
  const numKeys = keys.filter(k => !isNaN(k));
  if (numKeys.length) return numKeys.map(k => val[k]).filter(Boolean);
  return Object.values(val).filter(v => v && typeof v === "object" && v.sym);
}

async function readSources(sourceArg) {
  const sources = sourceArg === "all"
    ? ["recovery", "catalyst", "jax_scan", "weekly_monitor"]
    : sourceArg.split(",").map(s => s.trim()).map(s => {
        if (s === "jax")      return "jax_scan";
        if (s === "weekly")   return "weekly_monitor";
        if (s === "recovery") return "recovery";
        if (s === "catalyst") return "catalyst";
        if (s === "jax_live") return "jax_cron_alerts";
        return s;
      });

  const combined = [];
  const seen     = new Set();

  for (const node of sources) {
    console.log(`📡 Reading screener/${node}...`);
    try {
      const val   = await fbRead(`screener/${node}`);
      const items = parseFirebaseNode(val);
      let added   = 0;
      for (const item of items) {
        if (!item.sym) continue;
        if (seen.has(item.sym)) continue;
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

  // 2 — Sort by taScore (falls back to bullScore), take top N
  const ranked = allItems
    .filter(s => s.sym)
    .sort((a, b) => (b.taScore || b.bullScore || 0) - (a.taScore || a.bullScore || 0))
    .slice(0, TOP_N);
  console.log(`🎯 Classifying top ${ranked.length} (min score: ${ranked.at(-1)?.taScore || ranked.at(-1)?.bullScore || 0}, max: ${ranked[0]?.taScore || ranked[0]?.bullScore || 0})\n`);

  // 3 — Classify each ticker deterministically
  const classified = ranked.map(s => {
    const result = classifyTicker(s);
    const icon   = result.action === "ENTER" ? "🟢" : result.action === "WAIT" ? "🟡" : "🔴";
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
  } catch (e) {
    console.error(`❌ Firebase write failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
