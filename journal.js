// ── journal.js ────────────────────────────────────────────────────────────────
// Trade Journal — Options-first schema, archive, calibration feedback
// v2.0 — options fields, archive legacy entries, status bug fix
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════
// TRADE JOURNAL
// ══════════════════════════════════════════════════════════

let journalEntries = [];
const CALIBRATION_THRESHOLD = 30; // min closed trades before scoring adjustments activate

// ── Archive legacy stock entries and start fresh ──────────────────────────────
async function archiveLegacyJournal(){
  if(!window.firebaseReady) return;
  const existing = journalEntries;
  if(!existing.length) return;

  // Check if already archived
  const alreadyArchived = localStorage.getItem("cs_journal_archived_v2");
  if(alreadyArchived) return;

  // Any entry without optionContract field = legacy stock entry
  const legacy = existing.filter(e => !e.optionContract && !e._isOptions);
  if(!legacy.length) return;

  try{
    // Save to archive node in Firebase
    await window.fbSave("journal_archive", {
      entries: legacy,
      archivedAt: new Date().toISOString(),
      reason: "Transition to options tracking v2",
      count: legacy.length
    });
    // Clear active journal
    journalEntries = [];
    localStorage.setItem("cs_journal", JSON.stringify([]));
    localStorage.setItem("cs_journal_archived_v2", new Date().toISOString());
    // Do NOT push [] to Firebase — that triggers a clear on all listening devices
    // The archive is stored in journal_archive, active journal stays untouched in Firebase
    renderJournal();
    showToast(`📦 ${legacy.length} legacy entries archived — fresh start for options tracking`);
    console.log(`✅ Archived ${legacy.length} legacy journal entries to screener/journal_archive`);
  }catch(e){
    console.warn("Archive failed:", e);
  }
}

// ── Load journal ──────────────────────────────────────────────────────────────
function loadJournal(){
  try{
    const saved = localStorage.getItem("cs_journal");
    if(saved) journalEntries = JSON.parse(saved);
  }catch(e){ journalEntries = []; }

  const _doJournalFirebase = async()=>{
    try{
      const fb = await window.fbLoad("journal");
      if(fb && fb.data && fb.data.length >= journalEntries.length){
        journalEntries = fb.data;
        localStorage.setItem("cs_journal", JSON.stringify(journalEntries));
      }
      // Archive legacy entries on first load
      await archiveLegacyJournal();

      window.fbListen("journal", (fb)=>{
        if(fb.data === undefined || fb.data === null) return;
        const fbData    = Array.isArray(fb.data) ? fb.data : [];
        const fbSavedAt = new Date(fb.savedAt||0).getTime();
        const localClearedStr = localStorage.getItem("cs_journal_cleared");
        const localCleared    = localClearedStr ? new Date(localClearedStr).getTime() : 0;

        // Never overwrite local entries with empty array
        // unless a deliberate user clear happened after the last local save
        if(fbData.length === 0){
          const deliberateClear = localCleared > 0 && localCleared >= fbSavedAt - 5000;
          if(!deliberateClear){
            console.log("📓 Ignoring empty Firebase journal — keeping local entries");
            return;
          }
          journalEntries = [];
          localStorage.setItem("cs_journal", JSON.stringify([]));
          renderJournal();
          showToast("📓 Journal cleared");
          return;
        }

        // Only overwrite local if Firebase has MORE entries or is meaningfully newer
        const localSavedStr = localStorage.getItem("cs_journal_saved_at");
        const localSavedAt  = localSavedStr ? new Date(localSavedStr).getTime() : 0;
        if(fbData.length > journalEntries.length || fbSavedAt > localSavedAt + 2000){
          journalEntries = fbData;
          localStorage.setItem("cs_journal", JSON.stringify(journalEntries));
          renderJournal();
        }
      });
    }catch(e){}
  };
  if(window.firebaseReady){ _doJournalFirebase(); }
  else { document.addEventListener("firebaseReady", _doJournalFirebase, {once:true}); }
  renderJournal();
}

// ── Save journal ──────────────────────────────────────────────────────────────
function saveJournal(){
  // Fix status bug: any entry with closePrice + result but still "tracking" → flip to win/loss
  journalEntries.forEach(e=>{
    if(e.status === "tracking" && e.closePrice && e.result !== ""){
      const pct = parseFloat(e.result);
      if(!isNaN(pct) && Math.abs(pct) >= 0.01){
        e.status = pct >= 0 ? "win" : "loss";
      }
    }
  });
  try{
    localStorage.setItem("cs_journal", JSON.stringify(journalEntries));
    localStorage.setItem("cs_journal_saved_at", new Date().toISOString());
  }catch(e){}
  fbSafeSave("journal", journalEntries);
  const el = document.getElementById("jnl-last-update");
  if(el) el.textContent = "last updated " + new Date().toLocaleTimeString();
}

// ── DTE calculator ────────────────────────────────────────────────────────────
function calcDTE(expiryStr){
  if(!expiryStr) return null;
  try{
    const expiry = new Date(expiryStr);
    const today  = new Date();
    const diff   = Math.ceil((expiry - today) / (1000*60*60*24));
    return Math.max(0, diff);
  }catch(e){ return null; }
}

