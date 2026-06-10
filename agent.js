// ── agent.js ─────────────────────────────────────────────────────────────────
// Trading Agent — AI-powered decision engine
// Jobs: morning brief, entry confirm, exit monitor, pattern analysis, weekly review
// Depends on: callClaude, renderMD, fetchLiveQuote, getMarketSession (api.js)
//             fbSafeSave, fbLoad (firebase.js)
//             logToJournal, tickerLogo (index.html)
// ─────────────────────────────────────────────────────────────────────────────

// ── Gather all scanner data from Firebase ─────────────────
async function gatherAllData(){
  const data = {};
  const keys = ["recovery","catalyst","jax_scan","confluence","weekly_monitor","pulse","journal"];
  await Promise.all(keys.map(async key=>{
    try{
      const fb = await window.fbLoad(key);
      data[key] = fb ? fb.data : [];
    }catch(e){ data[key] = []; }
  }));
  // Cron alerts from GitHub Action
  try{
    const cron = await window.fbLoad("jax_cron_alerts");
    data.jax_cron_alerts = (cron && cron.data) ? cron.data : null;
  }catch(e){ data.jax_cron_alerts = null; }

  // Daily triggers has nested structure — fbSafeSave wraps it as fb.data = {data:[], time:""}
  try{
    const dt = await window.fbLoad("daily_triggers");
    data.daily_triggers = (dt && dt.data) ? dt.data : null;
  }catch(e){ data.daily_triggers = null; }

  // Recovery + Catalyst from Firebase (populated by daily-full-scan GitHub Action)
  // Merge with any existing manual scan data already in data.recovery / data.catalyst
  try{
    const fbRec = await window.fbLoad("recovery");
    if(fbRec && fbRec.data && fbRec.data.length){
      // Merge: Firebase results take priority, dedupe by sym
      const existing = Array.isArray(data.recovery) ? data.recovery : [];
      const merged = [...fbRec.data];
      existing.forEach(r=>{ if(!merged.find(x=>x.sym===r.sym)) merged.push(r); });
      data.recovery = merged;
    }
  }catch(e){}

  try{
    const fbCat = await window.fbLoad("catalyst");
    if(fbCat && fbCat.data && fbCat.data.length){
      const existing = Array.isArray(data.catalyst) ? data.catalyst : [];
      const merged = [...fbCat.data];
      existing.forEach(r=>{ if(!merged.find(x=>x.sym===r.sym)) merged.push(r); });
      data.catalyst = merged;
    }
  }catch(e){}

  return data;
}

// ── Build scanner context string for Claude ───────────────
function buildScannerContext(data){
  const sections = [];

  // ── Account status FIRST — prevents open position hallucinations ──
  // NOTE TO CLAUDE: You MUST evaluate ALL tabs equally. Recovery, JAX, Catalyst, 
  // Confluence and Weekly are all valid signal sources. Do not anchor on Weekly only.
  const journal  = Array.isArray(data.journal) ? data.journal : [];
  const openPos  = journal.filter(e=>e.status==="open"&&e.price);
  const openList = openPos.map(e=>`${e.sym}@$${parseFloat(e.price).toFixed(2)}`).join(", ");
  sections.push(`⚠️ ACCOUNT STATUS (DO NOT INFER — USE ONLY THIS):
Open positions: ${openPos.length > 0 ? openPos.length+" OPEN: "+openList : "0 — NO open positions, ALL trade slots available"}
Available slots: ${openPos.length > 0 ? Math.max(0, 5 - openPos.length) : "5 of 5"}
RULE: Never reference open positions not listed above. Never assume positions from context.`);

  // GitHub Action Cron Alerts — auto-scan fired green arrows
  const cronAlerts = data.jax_cron_alerts;
  if(cronAlerts && cronAlerts.data && cronAlerts.data.length){
    const savedAt  = cronAlerts.savedAt || cronAlerts.time;
    const hoursAgo = savedAt ? (Date.now() - new Date(savedAt).getTime()) / (1000*60*60) : 0;
    if(hoursAgo <= 24){
      sections.push(`🤖 AUTO-SCAN (all 685 stocks):
GREEN ARROWS: ${cronAlerts.data.map(r=>`${r.sym}@$${r.price?.toFixed(2)} bull${r.bullScore}/5 RSI${r.rsi?.toFixed(0)}`).join(", ")||"none"}`);
    }
  }

  // Daily Trigger — highest priority, green arrows fired today on watchlist
  const dt = data.daily_triggers;
  if(dt && dt.data && dt.data.length){
    const fired = dt.data;
    const today = fired.filter(r=>r.firedToday);
    const yest  = fired.filter(r=>!r.firedToday);
    sections.push(`🔥 DAILY TRIGGER — GREEN ARROWS FIRED ON WEEKLY WATCHLIST:
TODAY (enter immediately): ${today.map(r=>`${r.sym}@$${r.price?.toFixed(2)} bull${r.bullScore}/5 RSI${r.rsi?.toFixed(0)} ${r.tier}`).join(", ")||"none"}
YESTERDAY (still valid): ${yest.map(r=>`${r.sym}@$${r.price?.toFixed(2)} bull${r.bullScore}/5 ${r.tier}`).join(", ")||"none"}`);
  }

  // Weekly monitor — one of several equal data sources
  const wm = (data.weekly_monitor||[]);
  const t1  = wm.filter(r=>r.tier1);
  const t2  = wm.filter(r=>r.tier2&&!r.tier1);
  const t3  = wm.filter(r=>r.tier3&&!r.tier1&&!r.tier2);
  if(wm.length){
    const fmt = r => `${r.sym}@$${r.price?.toFixed(2)} (W-RSI:${r.weeklyRsi?.toFixed(0)||"?"} D-RSI:${r.rsi?.toFixed(0)||"?"} +${r.pctAbove4H?.toFixed(0)||"?"}%above4H flip${r.weeksAgo}wkAgo${r.weeklyJAXRecent?" 📅WkJAX🔥":""}${r.daily200Reclaim?" 📡200EMA-RECLAIM":r.dailyAbove200?" 📡above200EMA":""})`;
    sections.push(`WEEKLY MONITOR — ALL PASSED A+ FILTERS (${wm.length} signals):
⭐⭐ A++ ENTER NOW (weekly+4H flip+200EMA reclaim): ${(wm.filter(r=>r.tierApp)).map(fmt).join(", ")||"none"}
⭐ TIER 1 ENTER NOW (96% win rate): ${t1.map(fmt).join(", ")||"none"}
🟢 TIER 2 4H BULLISH: ${t2.map(fmt).join(", ")||"none"}
🟣 TIER 3 JAX ALIGNED: ${t3.map(fmt).join(", ")||"none"}`);
  } else {
    sections.push("WEEKLY MONITOR: No signals found today — market may lack setups.");
  }

  // Pulse — what's moving today
  const pulse = (data.pulse||[]).sort((a,b)=>b.absChange-a.absChange).slice(0,10);
  if(pulse.length){
    sections.push(`TODAY'S MOVERS (pulse scan):
${pulse.map(r=>`${r.sym} ${r.changePct>=0?"▲":"▼"}${Math.abs(r.changePct||0).toFixed(1)}%${r.weeklyMatch?" 🟣WEEKLY":""}`).join(", ")}`);
  }

  // Confluence — enriched with pillars, price, RSI, cross-ref with weekly
  const conf = (data.confluence||[]).sort((a,b)=>b.confScore-a.confScore||b.absChange-a.absChange).slice(0,15);
  if(conf.length){
    const wmSyms = new Set((data.weekly_monitor||[]).map(r=>r.sym));
    const fmtConf = r => {
      const pillars = [
        r.pillars?.move     ? "MOVE"     : "",
        r.pillars?.trend    ? "TREND"    : "",
        r.pillars?.jax      ? "JAX"      : "",
        r.pillars?.momentum ? "MOMENTUM" : ""
      ].filter(Boolean).join("+");
      const cross = wmSyms.has(r.sym) ? " ⭐ALSO-ON-WEEKLY" : "";
      return `${r.sym}@$${r.price?.toFixed(2)} ${r.confScore}/4[${pillars}] RSI${r.rsi?.toFixed(0)||"?"} ${r.change>=0?"+":""}${r.change?.toFixed(1)||"?"}%${cross}`;
    };
    const full   = conf.filter(r=>r.confScore===4);
    const strong = conf.filter(r=>r.confScore===3);
    sections.push(`CONFLUENCE SCANNER:
4/4 FULL (enter if RSI<70): ${full.map(fmtConf).join(", ")||"none"}
3/4 STRONG: ${strong.map(fmtConf).join(", ")||"none"}`);
  }

  // JAX Scanner — enriched, cross-ref with weekly watchlist
  const jax = (data.jax_scan||[]).filter(r=>r.greenArrow).slice(0,20);
  if(jax.length){
    const wmSyms = new Set((data.weekly_monitor||[]).map(r=>r.sym));
    const fmtJAX = r => {
      const cross = wmSyms.has(r.sym) ? " ⭐ALSO-ON-WEEKLY" : "";
      return `${r.sym}@$${r.price?.toFixed(2)} bull${r.bullScore}/5 RSI${r.rsi?.toFixed(0)||"?"}${r.jaxUtBuy?" UTBuy":""}${r.jaxStFlip?" STFlip":""}${cross}`;
    };
    const weeklyAlso = jax.filter(r=>wmSyms.has(r.sym));
    const jaxOnly    = jax.filter(r=>!wmSyms.has(r.sym));
    sections.push(`JAX GREEN ARROWS:
ON WEEKLY WATCHLIST (highest conviction): ${weeklyAlso.map(fmtJAX).join(", ")||"none"}
JAX ONLY: ${jaxOnly.map(fmtJAX).join(", ")||"none"}`);
  }

  // Catalyst — ATR coil breakouts only (not earnings plays)
  const cat = (data.catalyst||[]).filter(r=>r.atrCoiling).sort((a,b)=>b.bullScore-a.bullScore).slice(0,15);
  if(cat.length){
    const wmSyms = new Set((data.weekly_monitor||[]).map(r=>r.sym));
    const fmtCat = r => {
      const cross   = wmSyms.has(r.sym) ? " ⭐ALSO-ON-WEEKLY" : "";
      const coil    = r.atrRatio ? `coil${(r.atrRatio*100).toFixed(0)}%` : "coiling";
      const vol     = r.isIgniting ? "VOL-IGNITING🔥" : r.isWakingUp ? "vol-waking" : "";
      return `${r.sym}@$${r.price?.toFixed(2)} bull${r.bullScore||0}/5 RSI${r.rsi?.toFixed(0)||"?"} ${coil}${vol?" "+vol:""}${cross}`;
    };
    const withWeekly = cat.filter(r=>wmSyms.has(r.sym));
    const standalone = cat.filter(r=>!wmSyms.has(r.sym));
    sections.push(`CATALYST — ATR COIL SETUPS (energy building, breakout pending):
ON WEEKLY (highest conviction): ${withWeekly.map(fmtCat).join(", ")||"none"}
COIL ONLY: ${standalone.map(fmtCat).join(", ")||"none"}`);
  }

  // Recovery
  const rec = (data.recovery||[]).filter(r=>r.score>=5||r.greenArrow).slice(0,20);
  if(rec.length){
    const fmtRec = r => {
      const c7  = r.deepBounce||r.c7 ? " C7-DEEP-BOUNCE" : "";
      const jax = r.greenArrow ? " 🟢GREEN-ARROW" : "";
      const rsi = r.rsi ? " RSI"+Math.round(r.rsi) : "";
      const bull = r.bullScore ? " bull"+r.bullScore+"/5" : "";
      return r.sym+"@$"+(r.price||0).toFixed(2)+" "+r.score+"/6"+c7+jax+rsi+bull;
    };
    const rec66 = rec.filter(r=>r.score===6);
    const rec55 = rec.filter(r=>r.score===5&&!rec66.find(x=>x.sym===r.sym));
    const recJax = rec.filter(r=>r.greenArrow&&r.score<5);
    sections.push(`🔴 RECOVERY TAB SIGNALS (oversold bounce setups — IBM pattern):
6/6 CONDITIONS MET: ${rec66.map(fmtRec).join(", ")||"none"}
5/6 CONDITIONS MET: ${rec55.map(fmtRec).join(", ")||"none"}
JAX+RECOVERY: ${recJax.map(fmtRec).join(", ")||"none"}
NOTE: Recovery stocks are deeply oversold bounces — RSI < 45, off 52w highs, EMA21 reclaiming. These are the IBM@$212 pattern. Score them: +2 for 6/6, +1 for 5/6, +1 for C7 deep bounce, +1 for green arrow, +1 for RSI < 40.`);
  }

  return sections.join("\n\n");
}

