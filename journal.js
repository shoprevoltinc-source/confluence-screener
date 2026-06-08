// ── journal.js ───────────────────────────────────────────────────────────────
// Trade Journal — load, save, log, render, close prices
// Depends on: fbSafeSave, fbLoad, fbListen (firebase.js)
//             fetchLiveQuote (api.js)
//             log, showToast, sendNotification, sleep, tickerLogo (index.html)
// Exposes: journalEntries (global), loadJournal, saveJournal, logToJournal,
//          addManualEntry, renderJournal, fetchClosingPrices, startCloseAutoTimer
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════
// TRADE JOURNAL
// ══════════════════════════════════════════════════════════

let journalEntries = [];

function loadJournal(){
  try{
    const saved = localStorage.getItem("cs_journal");
    if(saved) journalEntries = JSON.parse(saved);
  }catch(e){ journalEntries = []; }
  // Also load from Firebase
  const _doJournalFirebase = async()=>{
    try{
      const fb = await window.fbLoad("journal");
      if(fb && fb.data && fb.data.length >= journalEntries.length){
        journalEntries = fb.data;
        localStorage.setItem("cs_journal", JSON.stringify(journalEntries));
      }
      // Real-time sync
      window.fbListen("journal", (fb)=>{
        if(fb.data !== undefined){
          const localClearedStr = localStorage.getItem("cs_journal_cleared");
          const localCleared = localClearedStr ? new Date(localClearedStr).getTime() : 0;
          const fbSavedAt = new Date(fb.savedAt||0).getTime();
          if(fb.data.length === 0 || (fb.data.length > 0 && fbSavedAt > localCleared)){
            journalEntries = fb.data;
            localStorage.setItem("cs_journal", JSON.stringify(journalEntries));
            renderJournal();
            if(fb.data.length === 0) showToast("📓 Journal cleared");
          }
        }
      });
    }catch(e){}
  };
  if(window.firebaseReady){ _doJournalFirebase(); } else { document.addEventListener("firebaseReady", _doJournalFirebase, {once:true}); }
  renderJournal();
}

function saveJournal(){
  try{ localStorage.setItem("cs_journal", JSON.stringify(journalEntries)); }catch(e){}
  fbSafeSave("journal", journalEntries);
  const el = document.getElementById("jnl-last-update");
  if(el) el.textContent = "last updated " + new Date().toLocaleTimeString();
}

function logToJournal(entry){
  // entry = { sym, price, score, source, session, greenArrow, heat }
  const today = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"2-digit"});

  // ── No duplicates: same ticker + same date = update existing entry ────────
  const existing = journalEntries.find(e=>e.sym===entry.sym && e.date===today);
  if(existing){
    // Update price if different (e.g. re-logged after price moved)
    const oldPrice = parseFloat(existing.price).toFixed(2);
    const newPrice = parseFloat(entry.price).toFixed(2);
    if(oldPrice !== newPrice){
      existing.price = entry.price;
      existing.score = entry.score;
      existing.greenArrow = entry.greenArrow||false;
      saveJournal();
      renderJournal();
      showToast("📓 "+entry.sym+" updated · $"+entry.price.toFixed(2)+" (was $"+oldPrice+")");
      log("📓 Updated "+entry.sym+" in journal · $"+entry.price.toFixed(2),"info");
    } else {
      showToast("⚠ "+entry.sym+" already logged today at $"+oldPrice);
    }
    return;
  }

  // New entry
  const id = Date.now();
  journalEntries.unshift({
    id, date: today, sym: entry.sym,
    price: entry.price, score: entry.score,
    source: entry.source||"manual",
    session: entry.session||getMarketSession(),
    greenArrow: entry.greenArrow||false,
    heat: entry.heat||0,
    tradeType: entry.tradeType||"",
    entryMode: entry.entryMode||"tracking", // "tracking" or "trade"
    stopLoss: entry.stopLoss||"",
    target1: entry.target1||"",
    target2: entry.target2||"",
    notes: entry.notes||"",
    result: "", status: "tracking",
    loggedAt: new Date().toISOString()
  });
  saveJournal();
  renderJournal();
  showToast("📓 "+entry.sym+" logged · $"+entry.price.toFixed(2)+" · "+entry.score+"/6");
  log("📓 Logged "+entry.sym+" to journal · $"+entry.price.toFixed(2)+" · "+entry.score+"/6","ok");
}

