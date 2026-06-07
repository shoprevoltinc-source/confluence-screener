// daily-full-scan.js — Full pre-market scanner (refactored)
// Runs JAX + Recovery + Catalyst and saves to Firebase for the agent + web app.
//
// TWO IMPORTANT CHANGES vs the old version:
//   1. SINGLE SOURCE OF TRUTH — the scoring logic now comes from indicators.js
//      (the SAME file the web app loads). No more drifted, slimmed-down copies,
//      so the data written here always has every field the renderers expect
//      (conds, change, pctHi, high52, the JAX condition booleans, etc.).
//   2. SAVE GUARD — a credit-starved or failed run can NO LONGER overwrite good
//      Firebase data with empty/partial results. We skip the save when a scanner
//      returns nothing OR when we couldn't fetch most of its universe.
//
// Requires indicators.js to sit next to this file in the repo root.

const https = require("https");
const I = require("./indicators.js"); // scoreRecovery, scoreCatalyst, scoreJAX, calcATR, ...

// ── Config ─────────────────────────────────────────────────
const TD_KEYS = (process.env.TD_KEYS || "")
  .split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");

const SCAN_DELAY_MS     = 10000;
const STAGGER_MS        = 1500;
const CAT_MAX_PRICE     = 250;
const CAT_MIN_VOL_SPIKE = 2;
const MIN_COVERAGE      = 0.6;

if (!TD_KEYS.length)  { console.error("❌ No TD_KEYS"); process.exit(1); }
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
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
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
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
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

// ── Score closures ───────────────────────────────────────────
const jaxScore = (sym, c, h, l, v) => {
  const r = I.scoreJAX(sym, c, h, l);
  return Object.assign(r, I.scoreTA(c, h, l, v, "continuation"));
};
const recScore = (sym, c, h, l, v) => {
  const r = I.scoreRecovery(sym, c, h, l);
  return Object.assign(r, I.scoreTA(c, h, l, v, "recovery"));
};
const catScore = (sym, c, h, l, v) => {
  const atrData = I.calcATR(h, l, c);
  const r = I.scoreCatalyst(sym, c, h, l, v, CAT_MAX_PRICE, CAT_MIN_VOL_SPIKE, null, atrData, 0);
  return Object.assign(r, I.scoreTA(c, h, l, v, "continuation"));
};

// ── Save to Firebase (GUARDED) ──────────────────────────────
async function fbSave(key, results) {
  if (!Array.isArray(results) || results.length === 0) {
    console.warn(`⏭️  ${key}: 0 results — SKIP save (existing Firebase data preserved)`);
    return false;
  }
  const payload = {
    data:    JSON.stringify(results),
    savedAt: new Date().toISOString(),
    device:  "github-actions-daily"
  };
  await firebasePut("screener/" + key, payload);
  console.log(`✅ Saved ${results.length} results → screener/${key}`);
  return true;
}

async function saveGuarded(key, run) {
  const coverage = run.total > 0 ? run.fetched / run.total : 0;
  if (coverage < MIN_COVERAGE) {
    console.warn(`⏭️  ${key}: only ${(coverage * 100).toFixed(0)}% universe coverage `
      + `(${run.fetched}/${run.total}) — likely credit-starved/failed; SKIP save to preserve existing data`);
    return false;
  }
  return fbSave(key, run.results);
}

