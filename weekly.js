// ── weekly.js ────────────────────────────────────────────────────────────────
// Weekly Monitor, Daily Trigger, Cron Alerts, Weinstein Stage Analysis
// Depends on: fbSafeSave, fbLoad, fbListen (firebase.js)
//             fetch4HCandles, fetchCandlesWithKey (api.js)
//             log, sleep, sendNotification (index.html)
// Exposes: wmResults, startWeeklyMonitor, renderWeeklyMonitor, loadWeeklyMonitor,
//          loadCronAlerts, loadWeeklyCronAlerts, loadWeinstein, toggleAccordion
// ─────────────────────────────────────────────────────────────────────────────


async function fetchWeeklyCandles(sym, keyIndex){
  const key = TD_KEYS[keyIndex % TD_KEYS.length];
  const url  = "https://api.twelvedata.com/time_series?symbol="+sym
               +"&interval=1week&outputsize=260&apikey="+key;
  const r = await fetch(url, {cache:"no-store"});
  if(!r.ok) throw new Error("HTTP "+r.status);
  const d = await r.json();
  if(d.status==="error"){
    if(d.message&&(d.message.includes("not found")||d.message.includes("missing or invalid")))
      throw new Error("SKIP:"+d.message);
    throw new Error(d.message||"API error");
  }
  if(!d.values||!d.values.length) throw new Error("No weekly data");
  const vals = [...d.values].reverse(); // oldest first
  return {
    closes:  vals.map(v=>parseFloat(v.close)),
    highs:   vals.map(v=>parseFloat(v.high)),
    lows:    vals.map(v=>parseFloat(v.low)),
    volumes: vals.map(v=>parseFloat(v.volume)||0),
    dates:   vals.map(v=>v.datetime),
    bars:    vals.length
  };
}

// Find all weekly trail flip points (bearish→bullish transitions)
function findWeeklyTrailFlips(closes, highs, lows, dates){
  if(closes.length < 15) return [];
  
  const trail = calcATRTrailStop(highs, lows, closes, 10, 3.5);
  
  // Recalculate full trail history to find all flips
  let trailVal = closes[0], tdir = 0;
  const history = [];
  
  for(let i=1; i<closes.length; i++){
    const atrVals = [];
    for(let j=Math.max(0,i-10); j<i; j++){
      const tr = Math.max(
        highs[j]-lows[j],
        Math.abs(highs[j]-(j>0?closes[j-1]:closes[j])),
        Math.abs(lows[j]-(j>0?closes[j-1]:closes[j]))
      );
      atrVals.push(tr);
    }
    const atrV   = atrVals.reduce((a,b)=>a+b,0)/atrVals.length;
    const nLoss  = 3.5 * atrV;
    const trailUp   = closes[i] - nLoss;
    const trailDown = closes[i] + nLoss;
    const prevTrail = trailVal;
    
    if(closes[i] > trailVal && closes[i-1] > trailVal)       trailVal = Math.max(trailVal, trailUp);
    else if(closes[i] < trailVal && closes[i-1] < trailVal)  trailVal = Math.min(trailVal, trailDown);
    else if(closes[i] > trailVal)                             trailVal = trailUp;
    else                                                      trailVal = trailDown;
    
    const prevDir = tdir;
    tdir = trailVal > prevTrail ? 1 : trailVal < prevTrail ? -1 : tdir;
    history.push({ close: closes[i], trail: trailVal, dir: tdir, prevDir, date: dates[i], idx: i });
  }
  
  // Find all bearish→bullish flips
  const flips = [];
  for(let i=1; i<history.length; i++){
    const cur  = history[i];
    const prev = history[i-1];
    if(cur.dir === 1 && prev.dir === -1){
      // This is a flip — record it
      flips.push({
        date:       cur.date,
        flipIdx:    cur.idx,
        flipPrice:  cur.close,
        trailVal:   cur.trail,
      });
    }
  }
  return { flips, history };
}

// Measure return N weeks after each flip
function measureReturns(flips, closes, dates, holdWeeks){
  return flips.map(flip=>{
    const entryIdx = flip.flipIdx;
    const exitIdx  = Math.min(entryIdx + holdWeeks, closes.length - 1);
    const exitPrice= closes[exitIdx];
    const exitDate = dates[exitIdx];
    const ret      = ((exitPrice - flip.flipPrice) / flip.flipPrice) * 100;
    const isActive = exitIdx === closes.length - 1; // still in trade
    
    // Also find max gain and max loss during hold period
    let maxGain = 0, maxLoss = 0;
    for(let i=entryIdx+1; i<=exitIdx; i++){
      const pct = ((closes[i] - flip.flipPrice) / flip.flipPrice) * 100;
      if(pct > maxGain) maxGain = pct;
      if(pct < maxLoss) maxLoss = pct;
    }
    
    return {
      ...flip,
      exitPrice,
      exitDate,
      returnPct: ret,
      maxGain,
      maxLoss,
      isActive,
      isWin: ret > 0
    };
  });
}


// ══════════════════════════════════════════════════════════
// 4H MULTI-TIMEFRAME BACKTEST
// Pattern: 4H trail flip bullish WHILE weekly already bullish
// Validated visually: COHR, MU, MRVL, CSCO, POWL
// This catches entries BEFORE the daily green arrow fires
// ══════════════════════════════════════════════════════════

// Fetch 4H candles from Twelve Data (1 credit per stock)

// Map weekly bar index to approximate 4H bar index
// Weekly bar = 5 trading days = ~10 4H bars (2 per day)
function weeklyIdxTo4HIdx(weeklyIdx, weeklyDates, h4Dates){
  if(!weeklyDates || !h4Dates) return -1;
  const weeklyDate = weeklyDates[weeklyIdx];
  if(!weeklyDate) return -1;
  // Find closest 4H bar to this weekly bar date
  const wDate = new Date(weeklyDate).getTime();
  let closest = -1, minDiff = Infinity;
  for(let i=0; i<h4Dates.length; i++){
    const diff = Math.abs(new Date(h4Dates[i]).getTime() - wDate);
    if(diff < minDiff){ minDiff=diff; closest=i; }
  }
  return closest;
}

// Find all 4H trail flips that occur WHILE weekly is bullish
// This is the core of the multi-timeframe backtest
function find4HFlipsInWeeklyBull(
  wkCloses, wkHighs, wkLows, wkDates,
  h4Closes, h4Highs, h4Lows, h4Dates
){
  if(wkCloses.length < 15 || h4Closes.length < 20) return [];

  // ── Step 1: Build weekly trail direction history ───────────────────────
  let wkTrail = wkCloses[0], wkDir = 0;
  const wkHistory = [];
  for(let i=1; i<wkCloses.length; i++){
    const atrVals = [];
    for(let j=Math.max(0,i-10); j<i; j++){
      const tr = Math.max(
        wkHighs[j]-wkLows[j],
        Math.abs(wkHighs[j]-(j>0?wkCloses[j-1]:wkCloses[j])),
        Math.abs(wkLows[j]-(j>0?wkCloses[j-1]:wkCloses[j]))
      );
      atrVals.push(tr);
    }
    const atrV  = atrVals.reduce((a,b)=>a+b,0)/Math.max(atrVals.length,1);
    const nLoss = 3.5 * atrV;
    const prevTrail = wkTrail;
    if(wkCloses[i]>wkTrail && wkCloses[i-1]>wkTrail)       wkTrail=Math.max(wkTrail,wkCloses[i]-nLoss);
    else if(wkCloses[i]<wkTrail && wkCloses[i-1]<wkTrail)  wkTrail=Math.min(wkTrail,wkCloses[i]+nLoss);
    else if(wkCloses[i]>wkTrail)                            wkTrail=wkCloses[i]-nLoss;
    else                                                    wkTrail=wkCloses[i]+nLoss;
    const prevDir = wkDir;
    wkDir = wkTrail>prevTrail?1:wkTrail<prevTrail?-1:wkDir;
    wkHistory.push({ dir:wkDir, date:wkDates[i], idx:i });
  }

  // ── Step 2: Build 4H trail direction history ────────────────────────────
  let h4Trail = h4Closes[0], h4Dir = 0;
  const h4History = [];
  for(let i=1; i<h4Closes.length; i++){
    const atrVals = [];
    for(let j=Math.max(0,i-10); j<i; j++){
      const tr = Math.max(
        h4Highs[j]-h4Lows[j],
        Math.abs(h4Highs[j]-(j>0?h4Closes[j-1]:h4Closes[j])),
        Math.abs(h4Lows[j]-(j>0?h4Closes[j-1]:h4Closes[j]))
      );
      atrVals.push(tr);
    }
    const atrV  = atrVals.reduce((a,b)=>a+b,0)/Math.max(atrVals.length,1);
    const nLoss = 3.5 * atrV;
    const prevTrail = h4Trail;
    if(h4Closes[i]>h4Trail && h4Closes[i-1]>h4Trail)       h4Trail=Math.max(h4Trail,h4Closes[i]-nLoss);
    else if(h4Closes[i]<h4Trail && h4Closes[i-1]<h4Trail)  h4Trail=Math.min(h4Trail,h4Closes[i]+nLoss);
    else if(h4Closes[i]>h4Trail)                            h4Trail=h4Closes[i]-nLoss;
    else                                                    h4Trail=h4Closes[i]+nLoss;
    const prevDir = h4Dir;
    h4Dir = h4Trail>prevTrail?1:h4Trail<prevTrail?-1:h4Dir;
    h4History.push({ dir:h4Dir, prevDir, close:h4Closes[i], trail:h4Trail, date:h4Dates[i], idx:i });
  }

  // ── Step 3: Find 4H flips that happen while weekly is bullish ────────────
  const signals = [];
  for(let i=1; i<h4History.length; i++){
    const h4 = h4History[i];
    const h4prev = h4History[i-1];

    // 4H flip: bearish → bullish
    if(h4.dir !== 1 || h4prev.dir !== -1) continue;

    // Find what the weekly was doing at this date
    const h4Date  = new Date(h4.date).getTime();
    let weeklyDir = 0;
    for(let w=wkHistory.length-1; w>=0; w--){
      if(new Date(wkHistory[w].date).getTime() <= h4Date){
        weeklyDir = wkHistory[w].dir;
        break;
      }
    }

    // Only count if weekly is already bullish
    if(weeklyDir !== 1) continue;

    signals.push({
      date:       h4.date,
      flipIdx:    h4.idx,
      flipPrice:  h4.close,
      trailVal:   h4.trail,
      weeklyBull: true
    });
  }

  return signals;
}

