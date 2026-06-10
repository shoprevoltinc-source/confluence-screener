// ── regime.js ─────────────────────────────────────────────────────────────────
// Market Regime Detector
// Classifies market as TRENDING / CHOPPY / VOLATILE / BEAR each morning
// Data: SPY move, VIX level, breadth (A/D ratio), sector rotation
// Exposes: detectRegime(), window.currentRegime
// Depends on: FH_KEY (index.html)
// ─────────────────────────────────────────────────────────────────────────────

window.currentRegime = null;

// ── Regime definitions ────────────────────────────────────────────────────────
const REGIMES = {
  TRENDING: {
    label:   "📈 TRENDING",
    color:   "#00E676",
    bg:      "rgba(0,230,118,0.08)",
    border:  "rgba(0,230,118,0.3)",
    advice:  "Strong trend day — take all qualifying setups. Full size on TIER 1/2.",
    maxTrades: 5,
    minScore:  4,
    sizeMultiplier: 1.0
  },
  CHOPPY: {
    label:   "〰️ CHOPPY",
    color:   "#FFB300",
    bg:      "rgba(255,179,0,0.08)",
    border:  "rgba(255,179,0,0.3)",
    advice:  "Low conviction day — be selective. Prefer TIER 1 and score 7+ only.",
    maxTrades: 3,
    minScore:  6,
    sizeMultiplier: 0.75
  },
  VOLATILE: {
    label:   "⚡ VOLATILE",
    color:   "#FF6D00",
    bg:      "rgba(255,109,0,0.08)",
    border:  "rgba(255,109,0,0.3)",
    advice:  "High volatility — reduce size to 0.5% max. Options premium elevated, widen stops.",
    maxTrades: 2,
    minScore:  7,
    sizeMultiplier: 0.5
  },
  BEAR: {
    label:   "🐻 BEAR",
    color:   "#FF1744",
    bg:      "rgba(255,23,68,0.08)",
    border:  "rgba(255,23,68,0.3)",
    advice:  "Broad market selling — consider puts only or stay cash. Avoid new longs.",
    maxTrades: 1,
    minScore:  8,
    sizeMultiplier: 0.5
  }
};

// ── Sector ETF map ────────────────────────────────────────────────────────────
const SECTOR_ETFS = {
  XLK: "Tech", XLF: "Financials", XLV: "Health",
  XLE: "Energy", XLI: "Industrials", XLC: "Comms",
  XLY: "Consumer Disc", XLP: "Consumer Staples",
  XLU: "Utilities", XLB: "Materials", XLRE: "Real Estate"
};

// ── Fetch quote ───────────────────────────────────────────────────────────────
async function fetchRegimeQuote(sym){
  try{
    const url = `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_KEY}`;
    const r   = await fetch(url);
    const d   = await r.json();
    if(!d||!d.c||d.c===0) return null;
    return {
      price:     d.c,
      prev:      d.pc,
      changePct: d.pc>0 ? ((d.c-d.pc)/d.pc*100) : 0,
      high:      d.h,
      low:       d.l
    };
  }catch(e){ return null; }
}

// ── Fetch VIX proxy ──────────────────────────────────────────────────────────
// Finnhub doesn't support ^VIX directly — use VIXY (ProShares VIX ETF) as proxy
// VIXY price ~= VIX/3 roughly, so we scale it up
// Alternatively infer VIX from SPY options spread — use VIXY for now
async function fetchVIX(){
  try{
    // Try VIXY — ProShares Short-Term VIX futures ETF
    // VIXY typically trades at ~VIX/3, scale to get approximate VIX
    const vixy = await fetchRegimeQuote("VIXY");
    if(vixy && vixy.price > 0){
      const approxVIX = vixy.price * 3.2; // rough scaling factor
      return {
        price:     parseFloat(approxVIX.toFixed(1)),
        changePct: vixy.changePct,
        high:      vixy.high * 3.2,
        low:       vixy.low  * 3.2,
        _source:   "VIXY proxy"
      };
    }
    // Fallback: UVXY (2x VIX) — divide by 6
    const uvxy = await fetchRegimeQuote("UVXY");
    if(uvxy && uvxy.price > 0){
      const approxVIX = uvxy.price * 1.6;
      return { price: parseFloat(approxVIX.toFixed(1)), changePct: uvxy.changePct, _source: "UVXY proxy" };
    }
    return null;
  }catch(e){ return null; }
}

