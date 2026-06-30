// breakout.js — BREAKOUT TAB (browser scanner, matches app architecture)
// RUN SCANNER fetches candles client-side via your proven fetchCandlesWithKey,
// scores setups with the spec engine, writes to screener/breakout (a path your
// Firebase rules already allow — same as screener/recovery), and renders live.
// No GitHub Action, no FIREBASE_TOKEN, no egress issues. Reuses: TD_KEYS, SP500,
// SMALLCAP, fetchCandlesWithKey, splitInterleaved, getMarketSession, tickerLogo,
// logToJournal, firebase, window.firebaseReady.

let boSetups   = {};   // keyed by sym
let boTriggers = {};   // keyed by sym (Layer 2, not built yet)
let boMeta     = null;
let boFilter   = "ALL";
let boUniverse = "flagged";   // flagged | smallcap | sp500 | all | watchlist
let boScanning = false, boStopReq = false;

function boText(id, v){ const e = document.getElementById(id); if(e) e.textContent = v; }

function setBOFilter(v, btn){
  boFilter = v;
  document.querySelectorAll('#panel-breakout .bo-chip').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');
  renderBreakout();
}
function boStars(n){ let o=""; for(let i=0;i<5;i++) o += i<n?'★':'<span style="color:#2a3340">★</span>'; return o; }
function boTierCls(t){ return t==='A+'?'bo-tA':t==='EARLY'?'bo-tE':t==='WATCH'?'bo-tW':'bo-tR'; }
function boTierClr(t){ return t==='A+'?'var(--green)':t==='EARLY'?'var(--orange)':t==='WATCH'?'var(--blue)':'var(--muted2)'; }

// ════════════════════════════════════════════════════════════════════════════
// SCORING ENGINE (mirrors breakout-scanner-spec.md — runs client-side)
// ════════════════════════════════════════════════════════════════════════════
const BO_K = { PRICE_FLOOR:10, FRESH_MAX_ATR:2.5, CONTRACTION_STRONG:0.60,
  BASE_DEPTH_TIGHT:0.15, MIN_BASE_WEEKS:5, DOLLARVOL_MIN:5e6, VOL_MIN:500000,
  MIN_SCORE:60, CAP:40 };
const boClamp = x => Math.max(0, Math.min(1, x));
const boSMA = (a,n)=>{ const s=a.slice(-n); return s.reduce((x,y)=>x+y,0)/Math.min(n, s.length||1); };
const boEMA = (c,n)=>{ const k=2/(n+1); let e=c[0]; for(let i=1;i<c.length;i++) e=c[i]*k+e*(1-k); return e; };
function boATR(highs,lows,closes,n){
  n = n||14;
  const tr=[]; for(let i=1;i<closes.length;i++){ const h=highs[i],l=lows[i],pc=closes[i-1];
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc))); }
  const out=[]; let prev=null;
  for(let i=0;i<tr.length;i++){
    if(i<n){ if(i===n-1){ prev=tr.slice(0,n).reduce((a,b)=>a+b,0)/n; out[i]=prev; } else out[i]=null; }
    else { prev=(prev*(n-1)+tr[i])/n; out[i]=prev; }
  } return out;
}
const boPerf = (c,b)=> c.length>b ? (c[c.length-1]-c[c.length-1-b])/c[c.length-1-b] : 0;