// Measure 4H-based returns (hold N weeks = N*10 4H bars approximately)
function measure4HReturns(signals, h4Closes, h4Dates, holdWeeks){
  const holdBars = holdWeeks * 10; // ~10 4H bars per week
  return signals.map(sig=>{
    const entryIdx = sig.flipIdx;
    const exitIdx  = Math.min(entryIdx + holdBars, h4Closes.length - 1);
    const exitPrice= h4Closes[exitIdx];
    const exitDate = h4Dates[exitIdx];
    const ret      = ((exitPrice - sig.flipPrice) / sig.flipPrice) * 100;
    const isActive = exitIdx === h4Closes.length - 1;

    // Max gain/loss during hold
    let maxGain=0, maxLoss=0;
    for(let i=entryIdx+1; i<=exitIdx; i++){
      const pct = ((h4Closes[i]-sig.flipPrice)/sig.flipPrice)*100;
      if(pct>maxGain) maxGain=pct;
      if(pct<maxLoss) maxLoss=pct;
    }

    return {
      ...sig,
      exitPrice,
      exitDate,
      returnPct: ret,
      maxGain,
      maxLoss,
      isActive,
      isWin: ret > 0,
      signalType: "4h_weekly"
    };
  });
}

// ══════════════════════════════════════════════════════════
// WEEKLY MONITOR
// Finds stocks where weekly ATR trail just flipped bullish
// + checks if daily JAX also active (both aligned = highest conviction)
// Backtest validated: 77% win rate over 5 years
// ══════════════════════════════════════════════════════════

let wmResults  = [];
let wmRunning  = false;
let wmStopReq  = false;
let wmFilter   = "recent";  // default: flip age 0-1 weeks (isRecent)

function logWM(msg, type=""){
  const p = document.getElementById("wm-log");
  if(!p) return;
  const d = document.createElement("div");
  d.className = "ll "+(type==="ok"?"ok":type==="info"?"info":type==="err"?"err":"");
  d.textContent = "["+new Date().toLocaleTimeString()+"] "+msg;
  p.appendChild(d);
  if(p.children.length>500) p.removeChild(p.firstChild);
  p.scrollTop = p.scrollHeight;
}

function setWMFilter(v, btn){
  wmFilter = v;
  document.querySelectorAll("#wm-filterBar .chip").forEach(b=>b.classList.remove("on"));
  btn.classList.add("on");
  renderWeeklyMonitor();
}

async function startWeeklyMonitor(){
  if(wmRunning) return;
  wmRunning = true; wmStopReq = false; wmResults = [];

  const listVal  = document.getElementById("wmList").value;
  const flipAge  = parseInt(document.getElementById("wmFlipAge").value)||2;

  let tickers;
  if(listVal==="sp500")        tickers = [...SP500];
  else if(listVal==="both")    tickers = [...new Set([...SP500,...SMALLCAP])];
  else if(listVal==="custom")  tickers = document.getElementById("wmCustomTk").value.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
  else                         tickers = [...WATCHLIST];

  document.getElementById("wmRunBtn").disabled  = true;
  document.getElementById("wmStopBtn").disabled = false;
  document.getElementById("wm-prog").style.display = "block";
  document.getElementById("wm-savedBanner").style.display = "none";
  document.getElementById("wm-filterBar").style.display = "none";
  document.getElementById("wm-results").innerHTML = "";
  document.getElementById("wm-log").innerHTML = "";
  // Clear stale data at scan start so old results never mix with new
  try{ localStorage.removeItem("cs_weekly"); }catch(e){}
  document.getElementById("wm-sub").textContent =
    tickers.length+" STOCKS · WEEKLY FLIP WITHIN "+flipAge+" WEEKS · BACKTEST: 77% WIN RATE";

  // Reset stats
  ["wm-scanned","wm-both","wm-fresh","wm-watching"].forEach(id=>{
    const el = document.getElementById(id); if(el) el.textContent = "0";
  });

  logWM("📅 Weekly monitor: "+tickers.length+" stocks · flip age ≤"+flipAge+" weeks","info");
  logWM("Looking for: weekly trail flip bullish + optional daily JAX alignment","info");

  const nKeys  = TD_KEYS.length;
  const chunks = splitInterleaved(tickers, nKeys);
  const total  = tickers.length;
  let done     = 0;

  const progInterval = setInterval(()=>{
    const pct = Math.round(done/total*100);
    document.getElementById("wm-progPct").textContent = pct+"%";
    document.getElementById("wm-progFill").style.width = pct+"%";
  }, 500);

  async function runWMWorker(keyIdx, tickerChunk){
    const DELAY = 300; // Grow plan — 377 credits/min, no throttle needed
    for(let i=0; i<tickerChunk.length; i++){
      if(wmStopReq) break;
      const sym = tickerChunk[i];
      document.getElementById("wm-progMsg").textContent =
        "K"+(keyIdx+1)+": "+sym+" · "+done+"/"+total+" · "+wmResults.length+" signals";

      try{
        // ── Step 1: Weekly candles ────────────────────────────────────────
        const wk = await fetchWeeklyCandles(sym, keyIdx);
        if(!wk || wk.closes.length < 20){ done++; await sleep(DELAY); continue; }

        // ── Step 2: Find most recent weekly trail flip ─────────────────────
        const { flips, history } = findWeeklyTrailFlips(wk.closes, wk.highs, wk.lows, wk.dates);
        if(!flips.length){ done++; await sleep(DELAY); continue; }

        // Most recent flip
        const lastFlip = flips[flips.length-1];
        const weeksAgo = wk.closes.length - 1 - lastFlip.flipIdx;

        // Only care about recent flips
        if(weeksAgo > flipAge){ done++; await sleep(DELAY); continue; }

        // ── Step 3: Is weekly still bullish? (trail still pointing up) ─────
        const lastHistory = history[history.length-1];
        const weeklyStillBullish = lastHistory && lastHistory.dir === 1;
        if(!weeklyStillBullish){ done++; await sleep(DELAY); continue; }

        // ── Step 3b: Weekly JAX check ─────────────────────────────────────
        // Weekly green arrow = institutional momentum confirmation
        // IONQ, CDNS, QUBT all fired weekly JAX on April 13th before the big move
        let weeklyJAX = false, weeklyJAXRecent = false, weeklyBullScore = 0;
        try{
          if(wk.closes.length >= 20){
            const wkJax = calcJAXPRO(wk.closes, wk.highs, wk.lows);
            if(wkJax){
              weeklyJAX       = wkJax.greenArrow;
              weeklyBullScore = wkJax.bullScore;
              // Check if green arrow fired within last 3 weekly bars
              const recentBars = 3;
              let recentFired  = false;
              for(let rb = 0; rb < recentBars && rb < wk.closes.length; rb++){
                const sliced = calcJAXPRO(
                  wk.closes.slice(0, wk.closes.length - rb),
                  wk.highs.slice(0, wk.closes.length - rb),
                  wk.lows.slice(0, wk.closes.length - rb)
                );
                if(sliced && sliced.greenArrow){ recentFired = true; break; }
              }
              weeklyJAXRecent = recentFired;
            }
          }
        }catch(e){}

        // ── Step 4: 4H check — is 4H trail currently bullish? ────────────────
        // Backtest validated: weekly bull + 4H flip = 96% win rate (24/25 signals)
        let h4Bullish = false, h4Trail = 0, h4FlipRecent = false;
        try{
          const h4 = await fetch4HCandles(sym, keyIdx);
          if(h4 && h4.closes.length >= 20){
            // Check current 4H trail direction
            const h4TS = calcATRTrailStop(h4.highs, h4.lows, h4.closes, 10, 3.5);
            h4Bullish = h4TS.dir === 1;
            h4Trail   = h4TS.trailVal;
            // Check if 4H flipped recently (last 5 bars = ~1 trading day)
            h4FlipRecent = h4TS.utBuy; // direction just flipped up
          }
        }catch(e){}

        // ── Step 5: Daily JAX + 200 EMA check ────────────────────────────
        let dailyJAX = false, dailyBullScore = 0, dailyTrail = 0;
        let rsiVal = 0, pctHiVal = 0;
        let daily200EMA = 0, dailyAbove200 = false, daily200Reclaim = false;
        try{
          const dy = await fetchCandlesWithKey(sym, keyIdx);
          if(dy && dy.closes.length >= 70){
            const jax = calcJAXPRO(dy.closes, dy.highs, dy.lows);
            if(jax){
              dailyBullScore = jax.bullScore;
              dailyTrail     = jax.trailVal;

              // ── JAX lookback: check last 3 daily bars for green arrow ────
              // Fixes stale signal issue — arrow on prior bar still counts
              let dailyJAXRecent = false;
              for(let rb = 0; rb < 3 && rb < dy.closes.length; rb++){
                const sliced = calcJAXPRO(
                  dy.closes.slice(0, dy.closes.length - rb),
                  dy.highs.slice(0,  dy.closes.length - rb),
                  dy.lows.slice(0,   dy.closes.length - rb)
                );
                if(sliced && sliced.greenArrow){ dailyJAXRecent = true; break; }
              }
              dailyJAX = jax.greenArrow || dailyJAXRecent;
            }
            rsiVal   = calcRSI(dy.closes, 14);
            const high52 = Math.max(...dy.highs);
            pctHiVal = ((dy.closes[dy.closes.length-1]-high52)/high52)*100;

            // 200 EMA on daily
            if(dy.closes.length >= 202){
              daily200EMA   = calcEMA(dy.closes, 200);
              const cur     = dy.closes[dy.closes.length-1];
              dailyAbove200 = cur > daily200EMA;
              // Fresh reclaim = price crossed above 200 EMA within last 10 bars
              const lookback = dy.closes.slice(-12);
              let crossedAbove = false;
              for(let li = 1; li < lookback.length; li++){
                const emaHere = calcEMA(dy.closes.slice(0, dy.closes.length - lookback.length + li), 200);
                const emaPrev = calcEMA(dy.closes.slice(0, dy.closes.length - lookback.length + li - 1), 200);
                if(lookback[li] > emaHere && lookback[li-1] < emaPrev){ crossedAbove = true; break; }
              }
              daily200Reclaim = dailyAbove200 && crossedAbove;
            }
          }
        }catch(e){}

        // ── Step 5b: 4H 200 EMA check (reuse h4 from Step 4 — no extra API call) ──
        let h4_200EMA = 0, h4Above200 = false;
        if(h4Trail > 0){
          try{
            if(h4 && h4.closes.length >= 202){
              h4_200EMA  = calcEMA(h4.closes, 200);
              h4Above200 = h4.closes[h4.closes.length-1] > h4_200EMA;
            }
          }catch(e){}
        }

        // ── Step 6: Live quote ────────────────────────────────────────────
        let price = wk.closes[wk.closes.length-1], change = 0;
        try{
          const q = await fetchLiveQuote(sym);
          if(q && q.price){ price = q.price; change = q.changePct||0; }
        }catch(e){}

        // ── Step 7: A+ Quality Filters ────────────────────────────────────
        // Derived from NVTS/CRDO (good entries) vs BE/SMTC (extended) chart analysis
        // FILTER 1: Price vs 4H trail <= 20% above — filters extended breakouts
        const pctAbove4H = h4Trail > 0 ? ((price - h4Trail) / h4Trail) * 100 : 0;
        const f_notExtended = h4Trail === 0 || pctAbove4H <= 20;
        // FILTER 2: Weekly RSI <= 70 — room to run, not overbought (raised from 65 — CRDO at 68 is valid)
        const weeklyRsi = calcRSI(wk.closes, 14);
        const f_weeklyRsiOk = weeklyRsi === 0 || weeklyRsi <= 70;
        // FILTER 3: Daily RSI <= 70 — not exhausted on daily
        const f_dailyRsiOk = rsiVal === 0 || rsiVal <= 70;
        // FILTER 4: Flip age <= 3 weeks — fresh signal only
        const f_freshFlip = weeksAgo <= 3;
        // All filters must pass for A+ quality
        const isAPlus = f_notExtended && f_weeklyRsiOk && f_dailyRsiOk && f_freshFlip;

        if(!isAPlus){
          const reasons = [];
          if(!f_notExtended) reasons.push("extended "+pctAbove4H.toFixed(0)+"% above 4H trail");
          if(!f_weeklyRsiOk) reasons.push("weekly RSI "+weeklyRsi.toFixed(0)+" > 65");
          if(!f_dailyRsiOk)  reasons.push("daily RSI "+rsiVal.toFixed(0)+" > 70");
          if(!f_freshFlip)   reasons.push("flip "+weeksAgo+" wks ago > 3");
          logWM("⚠️ FILTERED "+sym+" — "+reasons.join(" | "),"");
          done++; if(i<tickerChunk.length-1) await sleep(DELAY); continue;
        }

        // Priority tiers:
        // A++: Weekly bull + weekly JAX + 4H flip + 200 EMA reclaim = HIGHEST CONVICTION
        // TIER 1: Weekly bull + 4H just flipped = 96% win rate
        // TIER 2: Weekly bull + 4H established bullish
        // TIER 3: Weekly bull + weekly JAX recent OR daily JAX OR 200 EMA reclaim
        const tierApp = weeklyStillBullish && h4Bullish && h4FlipRecent && (daily200Reclaim || weeklyJAXRecent);
        const tier1   = weeklyStillBullish && h4Bullish && h4FlipRecent && !tierApp;
        const tier2   = weeklyStillBullish && h4Bullish && !h4FlipRecent;
        const tier3   = weeklyStillBullish && (dailyJAX || daily200Reclaim || weeklyJAXRecent) && !h4Bullish;
        const bothAligned = tierApp || tier1 || tier2 || tier3;
        const isFresh  = weeksAgo === 0;
        const isRecent = weeksAgo <= 1;

        const result = {
          sym, price, change,
          // Weekly signal
          weeklyFlipDate:  lastFlip.date,
          weeklyFlipPrice: lastFlip.flipPrice,
          weeksAgo,
          weeklyBullish:   weeklyStillBullish,
          weeklyTrail:     lastFlip.trailVal,
          totalFlips:      flips.length,
          // Weekly JAX
          weeklyJAX,
          weeklyJAXRecent,
          weeklyBullScore,
          // 4H signal
          h4Bullish,
          h4Trail,
          h4FlipRecent,
          // Daily signal
          dailyJAX,
          dailyBullScore,
          dailyTrail,
          // 200 EMA signals
          daily200EMA,
          dailyAbove200,
          daily200Reclaim,
          h4_200EMA,
          h4Above200,
          // Tiers
          tierApp, tier1, tier2, tier3,
          bothAligned,
          isFresh, isRecent,
          // Indicators
          rsi:        rsiVal,
          weeklyRsi,
          pctAbove4H,
          pctHi:      pctHiVal,
        };

        // Deduplicate — skip if already found by another worker
        if(wmResults.find(r=>r.sym===sym)){ done++; if(i<tickerChunk.length-1) await sleep(DELAY); continue; }
        // Deduplicate — keep highest tier if same sym scanned by multiple workers
        const existingIdx = wmResults.findIndex(r=>r.sym===sym);
        if(existingIdx>=0){
          const ex = wmResults[existingIdx];
          const newScore = (result.tierApp?4:result.tier1?3:result.tier2?2:result.tier3?1:0);
          const exScore  = (ex.tierApp?4:ex.tier1?3:ex.tier2?2:ex.tier3?1:0);
          if(newScore > exScore) wmResults[existingIdx] = result; // replace with better
        } else {
          wmResults.push(result);
        }

        // Update stats
        const t1Count    = wmResults.filter(r=>r.tier1).length;
        const t2Count    = wmResults.filter(r=>r.tier2&&!r.tier1).length;
        const t3Count    = wmResults.filter(r=>r.tier3&&!r.tier1&&!r.tier2).length;
        const freshCount = wmResults.filter(r=>r.isFresh).length;
        document.getElementById("wm-scanned").textContent  = done+1;
        document.getElementById("wm-t1").textContent       = t1Count;
        document.getElementById("wm-t2").textContent       = t2Count;
        document.getElementById("wm-both").textContent     = t3Count;
        document.getElementById("wm-fresh").textContent    = freshCount;
        document.getElementById("wm-watching").textContent = wmResults.length;

        renderWeeklyMonitor();
        document.getElementById("wm-filterBar").style.display = "flex";

        const label = tierApp?"⭐⭐ A++ ENTER NOW":tier1?"⭐ ENTER NOW":tier2?"🟢 4H BULLISH":tier3?"🟣 JAX/EMA":isFresh?"🔔 FRESH FLIP":"📅 WEEKLY";
        const ageStr = weeksAgo===0?"THIS WEEK":weeksAgo===1?"1 wk ago":weeksAgo+" wks ago";
        logWM(label+" "+sym+" $"+price.toFixed(2)+" · flip "+ageStr+" at $"+lastFlip.flipPrice.toFixed(2)
          +(h4Bullish?" | ⭐ 4H BULL"+(h4FlipRecent?" JUST FLIPPED":""):"")
          +(weeklyJAXRecent?" | 📅 WK JAX 🔥":"")+(dailyJAX?" | 🟢 D-JAX "+dailyBullScore+"/5":"")
          +(daily200Reclaim?" | 📡 200EMA RECLAIM":"")+(dailyAbove200&&!daily200Reclaim?" | 📡 above 200EMA":"")
          +(rsiVal>0?" | RSI "+rsiVal.toFixed(0):""), tier1||tier2?"ok":tier3?"info":"");

        // Notification for both aligned
        if(tier1){
          sendNotification(
            "⭐ "+sym+" ENTER NOW — 4H FLIPPED IN WEEKLY BULL",
            "$"+price.toFixed(2)+" · Weekly flip "+ageStr+" · 4H just flipped bullish · 96% win rate signal",
            sym
          );
        } else if(tier2){
          sendNotification(
            "🟢 "+sym+" 4H BULLISH IN WEEKLY BULL",
            "$"+price.toFixed(2)+" · Weekly flip "+ageStr+" · 4H trail bullish · Watch for 4H re-flip entry",
            sym
          );
        } else if(tier3){
          sendNotification(
            "🟣 "+sym+" WEEKLY + JAX ALIGNED",
            "$"+price.toFixed(2)+" · Weekly flip "+ageStr+" · Daily JAX bull "+dailyBullScore+"/5",
            sym
          );
        }

      }catch(e){
        if(!e.message.startsWith("SKIP:"))
          logWM("✗ "+sym+": "+e.message,"err");
      }

      done++;
      if(i<tickerChunk.length-1) await sleep(DELAY);
    }
  }

  await Promise.all(chunks.map((chunk,ki)=>runWMWorker(ki,chunk)));

  clearInterval(progInterval);
  const t1Count = wmResults.filter(r=>r.tier1).length;
  const t2Count = wmResults.filter(r=>r.tier2&&!r.tier1).length;
  document.getElementById("wm-progMsg").textContent =
    "Done — "+wmResults.length+" signals · "+t1Count+" ENTER NOW · "+t2Count+" 4H Bull";
  document.getElementById("wm-t1").textContent = t1Count;
  document.getElementById("wm-t2").textContent = t2Count;
  document.getElementById("wm-progPct").textContent = "100%";
  document.getElementById("wm-progFill").style.width = "100%";
  document.getElementById("wmRunBtn").disabled  = false;
  document.getElementById("wmStopBtn").disabled = true;
  wmRunning = false;

  if(wmResults.length){
    const banner = document.getElementById("wm-savedBanner");
    banner.style.display = "block";
    banner.textContent = "📅 "+wmResults.length+" signals · "+t1Count+" ⭐ Enter Now · "+t2Count+" 🟢 4H Bull · "+new Date().toLocaleString();
    document.getElementById("wm-lastscan").textContent = "Last scan: "+new Date().toLocaleTimeString();
    // Save
    fbSafeSave("weekly_monitor", wmResults);
    try{ localStorage.setItem("cs_weekly", JSON.stringify(wmResults)); }catch(e){}
  }
  renderWeeklyMonitor();
  logWM("✅ Complete · "+wmResults.length+" signals · "+t1Count+" ⭐ ENTER NOW · "+t2Count+" 🟢 4H Bull","ok");
}

