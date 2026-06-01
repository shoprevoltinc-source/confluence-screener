// ── indicators.js ─────────────────────────────────────────────────────────────
// Pure indicator and scoring functions — no DOM, no Firebase, no fetch calls
// Shared by: index.html (browser) via <script src="indicators.js">
//            jax-scanner.js, daily-full-scan.js, weekly-scanner.js (Node.js)
// ─────────────────────────────────────────────────────────────────────────────

// Universal export — works in both browser and Node.js
const _indicators = (() => {

  function calcMACD(closes, fast=12, slow=26, signal=9){
    if(closes.length < slow + signal) return {macdLine:0, signalLine:0, hist:0};
    const emaFast = calcEMA(closes, fast);
    const emaSlow = calcEMA(closes, slow);
    const macdLine = emaFast - emaSlow;
    const macdSeries = [];
    for(let i=slow; i<=closes.length; i++){
      const ef = calcEMA(closes.slice(0,i), fast);
      const es = calcEMA(closes.slice(0,i), slow);
      macdSeries.push(ef - es);
    }
    const signalLine = calcEMA(macdSeries, signal);
    const hist = macdLine - signalLine;
    return {macdLine, signalLine, hist};
  }

  function calcSuperTrend(highs, lows, closes, factor=1.5, period=10){
    if(closes.length < period+1) return {bullish:false, flipped:false, stVal:0};
    const atrVals = [];
    for(let i=1; i<closes.length; i++){
      const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      atrVals.push(tr);
    }
    const getATR = (idx) => {
      const slice = atrVals.slice(Math.max(0,idx-period), idx);
      return slice.reduce((a,b)=>a+b,0)/slice.length;
    };
    const stHistory = [];
    for(let i=period; i<closes.length; i++){
      const atr = getATR(i);
      const hl2 = (highs[i]+lows[i])/2;
      const upperBand = hl2 + factor*atr;
      const lowerBand = hl2 - factor*atr;
      const prevST = stHistory.length>0 ? stHistory[stHistory.length-1] : null;
      const prevDir = stHistory.length>0 ? prevST.dir : 1;
      let newST, newDir;
      if(prevST===null){ newST=lowerBand; newDir=1; }
      else if(prevDir===1){
        newST = Math.max(prevST.val, lowerBand);
        newDir = closes[i] > newST ? 1 : -1;
        if(newDir===-1) newST = upperBand;
      } else {
        newST = Math.min(prevST.val, upperBand);
        newDir = closes[i] < newST ? -1 : 1;
        if(newDir===1) newST = lowerBand;
      }
      stHistory.push({val:newST, dir:newDir});
    }
    const last = stHistory[stHistory.length-1];
    const prev = stHistory[stHistory.length-2];
    return {
      bullish: last && last.dir===1,
      flipped: last && prev && last.dir===1 && prev.dir===-1,
      stVal: last ? last.val : 0
    };
  }

  function calcATRTrailStop(highs, lows, closes, period=10, mult=3.5){
    if(closes.length < period+2) return {dir:1, prevDir:1, utBuy:false, utSell:false, trailVal:closes[closes.length-1]};
    const atrVals = [];
    for(let i=1; i<closes.length; i++){
      const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      atrVals.push(tr);
    }
    const getATR = (idx) => {
      const slice = atrVals.slice(Math.max(0,idx-period), idx);
      return slice.reduce((a,b)=>a+b,0)/Math.max(slice.length,1);
    };
    let trail = closes[0], tdir = 0;
    const trailHistory = [];
    for(let i=1; i<closes.length; i++){
      const atrV  = getATR(i);
      const nLoss = mult * atrV;
      const trailUp   = closes[i] - nLoss;
      const trailDown = closes[i] + nLoss;
      const prevTrail = trail;
      if(closes[i] > trail && closes[i-1] > trail)       trail = Math.max(trail, trailUp);
      else if(closes[i] < trail && closes[i-1] < trail)  trail = Math.min(trail, trailDown);
      else if(closes[i] > trail)                          trail = trailUp;
      else                                                trail = trailDown;
      const prevDir = tdir;
      tdir = trail > prevTrail ? 1 : trail < prevTrail ? -1 : tdir;
      trailHistory.push({trail, tdir, prevDir});
    }
    const last = trailHistory[trailHistory.length-1];
    const prev = trailHistory[trailHistory.length-2]||{tdir:0};
    return {
      dir:last.tdir, prevDir:prev.tdir,
      utBuy:  last.tdir===1  && prev.tdir===-1,
      utSell: last.tdir===-1 && prev.tdir===1,
      trailVal: last.trail
    };
  }

  function calcJAXPRO(closes, highs, lows){
    if(closes.length < 70) return null;
    const ema20 = calcEMA(closes, 20);
    const ema40 = calcEMA(closes, 40);
    const ema60 = calcEMA(closes, 60);
    const price = closes[closes.length-1];
    const rsi14 = calcRSI(closes, 14);
    const hh = Math.max(...highs.slice(-14));
    const ll = Math.min(...lows.slice(-14));
    const wr14 = hh===ll ? -50 : ((hh-price)/(hh-ll))*-100;
    const {hist} = calcMACD(closes);
    const st    = calcSuperTrend(highs, lows, closes, 1.5, 10);
    const atrTS = calcATRTrailStop(highs, lows, closes, 10, 3.5);
    // EMA stack — exact Pine Script match: ema20 > ema40 > ema60 AND close > ema20
    const emaStack  = price > ema20 && ema20 > ema40 && ema40 > ema60;
    const macdBull  = hist > 0;
    const rsiBull   = rsi14 > 50;
    const wrBull    = wr14 > -50;
    const stBull    = st.bullish;
    const bullScore = (emaStack?1:0)+(macdBull?1:0)+(rsiBull?1:0)+(wrBull?1:0)+(stBull?1:0);
    const greenArrow = (atrTS.utBuy || st.flipped) && bullScore >= 1 && rsi14 < 70;
    const redArrow   = atrTS.utSell && bullScore <= 2;
    return {
      ema20, ema40, ema60, rsi14, wr14,
      hist, st, atrTS,
      emaStack, macdBull, rsiBull, wrBull, stBull,
      bullScore, greenArrow, redArrow,
      trailVal: atrTS.trailVal
    };
  }

  function calcATR(highs, lows, closes, period=14){
    if(highs.length < period+1) return {currentATR:0, avgATR20:0, isCoiling:false};
    const trs = [];
    for(let i=1; i<closes.length; i++){
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i-1]),
        Math.abs(lows[i]  - closes[i-1])
      );
      trs.push(tr);
    }
    const currentATR = trs.slice(-period).reduce((a,b)=>a+b,0)/period;
    const atrSeries = [];
    for(let i=period; i<=trs.length; i++){
      atrSeries.push(trs.slice(i-period,i).reduce((a,b)=>a+b,0)/period);
    }
    const avgATR20 = atrSeries.slice(-20).reduce((a,b)=>a+b,0)/Math.min(atrSeries.length,20);
    return { currentATR, avgATR20, isCoiling: currentATR < avgATR20 };
  }

  function calcRSI(c,p=14){
    if(c.length<p+1) return 50;
    let ag=0,al=0;
    for(let i=1;i<=p;i++){const d=c[i]-c[i-1];d>=0?ag+=d:al-=d;}
    ag/=p;al/=p;
    for(let i=p+1;i<c.length;i++){
      const d=c[i]-c[i-1];
      ag=(ag*(p-1)+Math.max(d,0))/p;
      al=(al*(p-1)+Math.max(-d,0))/p;
    }
    return al===0?100:100-100/(1+ag/al);
  }

  function calcEMA(c,p=21){
    if(c.length<p) return c[c.length-1];
    const k=2/(p+1);
    let e=c.slice(0,p).reduce((a,b)=>a+b,0)/p;
    for(let i=p;i<c.length;i++) e=c[i]*k+e*(1-k);
    return e;
  }

  function scoreRecovery(sym, closes, highs, lows){
    if(closes.length < 36) throw new Error("Not enough bars");
    const price = closes[closes.length-1], prev = closes[closes.length-2];
    const change = ((price-prev)/prev)*100;
    const rsi    = calcRSI(closes, 14);
    const ema21  = calcEMA(closes, 21), ema21old = calcEMA(closes.slice(0,-5), 21);
    const emaRising = ema21 > ema21old;
    const hh = Math.max(...highs.slice(-14)), ll = Math.min(...lows.slice(-14));
    const wr = hh===ll ? -50 : ((hh-price)/(hh-ll))*-100;
    const high52 = Math.max(...highs);
    const pctHi  = (price-high52)/high52*100;
    const pctEMA = (price-ema21)/ema21*100;
    const c1=rsi<45, c2=wr<-65, c3=price>ema21, c4=emaRising, c5=pctEMA>-10, c6=pctHi<-25;
    const conds  = [c1,c2,c3,c4,c5,c6];
    const score  = conds.filter(Boolean).length;
    // C7 Deep Bounce
    const minRSI30 = Math.min(...closes.slice(-30).map((_,i,a)=>i>0?calcRSI(closes.slice(0,closes.length-30+i+1),14):50));
    const rsi5ago  = calcRSI(closes.slice(0,-5), 14);
    const c7crash  = pctHi < -50;
    const c7rsiWas = minRSI30 < 45;
    const c7rsiUp  = rsi > rsi5ago + 5;
    const deepBounce = c7crash && c7rsiWas && c7rsiUp;
    // JAX PRO
    const jax = closes.length >= 70 ? calcJAXPRO(closes, highs, lows) : null;
    const greenArrow = jax ? jax.greenArrow : false;
    const bullScore  = jax ? jax.bullScore  : 0;
    return {
      sym, price, change, rsi, wr, ema21, emaRising, high52, pctHi, pctEMA,
      c1, c2, c3, c4, c5, c6, score, conds,
      deepBounce, deepCrash:c7crash, c7crash, c7rsiWas, c7rsiUp, minRSI30, rsi5ago,
      jax, greenArrow, bullScore,
      trailVal: jax ? jax.trailVal : 0,
      jaxEmaStack: jax ? jax.emaStack  : false,
      jaxMacdBull: jax ? jax.macdBull  : false,
      jaxRsiBull:  jax ? jax.rsiBull   : false,
      jaxWrBull:   jax ? jax.wrBull    : false,
      jaxStBull:   jax ? jax.stBull    : false,
      jaxUtBuy:    jax ? jax.atrTS.utBuy  : false,
      jaxStFlip:   jax ? jax.st.flipped   : false,
      // aliases for debug/render compatibility
      deepCrash:   c7crash,
      rsiWasLow:   c7rsiWas,
      rsiTurningUp:c7rsiUp,
      jaxHasData:  jax !== null,
      c7:          deepBounce,
      liveQuote:   null,
      session:     null,
    };
  }

  function scoreCatalyst(sym, closes, highs, lows, volumes, maxPrice, minVolSpike, earnings, atrData, rvol15m){
    if(closes.length < 30) throw new Error("Not enough bars");
    // Filter nulls/NaN — some stocks have gaps in Twelve Data
    const validIdx = closes.map((c,i)=>c!=null&&!isNaN(c)&&highs[i]!=null&&lows[i]!=null?i:-1).filter(i=>i>=0);
    if(validIdx.length < 30) throw new Error("Not enough valid bars");
    const closes2  = validIdx.map(i=>closes[i]);
    const highs2   = validIdx.map(i=>highs[i]);
    const lows2    = validIdx.map(i=>lows[i]);
    const volumes2 = validIdx.map(i=>volumes[i]||0);
    // Use cleaned arrays
    closes = closes2; highs = highs2; lows = lows2; volumes = volumes2;

    const price   = closes[closes.length-1];
    const prev    = closes[closes.length-2];
    if(!price||!prev||price<=0) throw new Error("SKIP:invalid price");
    const change  = ((price-prev)/prev)*100;

    // ── ATR Coil (from your Python logic) ────────────────────
    // ATR shrinking = volatility compressing = spring loading
    const atrCoiling  = atrData ? atrData.isCoiling : false;
    const currentATR  = atrData ? atrData.currentATR : 0;
    const avgATR20    = atrData ? atrData.avgATR20 : 0;
    const atrRatio    = avgATR20 > 0 ? currentATR/avgATR20 : 1;

    // ── 15-min RVOL (same time slot — your Python logic) ─────
    // Volume exploding at this exact time vs normal = ignition
    const rvolNow     = rvol15m || 0;
    const isIgniting  = rvolNow >= 2.5;  // 2.5x+ = IGNITION
    const isWakingUp  = rvolNow >= 1.5 && rvolNow < 2.5;

    // ── Daily volume (fallback when market closed) ────────────
    const todayVol    = volumes[volumes.length-1];
    const avgVol20    = volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
    const dailySpike  = avgVol20 > 0 ? todayVol/avgVol20 : 0;
    const volDryUp    = (volumes.slice(-6,-1).reduce((a,b)=>a+b,0)/5) < avgVol20*0.6;

    // ── Price coiling (backup measure) ───────────────────────
    const last15H     = Math.max(...highs.slice(-15));
    const last15L     = Math.min(...lows.slice(-15));
    const rangeWidth  = last15H > 0 ? (last15H-last15L)/last15L*100 : 999;
    const isTight     = rangeWidth < 15;

    // ── Flat days ─────────────────────────────────────────────
    let flatDaysCount = 0;
    for(let i=closes.length-2; i>=0; i--){
      if(Math.abs(closes[i]-price)/price < 0.06) flatDaysCount++;
      else break;
    }

    // ── Breakout ──────────────────────────────────────────────
    const high20      = Math.max(...highs.slice(-21,-1));
    const breakout    = price > high20 * 1.02;

    // ── 52w levels ────────────────────────────────────────────
    const low52       = Math.min(...lows);
    const high52      = Math.max(...highs);
    const pctFromLow  = ((price-low52)/low52)*100;
    const pctFromHigh = ((price-high52)/high52)*100;
    const nearLow     = pctFromLow < 50;

    // ── Earnings ──────────────────────────────────────────────
    const hasEarnings    = earnings && earnings.daysUntil >= 0 && earnings.daysUntil <= 14;
    const earningsDays   = earnings ? earnings.daysUntil : 999;

    // ── RSI ───────────────────────────────────────────────────
    const rsi = calcRSI(closes, 14);

    // ══════════════════════════════════════════════════════════
    // 6 CONDITIONS — ATR + 15m RVOL upgraded system
    // ══════════════════════════════════════════════════════════
    const c1 = price >= 2 && price <= maxPrice;                    // Price in range ($2 min, UI-controlled max)
    const c2 = atrCoiling || (isTight && flatDaysCount >= 8);      // ATR coiling OR price tight
    const c3 = isIgniting || dailySpike >= minVolSpike || volDryUp; // 15m ignition OR daily spike OR dry-up
    const c4 = hasEarnings || breakout || change > 8;              // Catalyst present
    const c5 = nearLow || pctFromHigh < -20;                       // Deep pullback
    const c6 = rsi < 55;                                           // Not overbought

    const conds = [c1,c2,c3,c4,c5,c6];
    const score = conds.filter(Boolean).length;

    // ── Heat score — stacked signals = higher conviction ──────
    let heat = score;
    if(isIgniting && atrCoiling)       heat += 3; // 🚀 IGNITION — ATR coil + RVOL spike
    else if(isIgniting)                heat += 2; // 👀 WAKING UP — volume only
    else if(atrCoiling && volDryUp)    heat += 2; // ⏳ COILING — classic NVTS/AMPX setup
    if(hasEarnings && earningsDays<=7) heat += 1; // earnings this week
    if(breakout && rvolNow>=1.5)       heat += 1; // breakout with volume

    // ── Status label ──────────────────────────────────────────
    const status = isIgniting && atrCoiling ? "🚀 IGNITION"
                 : isIgniting               ? "👀 WAKING UP"
                 : atrCoiling && volDryUp   ? "⏳ COILING"
                 : atrCoiling               ? "⏳ WATCHING"
                 : "📡 MONITOR";

    // ── JAX PRO — C7 (green arrow = ignition confirmed) ────
    const jax = closes.length >= 70 ? calcJAXPRO(closes, highs, lows) : null;
    const greenArrow = jax ? jax.greenArrow : false;
    const bullScore  = jax ? jax.bullScore  : 0;
    // Flatten all JAX fields so they survive JSON/Firebase serialization
    const jaxRsiBull  = jax ? jax.rsiBull        : false;
    const jaxWrBull   = jax ? jax.wrBull         : false;
    const jaxEmaStack = jax ? jax.emaStack        : false;
    const jaxMacdBull = jax ? jax.macdBull        : false;
    const jaxStBull   = jax ? jax.stBull          : false;
    const jaxUtBuy    = jax ? jax.atrTS.utBuy     : false;
    const jaxStFlip   = jax ? jax.st.flipped      : false;
    const jaxTrail    = jax ? jax.trailVal        : 0;
    const jaxHasData  = jax !== null;

    // Upgrade heat score if JAX fires
    if(greenArrow) heat += 3;

    const finalStatus = greenArrow && isIgniting ? "🚀🟢 IGNITION + JAX"
      : greenArrow ? "🟢 JAX SIGNAL"
      : status;

    return {
      sym, price, change, status:finalStatus, heat, score, conds,
      // ATR data
      atrCoiling, currentATR, avgATR20, atrRatio,
      // Volume data
      rvolNow, isIgniting, isWakingUp, dailySpike, volDryUp,
      // Price data
      isTight, rangeWidth, flatDays:flatDaysCount, breakout,
      high20, high52, low52, pctFromHigh, pctFromLow, nearLow,
      // Catalyst data
      hasEarnings, earningsDays,
      // JAX PRO — all flat fields (survive JSON serialization perfectly)
      greenArrow, bullScore, jaxHasData,
      jaxRsiBull, jaxWrBull, jaxEmaStack, jaxMacdBull,
      jaxStBull, jaxUtBuy, jaxStFlip, jaxTrail,
      // Indicators
      rsi, avgVol:avgVol20, todayVol,
      // condition flags
      c1, c2, c3, c4, c5, c6,
      // direct fields needed by debug/render
      atrCoiling, greenArrow, hasEarnings,
      rsi, earnings: earnings||null,
      // aliases
      volSpike: dailySpike,
      rvolNow:  rvolNow||0,
      trailVal: jax ? jax.trailVal : 0,
    };
  }

  function scoreJAX(sym, closes, highs, lows){
    if(closes.length < 70) throw new Error("Need 70+ bars");
    const jax = calcJAXPRO(closes, highs, lows);
    if(!jax) throw new Error("JAX calc failed");
    const price   = closes[closes.length-1];
    const prev    = closes[closes.length-2];
    const change  = ((price-prev)/prev)*100;
    const high52  = Math.max(...highs);
    const low52   = Math.min(...lows);
    const pctHi   = (price-high52)/high52*100;
    const ema21   = calcEMA(closes, 21);
    const ema21old= calcEMA(closes.slice(0,-5), 21);
    return {
      sym, price, change,
      rsi:        jax.rsi14||calcRSI(closes,14),
      greenArrow: jax.greenArrow,
      bullScore:  jax.bullScore,
      utBuy:      jax.atrTS.utBuy,
      stFlipped:  jax.st.flipped,
      emaStack:   jax.emaStack,
      macdBull:   jax.macdBull,
      rsiBull:    jax.rsiBull,
      wrBull:     jax.wrBull,
      stBull:     jax.stBull,
      trailVal:   jax.trailVal,
      high52, low52, pctHi, ema21,
      emaRising: ema21 > ema21old,
    };
  }

  function scoreJAXDeep(sym, closes, highs, lows){
    if(closes.length < 70) throw new Error("Need 70+ bars");
    const jax   = calcJAXPRO(closes, highs, lows);
    if(!jax) throw new Error("JAX calc failed");
    const price  = closes[closes.length-1];
    const prev   = closes[closes.length-2];
    const change = ((price-prev)/prev)*100;
    const high52 = Math.max(...highs);
    const low52  = Math.min(...lows);
    const pctHi  = (price-high52)/high52*100;
    const ema21  = calcEMA(closes, 21);
    const ema21old = calcEMA(closes.slice(0,-5), 21);
    const rsi    = jax.rsi14 || calcRSI(closes, 14);

    // ── Deep Recovery conditions (DIFFERENT from standard) ─────────────────
    // RSI ceiling raised to 80 (vs 70 standard)
    // Must still be -20%+ off 52w high (genuinely beaten down)
    // Must be above EMA20 (trend turning)
    const deepGreenArrow = (jax.atrTS.utBuy || jax.st.flipped)
      && jax.bullScore >= 1
      && rsi < 80          // ← relaxed from 70
      && pctHi < -20       // ← still deep in the hole
      && price > jax.ema20; // ← trend turning up

    if(!deepGreenArrow) throw new Error("SKIP:no deep signal");

    return {
      sym, price, change, rsi,
      greenArrow:  true,
      bullScore:   jax.bullScore,
      utBuy:       jax.atrTS.utBuy,
      stFlipped:   jax.st.flipped,
      emaStack:    jax.emaStack,
      macdBull:    jax.macdBull,
      rsiBull:     jax.rsiBull,
      wrBull:      jax.wrBull,
      stBull:      jax.stBull,
      trailVal:    jax.trailVal,
      high52, low52, pctHi, ema21,
      emaRising:   ema21 > ema21old,
      isDeepRecovery: true,  // ← blue badge flag
      rsiCeiling:  80,
    };
  }


  // ── scoreTA — chart-quality composite (0-100) ──────────────────────
  // ADDITIVE: computes nothing the scan can't already see; just combines
  // existing inputs into a triage score + visible component breakdown.
  // mode: "recovery"  → reward oversold-turning-up, distance-off-high is a plus
  //       "continuation" (JAX/Catalyst) → reward strength, penalize overbought/extended
  // Returns { taScore, taParts, ...flags }. Never throws on short history.
  function scoreTA(closes, highs, lows, volumes, mode){
    const out = { taScore:0, taParts:{}, taHigherLows:false, taCoiling:false,
                  taVolConfirm:false, taNearTrail:false, taStrongClose:false,
                  taExtended:false, taIgniting:false };
    if(!closes || closes.length < 30) return out;
    const n = closes.length;
    const price = closes[n-1], prev = closes[n-2];
    const change = prev ? ((price-prev)/prev)*100 : 0;
    const cont = mode !== "recovery"; // default to continuation unless told recovery

    // 1) Trend structure (0-25): higher-lows / higher-highs over last ~20 bars
    let trendPts = 0;
    {
      const win = Math.min(20, n-1);
      const segLows  = lows.slice(-win), segHighs = highs.slice(-win);
      const half = Math.floor(win/2);
      const lowEarly = Math.min(...segLows.slice(0,half)),  lowLate = Math.min(...segLows.slice(half));
      const hiEarly  = Math.max(...segHighs.slice(0,half)), hiLate  = Math.max(...segHighs.slice(half));
      const higherLows  = lowLate >= lowEarly;
      const higherHighs = hiLate  >= hiEarly;
      out.taHigherLows = higherLows;
      // chop penalty: how often direction flips bar-to-bar in the window
      let flips = 0; const seg = closes.slice(-win);
      for(let i=2;i<seg.length;i++){ const a=seg[i]-seg[i-1], b=seg[i-1]-seg[i-2]; if((a>0)!==(b>0)) flips++; }
      const chop = flips/Math.max(seg.length-2,1); // 0 = clean, ~1 = noise
      trendPts = (higherLows?12:0) + (higherHighs?8:0) + Math.round((1-chop)*5);
    }
    out.taParts.trend = trendPts;

    // 2) Volatility compression (0-20): current ATR vs 20-day avg ATR
    let coilPts = 0;
    {
      const atr = calcATR(highs, lows, closes);
      const ratio = atr.avgATR20 > 0 ? atr.currentATR/atr.avgATR20 : 1;
      out.taCoiling = ratio < 0.8;
      // ratio 0.5 → full marks, 1.2+ → 0
      coilPts = Math.max(0, Math.min(20, Math.round((1.2 - ratio)/0.7 * 20)));
    }
    out.taParts.compression = coilPts;

    // 3) Volume confirmation (0-20): dry-up during base OR spike on the move
    let volPts = 0;
    {
      const today = volumes[n-1] || 0;
      const avg20 = volumes.slice(-21,-1).reduce((a,b)=>a+(b||0),0)/20;
      const spike = avg20>0 ? today/avg20 : 0;
      const dryUp = avg20>0 && (volumes.slice(-6,-1).reduce((a,b)=>a+(b||0),0)/5) < avg20*0.6;
      out.taVolConfirm = spike >= 1.5 || dryUp;
      if(spike >= 2)      volPts = 20;
      else if(spike>=1.5) volPts = 15;
      else if(dryUp)      volPts = 12;   // quiet base is constructive
      else if(spike>=1)   volPts = 6;
      else                volPts = 2;
    }
    out.taParts.volume = volPts;

    // 4) Position vs ATR trail (0-15): just-reclaimed = good R/R, far above = extended
    let trailPts = 0;
    {
      const ts = calcATRTrailStop(highs, lows, closes, 10, 3.5);
      const dist = ts.trailVal>0 ? (price - ts.trailVal)/ts.trailVal*100 : 0;
      out.taNearTrail = dist >= 0 && dist <= 6;
      out.taExtended  = dist > 15;
      if(dist < 0)        trailPts = 4;    // below trail — risky
      else if(dist <= 6)  trailPts = 15;   // fresh reclaim — best entry
      else if(dist <= 12) trailPts = 9;
      else if(dist <= 20) trailPts = 4;
      else                trailPts = 1;    // far extended
    }
    out.taParts.trail = trailPts;

    // 5) Candle quality, last bar (0-10): strong close, small upper wick
    let candlePts = 0;
    {
      const h=highs[n-1], l=lows[n-1], c=closes[n-1], o=closes[n-2]; // o≈prev close (no open in feed)
      const range = h-l;
      if(range>0){
        const closePos = (c-l)/range;            // 1 = closed at high
        const upperWick = (h-Math.max(c,o))/range;
        candlePts = Math.round(closePos*7) + Math.round((1-Math.min(upperWick*2,1))*3);
        out.taStrongClose = closePos >= 0.7 && upperWick <= 0.25;
      } else candlePts = 3;
    }
    out.taParts.candle = candlePts;

    // 6) Momentum (0-10) — MODE-DEPENDENT
    let momPts = 0;
    {
      const rsi = calcRSI(closes,14);
      const rsi5ago = calcRSI(closes.slice(0,-5),14);
      if(cont){
        // continuation: reward rising RSI, penalize overbought (the PLTR-at-67 problem)
        if(rsi>70)        momPts = 2;
        else if(rsi>=50)  momPts = (rsi>rsi5ago?10:7);
        else              momPts = 4;
      } else {
        // recovery: reward oversold turning up
        if(rsi<45 && rsi>rsi5ago+3) momPts = 10; // oversold and lifting
        else if(rsi<50 && rsi>rsi5ago) momPts = 7;
        else if(rsi<55) momPts = 4;
        else momPts = 2;                          // already recovered — less juice
      }
    }
    out.taParts.momentum = momPts;

    // 7) Ignition bonus (0-15) — today's move + volume, the thing the 6-cond
    //    Recovery score is blind to. Big green day on volume floats to the top.
    let igPts = 0;
    {
      const today = volumes[n-1] || 0;
      const avg20 = volumes.slice(-21,-1).reduce((a,b)=>a+(b||0),0)/20;
      const spike = avg20>0 ? today/avg20 : 0;
      const bigUp = change >= 5;
      const modUp = change >= 2.5;
      out.taIgniting = bigUp && spike >= 1.5;
      if(bigUp && spike>=2)        igPts = 15;
      else if(bigUp && spike>=1.5) igPts = 12;
      else if(bigUp)               igPts = 8;
      else if(modUp && spike>=1.5) igPts = 6;
      else if(modUp)               igPts = 3;
    }
    out.taParts.ignition = igPts;

    out.taScore = Math.max(0, Math.min(100,
      trendPts + coilPts + volPts + trailPts + candlePts + momPts + igPts));
    return out;
  }

  return {
    calcEMA, calcRSI, calcMACD, calcSuperTrend, calcATRTrailStop,
    calcJAXPRO, calcATR, scoreRecovery, scoreCatalyst, scoreJAX, scoreJAXDeep,
    scoreTA
  };
})();

// Browser: attach to window
if(typeof window !== 'undefined') Object.assign(window, _indicators);
// Node.js: export
if(typeof module !== 'undefined') module.exports = _indicators;
