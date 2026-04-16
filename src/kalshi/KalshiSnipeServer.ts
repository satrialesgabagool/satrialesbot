/**
 * Kalshi Snipe GUI server — Bun.serve-based HTTP dashboard.
 *
 * Serves a single-page dashboard that polls /api/state every 2s and
 * shows live bankroll, pending snipes, events feed, and stage/bucket
 * breakdowns — equivalent to the Python tkinter snipe_gui.py, minus the
 * embedded matplotlib charts (browser-rendered instead).
 *
 * Run mode: owns a KalshiSnipeHunter, starts the hunter in the background
 * while serving HTTP on the configured port. Control endpoints:
 *   GET  /                — dashboard.html (inline)
 *   GET  /api/state       — hunter snapshot JSON
 *   POST /api/pause       — hunter.pause()
 *   POST /api/resume      — hunter.resume()
 *   POST /api/stop        — hunter.stop()
 */

import { KalshiSnipeHunter, type HunterSnapshot } from "./KalshiSnipeHunter";

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Satriales · Kalshi BTC Snipe</title>
<style>
  :root {
    --bg:#0b0f14; --panel:#121821; --panel2:#0f141c; --border:#1f2835;
    --text:#d7e1ee; --dim:#6c7a8c; --accent:#51d6ff;
    --green:#34d399; --red:#f87171; --yellow:#fbbf24; --blue:#60a5fa;
    --mono: ui-monospace,Consolas,Monaco,"SF Mono",monospace;
  }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,sans-serif; }
  body { min-height:100vh; padding:18px 22px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 6px 0; letter-spacing:0.5px; }
  h2 { font-size:12px; font-weight:600; margin:0 0 8px 0; color:var(--dim); text-transform:uppercase; letter-spacing:0.8px; }
  .row { display:grid; gap:16px; }
  .row.top { grid-template-columns: 1fr 1fr 1fr 1fr; margin-bottom:16px; }
  .row.body { grid-template-columns: 1.3fr 1fr; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .stat-label { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:0.8px; }
  .stat-value { font-size:26px; font-weight:600; margin-top:4px; font-family:var(--mono); }
  .stat-sub { font-size:11px; color:var(--dim); margin-top:2px; }
  .green { color:var(--green); }
  .red { color:var(--red); }
  .yellow { color:var(--yellow); }
  .blue { color:var(--blue); }
  .dim { color:var(--dim); }
  table { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:12px; }
  th { text-align:left; padding:6px 8px; color:var(--dim); font-weight:500; border-bottom:1px solid var(--border); text-transform:uppercase; font-size:10px; letter-spacing:0.5px; }
  td { padding:5px 8px; border-bottom:1px solid var(--panel2); }
  tr:hover { background:var(--panel2); }
  .events { max-height:380px; overflow-y:auto; font-family:var(--mono); font-size:12px; }
  .events .line { padding:3px 6px; border-bottom:1px solid var(--panel2); white-space:pre; }
  .events .line.FIRE { color:var(--blue); }
  .events .line.WIN { color:var(--green); }
  .events .line.LOSS { color:var(--red); }
  .events .line.DROPPED { color:var(--yellow); }
  .events .line.INFO { color:var(--dim); }
  .btn { display:inline-block; padding:6px 14px; margin-right:8px; font-size:12px; border:1px solid var(--border); background:var(--panel2); color:var(--text); border-radius:6px; cursor:pointer; font-family:inherit; }
  .btn:hover { background:var(--panel); border-color:var(--accent); }
  .btn.danger:hover { border-color:var(--red); color:var(--red); }
  .controls { margin-top:12px; }
  .mode-chip { display:inline-block; padding:2px 10px; border-radius:999px; font-size:10px; font-weight:700; letter-spacing:0.5px; vertical-align:middle; margin-left:8px; }
  .mode-chip.PAPER { background:#193556; color:#93c5fd; }
  .mode-chip.LIVE { background:#411817; color:#fca5a5; }
  .footer { margin-top:16px; font-size:11px; color:var(--dim); text-align:center; font-family:var(--mono); }
  .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
  .spot { font-family:var(--mono); font-size:13px; color:var(--dim); }
  .badge { display:inline-block; padding:1px 8px; margin-left:6px; background:var(--panel2); border-radius:999px; font-size:10px; color:var(--dim); }
  .stale { color:var(--red); }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>
      🎯 Satriales · Kalshi BTC Snipe
      <span id="mode" class="mode-chip PAPER">PAPER</span>
      <span id="pauseBadge" class="badge" style="display:none">PAUSED</span>
    </h1>
    <div class="spot">
      BTC <span id="spot">–</span>
      · uptime <span id="uptime">0m</span>
      · last update <span id="lastUpdate">–</span>
    </div>
  </div>
  <div class="controls">
    <button class="btn" id="btnPause">Pause</button>
    <button class="btn" id="btnResume">Resume</button>
    <button class="btn danger" id="btnStop">Stop</button>
  </div>
</div>

<div class="row top">
  <div class="panel">
    <div class="stat-label">Bankroll</div>
    <div class="stat-value" id="bankroll">$–</div>
    <div class="stat-sub" id="bankrollSub">–</div>
  </div>
  <div class="panel">
    <div class="stat-label">Total P&amp;L</div>
    <div class="stat-value" id="pnl">$–</div>
    <div class="stat-sub" id="pnlSub">ROI –%</div>
  </div>
  <div class="panel">
    <div class="stat-label">Win Rate</div>
    <div class="stat-value" id="wr">–%</div>
    <div class="stat-sub" id="wrSub">– resolved · – pending</div>
  </div>
  <div class="panel">
    <div class="stat-label">Peak / Drawdown</div>
    <div class="stat-value" id="peak">$–</div>
    <div class="stat-sub" id="peakSub">dd –%</div>
  </div>
</div>

<div class="row body">
  <div>
    <div class="panel" style="margin-bottom:16px;">
      <h2>Pending Snipes (<span id="pendingCt">0</span>)</h2>
      <table>
        <thead>
          <tr><th>Ticker</th><th>Side</th><th>Entry</th><th>Shares</th><th>Cost</th><th>Stage</th><th>Conv</th><th>Strike</th><th>Closes</th></tr>
        </thead>
        <tbody id="pendingBody"><tr><td colspan="9" class="dim">No pending snipes.</td></tr></tbody>
      </table>
    </div>
    <div class="panel">
      <h2>By Stage</h2>
      <table>
        <thead><tr><th>Stage</th><th>Trades</th><th>WR</th><th>P&amp;L</th></tr></thead>
        <tbody id="stageBody"></tbody>
      </table>
      <h2 style="margin-top:14px;">By Conviction</h2>
      <table>
        <thead><tr><th>Conviction</th><th>Trades</th><th>WR</th><th>P&amp;L</th></tr></thead>
        <tbody id="convictionBody"></tbody>
      </table>
      <h2 style="margin-top:14px;">By Bucket (stage/conv)</h2>
      <table>
        <thead><tr><th>Bucket</th><th>Trades</th><th>WR</th><th>P&amp;L</th></tr></thead>
        <tbody id="bucketBody"></tbody>
      </table>
    </div>
  </div>
  <div class="panel">
    <h2>Event Log (newest first)</h2>
    <div class="events" id="events"></div>
  </div>
</div>

<div class="footer" id="footer">–</div>

<script>
const $ = (id) => document.getElementById(id);

function fmt(n, digits=2) {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toFixed(digits);
}
function money(n) {
  if (n == null || !Number.isFinite(n)) return "$–";
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toFixed(2);
}
function sgnMoney(n) {
  if (n == null || !Number.isFinite(n)) return "$–";
  const sign = n >= 0 ? "+" : "-";
  return sign + "$" + Math.abs(n).toFixed(2);
}
function pct(n) {
  if (n == null || !Number.isFinite(n)) return "–%";
  return n.toFixed(1) + "%";
}
function color(n, el) {
  el.classList.remove("green","red","yellow");
  if (n > 0) el.classList.add("green");
  else if (n < 0) el.classList.add("red");
}
function timeAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.round(m / 6) / 10;
  return h.toFixed(1) + "h";
}

let lastSnap = null;

async function fetchState() {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const s = await r.json();
    render(s);
    lastSnap = s;
    $("footer").classList.remove("stale");
  } catch (e) {
    $("footer").textContent = "[fetch error] " + e.message;
    $("footer").classList.add("stale");
  }
}

function render(s) {
  // Header
  $("mode").textContent = s.mode;
  $("mode").className = "mode-chip " + s.mode;
  $("pauseBadge").style.display = s.paused ? "inline-block" : "none";
  $("spot").textContent = s.spotBtc ? "$" + Math.round(s.spotBtc).toLocaleString() : "–";
  $("uptime").textContent = timeAgo(Date.now() - s.startedAtMs);
  $("lastUpdate").textContent = timeAgo(Date.now() - s.lastUpdateMs) + " ago";

  // Header stats
  const roi = s.config.initialBankroll ? ((s.bankroll - s.config.initialBankroll) / s.config.initialBankroll) * 100 : 0;
  const resolved = s.totalSnipes - s.pending.length;
  const losses = Math.max(0, resolved - s.totalWins);
  const wr = resolved ? (s.totalWins / resolved) * 100 : 0;
  const dd = s.peakBankroll > 0 ? ((s.peakBankroll - s.bankroll) / s.peakBankroll) * 100 : 0;

  $("bankroll").textContent = money(s.bankroll);
  $("bankroll").className = "stat-value";
  if (s.bankroll < s.config.initialBankroll) $("bankroll").classList.add("red");
  else if (s.bankroll > s.config.initialBankroll) $("bankroll").classList.add("green");
  $("bankrollSub").textContent = "init " + money(s.config.initialBankroll) + " · fees " + money(s.totalFees);

  const pnlEl = $("pnl");
  pnlEl.textContent = sgnMoney(s.totalPnl);
  color(s.totalPnl, pnlEl);
  $("pnlSub").textContent = "ROI " + (roi >= 0 ? "+" : "") + roi.toFixed(1) + "%";

  $("wr").textContent = resolved ? pct(wr) : "–%";
  $("wrSub").textContent = resolved ? (s.totalWins + "W / " + losses + "L resolved · " + s.pending.length + " pending") : (s.pending.length + " pending · nothing settled yet");

  $("peak").textContent = money(s.peakBankroll);
  $("peakSub").textContent = "dd " + pct(dd) + (s.bustCount ? " · " + s.bustCount + " busts" : "");

  // Pending
  const pending = s.pending;
  $("pendingCt").textContent = pending.length;
  const pBody = $("pendingBody");
  if (!pending.length) {
    pBody.innerHTML = '<tr><td colspan="9" class="dim">No pending snipes.</td></tr>';
  } else {
    pBody.innerHTML = pending.map(p => {
      const closesIn = p.closeTs * 1000 - Date.now();
      const closeTxt = closesIn > 0 ? "in " + timeAgo(closesIn) : "due";
      return \`<tr>
        <td>\${p.marketTicker}</td>
        <td>\${p.side}</td>
        <td>\${fmt(p.entryPrice, 3)}</td>
        <td>\${fmt(p.shares, 2)}</td>
        <td>\${money(p.shares * p.totalCost)}</td>
        <td>\${p.stage}</td>
        <td>\${p.conviction}</td>
        <td>$\${Math.round(p.strike).toLocaleString()}</td>
        <td class="dim">\${closeTxt}</td>
      </tr>\`;
    }).join("");
  }

  // Events (newest first, cap 60)
  const events = s.events.slice(-60).reverse();
  $("events").innerHTML = events.map(e => {
    const ts = new Date(e.ts).toLocaleTimeString();
    let line = "[" + ts + "] " + e.kind;
    if (e.stage) line += " " + e.stage;
    if (e.ticker) line += " " + e.ticker;
    if (e.side) line += " " + e.side;
    if (e.price != null) line += " @" + fmt(e.price, 3);
    if (e.size != null && e.kind === "FIRE") line += " $" + fmt(e.size, 2);
    if (e.pnl != null && e.kind !== "FIRE") line += " pnl " + sgnMoney(e.pnl);
    if (e.bankroll != null) line += " bank " + money(e.bankroll);
    if (e.message) line += " — " + e.message;
    return '<div class="line ' + e.kind + '">' + escapeHtml(line) + '</div>';
  }).join("");

  // Stage table
  const stage = s.stageStats;
  const stageRows = ["prime","late","wide"].map(k => renderStatRow(k, stage[k])).join("");
  $("stageBody").innerHTML = stageRows || '<tr><td colspan="4" class="dim">–</td></tr>';

  // Conviction table
  const conv = s.convictionStats;
  const convRows = ["weak","medium","strong"].map(k => renderStatRow(k, conv[k])).join("");
  $("convictionBody").innerHTML = convRows || '<tr><td colspan="4" class="dim">–</td></tr>';

  // Bucket table — only buckets with trades
  const bucket = s.bucketStats;
  const bRows = Object.keys(bucket)
    .filter(k => bucket[k].trades > 0)
    .sort()
    .map(k => renderStatRow(k, bucket[k])).join("");
  $("bucketBody").innerHTML = bRows || '<tr><td colspan="4" class="dim">no bucket fills yet</td></tr>';

  $("footer").textContent = "polling /api/state · running=" + s.running + " · paused=" + s.paused;
}

function renderStatRow(label, row) {
  if (!row) return "";
  const wr = row.trades ? (row.wins / row.trades * 100) : 0;
  const pnl = row.pnl || 0;
  const cls = pnl > 0 ? "green" : pnl < 0 ? "red" : "";
  return \`<tr><td>\${label}</td><td>\${row.trades}</td><td>\${row.trades ? wr.toFixed(1) + "%" : "–"}</td><td class="\${cls}">\${sgnMoney(pnl)}</td></tr>\`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>\"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;" })[c]);
}

async function post(path) {
  try {
    const r = await fetch(path, { method:"POST" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    fetchState();
  } catch (e) {
    alert(path + " failed: " + e.message);
  }
}
$("btnPause").addEventListener("click",  () => post("/api/pause"));
$("btnResume").addEventListener("click", () => post("/api/resume"));
$("btnStop").addEventListener("click",   () => { if (confirm("Stop the hunter?")) post("/api/stop"); });

fetchState();
setInterval(fetchState, 2000);
</script>
</body>
</html>`;

export interface KalshiSnipeServerOptions {
  port?: number;              // default 5173
  hostname?: string;          // default "127.0.0.1"
  /** Override dashboard HTML (for testing or customization) */
  dashboardHtml?: string;
}

export class KalshiSnipeServer {
  private hunter: KalshiSnipeHunter;
  private port: number;
  private hostname: string;
  private html: string;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(hunter: KalshiSnipeHunter, opts?: KalshiSnipeServerOptions) {
    this.hunter = hunter;
    this.port = opts?.port ?? 5173;
    this.hostname = opts?.hostname ?? "127.0.0.1";
    this.html = opts?.dashboardHtml ?? DASHBOARD_HTML;
  }

  /**
   * Build a Request handler. Extracted so it can be unit-tested without
   * actually binding a port.
   */
  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (method === "GET" && path === "/") {
      return new Response(this.html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    if (method === "GET" && path === "/api/state") {
      const snap: HunterSnapshot = this.hunter.getSnapshot();
      return Response.json(snap, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (method === "POST" && path === "/api/pause") {
      this.hunter.pause();
      return Response.json({ ok: true, paused: true });
    }
    if (method === "POST" && path === "/api/resume") {
      this.hunter.resume();
      return Response.json({ ok: true, paused: false });
    }
    if (method === "POST" && path === "/api/stop") {
      this.hunter.stop();
      return Response.json({ ok: true, stopping: true });
    }

    return new Response("Not found", { status: 404 });
  };

  /**
   * Start the HTTP server. Hunter must be started separately (the caller
   * owns that lifecycle — typically `await Promise.all([server.start(), hunter.run()])`).
   */
  start(): { port: number } {
    const server = Bun.serve({
      hostname: this.hostname,
      port: this.port,
      fetch: this.handle,
      error: (err: Error) => {
        console.error(`[KalshiSnipeServer] handler error: ${err.message}`);
        return new Response("Internal server error", { status: 500 });
      },
    });
    this.server = server;
    const port = Number(server.port);
    console.log(`[KalshiSnipeServer] listening on http://${this.hostname}:${port}`);
    return { port };
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }
}
