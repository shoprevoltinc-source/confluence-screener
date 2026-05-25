// weekly-scanner.js — Weekly Candle GitHub Action Scanner
// Mirrors the Weekly Monitor tab logic but runs headless (no 4H / daily checks)
// Scans all 685 stocks for:
//   1. Weekly trail flip bullish within last 3 weeks
//   2. Weekly green arrow fired (calcJAXPRO on weekly candles)
//   3. Weekly RSI ≤ 70
//   4. Weekly RSI coming from oversold (was below 40 recently)
// Saves to Firebase: screener/weekly_cron_alerts
// Credit cost: 685 stocks × 1 weekly candle call = 685 credits per run

const https = require("https");
const http  = require("http");

// ── Config ─────────────────────────────────────────────────────────────────
const TD_KEYS = (process.env.TD_KEYS || "")
  .split(/[\n,]+/)
  .map(k => k.trim())
  .filter(Boolean);

const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");

const SCAN_DELAY_MS   = 1200;  // ms between calls per key (safe under 8 req/min limit)
const FLIP_AGE_MAX    = 3;     // weeks — only recent flips
const WEEKLY_RSI_MAX  = 70;
const OVERSOLD_THRESH = 40;    // RSI was below this recently = recovery from oversold
const OVERSOLD_LOOKBACK = 8;   // bars to look back for oversold RSI

if (!TD_KEYS.length) { console.error("❌ No TD_KEYS set"); process.exit(1); }
if (!FIREBASE_DB_URL) { console.error("❌ No FIREBASE_DB_URL set"); process.exit(1); }

