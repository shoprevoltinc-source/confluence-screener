// ── JAX PRO Scanner — GitHub Action
// Scans all stocks, detects green arrows, saves to Firebase
// Exact port of Pine Script JAX PRO Strategy v5

const https = require('https');

// ── Config from environment ────────────────────────────────
const TD_KEYS = (process.env.TD_KEYS || '').split(/[,\n]/).map(k=>k.trim()).filter(Boolean);
const FIREBASE_URL = process.env.FIREBASE_DB_URL;

// ── Full stock universe ────────────────────────────────────
const SP500 = ["MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A","APD","AKAM","ALB","ARE","ALGN","ALLE","LNT","ALL","GOOGL","GOOG","MO","AMZN","AMCR","AEE","AAL","AEP","AXP","AIG","AMT","AWK","AMP","AME","AMGN","APH","ADI","ANSS","AON","APA","AAPL","AMAT","APTV","ADM","ANET","AJG","AIZ","T","ATO","ADSK","ADP","AZO","AVB","AVY","BKR","BALL","BAC","BK","BBWI","BAX","BDX","WRB","BRK/B","BBY","BIO","BIIB","BLK","BX","BA","BKNG","BWA","BSX","BMY","AVGO","BR","BLDR","BG","CDNS","CPT","CPB","COF","CAH","KMX","CCL","CARR","CAT","CBOE","CBRE","CDW","CE","COR","CNC","CF","CRL","SCHW","CHTR","CVX","CMG","CB","CHD","CI","CINF","CTAS","CSCO","C","CFG","CLX","CME","CMS","KO","CTSH","CL","CMCSA","CAG","COP","ED","STZ","COO","CPRT","GLW","CTVA","CSGP","COST","CTRA","CRWD","CCI","CSX","CMI","CVS","DHR","DRI","DVA","DAY","DE","DAL","DVN","DXCM","FANG","DLR","DFS","DG","DLTR","D","DPZ","DOV","DOW","DHI","DTE","DUK","DD","EMN","ETN","EBAY","ECL","EIX","EW","EA","ELV","EMR","ENPH","ETR","EOG","EPAM","EQT","EFX","EQIX","EQR","ESS","EL","ETSY","EG","EVRG","ES","EXC","EXPE","EXPD","EXR","XOM","FFIV","FDS","FICO","FAST","FRT","FDX","FIS","FITB","FSLR","FE","FI","FMC","F","FTNT","FTV","FOXA","FOX","BEN","FCX","GRMN","IT","GE","GD","GIS","GM","GPC","GILD","GS","HAL","HIG","HAS","HCA","HSIC","HSY","HES","HPE","HLT","HOLX","HD","HON","HRL","HST","HWM","HPQ","HUBB","HUM","HBAN","HII","IBM","IEX","IDXX","ITW","INCY","IR","PODD","INTC","ICE","IFF","IP","IPG","INTU","ISRG","IVZ","IQV","IRM","JCI","JPM","K","KDP","KEY","KEYS","KMB","KIM","KMI","KLAC","KHC","KR","LHX","LH","LRCX","LW","LVS","LDOS","LEN","LLY","LIN","LYV","LKQ","LMT","L","LOW","LULU","LYB","MTB","MRO","MPC","MKTX","MAR","MMC","MLM","MAS","MA","MTCH","MKC","MCD","MCK","MDT","MRK","META","MET","MTD","MGM","MCHP","MU","MSFT","MAA","MRNA","MHK","MOH","TAP","MDLZ","MPWR","MNST","MCO","MS","MOS","MSI","MSCI","NDAQ","NTAP","NFLX","NEM","NEE","NKE","NI","NDSN","NSC","NTRS","NOC","NCLH","NRG","NUE","NVDA","NVR","NXPI","ORLY","OXY","ODFL","OMC","ON","OKE","ORCL","OTIS","PCAR","PKG","PLTR","PANW","PARA","PH","PAYX","PAYC","PYPL","PNR","PEP","PFE","PCG","PM","PSX","PNW","PNC","POOL","PPG","PPL","PFG","PG","PGR","PLD","PRU","PEG","PTC","PSA","PHM","PWR","QCOM","DGX","RL","RJF","RTX","O","REG","REGN","RF","RSG","RMD","RVTY","ROK","ROL","ROP","ROST","RCL","SPGI","CRM","SBAC","SLB","STX","SRE","NOW","SHW","SPG","SWKS","SJM","SNA","SO","LUV","SWK","SBUX","STT","STLD","STE","SYK","SYF","SNPS","SYY","TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL","TDY","TFX","TER","TSLA","TXN","TXT","TMO","TJX","TSCO","TT","TDG","TRV","TRMB","TFC","TYL","TSN","USB","UBER","UDR","ULTA","UNP","UAL","UPS","URI","UNH","UHS","VLO","VRT","VTR","VRSN","VRSK","VZ","VRTX","VTRS","V","VMC","WAB","WBA","WMT","DIS","WBD","WM","WAT","WEC","WFC","WELL","WST","WDC","WY","WMB","WTW","GWW","WYNN","XEL","XYL","YUM","ZBRA","ZBH","ZTS"];

