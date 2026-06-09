// ── alerts.js ─────────────────────────────────────────────────────────────────
// Alerts Tab — Earnings Landmine, Upgrades/Downgrades, Catalyst News
// Depends on: FH_KEY (index.html), fbSafeSave, fbLoad (firebase.js)
//             journalEntries (journal.js), fetchLiveQuote (api.js)
// ─────────────────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────
let alertsData     = { earnings: [], upgrades: [], news: [], composite: [] };
let alertsRunning  = false;
let alertsLastRun  = null;

// ── Get all tickers to monitor ────────────────────────────────────────────────
// Combines watchlist + weekly monitor + open journal positions
function getAlertTickers(){
  const tickers = new Set();

  // Watchlist
  try{
    const wl = JSON.parse(localStorage.getItem("cs_watchlist")||"[]");
    wl.forEach(s=>tickers.add(s.toUpperCase()));
  }catch(e){}

  // Weekly monitor from Firebase (cached)
  try{
    const wm = JSON.parse(localStorage.getItem("cs_weekly_cache")||"[]");
    wm.forEach(r=>{ if(r.sym) tickers.add(r.sym.toUpperCase()); });
  }catch(e){}

  // Open journal positions
  try{
    (journalEntries||[])
      .filter(e=>e.status==="tracking"||e.status==="open")
      .forEach(e=>{ if(e.sym) tickers.add(e.sym.toUpperCase()); });
  }catch(e){}

  // Morning Brief recommendations (last saved)
  try{
    const brief = JSON.parse(localStorage.getItem("cs_agent_brief")||"{}");
    (brief.trades||[]).forEach(t=>{ if(t.sym) tickers.add(t.sym.toUpperCase()); });
  }catch(e){}

  return [...tickers].filter(Boolean).slice(0, 60); // cap at 60 to avoid rate limits
}

// ── Fetch earnings ────────────────────────────────────────────────────────────
async function fetchEarningsAlert(sym){
  try{
    const today  = new Date().toISOString().split("T")[0];
    const future = new Date(Date.now()+60*24*60*60*1000).toISOString().split("T")[0];
    const url    = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${future}&symbol=${sym}&token=${FH_KEY}`;
    const r      = await fetch(url);
    const d      = await r.json();
    const list   = d.earningsCalendar||[];
    if(!list.length) return null;
    const next   = list[0];
    const daysUntil = Math.max(0, Math.round((new Date(next.date)-new Date())/(1000*60*60*24)));
    return { sym, date: next.date, daysUntil, epsEst: next.epsEstimate };
  }catch(e){ return null; }
}

// ── Check if earnings conflicts with open option expiry ───────────────────────
function checkEarningsConflict(sym, earningsDate){
  if(!earningsDate) return null;
  const eDate = new Date(earningsDate);
  const conflicts = [];

  (journalEntries||[])
    .filter(e=> e.sym===sym && e.expiry && (e.status==="tracking"||e.status==="open"))
    .forEach(e=>{
      const expiry = new Date(e.expiry);
      if(eDate <= expiry){
        const daysBuffer = Math.round((expiry-eDate)/(1000*60*60*24));
        conflicts.push({
          contract: e.optionContract||`${sym} option`,
          expiry:   e.expiry,
          daysBuffer,
          action:   daysBuffer < 7 ? "CLOSE BEFORE EARNINGS" : "CONSIDER ROLLING OUT"
        });
      }
    });

  return conflicts.length ? conflicts : null;
}

// ── Fetch analyst recommendation trends (FREE tier) ──────────────────────────
// Uses /stock/recommendation endpoint — returns buy/hold/sell counts by month
async function fetchUpgradeAlert(sym){
  try{
    const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${sym}&token=${FH_KEY}`;
    const r   = await fetch(url);
    if(!r.ok) return null;
    const d   = await r.json();
    if(!d||!d.length) return null;

    // Get the two most recent months to detect trend change
    const latest = d[0];
    const prev   = d[1]||null;
    if(!latest) return null;

    const totalLatest = (latest.strongBuy||0)+(latest.buy||0)+(latest.hold||0)+(latest.sell||0)+(latest.strongSell||0);
    const totalPrev   = prev ? (prev.strongBuy||0)+(prev.buy||0)+(prev.hold||0)+(prev.sell||0)+(prev.strongSell||0) : 0;
    if(totalLatest < 3) return null; // not enough coverage

    const bullLatest = ((latest.strongBuy||0)+(latest.buy||0))/totalLatest;
    const bullPrev   = prev && totalPrev>0 ? ((prev.strongBuy||0)+(prev.buy||0))/totalPrev : null;

    // Detect trend: improving or deteriorating
    const improving    = bullPrev !== null && bullLatest > bullPrev + 0.05;
    const deteriorating= bullPrev !== null && bullLatest < bullPrev - 0.05;

    const bullPct = Math.round(bullLatest*100);
    const sentiment = bullPct >= 70 ? "STRONG BUY" : bullPct >= 55 ? "BUY" : bullPct >= 40 ? "HOLD" : "SELL";
    const isUpgrade   = improving && bullPct >= 55;
    const isDowngrade = deteriorating && bullPct < 45;

    // Only return if there's something noteworthy
    if(!isUpgrade && !isDowngrade && bullPct < 65) return null;

    return {
      sym,
      company:    `${totalLatest} analysts`,
      action:     improving?"improving":deteriorating?"deteriorating":"consensus",
      fromGrade:  prev ? `${Math.round(bullPrev*100)}% bullish` : "",
      toGrade:    `${bullPct}% bullish`,
      date:       latest.period||new Date().toISOString().split("T")[0],
      daysAgo:    0,
      bullish:    bullPct >= 55,
      bearish:    bullPct < 40,
      isUpgrade,
      isDowngrade,
      detail:     `${latest.strongBuy||0} strong buy · ${latest.buy||0} buy · ${latest.hold||0} hold · ${latest.sell||0} sell`
    };
  }catch(e){ return null; }
}