// ── Stock Universe ─────────────────────────────────────────────────────────
const SP500 = ["MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A","APD","AKAM","ALB","ARE","ALGN","ALLE","LNT","ALL","GOOGL","GOOG","MO","AMZN","AMCR","AEE","AAL","AEP","AXP","AIG","AMT","AWK","AMP","AME","AMGN","APH","ADI","ANSS","AON","APA","AAPL","AMAT","APTV","ADM","ANET","AJG","AIZ","T","ATO","ADSK","ADP","AZO","AVB","AVY","BKR","BALL","BAC","BK","BBWI","BAX","BDX","WRB","BRK/B","BBY","BIO","BIIB","BLK","BX","BA","BKNG","BWA","BSX","BMY","AVGO","BR","BLDR","BG","CDNS","CPT","CPB","COF","CAH","KMX","CCL","CARR","CAT","CBOE","CBRE","CDW","CE","COR","CNC","CF","CRL","SCHW","CHTR","CVX","CMG","CB","CHD","CI","CINF","CTAS","CSCO","C","CFG","CLX","CME","CMS","KO","CTSH","CL","CMCSA","CAG","COP","ED","STZ","COO","CPRT","GLW","CTVA","CSGP","COST","CTRA","CRWD","CCI","CSX","CMI","CVS","DHR","DRI","DVA","DAY","DE","DAL","DVN","DXCM","FANG","DLR","DFS","DG","DLTR","D","DPZ","DOV","DOW","DHI","DTE","DUK","DD","EMN","ETN","EBAY","ECL","EIX","EW","EA","ELV","EMR","ENPH","ETR","EOG","EPAM","EQT","EFX","EQIX","EQR","ESS","EL","ETSY","EG","EVRG","ES","EXC","EXPE","EXPD","EXR","XOM","FFIV","FDS","FICO","FAST","FRT","FDX","FIS","FITB","FSLR","FE","FI","FMC","F","FTNT","FTV","FOXA","FOX","BEN","FCX","GRMN","IT","GE","GD","GIS","GM","GPC","GILD","GS","HAL","HIG","HAS","HCA","HSIC","HSY","HES","HPE","HLT","HOLX","HD","HON","HRL","HST","HWM","HPQ","HUBB","HUM","HBAN","HII","IBM","IEX","IDXX","ITW","INCY","IR","PODD","INTC","ICE","IFF","IP","IPG","INTU","ISRG","IVZ","IQV","IRM","JCI","JPM","K","KDP","KEY","KEYS","KMB","KIM","KMI","KLAC","KHC","KR","LHX","LH","LRCX","LW","LVS","LDOS","LEN","LLY","LIN","LYV","LKQ","LMT","L","LOW","LULU","LYB","MTB","MRO","MPC","MKTX","MAR","MMC","MLM","MAS","MA","MTCH","MKC","MCD","MCK","MDT","MRK","META","MET","MTD","MGM","MCHP","MU","MSFT","MAA","MRNA","MHK","MOH","TAP","MDLZ","MPWR","MNST","MCO","MS","MOS","MSI","MSCI","NDAQ","NTAP","NFLX","NEM","NEE","NKE","NI","NDSN","NSC","NTRS","NOC","NCLH","NRG","NUE","NVDA","NVR","NXPI","ORLY","OXY","ODFL","OMC","ON","OKE","ORCL","OTIS","PCAR","PKG","PLTR","PANW","PARA","PH","PAYX","PAYC","PYPL","PNR","PEP","PFE","PCG","PM","PSX","PNW","PNC","POOL","PPG","PPL","PFG","PG","PGR","PLD","PRU","PEG","PTC","PSA","PHM","PWR","QCOM","DGX","RL","RJF","RTX","O","REG","REGN","RF","RSG","RMD","RVTY","ROK","ROL","ROP","ROST","RCL","SPGI","CRM","SBAC","SLB","STX","SRE","NOW","SHW","SPG","SWKS","SJM","SNA","SO","LUV","SWK","SBUX","STT","STLD","STE","SYK","SYF","SNPS","SYY","TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL","TDY","TFX","TER","TSLA","TXN","TXT","TMO","TJX","TSCO","TT","TDG","TRV","TRMB","TFC","TYL","TSN","USB","UBER","UDR","ULTA","UNP","UAL","UPS","URI","UNH","UHS","VLO","VTR","VRSN","VRSK","VZ","VRTX","VTRS","V","VMC","WAB","WBA","WMT","DIS","WBD","WM","WAT","WEC","WFC","WELL","WST","WDC","WY","WMB","WTW","GWW","WYNN","XEL","XYL","YUM","ZBRA","ZBH","ZTS"];
const SMALLCAP = ["MRAM","KTOS","AVAV","RCAT","ACHR","JOBY","ASTS","LUNR","RDW","SPIR","RKLB","ASTS","IONQ","QUBT","QBTS","ARQQ","DMYY","RXRX","SOUN","BBAI","PRCT","AEVA","OUST","LAZR","LIDR","INDI","MVIS","INVZ","AIOT","SWVL","HYZN","RIDE","GOEV","FSR","NKLA","BLNK","CHPT","EVGO","PTRA","WKHS","MVST","XPEV","LI","NIO","LCID","RIVN","FFIE","SOLO","AYRO","IDEX","ABML","AMTX","GEVO","REX","GPRE","ALTO","PEIX","HEMP","KERN","BYFC","CARV","MFAC","MGYR","MFIN","LSAQ","FPAC","AJAX","ARYA","ACIC","ACEV","ADEX","ADOC","AEON","AESC","AFAR","AFCG","AFIB","AFJK","AFTR","AGAC","AGBA","AGFS","AGFY","AGIL","AGIO","AGMH","AGRI","AGRO","AGTC","AGTI","AGYS","AGZD","AHCO","AHIX","AHPI","AIXI","AKTS","ALAB","ALBT","ALCO","ALEC","ALGT","ALIM","ALLO","ALLT","ALLK","ALNA","ALNY","ALOT","ALPN","ALPP","ALRM","ALRS","ALTG","ALTM","ALTO","ALTR","ALTS","ALVR","ALXO","ALYA","SMCI","AEHR","ACLS","UCTT","KLIC","KRYS","VKTX","ARWR","EXAS","DOMO","TSSI","MAXN","SPWR","LC","CACC","ENVA","QFIN","CRDO","NVTS","AMBA","AIOT","WOLF","FORM","ONTO","IRTC","TMDX","RXST","AXNX","CSTL","LNTH","NARI","SILK","STVN","INMD","SWAV","ATRC","BFLY","OTRK","ACMR","ALGM","ASMB","ASND","CLDX","CRNX","FGEN","INSM","INVA","ITCI","KROS","LEGN","MDGL","MRSN","NKTR","OVID","PRTA","PTGX","RAPT","RCUS","RETA","RLAY","RNAC","RPTX","RUBY","RXDX","SAGE","SRRK","SRPT","TPTX","TVTX","TYME","TICA","VCEL","VCNX","VIR","VNDA","VRNA","VRTX","XENE","YMAB","ZYME"];