function addManualEntry(){
  const symEl   = document.getElementById("jnl-sym-input");
  const priceEl = document.getElementById("jnl-price-input");
  const stopEl  = document.getElementById("jnl-stop-input");
  const t1El    = document.getElementById("jnl-t1-input");
  const t2El    = document.getElementById("jnl-t2-input");
  const typeEl  = document.getElementById("jnl-type-input");
  const sym     = symEl?.value.trim().toUpperCase();
  const price   = parseFloat(priceEl?.value);
  if(!sym){ symEl?.focus(); return; }
  if(isNaN(price)||price<=0){ priceEl?.focus(); return; }
  const stopLoss  = parseFloat(stopEl?.value)||"";
  const target1   = parseFloat(t1El?.value)||"";
  const target2   = parseFloat(t2El?.value)||"";
  const tradeType = typeEl?.value||"";
  const entryMode = document.getElementById("jnl-entry-mode")?.value || "tracking";
  logToJournal({sym, price, score:"?", source:"manual",
    session:getMarketSession(), stopLoss, target1, target2, tradeType, entryMode});
  [symEl,priceEl,stopEl,t1El,t2El].forEach(el=>{ if(el) el.value=""; });
  if(typeEl) typeEl.value="";
  symEl?.focus();
}

function updateResult(id, val){
  const entry = journalEntries.find(e=>e.id===id);
  if(!entry) return;
  const pct = parseFloat(val);
  if(!isNaN(pct)){
    entry.result = pct;
    entry.status = pct > 0 ? "win" : pct < 0 ? "loss" : "loss";
  } else {
    entry.result = val;
    // Don't overwrite status — keep whatever it was
  }
  saveJournal();
  renderJournal();
}

function updateField(id, field, val){
  const entry = journalEntries.find(e=>e.id===id);
  if(!entry) return;
  entry[field] = val;
  saveJournal();
  renderJournal();
}

function deleteEntry(id){
  journalEntries = journalEntries.filter(e=>e.id!==id);
  saveJournal();
  renderJournal();
}

function clearJournal(){
  if(!confirm("Clear entire journal? This cannot be undone.")) return;
  journalEntries = [];
  try{
    localStorage.setItem("cs_journal", JSON.stringify([]));
    localStorage.setItem("cs_journal_cleared", new Date().toISOString());
  }catch(e){}
  if(window.firebaseReady){
    fbSafeSave("journal", []);
    fbSafeSave("journal_cleared", {time: new Date().toISOString()});
  }
  renderJournal();
  showToast("📓 Journal cleared on all devices");
}

let jnlModeFilter = "all";
function setJnlFilter(mode, btn){
  jnlModeFilter = mode;
  document.querySelectorAll('[id^="jnl-filter-"]').forEach(b=>b.classList.remove("on"));
  if(btn) btn.classList.add("on");
  renderJournal();
}