// ── Log to journal (called from Morning Brief LOG button) ─────────────────────
function logToJournal(entry){
  const today = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"2-digit"});

  // No duplicates: same ticker + same date = update
  const existing = journalEntries.find(e=>e.sym===entry.sym && e.date===today);
  if(existing){
    const oldPrice = parseFloat(existing.price).toFixed(2);
    const newPrice = parseFloat(entry.price).toFixed(2);
    // If coming from LOG THIS STRIKE — update options fields even if ticker already logged
    if(entry.optionStrike){
      existing._isOptions    = true;
      existing.strike        = entry.optionStrike;
      existing.expiry        = entry.optionExpiry || "";
      existing.dte           = entry.optionDTE    || null;
      existing.premiumPaid   = entry.premiumPaid  || "";
      existing.contracts     = entry.contracts    || 1;
      existing.optionType    = "call";
      existing.optionContract= `${entry.sym} $${entry.optionStrike}C ${entry.optionExpiry||""}`;
      existing.totalCost     = entry.premiumPaid && entry.contracts
        ? (parseFloat(entry.premiumPaid)*(parseInt(entry.contracts)||1)*100).toFixed(2) : "";
      saveJournal(); renderJournal();
      showToast(`📓 ${entry.sym} $${entry.optionStrike}C updated in journal`);
      return;
    }
    if(oldPrice !== newPrice){
      existing.price = entry.price;
      existing.score = entry.score;
      existing.greenArrow = entry.greenArrow||false;
      saveJournal(); renderJournal();
      showToast("📓 "+entry.sym+" updated · $"+entry.price.toFixed(2));
    } else {
      showToast("⚠ "+entry.sym+" already logged today — open journal to add option details");
    }
    return;
  }

  // Build option contract string if strike data provided
  const hasOption   = !!entry.optionStrike;
  const optContract = hasOption ? `${entry.sym} $${entry.optionStrike}C ${entry.optionExpiry||""}` : "";
  const totalCost   = hasOption && entry.premiumPaid && entry.contracts
    ? (parseFloat(entry.premiumPaid)*(parseInt(entry.contracts)||1)*100).toFixed(2) : "";

  const id = Date.now();
  journalEntries.unshift({
    id, date: today,
    sym:          entry.sym,
    price:        entry.price,
    score:        entry.score || "?",
    source:       entry.source || "manual",
    session:      entry.session || getMarketSession(),
    greenArrow:   entry.greenArrow || false,
    tradeType:    entry.tradeType || "Swing",
    entryMode:    entry.entryMode || "tracking",
    stopLoss:     entry.stopLoss || "",
    target1:      entry.target1 || "",
    target2:      entry.target2 || "",
    notes:        entry.notes || "",
    // ── Options fields — auto-filled from LOG THIS STRIKE ──
    _isOptions:     hasOption,
    optionContract: optContract,
    optionType:     hasOption ? "call" : "",
    strike:         entry.optionStrike  || "",
    expiry:         entry.optionExpiry  || "",
    dte:            entry.optionDTE     || null,
    premiumPaid:    entry.premiumPaid   || "",
    premiumSold:    "",
    contracts:      entry.contracts     || 1,
    totalCost:      totalCost,
    optionResult:   "",
    result:         "",
    status:         "tracking",
    loggedAt:       new Date().toISOString()
  });
  saveJournal(); renderJournal();
  if(hasOption){
    showToast(`📓 ${entry.sym} $${entry.optionStrike}C logged · ${entry.optionDTE}DTE · $${totalCost} cost`);
    log(`📓 Logged ${entry.sym} $${entry.optionStrike}C · ${entry.optionDTE}DTE · cost $${totalCost}`,"ok");
  } else {
    showToast("📓 "+entry.sym+" logged · tap to add option details");
    log("📓 Logged "+entry.sym+" · underlying $"+parseFloat(entry.price).toFixed(2)+" · add option details in journal","ok");
  }
}