function boMetrics(cd, spy){
  const closes=cd.closes, highs=cd.highs, lows=cd.lows, vols=cd.volumes||[], n=closes.length, close=closes[n-1];
  const sma20=boSMA(closes,20), sma50=boSMA(closes,50), ema200=boEMA(closes,200);
  const atr=boATR(highs,lows,closes,14), atrDaily=atr[atr.length-1]||0;
  const ti=atr.length-1-60, atrThen=ti>0?atr[ti]:(atr.find(x=>x!=null)||atrDaily);
  const atrRatio=atrThen?atrDaily/atrThen:1;
  const baseN=Math.min(40,n), hi=Math.max.apply(null,highs.slice(-baseN)), lo=Math.min.apply(null,lows.slice(-baseN));
  const depth=lo>0?(hi-lo)/lo:1, baseWeeks=baseN/5, third=Math.floor(baseN/3);
  const at=atr.filter(x=>x!=null);
  const aF=boSMA(at.slice(0,third).length?at.slice(0,third):[atrDaily],third)||atrDaily;
  const aR=boSMA(at.slice(-third).length?at.slice(-third):[atrDaily],third)||atrDaily;
  const bv=vols.slice(-baseN), dryRatio=(boSMA(bv.slice(-10),10)||1)/(boSMA(bv,baseN)||1);
  let up=0,dn=0; for(let i=n-baseN+1;i<n;i++){ if(closes[i]>=closes[i-1]) up+=vols[i]||0; else dn+=vols[i]||0; }
  const accumRatio=dn>0?up/dn:2;
  const rs1=boPerf(closes,21)-boPerf(spy,21), rs3=boPerf(closes,63)-boPerf(spy,63), rs6=boPerf(closes,126)-boPerf(spy,126);
  let rsLineHigh=false;
  if(spy.length>=60){ const m=Math.min(60,n,spy.length); const ratio=[];
    for(let i=1;i<=m;i++) ratio.push(closes[n-i]/spy[spy.length-i]);
    rsLineHigh = ratio[0] >= Math.max.apply(null,ratio)*0.995; }
  const high52=Math.max.apply(null,highs.slice(-252)), distPct=high52>0?Math.max(0,(high52-close)/high52*100):100;
  return { close, sma20, sma50, ema200, atrDaily, atrRatio, atrFirstThird:aF, atrRecentThird:aR,
           depth, baseWeeks, dryRatio, accumRatio, rs1, rs3, rs6, rsLineHigh, distPct, avg20Vol:boSMA(vols,20) };
}
function boStage(m, closes){
  const ema200=m.ema200, prev=closes.length>10?boEMA(closes.slice(0,-10),200):ema200, rising=ema200>=prev;
  if(m.close>ema200 && m.sma50>ema200 && rising) return 2;
  if(m.close>ema200 && rising) return 1;
  if(m.close<ema200 && !rising) return 4;
  return m.close<ema200 ? 3 : 1;
}
function boScore(m, stage){
  const dp=boClamp((0.35-m.depth)/(0.35-BO_K.BASE_DEPTH_TIGHT))*10;
  const du=boClamp((m.baseWeeks-BO_K.MIN_BASE_WEEKS)/(20-BO_K.MIN_BASE_WEEKS))*4;
  const cp=boClamp((1-m.atrRatio)/(1-BO_K.CONTRACTION_STRONG))*11;
  const tp=boClamp((m.atrFirstThird-m.atrRecentThird)/(m.atrFirstThird||1)/0.30)*5;
  const base=dp+du+cp+tp;
  const dry=boClamp((1-m.dryRatio)/(1-0.6))*13, acc=boClamp((m.accumRatio-1)/(2-1))*12, vol=dry+acc;
  const sp=stage===2?10:stage===1?5:0;
  let ep=(m.close>m.sma20&&m.close>m.sma50)?6:(m.close>m.sma50?3:0); ep+=(m.sma50>m.ema200)?2:0;
  const trend=Math.min(20, sp+ep+2);
  const rs=(m.rs1>0?3:0)+(m.rs3>0?4:0)+(m.rs6>0?4:0)+(m.rsLineHigh?4:0);
  const prox=m.distPct<=0?10:boClamp((10-m.distPct)/10)*10;
  return { total:base+vol+trend+rs+prox, base, vol, trend, rs, prox };
}
const boStarCount = s => s>=90?5:s>=75?4:s>=60?3:s>=45?2:1;
function boGate(m, stage){
  const dv=m.avg20Vol*m.close;
  return m.close<BO_K.PRICE_FLOOR || dv<BO_K.DOLLARVOL_MIN || m.avg20Vol<BO_K.VOL_MIN || m.close<=m.ema200 || stage===4;
}

