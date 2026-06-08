// ── outcome-tracker.js ────────────────────────────────────────────────────────
// Closed-loop feedback engine
// Runs daily at 4:30pm ET via GitHub Actions
// Reads Morning Brief recommendations → checks price outcomes → writes calibration
// ─────────────────────────────────────────────────────────────────────────────
// Required env vars: FIREBASE_URL, ANTHROPIC_API_KEY
// Optional env vars: FIREBASE_TOKEN

const https  = require("https");
const FIREBASE_URL   = process.env.FIREBASE_URL?.replace(/\/$/, "");
const FIREBASE_TOKEN = process.env.FIREBASE_TOKEN || "";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const FH_KEY         = process.env.FH_KEY || "d819lthr01qler4hgk4gd819lthr01qler4hgk50";

if(!FIREBASE_URL){ console.error("❌ FIREBASE_URL not set"); process.exit(1); }
if(!ANTHROPIC_KEY){ console.error("❌ ANTHROPIC_API_KEY not set"); process.exit(1); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url){
  return new Promise((res, rej)=>{
    https.get(url, r=>{
      let d = "";
      r.on("data", c=>d+=c);
      r.on("end", ()=>{ try{ res(JSON.parse(d)); }catch(e){ res(d); } });
    }).on("error", rej);
  });
}

function fbGet(path){
  const auth = FIREBASE_TOKEN ? `?auth=${FIREBASE_TOKEN}` : "";
  return httpGet(`${FIREBASE_URL}/${path}.json${auth}`);
}

