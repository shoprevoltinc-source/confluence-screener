// telegram-morning-brief.js — v2
// Reads the agent_brief saved by the web app and sends it via Telegram
// Falls back to generating its own brief if Firebase is empty/stale
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FIREBASE_DB_URL, ANTHROPIC_API_KEY

const https = require("https");

const FIREBASE_DB_URL  = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const FH_KEY           = process.env.FH_KEY || "d819lthr01qler4hgk4gd819lthr01qler4hgk50";

if(!FIREBASE_DB_URL)  { console.error("❌ No FIREBASE_DB_URL"); process.exit(1); }
if(!TELEGRAM_TOKEN)   { console.error("❌ No TELEGRAM_BOT_TOKEN"); process.exit(1); }
if(!TELEGRAM_CHAT_ID) { console.error("❌ No TELEGRAM_CHAT_ID"); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function fetchJSON(url){
  return new Promise((res,rej)=>{
    https.get(url, r=>{ let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{ res(JSON.parse(d)); }catch(e){ rej(e); } }); }).on("error",rej);
  });
}

async function fbGet(path){
  try{
    const data = await fetchJSON(`${FIREBASE_DB_URL}/screener/${path}.json`);
    if(!data || data==="null") return null;
    if(data.data) return typeof data.data==="string" ? JSON.parse(data.data.replace(/```json|```/g,"").trim()) : data.data;
    return data;
  }catch(e){ console.warn(`fbGet(${path}) failed:`, e.message); return null; }
}

function fbPut(path, payload){
  return new Promise((res,rej)=>{
    const url  = new URL(`${FIREBASE_DB_URL}/screener/${path}.json`);
    const body = JSON.stringify(payload);
    const req  = https.request({ hostname:url.hostname, path:url.pathname+url.search, method:"PUT",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)} },
      r=>{ let d=""; r.on("data",c=>d+=c); r.on("end",()=>res(d)); });
    req.on("error",rej); req.write(body); req.end();
  });
}

function httpGet(url){
  return new Promise((res,rej)=>{
    https.get(url, r=>{ let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{ res(JSON.parse(d)); }catch(e){ res(null); } }); }).on("error",()=>res(null));
  });
}