// ════════════════════════════════════════════════════════════════════════════
// RUN SCANNER — client-side scan (this is what the button calls)
// ════════════════════════════════════════════════════════════════════════════
async function triggerBreakoutRun(){ return runBreakoutScan(); }

// Build the scan universe. "flagged" = union of tickers your other scanners already
// surfaced (screener/recovery|catalyst|jax_scan|weekly_monitor) — pre-vetted & smaller,
// so the scan is much faster and higher signal. Falls back to small-caps if empty.
async function boGetUniverse(mode){
  mode = mode || boUniverse || 'flagged';
  const dedup = arr => [...new Set((arr||[]).filter(Boolean).map(s=>(''+s).toUpperCase().trim()))];
  const SC = (typeof SMALLCAP!=='undefined') ? SMALLCAP : [];
  const SP = (typeof SP500!=='undefined') ? SP500 : [];

  if(mode==='smallcap') return dedup(SC);
  if(mode==='sp500')    return dedup(SP);
  if(mode==='all')      return dedup([...SC, ...SP]);
  if(mode==='watchlist'){
    if(typeof WATCHLIST!=='undefined' && WATCHLIST.length) return dedup(WATCHLIST);
    try{ const w=JSON.parse(localStorage.getItem('cs_watchlist')||'[]'); if(w.length) return dedup(w); }catch(e){}
    return dedup(SC);
  }

  // 'flagged' — read the screener nodes your other scanners write
  let syms = [];
  try{
    if(typeof firebase!=='undefined' && firebase.database){
      const nodes = ['recovery','catalyst','jax_scan','weekly_monitor'];
      for(const n of nodes){
        try{
          const snap = await firebase.database().ref('screener/'+n).once('value');
          const v = snap.val(); if(!v) continue;
          let arr = [];
          if(Array.isArray(v)) arr = v;
          else if(Array.isArray(v.data)) arr = v.data;
          else if(typeof v==='object') arr = Object.values(v).filter(x=>x && typeof x==='object');
          arr.forEach(it=>{
            if(typeof it==='string') syms.push(it);
            else if(it) { const s = it.sym||it.ticker||it.symbol; if(s) syms.push(s); }
          });
        }catch(e){}
      }
    }
  }catch(e){}
  syms = dedup(syms);
  return syms.length >= 20 ? syms : dedup(SC);  // fallback if screener empty
}

