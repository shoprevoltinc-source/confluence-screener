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
// JAX PRO arrow — faithful JS port of longCond from JAX_PRO_Strategy_v5 (Pine v6).
// longCond = (utBuy OR stFlip) AND bull_score>=entry_min AND rsi14<70
// Used ADDITIVELY: computed on daily AND 4H; a badge lights when both agree.
// ════════════════════════════════════════════════════════════════════════════
const JAX = { ATR_P:10, ATR_MULT:3.5, ST_FACTOR:1.5, ST_ATR:10, ENTRY_MIN:1 };

function jaxATRSeries(highs,lows,closes,n){
  const len=closes.length, tr=new Array(len).fill(NaN), atr=new Array(len).fill(NaN);
  for(let i=1;i<len;i++){ const h=highs[i],l=lows[i],pc=closes[i-1]; tr[i]=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)); }
  if(len<=n) return atr;
  let sum=0; for(let i=1;i<=n;i++) sum+=tr[i]; atr[n]=sum/n;
  for(let i=n+1;i<len;i++) atr[i]=(atr[i-1]*(n-1)+tr[i])/n;
  return atr;
}
function jaxEMAval(c,n){ const k=2/(n+1); let e=c[0]; for(let i=1;i<c.length;i++) e=c[i]*k+e*(1-k); return e; }
function jaxEMASeries(v,n){ const k=2/(n+1), out=[v[0]]; for(let i=1;i<v.length;i++) out.push(v[i]*k+out[i-1]*(1-k)); return out; }
function jaxRSI(c,n){
  let g=0,l=0; for(let i=1;i<=n;i++){ const ch=c[i]-c[i-1]; if(ch>=0) g+=ch; else l-=ch; }
  let ag=g/n, al=l/n;
  for(let i=n+1;i<c.length;i++){ const ch=c[i]-c[i-1]; ag=(ag*(n-1)+(ch>0?ch:0))/n; al=(al*(n-1)+(ch<0?-ch:0))/n; }
  if(al===0) return 100; return 100-100/(1+ag/al);
}
function jaxMACDhist(c){
  const e12=jaxEMASeries(c,12), e26=jaxEMASeries(c,26), macd=c.map((_,i)=>e12[i]-e26[i]), sig=jaxEMASeries(macd,9);
  const i=c.length-1; return macd[i]-sig[i];
}
function jaxWPR(highs,lows,closes,n){
  const i=closes.length-1, hh=Math.max.apply(null,highs.slice(i-n+1,i+1)), ll=Math.min.apply(null,lows.slice(i-n+1,i+1));
  return hh===ll?0:(hh-closes[i])/(hh-ll)*-100;
}
// UT Bot ATR trailing stop → direction series
function jaxTrailDir(closes, atr, mult){
  const n=closes.length, trail=new Array(n).fill(NaN), tdir=new Array(n).fill(0);
  for(let i=0;i<n;i++){
    const a=isNaN(atr[i])?0:atr[i], nLoss=mult*a, trailUp=closes[i]-nLoss, trailDown=closes[i]+nLoss;
    if(i===0||isNaN(trail[i-1])) trail[i]=closes[i];
    else { const pt=trail[i-1];
      if(closes[i]>pt && closes[i-1]>pt) trail[i]=Math.max(pt,trailUp);
      else if(closes[i]<pt && closes[i-1]<pt) trail[i]=Math.min(pt,trailDown);
      else trail[i]= closes[i]>pt ? trailUp : trailDown; }
    tdir[i] = i===0 ? 0 : (trail[i]>trail[i-1]?1:trail[i]<trail[i-1]?-1:tdir[i-1]);
  }
  return tdir;
}
// Supertrend direction series (-1 = bullish, +1 = bearish — matches Pine ta.supertrend)
function jaxSupertrendDir(highs,lows,closes,factor,atrP){
  const n=closes.length, atr=jaxATRSeries(highs,lows,closes,atrP);
  const dir=new Array(n).fill(1), st=new Array(n).fill(NaN), fU=new Array(n).fill(NaN), fL=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    const hl2=(highs[i]+lows[i])/2, a=isNaN(atr[i])?0:atr[i], bu=hl2+factor*a, bl=hl2-factor*a;
    if(i===0||isNaN(atr[i-1])){ fU[i]=bu; fL[i]=bl; dir[i]=1; st[i]=bu; continue; }
    fU[i]=(bu<fU[i-1]||closes[i-1]>fU[i-1])?bu:fU[i-1];
    fL[i]=(bl>fL[i-1]||closes[i-1]<fL[i-1])?bl:fL[i-1];
    if(st[i-1]===fU[i-1]) dir[i]= closes[i]>fU[i] ? -1 : 1;
    else                  dir[i]= closes[i]<fL[i] ?  1 : -1;
    st[i]= dir[i]===-1 ? fL[i] : fU[i];
  }
  return dir;
}
// Returns the full JAX evaluation for one candle set (daily or 4H).
function jaxSignal(cd){
  const c=cd.closes, h=cd.highs, l=cd.lows, n=c.length;
  if(n<70) return null;
  const atr=jaxATRSeries(h,l,c,JAX.ATR_P);
  const tdir=jaxTrailDir(c,atr,JAX.ATR_MULT);
  const utBuy = tdir[n-1]===1 && tdir[n-2]===-1;
  const sdir=jaxSupertrendDir(h,l,c,JAX.ST_FACTOR,JAX.ST_ATR);
  const stBull = sdir[n-1]<0, stFlip = stBull && !(sdir[n-2]<0);
  const e20=jaxEMAval(c,20), e40=jaxEMAval(c,40), e60=jaxEMAval(c,60), close=c[n-1];
  const emaStack = e20>e40 && e40>e60 && close>e20;
  const macdBull = jaxMACDhist(c)>0;
  const rsi=jaxRSI(c,14), rsiBull=rsi>50;
  const wrBull = jaxWPR(h,l,c,14) > -50;
  const bullScore=(emaStack?1:0)+(macdBull?1:0)+(rsiBull?1:0)+(wrBull?1:0)+(stBull?1:0);
  const longCond = (utBuy||stFlip) && bullScore>=JAX.ENTRY_MIN && rsi<70;
  return { longCond, bullScore, utBuy, stFlip, stBull, emaStack, macdBull, rsiBull, wrBull, rsi:+rsi.toFixed(1) };
}

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