// ── Scanner runner ───────────────────────────────────────────
async function runScanner(name, universe, scoreFn, filter, keyOffset = 0) {
  const results = [];
  let fetched = 0, failed = 0;
  const total  = universe.length;
  const chunks = TD_KEYS.map((_, ki) => universe.filter((_, idx) => idx % TD_KEYS.length === ki));

  async function worker(keyIdx, chunk) {
    if (keyIdx > 0) await sleep(keyIdx * STAGGER_MS);
    for (let i = 0; i < chunk.length; i++) {
      const sym = chunk[i];
      let retries = 2;
      while (retries >= 0) {
        try {
          const candles = await fetchCandles(sym, keyIdx + keyOffset);
          fetched++;
          const result = scoreFn(sym, candles.closes, candles.highs, candles.lows, candles.volumes);
          if (filter(result)) {
            results.push(result);
            console.log(`  ✅ ${name} ${sym} score:${result.score ?? result.bullScore ?? "?"} heat:${result.heat ?? ""}`);
          }
          if (fetched % 100 === 0) console.log(`  ... ${fetched}/${total} fetched, ${results.length} hits`);
          break;
        } catch (e) {
          const msg = e.message || "";
          if (msg.includes("credits")) {
            if (retries > 0) { await sleep(60000); retries--; continue; }
            failed++;
          } else if (msg.startsWith("SKIP:") || msg.includes("not found")
                     || msg.includes("Not enough") || msg.includes("70+")
                     || msg.includes("calc failed")) {
            // legitimate no-signal
          } else {
            failed++;
          }
          break;
        }
      }
      if (i < chunk.length - 1) await sleep(SCAN_DELAY_MS);
    }
  }

  console.log(`\n🔍 ${name} — scanning ${total} stocks with ${TD_KEYS.length} keys`);
  await Promise.all(chunks.map((chunk, ki) => worker(ki, chunk)));
  const coverage = total > 0 ? fetched / total : 0;
  results.sort((a,b) => (b.taScore||0) - (a.taScore||0));
  console.log(`  📊 ${name} done — ${results.length} hits · ${fetched}/${total} fetched `
    + `(${(coverage * 100).toFixed(0)}%) · ${failed} fetch-failures`);
  return { results, fetched, failed, total };
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`🌅 Daily Full Scan — ${new Date().toISOString()}`);
  console.log(`📡 ${TD_KEYS.length} keys, ${ALL.length} stocks · using indicators.js (shared logic)`);

  // ── 1. JAX Scanner ─────────────────────────────────────────
  const jaxRun = await runScanner("JAX", ALL, jaxScore, r => r && r.greenArrow);
  const jaxSaved = await saveGuarded("jax_scan", jaxRun);

  // ── Write jax_cron_alerts (banner) from daily scan results ─
  // Merges with any TradingView webhook entries already in the banner
  // so live per-ticker alerts aren't lost when the daily scan runs.
  if (jaxSaved) {
    try {
      // Read existing banner to preserve any webhook-sourced entries
      const existingRaw = await new Promise((resolve) => {
        https.get(`${FIREBASE_DB_URL}/screener/jax_cron_alerts.json`, res => {
          let body = "";
          res.on("data", d => body += d);
          res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        }).on("error", () => resolve(null));
      });

      // Collect any webhook-sourced entries not in today's scan
      const scanSyms = new Set(jaxRun.results.map(r => r.sym));
      let webhookEntries = [];
      if (existingRaw && existingRaw.data) {
        try {
          const existing = typeof existingRaw.data === "string"
            ? JSON.parse(existingRaw.data) : existingRaw.data;
          if (Array.isArray(existing)) {
            webhookEntries = existing.filter(r => r.source === "tradingview_webhook" && !scanSyms.has(r.sym));
          }
        } catch {}
      }

      // Daily scan results first, then any webhook-only entries
      const merged = [...jaxRun.results, ...webhookEntries];

      await firebasePut("screener/jax_cron_alerts", {
        data:        JSON.stringify(merged),
        savedAt:     new Date().toISOString(),
        device:      "github-actions-daily",
        greenArrows: merged.length
      });
      console.log(`✅ Banner updated → screener/jax_cron_alerts (${merged.length} tickers, ${webhookEntries.length} webhook entries preserved)`);
    } catch (e) {
      console.warn(`⚠️  jax_cron_alerts banner update failed: ${e.message} — jax_scan still saved`);
    }
  }

  console.log("\n⏳ Cooling down 2 minutes before Recovery scan...");
  await sleep(120000);

  // ── 2. Recovery Scanner ─────────────────────────────────────
  const recRun = await runScanner("Recovery", SP500, recScore, r => r && (r.score >= 3 || r.c7));
  await saveGuarded("recovery", recRun);

  console.log("\n⏳ Cooling down 2 minutes before Catalyst scan...");
  await sleep(120000);

  // ── 3. Catalyst Scanner ──────────────────────────────────────
  const catRun = await runScanner("Catalyst", SMALLCAP, catScore, r => r && r.atrCoiling && r.score >= 2);
  await saveGuarded("catalyst", catRun);

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n🏁 Daily full scan complete`);
  console.log(`  🟢 JAX green arrows: ${jaxRun.results.length}  (${jaxRun.fetched}/${jaxRun.total} fetched)`);
  console.log(`  📈 Recovery signals: ${recRun.results.length}  (${recRun.fetched}/${recRun.total} fetched)`);
  console.log(`  ⚡ Catalyst coils:   ${catRun.results.length}  (${catRun.fetched}/${catRun.total} fetched)`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