function renderJournal(){
  const body = document.getElementById("jnl-body");
  if(!body) return;
  const jnlSearch = (document.getElementById("jnl-search")?.value||"").toUpperCase().trim();

  // Stats
  // Stats only on REAL TRADES for accuracy
  // Include all entries in stats — entryMode filter only affects display
  const tradeEntries = journalEntries; // show stats for all entries
  const allClosed = journalEntries.filter(e=>e.status==="win"||e.status==="loss");
  const closed = allClosed;
  const wins   = journalEntries.filter(e=>e.status==="win");
  const losses = journalEntries.filter(e=>e.status==="loss");
  const winRate = closed.length ? Math.round(wins.length/closed.length*100) : null;
  const avgWin  = wins.length  ? (wins.reduce((a,e)=>a+parseFloat(e.result||0),0)/wins.length).toFixed(1)   : null;
  const avgLoss = losses.length? (losses.reduce((a,e)=>a+parseFloat(e.result||0),0)/losses.length).toFixed(1) : null;

  const realTrades = journalEntries.filter(e=>e.entryMode==="trade").length;
  const tracking   = journalEntries.filter(e=>e.entryMode!=="trade"&&e.entryMode!==undefined).length;
  // Show total/closed — if no entryMode distinction, just show total
  const totalDisplay = realTrades > 0
    ? realTrades+"/"+journalEntries.length
    : journalEntries.length;
  document.getElementById("jnl-total").textContent   = totalDisplay;
  document.getElementById("jnl-wins").textContent     = wins.length;
  document.getElementById("jnl-losses").textContent   = losses.length;
  document.getElementById("jnl-winrate").textContent  = winRate!==null ? winRate+"%" : "—";
  document.getElementById("jnl-avgwin").textContent   = avgWin  ? "+"+avgWin+"%" : "—";
  document.getElementById("jnl-avgloss").textContent  = avgLoss ? avgLoss+"%" : "—";

  // ── Source breakdown ──────────────────────────────────────────────────
  const sourceMap = {};
  journalEntries.forEach(e=>{
    const src = e.source||"manual";
    if(!sourceMap[src]) sourceMap[src]={wins:0,losses:0,total:0,avgWin:0,avgLoss:0,wSum:0,lSum:0};
    sourceMap[src].total++;
    if(e.status==="win"){ sourceMap[src].wins++; sourceMap[src].wSum+=parseFloat(e.result||0); }
    if(e.status==="loss"){ sourceMap[src].losses++; sourceMap[src].lSum+=parseFloat(e.result||0); }
  });

  const srcLabels = {
    recovery:"📈 Recovery", catalyst:"⚡ Catalyst", jax:"🟢 JAX",
    confluence:"⚡ Confluence", weekly:"📅 Weekly", pulse:"🔔 Pulse", manual:"✏️ Manual"
  };
  const srcOrder = ["weekly","confluence","jax","recovery","catalyst","pulse","manual"];
  const breakdown = document.getElementById("jnl-breakdown");
  const grid      = document.getElementById("jnl-source-grid");

  if(grid && Object.keys(sourceMap).length > 1){
    const sorted = srcOrder.filter(s=>sourceMap[s]).concat(
      Object.keys(sourceMap).filter(s=>!srcOrder.includes(s))
    );
    const bestWR = Math.max(...sorted.map(s=>{
      const sm = sourceMap[s];
      const closed = sm.wins+sm.losses;
      return closed>0 ? Math.round(sm.wins/closed*100) : 0;
    }));

    grid.innerHTML = sorted.map(src=>{
      const sm     = sourceMap[src];
      const closed = sm.wins + sm.losses;
      const wr     = closed>0 ? Math.round(sm.wins/closed*100) : null;
      const avgW   = sm.wins>0   ? (sm.wSum/sm.wins).toFixed(1) : null;
      const avgL   = sm.losses>0 ? (sm.lSum/sm.losses).toFixed(1) : null;
      const wrClr  = wr===null?"var(--muted)":wr>=70?"var(--green2)":wr>=50?"var(--yellow)":"var(--red)";
      const isTop  = wr === bestWR && wr !== null && closed >= 3;
      return `<div class="jnl-source-card${isTop?" top":""}">
        <div class="jnl-src-name">${srcLabels[src]||src}</div>
        <div class="jnl-src-wr" style="color:${wrClr}">${wr!==null?wr+"%":"—"}</div>
        <div class="jnl-src-detail">${sm.wins}W / ${sm.losses}L / ${sm.total-closed} open</div>
        <div class="jnl-src-detail">${avgW?"+"+avgW+"%":""} ${avgL?avgL+"%":""}</div>
      </div>`;
    }).join("");

    if(breakdown) breakdown.style.display = "block";
  } else {
    if(breakdown) breakdown.style.display = "none";
  }

  const filteredEntries = journalEntries
    .filter(e=> jnlModeFilter==="all" ? true :
                jnlModeFilter==="trade" ? e.entryMode==="trade" :
                (e.entryMode==="tracking"||!e.entryMode))
    .filter(e=> jnlSearch ? e.sym.includes(jnlSearch) : true);

  if(!journalEntries.length){
    body.innerHTML = `<tr><td colspan="9" class="jnl-empty">
      <span style="font-size:24px;display:block;margin-bottom:8px">📓</span>
      No entries yet — click LOG on any screener card<br>
      <span style="font-size:8px;color:var(--muted)">Every flagged stock gets logged with price, score, and source</span>
    </td></tr>`;
    return;
  }

  body.innerHTML = filteredEntries.map(e=>{
    const resultPct = parseFloat(e.result);
    const hasResult = !isNaN(resultPct) && e.result!=="";
    const resultColor = hasResult ? (resultPct>0?"var(--green2)":resultPct<0?"var(--red)":"var(--muted)") : "var(--muted)";
    const rowCls = e.status==="win"?"win":e.status==="loss"?"loss":"open";
    const scoreBg = e.score>=6?"var(--green2)":e.score>=5?"var(--yellow)":e.score>=4?"var(--orange)":"var(--muted)";
    const scoreColor = e.score>=5?"#000":"#fff";
    // Risk:Reward calculation
    const ep = parseFloat(e.price)||0;
    const sl = parseFloat(e.stopLoss)||0;
    const t1 = parseFloat(e.target1)||0;
    const risk    = sl>0&&ep>0 ? ep-sl : 0;
    const reward  = t1>0&&ep>0 ? t1-ep : 0;
    const rrRatio = risk>0&&reward>0 ? (reward/risk).toFixed(1)+"R" : "—";
    const rrColor = risk>0&&reward>0 ? (reward/risk>=2?"var(--green2)":reward/risk>=1?"var(--yellow)":"var(--red)") : "var(--muted)";
    // Type badge
    const typeBg = e.tradeType==="Catalyst"?"rgba(255,109,0,0.15)":e.tradeType==="Deep Bounce"?"rgba(0,176,255,0.15)":e.tradeType==="Swing"?"rgba(0,200,83,0.12)":"var(--bg3)";
    const typeColor = e.tradeType==="Catalyst"?"var(--orange)":e.tradeType==="Deep Bounce"?"var(--blue)":e.tradeType==="Swing"?"var(--green2)":"var(--muted)";
    return `<tr class="${rowCls}">
      <td style="color:var(--muted2);white-space:nowrap">${e.date}</td>
      <td>
        <span class="jnl-sym" style="cursor:pointer" onclick="window.open('https://www.tradingview.com/chart/?symbol=${e.sym}','_blank')">${e.sym}</span>
        ${e.greenArrow?'<span class="badge jax" style="font-size:7px;padding:1px 4px;margin-left:4px">🟢</span>':''}
        <span style="font-size:7px;padding:1px 5px;border-radius:1px;margin-left:3px;
          background:${e.entryMode==="trade"?"rgba(0,200,83,0.15)":"rgba(100,100,100,0.15)"};
          color:${e.entryMode==="trade"?"var(--green2)":"var(--muted2)"};
          border:1px solid ${e.entryMode==="trade"?"rgba(0,200,83,0.3)":"rgba(100,100,100,0.2)"}">
          ${e.entryMode==="trade"?"💰 TRADE":"📊 TRACK"}
        </span>
        <select onchange="updateField(${e.id},'entryMode',this.value);renderJournal()" 
          style="font-size:7px;background:transparent;border:none;color:var(--muted);cursor:pointer">
          <option value="">▾</option>
          <option value="tracking">📊 Tracking</option>
          <option value="trade">💰 Real Trade</option>
        </select>
      </td>
      <td>
        ${e.tradeType?`<span style="font-size:8px;padding:1px 6px;border-radius:1px;background:${typeBg};color:${typeColor}">${e.tradeType}</span>`:"<span style='color:var(--muted);font-size:8px'>—</span>"}
        <select onchange="updateField(${e.id},'tradeType',this.value)" style="font-size:8px;background:transparent;border:none;color:var(--muted);cursor:pointer;margin-left:2px">
          <option value="">edit</option>
          <option value="Catalyst">⚡ Catalyst</option>
          <option value="Deep Bounce">📉 Deep Bounce</option>
          <option value="Swing">📈 Swing</option>
          <option value="Watchlist">👀 Watchlist</option>
        </select>
      </td>
      <td style="font-weight:700">$${ep.toFixed(2)}</td>
      <td>
        ${sl>0?`<span style="color:var(--red);font-size:10px">$${sl.toFixed(2)}</span>`:""}
        <input class="jnl-result-input" type="number" value="${e.stopLoss||''}" placeholder="stop"
          onchange="updateField(${e.id},'stopLoss',parseFloat(this.value)||'')"
          style="width:65px;color:var(--red);border-color:rgba(255,23,68,0.2);${sl>0?'display:none':''}">
      </td>
      <td>
        ${t1>0?`<span style="color:var(--green2);font-size:10px">$${t1.toFixed(2)}</span><br><span style="font-size:8px;color:var(--muted)">(+${((t1-ep)/ep*100).toFixed(1)}%)</span>`:""}
        <input class="jnl-result-input" type="number" value="${e.target1||''}" placeholder="T1"
          onchange="updateField(${e.id},'target1',parseFloat(this.value)||'')"
          style="width:65px;color:var(--green2);border-color:rgba(0,200,83,0.2);${t1>0?'display:none':''}">
      </td>
      <td>
        ${parseFloat(e.target2||0)>0?`<span style="color:#64DD17;font-size:10px">$${parseFloat(e.target2).toFixed(2)}</span>`:""}
        <input class="jnl-result-input" type="number" value="${e.target2||''}" placeholder="T2"
          onchange="updateField(${e.id},'target2',parseFloat(this.value)||'')"
          style="width:65px;color:#64DD17;border-color:rgba(100,221,23,0.2);${parseFloat(e.target2||0)>0?'display:none':''}">
      </td>
      <td style="color:${e.closePrice?(parseFloat(e.closePrice)>ep?"var(--green2)":parseFloat(e.closePrice)<ep?"var(--red)":"var(--muted)"):"var(--muted)"}">
        ${e.closePrice?"$"+parseFloat(e.closePrice).toFixed(2)+(Math.abs(parseFloat(e.result||0))<0.01?" (flat)":""):"—"}
      </td>
      <td><span class="jnl-score" style="background:${scoreBg};color:${scoreColor}">${e.score}/6</span></td>
      <td><span class="jnl-source">${e.source}</span></td>
      <td style="color:var(--muted2);font-size:9px">${e.session==="premarket"?"🌅 6AM":e.session==="open"?"🟢 9:45AM":e.session==="manual"?"📊 Manual":"—"}</td>
      <td>
        <input class="jnl-result-input" type="text" 
          value="${e.result}" 
          placeholder="e.g. +10.5"
          onchange="updateResult(${e.id}, this.value)"
          style="color:${resultColor}">
      </td>
      <td><span style="color:${rrColor};font-size:10px;font-weight:700">${rrRatio}</span></td>
      <td>
        <span class="jnl-pct" style="color:${resultColor}">
          ${hasResult?(resultPct>0?"▲ +":"▼ ")+Math.abs(resultPct).toFixed(1)+"%":e.status==="open"?"⏳ OPEN":"—"}
        </span>
      </td>
      <td>
        <button class="jnl-del" onclick="deleteEntry(${e.id})" title="Delete">×</button>
      </td>
    </tr>`;
  }).join("");
}

