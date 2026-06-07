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

function buildMessage3(jaxScan, weinstein) {
  const lines = [];

  // JAX green arrows today
  const greenArrows = (jaxScan || []).filter(r => r.greenArrow);
  lines.push(`🟢 <b>JAX TODAY — ${greenArrows.length} green arrow${greenArrows.length !== 1 ? "s" : ""}</b>`);
  if (greenArrows.length > 0) {
    greenArrows.slice(0, 10).forEach(r => {
      const price = r.price    ? `$${Number(r.price).toFixed(2)}`         : "";
      const bull  = r.bullScore? ` bull${r.bullScore}/5`                   : "";
      const rsi   = r.rsi      ? ` RSI${Number(r.rsi).toFixed(0)}`        : "";
      const trigger = r.utBuy ? " UTBuy" : r.stFlipped ? " STFlip" : "";
      lines.push(`• <b>${r.sym}</b> ${price}${bull}${rsi}${trigger}`);
    });
  } else {
    lines.push("No green arrows fired yet today.");
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("📡 Fetching Firebase data...");

  const [weeklyMonitor, jaxScan, weinstein, agentBriefRaw] = await Promise.all([
    fbGet("weekly_monitor"),
    fbGet("jax_scan"),
    fbGet("weinstein"),
    fbGet("agent_brief")
  ]);

  // Parse agent brief — it's stored as {text, html, time, isJson}
  let agentBrief = null;
  if (agentBriefRaw && agentBriefRaw.text) {
    try {
      let clean = agentBriefRaw.text.replace(/```json/gi, "").replace(/```/g, "").trim();
      const start = clean.indexOf("{");
      const end   = clean.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        agentBrief = JSON.parse(clean.substring(start, end + 1));
      }
    } catch (e) {
      console.warn("⚠️  Could not parse agent brief JSON:", e.message);
    }
  }

  // Summary
  const wm = Array.isArray(weeklyMonitor) ? weeklyMonitor : [];
  const jax = Array.isArray(jaxScan) ? jaxScan : [];
  const ws = Array.isArray(weinstein) ? weinstein : [];
  console.log(`✅ Weekly: ${wm.length} | JAX: ${jax.filter(r => r.greenArrow).length} arrows | Weinstein: ${ws.length} | Agent brief: ${agentBrief ? "parsed" : "not available"}`);

  // Build messages
  const msg1 = buildMessage1(agentBrief, wm);
  const msg2 = buildMessage2(wm);
  const msg3 = buildMessage3(jax, ws);

  // Send with 1s gap between messages
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