// ── Build journal context string ──────────────────────────
function buildJournalContext(journal){
  const entries = Array.isArray(journal) ? journal : [];
  const closed  = entries.filter(e=>e.status==="win"||e.status==="loss");
  const wins    = entries.filter(e=>e.status==="win");
  const losses  = entries.filter(e=>e.status==="loss");
  const open    = entries.filter(e=>e.status==="open"&&e.price);
  const winRate = closed.length ? Math.round(wins.length/closed.length*100) : null;
  const avgWin  = wins.length   ? (wins.reduce((a,e)=>a+parseFloat(e.result||0),0)/wins.length).toFixed(1) : null;
  const avgLoss = losses.length ? (losses.reduce((a,e)=>a+parseFloat(e.result||0),0)/losses.length).toFixed(1) : null;

  // Source breakdown
  const srcMap = {};
  entries.forEach(e=>{
    const s = e.source||"manual";
    if(!srcMap[s]) srcMap[s]={w:0,l:0};
    if(e.status==="win") srcMap[s].w++;
    if(e.status==="loss") srcMap[s].l++;
  });
  const srcStr = Object.entries(srcMap).map(([s,v])=>{
    const wr = v.w+v.l>0?Math.round(v.w/(v.w+v.l)*100):null;
    return `${s}: ${wr!==null?wr+"%":"—"} (${v.w}W/${v.l}L)`;
  }).join(", ");

  // Open positions
  const openStr = open.slice(0,5).map(e=>{
    const sl = parseFloat(e.stopLoss)||0;
    const t1 = parseFloat(e.target1)||0;
    return `${e.sym} entered $${parseFloat(e.price).toFixed(2)}${sl?" stop $"+sl.toFixed(2):""}${t1?" target $"+t1.toFixed(2):""}`;
  }).join("; ");

  return `TRADING HISTORY (${entries.length} total):
Win Rate: ${winRate!==null?winRate+"%":"—"} | Avg Win: ${avgWin?"+"+avgWin+"%":"—"} | Avg Loss: ${avgLoss||"—"}%
By Source: ${srcStr||"no data"}
Open Positions RIGHT NOW: ${open.length > 0 ? openStr : "NONE — no open trades, all slots available"}`;
}