// ── Add manual entry from journal form ───────────────────────────────────────
function addManualEntry(){
  const sym      = document.getElementById("jnl-sym-input")?.value.trim().toUpperCase();
  const price    = parseFloat(document.getElementById("jnl-price-input")?.value);
  const stop     = parseFloat(document.getElementById("jnl-stop-input")?.value)||"";
  const t1       = parseFloat(document.getElementById("jnl-t1-input")?.value)||"";
  const t2       = parseFloat(document.getElementById("jnl-t2-input")?.value)||"";
  const type     = document.getElementById("jnl-type-input")?.value||"";
  const mode     = document.getElementById("jnl-entry-mode")?.value||"tracking";
  // Options fields from manual form
  const optType  = document.getElementById("jnl-opt-type")?.value||"";
  const strike   = document.getElementById("jnl-opt-strike")?.value||"";
  const expiry   = document.getElementById("jnl-opt-expiry")?.value||"";
  const premium  = parseFloat(document.getElementById("jnl-opt-premium")?.value)||"";
  const contracts= parseInt(document.getElementById("jnl-opt-contracts")?.value)||1;

  if(!sym){ document.getElementById("jnl-sym-input")?.focus(); return; }
  if(isNaN(price)||price<=0){ document.getElementById("jnl-price-input")?.focus(); return; }

  const dte = calcDTE(expiry);
  const totalCost = premium && contracts ? (parseFloat(premium)*contracts*100).toFixed(2) : "";
  const contract  = sym && strike && optType && expiry
    ? `${sym} $${strike}${optType==="call"?"C":"P"} ${expiry.slice(5).replace("-","/")}` : "";

  const id = Date.now();
  const today = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"2-digit"});
  journalEntries.unshift({
    id, date: today, sym, price,
    score: "?", source: "manual",
    session: getMarketSession(),
    greenArrow: false,
    tradeType: type, entryMode: mode,
    stopLoss: stop, target1: t1, target2: t2,
    notes: "",
    _isOptions:     !!optType,
    optionContract: contract,
    optionType:     optType,
    strike, expiry, dte,
    premiumPaid:    premium,
    premiumSold:    "",
    contracts,
    totalCost,
    optionResult:   "",
    result: "", status: "tracking",
    loggedAt: new Date().toISOString()
  });
  saveJournal(); renderJournal();
  ["jnl-sym-input","jnl-price-input","jnl-stop-input","jnl-t1-input","jnl-t2-input",
   "jnl-opt-strike","jnl-opt-expiry","jnl-opt-premium","jnl-opt-contracts"]
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=""; });
  document.getElementById("jnl-sym-input")?.focus();
}

// ── Update option details inline ──────────────────────────────────────────────
function updateOptionField(id, field, val){
  const entry = journalEntries.find(e=>e.id===id);
  if(!entry) return;
  entry[field] = val;

  // Auto-calculate derived fields
  if(field === "expiry")  entry.dte = calcDTE(val);
  if(field === "premiumPaid" || field === "contracts"){
    const p = parseFloat(entry.premiumPaid)||0;
    const c = parseInt(entry.contracts)||1;
    entry.totalCost = p && c ? (p*c*100).toFixed(2) : "";
    entry._isOptions = !!p;
  }
  if(field === "premiumSold"){
    const bought = parseFloat(entry.premiumPaid)||0;
    const sold   = parseFloat(val)||0;
    if(bought > 0 && sold > 0){
      const pct = ((sold - bought) / bought * 100);
      entry.optionResult = pct.toFixed(2);
      entry.result       = pct.toFixed(2);  // keep result in sync
      entry.status       = pct >= 0 ? "win" : "loss";
    }
  }
  // Auto-build contract string
  if(["sym","strike","optionType","expiry"].includes(field)){
    const s = entry.sym||"";
    const k = entry.strike||"";
    const t = entry.optionType||"";
    const x = entry.expiry||"";
    entry.optionContract = s&&k&&t&&x
      ? `${s} $${k}${t==="call"?"C":"P"} ${x.slice(5).replace("-","/")}` : "";
  }
  saveJournal(); renderJournal();
}

// ── Update result ─────────────────────────────────────────────────────────────
function updateResult(id, val){
  const entry = journalEntries.find(e=>e.id===id);
  if(!entry) return;
  const pct = parseFloat(val);
  if(!isNaN(pct)){
    entry.result = pct;
    entry.status = pct > 0 ? "win" : "loss";
    if(entry._isOptions) entry.optionResult = pct.toFixed(2);
  } else {
    entry.result = val;
  }
  saveJournal(); renderJournal();
}

function updateField(id, field, val){
  const entry = journalEntries.find(e=>e.id===id);
  if(!entry) return;
  entry[field] = val;
  saveJournal(); renderJournal();
}