async function runBreakoutScan(){
  const st = document.getElementById('bo-run-status');
  if(boScanning){ boStopReq = true; if(st) st.textContent='⏹ stopping…'; return; }
  if(typeof fetchCandlesWithKey !== 'function'){
    if(st) st.textContent = '✗ scanner deps not loaded — open this inside the app'; return;
  }
  boScanning = true; boStopReq = false;

  // universe — see boGetUniverse(); default "flagged" = pre-vetted union from your scanners
  const tickers = await boGetUniverse(boUniverse);
  const total = tickers.length;
  if(!total){ if(st) st.textContent='✗ universe empty — run your other scanners first, or switch to Small-caps'; boScanning=false; return; }
  const uniLabel = {flagged:'flagged',smallcap:'small-caps',sp500:'S&P 500',all:'all',watchlist:'watchlist'}[boUniverse]||boUniverse;
  if(st) st.textContent = '⏳ scanning '+total+' '+uniLabel+' tickers in-browser…';

  // SPY once for relative strength
  let spy=null; try{ spy = await fetchCandlesWithKey('SPY', 0); }catch(e){}
  const spyCloses = spy ? spy.closes : [];

  const setups={}; let scored=0, gated=0, done=0;
  const nKeys = (typeof TD_KEYS!=='undefined' && TD_KEYS.length) ? TD_KEYS.length : 1;
  const chunks = (typeof splitInterleaved==='function') ? splitInterleaved(tickers, nKeys) : [tickers];

  async function worker(ki, chunk){
    for(const sym of chunk){
      if(boStopReq) break;
      done++;
      if(st && (done%5===0 || done===total)) st.textContent = '⏳ '+done+'/'+total+' · '+scored+' setups';
      try{
        const cd = await fetchCandlesWithKey(sym, ki);
        if(cd && cd.closes && cd.closes.length>=60){
          const m = boMetrics(cd, spyCloses);
          const stage = boStage(m, cd.closes);
          if(boGate(m, stage)){ gated++; }
          else {
            const sc = boScore(m, stage);
            if(sc.total >= BO_K.MIN_SCORE){
              const stars = boStarCount(sc.total);
              const extended = m.close > m.sma20*1.20 || m.close > m.sma50*1.25;
              const tags=[]; if(m.distPct<=1) tags.push('52W_HIGH'); tags.push('RANGE_BREAK'); if(stage===2 && m.distPct<=3) tags.push('STAGE_2');
              const warnings=[]; if(extended) warnings.push('EXTENDED');
              const stack=[
                {k:'COIL',  on:m.atrRatio<=0.80},
                {k:'VOL',   on:m.dryRatio<1.0 && m.accumRatio>1.2},
                {k:'RS',    on:m.rs3>0},
                {k:'FRESH', on:!extended && m.distPct<=2},
                {k:'CLOSE', on:false},
                {k:'TREND', on:stage===2 && m.close>m.ema200},
                {k:'DAILY', on:false}
              ];
              setups[sym] = { sym, close:+m.close.toFixed(2), tier:'WATCH', stars,
                setupScore:Math.round(sc.total),
                parts:{ base:+sc.base.toFixed(1), vol:+sc.vol.toFixed(1), trend:+sc.trend.toFixed(1), rs:+sc.rs.toFixed(1), prox:+sc.prox.toFixed(1) },
                tags, warnings, stack, distPct:+m.distPct.toFixed(1), atr:+m.atrDaily.toFixed(2), extended, stage:'S'+stage };
              scored++;
              boSetups = Object.assign({}, setups); renderBreakout(); // live paint
            }
          }
        }
      }catch(e){ /* skip bad ticker */ }
      await new Promise(r=>setTimeout(r, 200)); // ~5 req/s — under the Grow 377/min cap
    }
  }

  await Promise.all(chunks.map((c,ki)=>worker(ki, c)));

  // write under screener/breakout — a path your rules already permit (no token needed)
  const ranked = Object.values(setups).sort((a,b)=>b.setupScore-a.setupScore);
  const watchlist = ranked.slice(0, BO_K.CAP).map(r=>r.sym);
  boMeta = { savedAt:new Date().toISOString(), device:'browser-scan', scored, gated, watchlistCount:watchlist.length };
  try{
    if(typeof firebase!=='undefined' && firebase.database){
      await firebase.database().ref('screener/breakout').set({ data:setups, watchlist, meta:boMeta });
    }
    try{ localStorage.setItem('cs_breakout', JSON.stringify({setups, meta:boMeta})); }catch(e){}
  }catch(e){ if(st) st.textContent = '⚠️ scored '+scored+' but write failed: '+e.message; boScanning=false; return; }

  boScanning = false; boStopReq = false;
  boSetups = setups; renderBreakout();
  if(st) st.textContent = '✅ '+scored+' setups · '+gated+' gated · saved '+new Date().toLocaleTimeString();
}

