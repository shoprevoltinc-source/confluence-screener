// telegram-morning-brief.js
// Reads Firebase data and sends 3 Telegram messages at 9am ET
// Secrets needed: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FIREBASE_DB_URL

const https = require("https");

const FIREBASE_DB_URL  = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!FIREBASE_DB_URL)  { console.error("❌ No FIREBASE_DB_URL"); process.exit(1); }
if (!TELEGRAM_TOKEN)   { console.error("❌ No TELEGRAM_BOT_TOKEN"); process.exit(1); }
if (!TELEGRAM_CHAT_ID) { console.error("❌ No TELEGRAM_CHAT_ID"); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("JSON parse error: " + e.message)); }
      });
    }).on("error", reject);
  });
}

async function fbGet(path) {
  try {
    const url  = `${FIREBASE_DB_URL}/screener/${path}.json`;
    const data = await fetchJSON(url);
    if (!data) return null;
    // Handle wrapped {data, savedAt} format
    if (data.data) {
      return typeof data.data === "string" ? JSON.parse(data.data) : data.data;
    }
    return data;
  } catch (e) {
    console.warn(`⚠️  fbGet(${path}) failed:`, e.message);
    return null;
  }
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text:       text,
      parse_mode: "HTML"
    });
    const req = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        const result = JSON.parse(d);
        if (result.ok) {
          console.log("✅ Telegram message sent");
          resolve(result);
        } else {
          reject(new Error("Telegram error: " + JSON.stringify(result)));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Date helpers ──────────────────────────────────────────────────────────────

function getTodayET() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short", month: "short", day: "numeric"
  });
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildMessage1(agentBrief, weeklyMonitor) {
  const today = getTodayET();
  const lines = [];
  lines.push(`☀️ <b>MORNING BRIEF — ${today}</b>`);
  lines.push("");

  // Pull trades from agent brief if available
  if (agentBrief && agentBrief.trades && agentBrief.trades.length > 0) {
    const enterTrades = agentBrief.trades.filter(t => t.action === "ENTER");
    if (enterTrades.length > 0) {
      lines.push(`⭐ <b>ENTER NOW — ${enterTrades.length} TRADE${enterTrades.length > 1 ? "S" : ""}</b>`);
      enterTrades.forEach((t, i) => {
        const score    = t.score ? ` ${t.score}/10` : "";
        const riskStr  = t.risk_pct ? ` · ${t.risk_pct}% risk` : "";
        const entry    = t.entry   ? `$${Number(t.entry).toFixed(2)}`   : "—";
        const stop     = t.stop    ? `$${Number(t.stop).toFixed(2)}`    : "—";
        const target   = t.target  ? `$${Number(t.target).toFixed(2)}`  : "—";
        const shares   = t.shares  ? `${t.shares} shares` : "";
        const note     = t.win_rate_note || "";
        lines.push(`\n${i + 1}. <b>${t.sym}</b>${score ? ` —${score}` : ""}${riskStr}`);
        lines.push(`   Entry ${entry} | Stop ${stop} | Target ${target}${shares ? " | " + shares : ""}`);
        if (note) lines.push(`   ${note}`);
      });
    } else {
      lines.push("No ENTER trades today — market conditions not ideal.");
    }

    // Avoid list
    if (agentBrief.avoid) {
      lines.push("");
      lines.push(`⚠️ <b>AVOID:</b> ${agentBrief.avoid}`);
    }
  } else {
    // Fallback: use weekly monitor tier1 stocks
    const tier1 = (weeklyMonitor || []).filter(r => r.tier1 || r.tierApp);
    const tier2 = (weeklyMonitor || []).filter(r => r.tier2 && !r.tier1 && !r.tierApp);
    if (tier1.length > 0) {
      lines.push(`⭐ <b>ENTER NOW (${tier1.length})</b>`);
      tier1.forEach((r, i) => {
        const price = r.price ? `$${Number(r.price).toFixed(2)}` : "";
        const rsi   = r.rsi   ? ` RSI-D:${Number(r.rsi).toFixed(0)}`   : "";
        const wrsi  = r.weeklyRsi ? ` RSI-W:${Number(r.weeklyRsi).toFixed(0)}` : "";
        lines.push(`${i + 1}. <b>${r.sym}</b> ${price}${rsi}${wrsi}`);
        lines.push(`   Weekly+4H flip | ${r.weeksAgo === 0 ? "flip THIS WEEK" : r.weeksAgo + "wk ago"}`);
      });
    }
    if (tier2.length > 0) {
      lines.push(`\n🟢 <b>4H BULLISH (${tier2.length})</b>`);
      tier2.slice(0, 5).forEach(r => {
        const price = r.price ? `$${Number(r.price).toFixed(2)}` : "";
        lines.push(`• <b>${r.sym}</b> ${price} | ${r.weeksAgo === 0 ? "THIS WEEK" : r.weeksAgo + "wk ago"}`);
      });
    }
    if (tier1.length === 0 && tier2.length === 0) {
      lines.push("No ENTER signals today.");
    }
  }

  // Confidence
  if (agentBrief && agentBrief.confidence) {
    lines.push("");
    lines.push(`📊 Confidence: ${agentBrief.confidence}`);
  }

  return lines.join("\n");
}

