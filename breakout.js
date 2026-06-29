// breakout.js — BREAKOUT TAB (Layer 1 setups + Layer 2 triggers)
// Reads breakout/setups · breakout/triggers · breakout/meta written by
// breakout-classify.js (daily) and breakout-trigger.js (4H).
// Matches app conventions: window.firebaseReady gate, tickerLogo, logToJournal,
// getMarketSession, dark terminal styling. Display-only — all scoring happens
// server-side in the Node scanners, same pattern as the Weinstein tab.

let boSetups   = {};   // keyed by sym
let boTriggers = {};   // keyed by sym
let boMeta     = null;
let boFilter   = "ALL";

function setText(id, v){ const e = document.getElementById(id); if(e) e.textContent = v; }

function setBOFilter(v, btn){
  boFilter = v;
  document.querySelectorAll('#panel-breakout .bo-chip').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');
  renderBreakout();
}

function boStars(n){
  let o = "";
  for(let i=0;i<5;i++) o += i < n ? '★' : '<span style="color:#2a3340">★</span>';
  return o;
}
function boTierCls(t){ return t==='A+'?'bo-tA':t==='EARLY'?'bo-tE':t==='WATCH'?'bo-tW':'bo-tR'; }
function boTierClr(t){ return t==='A+'?'var(--green)':t==='EARLY'?'var(--orange)':t==='WATCH'?'var(--blue)':'var(--muted2)'; }

function renderBreakout(){
  const grid = document.getElementById('bo-results');
  if(!grid) return;
  const sort   = document.getElementById('bo-sort')?.value || 'setup';
  const search = (document.getElementById('bo-search')?.value || '').toUpperCase().trim();

  // merge trigger info onto each setup
  let rows = Object.values(boSetups).map(s=>{
    const tg = boTriggers[s.sym] || {};
    return Object.assign({}, s, {
      triggerScore: tg.triggerScore || 0,
      tier: tg.tier || s.tier || 'WATCH'
    });
  });

  // stat bar (over non-reject)
  const live = rows.filter(r=>r.tier!=='REJECT');
  setText('bo-aplus', rows.filter(r=>r.tier==='A+').length);
  setText('bo-early', rows.filter(r=>r.tier==='EARLY').length);
  setText('bo-watch', rows.filter(r=>r.tier==='WATCH').length);
  setText('bo-avg', live.length ? Math.round(live.reduce((a,r)=>a+(r.setupScore||0),0)/live.length) : '—');
  if(boMeta) setText('bo-gated', boMeta.gated || 0);

  let f = rows.filter(r=> boFilter==='ALL' ? r.tier!=='REJECT' : r.tier===boFilter);
  if(search) f = f.filter(r=>r.sym.includes(search));
  f.sort((a,b)=>
    sort==='ticker'  ? a.sym.localeCompare(b.sym) :
    sort==='trigger' ? (b.triggerScore-a.triggerScore) :
                       (b.setupScore-a.setupScore));

  setText('bo-resCount', f.length+' shown');

  if(!f.length){
    grid.innerHTML = Object.keys(boSetups).length
      ? '<div class="conf-empty"><span class="conf-empty-icon">🔍</span>No setups in this tier.</div>'
      : '<div class="conf-empty"><span class="conf-empty-icon">🚀</span>BREAKOUT SCANNER<br>'
        +'<span style="font-size:9px;color:var(--muted2)">Run <b>breakout-classify</b> (GitHub Action) to populate setups</span><br>'
        +'<span style="font-size:8px;color:var(--muted)">Daily setup scorer → 4H trigger → daily confirm · writes breakout/* in Firebase</span></div>';
    return;
  }

  grid.innerHTML = f.map((s)=>{
    const pips  = (s.stack||[]).map(p=>`<div class="bo-pip ${p.on?'on':''}"><i></i><b>${p.k}</b></div>`).join('');
    const tags  = (s.tags||[]).map(t=>`<span class="bo-tag">${(''+t).replace(/_/g,' ')}</span>`).join('');
    const warns = (s.warnings||[]).map(w=>`<span class="bo-tag warn">${w}</span>`).join('');
    const p     = s.parts || {};
    const bar = (lbl,v,m,clr)=>`<div class="bo-bar"><span class="bo-bl">${lbl}</span>`
      +`<span class="bo-bt"><span class="bo-bf" style="width:${Math.round(((v||0)/m)*100)}%;background:${clr}"></span></span>`
      +`<span class="bo-bv">${(v||0).toFixed(0)}/${m}</span></div>`;
    const tClr = boTierClr(s.tier);
    return `<div class="bo-card ${boTierCls(s.tier)}" onclick="window.open('https://www.tradingview.com/chart/?symbol='+encodeURIComponent('${s.sym}'),'_blank')">
      <div class="bo-row1">
        <span class="bo-tkr">${tickerLogo(s.sym,20)}${s.sym}</span>
        <span class="bo-px">$${(s.close||0).toFixed(2)}</span>
        <span class="bo-stars">${boStars(s.stars||1)}</span>
        <span class="bo-tier" style="color:${tClr};border-color:${tClr}">${s.tier}</span>
      </div>
      <div class="bo-row2">
        <span class="bo-sc"><b>${s.setupScore||0}</b> setup</span>
        <span class="bo-sc"><b>${s.triggerScore||'—'}</b> trig</span>
        <div class="bo-stack">${pips}</div>
      </div>
      <div class="bo-bars">
        ${bar('Base',p.base,30,'var(--green2)')}
        ${bar('Vol',p.vol,25,'#00bcd4')}
        ${bar('Trend',p.trend,20,'var(--blue)')}
        ${bar('RS',p.rs,15,'#CE93D8')}
        ${bar('Prox',p.prox,10,'var(--yellow)')}
      </div>
      ${(tags||warns)?`<div class="bo-detail">${tags}${warns}</div>`:''}
      <div class="bo-footer">
        <span style="font-size:8px;color:var(--muted2);font-family:var(--mono)">${s.stage||''}${s.extended?' · EXTENDED':''}</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="log-btn" onclick="event.stopPropagation();logToJournal({sym:'${s.sym}',price:${s.close||0},score:${s.setupScore||0},source:'breakout',session:getMarketSession(),greenArrow:${s.tier==='A+'},tradeType:'Breakout',entryMode:'tracking'})">📓 LOG</button>
          <span style="font-size:8px;color:var(--muted2);font-family:var(--mono)">📈 TV →</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Manual run: triggers the breakout-classify GitHub Action via workflow_dispatch ──
// Needs a token with "Actions: write" on this repo. DO NOT hardcode it here and commit
// it — this repo is public. Store it once, per-device, in the browser instead:
//     localStorage.setItem('gh_pat','github_pat_xxx')
// (a fine-grained PAT scoped to Actions:write on confluence-screener only).
// If your Weinstein RUN CLASSIFIER button already works, it uses the same idea — point
// this at whatever it uses (e.g. set window.GH_PAT in firebase.js) and it'll match.
const BREAKOUT_REPO     = "shoprevoltinc-source/confluence-screener";
const BREAKOUT_WORKFLOW = "breakout-classify.yml";
const BREAKOUT_REF      = "main"; // change to "master" if that's your default branch

async function triggerBreakoutRun(){
  const st  = document.getElementById('bo-run-status');
  const pat = window.GH_PAT || (function(){ try{ return localStorage.getItem('gh_pat')||""; }catch(e){ return ""; } })();
  if(!pat){
    if(st) st.textContent = 'No token — run once in console: localStorage.setItem("gh_pat","github_pat_…") (Actions:write)';
    return;
  }
  if(st) st.textContent = '⏳ Dispatching scan…';
  try{
    const res = await fetch(`https://api.github.com/repos/${BREAKOUT_REPO}/actions/workflows/${BREAKOUT_WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ ref: BREAKOUT_REF, inputs: { top: 'all', source: 'all' } })
    });
    if(res.status === 204){
      if(st) st.textContent = '✅ Scan dispatched — ~3 min · this tab updates live when it writes';
    } else {
      const t = await res.text();
      if(st) st.textContent = '✗ '+res.status+' '+t.slice(0,90);
    }
  }catch(e){ if(st) st.textContent = '✗ '+e.message; }
}