// ══════════════════════════════════════════════════════════
// DAILY TRIGGER — checks weekly watchlist for fresh green arrows
// Runs calcJAXPRO on daily candles matching your exact Pine Script
// Fires alert when green arrow fired within last 2 daily bars
// ══════════════════════════════════════════════════════════
async function runDailyTrigger(){
  const btn = document.getElementById("dtRunBtn");
  if(!wmResults.length){
    alert("Run the weekly scan first — need a watchlist to check.");
    return;
  }

  btn.disabled = true;
  const panel    = document.getElementById("dt-panel");
  const results  = document.getElementById("dt-results");
  const prog     = document.getElementById("dt-prog");
  const progMsg  = document.getElementById("dt-progMsg");
  const progPct  = document.getElementById("dt-progPct");
  const progFill = document.getElementById("dt-progFill");
  const timeEl   = document.getElementById("dt-time");

  panel.style.display   = "block";
  prog.style.display    = "block";
  results.innerHTML     = "";
  timeEl.textContent    = "";

  const tickers  = wmResults.map(r=>r.sym);
  const total    = tickers.length;
  let done       = 0;
  const fired    = []; // stocks where green arrow fired today
  const DELAY    = 300; // Grow plan — 377 credits/min
  const nKeys    = TD_KEYS.length;
  const chunks   = splitInterleaved(tickers, nKeys);

  const progInterval = setInterval(()=>{
    const pct = Math.round(done/total*100);
    progPct.textContent    = pct+"%";
    progFill.style.width   = pct+"%";
  }, 400);

  async function dtWorker(keyIdx, chunk){
    for(let i=0; i<chunk.length; i++){
      const sym = chunk[i];
      progMsg.textContent = "Checking "+sym+" ("+done+"/"+total+")...";
      try{
        const dy = await fetchCandlesWithKey(sym, keyIdx);
        if(dy && dy.closes.length >= 70){
          // Check if green arrow fired on current bar OR previous bar
          const jaxNow  = calcJAXPRO(dy.closes, dy.highs, dy.lows);
          const jaxPrev = calcJAXPRO(
            dy.closes.slice(0,-1),
            dy.highs.slice(0,-1),
            dy.lows.slice(0,-1)
          );

          const firedToday     = jaxNow  && jaxNow.greenArrow;
          const firedYesterday = jaxPrev && jaxPrev.greenArrow;

          if(firedToday || firedYesterday){
            const wm    = wmResults.find(r=>r.sym===sym)||{};
            const price = dy.closes[dy.closes.length-1];
            fired.push({
              sym,
              price,
              firedToday,
              firedYesterday,
              bullScore:  jaxNow?.bullScore||0,
              rsi:        jaxNow?.rsi14||0,
              tier:       wm.tierApp?"A++":wm.tier1?"TIER1":wm.tier2?"TIER2":wm.tier3?"TIER3":"WEEKLY",
              h4Bullish:  wm.h4Bullish||false,
              weeklyRsi:  wm.weeklyRsi||0,
              weeksAgo:   wm.weeksAgo||0,
              daily200Reclaim: wm.daily200Reclaim||false,
              weeklyJAXRecent: wm.weeklyJAXRecent||false,
            });
            renderDailyTriggers(fired);
          }
        }
      }catch(e){}

      done++;
      if(i < chunk.length-1) await sleep(DELAY);
    }
  }

  await Promise.all(chunks.map((chunk,ki)=>dtWorker(ki,chunk)));
  clearInterval(progInterval);

  progPct.textContent  = "100%";
  progFill.style.width = "100%";
  progMsg.textContent  = fired.length
    ? "✅ Done — "+fired.length+" green arrows fired"
    : "✅ Done — no green arrows fired today";
  timeEl.textContent = "Last checked: "+new Date().toLocaleTimeString();

  // Save to Firebase for phone access
  if(fired.length) fbSafeSave("daily_triggers", {data:fired, time:new Date().toISOString()});

  btn.disabled = false;
  prog.style.display = "none";
}