function buildMessage2(weeklyMonitor) {
  const lines = [];
  const wm = weeklyMonitor || [];
  const today = getTodayET();

  const tierApp = wm.filter(r => r.tierApp);
  const tier1   = wm.filter(r => r.tier1 && !r.tierApp);
  const tier2   = wm.filter(r => r.tier2 && !r.tier1 && !r.tierApp);
  const tier3   = wm.filter(r => r.tier3 && !r.tier1 && !r.tier2 && !r.tierApp);
  const watching = wm.filter(r => !r.tier1 && !r.tier2 && !r.tier3 && !r.tierApp);

  // Flip age groups
  const thisWeek = wm.filter(r => r.weeksAgo === 0);
  const lastWeek = wm.filter(r => r.weeksAgo === 1);

  lines.push(`📅 <b>WEEKLY MONITOR — ${wm.length} signals</b>`);
  lines.push("");

  if (tierApp.length > 0) {
    lines.push(`⭐⭐ A++ ENTER NOW (${tierApp.length}): ${tierApp.map(r => r.sym).join(", ")}`);
  }
  if (tier1.length > 0) {
    lines.push(`⭐ ENTER NOW (${tier1.length}): ${tier1.map(r => r.sym).join(", ")}`);
  }
  if (tier2.length > 0) {
    lines.push(`🟢 4H BULL (${tier2.length}): ${tier2.map(r => r.sym).join(", ")}`);
  }
  if (tier3.length > 0) {
    lines.push(`🟣 JAX ALIGNED (${tier3.length}): ${tier3.map(r => r.sym).join(", ")}`);
  }
  if (watching.length > 0) {
    lines.push(`📅 WATCHING (${watching.length}): ${watching.map(r => r.sym).join(", ")}`);
  }

  lines.push("");

  if (thisWeek.length > 0) {
    lines.push(`🔔 <b>FLIP THIS WEEK:</b> ${thisWeek.map(r => r.sym).join(", ")}`);
  }
  if (lastWeek.length > 0) {
    lines.push(`📌 <b>FLIP LAST WEEK:</b> ${lastWeek.map(r => r.sym).join(", ")}`);
  }

  // Top weekly+JAX combos
  const weeklyJAX = wm.filter(r => r.weeklyJAX || r.weeklyJAXRecent || r.dailyJAX);
  if (weeklyJAX.length > 0) {
    lines.push("");
    lines.push("🎯 <b>Weekly+JAX combos:</b>");
    weeklyJAX.slice(0, 6).forEach(r => {
      const price = r.price    ? `$${Number(r.price).toFixed(2)}`              : "";
      const drsi  = r.rsi      ? ` RSI-D:${Number(r.rsi).toFixed(1)}`          : "";
      const wrsi  = r.weeklyRsi? ` RSI-W:${Number(r.weeklyRsi).toFixed(0)}`    : "";
      const jax   = r.weeklyJAXRecent ? " 🔥WkJAX" : r.dailyJAX ? " 🟢D-JAX" : "";
      lines.push(`• <b>${r.sym}</b> ${price}${drsi}${wrsi}${jax}`);
    });
  }

  return lines.join("\n");
}

