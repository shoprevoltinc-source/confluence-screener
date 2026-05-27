// daily-full-scan.js — Full pre-market scanner
// Runs Recovery + Catalyst + JAX automatically every morning
// Saves to Firebase so agent has all data sources populated at Morning Brief
// Schedule: 6am ET weekdays (before market open)

const https = require("https");

// ── Config ─────────────────────────────────────────────────
const TD_KEYS = (process.env.TD_KEYS || "")
  .split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");

const SCAN_DELAY_MS = 10000;
const STAGGER_MS    = 1500;

if (!TD_KEYS.length) { console.error("❌ No TD_KEYS"); process.exit(1); }
if (!FIREBASE_DB_URL) { console.error("❌ No FIREBASE_DB_URL"); process.exit(1); }

// ── Universe ────────────────────────────────────────────────
const SP500 = ["MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A","APD","AKAM","ALB","ARE","ALGN","ALLE","LNT","ALL","GOOGL","GOOG","MO","AMZN","AMCR","AEE","AAL","AEP","AXP","AIG","AMT","AWK","AMP","AME","AMGN","APH","ADI","ANSS","AON","APA","AAPL","AMAT","APTV","ADM","ANET","AJG","AIZ","T","ATO","ADSK","ADP","AZO","AVB","AVY","BKR","BALL","BAC","BK","BBWI","BAX","BDX","WRB","BBY","BIO","BIIB","BLK","BX","BA","BKNG","BWA","BSX","BMY","AVGO","BR","BLDR","BG","CDNS","CPT","CPB","COF","CAH","KMX","CCL","CARR","CAT","CBOE","CBRE","CDW","CE","COR","CNC","CF","CRL","SCHW","CHTR","CVX","CMG","CB","CHD","CI","CINF","CTAS","CSCO","C","CFG","CLX","CME","CMS","KO","CTSH","CL","CMCSA","CAG","COP","ED","STZ","COO","CPRT","GLW","CTVA","CSGP","COST","CTRA","CRWD","CCI","CSX","CMI","CVS","DHR","DRI","DVA","DAY","DE","DAL","DVN","DXCM","FANG","DLR","DFS","DG","DLTR","D","DPZ","DOV","DOW","DHI","DTE","DUK","DD","EMN","ETN","EBAY","ECL","EIX","EW","EA","ELV","EMR","ENPH","ETR","EOG","EPAM","EQT","EFX","EQIX","EQR","ESS","EL","ETSY","EG","EVRG","ES","EXC","EXPE","EXPD","EXR","XOM","FFIV","FDS","FICO","FAST","FRT","FDX","FIS","FITB","FSLR","FE","FI","FMC","F","FTNT","FTV","FOXA","FOX","BEN","FCX","GRMN","IT","GE","GD","GIS","GM","GPC","GILD","GS","HAL","HIG","HAS","HCA","HSIC","HSY","HES","HPE","HLT","HOLX","HD","HON","HRL","HST","HWM","HPQ","HUBB","HUM","HBAN","HII","IBM","IEX","IDXX","ITW","INCY","IR","PODD","INTC","ICE","IFF","IP","IPG","INTU","ISRG","IVZ","IQV","IRM","JCI","JPM","K","KDP","KEY","KEYS","KMB","KIM","KMI","KLAC","KHC","KR","LHX","LH","LRCX","LW","LVS","LDOS","LEN","LLY","LIN","LYV","LKQ","LMT","L","LOW","LULU","LYB","MTB","MRO","MPC","MKTX","MAR","MMC","MLM","MAS","MA","MTCH","MKC","MCD","MCK","MDT","MRK","META","MET","MTD","MGM","MCHP","MU","MSFT","MAA","MRNA","MHK","MOH","TAP","MDLZ","MPWR","MNST","MCO","MS","MOS","MSI","MSCI","NDAQ","NTAP","NFLX","NEM","NEE","NKE","NI","NDSN","NSC","NTRS","NOC","NCLH","NRG","NUE","NVDA","NVR","NXPI","ORLY","OXY","ODFL","OMC","ON","OKE","ORCL","OTIS","PCAR","PKG","PLTR","PANW","PARA","PH","PAYX","PAYC","PYPL","PNR","PEP","PFE","PCG","PM","PSX","PNW","PNC","POOL","PPG","PPL","PFG","PG","PGR","PLD","PRU","PEG","PTC","PSA","PHM","PWR","QCOM","DGX","RL","RJF","RTX","O","REG","REGN","RF","RSG","RMD","RVTY","ROK","ROL","ROP","ROST","RCL","SPGI","CRM","SBAC","SLB","STX","SRE","NOW","SHW","SPG","SWKS","SJM","SNA","SO","LUV","SWK","SBUX","STT","STLD","STE","SYK","SYF","SNPS","SYY","TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL","TDY","TFX","TER","TSLA","TXN","TXT","TMO","TJX","TSCO","TT","TDG","TRV","TRMB","TFC","TYL","TSN","USB","UBER","UDR","ULTA","UNP","UAL","UPS","URI","UNH","UHS","VLO","VTR","VRSN","VRSK","VZ","VRTX","VTRS","V","VMC","WAB","WBA","WMT","DIS","WBD","WM","WAT","WEC","WFC","WELL","WST","WDC","WY","WMB","WTW","GWW","WYNN","XEL","XYL","YUM","ZBRA","ZBH","ZTS"];
const SMALLCAP = ["MRAM","KTOS","AVAV","RCAT","ACHR","JOBY","ASTS","LUNR","RDW","SPIR","BBAI","CDRE","QUBT","IONQ","RGTI","SOUN","ARQQ","QBTS","VRNT","MGNX","RXRX","DNLI","BEAM","EDIT","CRSP","NTLA","VERV","NUVL","ALLO","HIMS","OCGN","NVAX","VXRT","INO","PSNL","BLUE","ARVN","PRTA","IMVT","KYMR","PTGX","RCKT","SAGE","TGTX","IOVA","APLS","FOLD","DAWN","YMAB","NVTS","AMPX","SMTC","AAOI","COHU","FORM","ONTO","ACMR","PLAB","DIOD","VIAV","POWI","AEVA","LAZR","MVIS","OUST","WOLF","AMBA","SLAB","BLNK","CHPT","EVGO","STEM","ARRY","NOVA","SHLS","FLNC","BLDP","FCEL","PLUG","RUN","CSIQ","DQ","JKS","BE","CWEN","GPRE","AMRC","VNET","CLSK","IREN","HUT","MARA","SOFI","HOOD","AFRM","UPST","DAVE","MQ","LMND","ROOT","DKNG","PENN","RBLX","MSTR","CIFR","RIOT","FOUR","RELY","DDOG","ZS","GTLB","BILL","DOCS","BRZE","CFLT","ASAN","SMAR","WEAV","ALKT","JAMF","TASK","SPSC","TDOC","ACCD","PRVA","GDRX","PGNY","TMDX","NVCR","MRCY","GEVO","CLNE","REGI","AXON","SITM","AMKR","NVRO","FATE","DISH","LUMN","VSAT","IRDM","GSAT","SHEN","IDT","OOMA","GOGO","AVNW","CLFD","LITE","CIEN","INFN","CRDO","POET","ANGO","ADTN","CASA","DZSI","FYBR","CALX","COMM","NTGR","TMUS","SATS","SPOK","LPSN","MTTR","CEVA","DRS","CACI","SAIC","BWXT","SMCI","AEHR","ACLS","UCTT","KLIC","KRYS","VKTX","ARWR","EXAS","RKLB","DOMO","TSSI","MAXN","SPWR","LC","CACC","ENVA","QFIN","WKHS","MVST"];
const ALL = [...new Set([...SP500, ...SMALLCAP])];