function renderDailyTriggers(fired){
  const results = document.getElementById("dt-results");
  if(!fired.length){
    results.innerHTML = '<div class="conf-empty"><span class="conf-empty-icon">🔍</span>No green arrows fired yet.</div>';
    return;
  }

  // Sort — today's fires first, then by bull score
  const sorted = [...fired].sort((a,b)=>{
    if(a.firedToday && !b.firedToday) return -1;
    if(!a.firedToday && b.firedToday) return 1;
    return b.bullScore - a.bullScore;
  });

  results.innerHTML = sorted.map(s=>{
    const urgency  = s.firedToday ? "🔥 FIRED TODAY" : "⚡ FIRED YESTERDAY";
    const urgClr   = s.firedToday ? "var(--green2)" : "var(--yellow)";
    const tierClr  = s.tier==="A++"?"#fff":s.tier==="TIER1"?"var(--green2)":s.tier==="TIER2"?"var(--green)":"var(--muted2)";
    const badges   = [
      s.weeklyJAXRecent ? "📅 WK JAX 🔥" : "",
      s.daily200Reclaim ? "📡 200EMA" : "",
      s.h4Bullish       ? "⭐ 4H BULL" : "",
    ].filter(Boolean).join(" · ");

    return `<div style="background:#0a1f0a;border:1px solid #1a4a1a;border-left:3px solid ${urgClr};border-radius:4px;padding:10px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-size:15px;font-weight:700;color:#fff;font-family:var(--mono);cursor:pointer" onclick="window.open('https://www.tradingview.com/chart/?symbol='+encodeURIComponent('${s.sym}'),'_blank')">${s.sym}</span>
        <span style="font-size:10px;font-weight:700;color:${urgClr};letter-spacing:1px">${urgency}</span>
        <span style="font-size:9px;color:${tierClr};font-family:var(--mono)">${s.tier}</span>
        <button onclick="event.stopPropagation();logToJournal({sym:'${s.sym}',price:${s.price},score:'W',source:'auto-scan',session:getMarketSession(),greenArrow:true,tradeType:'Swing'})"
          style="margin-left:auto;background:#0d2b0d;border:1px solid var(--green2);color:var(--green2);font-family:var(--mono);font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px;letter-spacing:1px">
          📓 LOG
        </button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:6px">
        <div style="background:#0d1f0d;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2)">PRICE</div>
          <div style="font-size:13px;font-weight:700;color:var(--green2)">$${s.price.toFixed(2)}</div>
        </div>
        <div style="background:#0d1f0d;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2)">BULL SCORE</div>
          <div style="font-size:13px;font-weight:700;color:#fff">${s.bullScore}/5</div>
        </div>
        <div style="background:#0d1f0d;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2)">D-RSI</div>
          <div style="font-size:13px;font-weight:700;color:${s.rsi<60?"var(--green2)":s.rsi<70?"var(--yellow)":"var(--red)"}">${s.rsi.toFixed(0)}</div>
        </div>
        <div style="background:#0d1f0d;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2)">WK FLIP</div>
          <div style="font-size:13px;font-weight:700;color:var(--muted2)">${s.weeksAgo===0?"THIS WK":s.weeksAgo!==undefined?s.weeksAgo+"wk ago":"—"}</div>
        </div>
      </div>
      ${badges?`<div style="font-size:9px;color:var(--muted2);font-family:var(--mono)">${badges}</div>`:""}
    </div>`;
  }).join("");
}

function stopWeeklyMonitor(){ wmStopReq = true; }

function clearWeeklyMonitor(){
  wmResults = [];
  document.getElementById("wm-savedBanner").style.display = "none";
  document.getElementById("wm-filterBar").style.display = "none";
  document.getElementById("wm-results").innerHTML = '<div class="conf-empty"><span class="conf-empty-icon">📅</span>Cleared.</div>';
  ["wm-scanned","wm-both","wm-fresh","wm-watching"].forEach(id=>{
    const el = document.getElementById(id); if(el) el.textContent = "0";
  });
  try{ localStorage.removeItem("cs_weekly"); }catch(e){}
}

function renderWeeklyMonitor(){
  const sort   = document.getElementById("wm-sortSel")?.value||"priority";
  const search = (document.getElementById("wm-search")?.value||"").toUpperCase().trim();

  let f = [...wmResults];
  if(wmFilter==="t1")     f = f.filter(r=>r.tier1);
  else if(wmFilter==="t2")     f = f.filter(r=>r.tier2&&!r.tier1);
  else if(wmFilter==="t3")     f = f.filter(r=>r.tier3&&!r.tier1&&!r.tier2);
  else if(wmFilter==="recent") f = f.filter(r=>r.isRecent);
  else if(wmFilter==="fresh")  f = f.filter(r=>r.isFresh);
  else if(wmFilter==="weekly") f = f.filter(r=>!r.tier1&&!r.tier2&&!r.tier3);
  if(search) f = f.filter(r=>r.sym.includes(search));

  f.sort((a,b)=>{
    if(sort==="fresh")    return a.weeksAgo-b.weeksAgo;
    if(sort==="rsi")      return a.rsi-b.rsi;
    // Priority: both aligned first, then fresh flips, then weekly only
    const aScore = (a.tier1?3000:a.tier2?2000:a.tier3?1000:0)+(a.isFresh?100:0)+(10-Math.min(a.weeksAgo,10));
    const bScore = (b.tier1?3000:b.tier2?2000:b.tier3?1000:0)+(b.isFresh?100:0)+(10-Math.min(b.weeksAgo,10));
    return bScore-aScore;
  });

  document.getElementById("wm-resCount").textContent = f.length+" shown";
  const grid = document.getElementById("wm-results");

  if(!f.length){
    grid.innerHTML = wmResults.length
      ? '<div class="conf-empty"><span class="conf-empty-icon">🔍</span>No results match filter.</div>'
      : '<div class="conf-empty"><span class="conf-empty-icon">📅</span>Run the weekly scan to find signals.</div>';
    return;
  }

  grid.innerHTML = f.map((s,i)=>{
    const cardCls = s.tierApp?"wm-card wm-fresh":s.tier1?"wm-card wm-fresh":s.tier2?"wm-card wm-fresh":s.tier3?"wm-card wm-recent":s.isFresh?"wm-card wm-recent":"wm-card wm-old";
    const ageStr  = s.weeksAgo===0?"THIS WEEK":s.weeksAgo===1?"1 WEEK AGO":s.weeksAgo+" WEEKS AGO";
    const ageClr  = s.weeksAgo===0?"var(--green2)":s.weeksAgo===1?"var(--blue)":"var(--yellow)";
    const badgeLabel = s.tierApp?"⭐⭐ A++ ENTER NOW":s.tier1?"⭐ ENTER NOW":s.tier2?"🟢 4H BULLISH":s.tier3?"🟣 JAX/EMA ALIGNED":s.isFresh?"🔔 FRESH FLIP":"📅 WEEKLY";
    const badgeCls   = s.tierApp?"fresh":s.tier1?"fresh":s.tier2?"fresh":s.tier3?"recent":s.isFresh?"recent":"old";

    // Signal pills — tier system
    const wkPill  = `<div class="wm-sig wk-on active">📅 WEEKLY<br><span style="font-size:9px">TRAIL BULL</span></div>`;
    const h4Pill  = s.h4Bullish
      ? `<div class="wm-sig dy-on active" style="background:rgba(0,230,118,0.08);color:var(--green)">⭐ 4H BULL${s.h4FlipRecent?" 🔥":""}<br><span style="font-size:9px">${s.h4FlipRecent?"JUST FLIPPED":"ESTABLISHED"}</span></div>`
      : `<div class="wm-sig off">⭐ 4H<br><span style="font-size:9px">WAITING</span></div>`;
    const dyPill  = s.dailyJAX
      ? `<div class="wm-sig dy-on active">🟢 DAILY JAX<br><span style="font-size:9px">BULL ${s.dailyBullScore}/5</span></div>`
      : `<div class="wm-sig off">🟢 DAILY JAX<br><span style="font-size:9px">${s.dailyBullScore>0?s.dailyBullScore+"/5":"—"}</span></div>`;
    const wkJaxPill = s.weeklyJAX
      ? `<div class="wm-sig dy-on active" style="background:rgba(255,215,0,0.08);color:var(--yellow)">📅 WK JAX${s.weeklyJAXRecent?" 🔥":""}<br><span style="font-size:9px">${s.weeklyJAXRecent?"RECENT":"ACTIVE"} ${s.weeklyBullScore}/5</span></div>`
      : `<div class="wm-sig off">📅 WK JAX<br><span style="font-size:9px">—</span></div>`;
    const emaPill = s.dailyAbove200
      ? `<div class="wm-sig dy-on active" style="background:rgba(100,181,246,0.08);color:#64B5F6">📡 200 EMA${s.daily200Reclaim?" 🔥":""}<br><span style="font-size:9px">${s.daily200Reclaim?"FRESH RECLAIM":"ABOVE"}</span></div>`
      : `<div class="wm-sig off">📡 200 EMA<br><span style="font-size:9px">BELOW</span></div>`;

    // Detail tags
    const tags = [];
    tags.push(`<span class="wm-tag" style="color:${ageClr};border-color:${ageClr}40">${ageStr}</span>`);
    tags.push(`<span class="wm-tag blue">Wk flip $${s.weeklyFlipPrice.toFixed(2)}</span>`);
    if(s.h4Bullish) tags.push(`<span class="wm-tag green">⭐ 4H trail bull${s.h4FlipRecent?" · just flipped":""}</span>`);
    if(s.h4Trail>0) tags.push(`<span class="wm-tag">4H trail $${s.h4Trail.toFixed(2)}</span>`);
    if(s.rsi>0) tags.push(`<span class="wm-tag ${s.rsi<=65?"green":s.rsi<=70?"":""}" style="${s.rsi>70?"color:var(--red)":""}">D-RSI ${s.rsi.toFixed(0)}</span>`);
    if(s.weeklyJAXRecent) tags.push(`<span class="wm-tag" style="color:var(--yellow)">📅 Weekly JAX fired 🔥 bull${s.weeklyBullScore}/5</span>`);
    else if(s.weeklyJAX) tags.push(`<span class="wm-tag" style="color:var(--yellow)">📅 Weekly JAX active bull${s.weeklyBullScore}/5</span>`);
    if(s.daily200EMA>0) tags.push(`<span class="wm-tag" style="color:${s.dailyAbove200?"#64B5F6":"var(--muted2)"}">D-200EMA $${s.daily200EMA.toFixed(2)}${s.daily200Reclaim?" 🔥 RECLAIM":s.dailyAbove200?" ✓":""}</span>`);
    if(s.h4_200EMA>0)   tags.push(`<span class="wm-tag" style="color:${s.h4Above200?"#64B5F6":"var(--muted2)"}">4H-200EMA ${s.h4Above200?"above":"below"}</span>`);
    if(s.weeklyRsi>0) tags.push(`<span class="wm-tag" style="${s.weeklyRsi>65?"color:var(--red)":"color:var(--green2)"}">W-RSI ${s.weeklyRsi.toFixed(0)}</span>`);
    if(s.pctAbove4H>0) tags.push(`<span class="wm-tag" style="${s.pctAbove4H>15?"color:var(--yellow)":"color:var(--green2)"}">+${s.pctAbove4H.toFixed(0)}% above 4H trail</span>`);
    if(s.pctHi<-20) tags.push(`<span class="wm-tag blue">📉 ${s.pctHi.toFixed(0)}% off hi</span>`);
    if(s.dailyJAX) tags.push(`<span class="wm-tag green">🟢 Daily arrow active</span>`);
    if(s.dailyTrail>0) tags.push(`<span class="wm-tag">Daily trail $${s.dailyTrail.toFixed(2)}</span>`);
    tags.push(`<span class="wm-tag">${s.totalFlips} wk flips</span>`);

    return `<div class="${cardCls}" onclick="window.open('https://www.tradingview.com/chart/?symbol='+encodeURIComponent('${s.sym}'),'_blank')">
      <div class="wm-band">
        <div>
          <div class="wm-sym" style="display:flex;align-items:center;gap:6px">${tickerLogo(s.sym,20)}${s.sym}</div>
          <div style="margin-top:4px">
            <span class="wm-badge ${badgeCls}">${badgeLabel}</span>
          </div>
        </div>
        <div class="wm-price-block">
          <div class="wm-price">$${s.price.toFixed(2)}</div>
          <div class="wm-chg ${s.change>=0?"up":"dn"}">${s.change>=0?"▲":"▼"}${Math.abs(s.change).toFixed(2)}%</div>
          <div style="font-size:7px;color:var(--muted2);margin-top:2px;font-family:var(--mono)">#${i+1}</div>
        </div>
      </div>
      <div class="wm-signals">
        ${wkPill}${wkJaxPill}${h4Pill}${dyPill}${emaPill}
      </div>
      <div class="wm-details">
        <div class="wm-detail-row">${tags.join("")}</div>
      </div>
      <div class="wm-footer">
        <span style="font-family:var(--mono);font-size:8px;color:var(--muted2)">Flip: ${s.weeklyFlipDate}</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="log-btn" onclick="event.stopPropagation();logToJournal({sym:'${s.sym}',price:${s.price},score:'W',source:'weekly',session:getMarketSession(),greenArrow:${s.dailyJAX},tradeType:'Swing'})">📓 LOG</button>
          <span style="font-size:8px;color:var(--muted2);font-family:var(--mono)">📈 TradingView →</span>
        </div>
      </div>
    </div>`;
  }).join("");
}