// ════════════════════════════════════════════════════════════════════════════
// LAYER 2 — 4H TRIGGER (consolidation break · RVOL · close-loc · wick · fresh)
// Runs only on Layer-1 setups, so it's cheap. Promotes WATCH → EARLY / A+.
// ════════════════════════════════════════════════════════════════════════════
const BO_T = { BREAK_PCT:2.0, RVOL_MIN:1.5, CLOSE_LOC_MIN:0.70, WICK_MAX:0.40,
  FRESH_ATR_MAX:2.5, EARLY_RVOL:1.2, EARLY_LOC:0.60, LOOKBACK:10 };

async function bo4HFetch(sym, ki){
  const key = (typeof TD_KEYS!=='undefined' && TD_KEYS.length) ? TD_KEYS[ki % TD_KEYS.length] : null;
  if(!key) return null;
  try{
    const url = 'https://api.twelvedata.com/time_series?symbol='+encodeURIComponent(sym)
      +'&interval=4h&outputsize=120&apikey='+key;
    const r = await fetch(url);
    if(!r.ok) return null;
    const d = await r.json();
    if(!d || d.status==='error' || !d.values || !d.values.length) return null;
    const v = d.values.slice().reverse(); // TD returns newest-first → oldest-first
    return { closes:v.map(x=>+x.close), highs:v.map(x=>+x.high), lows:v.map(x=>+x.low), volumes:v.map(x=>+(x.volume||0)) };
  }catch(e){ return null; }
}