// ── Update agent stat bar ─────────────────────────────────
function updateAgentStats(data){
  const journal = Array.isArray(data.journal) ? data.journal : [];
  const wm = data.weekly_monitor||[];
  const pulse = data.pulse||[];

  // Count unique tickers across all scanners
  const allSyms = new Set([
    ...wm.map(r=>r.sym),
    ...(data.jax_scan||[]).filter(r=>r.greenArrow).map(r=>r.sym),
    ...(data.confluence||[]).map(r=>r.sym),
    ...pulse.map(r=>r.sym)
  ]);

  const closed   = journal.filter(e=>e.status==="win"||e.status==="loss");
  const wins     = journal.filter(e=>e.status==="win");
  const wr       = closed.length ? Math.round(wins.length/closed.length*100) : null;
  const avgWin   = wins.length ? wins.reduce((a,e)=>a+parseFloat(e.result||0),0)/wins.length : 0;
  const avgLoss  = journal.filter(e=>e.status==="loss").length
    ? journal.filter(e=>e.status==="loss").reduce((a,e)=>a+parseFloat(e.result||0),0)/journal.filter(e=>e.status==="loss").length
    : 0;
  const expect   = wr ? ((wr/100)*avgWin + ((1-wr/100)*avgLoss)).toFixed(1) : null;
  const openPos  = journal.filter(e=>e.status==="open"&&e.price).length;

  const el = id=>document.getElementById(id);
  if(el("agent-signals")) el("agent-signals").textContent = allSyms.size;
  if(el("agent-top"))     el("agent-top").textContent     = wm.filter(r=>r.tier1).length;
  if(el("agent-winrate")) el("agent-winrate").textContent = wr!==null?wr+"%":"—";
  if(el("agent-expect"))  el("agent-expect").textContent  = expect?"+"+expect+"%":"—";
  if(el("agent-openpos")) el("agent-openpos").textContent = openPos;
}