// ── Load from localStorage / Firebase ─────────────────────
// ── Load and display GitHub Action cron alerts ───────────
async function loadCronAlerts(){
  try{
    const fb = await window.fbLoad("jax_cron_alerts");
    if(!fb || !fb.data) return;
    const alerts = fb.data;
    if(!alerts.data || !alerts.data.length) return;
    const fired   = alerts.data;
    const banner  = document.getElementById("cron-alert-banner");
    const count   = document.getElementById("cron-alert-count");
    const time    = document.getElementById("cron-alert-time");
    const tickers = document.getElementById("cron-alert-tickers");
    if(!banner) return;
    // Show results from last 72 hours (covers weekend + Monday morning)
    const checked  = new Date(alerts.time);
    const hoursAgo = (Date.now() - checked.getTime()) / (1000*60*60);
    if(hoursAgo > 72) return;
    banner.style.display = "block";
    count.textContent    = fired.length + " green arrow" + (fired.length>1?"s":"") + " fired";
    time.textContent     = "Auto-scan: " + checked.toLocaleDateString() + " " + (alerts.checkTime||checked.toLocaleTimeString());
    tickers.textContent  = fired.map(r=>`${r.sym} $${r.price?.toFixed(2)} bull${r.bullScore}/5`).join(" · ");
  }catch(e){ console.warn("loadCronAlerts error:", e); }
}

function showCronAlerts(){
  const panel = document.getElementById("dt-panel");
  if(panel) panel.style.display = "block";
  window.fbLoad("jax_cron_alerts").then(fb=>{
    if(!fb || !fb.data || !fb.data.data) return;
    const fired = fb.data.data.map(r=>({...r, firedToday:true}));
    renderDailyTriggers(fired);
  }).catch(()=>{});
}

function loadWeeklyMonitor(){
  try{
    const saved = localStorage.getItem("cs_weekly");
    if(saved){
      wmResults = JSON.parse(saved);
      if(wmResults.length){
        const banner = document.getElementById("wm-savedBanner");
        if(banner){ banner.style.display="block"; banner.textContent="💾 "+wmResults.length+" weekly signals · last scan"; }
        document.getElementById("wm-filterBar").style.display="flex";
        document.getElementById("wm-both").textContent     = wmResults.filter(r=>r.bothAligned).length;
        const wkonly = document.getElementById("wm-wkonly"); if(wkonly) wkonly.textContent = wmResults.filter(r=>!r.bothAligned).length;
        document.getElementById("wm-fresh").textContent    = wmResults.filter(r=>r.isFresh).length;
        document.getElementById("wm-watching").textContent = wmResults.length;
        renderWeeklyMonitor();
      }
    }
  }catch(e){ wmResults=[]; }

  const _doWMFirebase = async()=>{
    try{
      const fb = await window.fbLoad("weekly_monitor");
      if(fb && fb.data && fb.data.length > 0){
        wmResults = fb.data;
        localStorage.setItem("cs_weekly", JSON.stringify(wmResults));
        const banner = document.getElementById("wm-savedBanner");
        if(banner){ banner.style.display="block"; banner.textContent="☁️ "+(fb.device||"cloud")+" · "+new Date(fb.savedAt).toLocaleString()+" — "+wmResults.length+" signals"; }
        document.getElementById("wm-filterBar").style.display="flex";
        document.getElementById("wm-both").textContent     = wmResults.filter(r=>r.bothAligned).length;
        document.getElementById("wm-fresh").textContent    = wmResults.filter(r=>r.isFresh).length;
        document.getElementById("wm-watching").textContent = wmResults.length;
        renderWeeklyMonitor();
      }
      window.fbListen("weekly_monitor", (fb)=>{
        if(fb.data && fb.data.length > 0){
          wmResults = fb.data;
          localStorage.setItem("cs_weekly", JSON.stringify(wmResults));
          renderWeeklyMonitor();
        }
      });
    }catch(e){}
  };
  if(window.firebaseReady){ _doWMFirebase(); }
  else { document.addEventListener("firebaseReady", _doWMFirebase, {once:true}); }
}


// ══════════════════════════════════════════════════════════
// TRADING AGENT
// AI-powered decision engine using Claude API
// Reads all scanner Firebase data + journal history
// Jobs: morning brief, entry confirm, exit monitor,
//       weekly review, pattern learning, position sizing

// Load cron alerts on startup — wait for Firebase to be ready
document.addEventListener("firebaseReady", ()=>{
  try{ loadCronAlerts(); }catch(e){}
  try{ loadWeeklyCronAlerts(); }catch(e){}
});

async function loadWeeklyCronAlerts(){
  if(!window.firebaseReady || typeof window.fbLoad !== "function"){
    document.addEventListener("firebaseReady", ()=>{ try{ loadWeeklyCronAlerts(); }catch(e){} }, {once:true});
    return;
  }
  try{
    const fb = await window.fbLoad("weekly_cron_alerts");
    if(!fb||!fb.data) return;
    const alerts = Array.isArray(fb.data)?fb.data:(typeof fb.data==="string"?JSON.parse(fb.data):fb.data);
    if(!alerts||!alerts.length) return;
    const savedAt  = new Date(fb.savedAt);
    const hoursAgo = (Date.now()-savedAt.getTime())/(1000*60*60);
    if(hoursAgo>168) return;
    const banner  = document.getElementById("weekly-cron-banner");
    const count   = document.getElementById("weekly-cron-count");
    const time    = document.getElementById("weekly-cron-time");
    const tickers = document.getElementById("weekly-cron-tickers");
    if(!banner) return;
    const appPlus  = alerts.filter(r=>r.tierApp);
    const jax      = alerts.filter(r=>r.tier1&&!r.tierApp);
    const oversold = alerts.filter(r=>r.tier2&&!r.tier1&&!r.tierApp);
    banner.style.display="block";
    count.textContent=alerts.length+" weekly signal"+(alerts.length>1?"s":"")+
      (appPlus.length?" · "+appPlus.length+" ⭐⭐A++":"")+
      (jax.length?" · "+jax.length+" ⭐JAX":"")+
      (oversold.length?" · "+oversold.length+" 📈oversold":"");
    time.textContent="Scanned: "+savedAt.toLocaleDateString()+" "+savedAt.toLocaleTimeString();
    tickers.textContent=alerts.slice(0,12).map(r=>{
      const tier=r.tierApp?"⭐⭐":r.tier1?"⭐":r.tier2?"📈":"📅";
      return tier+r.sym;
    }).join(" · ");
  }catch(e){ console.warn("loadWeeklyCronAlerts error:",e); }
}

