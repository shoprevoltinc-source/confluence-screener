// ── JAX PRO Scanner — GitHub Action
// Runs at 12:00pm and 3:30pm ET on weekdays
// Scans all 658 stocks, detects green arrows, saves to Firebase
// Exact port of Pine Script JAX PRO Strategy v5

const https = require('https');

// ── Config from environment ────────────────────────────────
// TD_KEYS secret = comma-separated list of all keys
// Supports both comma-separated and newline-separated keys
const TD_KEYS = (process.env.TD_KEYS || '').split(/[,\n]/).map(k=>k.trim()).filter(Boolean);
const FIREBASE_URL = process.env.FIREBASE_DB_URL; // matches your existing secret name

// ── Full 658 stock universe ────────────────────────────────
const SP500 = [
  "MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A","APD","ABNB","AKAM","ALB","ARE",
  "ALGN","ALLE","LNT","ALL","GOOGL","GOOG","MO","AMZN","AMCR","AEE","AAL","AEP","AXP","AIG",
  "AMT","AWK","AMP","AME","AMGN","APH","ADI","ANSS","AON","APA","AAPL","AMAT","APTV","ACGL",
  "ADM","ANET","AJG","AIZ","T","ATO","ADSK","ADP","AZO","AVB","AVY","AXON","BKR","BALL","BAC",
  "BAX","BDX","WRB","BBY","BIO","TECH","BIIB","BLK","BX","BA","BCH","BSX","BMY","AVGO","BR",
  "BRO","BF.B","BLDR","BG","CDNS","CZR","CPT","CPB","COF","CAH","KMX","CCL","CARR","CTLT",
  "CAT","CBOE","CBRE","CDW","CE","COR","CNC","CNP","CF","CHRW","CRL","SCHW","CHTR","CVX",
  "CMG","CB","CHD","CI","CINF","CTAS","CSCO","C","CFG","CLX","CME","CMS","KO","CTSH","CL",
  "CMCSA","CAG","COP","ED","STZ","CEG","COO","CPRT","GLW","CPAY","CTVA","CSGP","COST","CTRA",
  "CRWD","CCI","CSX","CMI","CVS","DHR","DRI","DVA","DE","DAL","XRAY","DVN","DXCM","FANG",
  "DLR","DFS","DG","DLTR","D","DPZ","DOV","DOW","DHI","DTE","DUK","DD","EMN","ETN","EBAY",
  "ECL","EIX","EW","EA","ELV","LLY","EMR","ENPH","ETR","EOG","EPAM","EQT","EFX","EQIX","EQR",
  "ESS","EL","ETSY","EG","EVRST","ES","EXC","EXPE","EXPD","EXR","XOM","FFIV","FDS","FICO",
  "FAST","FRT","FDX","FIS","FITB","FSLR","FE","FMC","F","FTNT","FTV","FOXA","FOX","BEN","FCX",
  "GRMN","IT","GE","GEHC","GEV","GEN","GNRC","GD","GIS","GM","GPC","GILD","GPN","GL","GDDY",
  "GS","HAL","HIG","HAS","HCA","DOC","HSIC","HSY","HES","HPE","HLT","HOLX","HD","HON","HRL",
  "HST","HWM","HPQ","HUBB","HUM","HBAN","HII","IBM","IEX","IDXX","ITW","INCY","IR","PODD",
  "INTC","ICE","IFF","IP","IPG","INTU","ISRG","IVZ","INVH","IQV","IRM","JBHT","JBL","JKHY",
  "J","JNJ","JCI","JPM","JNPR","K","KVUE","KDP","KEY","KEYS","KMB","KIM","KMI","KLAC","KHC",
  "KR","LHX","LH","LRCX","LW","LVS","LDOS","LEN","LII","LLY","LIN","LYV","LKQ","LMT","L",
  "LOW","LULU","LYB","MTB","MRO","MPC","MKTX","MAR","MMC","MLM","MAS","MA","MTCH","MKC","MCD",
  "MCK","MDT","MRK","META","MET","MTD","MGM","MCHP","MU","MSFT","MAA","MRNA","MHK","MOH","TAP",
  "MDLZ","MPWR","MNST","MCO","MS","MOS","MSI","MSCI","NDAQ","NTAP","NOV","NWS","NWSA","NBIX",
  "NEM","NFLX","NI","NDSN","NSC","NTRS","NOC","NCLH","NRG","NUE","NVDA","NVR","NXPI","ORLY",
  "OXY","ODFL","OMC","ON","OKE","ORCL","OTIS","PCAR","PKG","PLTR","PH","PAYX","PAYC","PYPL",
  "PNR","PEP","PFE","PCG","PM","PSX","PNW","PNC","POOL","PPG","PPL","PFG","PG","PGR","PLD",
  "PRU","PEG","PTC","PSA","PHM","QRVO","PWR","QCOM","DGX","RL","RJF","RTX","O","REG","REGN",
  "RF","RSG","RMD","RVTY","ROK","ROL","ROP","ROST","RCL","SPGI","CRM","SBAC","SLB","STX","SRE",
  "NOW","SHW","SPG","SWKS","SJM","SNA","SOLV","SO","LUV","SWK","SBUX","STT","STLD","STE","SYK",
  "SMCI","SYF","SNPS","SYY","TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL","TDY","TFX","TER",
  "TSLA","TXN","TXT","TMO","TJX","TSCO","TT","TDG","TRV","TRMB","TFC","TYL","TSN","USB","UBER",
  "UDR","ULTA","UNP","UAL","UPS","URI","UNH","UHS","VLO","VTR","VLTO","VRSN","VRSK","VZ","VRTX",
  "VTRS","VICI","V","VST","VMC","WRK","WAB","WMT","WBD","WM","WAT","WEC","WFC","WELL","WST",
  "WDC","WHR","WMB","WTW","GWW","WYNN","XEL","XYL","YUM","ZBRA","ZBH","ZTS"
];