const UNIVERSE = [...new Set([...SP500, ...SMALLCAP])];

// ── Helpers ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error("JSON parse error: " + body.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

function firebasePut(path, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(FIREBASE_DB_URL + "/" + path + ".json");
    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Indicators (mirrors index.html exactly) ────────────────────────────────
function calcEMA(c, p = 21) {
  if (c.length < p) return c[c.length - 1];
  const k = 2 / (p + 1);
  let e = c.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < c.length; i++) e = c[i] * k + e * (1 - k);
  return e;
}

function calcRSI(c, p = 14) {
  if (c.length < p + 1) return 50;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; d >= 0 ? ag += d : al -= d; }
  ag /= p; al /= p;
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macdLine: 0, signalLine: 0, hist: 0 };
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast - emaSlow;
  const macdSeries = [];
  for (let i = slow; i <= closes.length; i++) {
    const ef = calcEMA(closes.slice(0, i), fast);
    const es = calcEMA(closes.slice(0, i), slow);
    macdSeries.push(ef - es);
  }
  const signalLine = calcEMA(macdSeries, signal);
  const hist = macdLine - signalLine;
  return { macdLine, signalLine, hist };
}

function calcSuperTrend(highs, lows, closes, factor = 1.5, period = 10) {
  if (closes.length < period + 1) return { bullish: false, flipped: false, stVal: 0 };
  const atrVals = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    atrVals.push(tr);
  }
  const getATR = idx => {
    const slice = atrVals.slice(Math.max(0, idx - period), idx);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };
  const stHistory = [];
  for (let i = period; i < closes.length; i++) {
    const atr = getATR(i);
    const hl2 = (highs[i] + lows[i]) / 2;
    const upperBand = hl2 + factor * atr;
    const lowerBand = hl2 - factor * atr;
    const prevST = stHistory.length > 0 ? stHistory[stHistory.length - 1] : null;
    const prevDir = stHistory.length > 0 ? prevST.dir : 1;
    let newST, newDir;
    if (prevST === null) { newST = lowerBand; newDir = 1; }
    else if (prevDir === 1) {
      newST = Math.max(prevST.val, lowerBand);
      newDir = closes[i] > newST ? 1 : -1;
      if (newDir === -1) newST = upperBand;
    } else {
      newST = Math.min(prevST.val, upperBand);
      newDir = closes[i] < newST ? -1 : 1;
      if (newDir === 1) newST = lowerBand;
    }
    stHistory.push({ val: newST, dir: newDir });
  }
  const last = stHistory[stHistory.length - 1];
  const prev = stHistory[stHistory.length - 2];
  return {
    bullish: last && last.dir === 1,
    flipped: last && prev && last.dir === 1 && prev.dir === -1,
    stVal: last ? last.val : 0
  };
}

function calcATRTrailStop(highs, lows, closes, period = 10, mult = 3.5) {
  if (closes.length < period + 2) return { dir: 1, prevDir: 1, utBuy: false, utSell: false, trailVal: closes[closes.length - 1] };
  const atrVals = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    atrVals.push(tr);
  }
  const getATR = idx => {
    const slice = atrVals.slice(Math.max(0, idx - period), idx);
    return slice.reduce((a, b) => a + b, 0) / Math.max(slice.length, 1);
  };
  let trail = closes[0], tdir = 0;
  const trailHistory = [];
  for (let i = 1; i < closes.length; i++) {
    const atrV = getATR(i);
    const nLoss = mult * atrV;
    const trailUp = closes[i] - nLoss;
    const trailDown = closes[i] + nLoss;
    const prevTrail = trail;
    if (closes[i] > trail && closes[i - 1] > trail)      trail = Math.max(trail, trailUp);
    else if (closes[i] < trail && closes[i - 1] < trail) trail = Math.min(trail, trailDown);
    else if (closes[i] > trail)                           trail = trailUp;
    else                                                   trail = trailDown;
    const prevDir = tdir;
    tdir = trail > prevTrail ? 1 : trail < prevTrail ? -1 : tdir;
    trailHistory.push({ trail, tdir, prevDir });
  }
  const last = trailHistory[trailHistory.length - 1];
  const prev = trailHistory[trailHistory.length - 2] || { tdir: 0 };
  return {
    dir: last.tdir, prevDir: prev.tdir,
    utBuy:  last.tdir === 1  && prev.tdir === -1,
    utSell: last.tdir === -1 && prev.tdir === 1,
    trailVal: last.trail
  };
}