function showWeeklyCronAlerts(){
  const panel=document.getElementById("weekly-cron-panel");
  if(!panel) return;
  if(panel.style.display==="block"){ panel.style.display="none"; return; }
  panel.style.display="block";
  const resultsEl=document.getElementById("weekly-cron-results");
  resultsEl.innerHTML='<div style="color:var(--muted2);font-family:var(--mono);font-size:11px;padding:10px">Loading...</div>';
  window.fbLoad("weekly_cron_alerts").then(fb=>{
    if(!fb||!fb.data){ resultsEl.innerHTML='<div style="color:var(--muted2);font-family:var(--mono);font-size:11px;padding:10px">No data.</div>'; return; }
    const alerts=Array.isArray(fb.data)?fb.data:(typeof fb.data==="string"?JSON.parse(fb.data):fb.data);
    const timeEl=document.getElementById("weekly-cron-panel-time");
    if(timeEl) timeEl.textContent=new Date(fb.savedAt).toLocaleString();
    resultsEl.innerHTML=renderWeeklyCronCards(alerts);
  }).catch(()=>{ resultsEl.innerHTML='<div style="color:var(--red);font-family:var(--mono);font-size:11px;padding:10px">Error.</div>'; });
}

function renderWeeklyCronCards(alerts){
  if(!alerts||!alerts.length) return '<div style="color:var(--muted2);font-family:var(--mono);font-size:11px;padding:10px">No signals.</div>';
  return alerts.map(s=>{
    const tierLabel=s.tierApp?"⭐⭐ A++ FRESH FLIP + JAX":s.tier1?"⭐ JAX RECENT":s.tier2?"📈 OVERSOLD RECOVERY":"📅 TRAIL FLIP";
    const tierClr=s.tierApp?"var(--green2)":s.tier1?"var(--blue)":s.tier2?"var(--yellow)":"var(--muted2)";
    const rsiClr=s.weeklyRsi<55?"var(--green2)":s.weeklyRsi<65?"var(--blue)":s.weeklyRsi<70?"var(--yellow)":"var(--red)";
    const flipStr=s.weeksAgo===0?"THIS WEEK":s.weeksAgo===1?"1 WK AGO":s.weeksAgo+" WKS AGO";
    const flipClr=s.weeksAgo===0?"var(--green2)":s.weeksAgo===1?"var(--blue)":"var(--yellow)";
    const badges=[s.weeklyJAXRecent?"🟢 WK JAX FIRED":"",s.cameFromOversold?"💹 FROM OVERSOLD":""].filter(Boolean).join(" · ");
    return `<div style="background:#0a1525;border:1px solid #1a3a4a;border-left:3px solid ${tierClr};border-radius:4px;padding:10px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-size:15px;font-weight:700;color:#fff;font-family:var(--mono);cursor:pointer"
          onclick="window.open('https://www.tradingview.com/chart/?symbol='+encodeURIComponent('${s.sym}'),'_blank')">${s.sym}</span>
        <span style="font-size:10px;font-weight:700;color:${tierClr};letter-spacing:1px">${tierLabel}</span>
        <button onclick="event.stopPropagation();logToJournal({sym:'${s.sym}',price:${s.price},score:'W',source:'weekly-scan',session:getMarketSession(),greenArrow:${s.weeklyJAXRecent},tradeType:'Swing'})"
          style="margin-left:auto;background:#0d1f2b;border:1px solid var(--blue);color:var(--blue);font-family:var(--mono);font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px">📓 LOG</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:6px">
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px"><div style="font-size:8px;color:var(--muted2)">PRICE</div><div style="font-size:13px;font-weight:700;color:var(--green2)">$${parseFloat(s.price).toFixed(2)}</div></div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px"><div style="font-size:8px;color:var(--muted2)">WK RSI</div><div style="font-size:13px;font-weight:700;color:${rsiClr}">${s.weeklyRsi}</div></div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px"><div style="font-size:8px;color:var(--muted2)">BULL</div><div style="font-size:13px;font-weight:700;color:#fff">${s.weeklyBullScore}/5</div></div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px"><div style="font-size:8px;color:var(--muted2)">FLIP</div><div style="font-size:13px;font-weight:700;color:${flipClr}">${flipStr}</div></div>
      </div>
      ${badges?`<div style="font-size:9px;color:var(--muted2);font-family:var(--mono)">${badges}</div>`:""}
    </div>`;
  }).join("");
}