// ════════════════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════════════════
function renderBreakout(){
  const grid = document.getElementById('bo-results');
  if(!grid) return;
  const sort   = document.getElementById('bo-sort')?.value || 'setup';
  const search = (document.getElementById('bo-search')?.value || '').toUpperCase().trim();

  let rows = Object.values(boSetups).map(s=>{
    const tg = boTriggers[s.sym] || {};
    return Object.assign({}, s, { triggerScore: tg.triggerScore||0, tier: tg.tier||s.tier||'WATCH' });
  });

  const live = rows.filter(r=>r.tier!=='REJECT');
  boText('bo-aplus', rows.filter(r=>r.tier==='A+').length);
  boText('bo-early', rows.filter(r=>r.tier==='EARLY').length);
  boText('bo-watch', rows.filter(r=>r.tier==='WATCH').length);
  boText('bo-avg', live.length ? Math.round(live.reduce((a,r)=>a+(r.setupScore||0),0)/live.length) : '—');
  if(boMeta) boText('bo-gated', boMeta.gated||0);
  if(boMeta && boMeta.savedAt){ const t=document.getElementById('bo-lastrun'); if(t) t.textContent='Last scan '+new Date(boMeta.savedAt).toLocaleString(); }

  let f = rows.filter(r=> boFilter==='ALL' ? r.tier!=='REJECT' : r.tier===boFilter);
  if(search) f = f.filter(r=>r.sym.includes(search));
  f.sort((a,b)=> sort==='ticker'?a.sym.localeCompare(b.sym) : sort==='trigger'?(b.triggerScore-a.triggerScore):(b.setupScore-a.setupScore));
  boText('bo-resCount', f.length+' shown');

  if(!f.length){
    grid.innerHTML = Object.keys(boSetups).length
      ? '<div class="conf-empty"><span class="conf-empty-icon">🔍</span>No setups in this tier.</div>'
      : '<div class="conf-empty"><span class="conf-empty-icon">🚀</span>BREAKOUT SCANNER<br>'
        +'<span style="font-size:9px;color:var(--muted2)">Tap <b>RUN SCANNER</b> — scans in-browser, ~2-3 min, writes results live</span><br>'
        +'<span style="font-size:8px;color:var(--muted)">VCP coil · volume dry-up · RS vs SPY · freshness · the full anti-fakeout stack</span></div>';
    return;
  }

  grid.innerHTML = f.map(function(s){
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
      </div>
      <div class="bo-stack" style="margin-left:0;margin-top:10px;width:100%;justify-content:space-between;flex-wrap:nowrap;gap:2px">${pips}</div>
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

// ════════════════════════════════════════════════════════════════════════════
// LOAD — read screener/breakout (written by the browser scan above)
// ════════════════════════════════════════════════════════════════════════════
function loadBreakout(){
  // inject a universe selector into the controls (additive; no index.html change)
  try{
    const ctrls = document.querySelector('#panel-breakout .conf-controls');
    if(ctrls && !document.getElementById('bo-universe')){
      const sel = document.createElement('select');
      sel.className = 'sort-select'; sel.id = 'bo-universe';
      sel.title = 'Scan universe';
      sel.innerHTML = '<option value="flagged">⚡ Flagged (~fast)</option>'
        + '<option value="smallcap">Small-caps</option>'
        + '<option value="sp500">S&amp;P 500</option>'
        + '<option value="all">All (~slow)</option>'
        + '<option value="watchlist">Watchlist</option>';
      sel.value = boUniverse;
      sel.onchange = function(){ boUniverse = sel.value; };
      const sortSel = document.getElementById('bo-sort');
      if(sortSel && sortSel.parentNode) sortSel.parentNode.insertBefore(sel, sortSel);
      else ctrls.appendChild(sel);
    }
  }catch(e){}

  try{
    const cached = localStorage.getItem('cs_breakout');
    if(cached){ const o=JSON.parse(cached); boSetups=o.setups||{}; boMeta=o.meta||null; renderBreakout(); }
  }catch(e){}

  const _fb = function(){
    if(typeof firebase==='undefined' || !firebase.database) return;
    try{
      firebase.database().ref('screener/breakout').on('value', function(snap){
        const v = snap.val();
        if(v){
          boSetups = v.data || {};
          boMeta   = v.meta || boMeta;
          try{ localStorage.setItem('cs_breakout', JSON.stringify({setups:boSetups, meta:boMeta})); }catch(e){}
          renderBreakout();
        }
      });
    }catch(e){ console.warn('breakout fb:', e); }
  };
  if(window.firebaseReady){ _fb(); }
  else { document.addEventListener('firebaseReady', _fb, {once:true}); }
}

// Version stamp — check the console after refresh to confirm the new file loaded.
// If you DON'T see this line in the console, your Service Worker served a cached copy.
console.log('%c🚀 breakout.js v4 loaded — universe dropdown + aligned cards', 'color:#00b0ff;font-weight:700');
