// ── api.js ────────────────────────────────────────────────────────────────────
// All external API calls: Claude proxy, Finnhub, TwelveData
// Depends on: TD_KEYS, FH_KEY (defined in index.html), sleep() (defined in index.html)
// Exposes: callClaude, renderMD, fetchEarningsDate, fetchUpgrades,
//          fetchLiveQuote, fetchCandles, fetchCandlesWithKey,
//          fetch4HCandles, fetch15mCandles
// ─────────────────────────────────────────────────────────────────────────────

// ── Market session detection ──────────────────────────────────────────────────
function getMarketSession(){
  const now  = new Date();
  const et   = new Date(now.toLocaleString("en-US", {timeZone:"America/New_York"}));
  const day  = et.getDay();
  const h    = et.getHours();
  const m    = et.getMinutes();
  const mins = h*60 + m;
  if(day===0 || day===6) return "weekend";
  if(mins < 4*60)        return "closed";
  if(mins < 9*60+30)     return "premarket";
  if(mins < 16*60)       return "open";
  if(mins < 20*60)       return "afterhours";
  return "closed";
}

// ── Key status indicator ──────────────────────────────────────────────────────
function updateKeyStatus(activeKeys){
  const els = document.querySelectorAll("[id^='ks']");
  els.forEach((el, i) => {
    const isActive = activeKeys ? activeKeys.includes(i) : false;
    el.className = "ks" + (isActive ? " active" : "");
  });
}

// ── Call Claude via Cloudflare proxy ─────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt, maxTokens=1500){
  const workerUrl = localStorage.getItem("cs_claude_proxy")||"https://yellow-hall-2317confluence-proxy.kevonjones26.workers.dev";
  if(!workerUrl){
    throw new Error("Claude proxy not configured. Set cs_claude_proxy in localStorage.");
  }
  console.log("CLAUDE PAYLOAD", {userLen: userPrompt?.length, userPreview: userPrompt?.slice(0,200)});
  const response = await fetch(workerUrl, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: systemPrompt, user: userPrompt, max_tokens: maxTokens, temperature: 0.1 })
  });
  if(!response.ok){
    let errBody = {};
    try{ errBody = await response.json(); }catch(e){}
    throw new Error(`Worker returned ${response.status}: ${errBody?.error?.message || errBody?.error || JSON.stringify(errBody)}`);
  }
  const data = await response.json();
  if(data.error) throw new Error(data.error.message||JSON.stringify(data.error));
  return data.content[0].text;
}

// ── Markdown renderer for Claude responses ────────────────────────────────────
function renderMD(text){
  if(!text) return "";
  let html = text
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,"<em>$1</em>")
    .replace(/\n{2,}/g,"</p><p>")
    .replace(/\n/g,"<br>");
  return `<p>${html}</p>`;
}

// ── Finnhub: earnings date ────────────────────────────────────────────────────
const earningsCache = {};
async function fetchEarningsDate(sym){
  try{
    const today  = new Date().toISOString().split("T")[0];
    const future = new Date(Date.now()+30*24*60*60*1000).toISOString().split("T")[0];
    const url    = "https://finnhub.io/api/v1/calendar/earnings?from="+today+"&to="+future+"&symbol="+sym+"&token="+FH_KEY;
    const r      = await fetch(url);
    const d      = await r.json();
    const list   = d.earningsCalendar||[];
    if(!list.length) return null;
    const days = Math.round((new Date(list[0].date)-new Date())/(1000*60*60*24));
    return {date:list[0].date, daysUntil:Math.max(0,days)};
  }catch(e){ return null; }
}

// ── Finnhub: analyst upgrades/downgrades (last 7 days) ───────────────────────
const upgradeCache = {};
async function fetchUpgrades(sym){
  if(upgradeCache[sym] !== undefined) return upgradeCache[sym];
  try{
    const url = "https://finnhub.io/api/v1/stock/upgrade-downgrade?symbol="+sym+"&token="+FH_KEY;
    const r = await fetch(url);
    if(!r.ok){ upgradeCache[sym]=null; return null; }
    const data = await r.json();
    if(!data || !data.length){ upgradeCache[sym]=null; return null; }
    const cutoff = Date.now() - 7*24*60*60*1000;
    const recent = data.filter(d=> new Date(d.gradeDate).getTime() >= cutoff);
    if(!recent.length){ upgradeCache[sym]=null; return null; }
    recent.sort((a,b)=>new Date(b.gradeDate)-new Date(a.gradeDate));
    const top = recent[0];
    const bullishGrades = ["buy","strong buy","outperform","overweight","positive","accumulate","add"];
    const toGrade   = (top.toGrade||"").toLowerCase();
    const fromGrade = (top.fromGrade||"").toLowerCase();
    const isBullish   = bullishGrades.some(g=>toGrade.includes(g));
    const isBearish   = toGrade.includes("sell")||toGrade.includes("underperform")||toGrade.includes("underweight");
    const isUpgrade   = top.action==="upgrade"||(isBullish&&!bullishGrades.some(g=>fromGrade.includes(g)));
    const isDowngrade = top.action==="downgrade"||(isBearish&&!fromGrade.includes("sell"));
    const result = {
      company: top.company||"Analyst", action: top.action||"reiterated",
      fromGrade: top.fromGrade||"", toGrade: top.toGrade||"", date: top.gradeDate,
      isBullish, isBearish, isUpgrade, isDowngrade,
      daysAgo: Math.floor((Date.now()-new Date(top.gradeDate).getTime())/86400000)
    };
    upgradeCache[sym] = result;
    return result;
  }catch(e){ upgradeCache[sym]=null; return null; }
}