function toggleAccordion(bodyId, arrowId){
  const body = document.getElementById(bodyId);
  const arrow = document.getElementById(arrowId);
  if(!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  if(arrow) arrow.classList.toggle('open', !isOpen);
}

// ── Tradier: fetch best option strike ─────────────────────────────────────────
// Rules: first expiry ≥ 30 DTE, best ATM strike (delta ~0.45) + 1-strike OTM (delta ~0.30)
async function fetchBestStrike(sym, price) {
  try {
    const hdrs = { "Authorization": `Bearer ${TR_KEY}`, "Accept": "application/json" };

    // Step 1: get expirations
    const expRes = await fetch(`${TR_BASE}/markets/options/expirations?symbol=${sym}&includeAllRoots=true&strikes=false`, { headers: hdrs });
    const expData = await expRes.json();
    const expirations = expData?.expirations?.date;
    if (!expirations || !expirations.length) return null;

    // Step 2: find first expiry >= 30 DTE
    const today = new Date();
    today.setHours(0,0,0,0);
    let targetExp = null;
    for (const exp of expirations) {
      const expDate = new Date(exp + "T00:00:00");
      const dte = Math.round((expDate - today) / (1000 * 60 * 60 * 24));
      if (dte >= 30) { targetExp = { date: exp, dte }; break; }
    }
    if (!targetExp) return null;

    // Step 3: get chain for that expiry with greeks
    const chainRes = await fetch(`${TR_BASE}/markets/options/chains?symbol=${sym}&expiration=${targetExp.date}&greeks=true`, { headers: hdrs });
    const chainData = await chainRes.json();
    const options = chainData?.options?.option;
    if (!options || !options.length) return null;

    // Step 4: filter calls only, find ATM (delta 0.40-0.55) and OTM (delta 0.25-0.40)
    const calls = options.filter(o => o.option_type === "call" && o.greeks?.delta > 0);

    // ATM: delta closest to 0.47
    const atm = calls.reduce((best, o) => {
      const d = Math.abs((o.greeks?.delta || 0) - 0.47);
      const bd = Math.abs((best?.greeks?.delta || 0) - 0.47);
      return d < bd ? o : best;
    }, calls[0]);

    // OTM: delta closest to 0.30
    const otm = calls.reduce((best, o) => {
      const d = Math.abs((o.greeks?.delta || 0) - 0.30);
      const bd = Math.abs((best?.greeks?.delta || 0) - 0.30);
      return d < bd ? o : best;
    }, calls[0]);

    return {
      expiry:  targetExp.date,
      dte:     targetExp.dte,
      atm: atm ? {
        strike:  atm.strike,
        ask:     atm.ask,
        bid:     atm.bid,
        delta:   atm.greeks?.delta?.toFixed(2),
        iv:      atm.greeks?.smv_vol ? (atm.greeks.smv_vol * 100).toFixed(0) + "%" : "—",
        theta:   atm.greeks?.theta?.toFixed(2),
        symbol:  atm.symbol,
        cost1:   atm.ask ? (atm.ask * 100).toFixed(0) : "—",
        oi:      atm.open_interest || 0
      } : null,
      otm: otm && otm.strike !== atm?.strike ? {
        strike:  otm.strike,
        ask:     otm.ask,
        bid:     otm.bid,
        delta:   otm.greeks?.delta?.toFixed(2),
        iv:      otm.greeks?.smv_vol ? (otm.greeks.smv_vol * 100).toFixed(0) + "%" : "—",
        theta:   otm.greeks?.theta?.toFixed(2),
        symbol:  otm.symbol,
        cost1:   otm.ask ? (otm.ask * 100).toFixed(0) : "—",
        oi:      otm.open_interest || 0
      } : null
    };
  } catch(e) {
    console.warn("Tradier fetch failed:", e.message);
    return null;
  }
}

// Cache so we don't re-fetch on every render
const wsStrikeCache = {};

async function loadStrikeForCard(sym, price, cardEl) {
  if (wsStrikeCache[sym]) {
    renderStrikeRow(sym, wsStrikeCache[sym], cardEl);
    return;
  }
  const strikeEl = cardEl.querySelector(`[data-strike="${sym}"]`);
  if (strikeEl) strikeEl.innerHTML = `<span style="color:var(--muted2);font-size:9px;font-family:var(--mono)">⏳ Loading options...</span>`;
  const result = await fetchBestStrike(sym, price);
  wsStrikeCache[sym] = result;
  renderStrikeRow(sym, result, cardEl);
}

function renderStrikeRow(sym, data, cardEl) {
  const el = cardEl?.querySelector(`[data-strike="${sym}"]`);
  if (!el) return;
  if (!data || (!data.atm && !data.otm)) {
    el.innerHTML = `<span style="color:var(--muted2);font-size:9px;font-family:var(--mono)">Options data unavailable</span>`;
    return;
  }

  const oiClr = oi => oi >= 1000 ? "var(--green2)" : oi >= 500 ? "#FFB300" : "var(--red)";
  const oiLbl = oi => oi >= 1000 ? "✅" : oi >= 500 ? "⚠️" : "🔴";

  // Low liquidity warning banner
  const atmOI = data.atm?.oi || 0;
  const liquidityWarning = atmOI < 500 ? `
    <div style="background:rgba(255,23,68,0.08);border:1px solid rgba(255,23,68,0.3);border-radius:3px;padding:6px 10px;margin-bottom:8px;font-family:var(--mono);font-size:9px;color:var(--red)">
      ⚠️ LOW LIQUIDITY — ATM OI ${atmOI.toLocaleString()} · Wide spreads likely · Consider stock entry or different expiry
    </div>` : atmOI < 1000 ? `
    <div style="background:rgba(255,214,0,0.06);border:1px solid rgba(255,214,0,0.2);border-radius:3px;padding:6px 10px;margin-bottom:8px;font-family:var(--mono);font-size:9px;color:#FFD600">
      ⚠️ MODERATE LIQUIDITY — ATM OI ${atmOI.toLocaleString()} · Verify fill before entering
    </div>` : "";

  const fmt = o => !o ? "" : `
    <div style="background:#0d1a25;border:1px solid rgba(100,181,246,0.2);border-radius:3px;padding:6px 10px;flex:1;min-width:140px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span style="font-size:10px;font-weight:700;color:#64B5F6;font-family:var(--mono)">$${o.strike}C</span>
        <span style="font-size:9px;color:var(--muted2);font-family:var(--mono)">${data.dte}DTE</span>
        <span style="font-size:9px;color:var(--muted2);font-family:var(--mono);margin-left:auto">δ ${o.delta}</span>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:4px">
        <span style="font-size:10px;font-family:var(--mono);color:var(--green2)">ask $${o.ask}</span>
        <span style="font-size:10px;font-family:var(--mono);color:var(--muted2)">IV ${o.iv}</span>
        <span style="font-size:10px;font-family:var(--mono);color:var(--muted2)">θ ${o.theta}/day</span>
        <span style="font-size:10px;font-family:var(--mono);color:#FFB300">1 contract = $${o.cost1}</span>
      </div>
      <div style="font-size:9px;font-family:var(--mono);color:${oiClr(o.oi)};margin-bottom:6px">
        ${oiLbl(o.oi)} OI ${(o.oi||0).toLocaleString()}${o.oi >= 1000 ? " — liquid" : o.oi >= 500 ? " — moderate" : " — thin"}
      </div>
      <button onclick="event.stopPropagation();logToJournal({sym:'${sym}',price:${cardEl.dataset.price||0},score:'W',source:'weinstein',session:getMarketSession(),greenArrow:false,tradeType:'Weinstein',optionStrike:${o.strike},optionExpiry:'${data.expiry}',optionDTE:${data.dte},optionDelta:${o.delta},premiumPaid:${o.ask},contracts:1})"
        style="width:100%;background:rgba(0,200,83,0.12);border:1px solid var(--green2);color:var(--green2);font-family:var(--mono);font-size:9px;padding:4px;cursor:pointer;border-radius:2px">
        📓 LOG THIS STRIKE
      </button>
    </div>`;

  el.innerHTML = `
    ${liquidityWarning}
    <div style="font-size:8px;color:var(--muted2);font-family:var(--mono);margin-bottom:4px">
      OPTIONS — ${data.expiry} (${data.dte} DTE)
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${data.atm ? `<div style="flex:1;min-width:140px"><div style="font-size:8px;color:var(--green2);font-family:var(--mono);margin-bottom:3px">ATM δ~0.47</div>${fmt(data.atm)}</div>` : ""}
      ${data.otm ? `<div style="flex:1;min-width:140px"><div style="font-size:8px;color:#FFB300;font-family:var(--mono);margin-bottom:3px">OTM δ~0.30</div>${fmt(data.otm)}</div>` : ""}
    </div>`;
}

// ── Weinstein Tab ─────────────────────────────────────────────────────────────
let wsResults = [];
let wsFilter  = "ALL"; // ALL | ENTER | WAIT | AVOID

function setWSFilter(val) {
  wsFilter = val;
  // Reset all chips
  const chips = {
    ALL:   { id: "ws-filter-ALL",  activeColor: "var(--muted2)" },
    ENTER: { id: "ws-enter-count", activeColor: "var(--green2)" },
    WAIT:  { id: "ws-wait-count",  activeColor: "#FFB300"       },
    AVOID: { id: "ws-avoid-count", activeColor: "var(--red)"    },
  };
  Object.entries(chips).forEach(([key, cfg]) => {
    const el = document.getElementById(cfg.id);
    if (!el) return;
    const isActive = key === wsFilter;
    el.style.opacity     = isActive ? "1"             : "0.45";
    el.style.borderColor = isActive ? "currentColor"  : "transparent";
  });
  renderWeinstein();
}

function loadWeinstein(){
  const grid = document.getElementById("ws-grid");
  const lastrun = document.getElementById("ws-lastrun");
  grid.innerHTML = '<div style="color:var(--muted2);font-family:var(--mono);font-size:11px;padding:20px;text-align:center">Loading...</div>';
  // Read raw from Firebase to handle both wrapped {data,savedAt} and direct array structures
  firebase.database().ref("screener/weinstein").once("value").then(snap => {
    if(!snap.exists()){
      grid.innerHTML = '<div style="color:var(--muted2);font-family:var(--mono);font-size:11px;padding:40px 20px;text-align:center;line-height:1.8">No Weinstein analysis yet.<br><span style="color:#FFB300">Open desktop Claude → run Prompt 1 with Firebase + TradingView MCP connected.</span><br><span style="font-size:9px;color:var(--muted2)">Results write to screener/weinstein and appear here automatically.</span></div>';
      return;
    }
    try{
      const val = snap.val();
      let results = [], savedAt = null, tickersAnalyzed = 0;

      if(val && val.data){
        // Expected format: {data: string|array, savedAt, device, tickersAnalyzed}
        results = typeof val.data === "string" ? JSON.parse(val.data) : val.data;
        savedAt = val.savedAt;
        tickersAnalyzed = val.tickersAnalyzed || (Array.isArray(results)?results.length:0);
      } else if(Array.isArray(val)){
        // Desktop agent wrote array directly
        results = val;
        tickersAnalyzed = val.length;
      } else if(val && typeof val === "object"){
        // Desktop agent wrote object with numeric keys (Firebase array-like)
        const keys = Object.keys(val);
        const numericKeys = keys.filter(k => !isNaN(k));
        if(numericKeys.length > 0){
          results = numericKeys.map(k => val[k]);
          tickersAnalyzed = results.length;
          savedAt = val.savedAt || null;
        }
      }

      if(!Array.isArray(results)) results = [];
      wsResults = results;
      if(savedAt) lastrun.textContent = "Updated " + new Date(savedAt).toLocaleString();
      document.getElementById("ws-sub").textContent = tickersAnalyzed + " TICKERS · DAILY + WEEKLY · DESKTOP AGENT";
      renderWeinstein();
    }catch(e){
      console.warn("loadWeinstein error:", e);
      grid.innerHTML = '<div style="color:var(--red);font-family:var(--mono);font-size:11px;padding:20px">Error parsing data: '+e.message+'</div>';
    }
  }).catch(e => {
    grid.innerHTML = '<div style="color:var(--red);font-family:var(--mono);font-size:11px;padding:20px">Firebase error — check connection.</div>';
  });
}

function renderWeinstein(){
  const grid = document.getElementById("ws-grid");
  const topbar = document.getElementById("ws-topbar");
  if(!wsResults.length){
    grid.innerHTML = '<div style="color:var(--muted2);font-family:var(--mono);font-size:11px;padding:20px;text-align:center">No results.</div>';
    return;
  }

  // Count by action
  const enters = wsResults.filter(r=>r.action==="ENTER").length;
  const waits  = wsResults.filter(r=>r.action==="WAIT").length;
  const avoids = wsResults.filter(r=>r.action==="AVOID").length;
  document.getElementById("ws-enter-count").textContent = "🟢 " + enters + " ENTER";
  document.getElementById("ws-wait-count").textContent  = "🟡 " + waits  + " WAIT";
  document.getElementById("ws-avoid-count").textContent = "🔴 " + avoids + " AVOID";
  const syms = wsResults.map(r=>r.sym);
  const tickerDisplay = syms.length > 12
    ? syms.slice(0,12).join(" · ") + " +" + (syms.length-12) + " more"
    : syms.join(" · ");
  document.getElementById("ws-tickers").textContent = wsResults.length + " analyzed: " + tickerDisplay;
  topbar.style.display = "flex";

  // Ensure ALL chip is visually active on first load (setWSFilter handles re-renders)
  const allChip = document.getElementById("ws-filter-ALL");
  if (allChip && wsFilter === "ALL") {
    allChip.style.opacity = "1";
    allChip.style.borderColor = "currentColor";
  }

  // Sort: ENTER first, then WAIT, then AVOID, within each by taScore
  const order = {ENTER:0, WAIT:1, AVOID:2};
  const sorted = [...wsResults].sort((a,b) => {
    const od = (order[a.action]||1) - (order[b.action]||1);
    return od !== 0 ? od : (b.taScore||0) - (a.taScore||0);
  });

  // Apply active filter
  const filtered = wsFilter === "ALL" ? sorted : sorted.filter(r => r.action === wsFilter);

  if (!filtered.length) {
    grid.innerHTML = `<div style="color:var(--muted2);font-family:var(--mono);font-size:11px;padding:40px 20px;text-align:center">No ${wsFilter} signals found.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(s => {
    // Action styling
    const isEnter = s.action==="ENTER";
    const isWait  = s.action==="WAIT";
    const isAvoid = s.action==="AVOID";
    const acColor = isEnter?"var(--green2)":isWait?"#FFB300":"var(--red)";
    const acBg    = isEnter?"rgba(0,200,83,0.08)":isWait?"rgba(255,179,0,0.08)":"rgba(255,60,60,0.08)";
    const acIcon  = isEnter?"🟢":isWait?"🟡":"🔴";
    const borderColor = isEnter?"var(--green2)":isWait?"#FFB300":"var(--red)";

    // Stage labels
    const stageLabel = n => ["","① BASE","② BREAKOUT","③ MARKUP","④ DISTRIB","⑤ BREAKDOWN","⑥ MARKDOWN"][n] || ("Stage "+n);
    const stageColor = n => n===2?"var(--green2)":n===3?"#64B5F6":n>=4?"var(--red)":"var(--muted2)";

    // Alignment badge
    const alignColor = s.alignment==="CONFIRMED"?"var(--green2)":s.alignment==="CONFLICT"?"#FFB300":"var(--red)";

    // Trail bullets
    const dTrail = s.trailBullishDaily  ? "🟢" : "🔴";
    const wTrail = s.trailBullishWeekly ? "🟢" : "🔴";

    // JAX bullets
    const dJAX = s.jaxActiveDaily  ? "⚡" : "—";
    const wJAX = s.jaxActiveWeekly ? "⚡" : "—";

    // taScore badge color
    const tsColor = (s.taScore||0)>=70?"#00C853":(s.taScore||0)>=50?"#FFB300":(s.taScore||0)>=30?"#FF6D00":"var(--muted2)";
    const igFlag  = s.taIgniting ? " 🚀" : "";

    // Change color
    const chg = parseFloat(s.change||0);
    const chgStr = (chg>=0?"▲":"▼")+Math.abs(chg).toFixed(2)+"%";
    const chgColor = chg>=0?"var(--green2)":"var(--red)";

    return `<div style="background:#0a1525;border:1px solid #1a3a4a;border-left:3px solid ${borderColor};border-radius:4px;padding:12px 14px;margin-bottom:10px;cursor:pointer"
      data-price="${s.price||0}"
      onclick="window.open('https://www.tradingview.com/chart/?symbol='+encodeURIComponent('${s.sym}'),'_blank')"
      id="ws-card-${s.sym}">

      <!-- Header row -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px">${tickerLogo(s.sym,18)}<span style="font-size:16px;font-weight:700;color:#fff;font-family:var(--mono)">${s.sym}</span></div>
        <span style="font-size:13px;font-weight:700;color:${chgColor};font-family:var(--mono)">${chgStr}</span>
        <span style="font-size:11px;color:var(--muted2);font-family:var(--mono)">$${parseFloat(s.price||0).toFixed(2)}</span>
        <span style="background:${tsColor};color:#000;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;font-family:var(--mono)">TA ${s.taScore||0}${igFlag}</span>
        <span style="background:${acBg};color:${acColor};font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;border:1px solid ${acColor};font-family:var(--mono);margin-left:auto">${acIcon} ${s.action}</span>
        <button onclick="event.stopPropagation();logToJournal({sym:'${s.sym}',price:${s.price||0},score:'W',source:'weinstein',session:getMarketSession(),greenArrow:${s.jaxActiveDaily||false},tradeType:'Weinstein'})"
          style="background:#0d1f2b;border:1px solid var(--blue);color:var(--blue);font-family:var(--mono);font-size:8px;padding:3px 8px;cursor:pointer;border-radius:2px">📓 LOG</button>
      </div>

      <!-- Stage row -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:8px">
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">DAILY</div>
          <div style="font-size:11px;font-weight:700;color:${stageColor(s.dailyStage)};font-family:var(--mono)">${stageLabel(s.dailyStage)}</div>
        </div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">WEEKLY</div>
          <div style="font-size:11px;font-weight:700;color:${stageColor(s.weeklyStage)};font-family:var(--mono)">${stageLabel(s.weeklyStage)}</div>
        </div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">ALIGN</div>
          <div style="font-size:10px;font-weight:700;color:${alignColor};font-family:var(--mono)">${s.alignment||"—"}</div>
        </div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">TRAIL D/W</div>
          <div style="font-size:12px;font-family:var(--mono)">${dTrail} ${wTrail}</div>
        </div>
      </div>

      <!-- RSI / Trail values row -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px">
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">D-RSI</div>
          <div style="font-size:12px;font-weight:700;color:${(s.dailyRSI||0)<70?"var(--green2)":"var(--red)"};font-family:var(--mono)">${(s.dailyRSI||0).toFixed(1)}</div>
        </div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">W-RSI</div>
          <div style="font-size:12px;font-weight:700;color:${(s.weeklyRSI||0)<70?"#64B5F6":"var(--red)"};font-family:var(--mono)">${(s.weeklyRSI||0).toFixed(1)}</div>
        </div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">JAX D/W</div>
          <div style="font-size:12px;font-family:var(--mono)">${dJAX} ${wJAX}</div>
        </div>
        <div style="background:#0d1a25;border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">D-TRAIL</div>
          <div style="font-size:11px;font-weight:700;color:var(--muted2);font-family:var(--mono)">$${parseFloat(s.dailyTrail||0).toFixed(2)}</div>
        </div>
      </div>

      ${isEnter && s.entryZone ? `
      <!-- Trade levels (ENTER only) -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
        <div style="background:rgba(0,200,83,0.06);border:1px solid rgba(0,200,83,0.2);border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">ENTRY</div>
          <div style="font-size:13px;font-weight:700;color:var(--green2);font-family:var(--mono)">$${parseFloat(s.entryZone||0).toFixed(2)}</div>
        </div>
        <div style="background:rgba(255,60,60,0.06);border:1px solid rgba(255,60,60,0.2);border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">STOP${s.stopSource==="swing-low"?" 📊":""}</div>
          <div style="font-size:13px;font-weight:700;color:var(--red);font-family:var(--mono)">$${parseFloat(s.stop||0).toFixed(2)}</div>
        </div>
        <div style="background:rgba(100,181,246,0.06);border:1px solid rgba(100,181,246,0.2);border-radius:3px;padding:5px 8px">
          <div style="font-size:8px;color:var(--muted2);font-family:var(--mono)">TARGET</div>
          <div style="font-size:13px;font-weight:700;color:#64B5F6;font-family:var(--mono)">$${parseFloat(s.target||0).toFixed(2)}</div>
        </div>
      </div>
      <!-- Options chain row — loads async via Tradier -->
      <div data-strike="${s.sym}"
        style="background:rgba(100,181,246,0.04);border:1px solid rgba(100,181,246,0.15);border-radius:3px;padding:8px 10px;margin-bottom:8px;min-height:32px"
        onclick="event.stopPropagation()">
        <span style="color:var(--muted2);font-size:9px;font-family:var(--mono)">⏳ Loading options...</span>
      </div>` : ""}

      ${isWait && s.trigger ? `
      <!-- Trigger (WAIT only) -->
      <div style="background:rgba(255,179,0,0.08);border:1px solid rgba(255,179,0,0.25);border-radius:3px;padding:6px 10px;margin-bottom:8px;font-family:var(--mono);font-size:10px;color:#FFB300">
        ⏳ TRIGGER: ${s.trigger}
      </div>` : ""}

      <!-- Summary + Key Risk -->
      ${s.summary ? `<div style="font-family:var(--mono);font-size:10px;color:var(--muted2);margin-bottom:4px">${s.summary}</div>` : ""}
      ${s.keyRisk  ? `<div style="font-family:var(--mono);font-size:9px;color:#FF6D00">⚠️ ${s.keyRisk}</div>` : ""}

    </div>`;
  }).join("");

  // After render — async load Tradier strikes for all ENTER cards
  setTimeout(() => {
    filtered.filter(s => s.action === "ENTER" && s.entryZone).forEach(s => {
      const cardEl = document.getElementById(`ws-card-${s.sym}`);
      if (cardEl) loadStrikeForCard(s.sym, s.price || 0, cardEl);
    });
  }, 50);
}

// ── Weinstein ticker search ───────────────────────────────────────────────────
async function searchWeinstein(){
  const sym = document.getElementById("ws-search-input")?.value.trim().toUpperCase();
  if(!sym){ return; }
  const panel = document.getElementById("ws-search-result");
  if(!panel) return;
  panel.style.display = "block";
  panel.innerHTML = `<div style="color:var(--muted2);font-size:10px;font-family:var(--mono)">⏳ Analysing ${sym}...</div>`;

  try{
    // Check if already in weinstein Firebase results
    const existing = await window.fbLoad("weinstein");
    if(existing && existing.data){
      const data = Array.isArray(existing.data) ? existing.data : [];
      const found = data.find(s=>s.sym===sym);
      if(found){
        panel.innerHTML = renderWeinsteinCard(found, true);
        return;
      }
    }
    // Fetch fresh data and classify
    panel.innerHTML = `<div style="color:var(--muted2);font-size:10px;font-family:var(--mono)">📡 Fetching data for ${sym}...</div>`;
    const [daily, weekly] = await Promise.all([
      fetchCandlesWithKey(sym, 0).catch(()=>null),
      fetchWeeklyCandles(sym, 0).catch(()=>null)
    ]);
    if(!daily || !weekly){
      panel.innerHTML = `<div style="color:var(--red);font-size:10px;font-family:var(--mono)">❌ No data found for ${sym}</div>`;
      return;
    }
    const classified = classifyWeinsteinTicker(sym, daily, weekly);
    if(!classified){
      panel.innerHTML = `<div style="color:var(--red);font-size:10px;font-family:var(--mono)">❌ Could not classify ${sym}</div>`;
      return;
    }
    panel.innerHTML = renderWeinsteinCard(classified, true);
  }catch(e){
    panel.innerHTML = `<div style="color:var(--red);font-size:10px;font-family:var(--mono)">❌ Error: ${e.message}</div>`;
  }
}

// ── Classify a single ticker inline ──────────────────────────────────────────
function classifyWeinsteinTicker(sym, daily, weekly){
  try{
    const closes  = daily.closes;
    const wCloses = weekly.closes;
    if(!closes?.length || !wCloses?.length) return null;

    // Daily stage
    const ema30d  = calcEMA(closes, 30);
    const ema10d  = calcEMA(closes, 10);
    const rsiD    = calcRSI(closes, 14);
    const lastD   = closes[closes.length-1];
    const lastEMA30d = ema30d[ema30d.length-1];
    const lastRSID   = rsiD[rsiD.length-1];
    const dailyUp    = lastD > lastEMA30d;
    const dailyMom   = ema10d[ema10d.length-1] > lastEMA30d;
    const dailyStage = dailyUp && dailyMom ? 2 : dailyUp ? 1 : !dailyUp && !dailyMom ? 4 : 3;

    // Weekly stage
    const ema30w  = calcEMA(wCloses, 30);
    const rsiW    = calcRSI(wCloses, 14);
    const lastW   = wCloses[wCloses.length-1];
    const lastEMA30w = ema30w[ema30w.length-1];
    const lastRSIW   = rsiW[rsiW.length-1];
    const weeklyUp   = lastW > lastEMA30w;
    const weeklyMom  = calcEMA(wCloses,10)[calcEMA(wCloses,10).length-1] > lastEMA30w;
    const weeklyStage = weeklyUp && weeklyMom ? 2 : weeklyUp ? 1 : !weeklyUp && !weeklyMom ? 4 : 3;

    const alignment = dailyStage===2 && weeklyStage===2 ? "BULLISH" :
                      dailyStage===4 && weeklyStage===4 ? "BEARISH" : "MIXED";
    const action    = alignment==="BULLISH" ? "ENTER" :
                      alignment==="BEARISH" ? "AVOID" : "WAIT";

    return { sym, dailyStage, weeklyStage, alignment, action,
             rsi: lastRSID?.toFixed(1), weeklyRsi: lastRSIW?.toFixed(1),
             price: lastD?.toFixed(2) };
  }catch(e){ return null; }
}

// ── Render single Weinstein card ──────────────────────────────────────────────
function renderWeinsteinCard(s, isSearch=false){
  const stageColor = n => n===2?"var(--green2)":n===1?"#00BCD4":n===3?"var(--yellow)":"var(--red)";
  const stageLabel = n => n===2?"Stage 2 ▲":n===1?"Stage 1 →":n===3?"Stage 3 ↓":"Stage 4 ▼";
  const actionColor = s.action==="ENTER"?"var(--green2)":s.action==="WAIT"?"var(--yellow)":"var(--red)";
  const actionIcon  = s.action==="ENTER"?"🟢":s.action==="WAIT"?"🟡":"🔴";
  return `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="font-family:var(--sans);font-size:${isSearch?"16px":"13px"};font-weight:700;color:#fff">${s.sym}</span>
    ${s.price?`<span style="font-size:11px;color:var(--muted2)">$${s.price}</span>`:""}
    <span style="font-size:11px;font-weight:700;color:${actionColor}">${actionIcon} ${s.action}</span>
    <span style="font-size:9px;padding:2px 8px;border-radius:2px;background:${actionColor}20;border:1px solid ${actionColor}40;color:${actionColor}">${s.alignment}</span>
    <div style="display:flex;gap:16px;margin-left:auto">
      <div style="text-align:center">
        <div style="font-size:8px;color:var(--muted2)">DAILY</div>
        <div style="font-size:11px;font-weight:700;color:${stageColor(s.dailyStage)}">${stageLabel(s.dailyStage)}</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:8px;color:var(--muted2)">WEEKLY</div>
        <div style="font-size:11px;font-weight:700;color:${stageColor(s.weeklyStage)}">${stageLabel(s.weeklyStage)}</div>
      </div>
      ${s.rsi?`<div style="text-align:center"><div style="font-size:8px;color:var(--muted2)">D-RSI</div><div style="font-size:11px;color:var(--text)">${s.rsi}</div></div>`:""}
      ${s.weeklyRsi?`<div style="text-align:center"><div style="font-size:8px;color:var(--muted2)">W-RSI</div><div style="font-size:11px;color:var(--text)">${s.weeklyRsi}</div></div>`:""}
    </div>
  </div>`;
}

// ── Trigger GitHub Actions run via API ────────────────────────────────────────
async function triggerWeinsteinRun(){
  const statusEl = document.getElementById("ws-run-status");
  if(statusEl) statusEl.textContent = "⏳ Triggering...";

  // Note: GitHub Actions API requires a PAT token — show instructions instead
  if(statusEl) statusEl.innerHTML = `
    <span style="color:var(--yellow)">Go to GitHub → Actions → Weinstein Classifier → Run workflow</span>
    <span style="color:var(--muted2);margin-left:8px">Results appear here automatically when done</span>`;
}