function deleteEntry(id){
  journalEntries = journalEntries.filter(e=>e.id!==id);
  saveJournal(); renderJournal();
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

// ── Calibration data builder ──────────────────────────────────────────────────
// Reads closed options trades → builds scoring calibration object
// Written to Firebase so Morning Brief can use it
async function buildCalibration(){
  const closed = journalEntries.filter(e=>
    (e.status==="win"||e.status==="loss") && e._isOptions && e.optionResult!==""
  );
  if(closed.length < CALIBRATION_THRESHOLD){
    console.log(`📊 Calibration: ${closed.length}/${CALIBRATION_THRESHOLD} trades needed`);
    return null;
  }

  const bySource = {}, bySetup = {}, byDTE = {};

  closed.forEach(e=>{
    const pct = parseFloat(e.optionResult||e.result)||0;
    const isWin = pct > 0;
    // By source
    const src = e.source||"manual";
    if(!bySource[src]) bySource[src] = {wins:0,total:0,avgPct:0,pcts:[]};
    bySource[src].total++;
    if(isWin) bySource[src].wins++;
    bySource[src].pcts.push(pct);
    // By DTE bucket
    const dte = e.dte||0;
    const dteBucket = dte <= 14?"0-14DTE": dte <= 30?"15-30DTE": dte <= 45?"31-45DTE":"45+DTE";
    if(!byDTE[dteBucket]) byDTE[dteBucket] = {wins:0,total:0,pcts:[]};
    byDTE[dteBucket].total++;
    if(isWin) byDTE[dteBucket].wins++;
    byDTE[dteBucket].pcts.push(pct);
    // By option type
    if(!bySetup[e.optionType||"unknown"]) bySetup[e.optionType||"unknown"] = {wins:0,total:0,pcts:[]};
    bySetup[e.optionType||"unknown"].total++;
    if(isWin) bySetup[e.optionType||"unknown"].wins++;
    bySetup[e.optionType||"unknown"].pcts.push(pct);
  });

  // Calculate win rates and avg returns
  const calcStats = (obj) => {
    Object.keys(obj).forEach(k=>{
      const d = obj[k];
      d.winRate = d.total > 0 ? Math.round(d.wins/d.total*100) : 0;
      d.avgPct  = d.pcts.length ? (d.pcts.reduce((a,b)=>a+b,0)/d.pcts.length).toFixed(1) : 0;
      delete d.pcts;
    });
    return obj;
  };

  const calibration = {
    bySource:     calcStats(bySource),
    byDTE:        calcStats(byDTE),
    bySetup:      calcStats(bySetup),
    sampleSize:   closed.length,
    lastUpdated:  new Date().toISOString(),
    active:       closed.length >= CALIBRATION_THRESHOLD
  };

  // Write to Firebase for Morning Brief to read
  await window.fbSave("calibration", calibration);
  console.log("✅ Calibration written:", calibration);
  return calibration;
}

// ── Filter + search state ─────────────────────────────────────────────────────
let jnlModeFilter = "all";
let jnlSearch = "";

function setJnlFilter(mode, btn){
  jnlModeFilter = mode;
  document.querySelectorAll(".jnl-filter-btn").forEach(b=>b.classList.remove("active"));
  if(btn) btn.classList.add("active");
  renderJournal();
}

// ── $1k Goal Dashboard ────────────────────────────────────────────────────────
const MONTHLY_GOAL = 1000;

function renderDashboard(trades, closed, wins, losses, totalPnL){
  const el = document.getElementById("jnl-dashboard");
  if(!el) return;

  // Month progress
  const now       = new Date();
  const daysInMo  = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const dayOfMo   = now.getDate();
  const daysPct   = Math.round(dayOfMo / daysInMo * 100);

  // P&L progress toward goal
  const goalPct   = Math.min(100, Math.round(Math.max(0, totalPnL) / MONTHLY_GOAL * 100));
  const remaining = Math.max(0, MONTHLY_GOAL - totalPnL);
  const onPace    = totalPnL > 0 ? (totalPnL / dayOfMo * daysInMo) : 0;
  const paceClr   = onPace >= MONTHLY_GOAL ? "var(--green2)" : onPace >= MONTHLY_GOAL * 0.7 ? "var(--yellow)" : "var(--red)";

  // Win rate
  const wr        = closed.length ? Math.round(wins.length / closed.length * 100) : null;
  const wrClr     = wr >= 60 ? "var(--green2)" : wr >= 50 ? "var(--yellow)" : "var(--red)";

  // Trades needed to hit goal (rough estimate based on avg win)
  const getResult = e => parseFloat(e.optionResult||e.result||0);
  const avgWinDollar = wins.length
    ? wins.reduce((a,e)=>{ const r=getResult(e)/100; const cost=(parseFloat(e.premiumPaid)||0)*(parseInt(e.contracts)||1)*100; return a+(cost*r); },0) / wins.length
    : 0;
  const tradesNeeded = avgWinDollar > 0 ? Math.ceil(remaining / avgWinDollar) : "—";

  // Month label
  const monthName = now.toLocaleString("en-US", {month:"long"});

  el.innerHTML = `
    <div style="padding:14px 18px 10px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-family:var(--mono);font-size:11px;color:var(--green2);letter-spacing:.05em">🎯 ${monthName} Goal — $${MONTHLY_GOAL.toLocaleString()}</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--muted2)">Day ${dayOfMo} of ${daysInMo}</div>
      </div>

      <!-- Goal progress bar -->
      <div style="background:var(--bg3);border-radius:3px;height:8px;margin-bottom:4px;overflow:hidden">
        <div style="height:100%;width:${goalPct}%;background:${goalPct>=100?"var(--green2)":goalPct>=60?"var(--yellow)":"var(--blue)"};border-radius:3px;transition:width .4s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--muted2);margin-bottom:12px">
        <span style="color:${totalPnL>0?"var(--green2)":totalPnL<0?"var(--red)":"var(--muted2)"}">${totalPnL>0?"+$":"−$"}${Math.abs(totalPnL).toFixed(0)} earned</span>
        <span>${goalPct}% of goal</span>
        <span style="color:var(--muted2)">$${remaining.toFixed(0)} to go</span>
      </div>

      <!-- Time progress bar -->
      <div style="background:var(--bg3);border-radius:3px;height:4px;margin-bottom:4px;overflow:hidden">
        <div style="height:100%;width:${daysPct}%;background:var(--border2);border-radius:3px"></div>
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--muted2);margin-bottom:12px">
        ${daysPct}% of month elapsed
      </div>

      <!-- Key metrics row -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        <div style="background:var(--bg3);border-radius:3px;padding:8px 10px;text-align:center">
          <div style="font-family:var(--mono);font-size:14px;font-weight:500;color:${paceClr}">$${Math.round(onPace).toLocaleString()}</div>
          <div style="font-size:9px;color:var(--muted2);margin-top:2px">projected</div>
        </div>
        <div style="background:var(--bg3);border-radius:3px;padding:8px 10px;text-align:center">
          <div style="font-family:var(--mono);font-size:14px;font-weight:500;color:${wrClr}">${wr!==null?wr+"%":"—"}</div>
          <div style="font-size:9px;color:var(--muted2);margin-top:2px">win rate</div>
        </div>
        <div style="background:var(--bg3);border-radius:3px;padding:8px 10px;text-align:center">
          <div style="font-family:var(--mono);font-size:14px;font-weight:500;color:var(--text)">${closed.length}</div>
          <div style="font-size:9px;color:var(--muted2);margin-top:2px">closed</div>
        </div>
        <div style="background:var(--bg3);border-radius:3px;padding:8px 10px;text-align:center">
          <div style="font-family:var(--mono);font-size:14px;font-weight:500;color:var(--yellow)">${tradesNeeded}</div>
          <div style="font-size:9px;color:var(--muted2);margin-top:2px">trades left</div>
        </div>
      </div>
    </div>`;
}

// ── Render journal ────────────────────────────────────────────────────────────
function renderJournal(){
  const body      = document.getElementById("jnl-body");
  const statsEl   = document.getElementById("jnl-stats");
  const breakdown = document.getElementById("jnl-breakdown");
  if(!body) return;

  jnlSearch = (document.getElementById("jnl-search")?.value||"").toUpperCase();

  // ── Stats ──────────────────────────────────────────────────────────────────
  const all     = journalEntries;
  const trades  = all.filter(e=>e.entryMode==="trade");
  const closed  = trades.filter(e=>e.status==="win"||e.status==="loss");
  const wins    = trades.filter(e=>e.status==="win");
  const losses  = trades.filter(e=>e.status==="loss");
  const open    = all.filter(e=>e.status==="open"||e.status==="tracking");

  // Use optionResult if available, else result
  const getResult = e => parseFloat(e.optionResult||e.result||0);
  const wr      = closed.length ? Math.round(wins.length/closed.length*100) : null;
  const avgWin  = wins.length   ? (wins.reduce((a,e)=>a+getResult(e),0)/wins.length).toFixed(1) : null;
  const avgLoss = losses.length ? (losses.reduce((a,e)=>a+getResult(e),0)/losses.length).toFixed(1) : null;
  const expect  = wr&&avgWin&&avgLoss ? ((wr/100)*parseFloat(avgWin)+(1-wr/100)*parseFloat(avgLoss)).toFixed(1) : null;

  // Total P&L in dollars (options: premiumSold - premiumPaid) * contracts * 100
  let totalPnL = 0;
  closed.forEach(e=>{
    if(e._isOptions && e.premiumPaid && e.premiumSold){
      totalPnL += (parseFloat(e.premiumSold)-parseFloat(e.premiumPaid)) * (parseInt(e.contracts)||1) * 100;
    }
  });

  const calibStatus = closed.filter(e=>e._isOptions).length;
  // Render $1k goal dashboard
  renderDashboard(trades, closed, wins, losses, totalPnL);
  const calibPct    = Math.min(100, Math.round(calibStatus/CALIBRATION_THRESHOLD*100));

  if(statsEl) statsEl.innerHTML = `
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:var(--blue)">${all.length}</div><div class="jnl-stat-l">Total</div></div>
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:var(--green2)">${wins.length}</div><div class="jnl-stat-l">Wins</div></div>
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:var(--red)">${losses.length}</div><div class="jnl-stat-l">Losses</div></div>
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:${wr>=60?"var(--green2)":wr>=50?"var(--yellow)":"var(--red)"}">${wr!==null?wr+"%":"—"}</div><div class="jnl-stat-l">Win Rate</div></div>
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:var(--green2)">${avgWin?"+"+avgWin+"%":"—"}</div><div class="jnl-stat-l">Avg Win</div></div>
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:var(--red)">${avgLoss?avgLoss+"%":"—"}</div><div class="jnl-stat-l">Avg Loss</div></div>
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:${expect>0?"var(--green2)":"var(--red)"}">${expect?(expect>0?"+":"")+expect+"%":"—"}</div><div class="jnl-stat-l">Expectancy</div></div>
    <div class="jnl-stat"><div class="jnl-stat-v" style="color:${totalPnL>0?"var(--green2)":"var(--red)"}">${totalPnL!==0?(totalPnL>0?"+$":"−$")+Math.abs(totalPnL).toFixed(0):"—"}</div><div class="jnl-stat-l">Options P&L</div></div>
    <div class="jnl-stat" title="${calibStatus}/${CALIBRATION_THRESHOLD} options trades for AI calibration">
      <div class="jnl-stat-v" style="color:${calibPct>=100?"var(--green2)":"var(--yellow)"}">
        ${calibPct>=100?"🧠 ACTIVE":calibPct+"%"}
      </div>
      <div class="jnl-stat-l">AI Calibration</div>
    </div>`;

  // ── Source breakdown ───────────────────────────────────────────────────────
  if(closed.length >= 3 && breakdown){
    const srcMap = {};
    const srcLabels = {agent:"🤖 Agent",weekly:"📅 Weekly",jax:"🟢 JAX",catalyst:"⚡ Catalyst",recovery:"🔴 Recovery",confluence:"⚡ Confluence",manual:"✏️ Manual","auto-scan":"🤖 Auto-Scan",weinstein:"📊 Weinstein"};
    trades.forEach(e=>{
      const s = e.source||"manual";
      if(!srcMap[s]) srcMap[s]={wins:0,losses:0,total:0,pcts:[]};
      srcMap[s].total++;
      if(e.status==="win"){ srcMap[s].wins++; srcMap[s].pcts.push(getResult(e)); }
      if(e.status==="loss"){ srcMap[s].losses++; srcMap[s].pcts.push(getResult(e)); }
    });
    const bestWR = Math.max(...Object.values(srcMap).map(v=>v.wins+v.losses>0?Math.round(v.wins/(v.wins+v.losses)*100):0));
    breakdown.innerHTML = Object.entries(srcMap).sort((a,b)=>{
      const wrA = a[1].wins+a[1].losses>0?a[1].wins/(a[1].wins+a[1].losses):0;
      const wrB = b[1].wins+b[1].losses>0?b[1].wins/(b[1].wins+b[1].losses):0;
      return wrB-wrA;
    }).map(([src,sm])=>{
      const closedN = sm.wins+sm.losses;
      const wr      = closedN>0?Math.round(sm.wins/closedN*100):null;
      const avgW    = sm.wins>0?(sm.pcts.filter(p=>p>0).reduce((a,b)=>a+b,0)/sm.wins).toFixed(1):null;
      const avgL    = sm.losses>0?(sm.pcts.filter(p=>p<0).reduce((a,b)=>a+b,0)/sm.losses).toFixed(1):null;
      const wrClr   = wr>=60?"var(--green2)":wr>=50?"var(--yellow)":"var(--red)";
      const isTop   = wr===bestWR&&wr!==null&&closedN>=3;
      return `<div class="jnl-source-card${isTop?" top":""}">
        <div class="jnl-src-name">${srcLabels[src]||src}</div>
        <div class="jnl-src-wr" style="color:${wrClr}">${wr!==null?wr+"%":"—"}</div>
        <div class="jnl-src-detail">${sm.wins}W / ${sm.losses}L / ${sm.total-closedN} open</div>
        <div class="jnl-src-detail">${avgW?"+"+avgW+"%":""} ${avgL?avgL+"%":""}</div>
      </div>`;
    }).join("");
    breakdown.style.display = "block";
  } else if(breakdown){
    breakdown.style.display = "none";
  }

  // ── Filter entries ─────────────────────────────────────────────────────────
  const filtered = journalEntries
    .filter(e=> jnlModeFilter==="all"    ? true :
                jnlModeFilter==="trade"  ? e.entryMode==="trade" :
                jnlModeFilter==="options"? e._isOptions :
                (e.entryMode==="tracking"||!e.entryMode))
    .filter(e=> jnlSearch ? e.sym.includes(jnlSearch) : true);

  if(!journalEntries.length){
    body.innerHTML = `<tr><td colspan="12" class="jnl-empty">
      <span style="font-size:24px;display:block;margin-bottom:8px">📓</span>
      Fresh start — options journal ready<br>
      <span style="font-size:8px;color:var(--muted)">Log from Morning Brief, then add option details (strike, expiry, premium) in the row</span>
    </td></tr>`;
    return;
  }

  body.innerHTML = filtered.map(e=>{
    const optResult  = parseFloat(e.optionResult||e.result);
    const hasResult  = !isNaN(optResult) && (e.optionResult||e.result)!=="";
    const resultColor= hasResult?(optResult>0?"var(--green2)":optResult<0?"var(--red)":"var(--muted)"):"var(--muted)";
    const rowCls     = e.status==="win"?"win":e.status==="loss"?"loss":"open";
    const ep         = parseFloat(e.price)||0;
    const sl         = parseFloat(e.stopLoss)||0;
    const t1         = parseFloat(e.target1)||0;
    const rrRatio    = sl>0&&t1>0&&ep>0 ? ((t1-ep)/(ep-sl)).toFixed(1)+"R" : "—";
    const rrColor    = sl>0&&t1>0&&ep>0 ? ((t1-ep)/(ep-sl)>=2?"var(--green2)":(t1-ep)/(ep-sl)>=1?"var(--yellow)":"var(--red)") : "var(--muted)";
    const dte        = e.expiry ? calcDTE(e.expiry) : null;
    const dteColor   = dte===null?"var(--muted)":dte<=7?"var(--red)":dte<=14?"var(--yellow)":"var(--green2)";
    const totalCost  = e.premiumPaid&&e.contracts ? (parseFloat(e.premiumPaid)*(parseInt(e.contracts)||1)*100).toFixed(0) : "";
    const optPnL     = e.premiumPaid&&e.premiumSold&&e.contracts
      ? ((parseFloat(e.premiumSold)-parseFloat(e.premiumPaid))*(parseInt(e.contracts)||1)*100).toFixed(0) : "";

    return `<tr class="${rowCls}" id="jrow-${e.id}">
      <td style="color:var(--muted2);white-space:nowrap;font-size:9px">${e.date}</td>
      <td>
        <span class="jnl-sym" style="cursor:pointer" onclick="window.open('https://www.tradingview.com/chart/?symbol=${e.sym}','_blank')">${e.sym}</span>
        ${e.greenArrow?'<span style="font-size:7px;margin-left:3px">🟢</span>':''}
        <span style="font-size:7px;padding:1px 4px;border-radius:1px;margin-left:3px;
          background:${e.entryMode==="trade"?"rgba(0,200,83,0.15)":"rgba(100,100,100,0.12)"};
          color:${e.entryMode==="trade"?"var(--green2)":"var(--muted2)"};
          border:1px solid ${e.entryMode==="trade"?"rgba(0,200,83,0.3)":"rgba(100,100,100,0.2)"}">
          ${e.entryMode==="trade"?"💰":"📊"}
        </span>
        <select onchange="updateField(${e.id},'entryMode',this.value);renderJournal()"
          style="font-size:7px;background:transparent;border:none;color:var(--muted);cursor:pointer">
          <option value="">▾</option>
          <option value="tracking">📊 Track</option>
          <option value="trade">💰 Real Trade</option>
        </select>
      </td>

      <!-- Options contract cell -->
      <td style="min-width:160px">
        ${e.optionContract
          ? `<span style="font-size:9px;font-weight:700;color:${e.optionType==="call"?"var(--green2)":"#FF6090"}">${e.optionContract}</span>
             ${dte!==null?`<span style="font-size:8px;color:${dteColor};margin-left:4px">${dte}d</span>`:""}`
          : `<span style="font-size:8px;color:var(--muted2)">Add option ▾</span>`}
        <div style="display:flex;gap:3px;margin-top:3px;flex-wrap:wrap">
          <select onchange="updateOptionField(${e.id},'optionType',this.value)"
            style="font-size:7px;background:#0d1520;border:1px solid #1a2a3a;color:var(--text);padding:1px 3px;border-radius:2px">
            <option value="">C/P</option>
            <option value="call" ${e.optionType==="call"?"selected":""}>📈 Call</option>
            <option value="put"  ${e.optionType==="put"?"selected":""}>📉 Put</option>
          </select>
          <input type="text" placeholder="strike" value="${e.strike||''}"
            onchange="updateOptionField(${e.id},'strike',this.value)"
            style="width:42px;font-size:7px;background:#0d1520;border:1px solid #1a2a3a;color:var(--text);padding:1px 4px;border-radius:2px">
          <input type="date" value="${e.expiry||''}"
            onchange="updateOptionField(${e.id},'expiry',this.value)"
            style="width:95px;font-size:7px;background:#0d1520;border:1px solid #1a2a3a;color:var(--text);padding:1px 3px;border-radius:2px">
        </div>
      </td>

      <!-- Premium cells -->
      <td style="min-width:100px">
        <div style="display:flex;gap:3px;align-items:center">
          <span style="font-size:8px;color:var(--muted2)">Buy</span>
          <input type="number" step="0.01" placeholder="$0.00" value="${e.premiumPaid||''}"
            onchange="updateOptionField(${e.id},'premiumPaid',this.value)"
            style="width:52px;font-size:9px;background:#0d1520;border:1px solid #1a2a3a;color:var(--green2);padding:2px 4px;border-radius:2px">
        </div>
        <div style="display:flex;gap:3px;align-items:center;margin-top:2px">
          <span style="font-size:8px;color:var(--muted2)">Qty</span>
          <input type="number" min="1" placeholder="1" value="${e.contracts||1}"
            onchange="updateOptionField(${e.id},'contracts',this.value)"
            style="width:35px;font-size:9px;background:#0d1520;border:1px solid #1a2a3a;color:var(--text);padding:2px 4px;border-radius:2px">
          ${totalCost?`<span style="font-size:8px;color:var(--muted2)">=$${totalCost}</span>`:""}
        </div>
      </td>

      <!-- Exit premium + P&L -->
      <td style="min-width:90px">
        <div style="display:flex;gap:3px;align-items:center">
          <span style="font-size:8px;color:var(--muted2)">Sell</span>
          <input type="number" step="0.01" placeholder="$0.00" value="${e.premiumSold||''}"
            onchange="updateOptionField(${e.id},'premiumSold',this.value)"
            style="width:52px;font-size:9px;background:#0d1520;border:1px solid #1a2a3a;color:${parseFloat(e.premiumSold||0)>parseFloat(e.premiumPaid||0)?"var(--green2)":"var(--red)"};padding:2px 4px;border-radius:2px">
        </div>
        ${optPnL?`<div style="font-size:8px;font-weight:700;color:${parseFloat(optPnL)>=0?"var(--green2)":"var(--red)"};margin-top:2px">${parseFloat(optPnL)>=0?"+$":"−$"}${Math.abs(parseFloat(optPnL)).toFixed(0)}</div>`:""}
      </td>

      <!-- Underlying price -->
      <td style="font-size:10px;font-weight:700;color:var(--muted2)">$${ep.toFixed(2)}</td>

      <!-- Stop / Target -->
      <td>
        ${sl>0?`<span style="color:var(--red);font-size:10px">$${sl.toFixed(2)}</span>`:""}
        <input class="jnl-result-input" type="number" value="${e.stopLoss||''}" placeholder="stop"
          onchange="updateField(${e.id},'stopLoss',parseFloat(this.value)||'')"
          style="width:58px;color:var(--red);border-color:rgba(255,23,68,0.2);${sl>0?'display:none':''}">
      </td>
      <td>
        ${t1>0?`<span style="color:var(--green2);font-size:10px">$${t1.toFixed(2)}</span>`:""}
        <input class="jnl-result-input" type="number" value="${e.target1||''}" placeholder="T1"
          onchange="updateField(${e.id},'target1',parseFloat(this.value)||'')"
          style="width:58px;color:var(--green2);border-color:rgba(0,200,83,0.2);${t1>0?'display:none':''}">
      </td>

      <!-- Result -->
      <td>
        <input class="jnl-result-input" type="text"
          value="${e.optionResult||e.result||''}"
          placeholder="% result"
          onchange="updateResult(${e.id}, this.value)"
          style="width:65px;color:${resultColor}">
      </td>
      <td><span style="color:${rrColor};font-size:10px;font-weight:700">${rrRatio}</span></td>
      <td>
        <span style="color:${resultColor};font-size:10px;font-weight:700">
          ${hasResult?(optResult>0?"▲ +":"▼ ")+Math.abs(optResult).toFixed(1)+"%":e.status==="open"||e.status==="tracking"?"⏳":"—"}
        </span>
      </td>
      <td><span class="jnl-source" style="font-size:8px">${e.source||"—"}</span></td>
      <td><button class="jnl-del" onclick="deleteEntry(${e.id})" title="Delete">×</button></td>
    </tr>`;
  }).join("");
}

// ── Auto-fetch closing prices at 4:15pm ET ────────────────────────────────────
let closeAutoTimer = null;

async function fetchClosingPrices(){
  const openEntries = journalEntries.filter(e=>
    (e.status==="open"||e.status==="tracking") && e.price > 0
  );
  if(!openEntries.length){ log("Journal: no open entries to update","info"); return; }
  log("📓 Fetching prices for "+openEntries.length+" entries...","info");

  for(const entry of openEntries){
    try{
      const q = await fetchLiveQuote(entry.sym);
      if(q && q.price > 0){
        const entryPrice = parseFloat(entry.price);
        const closePrice = q.price;
        entry.closePrice = closePrice;
        entry.closedAt   = new Date().toISOString();

        if(entry._isOptions && entry.premiumPaid){
          // Options: we can't fetch option price from Finnhub, just update underlying
          // User needs to manually enter premiumSold — just flag it
          entry.underlyingClose = closePrice;
          const underlyingMove  = ((closePrice-entryPrice)/entryPrice*100).toFixed(2);
          entry.underlyingMove  = underlyingMove;
          log(`📓 ${entry.sym} underlying → $${closePrice.toFixed(2)} (${underlyingMove>=0?"+":""}${underlyingMove}%) — enter option exit price manually`,"info");
        } else {
          // Stock tracking — calculate result normally
          const resultPct = ((closePrice - entryPrice) / entryPrice * 100);
          if(Math.abs(resultPct) >= 0.01){
            entry.result = resultPct.toFixed(2);
            entry.status = resultPct >= 0 ? "win" : "loss";
          }
          log(`📓 ${entry.sym} → $${closePrice.toFixed(2)} · ${resultPct>=0?"+":""}${resultPct.toFixed(2)}%`,"ok");
        }
      }
    }catch(e){ log("📓 "+entry.sym+": could not fetch price","warn"); }
    await sleep(300);
  }
  saveJournal(); renderJournal();
  // Build calibration after each close
  try{ await buildCalibration(); }catch(e){}
  log("📓 Prices updated","ok");
  sendNotification("📓 Journal Updated",
    `${journalEntries.filter(e=>e.status==="win").length}W · ${journalEntries.filter(e=>e.status==="loss").length}L`,
    "journal");
}

function startCloseAutoTimer(){
  if(closeAutoTimer) clearInterval(closeAutoTimer);
  closeAutoTimer = setInterval(()=>{
    const et  = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const h   = et.getHours(), m = et.getMinutes(), day = et.getDay();
    if(day > 0 && day < 6 && h === 16 && m === 15){
      log("⏰ 4:15 PM ET — auto-fetching closing prices...","info");
      fetchClosingPrices();
    }
  }, 60000);
}

startCloseAutoTimer();