function calcJAXPRO(closes, highs, lows) {
  if (closes.length < 70) return null;
  const ema20 = calcEMA(closes, 20);
  const ema40 = calcEMA(closes, 40);
  const ema60 = calcEMA(closes, 60);
  const price = closes[closes.length - 1];
  const rsi14 = calcRSI(closes, 14);
  const hh = Math.max(...highs.slice(-14));
  const ll = Math.min(...lows.slice(-14));
  const wr14 = hh === ll ? -50 : ((hh - price) / (hh - ll)) * -100;
  const { hist } = calcMACD(closes);
  const st    = calcSuperTrend(highs, lows, closes, 1.5, 10);
  const atrTS = calcATRTrailStop(highs, lows, closes, 10, 3.5);
  const emaStack = price > ema20 && ema20 > ema40 && ema40 > ema60;
  const macdBull = hist > 0;
  const rsiBull  = rsi14 > 50;
  const wrBull   = wr14 > -50;
  const stBull   = st.bullish;
  const bullScore  = (emaStack ? 1 : 0) + (macdBull ? 1 : 0) + (rsiBull ? 1 : 0) + (wrBull ? 1 : 0) + (stBull ? 1 : 0);
  const greenArrow = (atrTS.utBuy || st.flipped) && bullScore >= 1 && rsi14 < 70;
  const redArrow   = atrTS.utSell && bullScore <= 2;
  return { ema20, ema40, ema60, rsi14, wr14, hist, st, atrTS, emaStack, macdBull, rsiBull, wrBull, stBull, bullScore, greenArrow, redArrow, trailVal: atrTS.trailVal };
}

// Mirrors findWeeklyTrailFlips from the app
function findWeeklyTrailFlips(closes, highs, lows, dates) {
  if (closes.length < 15) return { flips: [], history: [] };
  let trailVal = closes[0], tdir = 0;
  const history = [];
  const flips = [];

  for (let i = 1; i < closes.length; i++) {
    const atrVals = [];
    for (let j = Math.max(0, i - 10); j < i; j++) {
      const tr = Math.max(
        highs[j] - lows[j],
        Math.abs(highs[j] - (j > 0 ? closes[j - 1] : closes[j])),
        Math.abs(lows[j] - (j > 0 ? closes[j - 1] : closes[j]))
      );
      atrVals.push(tr);
    }
    const atrV = atrVals.reduce((a, b) => a + b, 0) / atrVals.length;
    const nLoss = 3.5 * atrV;
    const trailUp   = closes[i] - nLoss;
    const trailDown = closes[i] + nLoss;
    const prevTrail = trailVal;

    if (closes[i] > trailVal && closes[i - 1] > trailVal)      trailVal = Math.max(trailVal, trailUp);
    else if (closes[i] < trailVal && closes[i - 1] < trailVal) trailVal = Math.min(trailVal, trailDown);
    else if (closes[i] > trailVal)                               trailVal = trailUp;
    else                                                          trailVal = trailDown;

    const prevDir = tdir;
    tdir = trailVal > prevTrail ? 1 : trailVal < prevTrail ? -1 : tdir;
    history.push({ trail: trailVal, dir: tdir, prevDir });

    if (tdir === 1 && prevDir === -1) {
      flips.push({ flipIdx: i, date: dates ? dates[i] : null, flipPrice: closes[i], trailVal });
    }
  }
  return { flips, history };
}