// Evaluate the 4H trigger. dm = daily metrics (for ATR + extension). Returns trigger detail.
function boTriggerEval(c4, dm){
  const n=c4.closes.length; if(n<BO_T.LOOKBACK+2) return null;
  const close=c4.closes[n-1], high=c4.highs[n-1], low=c4.lows[n-1];
  const rangeHigh=Math.max.apply(null, c4.highs.slice(n-1-BO_T.LOOKBACK, n-1));
  const breakPct=rangeHigh>0?(close-rangeHigh)/rangeHigh*100:0;
  const avgVol=c4.volumes.slice(n-1-20<0?0:n-1-20, n-1).reduce((a,b)=>a+b,0)/Math.min(20,n-1);
  const rvol=avgVol>0?c4.volumes[n-1]/avgVol:0;
  const barRange=high-low;
  const closeLoc=barRange>0?(close-low)/barRange:0;
  const wickFrac=barRange>0?(high-close)/barRange:0;
  const atr=dm.atrDaily||barRange||1;
  const extAtr=atr>0?(close-rangeHigh)/atr:0;

  const closeOver=breakPct>=BO_T.BREAK_PCT, volOk=rvol>=BO_T.RVOL_MIN,
        locOk=closeLoc>=BO_T.CLOSE_LOC_MIN, wickOk=wickFrac<=BO_T.WICK_MAX,
        fresh=extAtr<=BO_T.FRESH_ATR_MAX && extAtr>=-0.75;

  let score=0;
  score += closeOver?35:boClamp(breakPct/BO_T.BREAK_PCT)*35;
  score += volOk?25:boClamp(rvol/BO_T.RVOL_MIN)*25;
  score += locOk?20:boClamp(closeLoc/BO_T.CLOSE_LOC_MIN)*20;
  score += wickOk?10:0;
  score += fresh?10:0;
  score = Math.round(Math.min(100, score));

  const fullTrigger = closeOver && volOk && locOk && wickOk && fresh;
  const earlyTrigger = !fullTrigger && fresh && breakPct>=-1 && rvol>=BO_T.EARLY_RVOL && closeLoc>=BO_T.EARLY_LOC;
  return { triggerScore:score, closeOver, volOk, locOk, wickOk, fresh, fullTrigger, earlyTrigger,
           rvol:+rvol.toFixed(2), breakPct:+breakPct.toFixed(2), closeLoc:+closeLoc.toFixed(2), rangeHigh:+rangeHigh.toFixed(2) };
}