// ── Fetch market breadth via sector ETFs ─────────────────────────────────────
async function fetchBreadth(){
  const syms   = Object.keys(SECTOR_ETFS);
  const results = [];
  // Batch fetch with small delay
  for(let i=0; i<syms.length; i+=3){
    const batch = syms.slice(i,i+3);
    const quotes = await Promise.all(batch.map(s=>fetchRegimeQuote(s)));
    quotes.forEach((q,idx)=>{
      if(q) results.push({ sym: batch[idx], sector: SECTOR_ETFS[batch[idx]], ...q });
    });
    if(i+3 < syms.length) await new Promise(r=>setTimeout(r,200));
  }
  const advancing  = results.filter(r=>r.changePct>0);
  const declining  = results.filter(r=>r.changePct<0);
  const adRatio    = results.length>0 ? advancing.length/results.length : 0.5;
  const leaders    = [...results].sort((a,b)=>b.changePct-a.changePct).slice(0,3);
  const laggards   = [...results].sort((a,b)=>a.changePct-b.changePct).slice(0,3);
  return { advancing: advancing.length, declining: declining.length,
           total: results.length, adRatio, leaders, laggards, sectors: results };
}

// ── Classify regime ───────────────────────────────────────────────────────────
function classifyRegime(spy, vix, breadth){
  const spyMove  = spy?.changePct || 0;
  const adRatio  = breadth?.adRatio || 0.5;
  const hasVIX   = vix && vix.price > 0;
  const vixLevel = hasVIX ? vix.price : null;

  // BEAR: SPY down hard, or VIX spiking + broad selling
  if(spyMove < -1.5) return "BEAR";
  if(hasVIX && vixLevel > 30 && spyMove < -0.5) return "BEAR";

  // VOLATILE: VIX elevated OR big intraday swings
  if(hasVIX && vixLevel > 25) return "VOLATILE";
  if(hasVIX && vixLevel > 20 && Math.abs(spyMove) > 1.2) return "VOLATILE";
  if(!hasVIX && Math.abs(spyMove) > 1.5) return "VOLATILE"; // no VIX fallback

  // TRENDING: SPY up, broad participation, VIX calm (or unknown)
  if(spyMove > 0.5 && adRatio > 0.6 && (!hasVIX || vixLevel < 20)) return "TRENDING";

  // CHOPPY: everything else
  return "CHOPPY";
}

// ── Main detect function ──────────────────────────────────────────────────────
async function detectRegime(){
  console.log("🔍 Detecting market regime...");

  // Check cache — don't re-fetch within 15 min
  const cached    = localStorage.getItem("cs_regime");
  const cachedAt  = localStorage.getItem("cs_regime_at");
  if(cached && cachedAt){
    const ageMin = (Date.now()-new Date(cachedAt).getTime())/60000;
    if(ageMin < 15){
      window.currentRegime = JSON.parse(cached);
      console.log(`🔍 Regime (cached ${ageMin.toFixed(0)}min): ${window.currentRegime.type}`);
      renderRegimeBanner(window.currentRegime);
      return window.currentRegime;
    }
  }

  try{
    // Fetch all data in parallel
    const [spy, vix] = await Promise.all([
      fetchRegimeQuote("SPY"),
      fetchVIX()
    ]);
    const breadth = await fetchBreadth();

    const type   = classifyRegime(spy, vix, breadth);
    const config = REGIMES[type];

    // Build sector rotation string
    const leaderStr  = breadth.leaders.map(s=>`${s.sector} ${s.changePct>=0?"+":""}${s.changePct.toFixed(1)}%`).join(", ");
    const laggardStr = breadth.laggards.map(s=>`${s.sector} ${s.changePct.toFixed(1)}%`).join(", ");

    const regime = {
      type,
      label:           config.label,
      color:           config.color,
      bg:              config.bg,
      border:          config.border,
      advice:          config.advice,
      maxTrades:       config.maxTrades,
      minScore:        config.minScore,
      sizeMultiplier:  config.sizeMultiplier,
      // Raw data
      spyMove:         spy ? parseFloat(spy.changePct.toFixed(2)) : null,
      spyPrice:        spy?.price || null,
      vixLevel:        vix ? parseFloat(vix.price.toFixed(1)) : null,
      vixChange:       vix ? parseFloat(vix.changePct.toFixed(1)) : null,
      breadthAD:       `${breadth.advancing}/${breadth.total} sectors advancing`,
      adRatio:         parseFloat((breadth.adRatio*100).toFixed(0)),
      leadingSectors:  leaderStr,
      laggingSectors:  laggardStr,
      detectedAt:      new Date().toISOString()
    };

    // Cache it
    localStorage.setItem("cs_regime", JSON.stringify(regime));
    localStorage.setItem("cs_regime_at", new Date().toISOString());

    // Save to Firebase for Telegram and GitHub Actions
    if(window.firebaseReady){
      fbSafeSave("market_regime", regime);
    }

    window.currentRegime = regime;
    console.log(`🔍 Regime: ${type} | SPY ${spy?.changePct>=0?"+":""}${spy?.changePct?.toFixed(2)||"?"}% | VIX ${vix?.price?.toFixed(1)||"? (unavailable)"} ${vix?._source?"("+vix._source+")":""} | Breadth ${breadth.advancing}/${breadth.total}`);
    renderRegimeBanner(regime);
    return regime;

  }catch(e){
    console.warn("Regime detection failed:", e);
    return null;
  }
}