// ── Fetch catalyst news ───────────────────────────────────────────────────────
const CATALYST_KEYWORDS = [
  "FDA","approval","approved","breakthrough","fast.track","PDUFA",
  "merger","acquisition","acquired","buyout","takeover",
  "guidance raised","raises guidance","beat","earnings beat",
  "buyback","repurchase","dividend","special dividend",
  "patent","partnership","contract","awarded",
  "short squeeze","short interest"
];

async function fetchCatalystNews(sym){
  try{
    const to   = Math.floor(Date.now()/1000);
    const from = to - 3*24*60*60; // last 3 days
    const url  = `https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${new Date(from*1000).toISOString().split("T")[0]}&to=${new Date(to*1000).toISOString().split("T")[0]}&token=${FH_KEY}`;
    const r    = await fetch(url);
    const d    = await r.json();
    if(!d||!d.length) return null;

    // Filter for high-impact keywords
    const impactful = d.filter(article=>{
      const text = ((article.headline||"")+" "+(article.summary||"")).toLowerCase();
      return CATALYST_KEYWORDS.some(kw=>text.includes(kw.toLowerCase()));
    });

    if(!impactful.length) return null;

    // Score by keyword matches
    const scored = impactful.map(a=>{
      const text    = ((a.headline||"")+" "+(a.summary||"")).toLowerCase();
      const matches = CATALYST_KEYWORDS.filter(kw=>text.includes(kw.toLowerCase()));
      const hoursAgo = Math.round((Date.now()-a.datetime*1000)/3600000);
      return { ...a, keywordMatches: matches, score: matches.length, hoursAgo };
    }).sort((a,b)=>b.score-a.score||a.hoursAgo-b.hoursAgo);

    return { sym, articles: scored.slice(0,3), topHeadline: scored[0].headline, topKeywords: scored[0].keywordMatches };
  }catch(e){ return null; }
}