// ════════════════════════════════════════════════════════════════════════════
// RUN SCANNER — client-side scan (this is what the button calls)
// ════════════════════════════════════════════════════════════════════════════
async function triggerBreakoutRun(){ return runBreakoutScan(); }

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
              const jd = jaxSignal(cd);  // JAX arrow on the DAILY timeframe
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
                tags, warnings, stack, distPct:+m.distPct.toFixed(1), atr:+m.atrDaily.toFixed(2), extended, stage:'S'+stage,
                jaxArrowD: jd?jd.longCond:false, jaxScoreD: jd?jd.bullScore:0, jaxRsiD: jd?jd.rsi:null,
                jaxArrow4:false, jaxScore4:0, jaxBoth:false };
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

  // ── LAYER 2 — 4H trigger on the qualified setups only ──────────────────────
  const setupSyms = Object.keys(setups);
  let trig4hOk=0;
  if(setupSyms.length && !boStopReq){
    let ti=0;
    for(const sym of setupSyms){
      if(boStopReq) break;
      ti++;
      if(st) st.textContent = '⏳ Layer 2 (4H trigger): '+ti+'/'+setupSyms.length+' · '+sym;
      const s = setups[sym];
      try{
        const c4 = await bo4HFetch(sym, 0);
        if(c4){
          trig4hOk++;
          const j4 = jaxSignal(c4);  // JAX arrow on the 4H timeframe
          if(j4){ s.jaxArrow4 = j4.longCond; s.jaxScore4 = j4.bullScore; }
          s.jaxBoth = !!(s.jaxArrowD && s.jaxArrow4);
          const tg = boTriggerEval(c4, { atrDaily:s.atr });
          if(tg){
            s.triggerScore = tg.triggerScore;
            const dailyConfirm = !s.extended && s.distPct <= 2;   // daily at new-high & fresh
            s.stack = s.stack.map(p=>{
              if(p.k==='CLOSE') return { k:'CLOSE', on: tg.closeOver && tg.locOk };
              if(p.k==='DAILY') return { k:'DAILY', on: dailyConfirm };
              return p;
            });
            if(!s.extended){
              if(tg.fullTrigger && dailyConfirm) s.tier='A+';
              else if(tg.fullTrigger || tg.earlyTrigger) s.tier='EARLY';
              else s.tier='WATCH';
            } else { s.tier='WATCH'; }
            if(tg.fullTrigger && s.tags.indexOf('TRIGGER')<0) s.tags.unshift('TRIGGER');
            s.trig = { rvol:tg.rvol, breakPct:tg.breakPct, closeLoc:tg.closeLoc };
          }
        }
      }catch(e){}
      boSetups = Object.assign({}, setups); renderBreakout();
      await new Promise(r=>setTimeout(r, 200));
    }
  }

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
  if(st){
    const aplus = Object.values(setups).filter(x=>x.tier==='A+').length;
    const early = Object.values(setups).filter(x=>x.tier==='EARLY').length;
    if(setupSyms.length && trig4hOk===0){
      st.textContent = '⚠️ '+scored+' setups · Layer 2 could NOT fetch 4H data (0/'+setupSyms.length+') — names stay WATCH. Tell Claude.';
    } else {
      st.textContent = '✅ '+scored+' setups · 4H '+trig4hOk+'/'+setupSyms.length+' · '+aplus+' A+ · '+early+' EARLY · '+new Date().toLocaleTimeString();
    }
  }
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
    const pips  = (s.stack||[]).map(p=>`<div class="bo-pip ${p.on?'on':''}" style="flex:1 1 0;min-width:0;width:auto"><i></i><b style="font-size:7px;letter-spacing:0;white-space:nowrap">${p.k}</b></div>`).join('');
    const tags  = (s.tags||[]).map(t=>`<span class="bo-tag">${(''+t).replace(/_/g,' ')}</span>`).join('');
    const warns = (s.warnings||[]).map(w=>`<span class="bo-tag warn">${w}</span>`).join('');
    const jax = s.jaxBoth
      ? `<span class="bo-tag" style="border-color:#00e676;background:rgba(0,230,118,.12);color:#00e676;font-weight:700">⚡ JAX D+4H · ${s.jaxScoreD||0}/5</span>`
      : (s.jaxArrowD ? `<span class="bo-tag" style="border-color:rgba(0,176,255,.35);background:rgba(0,176,255,.06);color:#7fd4ff">JAX Daily · ${s.jaxScoreD||0}/5</span>`
      : (s.jaxArrow4 ? `<span class="bo-tag" style="border-color:rgba(255,179,0,.35);background:rgba(255,179,0,.06);color:#ffce6b">JAX 4H · ${s.jaxScore4||0}/5</span>` : ''));
    const p     = s.parts || {};
    const bar = (lbl,v,m,clr)=>`<div class="bo-bar"><span class="bo-bl">${lbl}</span>`
      +`<span class="bo-bt"><span class="bo-bf" style="width:${Math.round(((v||0)/m)*100)}%;background:${clr}"></span></span>`
      +`<span class="bo-bv">${(v||0).toFixed(0)}/${m}</span></div>`;
    const tClr = boTierClr(s.tier);
    return `<div class="bo-card ${boTierCls(s.tier)}" onclick="window.open('https://www.tradingview.com/chart/?symbol='+encodeURIComponent('${s.sym}'),'_blank')">
      <div class="bo-row1" style="flex-wrap:nowrap;min-width:0">
        <span class="bo-tkr" style="white-space:nowrap;flex-shrink:0">${tickerLogo(s.sym,20)}${s.sym}</span>
        <span class="bo-px" style="flex-shrink:0">$${(s.close||0).toFixed(2)}</span>
        <span class="bo-stars" style="flex-shrink:0;margin-left:auto">${boStars(s.stars||1)}</span>
      </div>
      <div class="bo-row2">
        <span class="bo-sc"><b>${s.setupScore||0}</b> setup</span>
        <span class="bo-sc"><b>${s.triggerScore||'—'}</b> trig</span>
      </div>
      <div class="bo-stack" style="margin-left:0;margin-top:10px;width:100%;display:flex;flex-wrap:nowrap;gap:2px">${pips}</div>
      <div class="bo-bars">
        ${bar('Base',p.base,30,'var(--green2)')}
        ${bar('Vol',p.vol,25,'#00bcd4')}
        ${bar('Trend',p.trend,20,'var(--blue)')}
        ${bar('RS',p.rs,15,'#CE93D8')}
        ${bar('Prox',p.prox,10,'var(--yellow)')}
      </div>
      ${(tags||warns||jax)?`<div class="bo-detail">${jax}${tags}${warns}</div>`:''}
      <div class="bo-footer">
        <span style="font-size:8px;color:var(--muted2);font-family:var(--mono)">${s.stage||''}${s.extended?' · EXTENDED':''}</span>
        <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
          <span class="bo-tier" style="color:${tClr};border-color:${tClr};white-space:nowrap">${s.tier}</span>
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

  const subEl = document.getElementById('bo-sub');
  if(subEl) subEl.textContent = 'DAILY SETUP → 4H TRIGGER → DAILY CONFIRM · v11';

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
console.log('%c🚀 breakout.js v11 loaded — JAX arrow + button fix', 'color:#00b0ff;font-weight:700');