// ── Auto-fetch closing prices at 4:15pm ET ───────────────────────────────────
let closeAutoTimer = null;

async function fetchClosingPrices(){
  const openEntries = journalEntries.filter(e=>(e.status==="open"||e.status==="tracking") && e.price > 0);
  if(!openEntries.length){ log("Journal: no open entries to update","info"); return; }
  log("📓 Fetching prices for "+openEntries.length+" entries...","info");
  for(const entry of openEntries){
    try{
      const q = await fetchLiveQuote(entry.sym);
      if(q && q.price > 0){
        const entryPrice = parseFloat(entry.price);
        const closePrice = q.price;
        const resultPct  = ((closePrice - entryPrice) / entryPrice * 100);
        entry.closePrice = closePrice;
        entry.closedAt   = new Date().toISOString();
        if(Math.abs(resultPct) >= 0.01){
          entry.result = resultPct.toFixed(2);
          if(entry.status === "open") entry.status = resultPct >= 0 ? "win" : "loss";
        } else {
          entry.closePrice = closePrice;
          if(entry.status !== "tracking") entry.status = "open";
        }
        log("📓 "+entry.sym+" → $"+closePrice.toFixed(2)+" · "+(Math.abs(resultPct)<0.01?"flat (holiday?)":(resultPct>=0?"+":"")+resultPct.toFixed(2)+"%"),"ok");
      }
    }catch(e){ log("📓 "+entry.sym+": could not fetch price","warn"); }
    await sleep(300);
  }
  saveJournal();
  renderJournal();
  log("📓 Prices updated for "+openEntries.length+" entries","ok");
  const wins   = journalEntries.filter(e=>e.status==="win").length;
  const losses = journalEntries.filter(e=>e.status==="loss").length;
  sendNotification("📓 Journal Updated","wins "+wins+" · losses "+losses,"journal");
}

function startCloseAutoTimer(){
  if(closeAutoTimer) clearInterval(closeAutoTimer);
  closeAutoTimer = setInterval(()=>{
    const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const h = et.getHours(), m = et.getMinutes(), day = et.getDay();
    // 4:15pm ET on weekdays only
    if(day > 0 && day < 6 && h === 16 && m === 15){
      log("⏰ 4:15 PM ET — auto-fetching closing prices...","info");
      fetchClosingPrices();
    }
  }, 60000);
}

// Start the auto-close timer when page loads
startCloseAutoTimer();