// ── Build composite alert score ───────────────────────────────────────────────
function buildComposite(sym, earnings, upgrade, news, reddit=null){
  const signals = [];
  let riskLevel = "normal"; // normal | elevated | high | critical

  if(earnings){
    if(earnings.daysUntil <= 7)  { signals.push(`⚠️ EARNINGS IN ${earnings.daysUntil}d`); riskLevel = "critical"; }
    else if(earnings.daysUntil <= 21){ signals.push(`📅 Earnings in ${earnings.daysUntil}d`); riskLevel = riskLevel==="normal"?"elevated":riskLevel; }
  }
  if(upgrade){
    if(upgrade.isUpgrade)   { signals.push(`📈 ${upgrade.company} UPGRADE → ${upgrade.toGrade}`); riskLevel = riskLevel==="normal"?"elevated":riskLevel; }
    if(upgrade.isDowngrade) { signals.push(`📉 ${upgrade.company} DOWNGRADE → ${upgrade.toGrade}`); riskLevel = "high"; }
  }
  if(news){
    const topKw = news.topKeywords.slice(0,2).join(", ");
    signals.push(`📰 Catalyst: ${topKw}`);
    if(news.topKeywords.some(k=>["FDA","merger","acquisition","buyout"].includes(k.toUpperCase()))){
      riskLevel = riskLevel==="normal"?"elevated":"high";
    }
  }

  // Escalate: 2+ bullish signals = high conviction
  const bullishCount = (upgrade?.isUpgrade?1:0) + (news?1:0);
  if(bullishCount >= 2 && riskLevel==="elevated") riskLevel = "high";

  if(reddit && reddit.totalMentions > 0){
    const sp = reddit.spikePct!==null ? " (+"+reddit.spikePct+"% spike)" : "";
    signals.push("🔴 Reddit: "+reddit.totalMentions+" mentions in 24h"+sp);
    if(reddit.isSpike && reddit.spikePct>=200 && riskLevel==="normal") riskLevel="elevated";
  }
  return { sym, signals, riskLevel, earnings, upgrade, news, reddit };
}


// ── Reddit sentiment (no auth needed — public JSON API) ───────────────────────
const REDDIT_CACHE_KEY = "cs_reddit_cache";
const SUBREDDITS = ["wallstreetbets","stocks","options","investing"];

async function fetchRedditMentions(sym){
  try{
    const cached = JSON.parse(localStorage.getItem(REDDIT_CACHE_KEY)||"{}");
    const now    = Date.now();
    if(cached[sym] && (now - cached[sym].fetchedAt) < 2*60*60*1000) return cached[sym];

    let totalMentions = 0;
    let posts = [];
    const regex = new RegExp("\\b"+sym+"\\b","i");

    for(const sub of SUBREDDITS){
      try{
        const url = "https://www.reddit.com/r/"+sub+"/search.json?q="+sym+"&sort=new&t=day&limit=25&restrict_sr=1";
        const r   = await fetch(url, { headers:{ "User-Agent":"ConfluenceScreener/1.0" } });
        if(!r.ok) continue;
        const d   = await r.json();
        const items = d?.data?.children||[];
        const matching = items.filter(p=>regex.test((p.data?.title||"")+" "+(p.data?.selftext||"")));
        totalMentions += matching.length;
        posts = posts.concat(matching.slice(0,2).map(p=>({
          title: p.data?.title||"", score: p.data?.score||0,
          subreddit: sub, url: "https://reddit.com"+(p.data?.permalink||""),
          hoursAgo: Math.round((now/1000-(p.data?.created_utc||0))/3600)
        })));
        await new Promise(r=>setTimeout(r,500));
      }catch(e){ continue; }
    }

    const yesterday = cached[sym]?.totalMentions||0;
    const spikePct  = yesterday>0 ? Math.round((totalMentions-yesterday)/yesterday*100) : null;
    const result = { sym, totalMentions, posts:posts.slice(0,3), spikePct, yesterday,
                     fetchedAt:now, isSpike: totalMentions>=20||(spikePct!==null&&spikePct>=100) };
    cached[sym] = result;
    try{ localStorage.setItem(REDDIT_CACHE_KEY, JSON.stringify(cached)); }catch(e){}
    return result;
  }catch(e){ return null; }
}