// Load once from _initApp — registers listeners a single time.
function loadBreakout(){
  // local cache first (instant paint)
  try{
    const cached = localStorage.getItem('cs_breakout');
    if(cached){ const o = JSON.parse(cached); boSetups = o.setups||{}; boTriggers = o.triggers||{}; boMeta = o.meta||null; renderBreakout(); }
  }catch(e){}

  const _fb = ()=>{
    if(typeof firebase === 'undefined' || !firebase.database) return;
    try{
      const db = firebase.database();
      const apply = ()=>{
        try{ localStorage.setItem('cs_breakout', JSON.stringify({setups:boSetups, triggers:boTriggers, meta:boMeta})); }catch(e){}
        renderBreakout();
      };
      db.ref('breakout/setups').on('value',   snap=>{ boSetups   = snap.val()||{};   apply(); });
      db.ref('breakout/triggers').on('value', snap=>{ boTriggers = snap.val()||{};   apply(); });
      db.ref('breakout/meta').on('value',     snap=>{ boMeta     = snap.val()||null;
        if(boMeta && boMeta.savedAt){ const t=document.getElementById('bo-lastrun'); if(t) t.textContent='Last scan '+new Date(boMeta.savedAt).toLocaleString(); }
        apply();
      });
    }catch(e){ console.warn('breakout fb:', e); }
  };
  if(window.firebaseReady){ _fb(); }
  else { document.addEventListener('firebaseReady', _fb, {once:true}); }
}