const SMALLCAP = ["MRAM", "KTOS", "AVAV", "RCAT", "ACHR", "JOBY", "ASTS", "LUNR", "RDW", "SPIR", 
  "BBAI", "CDRE", "QUBT", "IONQ", "RGTI", "SOUN", "ARQQ", "QBTS", "VRNT", "MGNX", "RXRX", "DNLI", 
  "BEAM", "EDIT", "CRSP", "NTLA", "VERV", "NUVL", "ALLO", "HIMS", "OCGN", "NVAX", "VXRT", "INO", 
  "PSNL", "BLUE", "ARVN", "PRTA", "IMVT", "KYMR", "PTGX", "RCKT", "SAGE", "TGTX", "IOVA", "APLS", 
  "FOLD", "DAWN", "YMAB", "NVTS", "AMPX", "SMTC", "AAOI", "COHU", "FORM", "ONTO", "ACMR", "PLAB", 
  "DIOD", "VIAV", "POWI", "AEVA", "LAZR", "MVIS", "OUST", "WOLF", "AMBA", "SLAB", "BLNK", "CHPT", 
  "EVGO", "STEM", "ARRY", "NOVA", "SHLS", "FLNC", "BLDP", "FCEL", "PLUG", "RUN", "CSIQ", "DQ", 
  "JKS", "BE", "CWEN", "GPRE", "AMRC", "VNET", "CLSK", "IREN", "HUT", "MARA", "SOFI", "HOOD", 
  "AFRM", "UPST", "DAVE", "MQ", "LMND", "ROOT", "DKNG", "PENN", "CELH", "RBLX", "MSTR", "CIFR", "RIOT", 
  "FOUR", "RELY", "CRWD", "DDOG", "ZS", "GTLB", "BILL", "DOCS", "BRZE", "CFLT", "ASAN", "SMAR", 
  "WEAV", "ALKT", "JAMF", "TASK", "SPSC", "TDOC", "ACCD", "PRVA", "GDRX", "PGNY", "TMDX", "NVCR", 
  "MRCY", "GEVO", "CLNE", "REGI", "AXON", "SITM", "NXPI", "AMKR", "NVRO", "FATE", "DISH", "LUMN", 
  "VSAT", "IRDM", "GSAT", "SHEN", "IDT", "OOMA", "GOGO", "AVNW", "CLFD", "LITE", "CIEN", "INFN", 
  "CRDO", "POET", "ANGO", "ADTN", "CASA", "DZSI", "FYBR", "CALX", "COMM", "IIVI", "NTGR", "TMUS", 
  "SATS", "SPOK", "LPSN", "MTTR", "CEVA", "DRS", "CACI", "SAIC", "BWXT", "HWM", "TDG", "LILM", 
  "SEMR", "ONEM", "CANO", "TALK", "ALHC", "CERT", "XERS", "INVA", "LUNG", "LDOS", "PANW", "SNOW", 
  "MDB", "NET", "TEAM", "HUBS", "ZI", "INSP", "IRTC", "OMCL", "NTRA", "RGEN", "PAYC", "PAYO", 
  "SMCI", "AEHR", "ACLS", "EME", "TTMI", "UCTT", "KLIC", "KRYS", "VKTX", "ARWR", "EXAS", "RKLB", "DOMO", "TSSI", 
  "MAXN", "SPWR", "LC", "CACC", "ENVA", "QFIN", "WKHS", "MVST"
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
  return { greenArrow, bullScore, rsi14, trailVal: atrTS.trailVal, utBuy: atrTS.utBuy, stFlipped: st.flipped,
           emaStack, macdBull, rsiBull, wrBull, stBull, emaRising: ema20 > ema40 };
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

// ── NEW: Fetch weekly candles from Twelve Data ─────────────
// Called only for green arrow tickers — no extra API budget for non-firers
async function fetchWeeklyData(sym, keyIndex){
  const key = TD_KEYS[keyIndex % TD_KEYS.length];
  const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1week&outputsize=52&apikey=${key}`;
  try {
    const d = await fetchJSON(url);
    if(!d.values || d.status==='error') return null;
    const vals = [...d.values].reverse();
    const closes = vals.map(v=>parseFloat(v.close));
    const highs  = vals.map(v=>parseFloat(v.high));
    const lows   = vals.map(v=>parseFloat(v.low));
    if(closes.length < 20) return null;

    const weeklyRsi      = calcRSI(closes, 14);
    const wST            = calcSuperTrend(highs, lows, closes, 1.5, 10);
    const wATR           = calcATRTrailStop(highs, lows, closes, 10, 3.5);
    const wEma20         = calcEMA(closes, 20);
    const price          = closes[closes.length-1];
    const weeklyBullish  = wST.bullish;
    const weeklyJAX      = wATR.utBuy || wST.flipped;
    const weeklyJAXRecent = wST.flipped; // flipped this week
    const weeklyTrail    = wATR.trailVal;
    const dailyAbove200  = price > calcEMA(closes, 40); // use 40w as proxy for 200d

    return {
      weeklyBullish,
      weeklyRsi:       parseFloat(weeklyRsi.toFixed(1)),
      weeklyJAX,
      weeklyJAXRecent,
      weeklyTrail:     parseFloat(weeklyTrail.toFixed(2)),
      weeklyAboveEma:  price > wEma20,
    };
  } catch(e) {
    return null;
  }
}

// ── Save results to Firebase ──────────────────────────────
async function saveToFirebase(key, payload){
  const url = `${FIREBASE_URL}/screener/${key}.json`;
  console.log(`💾 Saving to Firebase: screener/${key}`);
  const raw = JSON.stringify(payload);
  return new Promise((resolve, reject)=>{
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }
    };
    const req = https.request(options, res=>{
      let data = '';
      res.on('data', chunk=> data+=chunk);
      res.on('end', ()=>{
        console.log(`✅ Firebase saved: screener/${key}`);
        resolve(data);
      });
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

// ── Main scanner ──────────────────────────────────────────
async function main(){
  console.log(`🔍 JAX Scanner starting — ${ALL_TICKERS.length} stocks — ${new Date().toISOString()}`);
  console.log(`📡 Using ${TD_KEYS.length} API keys`);

  if(!TD_KEYS.length){
    console.error('❌ No API keys found. Check TD_KEYS secret.');
    process.exit(1);
  }

  const fired   = [];
  const errors  = [];
  const DELAY   = 10000;
  const nKeys   = TD_KEYS.length;

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
          const price = candles.closes[candles.closes.length-1];

          // Fetch weekly data for this green arrow ticker
          await sleep(1000); // small pause before weekly fetch
          const weekly = await fetchWeeklyData(sym, keyIdx);

          const result = {
            sym,
            price:            parseFloat(price.toFixed(2)),
            change:           parseFloat(((price - candles.closes[candles.closes.length-2]) / candles.closes[candles.closes.length-2] * 100).toFixed(2)),
            bullScore:        jax.bullScore,
            rsi:              parseFloat(jax.rsi14.toFixed(1)),
            greenArrow:       true,
            utBuy:            jax.utBuy,
            stFlipped:        jax.stFlipped,
            emaStack:         jax.emaStack,
            macdBull:         jax.macdBull,
            rsiBull:          jax.rsiBull,
            wrBull:           jax.wrBull,
            stBull:           jax.stBull,
            emaRising:        jax.emaRising,
            trailVal:         parseFloat(jax.trailVal.toFixed(2)),
            dailyJAX:         true,
            dailyAbove200:    price > calcEMA(candles.closes, 200 > candles.closes.length ? candles.closes.length : 200),
            // Weekly fields — what the classifier needs
            weeklyBullish:    weekly ? weekly.weeklyBullish    : false,
            weeklyRsi:        weekly ? weekly.weeklyRsi        : 0,
            weeklyJAX:        weekly ? weekly.weeklyJAX        : false,
            weeklyJAXRecent:  weekly ? weekly.weeklyJAXRecent  : false,
            weeklyTrail:      weekly ? weekly.weeklyTrail      : 0,
            weeklyAboveEma:   weekly ? weekly.weeklyAboveEma   : false,
            weeklyFetched:    weekly !== null,
            firedAt:          new Date().toISOString(),
          };
          fired.push(result);
          const wStage = weekly && weekly.weeklyBullish ? (weekly.weeklyJAX ? 'W2' : 'W1?') : 'W-bear';
          console.log(`🟢 ${sym} @ $${result.price} bull${result.bullScore}/5 RSI${result.rsi} ${wStage}`);
        }
      }catch(e){
        if(!e.message?.includes('credits')) errors.push(sym);
      }
      if(i < chunk.length-1) await sleep(DELAY);
    }
  }

  await Promise.all(chunks.map((chunk, ki)=> runWorker(ki, chunk)));

  console.log(`\n✅ Scan complete — ${fired.length} green arrows fired`);
  const withWeeklyBull = fired.filter(r => r.weeklyBullish);
  const potentialEnter = fired.filter(r => r.weeklyBullish && (r.weeklyJAX || r.weeklyJAXRecent));
  console.log(`   Weekly bullish: ${withWeeklyBull.length} | Potential ENTER: ${potentialEnter.length}`);

  if(errors.length) console.log(`⚠️  Skipped ${errors.length} stocks`);

  // Save full results — classifier reads this
  const payload = {
    data:          JSON.stringify(fired),
    savedAt:       new Date().toISOString(),
    device:        'github-action-jax',
    totalScanned:  ALL_TICKERS.length,
    greenArrows:   fired.length,
    weeklyBullish: withWeeklyBull.length,
    potentialEnter: potentialEnter.length,
    checkTime:     new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York'})
  };

  // Save to both nodes so classifier and existing app both work
  await saveToFirebase('jax_scan', payload);
  await saveToFirebase('jax_cron_alerts', payload);

  console.log(`\n🎯 Top potential setups (weekly bullish + JAX):`);
  potentialEnter.forEach(r => console.log(`   ${r.sym} $${r.price} RSI-D:${r.rsi} RSI-W:${r.weeklyRsi}`));
}

main().catch(e=>{ console.error('Fatal error:', e); process.exit(1); });