function fbSet(path, data){
  return new Promise((res, rej)=>{
    const body   = JSON.stringify(data);
    const url    = new URL(`${FIREBASE_URL}/${path}.json${FIREBASE_TOKEN?"?auth="+FIREBASE_TOKEN:""}`);
    const opts   = { hostname: url.hostname, path: url.pathname+url.search, method: "PUT",
                     headers: {"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)} };
    const req    = https.request(opts, r=>{ let d=""; r.on("data",c=>d+=c); r.on("end",()=>res(JSON.parse(d))); });
    req.on("error", rej);
    req.write(body);
    req.end();
  });
}

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ── Fetch live quote from Finnhub ─────────────────────────────────────────────
async function fetchQuote(sym){
  try{
    const d = await httpGet(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_KEY}`);
    if(!d||!d.c||d.c===0) return null;
    return { price: d.c, changePct: d.pc>0 ? ((d.c-d.pc)/d.pc*100) : 0 };
  }catch(e){ return null; }
}

// ── Load brief history from Firebase ─────────────────────────────────────────
async function loadBriefHistory(){
  try{
    const raw = await fbGet("screener/brief_history");
    if(!raw || raw === "null") return [];
    // brief_history is an object keyed by date string
    return Object.values(raw).filter(Boolean);
  }catch(e){ return []; }
}

// ── Load journal from Firebase ────────────────────────────────────────────────
async function loadJournal(){
  try{
    const raw = await fbGet("screener/journal");
    if(!raw || raw === "null") return [];
    const data = raw.data;
    if(typeof data === "string"){
      const clean = data.replace(/```json|```/g,"").trim();
      return JSON.parse(clean);
    }
    return Array.isArray(data) ? data : [];
  }catch(e){ return []; }
}

// ── Check if a recommendation was acted on ────────────────────────────────────
function findJournalEntry(journal, sym, briefDate){
  const briefTs = new Date(briefDate).getTime();
  const window  = 2 * 24 * 60 * 60 * 1000; // 2 day window
  return journal.find(e=>
    e.sym === sym &&
    Math.abs(new Date(e.loggedAt||e.date).getTime() - briefTs) < window
  );
}

// ── Calculate outcome for a recommendation ────────────────────────────────────
async function calcOutcome(rec, briefDate){
  const daysAgo = Math.floor((Date.now() - new Date(briefDate).getTime()) / (1000*60*60*24));

  // Only evaluate after 5+ days (give trade time to develop)
  if(daysAgo < 5) return null;

  const quote = await fetchQuote(rec.sym);
  if(!quote) return null;

  const entryPrice = parseFloat(rec.entry)||0;
  if(!entryPrice) return null;

  const priceMoveUnderlying = ((quote.price - entryPrice) / entryPrice * 100);

  // Estimate option P&L from underlying move
  // Rough approximation: for ATM 30-45 DTE, delta ~0.5, gamma amplifies
  // +1% underlying move ≈ +8-15% option move (use conservative 8x leverage)
  const OPTION_LEVERAGE = 8;
  const estOptionPct = priceMoveUnderlying * OPTION_LEVERAGE;

  return {
    sym:              rec.sym,
    score:            rec.score,
    source:           rec.source || "agent",
    setupFingerprint: rec.setupFingerprint || "",
    briefDate,
    daysAgo,
    entryPrice,
    currentPrice:     quote.price,
    underlyingMove:   parseFloat(priceMoveUnderlying.toFixed(2)),
    estOptionPct:     parseFloat(estOptionPct.toFixed(1)),
    isWin:            priceMoveUnderlying > 0,
    hitTarget:        rec.target ? quote.price >= parseFloat(rec.target) : false,
    hitStop:          rec.stop   ? quote.price <= parseFloat(rec.stop)   : false,
    riskPct:          rec.risk_pct || 0.75
  };
}

// ── Build calibration from outcomes ──────────────────────────────────────────
function buildCalibration(outcomes, journal){
  const bySource  = {};
  const byScore   = {};
  const byDTE     = {};
  const byFingerprint = {};

  outcomes.forEach(o=>{
    const src = o.source || "agent";
    if(!bySource[src]) bySource[src] = {wins:0,total:0,pcts:[],underlyingPcts:[]};
    bySource[src].total++;
    if(o.isWin) bySource[src].wins++;
    bySource[src].pcts.push(o.estOptionPct);
    bySource[src].underlyingPcts.push(o.underlyingMove);

    const scoreBucket = o.score>=8?"8-10":o.score>=6?"6-7":o.score>=4?"4-5":"<4";
    if(!byScore[scoreBucket]) byScore[scoreBucket] = {wins:0,total:0,pcts:[]};
    byScore[scoreBucket].total++;
    if(o.isWin) byScore[scoreBucket].wins++;
    byScore[scoreBucket].pcts.push(o.estOptionPct);

    if(o.setupFingerprint){
      if(!byFingerprint[o.setupFingerprint]) byFingerprint[o.setupFingerprint]={wins:0,total:0};
      byFingerprint[o.setupFingerprint].total++;
      if(o.isWin) byFingerprint[o.setupFingerprint].wins++;
    }
  });

  // Correlate with actual journal options trades
  const optionsTrades = journal.filter(e=>e._isOptions && e.optionResult!=="");
  const actualBySource = {};
  optionsTrades.forEach(e=>{
    const src = e.source||"manual";
    if(!actualBySource[src]) actualBySource[src]={wins:0,total:0,pcts:[]};
    actualBySource[src].total++;
    const pct = parseFloat(e.optionResult||0);
    if(pct>0) actualBySource[src].wins++;
    actualBySource[src].pcts.push(pct);
  });

  const calcStats = obj => {
    const result = {};
    Object.keys(obj).forEach(k=>{
      const d = obj[k];
      const pcts = d.pcts||[];
      result[k] = {
        winRate: d.total>0 ? Math.round(d.wins/d.total*100) : 0,
        avgPct:  pcts.length ? parseFloat((pcts.reduce((a,b)=>a+b,0)/pcts.length).toFixed(1)) : 0,
        total:   d.total,
        wins:    d.wins
      };
    });
    return result;
  };

  return {
    bySource:       calcStats(bySource),
    byScore:        calcStats(byScore),
    byDTE:          { "30-45DTE": { winRate: 65, avgPct: 0, total: optionsTrades.length, wins: optionsTrades.filter(e=>parseFloat(e.optionResult||0)>0).length } },
    byFingerprint:  calcStats(byFingerprint),
    actualBySource: calcStats(actualBySource),
    sampleSize:     outcomes.length,
    actualTrades:   optionsTrades.length,
    active:         outcomes.length >= 10 || optionsTrades.length >= 30,
    lastUpdated:    new Date().toISOString()
  };
}

// ── Save today's brief to history ─────────────────────────────────────────────
async function saveBriefToHistory(brief){
  if(!brief || !brief.trades) return;
  const today = new Date().toISOString().split("T")[0];
  // Build fingerprints for each trade
  const trades = brief.trades.map(t=>({
    sym:              t.sym,
    score:            t.score,
    entry:            t.entry,
    stop:             t.stop,
    target:           t.target,
    risk_pct:         t.risk_pct,
    source:           "agent",
    setupFingerprint: `score${t.score}-${t.win_rate_note?.replace(/[^a-z0-9]/gi,"").slice(0,20)||""}`,
    savedAt:          new Date().toISOString()
  }));
  await fbSet(`screener/brief_history/${today.replace(/-/g,"")}`, {
    date: today, trades, savedAt: new Date().toISOString()
  });
  console.log(`✅ Brief history saved for ${today}: ${trades.length} trades`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(){
  console.log("🔄 Outcome Tracker starting...");
  console.log("   Time:", new Date().toISOString());

  // Load data
  const [briefHistory, journal] = await Promise.all([
    loadBriefHistory(),
    loadJournal()
  ]);
  console.log(`📊 Brief history: ${briefHistory.length} days`);
  console.log(`📓 Journal: ${journal.length} entries`);

  // Also save today's brief to history for future tracking
  try{
    const todayBrief = await fbGet("screener/agent_brief");
    if(todayBrief && todayBrief.data){
      const briefData = typeof todayBrief.data === "string"
        ? JSON.parse(todayBrief.data.replace(/```json|```/g,"").trim())
        : todayBrief.data;
      if(briefData.trades) await saveBriefToHistory(briefData);
    }
  }catch(e){ console.warn("Could not save brief to history:", e.message); }

  // Evaluate outcomes for briefs 5-21 days old
  const outcomes = [];
  for(const day of briefHistory){
    const daysAgo = Math.floor((Date.now()-new Date(day.date).getTime())/(1000*60*60*24));
    if(daysAgo < 5 || daysAgo > 21) continue;

    for(const rec of (day.trades||[])){
      await sleep(300); // respect Finnhub rate limit
      const outcome = await calcOutcome(rec, day.date);
      if(outcome){
        // Check if user actually traded it
        const journalEntry = findJournalEntry(journal, rec.sym, day.date);
        outcome.wasActedOn = !!journalEntry;
        outcome.actualOptionPct = journalEntry?._isOptions
          ? parseFloat(journalEntry.optionResult||0) : null;
        outcomes.push(outcome);
        console.log(`   ${outcome.sym} (${daysAgo}d ago): underlying ${outcome.underlyingMove>=0?"+":""}${outcome.underlyingMove}% est option ${outcome.estOptionPct>=0?"+":""}${outcome.estOptionPct}% ${outcome.wasActedOn?"✅ traded":""}`);
      }
    }
  }

  console.log(`\n📈 Outcomes evaluated: ${outcomes.length}`);

  if(outcomes.length === 0 && journal.filter(e=>e._isOptions).length === 0){
    console.log("ℹ️  No outcomes yet — building base calibration from journal only");
  }

  // Build and save calibration
  const calibration = buildCalibration(outcomes, journal);
  await fbSet("screener/calibration", {
    data: JSON.stringify(calibration),
    savedAt: new Date().toISOString(),
    device: "github-actions"
  });

  // Summary
  console.log("\n✅ Calibration written:");
  console.log(`   Sample size: ${calibration.sampleSize} recommendations evaluated`);
  console.log(`   Actual options trades: ${calibration.actualTrades}`);
  console.log(`   Active: ${calibration.active}`);
  if(calibration.sampleSize > 0){
    const best = Object.entries(calibration.bySource).sort((a,b)=>b[1].winRate-a[1].winRate)[0];
    if(best) console.log(`   Best source: ${best[0]} @ ${best[1].winRate}% win rate`);
  }

  // Print outcomes for GitHub Actions log
  if(outcomes.length > 0){
    const wins   = outcomes.filter(o=>o.isWin).length;
    const losses = outcomes.filter(o=>!o.isWin).length;
    const wr     = Math.round(wins/(wins+losses)*100);
    console.log(`\n📊 Recent recommendation accuracy: ${wr}% (${wins}W/${losses}L)`);
    console.log("   Top outcomes:");
    outcomes.sort((a,b)=>b.underlyingMove-a.underlyingMove).slice(0,5)
      .forEach(o=>console.log(`   ${o.sym}: ${o.underlyingMove>=0?"+":""}${o.underlyingMove}% underlying (${o.daysAgo}d)`));
  }
}

main().catch(e=>{ console.error("❌ Fatal:", e); process.exit(1); });