// ── Finnhub: live quote ───────────────────────────────────────────────────────
async function fetchLiveQuote(sym){
  try{
    const url = "https://finnhub.io/api/v1/quote?symbol="+sym+"&token="+FH_KEY;
    const r   = await fetch(url);
    const d   = await r.json();
    if(!d||!d.c||d.c===0) return null;
    const changePct = d.pc && d.pc > 0 ? ((d.c - d.pc) / d.pc) * 100 : (d.dp||0);
    return {
      price: d.c, prev: d.pc, change: d.c - d.pc, changePct,
      high: d.h||0, low: d.l||0, open: d.o||0,
      session: d.c!==d.pc?"live":"closed"
    };
  }catch(e){ return null; }
}

// ── Finnhub: 15-minute intraday candles ──────────────────────────────────────
async function fetch15mCandles(sym){
  try{
    const now  = Math.floor(Date.now()/1000);
    const from = now - 11*24*60*60;
    const url  = "https://finnhub.io/api/v1/stock/candle?symbol="+sym+"&resolution=15&from="+from+"&to="+now+"&token="+FH_KEY;
    const r    = await fetch(url);
    const d    = await r.json();
    if(!d||d.s==="no_data"||!d.c) return null;
    return d;
  }catch(e){ return null; }
}

// ── TwelveData: daily candles ─────────────────────────────────────────────────
async function fetchCandles(sym){ return fetchCandlesWithKey(sym, 0); }

async function fetchCandlesWithKey(sym, keyIndex, retries=3){
  for(let attempt=0; attempt<retries; attempt++){
    const key = TD_KEYS[keyIndex % TD_KEYS.length];
    const url = "https://api.twelvedata.com/time_series?symbol="+sym+"&interval=1day&outputsize=260&apikey="+key;
    try{
      const r = await fetch(url, {cache:"no-store"});
      const d = await r.json();
      if(d.status==="error"){
        if(d.message&&d.message.includes("API credits")){ await sleep(2000); continue; }
        throw new Error("SKIP:"+d.message);
      }
      const vals = [...(d.values||[])].reverse();
      if(vals.length < 30) throw new Error("SKIP:not enough bars");
      return {
        closes:  vals.map(v=>parseFloat(v.close)),
        highs:   vals.map(v=>parseFloat(v.high)),
        lows:    vals.map(v=>parseFloat(v.low)),
        volumes: vals.map(v=>parseFloat(v.volume||0)),
        dates:   vals.map(v=>v.datetime),
        bars:    vals.length
      };
    }catch(e){
      if(e.message&&e.message.startsWith("SKIP:")) throw e;
      if(attempt===retries-1) throw e;
      await sleep(2000);
    }
  }
}

// ── TwelveData: 4H candles ────────────────────────────────────────────────────
async function fetch4HCandles(sym, keyIndex){
  const key = TD_KEYS[keyIndex % TD_KEYS.length];
  const url = "https://api.twelvedata.com/time_series?symbol="+sym+"&interval=4h&outputsize=500&apikey="+key;
  const r = await fetch(url, {cache:"no-store"});
  if(!r.ok) throw new Error("HTTP "+r.status);
  const d = await r.json();
  if(d.status==="error"){
    if(d.message&&(d.message.includes("not found")||d.message.includes("missing or invalid")))
      throw new Error("SKIP:"+d.message);
    throw new Error(d.message||"API error");
  }
  if(!d.values||!d.values.length) throw new Error("No 4H data");
  const vals = [...d.values].reverse();
  return {
    closes: vals.map(v=>parseFloat(v.close)),
    highs:  vals.map(v=>parseFloat(v.high)),
    lows:   vals.map(v=>parseFloat(v.low)),
    dates:  vals.map(v=>v.datetime),
    bars:   vals.length
  };
}