const SMALLCAP = [
  "NVTS","SMTC","IONQ","CRDO","QUBT","AMBA","PENN","FATE","MGNX","CLFD","PLUG","DDOG",
  "PGNY","NVCR","MRAM","CDNS","WST","TMUS","BEN","MNST","QCOM","PANW","NTAP","FTNT",
  "HUM","DVA","CRWD","CNC","D","ELV","GOOG","MGNX","CLSK","DQ","HOOD","LMND","AMRC",
  "RXRX","QBTS","VRNT","BLUE","VERV","SAGE","NOVA","FORM","ACCD","SMAR","DISH","NVRO",
  "CASA","CANO","FYBR","INFN","DZSI","SATS","VIAV","EDIT","NTLA","CRSP","ALLO","OCGN",
  "HIMS","AIZ","IPG","K","MRO","PARA","DFS","POET","GOGO","SMAR","NVCR","SPSC"
];

const ALL_TICKERS = [...new Set([...SP500, ...SMALLCAP])];

// ── Helpers ───────────────────────────────────────────────
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function fetchJSON(url){
  return new Promise((resolve, reject)=>{
    https.get(url, res=>{
      let data = '';
      res.on('data', chunk=> data+=chunk);
      res.on('end', ()=>{
        try{ resolve(JSON.parse(data)); }
        catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}

function httpRequest(url, method='GET', body=null, headers={}){
  return new Promise((resolve, reject)=>{
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = https.request(options, res=>{
      let data = '';
      res.on('data', chunk=> data+=chunk);
      res.on('end', ()=>{
        try{ resolve(JSON.parse(data)); }
        catch(e){ resolve(data); }
      });
    });
    req.on('error', reject);
    if(body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Indicator functions (exact port from HTML) ─────────────
function calcEMA(c, p=21){
  if(c.length < p) return c[c.length-1];
  const k = 2/(p+1);
  let e = c.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p; i<c.length; i++) e = c[i]*k + e*(1-k);
  return e;
}

function calcRSI(c, p=14){
  if(c.length < p+1) return 50;
  let ag=0, al=0;
  for(let i=1; i<=p; i++){ const d=c[i]-c[i-1]; d>=0?ag+=d:al-=d; }
  ag/=p; al/=p;
  for(let i=p+1; i<c.length; i++){
    const d=c[i]-c[i-1];
    ag=(ag*(p-1)+Math.max(d,0))/p;
    al=(al*(p-1)+Math.max(-d,0))/p;
  }
  return al===0?100:100-100/(1+ag/al);
}

function calcMACD(closes, fast=12, slow=26, signal=9){
  if(closes.length < slow+signal) return {hist:0};
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast - emaSlow;
  const macdSeries = [];
  for(let i=slow; i<=closes.length; i++){
    const ef = calcEMA(closes.slice(0,i), fast);
    const es = calcEMA(closes.slice(0,i), slow);
    macdSeries.push(ef - es);
  }
  const signalLine = calcEMA(macdSeries, signal);
  return {hist: macdLine - signalLine};
}

function calcSuperTrend(highs, lows, closes, factor=1.5, period=10){
  if(closes.length < period+1) return {bullish:false, flipped:false};
  const atrVals = [];
  for(let i=1; i<closes.length; i++){
    const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    atrVals.push(tr);
  }
  const getATR = (idx)=>{
    const slice = atrVals.slice(Math.max(0,idx-period), idx);
    return slice.reduce((a,b)=>a+b,0)/slice.length;
  };
  const stHistory = [];
  for(let i=period; i<closes.length; i++){
    const atr = getATR(i);
    const hl2 = (highs[i]+lows[i])/2;
    const upperBand = hl2 + factor*atr;
    const lowerBand = hl2 - factor*atr;
    const prevST = stHistory.length>0 ? stHistory[stHistory.length-1] : null;
    const prevDir = prevST ? prevST.dir : 1;
    let newST, newDir;
    if(!prevST){ newST=lowerBand; newDir=1; }
    else if(prevDir===1){
      newST = Math.max(prevST.val, lowerBand);
      newDir = closes[i] > newST ? 1 : -1;
      if(newDir===-1) newST = upperBand;
    } else {
      newST = Math.min(prevST.val, upperBand);
      newDir = closes[i] < newST ? -1 : 1;
      if(newDir===1) newST = lowerBand;
    }
    stHistory.push({val:newST, dir:newDir});
  }
  const last = stHistory[stHistory.length-1];
  const prev = stHistory[stHistory.length-2];
  return {
    bullish: last && last.dir===1,
    flipped: last && prev && last.dir===1 && prev.dir===-1
  };
}

function calcATRTrailStop(highs, lows, closes, period=10, mult=3.5){
  if(closes.length < period+2) return {utBuy:false, utSell:false, trailVal:closes[closes.length-1]};
  const atrVals = [];
  for(let i=1; i<closes.length; i++){
    const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    atrVals.push(tr);
  }
  const getATR = (idx)=>{
    const slice = atrVals.slice(Math.max(0,idx-period), idx);
    return slice.reduce((a,b)=>a+b,0)/Math.max(slice.length,1);
  };
  let trail = closes[0], tdir = 0;
  const trailHistory = [];
  for(let i=1; i<closes.length; i++){
    const atrV   = getATR(i);
    const nLoss  = mult * atrV;
    const trailUp   = closes[i] - nLoss;
    const trailDown = closes[i] + nLoss;
    const prevTrail = trail;
    if(closes[i] > trail && closes[i-1] > trail)      trail = Math.max(trail, trailUp);
    else if(closes[i] < trail && closes[i-1] < trail) trail = Math.min(trail, trailDown);
    else if(closes[i] > trail)                         trail = trailUp;
    else                                               trail = trailDown;
    const prevDir = tdir;
    tdir = trail > prevTrail ? 1 : trail < prevTrail ? -1 : tdir;
    trailHistory.push({trail, tdir, prevDir});
  }
  const last = trailHistory[trailHistory.length-1];
  const prev = trailHistory[trailHistory.length-2]||{tdir:0};
  return {
    utBuy:    last.tdir===1  && prev.tdir===-1,
    utSell:   last.tdir===-1 && prev.tdir===1,
    trailVal: last.trail
  };
}

function calcJAXPRO(closes, highs, lows){
  if(closes.length < 70) return null;
  const ema20 = calcEMA(closes, 20);
  const ema40 = calcEMA(closes, 40);
  const ema60 = calcEMA(closes, 60);
  const price = closes[closes.length-1];
  const rsi14 = calcRSI(closes, 14);
  const hh    = Math.max(...highs.slice(-14));
  const ll    = Math.min(...lows.slice(-14));
  const wr14  = hh===ll ? -50 : ((hh-price)/(hh-ll))*-100;
  const {hist} = calcMACD(closes);
  const st     = calcSuperTrend(highs, lows, closes, 1.5, 10);
  const atrTS  = calcATRTrailStop(highs, lows, closes, 10, 3.5);
  const emaStack  = price > ema20 && ema20 > ema40 && ema40 > ema60;
  const macdBull  = hist > 0;
  const rsiBull   = rsi14 > 50;
  const wrBull    = wr14 > -50;
  const stBull    = st.bullish;
  const bullScore = (emaStack?1:0)+(macdBull?1:0)+(rsiBull?1:0)+(wrBull?1:0)+(stBull?1:0);
  const greenArrow = (atrTS.utBuy || st.flipped) && bullScore >= 1 && rsi14 < 70;
  return { greenArrow, bullScore, rsi14, trailVal: atrTS.trailVal, utBuy: atrTS.utBuy, stFlipped: st.flipped };
}

// ── Fetch daily candles from Twelve Data ──────────────────
async function fetchCandles(sym, keyIndex){
  const key = TD_KEYS[keyIndex % TD_KEYS.length];
  const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=120&apikey=${key}`;
  const d   = await fetchJSON(url);
  if(!d.values || d.status==='error') return null;
  const vals = [...d.values].reverse();
  return {
    closes:  vals.map(v=>parseFloat(v.close)),
    highs:   vals.map(v=>parseFloat(v.high)),
    lows:    vals.map(v=>parseFloat(v.low)),
  };
}

// ── Save results to Firebase ──────────────────────────────
async function saveToFirebase(key, data){
  const url = `${FIREBASE_URL}/${key}.json`;
  await httpRequest(url, 'PUT', { data, savedAt: new Date().toISOString(), device: 'github-action' });
}

// ── Main scanner ──────────────────────────────────────────
async function main(){
  console.log(`🔍 JAX Scanner starting — ${ALL_TICKERS.length} stocks — ${new Date().toISOString()}`);
  console.log(`📡 Using ${TD_KEYS.length} API keys`);
  console.log(`🔑 Keys detected: ${TD_KEYS.map(k=>k.substring(0,8)+'...').join(', ')||'NONE'}`);

  if(!TD_KEYS.length){
    console.error('❌ No API keys found. Check TD_KEYS secret in GitHub — must be comma or newline separated.');
    process.exit(1);
  }

  const fired   = [];
  const errors  = [];
  const DELAY   = 10000; // 10s between calls per worker
  const nKeys   = TD_KEYS.length;

  // Split tickers across keys — interleaved for even distribution
  const chunks = Array.from({length: nKeys}, ()=>[]);
  ALL_TICKERS.forEach((sym, i)=> chunks[i % nKeys].push(sym));

  async function runWorker(keyIdx, chunk){
    for(let i=0; i<chunk.length; i++){
      const sym = chunk[i];
      try{
        const candles = await fetchCandles(sym, keyIdx);
        if(!candles || candles.closes.length < 70){
          if(i < chunk.length-1) await sleep(DELAY);
          continue;
        }
        const jax = calcJAXPRO(candles.closes, candles.highs, candles.lows);
        if(jax && jax.greenArrow){
          const result = {
            sym,
            price:      candles.closes[candles.closes.length-1],
            bullScore:  jax.bullScore,
            rsi:        jax.rsi14,
            trailVal:   jax.trailVal,
            utBuy:      jax.utBuy,
            stFlipped:  jax.stFlipped,
            firedAt:    new Date().toISOString(),
          };
          fired.push(result);
          console.log(`🟢 GREEN ARROW: ${sym} @ $${result.price.toFixed(2)} bull${result.bullScore}/5 RSI${result.rsi.toFixed(0)}`);
        }
      }catch(e){
        if(!e.message?.includes('credits')) errors.push(sym);
      }
      if(i < chunk.length-1) await sleep(DELAY);
    }
  }

  // Run all workers in parallel
  await Promise.all(chunks.map((chunk, ki)=> runWorker(ki, chunk)));

  console.log(`\n✅ Scan complete — ${fired.length} green arrows fired`);
  if(fired.length){
    fired.forEach(r=> console.log(`  → ${r.sym} $${r.price.toFixed(2)} bull${r.bullScore}/5`));
  }
  if(errors.length) console.log(`⚠️  Skipped ${errors.length} stocks (API limits)`);

  // Save to Firebase
  const payload = {
    data: fired,
    time: new Date().toISOString(),
    totalScanned: ALL_TICKERS.length,
    checkTime: new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York'})
  };
  await saveToFirebase('jax_cron_alerts', payload);
  console.log(`💾 Saved to Firebase — jax_cron_alerts`);
}

main().catch(e=>{ console.error('Fatal error:', e); process.exit(1); });