async function fetchQuote(sym){
  try{
    const d = await httpGet(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_KEY}`);
    if(!d||!d.c||d.c===0) return null;
    return { price:d.c, changePct: d.pc>0?((d.c-d.pc)/d.pc*100):0 };
  }catch(e){ return null; }
}

function sendTelegram(text){
  return new Promise((res,rej)=>{
    const body = JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text, parse_mode:"HTML" });
    const req  = https.request({ hostname:"api.telegram.org", path:`/bot${TELEGRAM_TOKEN}/sendMessage`,
      method:"POST", headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)} },
      r=>{ let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ const result=JSON.parse(d); result.ok?res(result):rej(new Error(JSON.stringify(result))); }); });
    req.on("error",rej); req.write(body); req.end();
  });
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

function getTodayET(){
  return new Date().toLocaleDateString("en-US",{timeZone:"America/New_York",weekday:"short",month:"short",day:"numeric"});
}

// ── Detect if brief is from today ─────────────────────────────────────────────
function isFreshBrief(savedAt){
  if(!savedAt) return false;
  const now        = new Date();
  const etNow      = new Date(now.toLocaleString("en-US",{timeZone:"America/New_York"}));
  const dayOfWeek  = etNow.getDay();
  const isWeekend  = dayOfWeek === 0 || dayOfWeek === 6;
  // On weekends always generate fresh — no saved brief is current
  if(isWeekend) return false;
  const savedDate  = new Date(savedAt).toLocaleDateString("en-US",{timeZone:"America/New_York"});
  const today      = now.toLocaleDateString("en-US",{timeZone:"America/New_York"});
  // Also check it was saved within last 8 hours — prevents stale same-day briefs
  const ageHours   = (now - new Date(savedAt)) / 3600000;
  return savedDate === today && ageHours < 8;
}

// ── Generate fresh brief via Claude (fallback only) ───────────────────────────
async function generateFreshBrief(wm, jax, ws, regime, rec=[], cat=[], conf=[], triggers=[]){
  if(!ANTHROPIC_KEY){ console.warn("⚠️  No ANTHROPIC_API_KEY"); return null; }

  const today      = new Date().toLocaleDateString("en-US",{timeZone:"America/New_York",weekday:"long",month:"short",day:"numeric"});
  const tier1      = wm.filter(r=>r.tier1||r.tierApp);
  const tier2      = wm.filter(r=>r.tier2&&!r.tier1&&!r.tierApp);
  const arrows     = jax.filter(r=>r.greenArrow&&(r.bullScore||0)>=4);
  const wsEnters   = ws.filter(r=>r.action==="ENTER");
  const regimeCtx  = regime ? `\nMARKET REGIME: ${regime.type} | SPY ${regime.spyMove>=0?"+":""}${regime.spyMove}% | Breadth ${regime.adRatio}% | ${regime.advice}\nMax trades: ${regime.maxTrades} | Min score: ${regime.minScore}/10` : "";

  // ── Fetch live prices for top candidates ──────────────────────────────────
  const topSyms = [...new Set([
    ...tier1.map(r=>r.sym), ...tier2.slice(0,10).map(r=>r.sym),
    ...arrows.slice(0,8).map(r=>r.sym)
  ])].slice(0,20);

  const livePrices = {};
  const extendedSyms = [];
  for(const sym of topSyms){
    try{
      const q = await fetchQuote(sym);
      if(q && q.price > 0){
        livePrices[sym] = q;
        // Find scan price from weekly monitor
        const wmEntry = wm.find(r=>r.sym===sym);
        const scanPrice = wmEntry?.price || 0;
        if(scanPrice > 0){
          const pctMove = ((q.price - scanPrice) / scanPrice * 100);
          if(Math.abs(pctMove) > 5) extendedSyms.push(`${sym} (${pctMove>=0?"+":""}${pctMove.toFixed(1)}% from scan)`);
        }
      }
      await new Promise(r=>setTimeout(r,150));
    }catch(e){}
  }
  const liveCtx = Object.keys(livePrices).length > 0
    ? `\n\nLIVE PRICES (use these, not scan prices):\n`
      + Object.entries(livePrices).map(([s,q])=>`${s}: $${q.price.toFixed(2)} (${q.changePct>=0?"+":""}${q.changePct.toFixed(1)}% today)`).join(", ")
      + (extendedSyms.length ? `\n⚠️ EXTENDED >5% from scan — avoid entering: ${extendedSyms.join(", ")}` : "")
    : "";

  const system = `You are a professional trading advisor specializing in options. Respond ONLY with a raw JSON object. No markdown, no backticks. Start with { end with }.
Return exactly:
{
  "context": "one sentence market context",
  "confidence": "X/10 — brief reason",
  "avoid": "what to avoid today",
  "trades": [{
    "sym": "TICKER",
    "score": 7,
    "action": "ENTER",
    "entry": 84.38,
    "stop": 81.00,
    "target": 94.00,
    "option_type": "call",
    "strike_guidance": "ATM $84C or $85C",
    "expiry_guidance": "30-45 DTE (mid-to-late ${new Date().toLocaleDateString("en-US",{month:"long",year:"numeric"})})",
    "est_premium": 2.50,
    "contracts": 3,
    "total_cost": 750,
    "risk_pct": 0.75,
    "win_rate_note": "signal description",
    "notes": "score breakdown"
  }],
  "skipped": "brief note on skipped signals"
}`;

  const user = `Date: ${today} | Account: $10,000 | Risk: 0.75% ($75) per TIER 2, 1% ($100) TIER 1 | Max trades: ${regime?.maxTrades||5}${regimeCtx}

WEEKLY MONITOR — TIER 1 ENTER NOW (${tier1.length}):
${tier1.map(r=>`${r.sym} $${Number(r.price||0).toFixed(2)} W-RSI:${Number(r.weeklyRsi||0).toFixed(0)} D-RSI:${Number(r.rsi||0).toFixed(0)} flip${r.weeksAgo}wk ${r.weeklyJAXRecent?"WkJAX":""}${r.h4FlipRecent?" 4H-JUST-FLIPPED":" 4H-bull"}`).join("\n")||"none"}

WEEKLY MONITOR — TIER 2 4H BULL (${tier2.length}):
${tier2.slice(0,10).map(r=>`${r.sym} $${Number(r.price||0).toFixed(2)} W-RSI:${Number(r.weeklyRsi||0).toFixed(0)} D-RSI:${Number(r.rsi||0).toFixed(0)} flip${r.weeksAgo}wk ${r.weeklyJAXRecent?"WkJAX":""}`).join("\n")||"none"}

JAX GREEN ARROWS bull 4-5/5 (${arrows.length}):
${arrows.slice(0,10).map(r=>`${r.sym} $${Number(r.price||0).toFixed(2)} bull${r.bullScore}/5 RSI${Number(r.rsi||0).toFixed(0)}`).join("\n")||"none"}

WEINSTEIN ENTER (${wsEnters.length}): ${wsEnters.map(r=>r.sym).join(", ")||"none"}

RECOVERY SCAN — top setups (${rec.length} total, showing score >= 60):
${rec.filter(r=>(r.taScore||r.score||0)>=60).slice(0,8).map(r=>`${r.sym} $${Number(r.price||0).toFixed(2)} score:${r.taScore||r.score||0} RSI:${Number(r.rsi||0).toFixed(0)}`).join("\n")||"none"}

CATALYST SCAN — coils + momentum (${cat.length} total):
${cat.filter(r=>r.coilPct>=70||(r.bullScore||0)>=4).slice(0,6).map(r=>`${r.sym} $${Number(r.price||0).toFixed(2)} ${r.coilPct?`coil${r.coilPct}%`:""} ${r.bullScore?`bull${r.bullScore}/5`:""} RSI:${Number(r.rsi||0).toFixed(0)}`).join("\n")||"none"}

CONFLUENCE SCAN (${conf.length} total):
${conf.filter(r=>(r.taScore||r.score||0)>=55).slice(0,6).map(r=>`${r.sym} $${Number(r.price||0).toFixed(2)} score:${r.taScore||r.score||0}`).join("\n")||"none"}

DAILY TRIGGERS fired today (${triggers.length}):
${triggers.slice(0,6).map(r=>`${r.sym} ${r.trigger||""} ${r.price?`$${Number(r.price).toFixed(2)}`:""}`).join("\n")||"none"}

${liveCtx}

Options sizing: max premium spend $${regime?.maxTrades>=4?100:75} per trade. Estimate ATM 30-45 DTE premium as ~3-5% of underlying. Show contracts AND total cost.
Give top ${regime?.maxTrades||5} trades. Only ENTER if score >= ${regime?.minScore||5}/10.`;

  return new Promise((resolve,reject)=>{
    const body = JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:2500, temperature:0.1, system, messages:[{role:"user",content:user}] });
    const req  = https.request({ hostname:"api.anthropic.com", path:"/v1/messages", method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","Content-Length":Buffer.byteLength(body)} },
      r=>{ let d=""; r.on("data",c=>d+=c); r.on("end",()=>{
        try{
          const result = JSON.parse(d);
          if(!result.content?.[0]?.text){ reject(new Error("No content: "+d)); return; }
          const raw   = result.content[0].text;
          let clean   = raw.replace(/```json|```/g,"").trim();
          const start = clean.indexOf("{"), end = clean.lastIndexOf("}");
          if(start===-1||end===-1){ reject(new Error("No JSON found")); return; }
          const brief = JSON.parse(clean.substring(start,end+1));
          console.log(`✅ Fresh brief generated — ${brief.trades?.length||0} trades`);
          resolve(brief);
        }catch(e){ reject(e); }
      }); });
    req.on("error",reject); req.write(body); req.end();
  });
}

// ── Message builders ──────────────────────────────────────────────────────────
function buildMessage1(brief, regime, today){
  const lines = [];
  lines.push(`☀️ <b>MORNING BRIEF — ${today}</b>`);

  // Regime banner
  if(regime){
    const regimeEmoji = {TRENDING:"📈",CHOPPY:"〰️",VOLATILE:"⚡",BEAR:"🐻"}[regime.type]||"📊";
    lines.push(`${regimeEmoji} <b>${regime.type}</b> · SPY ${regime.spyMove>=0?"+":""}${regime.spyMove||"?"}% · VIX ${regime.vixLevel||"?"} · Breadth ${regime.adRatio||"?"}%`);
    lines.push(`<i>${regime.advice}</i>`);
    lines.push(`Max trades: ${regime.maxTrades} · Min score: ${regime.minScore}/10`);
  }

  lines.push("");
  if(brief?.context) lines.push(`📌 ${brief.context}`);
  lines.push("");

  // Trades
  const enters = (brief?.trades||[]).filter(t=>t.action==="ENTER");
  if(enters.length > 0){
    lines.push(`⭐ <b>ENTER — ${enters.length} TRADE${enters.length>1?"S":""}</b>`);
    enters.forEach((t,i)=>{
      lines.push(`\n${i+1}. <b>${t.sym}</b> ${t.score}/10 · ${t.risk_pct||0.75}% risk`);
      lines.push(`   Entry $${Number(t.entry||0).toFixed(2)} | Stop $${Number(t.stop||0).toFixed(2)} | Target $${Number(t.target||0).toFixed(2)}`);
      // Options sizing
      if(t.strike_guidance){
        lines.push(`   📋 ${t.strike_guidance} ${t.option_type||"call"} · ${t.expiry_guidance||"30-45 DTE"}`);
        lines.push(`   💰 ${t.contracts||"?"} contracts × $${t.est_premium||"?"} = $${t.total_cost||"?"}`);
      } else if(t.shares){
        lines.push(`   ${t.shares} shares`);
      }
      if(t.win_rate_note) lines.push(`   <i>${t.win_rate_note}</i>`);
    });
  } else {
    lines.push("No ENTER trades today.");
  }

  if(brief?.avoid){
    lines.push("");
    lines.push(`⚠️ <b>AVOID:</b> ${brief.avoid}`);
  }
  if(brief?.confidence){
    lines.push("");
    lines.push(`📊 Confidence: ${brief.confidence}`);
  }
  return lines.join("\n");
}

function buildMessage2(wm){
  const lines = [];
  const tierApp = wm.filter(r=>r.tierApp);
  const tier1   = wm.filter(r=>r.tier1&&!r.tierApp);
  const tier2   = wm.filter(r=>r.tier2&&!r.tier1&&!r.tierApp);
  const thisWeek= wm.filter(r=>r.weeksAgo===0);
  const lastWeek= wm.filter(r=>r.weeksAgo===1);
  const wkJAX   = wm.filter(r=>r.weeklyJAX||r.weeklyJAXRecent);

  lines.push(`📅 <b>WEEKLY MONITOR — ${wm.length} signals</b>`);
  lines.push("");
  if(tierApp.length) lines.push(`⭐⭐ A++ ENTER (${tierApp.length}): ${tierApp.map(r=>r.sym).join(", ")}`);
  if(tier1.length)   lines.push(`⭐ ENTER NOW (${tier1.length}): ${tier1.map(r=>r.sym).join(", ")}`);
  if(tier2.length)   lines.push(`🟢 4H BULL (${tier2.length}): ${tier2.map(r=>r.sym).join(", ")}`);
  if(thisWeek.length) lines.push(`\n🔔 <b>FLIP THIS WEEK:</b> ${thisWeek.map(r=>r.sym).join(", ")}`);
  if(lastWeek.length) lines.push(`📌 <b>FLIP LAST WEEK:</b> ${lastWeek.map(r=>r.sym).join(", ")}`);
  if(wkJAX.length){
    lines.push("\n🎯 <b>Weekly+JAX combos:</b>");
    wkJAX.slice(0,6).forEach(r=>{
      const drsi = r.rsi       ? ` RSI-D:${Number(r.rsi).toFixed(0)}`       : "";
      const wrsi = r.weeklyRsi ? ` RSI-W:${Number(r.weeklyRsi).toFixed(0)}` : "";
      lines.push(`• <b>${r.sym}</b> $${Number(r.price||0).toFixed(2)}${drsi}${wrsi} 🔥WkJAX`);
    });
  }
  return lines.join("\n");
}

function buildMessage3(jax, ws, wm, rec=[], cat=[], conf=[], triggers=[]){
  const lines = [];
  const wmSyms    = new Set(wm.map(r=>r.sym));
  const allArrows = jax.filter(r=>r.greenArrow);
  const topArrows = allArrows.filter(r=>(r.bullScore||0)>=4).sort((a,b)=>(b.bullScore||0)-(a.bullScore||0)).slice(0,8);
  const combos    = allArrows.filter(r=>wmSyms.has(r.sym)).slice(0,5);

  lines.push(`🟢 <b>JAX TODAY — ${topArrows.length} arrows (bull 4-5/5) of ${allArrows.length} total</b>`);
  if(topArrows.length){
    topArrows.forEach(r=>{
      lines.push(`• <b>${r.sym}</b> $${Number(r.price||0).toFixed(2)} bull${r.bullScore}/5 RSI${Number(r.rsi||0).toFixed(0)}`);
    });
  } else { lines.push("No bull 4-5/5 arrows today."); }

  if(combos.length){
    lines.push("\n🎯 <b>Weekly+JAX overlap:</b>");
    combos.forEach(r=>{
      const wme = wm.find(w=>w.sym===r.sym);
      lines.push(`• <b>${r.sym}</b> $${Number(r.price||0).toFixed(2)} bull${r.bullScore}/5 W-RSI:${Number(wme?.weeklyRsi||0).toFixed(0)}`);
    });
  }

  // Daily triggers
  if(triggers.length){
    lines.push(`\n⚡ <b>DAILY TRIGGERS (${triggers.length}):</b>`);
    triggers.slice(0,5).forEach(r=>{
      lines.push(`• <b>${r.sym}</b> ${r.trigger||""} $${Number(r.price||0).toFixed(2)}`);
    });
  }

  // Recovery top picks
  const topRec = rec.filter(r=>(r.taScore||r.score||0)>=65).slice(0,4);
  if(topRec.length){
    lines.push(`\n🔴 <b>RECOVERY top (${topRec.length}):</b> ${topRec.map(r=>`${r.sym} ${r.taScore||r.score||0}`).join(", ")}`);
  }

  // Catalyst coils
  const topCat = cat.filter(r=>r.coilPct>=80||(r.bullScore||0)>=5).slice(0,4);
  if(topCat.length){
    lines.push(`\n⚡ <b>CATALYST coils 80%+ (${topCat.length}):</b> ${topCat.map(r=>`${r.sym} ${r.coilPct?r.coilPct+"%":""}`).join(", ")}`);
  }

  if(ws?.length){
    const enters = ws.filter(r=>r.action==="ENTER");
    const waits  = ws.filter(r=>r.action==="WAIT");
    const avoids = ws.filter(r=>r.action==="AVOID");
    lines.push(`\n📊 <b>WEINSTEIN (${ws.length})</b>`);
    if(enters.length) lines.push(`🟢 ENTER (${enters.length}): ${enters.map(r=>r.sym).join(", ")}`);
    if(waits.length)  lines.push(`🟡 WAIT  (${waits.length}): ${waits.map(r=>r.sym).join(", ")}`);
    if(avoids.length) lines.push(`🔴 AVOID (${avoids.length}): ${avoids.slice(0,8).map(r=>r.sym).join(", ")}${avoids.length>8?" +"+(avoids.length-8)+" more":""}`);
    if(enters.length){
      lines.push("");
      enters.slice(0,3).forEach(r=>{
        lines.push(`• <b>${r.sym}</b> $${Number(r.price||0).toFixed(2)} Entry $${Number(r.entryZone||0).toFixed(2)} Stop $${Number(r.stop||0).toFixed(2)} Target $${Number(r.target||0).toFixed(2)}`);
        if(r.summary) lines.push(`  <i>${r.summary}</i>`);
      });
    }
  }
  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(){
  const today = getTodayET();
  console.log(`☀️  Telegram Morning Brief — ${today}`);
  console.log("📡 Fetching Firebase data...");

  const [agentBriefRaw, weeklyMonitor, jaxScan, weinstein, regimeRaw,
         recovery, catalyst, confluence, dailyTriggers] = await Promise.all([
    fbGet("agent_brief"),
    fbGet("weekly_monitor"),
    fbGet("jax_scan"),
    fbGet("weinstein"),
    fbGet("market_regime"),
    fbGet("recovery"),
    fbGet("catalyst"),
    fbGet("confluence"),
    fbGet("daily_triggers")
  ]);

  const wm       = Array.isArray(weeklyMonitor) ? weeklyMonitor : [];
  const jax      = Array.isArray(jaxScan)       ? jaxScan       : [];
  const ws       = Array.isArray(weinstein)     ? weinstein      : [];
  const rec      = Array.isArray(recovery)      ? recovery       : [];
  const cat      = Array.isArray(catalyst)      ? catalyst       : [];
  const conf     = Array.isArray(confluence)    ? confluence     : [];
  const triggers = dailyTriggers?.data          ? (Array.isArray(dailyTriggers.data) ? dailyTriggers.data : []) : [];
  const regime   = regimeRaw && regimeRaw.type  ? regimeRaw     : null;

  console.log(`✅ Weekly: ${wm.length} | JAX: ${jax.filter(r=>r.greenArrow).length} arrows | Weinstein: ${ws.length} | Recovery: ${rec.length} | Catalyst: ${cat.length} | Confluence: ${conf.length} | Triggers: ${triggers.length} | Regime: ${regime?.type||"unknown"}`);

  // ── Use saved brief if fresh (from today), otherwise generate new one ──────
  let brief = null;

  // Check if agent_brief was saved today by the web app
  const savedBriefRaw = await fetchJSON(`${FIREBASE_DB_URL}/screener/agent_brief.json`).catch(()=>null);
  const savedAt       = savedBriefRaw?.savedAt || savedBriefRaw?.time;
  const briefIsFresh  = isFreshBrief(savedAt);

  if(briefIsFresh && agentBriefRaw?.trades){
    brief = agentBriefRaw;
    console.log(`✅ Using today's saved brief from Firebase (${savedAt}) — ${brief.trades?.length||0} trades`);
  } else {
    console.log(`⚠️  No fresh brief in Firebase (savedAt: ${savedAt||"never"}) — generating new one`);

    // Fetch SPY for regime if not already in Firebase
    let liveRegime = regime;
    if(!liveRegime){
      const spy = await fetchQuote("SPY");
      if(spy) console.log(`SPY: ${spy.changePct>=0?"+":""}${spy.changePct.toFixed(2)}%`);
    }

    brief = await generateFreshBrief(wm, jax, ws, liveRegime, rec, cat, conf, triggers).catch(e=>{
      console.warn("Brief generation failed:", e.message);
      return null;
    });

    // Save fresh brief to Firebase so web app shows same data
    if(brief){
      await fbPut("agent_brief", {
        data:    JSON.stringify(brief),
        text:    JSON.stringify(brief),
        html:    "",
        time:    new Date().toISOString(),
        isJson:  true,
        savedAt: new Date().toISOString(),
        device:  "telegram-action"
      });
      console.log("✅ Fresh brief saved to Firebase");
    }
  }

  // ── Build and send messages ───────────────────────────────────────────────
  const msg1 = buildMessage1(brief, regime, today);
  const msg2 = buildMessage2(wm);
  const msg3 = buildMessage3(jax, ws, wm, rec, cat, conf, triggers);

  console.log("📤 Sending Message 1 (Trades + Regime)...");
  await sendTelegram(msg1);
  await sleep(1000);

  console.log("📤 Sending Message 2 (Weekly Monitor)...");
  await sendTelegram(msg2);
  await sleep(1000);

  console.log("📤 Sending Message 3 (JAX + Weinstein)...");
  await sendTelegram(msg3);

  console.log("✅ All 3 messages sent.");
}

main().catch(e=>{ console.error("❌ Fatal:", e); process.exit(1); });