// ══════════════════════════════════════════════════════════
// JOB 1: MORNING BRIEF
// ══════════════════════════════════════════════════════════
async function runMorningBrief(){
  const btn = document.getElementById("agent-brief-btn");
  const body = document.getElementById("agent-brief-body");
  btn.disabled = true;
  body.innerHTML = '<div class="agent-output loading">⏳ Reading all scanners and your journal history...</div>';

  try{
    const data    = await gatherAllData();
    const account = parseFloat(document.getElementById("agent-account").value)||10000;
    const risk    = parseFloat(document.getElementById("agent-risk").value)||1;
    const maxT    = parseInt(document.getElementById("agent-maxtrades").value)||3;
    const riskAmt = account * (risk/100);

    updateAgentStats(data);

    // ── Detect market regime before building brief ──────────────────────────
    body.innerHTML = '<div class="agent-output loading">⏳ Reading market regime...</div>';
    const regime         = await detectRegime().catch(()=>null);
    const regimeOverride = document.getElementById("agent-regime-override")?.checked || false;
    const regimeMaxTrades = regimeOverride ? maxT : (regime ? Math.min(maxT, regime.maxTrades) : maxT);
    const regimeMinScore  = regimeOverride ? 4    : (regime ? regime.minScore : 4);
    const regimeSizeMult  = regimeOverride ? 1.0  : (regime ? regime.sizeMultiplier : 1.0);
    if(regimeOverride) log("⚠️ Regime override ON — showing all "+maxT+" trades regardless of market conditions","warn");

    // ── Fetch live prices for top candidates before sending to Claude ──
    // Collects all candidate tickers from scan data, fetches Finnhub quotes
    // Claude sees scan price AND live price — knows if stock already moved
    const livePrices = {};
    try{
      body.innerHTML = '<div class="agent-output loading">⏳ Fetching live prices for top candidates...</div>';
      // Gather all candidate tickers from all sources
      const candidates = new Set();
      if(data.jax_cron_alerts&&data.jax_cron_alerts.data) data.jax_cron_alerts.data.slice(0,20).forEach(r=>candidates.add(r.sym));
      if(data.daily_triggers&&data.daily_triggers.data&&data.daily_triggers.data.length) data.daily_triggers.data.forEach(r=>candidates.add(r.sym));
      if(data.weekly_monitor&&data.weekly_monitor.length) data.weekly_monitor.slice(0,10).forEach(r=>candidates.add(r.sym));
      if(data.confluence&&data.confluence.length) data.confluence.slice(0,10).forEach(r=>candidates.add(r.sym));
      if(data.catalyst&&data.catalyst.length) data.catalyst.slice(0,10).forEach(r=>candidates.add(r.sym));
      if(data.jax_scan&&data.jax_scan.length) data.jax_scan.filter(r=>r.greenArrow).slice(0,10).forEach(r=>candidates.add(r.sym));
      if(data.recovery&&data.recovery.length) data.recovery.filter(r=>r.score>=5||r.greenArrow).slice(0,10).forEach(r=>candidates.add(r.sym));
      if(data.catalyst&&data.catalyst.length) data.catalyst.filter(r=>r.atrCoiling).slice(0,10).forEach(r=>candidates.add(r.sym));
      // Fetch live quotes in batches of 5 to avoid Finnhub 429 rate limit
      const syms = [...candidates].slice(0,30);
      const BATCH = 5;
      for(let i=0; i<syms.length; i+=BATCH){
        const batch = syms.slice(i, i+BATCH);
        await Promise.all(batch.map(async sym=>{
          try{
            const q = await fetchLiveQuote(sym);
            if(q && q.price > 0) livePrices[sym] = q;
          }catch(e){}
        }));
        if(i+BATCH < syms.length) await new Promise(r=>setTimeout(r, 300));
      }
      console.log(`📡 Live prices fetched for ${Object.keys(livePrices).length} stocks`);
    }catch(e){ console.warn("Live price fetch error:", e); }

    const scanCtx = buildScannerContext(data);
    const jnlCtx  = buildJournalContext(data.journal);
    const sess    = getMarketSession();

    // ── Build live price context string ──
    const liveCtx = Object.keys(livePrices).length > 0
      ? `\n\n📡 LIVE PRICES (fetched right now — use these for entry decisions, NOT scan prices):\n` +
        Object.entries(livePrices).map(([sym,q])=>{
          const moved   = q.changePct;
          const flag    = Math.abs(moved) >= 5 ? " ⚠️ EXTENDED" : Math.abs(moved) >= 3 ? " 📈 MOVED" : "";
          return `${sym}: $${q.price.toFixed(2)} (${moved>=0?"+":""}${moved.toFixed(1)}% today)${flag}`;
        }).join(", ") +
        `\n\nRULE: If live price is 5%+ above scan price = do NOT enter, wait for pullback. If 2-4% above = adjust stop/size. If below scan price = better entry than expected.`
      : "";

    // Load calibration data from Firebase
    let calibrationCtx = "";
    try{
      const cal = await window.fbLoad("calibration");
      if(cal && cal.data && cal.data.active){
        const d = cal.data;
        const bestSrc = Object.entries(d.bySource||{}).sort((a,b)=>b[1].winRate-a[1].winRate)[0];
        const bestDTE = Object.entries(d.byDTE||{}).sort((a,b)=>b[1].winRate-a[1].winRate)[0];
        calibrationCtx = `\n\n🧠 AI CALIBRATION (${d.sampleSize} real options trades):\n` +
          `Best source: ${bestSrc?bestSrc[0]+" "+bestSrc[1].winRate+"% WR":"—"} | ` +
          `Best DTE: ${bestDTE?bestDTE[0]+" "+bestDTE[1].winRate+"% WR":"—"}\n` +
          Object.entries(d.bySource||{}).map(([s,v])=>`${s}: ${v.winRate}% WR, avg ${v.avgPct>0?"+":""}${v.avgPct}% on ${v.total} trades`).join(" | ");
      }
    }catch(e){}

    const system = `You are a trading advisor. OUTPUT ONLY VALID JSON. Your entire response must be a single JSON object starting with { and ending with }. No text before {. No text after }. No backticks. No markdown. No explanation. If you add ANY text outside the JSON object the system will crash.
The trader has $${account} account, ${risk}% risk per trade ($${riskAmt.toFixed(0)} max risk), max ${regimeMaxTrades} trades.
${regime ? `
MARKET REGIME TODAY: ${regime.label}
SPY: ${regime.spyMove>=0?"+":""}${regime.spyMove}% | VIX: ${regime.vixLevel} | Breadth: ${regime.adRatio}% sectors advancing
Leading sectors: ${regime.leadingSectors}
Lagging sectors: ${regime.laggingSectors}
Regime advice: ${regime.advice}
REGIME RULES: Only recommend setups scoring ${regimeMinScore}+/10 today. Max ${regimeMaxTrades} trades. Size multiplier: ${regimeSizeMult}x.${regimeOverride?' USER HAS OVERRIDDEN REGIME — show all 5 trades but flag elevated risk on each.':''}
` : ""}
Market session: ${sess.toUpperCase()}.

YOUR A+ SETUP RULES (derived from backtested winning trades NVTS, CRDO vs filtered-out BE, SMTC):
1. Weekly trail must be BULLISH (green trail flipped from bearish)
2. Weekly flip must be RECENT (within 3 weeks) — not an old flip that already ran
3. Weekly RSI must be <= 70 — room to run, not overbought
4. Daily RSI must be <= 70 — momentum healthy, not exhausted
5. Price must be within 20% of the 4H trail stop — not an extended breakout
6. 4H trail must ALSO be bullish for highest conviction (TIER 1/2)
7. Daily green arrow (JAX) firing = additional confirmation (TIER 3)
8. Weekly green arrow (JAX) firing within last 3 weeks = INSTITUTIONAL momentum signal — IONQ, CDNS, QUBT all fired this on April 13th before major moves. When weekly JAX fires AND 4H confirms = A++

SCORING SYSTEM — rank every candidate 0-10 before recommending:
Award points for each condition that is true:

WEEKLY FOUNDATION (required — no weekly = max 2 points total):
+3 = On weekly watchlist (trail flip confirmed within 3 weeks)
+2 = Weekly JAX fired recently
+1 = 200 EMA reclaim on daily

TIMING SIGNALS:
+2 = Green arrow fired TODAY (auto-scan or daily trigger)
+1 = Green arrow fired YESTERDAY (still valid)
+1 = 4H just flipped bullish (fresh, not established)

MOMENTUM QUALITY:
+2 = Bull score 4/5 or 5/5
+1 = Bull score 3/5
+1 = Confluence 4/4 (all pillars)
+1 = Catalyst coil active (ATR coiling)

DEDUCTIONS:
-2 = RSI > 70 (overbought)
-1 = RSI 65-70 (elevated)
-1 = Price > 15% above 4H trail (extended)
-2 = No weekly watchlist confirmation

SCORE THRESHOLDS:
8-10 = A++ — ENTER, full 1% risk
6-7  = A+  — ENTER, 0.75% risk  
4-5  = A   — ENTER, 0.5% risk
2-3  = WATCH — monitor only, no entry
0-1  = SKIP — ignore completely

TRADE SLOTS (up to 5):
- Fill slots in score order — highest score first
- Never recommend a stock scoring below 4
- CRITICAL: Never say a stock is 'already in open position' unless it explicitly appears in the journal data as an unclosed trade with no exit recorded. Do NOT assume positions from context.
- Leave slots empty rather than fill with weak signals
- If 49 green arrows fired — score ALL of them, recommend only top scorers ≥ 4

DATA SOURCES — ALL TABS ARE EQUAL. You MUST evaluate every tab:
- 🔴 RECOVERY TAB — deeply oversold stocks bouncing off lows. IBM ran +40% from a Recovery signal. These are NOT weak — 6/6 Recovery + green arrow = high conviction entry.
- 🟢 JAX TAB — green arrows across 685 stocks. Bull 4-5/5 + green arrow = strong momentum signal regardless of weekly status.
- ⚡ CATALYST TAB — ATR coil + volume = energy building before breakout. VOL-IGNITING = breakout imminent.
- ⚡ CONFLUENCE TAB — 4/4 pillars = all systems aligned. Strong standalone signal.
- 📅 WEEKLY MONITOR — weekly trail flips. Important but NOT the only valid signal source.

SCORING ORDER — evaluate ALL tabs before ranking:
1. 🔥 DAILY TRIGGER — green arrow on weekly watchlist stock today
2. 🔴 RECOVERY 6/6 + green arrow — IBM pattern, highest oversold conviction  
3. ⭐⭐ A++ weekly — flip + 4H flip + 200EMA reclaim
4. ⭐ TIER 1 weekly — flip + 4H just flipped
5. 🟢 JAX bull 5/5 + green arrow today — pure momentum
6. 🟢 TIER 2 weekly — flip + 4H established
7. ⚡ Confluence 4/4 — all pillars firing
8. 🔴 RECOVERY 5/6 or C7 deep bounce
9. ⚡ Catalyst VOL-IGNITING — breakout imminent
10. Pulse movers crossing weekly signals

TIER SYSTEM (priority order):
- A++ ⭐⭐ ENTER NOW: Weekly bull + 4H just flipped + daily 200 EMA fresh reclaim = HIGHEST CONVICTION
- TIER 1 ⭐ ENTER NOW: Weekly bull + 4H just flipped bullish = 96% win rate
- TIER 2 🟢 4H BULLISH: Weekly bull + 4H established bullish = strong setup
- TIER 3 🟣 JAX/EMA: Weekly bull + daily JAX or 200 EMA reclaim, 4H not yet confirmed
- WATCHING: Weekly bull only, nothing else confirmed yet

ENTRY RULES:
- Only recommend TIER 1 or TIER 2 as immediate entries
- TIER 3 = enter on pullback to daily trail only
- Options sizing: max premium spend = $${riskAmt.toFixed(0)} per trade. Typical 30-45 DTE call/put.
- Contracts = floor($${riskAmt.toFixed(0)} / (premium_estimate * 100)), min 1 contract
- Estimate premium as ~3-5% of underlying price for ATM 30-45 DTE options
- Show BOTH: contracts count AND total premium cost ($)
- Stop = just below the 4H trail stop value
- Target = 2-3x the risk distance minimum
- If no TIER 1/2 signals today = say so clearly, recommend WATCHING list

CROSS-REFERENCE RULES (highest conviction combos):
- Stock on WEEKLY WATCHLIST + JAX green arrow fired today = treat as Daily Trigger priority
- Stock on WEEKLY WATCHLIST + CONFLUENCE 4/4 = A++ entry, take immediately
- Stock on WEEKLY WATCHLIST + CONFLUENCE 3/4 + RSI < 65 = strong entry
- JAX only (not on weekly) = wait for pullback, smaller size 0.5%
- CONFLUENCE only (not on weekly) = secondary trade, only if slots 1+2 empty
- CATALYST coil on weekly = treat as TIER 2 conviction — energy building + weekly confirmed
- CATALYST coil only (no weekly) = 0.5% risk max, only if vol igniting
- CATALYST with vol igniting (VOL-IGNITING) = breakout imminent, prioritize over regular coil
- Never recommend catalyst earnings plays — only ATR coil breakouts

TAB GUARANTEE RULES (ensures all scanners get representation):
- If Recovery tab has ANY stock scoring 5/6 or 6/6 conditions = MUST include at least 1 Recovery pick in final 5. Score it: +2 for 6/6, +1 for 5/6, +1 for C7 deep bounce, +1 for RSI < 40, +1 for green arrow confirmed. Recovery picks with RSI < 40 + 6/6 + green arrow = minimum 5/10 entry.
- If JAX auto-scan has ANY stock with bull 4/5 or 5/5 + green arrow today (not on weekly) = MUST include at least 1 pure auto-scan pick if weekly slots 1+2 are filled
- If Catalyst tab has ANY stock with heat score 8+ or VOL-IGNITING status = MUST include at least 1 catalyst pick
- These guarantees only apply if the respective tab data is present and has qualifying signals
- Weekly picks still fill slots 1-2 first. Tab guarantees fill remaining slots 3-5

POSITION SIZING BY CONVICTION:
- Daily Trigger fired today + Weekly = full 1% risk
- A++ or TIER 1 Weekly = full 1% risk  
- TIER 2 Weekly or Confluence 4/4 + Weekly = 0.75% risk
- JAX only or Confluence without weekly = 0.5% risk
- Never exceed max trades regardless of signals

WHAT TO AVOID:
- Any stock where price is >20% above 4H trail (extended, chasing)
- Weekly RSI > 70 (late stage, momentum fading)
- Daily RSI > 70 (short term overbought)
- Weekly flip older than 3 weeks without a pullback re-entry setup
- Stocks showing RSI Bear divergence on weekly or daily
- Filling trade slots with weak signals just to reach max trades — quality over quantity

Return ONLY this exact JSON structure (no other text):
{
  "context": "one sentence market context",
  "confidence": "X/10 — one sentence explanation",
  "avoid": "one sentence on what to avoid today",
  "trades": [
    {
      "sym": "TICKER",
      "score": 8,
      "action": "ENTER or WATCH or SKIP",
      "entry": 123.45,
      "stop": 120.00,
      "target": 135.00,
      "option_type": "call",
      "strike_guidance": "ATM or 1 strike OTM (e.g. $124C)",
      "expiry_guidance": "30-45 DTE from today",
      "est_premium": 2.50,
      "contracts": 3,
      "total_cost": 750,
      "risk_pct": 1.0,
      "win_rate_note": "weekly+4H+200EMA = A++ setup",
      "notes": "score breakdown: +3 weekly +2 today +2 bull5/5 +1 200EMA = 8/10"
    }
  ],
  "recommendation": "final recommendation with key reasoning",
  "skipped": "brief note on why other signals were skipped"
}`;

    const user = `Here is today's scanner data and my trading history. Give me my morning brief with up to ${regimeMaxTrades} trades (regime-adjusted from ${maxT} max).

${scanCtx}
${liveCtx}
${jnlCtx}${calibrationCtx}`;

    const raw = await callClaude(system, user, 4000);

    // Parse JSON response — strip any markdown formatting Claude adds
    let brief;
    try{
      // Remove ALL backtick code fences regardless of position
      let clean = raw.replace(/```json/gi,"").replace(/```/g,"").trim();
      // Find first { and last } to extract just the JSON object
      const start = clean.indexOf("{");
      let end     = clean.lastIndexOf("}");
      if(start !== -1 && end !== -1) clean = clean.substring(start, end+1);
      // If JSON is truncated, try to close it
      if(start !== -1 && end === -1){
        clean = clean.substring(start);
        // Close any open arrays/objects
        let depth = 0;
        for(const c of clean){ if(c==="{") depth++; if(c==="}") depth--; }
        clean += "]}".repeat(Math.max(0,depth));
      }
      brief = JSON.parse(clean);
    }catch(ex){
      // Try harder — find the outermost { } pair and parse that
      try{
        const s = raw.indexOf("{");
        const e = raw.lastIndexOf("}");
        if(s !== -1 && e !== -1){
          let attempt = raw.substring(s, e+1);
          // Fix common Claude JSON errors: trailing commas, unescaped newlines
          attempt = attempt.replace(/,\s*([}\]])/g,"$1").replace(/[\n\r]/g," ");
          brief = JSON.parse(attempt);
          console.warn("JSON recovered on second attempt");
        } else { throw ex; }
      }catch(ex2){
        body.innerHTML = `<div style="font-family:var(--mono);font-size:11px;line-height:1.9;color:var(--text)">${renderMD(raw)}</div>`;
        console.error("JSON parse failed:", ex2.message, "\nRaw:", raw.substring(0,500));
      document.getElementById("agent-brief-time").textContent = new Date().toLocaleTimeString();
    // Re-render regime banner (sits above brief)
    if(window.currentRegime) renderRegimeBanner(window.currentRegime);
      document.getElementById("agent-lastrun").textContent = "Last brief: "+new Date().toLocaleTimeString();
      try{
        const briefData = {text:raw, html:body.innerHTML, time:new Date().toISOString(), isJson:false};
        localStorage.setItem("cs_agent_brief", JSON.stringify(briefData));
        fbSafeSave("agent_brief", briefData);
      }catch(e){}
      btn.disabled = false;
      return;
      }
    }

    // Action color
    function actionColor(a){
      if(!a) return "var(--green2)";
      const u = a.toUpperCase();
      if(u==="ENTER") return "var(--green2)";
      if(u==="WATCH") return "var(--yellow)";
      return "#FF9800";
    }

    // Render structured cards
    const scoreColor = (s)=> s>=8?"#00E676":s>=6?"var(--green2)":s>=4?"var(--yellow)":"var(--red)";
    const tradesHTML = (brief.trades||[]).filter(t=>t.action!=="SKIP").map((t,i)=>`
      <div style="background:#0d1f14;border:1px solid #1a3a20;border-radius:4px;padding:12px 14px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="font-size:15px;font-weight:700;color:#fff">${i+1}. ${t.sym}</span>
          <span style="font-size:9px;font-weight:700;letter-spacing:1px;padding:2px 8px;border-radius:2px;background:${actionColor(t.action)};color:#000">${t.action||"ENTER"}</span>
          ${t.score?`<span style="font-size:10px;font-weight:700;color:${scoreColor(t.score)};padding:2px 6px;background:rgba(0,0,0,0.3);border-radius:2px">${t.score}/10</span>`:""}
          ${t.risk_pct?`<span style="font-size:9px;color:var(--muted2)">${t.risk_pct}% risk</span>`:""}
          ${t.win_rate_note?`<span style="font-size:9px;color:var(--muted2);margin-left:auto">${t.win_rate_note}</span>`:""}
          <button data-sym="${t.sym}" data-price="${t.entry||0}" data-stop="${t.stop||0}" data-target="${t.target||0}"
            onclick="const d=this.dataset;logToJournal({sym:d.sym,price:parseFloat(d.price),score:'W',source:'agent',session:getMarketSession(),greenArrow:true,tradeType:'Swing',stopLoss:parseFloat(d.stop),target1:parseFloat(d.target)})"
            style="background:#0d2b0d;border:1px solid var(--green2);color:var(--green2);font-family:var(--mono);font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px;letter-spacing:1px;margin-left:${t.win_rate_note?'4px':'auto'}">
            📓 LOG
          </button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px">
          <div style="background:#0a1a0f;border-radius:3px;padding:6px 8px">
            <div style="font-size:8px;color:var(--muted2);letter-spacing:1px">ENTRY</div>
            <div style="font-size:13px;font-weight:700;color:var(--green2)">$${t.entry||"—"}</div>
          </div>
          <div style="background:#0a1a0f;border-radius:3px;padding:6px 8px">
            <div style="font-size:8px;color:var(--muted2);letter-spacing:1px">STOP</div>
            <div style="font-size:13px;font-weight:700;color:var(--red)">$${t.stop||"—"}</div>
          </div>
          <div style="background:#0a1a0f;border-radius:3px;padding:6px 8px">
            <div style="font-size:8px;color:var(--muted2);letter-spacing:1px">TARGET</div>
            <div style="font-size:13px;font-weight:700;color:#64B5F6">$${t.target||"—"}</div>
          </div>
          <div style="background:#0a1a0f;border-radius:3px;padding:6px 8px">
            <div style="font-size:8px;color:var(--muted2);letter-spacing:1px">OPTION</div>
            <div style="font-size:11px;font-weight:700;color:#fff">${t.strike_guidance||"ATM"} <span style="font-size:9px;color:var(--muted2)">${t.option_type||"call"} · ${t.expiry_guidance||"30-45 DTE"}</span></div>
          </div>
          <div style="background:#0a1a0f;border-radius:3px;padding:6px 8px">
            <div style="font-size:8px;color:var(--muted2);letter-spacing:1px">CONTRACTS</div>
            <div style="font-size:13px;font-weight:700;color:#fff">${t.contracts||"—"} <span style="font-size:9px;color:var(--muted2)">× $${t.est_premium||"?"} = $${t.total_cost||"?"}</span></div>
          </div>
        </div>
        ${t.notes?`<div style="font-size:10px;color:var(--muted2);line-height:1.6;border-top:1px solid #1a3a20;padding-top:7px">${t.notes}</div>`:""}
      </div>`).join("");

    const confidenceColor = ()=>{
      const n = parseInt((brief.confidence||"0").split("/")[0]);
      if(n>=7) return "var(--green2)";
      if(n>=4) return "var(--yellow)";
      return "var(--red)";
    };

    body.innerHTML = `
      <div style="font-family:var(--mono)">
        <!-- Context bar -->
        <div style="font-size:11px;color:var(--text);line-height:1.7;margin-bottom:14px;padding:10px 12px;background:#0a1520;border-left:3px solid var(--green2);border-radius:2px">
          ${brief.context||""}
        </div>

        <!-- Trade cards -->
        ${tradesHTML}

        <!-- Avoid -->
        ${brief.avoid?`<div style="font-size:10px;color:var(--red);margin-bottom:12px;padding:8px 12px;background:#1a0a0a;border-left:3px solid var(--red);border-radius:2px">⚠️ ${brief.avoid}</div>`:""}

        <!-- Recommendation -->
        ${brief.recommendation?`<div style="font-size:11px;color:var(--text);line-height:1.8;margin-bottom:12px;padding:10px 12px;background:#0d1520;border-left:3px solid #64B5F6;border-radius:2px">${renderMD(brief.recommendation)}</div>`:""}

        <!-- Skipped -->
        ${brief.skipped?`<div style="font-size:9px;color:var(--muted2);padding:6px 12px;margin-bottom:8px;font-family:var(--mono)">⏭ SKIPPED: ${brief.skipped}</div>`:""}

        <!-- Confidence -->
        <div style="font-size:10px;color:${confidenceColor()};padding:8px 12px;background:#0a0a0a;border-radius:3px;border:1px solid #1a1a1a">
          📊 CONFIDENCE: ${brief.confidence||"—"}
        </div>
      </div>`;

    document.getElementById("agent-brief-time").textContent = new Date().toLocaleTimeString();
    document.getElementById("agent-lastrun").textContent = "Last brief: "+new Date().toLocaleTimeString();

    // Save both raw text AND rendered HTML — localStorage for speed, Firebase for cross-device sync
    try{
      const cleanRaw = raw.replace(/```json|```/g, "").trim();
      const briefData = { text: cleanRaw, html: body.innerHTML, time: new Date().toISOString(), isJson: true };
      localStorage.setItem("cs_agent_brief", JSON.stringify(briefData));
      fbSafeSave("agent_brief", briefData);
    }catch(e){}

  }catch(e){
    body.innerHTML = `<div class="agent-output" style="color:var(--red)">Error: ${e.message}<br><br>Make sure your scanner has run today and Firebase has data.</div>`;
  }
  btn.disabled = false;
}