// ── Main run function ─────────────────────────────────────────────────────────
async function runAlertsCheck(){
  if(alertsRunning) return;
  alertsRunning = true;

  const tickers = getAlertTickers();
  if(!tickers.length){
    renderAlertsTab({ earnings:[], upgrades:[], news:[], composite:[] });
    alertsRunning = false;
    return;
  }

  updateAlertsProgress(0, tickers.length, "Starting alerts check...");
  renderAlertsTab(null, true); // show loading state

  const earnings  = [];
  const upgrades  = [];
  const news      = [];
  const composite = [];

  for(let i=0; i<tickers.length; i++){
    const sym = tickers[i];
    updateAlertsProgress(i+1, tickers.length, `Checking ${sym}...`);

    const [earn, upg, cat] = await Promise.all([
      fetchEarningsAlert(sym),
      fetchUpgradeAlert(sym),
      fetchCatalystNews(sym)
    ]);

    if(earn){
      const conflicts = checkEarningsConflict(sym, earn.date);
      earnings.push({ ...earn, conflicts });
    }
    if(upg)  upgrades.push(upg);
    if(cat)  news.push(cat);

    // Only fetch Reddit for tickers that already have a signal
    let reddit = null;
    if(earn || upg || cat){
      reddit = await fetchRedditMentions(sym).catch(()=>null);
      await new Promise(r=>setTimeout(r,600));
    }

    // Build composite if any signal exists
    if(earn || upg || cat || (reddit && reddit.isSpike)){
      composite.push(buildComposite(sym, earn||null, upg||null, cat||null, reddit||null));
    }

    await new Promise(r=>setTimeout(r, 150)); // rate limit
  }

  // Sort composite by risk level
  const riskOrder = { critical:0, high:1, elevated:2, normal:3 };
  composite.sort((a,b)=>riskOrder[a.riskLevel]-riskOrder[b.riskLevel]);

  alertsData = { earnings, upgrades, news, composite };
  alertsLastRun = new Date();

  // Save to Firebase
  fbSafeSave("alerts_cache", { data: alertsData, savedAt: alertsLastRun.toISOString() });

  renderAlertsTab(alertsData);
  updateAlertsProgress(0, 0, "");
  alertsRunning = false;

  log(`🔔 Alerts: ${composite.length} signals | ${earnings.length} earnings | ${upgrades.length} upgrades | ${news.length} catalyst`, "ok");
}