// ── Weekly candle fetch ────────────────────────────────────────────────────
async function fetchWeeklyCandles(sym, keyIndex) {
  const key = TD_KEYS[keyIndex % TD_KEYS.length];
  const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1week&outputsize=260&apikey=${key}`;
  const d = await fetchJSON(url);
  if (d.status === "error") {
    if (d.message && (d.message.includes("not found") || d.message.includes("missing or invalid")))
      throw new Error("SKIP:" + d.message);
    throw new Error(d.message || "API error");
  }
  if (!d.values || !d.values.length) throw new Error("No weekly data");
  const vals = [...d.values].reverse(); // oldest first
  return {
    closes:  vals.map(v => parseFloat(v.close)),
    highs:   vals.map(v => parseFloat(v.high)),
    lows:    vals.map(v => parseFloat(v.low)),
    volumes: vals.map(v => parseFloat(v.volume) || 0),
    dates:   vals.map(v => v.datetime),
    bars:    vals.length
  };
}

// ── Main scan ──────────────────────────────────────────────────────────────
async function scanStock(sym, keyIndex) {
  const wk = await fetchWeeklyCandles(sym, keyIndex);
  if (!wk || wk.closes.length < 20) return null;

  // Step 1: Find most recent weekly trail flip
  const { flips, history } = findWeeklyTrailFlips(wk.closes, wk.highs, wk.lows, wk.dates);
  if (!flips.length) return null;

  const lastFlip = flips[flips.length - 1];
  const weeksAgo = wk.closes.length - 1 - lastFlip.flipIdx;
  if (weeksAgo > FLIP_AGE_MAX) return null;

  // Step 2: Is weekly trail still bullish?
  const lastHistory = history[history.length - 1];
  const weeklyStillBullish = lastHistory && lastHistory.dir === 1;
  if (!weeklyStillBullish) return null;

  // Step 3: Weekly RSI filter
  const weeklyRsi = calcRSI(wk.closes, 14);
  if (weeklyRsi > WEEKLY_RSI_MAX) return null;

  // Step 4: Was RSI oversold recently? (recovery signal)
  let cameFromOversold = false;
  const rsiLookback = wk.closes.slice(-(OVERSOLD_LOOKBACK + 1));
  for (let i = 0; i < rsiLookback.length - 1; i++) {
    const rsiAt = calcRSI(wk.closes.slice(0, wk.closes.length - (rsiLookback.length - 1 - i)), 14);
    if (rsiAt < OVERSOLD_THRESH) { cameFromOversold = true; break; }
  }

  // Step 5: Weekly JAX — fired within last 3 bars?
  let weeklyJAX = false;
  let weeklyJAXRecent = false;
  let weeklyBullScore = 0;
  if (wk.closes.length >= 70) {
    const wkJax = calcJAXPRO(wk.closes, wk.highs, wk.lows);
    if (wkJax) {
      weeklyJAX       = wkJax.greenArrow;
      weeklyBullScore = wkJax.bullScore;
      for (let rb = 0; rb < 3 && rb < wk.closes.length; rb++) {
        const sliced = calcJAXPRO(
          wk.closes.slice(0, wk.closes.length - rb),
          wk.highs.slice(0, wk.closes.length - rb),
          wk.lows.slice(0, wk.closes.length - rb)
        );
        if (sliced && sliced.greenArrow) { weeklyJAXRecent = true; break; }
      }
    }
  }

  const price = wk.closes[wk.closes.length - 1];

  // Tier
  const tierApp = weeklyJAXRecent && weeksAgo <= 1;  // Fresh flip + recent JAX = highest
  const tier1   = weeklyJAXRecent && !tierApp;        // JAX recent, flip slightly older
  const tier2   = !weeklyJAX && cameFromOversold;     // Oversold recovery, no JAX yet
  const tier3   = !weeklyJAX && !cameFromOversold;    // Trail flip only

  return {
    sym,
    price,
    weeklyFlipDate:  lastFlip.date,
    weeklyFlipPrice: lastFlip.flipPrice,
    weeksAgo,
    weeklyBullish:   weeklyStillBullish,
    weeklyTrail:     lastHistory.trail,
    totalFlips:      flips.length,
    weeklyRsi:       parseFloat(weeklyRsi.toFixed(2)),
    cameFromOversold,
    weeklyJAX,
    weeklyJAXRecent,
    weeklyBullScore,
    tierApp, tier1, tier2, tier3,
    scannedAt: new Date().toISOString()
  };
}

// ── Run with key rotation ──────────────────────────────────────────────────
async function run() {
  const startTime = Date.now();
  const results   = [];
  const errors    = [];
  let   done      = 0;
  const total     = UNIVERSE.length;

  console.log(`🔍 Weekly scanner starting — ${total} stocks, ${TD_KEYS.length} key(s)`);
  console.log(`⚙️  Flip age ≤ ${FLIP_AGE_MAX} wks | Weekly RSI ≤ ${WEEKLY_RSI_MAX} | Oversold lookback ${OVERSOLD_LOOKBACK} bars`);

  // Distribute stocks across keys
  const chunks = TD_KEYS.map((_, ki) =>
    UNIVERSE.filter((_, idx) => idx % TD_KEYS.length === ki)
  );

  async function runWorker(keyIdx, chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const sym = chunk[i];
      try {
        const result = await scanStock(sym, keyIdx);
        done++;
        if (result) {
          results.push(result);
          const tier = result.tierApp ? "⭐⭐ A++" : result.tier1 ? "⭐ JAX" : result.tier2 ? "📈 OVERSOLD" : "📅 FLIP";
          console.log(`✅ ${tier} ${sym} | RSI ${result.weeklyRsi} | flip ${result.weeksAgo}w ago | JAX ${result.weeklyJAXRecent ? "🟢" : "—"}`);
        }
        if (done % 50 === 0) console.log(`   ... ${done}/${total} scanned, ${results.length} signals`);
      } catch (e) {
        done++;
        if (!e.message.startsWith("SKIP:")) {
          errors.push({ sym, error: e.message });
          console.warn(`⚠️  ${sym}: ${e.message}`);
        }
      }
      if (i < chunk.length - 1) await sleep(SCAN_DELAY_MS);
    }
  }

  await Promise.all(chunks.map((chunk, ki) => runWorker(ki, chunk)));

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n📊 Scan complete in ${elapsed} min`);
  console.log(`   ${results.length} signals | ${errors.length} errors | ${done} scanned`);

  // Tier breakdown
  const appCount   = results.filter(r => r.tierApp).length;
  const t1Count    = results.filter(r => r.tier1 && !r.tierApp).length;
  const t2Count    = results.filter(r => r.tier2 && !r.tier1 && !r.tierApp).length;
  const t3Count    = results.filter(r => r.tier3).length;
  const jaxCount   = results.filter(r => r.weeklyJAXRecent).length;
  const oversoldCount = results.filter(r => r.cameFromOversold).length;
  console.log(`   ⭐⭐ A++ (flip+JAX fresh): ${appCount}`);
  console.log(`   ⭐  JAX recent:            ${t1Count}`);
  console.log(`   📈  Oversold recovery:     ${t2Count}`);
  console.log(`   📅  Flip only:             ${t3Count}`);
  console.log(`   🟢  Weekly JAX fired:      ${jaxCount}`);
  console.log(`   💹  From oversold:         ${oversoldCount}`);

  // Sort: A++ > JAX > oversold > flip only, then by weeksAgo asc
  results.sort((a, b) => {
    const scoreA = a.tierApp ? 4 : a.tier1 ? 3 : a.tier2 ? 2 : 1;
    const scoreB = b.tierApp ? 4 : b.tier1 ? 3 : b.tier2 ? 2 : 1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.weeksAgo - b.weeksAgo;
  });

  // Save to Firebase — same structure as fbSafeSave/fbLoad expects
  const payload = {
    data: JSON.stringify(results),
    savedAt: new Date().toISOString(),
    device: "github-actions",
    meta: {
      total, scanned: done, found: results.length, errors: errors.length,
      elapsedMin: elapsed,
      appCount, t1Count, t2Count, t3Count, jaxCount, oversoldCount
    }
  };

  console.log("\n💾 Saving to Firebase screener/weekly_cron_alerts ...");
  try {
    await firebasePut("screener/weekly_cron_alerts", payload);
    console.log("✅ Firebase save OK");
  } catch (e) {
    console.error("❌ Firebase save failed:", e.message);
    process.exit(1);
  }

  console.log(`\n🏁 Done — ${results.length} weekly signals saved`);
  if (results.length > 0) {
    console.log("\nTop signals:");
    results.slice(0, 10).forEach(r => {
      const tier = r.tierApp ? "⭐⭐A++" : r.tier1 ? "⭐JAX" : r.tier2 ? "📈OVERSOLD" : "📅FLIP";
      console.log(`  ${tier} ${r.sym.padEnd(6)} $${r.price.toFixed(2).padStart(8)} | RSI ${r.weeklyRsi.toFixed(1).padStart(5)} | flip ${r.weeksAgo}w ago${r.weeklyJAXRecent ? " | 🟢 JAX" : ""}${r.cameFromOversold ? " | 💹 from oversold" : ""}`);
    });
  }
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