// ── Render regime banner on dashboard ────────────────────────────────────────
function renderRegimeBanner(regime){
  if(!regime) return;
  let banner = document.getElementById("regime-banner");

  // Use dedicated slot inside Morning Brief card
  const slot = document.getElementById("regime-banner-slot");

  // Create banner if it doesn't exist
  if(!banner){
    banner = document.createElement("div");
    banner.id = "regime-banner";
    banner.style.cssText = `
      margin: 0 0 0 0;
      border-radius: 0 0 4px 4px;
      padding: 8px 14px;
      font-family: var(--mono);
      font-size: 10px;
      cursor: pointer;
      transition: opacity 0.2s;
    `;
    banner.onclick = ()=>{
      const detail = document.getElementById("regime-detail");
      if(detail) detail.style.display = detail.style.display==="none"?"block":"none";
    };
    // Insert into dedicated slot
    if(slot) slot.appendChild(banner);
    else {
      // Fallback: insert before agent-brief-body
      const agentBody = document.getElementById("agent-brief-body");
      if(agentBody) agentBody.parentElement.insertBefore(banner, agentBody);
    }
  }

  banner.style.background   = regime.bg;
  banner.style.border       = `1px solid ${regime.border}`;
  banner.style.color        = regime.color;

  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-weight:700;font-size:11px;letter-spacing:1px">${regime.label}</span>
      <span style="color:var(--muted2)">SPY ${regime.spyMove>=0?"+":""}${regime.spyMove??'?'}%</span>
      <span style="color:var(--muted2)">VIX ${regime.vixLevel??'?'}</span>
      <span style="color:var(--muted2)">Breadth ${regime.adRatio??'?'}%</span>
      <span style="color:${regime.color};margin-left:auto;font-size:9px">${regime.advice}</span>
    </div>
    <div id="regime-detail" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid ${regime.border}">
      <div style="color:var(--muted2);margin-bottom:4px">📈 Leading: <span style="color:var(--green2)">${regime.leadingSectors||'—'}</span></div>
      <div style="color:var(--muted2);margin-bottom:4px">📉 Lagging: <span style="color:var(--red)">${regime.laggingSectors||'—'}</span></div>
      <div style="color:var(--muted2)">🏦 ${regime.breadthAD} · Max trades today: <span style="color:${regime.color}">${regime.maxTrades}</span> · Min score: <span style="color:${regime.color}">${regime.minScore}/10</span></div>
    </div>`;
}

// ── Auto-detect on page load + refresh every 30 min during market hours ───────
document.addEventListener("DOMContentLoaded", ()=>{
  const sess = getMarketSession();
  if(sess === "open" || sess === "premarket"){
    detectRegime();
    // Refresh every 30 min during market hours
    setInterval(()=>{
      if(getMarketSession()==="open") detectRegime();
    }, 30*60*1000);
  }
});