// ── Load cached alerts from Firebase ─────────────────────────────────────────
async function loadAlertsCache(){
  try{
    const fb = await window.fbLoad("alerts_cache");
    if(!fb || !fb.data) return;
    const savedAt = new Date(fb.savedAt||0);
    const ageHours = (Date.now()-savedAt.getTime())/3600000;
    if(ageHours > 4) return; // stale after 4 hours
    alertsData    = fb.data;
    alertsLastRun = savedAt;
    renderAlertsTab(alertsData);
    log(`🔔 Alerts loaded from cache (${ageHours.toFixed(1)}h ago)`, "info");
  }catch(e){}
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function updateAlertsProgress(current, total, msg){
  const prog    = document.getElementById("alerts-prog");
  const progMsg = document.getElementById("alerts-prog-msg");
  const progFill= document.getElementById("alerts-prog-fill");
  const progPct = document.getElementById("alerts-prog-pct");
  if(!prog) return;
  if(!current && !total){ prog.style.display="none"; return; }
  prog.style.display = "block";
  const pct = total>0 ? Math.round(current/total*100) : 0;
  if(progMsg)  progMsg.textContent  = msg;
  if(progFill) progFill.style.width = pct+"%";
  if(progPct)  progPct.textContent  = pct+"%";
}

// ── Render alerts tab ─────────────────────────────────────────────────────────
function renderAlertsTab(data, loading=false){
  const container = document.getElementById("alerts-intel-container");
  if(!container) return;

  if(loading){
    container.innerHTML = `<div style="color:var(--muted2);font-family:var(--mono);font-size:10px;padding:20px;text-align:center">
      ⏳ Scanning ${getAlertTickers().length} tickers for earnings, upgrades, and catalysts...
    </div>`;
    return;
  }

  if(!data || !data.composite?.length){
    container.innerHTML = `<div style="color:var(--muted2);font-family:var(--mono);font-size:10px;padding:20px;text-align:center">
      <div style="font-size:24px;margin-bottom:8px">🔔</div>
      No alerts found — run scan to check your watchlist<br>
      <span style="font-size:8px;color:var(--muted)">Checks earnings dates, analyst upgrades, and catalyst news</span>
    </div>`;
    // Still render individual sections
    renderEarningsSection(data?.earnings||[]);
    renderUpgradesSection(data?.upgrades||[]);
    renderNewsSection(data?.news||[]);
    return;
  }

  // ── Composite intelligence cards ──────────────────────────────────────────
  const riskConfig = {
    critical: { color:"var(--red)",    bg:"rgba(255,23,68,0.06)",   border:"rgba(255,23,68,0.25)",   icon:"🚨" },
    high:     { color:"var(--orange)", bg:"rgba(255,109,0,0.06)",   border:"rgba(255,109,0,0.2)",    icon:"⚠️" },
    elevated: { color:"var(--yellow)", bg:"rgba(255,179,0,0.06)",   border:"rgba(255,179,0,0.2)",    icon:"📊" },
    normal:   { color:"var(--muted2)", bg:"rgba(255,255,255,0.02)", border:"rgba(255,255,255,0.06)", icon:"ℹ️" }
  };

  container.innerHTML = data.composite.map(c=>{
    const cfg      = riskConfig[c.riskLevel]||riskConfig.normal;
    const conflicts= c.earnings?.conflicts;
    const conflictHTML = conflicts ? conflicts.map(x=>
      `<div style="margin-top:6px;padding:5px 8px;background:rgba(255,23,68,0.08);border:1px solid rgba(255,23,68,0.2);border-radius:3px;font-size:8px;color:var(--red)">
        ⚠️ ${x.contract} expires ${x.expiry} — earnings ${c.earnings.daysUntil}d away → <strong>${x.action}</strong>
      </div>`).join("") : "";

    const newsHTML = c.news ? `
      <div style="margin-top:4px;font-size:8px;color:var(--muted2);font-style:italic;line-height:1.4">
        📰 ${c.news.topHeadline.slice(0,100)}${c.news.topHeadline.length>100?"...":""}
        <span style="color:var(--muted);margin-left:4px">${c.news.articles[0].hoursAgo}h ago</span>
      </div>` : "";

    return `<div style="
        background:${cfg.bg};border:1px solid ${cfg.border};border-radius:4px;
        padding:10px 12px;margin-bottom:8px;
        border-left:3px solid ${cfg.color}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:14px">${cfg.icon}</span>
        <span style="font-family:var(--sans);font-size:13px;font-weight:700;color:#fff">${c.sym}</span>
        <span style="font-size:8px;padding:1px 6px;border-radius:2px;background:${cfg.bg};border:1px solid ${cfg.border};color:${cfg.color};text-transform:uppercase;letter-spacing:1px">${c.riskLevel}</span>
        <span style="margin-left:auto;font-size:9px;color:var(--muted2);font-family:var(--mono)">
          ${c.signals.length} signal${c.signals.length>1?"s":""}
        </span>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${c.signals.map(s=>`<div style="font-size:9px;color:var(--text2);font-family:var(--mono)">${s}</div>`).join("")}
      </div>
      ${conflictHTML}
      ${newsHTML}
      ${c.reddit&&c.reddit.totalMentions>0?`
      <div style="margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:9px;color:var(--muted2)">🔴 Reddit</span>
        <span style="font-size:10px;font-weight:700;color:${c.reddit.isSpike?"var(--orange)":"var(--muted2)"}">${c.reddit.totalMentions} mentions</span>
        ${c.reddit.spikePct!==null?`<span style="font-size:8px;color:${c.reddit.spikePct>=100?"var(--orange)":"var(--muted2)"}">(${c.reddit.spikePct>=0?"+":""}${c.reddit.spikePct}% vs yesterday)</span>`:""}
        ${c.reddit.posts?.slice(0,1).map(p=>`<a href="${p.url}" target="_blank" style="font-size:8px;color:var(--muted);text-decoration:none;margin-left:4px">r/${p.subreddit}: ${p.title.slice(0,50)}...</a>`).join("")||""}
      </div>`:""}
    </div>`;
  }).join("");

  // Render individual sections below composite
  renderEarningsSection(data.earnings);
  renderUpgradesSection(data.upgrades);
  renderNewsSection(data.news);
  renderRedditSection(data.composite?.filter(c=>c.reddit?.totalMentions>0).map(c=>c.reddit)||[]);

  // Update last run time
  const lastRun = document.getElementById("alerts-last-run");
  if(lastRun && alertsLastRun) lastRun.textContent = "Last scan: "+alertsLastRun.toLocaleTimeString();
}

// ── Earnings section ──────────────────────────────────────────────────────────
function renderEarningsSection(earnings){
  const el = document.getElementById("alerts-earnings-list");
  if(!el) return;
  if(!earnings.length){ el.innerHTML = `<div style="color:var(--muted);font-size:9px;padding:8px">No upcoming earnings in next 60 days for monitored tickers</div>`; return; }

  // Sort by days until
  earnings.sort((a,b)=>a.daysUntil-b.daysUntil);
  el.innerHTML = earnings.map(e=>{
    const urgency = e.daysUntil<=7?"var(--red)":e.daysUntil<=21?"var(--yellow)":"var(--muted2)";
    const hasConflict = e.conflicts?.length>0;
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="font-family:var(--sans);font-size:11px;font-weight:700;color:#fff;min-width:55px">${e.sym}</span>
      <span style="font-size:9px;color:${urgency};font-family:var(--mono)">${e.date}</span>
      <span style="font-size:9px;color:${urgency};font-family:var(--mono);font-weight:700">${e.daysUntil}d</span>
      ${e.epsEst?`<span style="font-size:8px;color:var(--muted2)">EPS est: ${e.epsEst}</span>`:""}
      ${hasConflict?`<span style="font-size:8px;color:var(--red);margin-left:auto">⚠️ OPTION CONFLICT</span>`:""}
    </div>`;
  }).join("");
}

// ── Upgrades section ──────────────────────────────────────────────────────────
function renderUpgradesSection(upgrades){
  const el = document.getElementById("alerts-upgrades-list");
  if(!el) return;
  if(!upgrades.length){ el.innerHTML = `<div style="color:var(--muted);font-size:9px;padding:8px">No analyst actions in last 7 days for monitored tickers</div>`; return; }

  upgrades.sort((a,b)=>a.daysAgo-b.daysAgo);
  el.innerHTML = upgrades.map(u=>{
    const color = u.isUpgrade?"var(--green2)":u.isDowngrade?"var(--red)":"var(--muted2)";
    const icon  = u.isUpgrade?"📈":u.isDowngrade?"📉":"➡️";
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:12px">${icon}</span>
      <span style="font-family:var(--sans);font-size:11px;font-weight:700;color:#fff;min-width:55px">${u.sym}</span>
      <div style="flex:1">
        <div style="font-size:9px;color:${color};font-family:var(--mono)">${u.company} — ${u.action.toUpperCase()}</div>
        <div style="font-size:8px;color:var(--muted2)">${u.fromGrade?u.fromGrade+" → ":""}<strong style="color:${color}">${u.toGrade}</strong></div>
      </div>
      <span style="font-size:8px;color:var(--muted);font-family:var(--mono)">${u.daysAgo===0?"today":u.daysAgo+"d ago"}</span>
    </div>`;
  }).join("");
}

// ── News section ──────────────────────────────────────────────────────────────
function renderNewsSection(news){
  const el = document.getElementById("alerts-news-list");
  if(!el) return;
  if(!news.length){ el.innerHTML = `<div style="color:var(--muted);font-size:9px;padding:8px">No high-impact news in last 3 days for monitored tickers</div>`; return; }

  news.sort((a,b)=>b.articles[0].score-a.articles[0].score);
  el.innerHTML = news.map(n=>{
    const top = n.articles[0];
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
        <span style="font-family:var(--sans);font-size:11px;font-weight:700;color:#fff">${n.sym}</span>
        <span style="font-size:8px;color:var(--muted2);font-family:var(--mono)">${top.hoursAgo}h ago</span>
        <div style="margin-left:auto;display:flex;gap:3px">
          ${top.keywordMatches.slice(0,3).map(k=>`<span style="font-size:7px;padding:1px 4px;background:rgba(255,179,0,0.1);border:1px solid rgba(255,179,0,0.2);color:var(--yellow);border-radius:2px">${k}</span>`).join("")}
        </div>
      </div>
      <div style="font-size:8px;color:var(--text2);line-height:1.4">${top.headline.slice(0,120)}${top.headline.length>120?"...":""}</div>
      ${n.articles.length>1?`<div style="font-size:7px;color:var(--muted);margin-top:2px">+${n.articles.length-1} more articles</div>`:""}
    </div>`;
  }).join("");
}

// ── Auto-refresh: run on tab open if cache is stale ───────────────────────────
function loadAlertsTab(){
  // Load from cache first
  loadAlertsCache().then(()=>{
    // Auto-run if no data or cache is old
    const cacheAge = alertsLastRun ? (Date.now()-alertsLastRun.getTime())/3600000 : 999;
    if(cacheAge > 2 && !alertsRunning){
      runAlertsCheck();
    }
  });
}

// ── Reddit section ────────────────────────────────────────────────────────────
function renderRedditSection(redditData){
  const el = document.getElementById("alerts-reddit-list");
  if(!el) return;
  if(!redditData.length){
    el.innerHTML = '<div style="color:var(--muted);font-size:9px;padding:8px">No Reddit spikes — only checks tickers with existing signals</div>';
    return;
  }
  redditData.sort((a,b)=>b.totalMentions-a.totalMentions);
  el.innerHTML = redditData.map(r=>{
    const spikeColor = r.spikePct>=200?"var(--red)":r.spikePct>=100?"var(--orange)":"var(--muted2)";
    return '<div style="padding:5px 0;border-bottom:1px solid var(--border)">'+
      '<div style="display:flex;align-items:center;gap:6px">'+
        '<span style="font-family:var(--sans);font-size:11px;font-weight:700;color:#fff;min-width:55px">'+r.sym+'</span>'+
        '<span style="font-size:11px;font-weight:700;color:'+spikeColor+'">'+r.totalMentions+'</span>'+
        '<span style="font-size:8px;color:var(--muted2)">mentions</span>'+
        (r.spikePct!==null?'<span style="font-size:8px;color:'+spikeColor+';font-weight:700">'+(r.spikePct>=0?"+":"")+r.spikePct+'%</span>':"")+'</div>'+
      (r.posts?.slice(0,1).map(p=>'<div style="font-size:8px;color:var(--muted2);margin-top:2px">r/'+p.subreddit+' · '+p.hoursAgo+'h ago · <a href="'+p.url+'" target="_blank" style="color:var(--muted2)">'+p.title.slice(0,70)+'...</a></div>').join("")||"")+
    '</div>';
  }).join("");
}