// ══════════════════════════════════════════════════════════
// JOB 2: ENTRY CONFIRMATION
// ══════════════════════════════════════════════════════════
async function confirmEntry(){
  const sym   = (document.getElementById("agent-entry-sym")?.value||"").trim().toUpperCase();
  const price = parseFloat(document.getElementById("agent-entry-price")?.value)||0;
  const body  = document.getElementById("agent-entry-body");

  if(!sym){ body.innerHTML='<div class="agent-output" style="color:var(--red)">Enter a ticker symbol</div>'; return; }

  body.innerHTML = '<div class="agent-output loading">⏳ Analyzing '+sym+'...</div>';

  try{
    const data    = await gatherAllData();
    const account = parseFloat(document.getElementById("agent-account").value)||10000;
    const risk    = parseFloat(document.getElementById("agent-risk").value)||1;
    const riskAmt = account * (risk/100);

    // Find sym in all scanners
    const inWeekly    = (data.weekly_monitor||[]).find(r=>r.sym===sym);
    const inJAX       = (data.jax_scan||[]).find(r=>r.sym===sym&&r.greenArrow);
    const inConf      = (data.confluence||[]).find(r=>r.sym===sym);
    const inPulse     = (data.pulse||[]).find(r=>r.sym===sym);
    const inRecovery  = (data.recovery||[]).find(r=>r.sym===sym);
    const inCatalyst  = (data.catalyst||[]).find(r=>r.sym===sym);

    // Journal history for this symbol
    const journal     = Array.isArray(data.journal)?data.journal:[];
    const symHistory  = journal.filter(e=>e.sym===sym);
    const openPos     = journal.find(e=>e.sym===sym&&e.status==="open");
    const srcStats    = {};
    journal.forEach(e=>{
      const s=e.source||"manual";
      if(!srcStats[s]) srcStats[s]={w:0,l:0};
      if(e.status==="win") srcStats[s].w++;
      if(e.status==="loss") srcStats[s].l++;
    });

    // Find sym in cron alerts too
    const cronData   = data.jax_cron_alerts;
    const inCron     = cronData && cronData.data ? cronData.data.find(r=>r.sym===sym) : null;

    // Calculate conviction score using same system as Morning Brief
    let score = 0;
    const scoreBreakdown = [];
    if(inWeekly){
      score += 3; scoreBreakdown.push("+3 weekly watchlist");
      if(inWeekly.weeklyJAXRecent){ score += 2; scoreBreakdown.push("+2 weekly JAX fired"); }
      if(inWeekly.daily200Reclaim){ score += 1; scoreBreakdown.push("+1 200EMA reclaim"); }
      if(inWeekly.h4FlipRecent)   { score += 1; scoreBreakdown.push("+1 4H just flipped"); }
    }
    if(inCron){ score += 2; scoreBreakdown.push("+2 green arrow today (auto-scan)"); }
    else if(inJAX){ score += 1; scoreBreakdown.push("+1 green arrow (JAX)"); }
    if(inJAX && inJAX.bullScore >= 4){ score += 2; scoreBreakdown.push("+2 bull "+inJAX.bullScore+"/5"); }
    else if(inJAX && inJAX.bullScore === 3){ score += 1; scoreBreakdown.push("+1 bull 3/5"); }
    if(inConf && inConf.confScore === 4){ score += 1; scoreBreakdown.push("+1 confluence 4/4"); }
    if(inCatalyst && inCatalyst.atrCoiling){ score += 1; scoreBreakdown.push("+1 catalyst coil"); }
    if(!inWeekly){ score -= 2; scoreBreakdown.push("-2 not on weekly watchlist"); }
    const rsi = inWeekly?.rsi || inJAX?.rsi14 || 0;
    if(rsi > 70){ score -= 2; scoreBreakdown.push("-2 RSI "+rsi.toFixed(0)+" overbought"); }
    else if(rsi > 65){ score -= 1; scoreBreakdown.push("-1 RSI "+rsi.toFixed(0)+" elevated"); }

    const scoreGrade = score >= 8 ? "A++ 🔥" : score >= 6 ? "A+" : score >= 4 ? "A" : score >= 2 ? "WATCH" : "SKIP";

    const symCtx = [
      `CONVICTION SCORE: ${score}/10 — ${scoreGrade}`,
      `Score breakdown: ${scoreBreakdown.join(", ")}`,
      "",
      inWeekly  ? `✅ Weekly Monitor: TIER${inWeekly.tier1?"1 ⭐":inWeekly.tier2?"2 🟢":"3"} | flip ${inWeekly.weeksAgo}wk ago at $${inWeekly.weeklyFlipPrice?.toFixed(2)} | 4H ${inWeekly.h4Bullish?"bullish ✅":"bearish ❌"} | W-RSI ${inWeekly.weeklyRsi?.toFixed(0)} | D-RSI ${inWeekly.rsi?.toFixed(0)}` : "❌ Weekly Monitor: NOT on watchlist",
      inCron    ? `✅ AUTO-SCAN: Green arrow fired TODAY | bull ${inCron.bullScore}/5 | RSI ${inCron.rsi?.toFixed(0)}` : "",
      inJAX     ? `✅ JAX: Green arrow | bull score ${inJAX.bullScore}/5 | trail $${inJAX.trailVal?.toFixed(2)}` : "❌ JAX: no green arrow",
      inConf    ? `✅ Confluence: ${inConf.confScore}/4 | pillars: ${Object.entries(inConf.pillars||{}).filter(([,v])=>v).map(([k])=>k.toUpperCase()).join("+")}` : "❌ Confluence: not in scan",
      inCatalyst? `✅ Catalyst: ATR coiling ${inCatalyst.atrCoiling?"YES":"NO"}` : "",
      inPulse   ? `📊 Pulse: ${inPulse.changePct>=0?"▲":"▼"}${Math.abs(inPulse.changePct||0).toFixed(1)}% today` : "",
      openPos   ? `⚠️ ALREADY OPEN: entered $${parseFloat(openPos.price).toFixed(2)}` : "No open position",
      symHistory.length ? `History: ${symHistory.filter(e=>e.status==="win").length}W/${symHistory.filter(e=>e.status==="loss").length}L on ${sym}` : "No history on this stock",
    ].filter(Boolean).join("\n");

    const winRateCtx = Object.entries(srcStats).map(([s,v])=>`${s}: ${v.w+v.l>0?Math.round(v.w/(v.w+v.l)*100)+"%":"—"} (${v.w+v.l} trades)`).join(", ");

    const system = `You are a professional trading advisor using a proven conviction scoring system.
Score: ${score}/10 — ${scoreGrade}
Rules:
- Score 8-10 = YES, full 1% risk
- Score 6-7 = YES, 0.75% risk  
- Score 4-5 = YES, 0.5% risk
- Score 2-3 = WAIT for better entry
- Score 0-1 = NO
Be direct. Under 200 words. Lead with YES/NO/WAIT.`;

    const user = `Should I enter ${sym} at ${price>0?"$"+price.toFixed(2):"current price"}?

${symCtx}

MY WIN RATES: ${winRateCtx}
Account: $${account} | Max risk: $${riskAmt.toFixed(0)}

Give: decision, one-line reason, stop level on underlying, option guidance (strike, expiry, est premium, contracts), confidence.`;

    const response = await callClaude(system, user, 400);
    const isYes    = response.toLowerCase().startsWith("yes");
    const isNo     = response.toLowerCase().startsWith("no");
    const isWait   = response.toLowerCase().startsWith("wait");
    const clr      = isYes?"var(--green2)":isNo?"var(--red)":"var(--yellow)";
    const scoreClr = score>=8?"#00E676":score>=6?"var(--green2)":score>=4?"var(--yellow)":"var(--red)";

    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:${clr}">${response.split("\n")[0]}</div>
        <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:${scoreClr};padding:2px 8px;background:rgba(0,0,0,0.3);border-radius:3px">${score}/10 ${scoreGrade}</div>
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted2);margin-bottom:8px">${scoreBreakdown.join(" · ")}</div>
      <div style="font-family:var(--mono);font-size:11px;line-height:1.9;color:var(--text)">${renderMD(response.split("\n").slice(1).join("\n"))}</div>`;

  }catch(e){
    body.innerHTML = `<div class="agent-output" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// ══════════════════════════════════════════════════════════
// JOB 3: EXIT MONITOR
// ══════════════════════════════════════════════════════════
async function runExitMonitor(){
  const body = document.getElementById("agent-exit-body");
  body.innerHTML = '<div class="agent-output loading">⏳ Checking open positions...</div>';

  try{
    const data    = await gatherAllData();
    const journal = Array.isArray(data.journal)?data.journal:[];
    const open    = journal.filter(e=>e.status==="open"&&e.price&&parseFloat(e.price)>0);

    if(!open.length){
      body.innerHTML = '<div class="agent-output" style="color:var(--muted2)">No open positions in journal.</div>';
      return;
    }

    // Check each open position against current JAX and weekly data
    const exitSignals = [];
    const holds       = [];

    for(const pos of open){
      const sym      = pos.sym;
      const entry    = parseFloat(pos.price);
      const stop     = parseFloat(pos.stopLoss)||0;
      const target   = parseFloat(pos.target1)||0;

      // Check JAX status
      const jaxData  = (data.jax_scan||[]).find(r=>r.sym===sym);
      const wkData   = (data.weekly_monitor||[]).find(r=>r.sym===sym);
      const pulseData= (data.pulse||[]).find(r=>r.sym===sym);

      const currentPrice = pulseData?.price || entry;
      const unrealPct    = ((currentPrice-entry)/entry*100).toFixed(1);
      const jaxBearish   = jaxData && !jaxData.greenArrow && jaxData.bullScore <= 2;
      const wkBearish    = wkData && !wkData.weeklyBullish;

      if(jaxBearish || wkBearish){
        exitSignals.push({sym, entry, currentPrice, unrealPct, reason: jaxBearish?"JAX turned bearish":"Weekly trail flipped"});
      } else {
        holds.push({sym, entry, currentPrice, unrealPct, target, stop});
      }
    }

    let html = "";

    if(exitSignals.length){
      html += `<div style="color:var(--red);font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:1px;margin-bottom:8px">🚨 EXIT SIGNALS</div>`;
      exitSignals.forEach(s=>{
        const pnlClr = parseFloat(s.unrealPct)>=0?"var(--green2)":"var(--red)";
        html += `<div class="agent-trade" style="border-color:rgba(255,23,68,0.4);background:rgba(255,23,68,0.04);margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="agent-trade-sym" style="display:flex;align-items:center;gap:5px">${tickerLogo(s.sym,18)}${s.sym}</span>
            <span style="font-family:var(--mono);font-size:8px;color:var(--red);font-weight:700">🚨 CONSIDER EXIT</span>
          </div>
          <div class="agent-trade-detail">Entry $${s.entry.toFixed(2)} → Now $${s.currentPrice.toFixed(2)} · <span style="color:${pnlClr}">${parseFloat(s.unrealPct)>=0?"+":""}${s.unrealPct}%</span><br>Reason: ${s.reason}</div>
        </div>`;
      });
    }

    if(holds.length){
      html += `<div style="color:var(--green2);font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:1px;margin:8px 0">✅ HOLD</div>`;
      holds.forEach(s=>{
        const pnlClr = parseFloat(s.unrealPct)>=0?"var(--green2)":"var(--red)";
        const toTarget = s.target>0?((s.target-s.currentPrice)/s.currentPrice*100).toFixed(1):null;
        html += `<div class="agent-trade" style="margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="agent-trade-sym" style="display:flex;align-items:center;gap:5px">${tickerLogo(s.sym,18)}${s.sym}</span>
            <span style="font-family:var(--mono);font-size:8px;color:var(--green2)">HOLD</span>
          </div>
          <div class="agent-trade-detail">Entry $${s.entry.toFixed(2)} → Now $${s.currentPrice.toFixed(2)} · <span style="color:${pnlClr}">${parseFloat(s.unrealPct)>=0?"+":""}${s.unrealPct}%</span>${toTarget?` · ${toTarget}% to target`:""}${s.stop?" · Stop $"+s.stop.toFixed(2):""}</div>
        </div>`;
      });
    }

    body.innerHTML = html || '<div class="agent-output" style="color:var(--muted2)">No signals detected on open positions.</div>';

  }catch(e){
    body.innerHTML = `<div class="agent-output" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// ══════════════════════════════════════════════════════════
// JOB 4: PATTERN ANALYSIS
// ══════════════════════════════════════════════════════════
async function runPatternAnalysis(){
  const btn  = document.getElementById("agent-patterns-btn");
  const body = document.getElementById("agent-patterns-body");
  btn.disabled = true;
  body.innerHTML = '<div class="agent-output loading">⏳ Analyzing your trading patterns...</div>';

  try{
    const data    = await gatherAllData();
    const journal = Array.isArray(data.journal)?data.journal:[];

    if(journal.length < 5){
      body.innerHTML = '<div class="agent-output" style="color:var(--muted2)">Need at least 5 journal entries for pattern analysis.</div>';
      btn.disabled = false;
      return;
    }

    // Build detailed journal data for Claude
    const closed = journal.filter(e=>e.status==="win"||e.status==="loss");
    const jnlData = closed.slice(0,50).map(e=>({
      sym:    e.sym,
      source: e.source||"manual",
      result: parseFloat(e.result||0),
      status: e.status,
      rsi:    e.rsi||null,
      score:  e.score,
      greenArrow: e.greenArrow||false,
      session: e.session||"unknown",
      tradeType: e.tradeType||"",
      date:   e.date||""
    }));

    const system = `You are a quantitative trading analyst. Analyze this trader's journal data and identify specific, actionable patterns. Be data-driven. Focus on what ACTUALLY improves their win rate based on the data. Under 300 words. Use bullet points.`;

    const user = `Analyze my trading journal and tell me:
1. Which signal sources produce my best results
2. Any time/session patterns (morning vs afternoon)
3. What my worst trades have in common
4. My single biggest improvement opportunity
5. What I should do MORE of based on the data

My journal (${closed.length} closed trades):
${JSON.stringify(jnlData, null, 1)}

Be specific with numbers. If a pattern isn't clear in the data, say so.`;

    const response = await callClaude(system, user, 600);
    body.innerHTML = `<div style="font-family:var(--mono);font-size:11px;line-height:1.9;color:var(--text)">${renderMD(response)}</div>`;

  }catch(e){
    body.innerHTML = `<div class="agent-output" style="color:var(--red)">Error: ${e.message}</div>`;
  }
  btn.disabled = false;
}

// ══════════════════════════════════════════════════════════
// JOB 5: WEEKLY REVIEW
// ══════════════════════════════════════════════════════════
async function runWeeklyReview(){
  const btn  = document.getElementById("agent-review-btn");
  const body = document.getElementById("agent-review-body");
  btn.disabled = true;
  body.innerHTML = '<div class="agent-output loading">⏳ Running weekly review...</div>';

  try{
    const data    = await gatherAllData();
    const journal = Array.isArray(data.journal)?data.journal:[];

    // Get last 7 days
    const weekAgo  = new Date(Date.now() - 7*24*60*60*1000);
    const thisWeek = journal.filter(e=>{
      try{ return new Date(e.loggedAt||e.date) >= weekAgo; }catch(ex){ return false; }
    });

    const system = `You are a professional trading coach doing a weekly performance review. Be honest, direct, and constructive. Focus on process not just results. Under 400 words.`;

    const user = `Review my trading week and give me:
1. Performance summary (numbers)
2. What worked well this week
3. What to improve next week
4. Specific rule to follow next week based on my patterns
5. Confidence level going into next week

This week's trades (${thisWeek.length} entries):
${JSON.stringify(thisWeek.slice(0,20), null, 1)}

Overall journal context:
${buildJournalContext(journal)}

Current scanner signals summary:
${buildScannerContext(data)}`;

    const response = await callClaude(system, user, 600);
    body.innerHTML = `<div style="font-family:var(--mono);font-size:11px;line-height:1.9;color:var(--text)">${renderMD(response)}</div>`;

  }catch(e){
    body.innerHTML = `<div class="agent-output" style="color:var(--red)">Error: ${e.message}</div>`;
  }
  btn.disabled = false;
}

// ── Load saved agent brief on startup ─────────────────────
// ── Load saved agent brief on startup / tab switch ────────
function loadAgent(){
  if(typeof window.fbLoad !== "function"){
    // Firebase not ready yet — wait for it
    document.addEventListener("firebaseReady", loadAgent, {once:true});
    return;
  }
  const body   = document.getElementById("agent-brief-body");
  const timeEl = document.getElementById("agent-brief-time");
  const lastRun= document.getElementById("agent-lastrun");

  // Try Firebase first for cross-device sync, fall back to localStorage
  window.fbLoad("agent_brief").then(fb=>{
    const fbData   = fb ? fb.data : null;
    const lsRaw    = localStorage.getItem("cs_agent_brief");
    const lsData   = lsRaw ? JSON.parse(lsRaw) : null;

    // Use whichever is more recent
    let saved = null;
    if(fbData && lsData){
      saved = new Date(fbData.time) > new Date(lsData.time) ? fbData : lsData;
    } else {
      saved = fbData || lsData;
    }

    if(saved && body){
      if(saved.html){
        body.innerHTML = saved.html;
      } else if(saved.isJson){
        body.innerHTML = `<div style="font-family:var(--mono);font-size:11px;color:var(--muted2);padding:10px">📋 Last brief from ${new Date(saved.time).toLocaleTimeString()} — tap MORNING BRIEF to refresh.</div>`;
      } else {
        body.innerHTML = `<div style="font-family:var(--mono);font-size:11px;line-height:1.9;color:var(--text)">${renderMD(saved.text)}</div>`;
      }
      if(timeEl)  timeEl.textContent  = new Date(saved.time).toLocaleTimeString();
      if(lastRun) lastRun.textContent = "Last brief: "+new Date(saved.time).toLocaleTimeString();
      // Sync to localStorage if Firebase had newer data
      if(fbData && saved === fbData){
        try{ localStorage.setItem("cs_agent_brief", JSON.stringify(fbData)); }catch(e){}
      }
    }
  }).catch(()=>{
    // Firebase failed — fall back to localStorage only
    try{
      const lsRaw = localStorage.getItem("cs_agent_brief");
      if(!lsRaw) return;
      const saved = JSON.parse(lsRaw);
      if(body){
        if(saved.html) body.innerHTML = saved.html;
        else body.innerHTML = `<div style="font-family:var(--mono);font-size:11px;line-height:1.9;color:var(--text)">${renderMD(saved.text||"")}</div>`;
      }
      if(timeEl)  timeEl.textContent  = new Date(saved.time).toLocaleTimeString();
      if(lastRun) lastRun.textContent = "Last brief: "+new Date(saved.time).toLocaleTimeString();
    }catch(e){}
  });

  // Update stats on load
  document.addEventListener("firebaseReady", async()=>{
    try{
      const data = await gatherAllData();
      updateAgentStats(data);
    }catch(e){}
  });
}