// ── Helpers ─────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function firebasePut(path, payload) {
  return new Promise((resolve, reject) => {
    const url  = new URL(FIREBASE_DB_URL + "/" + path + ".json");
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>resolve(d)); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

async function fetchCandles(sym, keyIdx, outputsize = 120) {
  const key = TD_KEYS[keyIdx % TD_KEYS.length];
  const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=${outputsize}&apikey=${key}`;
  const d = await fetchJSON(url);
  if (d.status === "error") throw new Error(d.message || "API error");
  if (!d.values || !d.values.length) throw new Error("No data");
  const vals = [...d.values].reverse();
  return {
    closes:  vals.map(v => parseFloat(v.close)),
    highs:   vals.map(v => parseFloat(v.high)),
    lows:    vals.map(v => parseFloat(v.low)),
    volumes: vals.map(v => parseFloat(v.volume) || 0),
  };
}

// ── Indicators (exact port from index.html) ─────────────────
function calcEMA(c, p=21) {
  if (c.length < p) return c[c.length-1];
  const k = 2/(p+1);
  let e = c.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p; i<c.length; i++) e = c[i]*k + e*(1-k);
  return e;
}

function calcRSI(c, p=14) {
  if (c.length < p+1) return 50;
  let ag=0, al=0;
  for (let i=1; i<=p; i++) { const d=c[i]-c[i-1]; d>=0?ag+=d:al-=d; }
  ag/=p; al/=p;
  for (let i=p+1; i<c.length; i++) {
    const d=c[i]-c[i-1];
    ag=(ag*(p-1)+Math.max(d,0))/p;
    al=(al*(p-1)+Math.max(-d,0))/p;
  }
  return al===0?100:100-100/(1+ag/al);
}

function calcMACD(closes, fast=12, slow=26, signal=9) {
  if (closes.length < slow+signal) return { hist:0 };
  const macdSeries = [];
  for (let i=slow; i<=closes.length; i++) {
    macdSeries.push(calcEMA(closes.slice(0,i),fast) - calcEMA(closes.slice(0,i),slow));
  }
  const macdLine  = macdSeries[macdSeries.length-1];
  const signalLine = calcEMA(macdSeries, signal);
  return { hist: macdLine - signalLine };
}

function calcSuperTrend(highs, lows, closes, factor=1.5, period=10) {
  if (closes.length < period+1) return { bullish:false, flipped:false };
  const atrVals = [];
  for (let i=1; i<closes.length; i++) {
    atrVals.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const getATR = idx => atrVals.slice(Math.max(0,idx-period),idx).reduce((a,b)=>a+b,0)/Math.max(atrVals.slice(Math.max(0,idx-period),idx).length,1);
  const hist = [];
  for (let i=period; i<closes.length; i++) {
    const atr=getATR(i), hl2=(highs[i]+lows[i])/2;
    const ub=hl2+factor*atr, lb=hl2-factor*atr;
    const prev=hist.length>0?hist[hist.length-1]:null;
    const pd=prev?prev.dir:1;
    let ns,nd;
    if(!prev){ns=lb;nd=1;}
    else if(pd===1){ns=Math.max(prev.val,lb);nd=closes[i]>ns?1:-1;if(nd===-1)ns=ub;}
    else{ns=Math.min(prev.val,ub);nd=closes[i]<ns?-1:1;if(nd===1)ns=lb;}
    hist.push({val:ns,dir:nd});
  }
  const last=hist[hist.length-1], prev=hist[hist.length-2];
  return { bullish:last&&last.dir===1, flipped:last&&prev&&last.dir===1&&prev.dir===-1 };
}

function calcATRTrailStop(highs, lows, closes, period=10, mult=3.5) {
  if (closes.length < period+2) return { utBuy:false, utSell:false, trailVal:closes[closes.length-1] };
  const atrVals = [];
  for (let i=1; i<closes.length; i++) {
    atrVals.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const getATR = idx => { const s=atrVals.slice(Math.max(0,idx-period),idx); return s.reduce((a,b)=>a+b,0)/Math.max(s.length,1); };
  let trail=closes[0], tdir=0;
  const trailHist=[];
  for (let i=1; i<closes.length; i++) {
    const nLoss=mult*getATR(i), tu=closes[i]-nLoss, td=closes[i]+nLoss, pt=trail;
    if(closes[i]>trail&&closes[i-1]>trail) trail=Math.max(trail,tu);
    else if(closes[i]<trail&&closes[i-1]<trail) trail=Math.min(trail,td);
    else if(closes[i]>trail) trail=tu; else trail=td;
    const pd=tdir;
    tdir=trail>pt?1:trail<pt?-1:tdir;
    trailHist.push({trail,tdir,prevDir:pd});
  }
  const last=trailHist[trailHist.length-1], prev=trailHist[trailHist.length-2]||{tdir:0};
  return { utBuy:last.tdir===1&&prev.tdir===-1, utSell:last.tdir===-1&&prev.tdir===1, trailVal:last.trail };
}

function calcATR(highs, lows, closes, period=14) {
  if (highs.length < period+1) return { currentATR:0, avgATR20:0, isCoiling:false };
  const trs=[];
  for (let i=1; i<closes.length; i++) {
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const currentATR=trs.slice(-period).reduce((a,b)=>a+b,0)/period;
  const atrSeries=[];
  for (let i=period; i<=trs.length; i++) atrSeries.push(trs.slice(i-period,i).reduce((a,b)=>a+b,0)/period);
  const avgATR20=atrSeries.slice(-20).reduce((a,b)=>a+b,0)/Math.min(atrSeries.length,20);
  return { currentATR, avgATR20, isCoiling: currentATR < avgATR20 };
}

function calcJAXPRO(closes, highs, lows) {
  if (closes.length < 70) return null;
  const ema20=calcEMA(closes,20), ema40=calcEMA(closes,40), ema60=calcEMA(closes,60);
  const price=closes[closes.length-1], rsi14=calcRSI(closes,14);
  const hh=Math.max(...highs.slice(-14)), ll=Math.min(...lows.slice(-14));
  const wr14=hh===ll?-50:((hh-price)/(hh-ll))*-100;
  const {hist}=calcMACD(closes);
  const st=calcSuperTrend(highs,lows,closes,1.5,10);
  const atrTS=calcATRTrailStop(highs,lows,closes,10,3.5);
  const emaStack=price>ema20&&ema20>ema40&&ema40>ema60;
  const macdBull=hist>0, rsiBull=rsi14>50, wrBull=wr14>-50, stBull=st.bullish;
  const bullScore=(emaStack?1:0)+(macdBull?1:0)+(rsiBull?1:0)+(wrBull?1:0)+(stBull?1:0);
  const greenArrow=(atrTS.utBuy||st.flipped)&&bullScore>=1&&rsi14<70;
  return { greenArrow, bullScore, rsi14, trailVal:atrTS.trailVal, emaStack, macdBull, rsiBull, wrBull, stBull, atrTS, st };
}

// ── scoreRecovery (exact port) ───────────────────────────────
function scoreRecovery(sym, closes, highs, lows) {
  if (closes.length < 36) throw new Error("Not enough bars");
  const price=closes[closes.length-1], prev=closes[closes.length-2];
  const change=((price-prev)/prev)*100;
  const rsi=calcRSI(closes,14);
  const ema21=calcEMA(closes,21), ema21old=calcEMA(closes.slice(0,-5),21);
  const emaRising=ema21>ema21old;
  const hh=Math.max(...highs.slice(-14)), ll=Math.min(...lows.slice(-14));
  const wr=hh===ll?-50:((hh-price)/(hh-ll))*-100;
  const high52=Math.max(...highs);
  const pctHi=(price-high52)/high52*100;
  const pctEMA=(price-ema21)/ema21*100;
  const c1=rsi<45,c2=wr<-65,c3=price>ema21,c4=emaRising,c5=pctEMA>-10,c6=pctHi<-25;
  const score=[c1,c2,c3,c4,c5,c6].filter(Boolean).length;
  // C7 deep bounce
  const minRSI30=Math.min(...closes.slice(-30).map((_,i,a)=>i>0?calcRSI(closes.slice(0,closes.length-30+i+1),14):50));
  const rsi5ago=calcRSI(closes.slice(0,-5),14);
  const c7crash=pctHi<-50, c7rsiWas=minRSI30<45, c7rsiUp=rsi>rsi5ago+5;
  const deepBounce=c7crash&&c7rsiWas&&c7rsiUp;
  const jax=closes.length>=70?calcJAXPRO(closes,highs,lows):null;
  return {
    sym, price, change, rsi, wr, ema21, emaRising, high52, pctHi, pctEMA,
    c1,c2,c3,c4,c5,c6, score,
    c7:deepBounce, deepCrash:c7crash, c7crash, c7rsiWas, c7rsiUp, minRSI30, rsi5ago,
    greenArrow: jax?jax.greenArrow:false,
    bullScore:  jax?jax.bullScore:0,
    trailVal:   jax?jax.trailVal:0,
  };
}

// ── scoreCatalyst (exact port — no Finnhub RVOL in Action) ──
function scoreCatalyst(sym, closes, highs, lows, volumes) {
  if (closes.length < 30) throw new Error("Not enough bars");
  const price=closes[closes.length-1], prev=closes[closes.length-2];
  if (!price||!prev||price<=0) throw new Error("SKIP:invalid price");
  const change=((price-prev)/prev)*100;
  const atrData=calcATR(highs,lows,closes);
  const atrCoiling=atrData.isCoiling;
  const todayVol=volumes[volumes.length-1];
  const avgVol20=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const dailySpike=avgVol20>0?todayVol/avgVol20:0;
  const volDryUp=(volumes.slice(-6,-1).reduce((a,b)=>a+b,0)/5)<avgVol20*0.6;
  const last15H=Math.max(...highs.slice(-15)), last15L=Math.min(...lows.slice(-15));
  const rangeWidth=last15H>0?(last15H-last15L)/last15L*100:999;
  const isTight=rangeWidth<15;
  let flatDaysCount=0;
  for (let i=closes.length-2;i>=0;i--) { if(Math.abs(closes[i]-price)/price<0.06) flatDaysCount++; else break; }
  const high20=Math.max(...highs.slice(-21,-1));
  const breakout=price>high20*1.02;
  const low52=Math.min(...lows), high52=Math.max(...highs);
  const pctFromLow=((price-low52)/low52)*100;
  const pctFromHigh=((price-high52)/high52)*100;
  const nearLow=pctFromLow<50;
  const rsi=calcRSI(closes,14);
  const c1=price>=2&&price<=200;
  const c2=atrCoiling||(isTight&&flatDaysCount>=8);
  const c3=dailySpike>=2||volDryUp;
  const c4=breakout||Math.abs(change)>8;
  const c5=nearLow||pctFromHigh<-20;
  const c6=rsi<55;
  const score=[c1,c2,c3,c4,c5,c6].filter(Boolean).length;
  let heat=score;
  if(atrCoiling&&volDryUp) heat+=2;
  const jax=closes.length>=70?calcJAXPRO(closes,highs,lows):null;
  const greenArrow=jax?jax.greenArrow:false;
  const bullScore=jax?jax.bullScore:0;
  if(greenArrow) heat+=3;
  const status=greenArrow?"🟢 JAX SIGNAL":atrCoiling&&volDryUp?"⏳ COILING":atrCoiling?"⏳ WATCHING":"📡 MONITOR";
  return {
    sym, price, change, status, heat, score,
    atrCoiling, dailySpike, volDryUp, isTight, flatDays:flatDaysCount,
    breakout, pctFromHigh, pctFromLow, nearLow, rsi,
    greenArrow, bullScore, trailVal:jax?jax.trailVal:0,
    c1,c2,c3,c4,c5,c6, volSpike:dailySpike,
    currentATR:atrData.currentATR, avgATR20:atrData.avgATR20,
  };
}

// ── Save to Firebase ─────────────────────────────────────────
async function fbSave(key, results, meta={}) {
  const payload = {
    data:    JSON.stringify(results),
    savedAt: new Date().toISOString(),
    device:  "github-actions-daily",
    ...meta
  };
  await firebasePut("screener/" + key, payload);
  console.log(`✅ Saved ${results.length} results → screener/${key}`);
}

// ── Scanner runner ───────────────────────────────────────────
async function runScanner(name, universe, scoreFn, filter, keyOffset=0) {
  const results=[], errors=[];
  let done=0;
  const total=universe.length;
  const chunks = TD_KEYS.map((_,ki) => universe.filter((_,idx) => idx % TD_KEYS.length === ki));

  async function worker(keyIdx, chunk) {
    if (keyIdx > 0) await sleep(keyIdx * STAGGER_MS);
    for (let i=0; i<chunk.length; i++) {
      const sym=chunk[i];
      let retries=2;
      while (retries>=0) {
        try {
          const candles = await fetchCandles(sym, keyIdx+keyOffset);
          done++;
          const result = scoreFn(sym, candles.closes, candles.highs, candles.lows, candles.volumes);
          if (filter(result)) {
            results.push(result);
            console.log(`  ✅ ${name} ${sym} score:${result.score||result.confScore||"?"} heat:${result.heat||""}`);
          }
          if (done % 100 === 0) console.log(`  ... ${done}/${total} scanned, ${results.length} hits`);
          break;
        } catch(e) {
          if (e.message&&e.message.includes("credits")) {
            if (retries>0) { await sleep(60000); retries--; continue; }
            done++;
          } else if (e.message&&(e.message.startsWith("SKIP:")||e.message.includes("not found"))) {
            done++; break;
          } else {
            done++; errors.push({sym,error:e.message});
          }
          break;
        }
      }
      if (i < chunk.length-1) await sleep(SCAN_DELAY_MS);
    }
  }

  console.log(`\n🔍 ${name} — scanning ${total} stocks with ${TD_KEYS.length} keys`);
  await Promise.all(chunks.map((chunk,ki) => worker(ki, chunk)));
  console.log(`  📊 ${name} done — ${results.length} hits, ${errors.length} errors`);
  return results;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`🌅 Daily Full Scan — ${new Date().toISOString()}`);
  console.log(`📡 ${TD_KEYS.length} keys, ${ALL.length} stocks`);

  // ── 1. JAX Scanner — all 685 stocks, green arrows ──────────
  const jaxResults = await runScanner(
    "JAX",
    ALL,
    (sym, closes, highs, lows) => {
      const jax = calcJAXPRO(closes, highs, lows);
      if (!jax) return null;
      return { sym, price:closes[closes.length-1], bullScore:jax.bullScore, rsi:jax.rsi14, trailVal:jax.trailVal, utBuy:jax.atrTS.utBuy, stFlipped:jax.st.flipped, greenArrow:jax.greenArrow, firedAt:new Date().toISOString() };
    },
    r => r && r.greenArrow,
    0
  );
  await fbSave("jax_scan", jaxResults);
  await fbSave("jax_cron_alerts", jaxResults);

  console.log("\n⏳ Cooling down 2 minutes before Recovery scan...");
  await sleep(120000);

  // ── 2. Recovery Scanner — SP500 only, score >= 3 or C7 ─────
  const recoveryResults = await runScanner(
    "Recovery",
    SP500,
    (sym, closes, highs, lows) => scoreRecovery(sym, closes, highs, lows),
    r => r && (r.score >= 3 || r.c7),
    0
  );
  await fbSave("recovery", recoveryResults);

  console.log("\n⏳ Cooling down 2 minutes before Catalyst scan...");
  await sleep(120000);

  // ── 3. Catalyst Scanner — smallcap universe, coiling stocks ─
  const catalystResults = await runScanner(
    "Catalyst",
    SMALLCAP,
    (sym, closes, highs, lows, volumes) => scoreCatalyst(sym, closes, highs, lows, volumes),
    r => r && r.atrCoiling && r.score >= 2,
    0
  );
  await fbSave("catalyst", catalystResults);

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n🏁 Daily full scan complete`);
  console.log(`  🟢 JAX green arrows: ${jaxResults.length}`);
  console.log(`  📈 Recovery signals: ${recoveryResults.length}`);
  console.log(`  ⚡ Catalyst coils:   ${catalystResults.length}`);
  console.log(`\nAgent is ready. All 3 sources populated in Firebase.`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
