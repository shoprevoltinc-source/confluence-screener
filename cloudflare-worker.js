// ── Confluence Screener — TradingView Webhook Receiver
// Deploy as a Cloudflare Worker
//
// Environment variables (set in Cloudflare Dashboard → Worker → Settings → Variables):
//   FIREBASE_URL    — https://confluence-screener-default-rtdb.firebaseio.com
//   FIREBASE_TOKEN  — Firebase database secret (leave blank if rules allow open writes)
//   WEBHOOK_SECRET  — any secret string you choose, e.g. "cs2026xK9mR"

export default {
  async fetch(request, env) {

    // ── CORS preflight ──────────────────────────────────────
    if (request.method === "OPTIONS") {
      return respond(200, null, corsHeaders());
    }

    // ── Only accept POST ────────────────────────────────────
    if (request.method !== "POST") {
      return respond(405, { error: "Method not allowed" });
    }

    // ── Validate secret ─────────────────────────────────────
    const url    = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (!secret || secret !== env.WEBHOOK_SECRET) {
      console.log("❌ Invalid secret");
      return respond(401, { error: "Unauthorized" });
    }

    // ── Parse body ──────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return respond(400, { error: "Invalid JSON", detail: e.message });
    }

    // ── Require sym field ───────────────────────────────────
    const sym = ((body.sym || body.symbol || "")).toUpperCase().trim();
    if (!sym) return respond(400, { error: "Missing sym field" });

    // ── Build clean record ──────────────────────────────────
    // All values come directly from Pine Script alert() — real indicator values
    const signal    = body.signal || "green_arrow";
    const timeframe = body.timeframe || "D";
    const now       = new Date().toISOString();

    const record = {
      sym,
      price:           parseFloat(body.price)        || 0,
      rsi:             parseFloat(body.rsi)           || 0,
      weeklyRsi:       parseFloat(body.weeklyRsi)     || 0,
      trailVal:        parseFloat(body.trail)         || 0,
      weeklyTrail:     parseFloat(body.weeklyTrail)   || 0,
      bullScore:       parseInt(body.bullScore)        || 0,
      emaStack:        body.emaStack  === "true" || body.emaStack  === true,
      macdBull:        body.macdBull  === "true" || body.macdBull  === true,
      rsiBull:         body.rsiBull   === "true" || body.rsiBull   === true,
      stBull:          body.stBull    === "true" || body.stBull    === true,
      emaRising:       body.emaRising === "true" || body.emaRising === true,
      dailyAbove200:   body.above200  === "true" || body.above200  === true,
      greenArrow:      true,
      dailyJAX:        signal === "green_arrow" || signal === "jax_daily",
      weeklyJAX:       signal === "jax_weekly",
      weeklyJAXRecent: signal === "jax_weekly",
      weeklyBullish:   signal === "jax_weekly" || body.weeklyBullish === "true",
      timeframe,
      signal,
      firedAt:         now,
      source:          "tradingview_webhook",
    };

    // ── Write to Firebase ───────────────────────────────────
    const base      = (env.FIREBASE_URL || "").replace(/\/$/, "");
    const authParam = env.FIREBASE_TOKEN ? `?auth=${env.FIREBASE_TOKEN}` : "";

    try {
      // 1. Write/overwrite individual record at jax_signals/{SYM}
      //    This gives you a clean per-ticker lookup in Firebase
      await fbPut(`${base}/screener/jax_signals/${sym}.json${authParam}`, record);

      // 2. Merge into jax_cron_alerts so the app banner updates
      await mergeIntoBanner(base, authParam, record);

      console.log(`✅ ${sym} ${signal} @ $${record.price} → Firebase`);
      return respond(200, { ok: true, sym, signal, price: record.price, firedAt: now });

    } catch (e) {
      console.error("Firebase error:", e.message);
      return respond(500, { error: "Firebase write failed", detail: e.message });
    }
  }
};

// ── Firebase PUT ──────────────────────────────────────────────
async function fbPut(url, data) {
  const res = await fetch(url, {
    method:  "PUT",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Merge new signal into jax_cron_alerts banner array ────────
async function mergeIntoBanner(base, authParam, newRecord) {
  const url = `${base}/screener/jax_cron_alerts.json${authParam}`;

  // Read existing banner data
  let arr = [];
  try {
    const getRes = await fetch(url);
    if (getRes.ok) {
      const existing = await getRes.json();
      if (existing && existing.data) {
        const parsed = typeof existing.data === "string"
          ? JSON.parse(existing.data) : existing.data;
        if (Array.isArray(parsed)) arr = parsed;
      } else if (Array.isArray(existing)) {
        arr = existing;
      }
    }
  } catch { /* start fresh if read fails */ }

  // Remove stale entry for this sym, add new one at front
  arr = arr.filter(r => r.sym !== newRecord.sym);
  arr.unshift(newRecord);

  // Write back in the format the app expects
  await fbPut(url, {
    data:        JSON.stringify(arr),
    savedAt:     new Date().toISOString(),
    device:      "tradingview_webhook",
    greenArrows: arr.length
  });
}

// ── Response helper ───────────────────────────────────────────
function respond(status, body, extraHeaders = {}) {
  return new Response(
    body ? JSON.stringify(body) : null,
    { status, headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders } }
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