function buildMessage3(jaxScan, weinstein, weeklyMonitor) {
  const lines = [];

  // JAX green arrows today — top 8, bull 4/5+ only
  const allArrows   = (jaxScan || []).filter(r => r.greenArrow);
  const greenArrows = allArrows
    .filter(r => (r.bullScore || 0) >= 4)
    .sort((a, b) => (b.bullScore || 0) - (a.bullScore || 0))
    .slice(0, 8);
  lines.push(`🟢 <b>JAX TODAY — top ${greenArrows.length} of ${allArrows.length} arrows (bull 4-5/5)</b>`);
  if (greenArrows.length > 0) {
    greenArrows.forEach(r => {
      const price   = r.price    ? `$${Number(r.price).toFixed(2)}`  : "";
      const bull    = r.bullScore? ` bull${r.bullScore}/5`            : "";
      const rsi     = r.rsi      ? ` RSI${Number(r.rsi).toFixed(0)}` : "";
      const trigger = r.utBuy ? " UTBuy" : r.stFlipped ? " STFlip" : "";
      lines.push(`• <b>${r.sym}</b> ${price}${bull}${rsi}${trigger}`);
    });
  } else {
    lines.push("No bull 4-5/5 arrows today.");
  }

  // Top potential setups — weekly bullish + JAX
  const wm = Array.isArray(weeklyMonitor) ? weeklyMonitor : [];
  const wmSyms = new Set(wm.map(r => r.sym));
  const weeklyJAX = allArrows
    .filter(r => wmSyms.has(r.sym))
    .sort((a, b) => (b.bullScore || 0) - (a.bullScore || 0))
    .slice(0, 6);

  // Also include weekly stocks with weekly JAX fired (no daily arrow needed)
  const weeklyJAXOnly = wm
    .filter(r => (r.weeklyJAX || r.weeklyJAXRecent) && !weeklyJAX.find(j => j.sym === r.sym))
    .slice(0, 4);

  const allCombos = [
    ...weeklyJAX.map(r => {
      const wmEntry = wm.find(w => w.sym === r.sym);
      return { sym: r.sym, price: r.price, rsiD: r.rsi, rsiW: wmEntry?.weeklyRsi };
    }),
    ...weeklyJAXOnly.map(r => ({ sym: r.sym, price: r.price, rsiD: r.rsi, rsiW: r.weeklyRsi }))
  ].slice(0, 6);

  if (allCombos.length > 0) {
    lines.push("");
    lines.push("🎯 <b>Top setups (weekly bullish + JAX):</b>");
    allCombos.forEach(r => {
      const price = r.price ? `$${Number(r.price).toFixed(2)}` : "";
      const rsiD  = r.rsiD  ? ` RSI-D:${Number(r.rsiD).toFixed(1)}`  : "";
      const rsiW  = r.rsiW  ? ` RSI-W:${Number(r.rsiW).toFixed(1)}`  : "";
      lines.push(`   <b>${r.sym}</b> ${price}${rsiD}${rsiW}`);
    });
  }

  // Weinstein
  if (weinstein && Array.isArray(weinstein) && weinstein.length > 0) {
    lines.push("");
    const enters = weinstein.filter(r => r.action === "ENTER");
    const waits  = weinstein.filter(r => r.action === "WAIT");
    const avoids = weinstein.filter(r => r.action === "AVOID");
    lines.push(`📊 <b>WEINSTEIN (${weinstein.length} analyzed)</b>`);
    if (enters.length > 0) lines.push(`🟢 ENTER (${enters.length}): ${enters.map(r => r.sym).join(", ")}`);
    if (waits.length  > 0) lines.push(`🟡 WAIT  (${waits.length}): ${waits.map(r => r.sym).join(", ")}`);
    if (avoids.length > 0) lines.push(`🔴 AVOID (${avoids.length}): ${avoids.slice(0, 8).map(r => r.sym).join(", ")}${avoids.length > 8 ? " +" + (avoids.length - 8) + " more" : ""}`);

    // ENTER details
    if (enters.length > 0) {
      lines.push("");
      enters.slice(0, 3).forEach(r => {
        const price  = r.price     ? `$${Number(r.price).toFixed(2)}`    : "";
        const entry  = r.entryZone ? ` Entry $${Number(r.entryZone).toFixed(2)}` : "";
        const stop   = r.stop      ? ` Stop $${Number(r.stop).toFixed(2)}`       : "";
        const target = r.target    ? ` Target $${Number(r.target).toFixed(2)}`   : "";
        lines.push(`• <b>${r.sym}</b> ${price}${entry}${stop}${target}`);
        if (r.summary) lines.push(`  ${r.summary}`);
      });
    }
  }

  return lines.join("\n");
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userPrompt) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    console.warn("⚠️  No ANTHROPIC_API_KEY — skipping agent brief generation");
    return null;
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      "claude-sonnet-4-5",
      max_tokens: 2500,
      temperature: 0.1,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }]
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers:  {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length":    Buffer.byteLength(body)
      }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const result = JSON.parse(d);
          if (result.content && result.content[0]) {
            resolve(result.content[0].text);
          } else {
            reject(new Error("No content in Claude response: " + d));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Firebase PUT ──────────────────────────────────────────────────────────────

function fbPut(path, payload) {
  return new Promise((resolve, reject) => {
    const url  = new URL(`${FIREBASE_DB_URL}/screener/${path}.json`);
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   "PUT",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("📡 Fetching Firebase data...");

  const [weeklyMonitor, jaxScan, weinstein] = await Promise.all([
    fbGet("weekly_monitor"),
    fbGet("jax_scan"),
    fbGet("weinstein")
  ]);

  const wm  = Array.isArray(weeklyMonitor) ? weeklyMonitor : [];
  const jax = Array.isArray(jaxScan)       ? jaxScan       : [];
  const ws  = Array.isArray(weinstein)     ? weinstein      : [];

  console.log(`✅ Weekly: ${wm.length} | JAX: ${jax.filter(r => r.greenArrow).length} arrows | Weinstein: ${ws.length}`);

  // ── Generate fresh agent brief via Claude API ────────────────────────────
  let agentBrief = null;
  console.log("🤖 Generating agent brief via Claude...");
  try {
    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric"
    });

    const tier1    = wm.filter(r => r.tier1 || r.tierApp);
    const tier2    = wm.filter(r => r.tier2 && !r.tier1 && !r.tierApp);
    const greenArrows = jax.filter(r => r.greenArrow && (r.bullScore || 0) >= 4);
    const wsEnters = ws.filter(r => r.action === "ENTER");

    const systemPrompt = `You are a professional trading advisor. Respond ONLY with a raw JSON object, no markdown, no backticks. Start with { and end with }.
Return this exact structure:
{
  "context": "one sentence market context",
  "confidence": "X/10 — brief reason",
  "avoid": "brief list of what to avoid today",
  "trades": [
    {
      "sym": "TICKER",
      "score": 8,
      "action": "ENTER",
      "entry": 123.45,
      "stop": 120.00,
      "target": 135.00,
      "shares": 12,
      "risk_pct": 1.0,
      "win_rate_note": "brief signal description",
      "notes": "score breakdown"
    }
  ],
  "recommendation": "one paragraph summary",
  "skipped": "brief note on skipped signals"
}`;

    const userPrompt = `Date: ${today}
Account: $10000 | Risk: 1% ($100) | Max trades: 5

WEEKLY MONITOR (${wm.length} signals):
TIER 1 ENTER NOW: ${tier1.map(r => `${r.sym} $${Number(r.price||0).toFixed(2)} W-RSI:${Number(r.weeklyRsi||0).toFixed(0)} D-RSI:${Number(r.rsi||0).toFixed(0)} flip${r.weeksAgo}wk ${r.h4FlipRecent?"4H-JUST-FLIPPED":"4H-bull"}`).join(", ") || "none"}
TIER 2 4H BULL: ${tier2.map(r => `${r.sym} $${Number(r.price||0).toFixed(2)} W-RSI:${Number(r.weeklyRsi||0).toFixed(0)}`).join(", ") || "none"}

JAX GREEN ARROWS (bull 4-5/5): ${greenArrows.slice(0,10).map(r => `${r.sym} $${Number(r.price||0).toFixed(2)} bull${r.bullScore}/5 RSI${Number(r.rsi||0).toFixed(0)}`).join(", ") || "none"}

WEINSTEIN ENTER: ${wsEnters.map(r => `${r.sym} $${Number(r.price||0).toFixed(2)}`).join(", ") || "none"}

Give me my top 5 trades for today. Score each 0-10. ENTER only if score >= 4.`;

    const raw = await callClaude(systemPrompt, userPrompt);
    if (raw) {
      let clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
      const start = clean.indexOf("{");
      const end   = clean.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        agentBrief = JSON.parse(clean.substring(start, end + 1));
        console.log(`✅ Agent brief generated — ${agentBrief.trades?.length || 0} trades`);

        // Save to Firebase so Agent tab auto-updates
        await fbPut("agent_brief", {
          data:    raw,
          text:    raw,
          html:    "",
          time:    new Date().toISOString(),
          isJson:  true,
          savedAt: new Date().toISOString(),
          device:  "github-actions"
        });
        console.log("✅ Agent brief saved to Firebase");
      }
    }
  } catch (e) {
    console.warn("⚠️  Agent brief generation failed:", e.message);
  }

  // ── Build and send Telegram messages ────────────────────────────────────
  const msg1 = buildMessage1(agentBrief, wm);
  const msg2 = buildMessage2(wm);
  const msg3 = buildMessage3(jax, ws, wm);

  console.log("📤 Sending Message 1 (Trades)...");
  await sendTelegram(msg1);
  await sleep(1000);

  console.log("📤 Sending Message 2 (Weekly Monitor)...");
  await sendTelegram(msg2);
  await sleep(1000);

  console.log("📤 Sending Message 3 (JAX + Weinstein)...");
  await sendTelegram(msg3);

  console.log("✅ All 3 messages sent.");
}

main().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
