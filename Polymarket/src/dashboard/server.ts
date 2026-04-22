/**
 * Dashboard HTTP server — serves real-time stats from both engines.
 *
 * Reads state files + CSVs every 2 seconds and pushes updates via SSE.
 * Zero dependencies beyond Bun's built-in HTTP server.
 *
 * Endpoints:
 *   GET /           — Dashboard HTML page
 *   GET /api/state  — JSON snapshot of both engines
 *   GET /api/stream — Server-Sent Events for live updates
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const STATE_DIR = join(ROOT, "state");
const RESULTS_DIR = join(ROOT, "results");

// ─── State readers ──────────────────────────────────────────────────

interface WeatherState {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  pending: any[];
  completed: any[];
  bankroll: number;
}

interface BtcState {
  sessionPnl: number;
  sessionLoss: number;
  roundsCompleted: number;
  completedRounds: any[];
}

interface DashboardState {
  timestamp: number;
  weather: WeatherState & { recentOpportunities: any[] };
  btc: BtcState & { wins: number; losses: number; flats: number; avgPnl: number; bankroll: number };
  combined: { totalPnl: number; totalTrades: number; winRate: number; totalBankroll: number };
}

function readJSON<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readCSVTail(path: string, maxRows: number = 50): any[] {
  try {
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8").trim();
    const lines = content.split("\n");
    if (lines.length < 2) return [];

    const headers = lines[0].split(",");
    const dataLines = lines.slice(1);
    const recent = dataLines.slice(-maxRows);

    return recent.map(line => {
      const values = line.split(",");
      const obj: any = {};
      headers.forEach((h, i) => obj[h.trim()] = values[i]?.trim() ?? "");
      return obj;
    }).reverse(); // newest first
  } catch {
    return [];
  }
}

function getState(): DashboardState {
  // Weather state
  const wx = readJSON<WeatherState>(join(STATE_DIR, "weather-state.json"), {
    totalPnl: 0, totalTrades: 0, wins: 0, losses: 0,
    pending: [], completed: [], bankroll: 20,
  });

  const wxOpps = readCSVTail(join(RESULTS_DIR, "weather-opportunities.csv"), 30);

  // BTC state — try all strategy state files
  const btcStrategies = ["snipe-v2", "latency-arb", "simulation", "signal-momentum", "observer"];
  let btc: BtcState = {
    sessionPnl: 0, sessionLoss: 0, roundsCompleted: 0, completedRounds: [],
  };

  for (const s of btcStrategies) {
    const path = join(STATE_DIR, `engine-sim-${s}.json`);
    if (existsSync(path)) {
      btc = readJSON<BtcState>(path, btc);
      break;
    }
  }

  // Also try prod state
  if (btc.roundsCompleted === 0) {
    for (const s of btcStrategies) {
      const path = join(STATE_DIR, `engine-prod-${s}.json`);
      if (existsSync(path)) {
        btc = readJSON<BtcState>(path, btc);
        break;
      }
    }
  }

  const btcWins = btc.completedRounds.filter((r: any) => r.pnl > 0).length;
  const btcLosses = btc.completedRounds.filter((r: any) => r.pnl < 0).length;
  const btcFlats = btc.completedRounds.filter((r: any) => r.pnl === 0).length;
  const btcAvgPnl = btc.completedRounds.length > 0
    ? btc.completedRounds.reduce((s: number, r: any) => s + r.pnl, 0) / btc.completedRounds.length
    : 0;

  // Each engine has its own $20 bankroll
  const BTC_STARTING_BANKROLL = 20;
  const btcBankroll = BTC_STARTING_BANKROLL + btc.sessionPnl;

  // Combined totals
  const totalPnl = wx.totalPnl + btc.sessionPnl;
  const totalTrades = wx.totalTrades + btc.roundsCompleted;
  const totalWins = wx.wins + btcWins;
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const totalBankroll = wx.bankroll + btcBankroll;

  return {
    timestamp: Date.now(),
    weather: { ...wx, recentOpportunities: wxOpps },
    btc: { ...btc, wins: btcWins, losses: btcLosses, flats: btcFlats, avgPnl: btcAvgPnl, bankroll: btcBankroll },
    combined: { totalPnl, totalTrades, winRate, totalBankroll },
  };
}

// ─── HTML Dashboard ─────────────────────────────────────────────────

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Satriales Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --border: #30363d; --text: #e6edf3; --dim: #8b949e;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --cyan: #58a6ff; --purple: #bc8cff; --blue: #388bfd;
    --orange: #f0883e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 16px;
    min-height: 100vh;
  }

  /* Header */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; margin-bottom: 16px;
  }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header h1 span { color: var(--cyan); }
  .status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dim); }
  .status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Grid layout */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }

  /* Cards */
  .card {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; position: relative; overflow: hidden;
  }
  .card.highlight { border-color: var(--cyan); }
  .card-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 1px; color: var(--dim); margin-bottom: 8px;
  }
  .card-value {
    font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums;
  }
  .card-sub { font-size: 13px; color: var(--dim); margin-top: 4px; }
  .card-icon {
    position: absolute; top: 14px; right: 16px;
    font-size: 24px; opacity: 0.15;
  }
  .pnl-pos { color: var(--green); }
  .pnl-neg { color: var(--red); }
  .pnl-zero { color: var(--dim); }

  /* Section headers */
  .section-header {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 0; margin-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .section-header h2 { font-size: 15px; font-weight: 600; }
  .section-header .badge {
    font-size: 11px; padding: 2px 8px; border-radius: 12px;
    font-weight: 600;
  }
  .badge-wx { background: rgba(56,139,253,0.15); color: var(--blue); }
  .badge-btc { background: rgba(188,140,255,0.15); color: var(--purple); }

  /* Stat rows */
  .stat-row {
    display: flex; justify-content: space-between;
    padding: 6px 0; border-bottom: 1px solid rgba(48,54,61,0.5);
    font-size: 13px;
  }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--dim); }
  .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }

  /* Tables */
  .table-wrap {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; overflow: hidden; margin-bottom: 16px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    text-align: left; padding: 8px 12px; background: var(--bg3);
    font-weight: 600; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--dim); border-bottom: 1px solid var(--border);
    position: sticky; top: 0;
  }
  td { padding: 7px 12px; border-bottom: 1px solid rgba(48,54,61,0.3); font-variant-numeric: tabular-nums; }
  tr:hover td { background: rgba(56,139,253,0.04); }
  .action-yes { color: var(--green); font-weight: 600; }
  .action-no { color: var(--red); font-weight: 600; }
  .edge-high { color: var(--green); }
  .edge-med { color: var(--yellow); }
  .edge-low { color: var(--dim); }
  .scrollable { max-height: 300px; overflow-y: auto; }

  /* Progress bars */
  .progress-bar {
    height: 6px; background: var(--bg3); border-radius: 3px;
    overflow: hidden; margin-top: 6px;
  }
  .progress-fill {
    height: 100%; border-radius: 3px; transition: width 0.5s ease;
  }
  .fill-green { background: var(--green); }
  .fill-red { background: var(--red); }
  .fill-cyan { background: var(--cyan); }

  /* Ensemble mini chart */
  .ensemble-bar {
    display: flex; gap: 1px; align-items: flex-end; height: 30px; margin-top: 8px;
  }
  .ensemble-bar div {
    flex: 1; background: var(--cyan); border-radius: 1px 1px 0 0;
    min-width: 2px; opacity: 0.7; transition: height 0.3s;
  }

  /* Footer */
  .footer { text-align: center; padding: 16px; color: var(--dim); font-size: 11px; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <h1><span>SATRIALES</span> Trading Dashboard</h1>
  <div class="status">
    <div class="dot" id="statusDot"></div>
    <span id="statusText">Connecting...</span>
    <span style="margin-left:12px" id="lastUpdate"></span>
  </div>
</div>

<!-- Combined Overview -->
<div class="grid">
  <div class="card highlight">
    <div class="card-icon">$</div>
    <div class="card-title">Combined P&L</div>
    <div class="card-value" id="combinedPnl">$0.00</div>
    <div class="card-sub" id="combinedSub">0 trades</div>
  </div>
  <div class="card">
    <div class="card-icon">W</div>
    <div class="card-title">Win Rate</div>
    <div class="card-value" id="combinedWinRate">0%</div>
    <div class="card-sub" id="combinedRecord">0W / 0L</div>
  </div>
  <div class="card">
    <div class="card-icon">B</div>
    <div class="card-title">Total Bankroll</div>
    <div class="card-value" id="totalBankroll">$40.00</div>
    <div class="card-sub" id="bankrollBreakdown">WX $20.00 + BTC $20.00</div>
  </div>
</div>

<!-- Two-column: Weather + BTC -->
<div class="grid-2">

  <!-- Weather Engine -->
  <div>
    <div class="section-header">
      <h2>Weather Temperature Markets</h2>
      <span class="badge badge-wx">GFS+ECMWF</span>
    </div>

    <div class="grid" style="grid-template-columns: 1fr 1fr;">
      <div class="card">
        <div class="card-title">Weather P&L</div>
        <div class="card-value" id="wxPnl">$0.00</div>
        <div class="card-sub" id="wxRecord">0W / 0L</div>
        <div class="progress-bar"><div class="progress-fill fill-green" id="wxWinBar" style="width:0%"></div></div>
      </div>
      <div class="card">
        <div class="card-title">Bankroll</div>
        <div class="card-value" id="wxBankroll">$20.00</div>
        <div class="card-sub" id="wxPending">0 pending trades</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 12px;">
      <div class="card-title">Weather Stats</div>
      <div class="stat-row"><span class="stat-label">Total Trades</span><span class="stat-value" id="wxTotalTrades">0</span></div>
      <div class="stat-row"><span class="stat-label">Win Rate</span><span class="stat-value" id="wxWinRate">0%</span></div>
      <div class="stat-row"><span class="stat-label">Avg Edge at Entry</span><span class="stat-value" id="wxAvgEdge">--</span></div>
      <div class="stat-row"><span class="stat-label">Best Trade</span><span class="stat-value pnl-pos" id="wxBestTrade">--</span></div>
      <div class="stat-row"><span class="stat-label">Worst Trade</span><span class="stat-value pnl-neg" id="wxWorstTrade">--</span></div>
    </div>

    <!-- Pending Trades -->
    <div class="table-wrap">
      <table>
        <thead><tr><th>City</th><th>Date</th><th>Bracket</th><th>Action</th><th>Edge</th><th>Cost</th></tr></thead>
        <tbody id="wxPendingTable"></tbody>
      </table>
    </div>

    <!-- Recent Opportunities -->
    <div class="table-wrap">
      <div style="padding:8px 12px;background:var(--bg3);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--dim);">
        Recent Opportunities Scanned
      </div>
      <div class="scrollable">
        <table>
          <thead><tr><th>City</th><th>Date</th><th>Bracket</th><th>Forecast</th><th>Market</th><th>Edge</th></tr></thead>
          <tbody id="wxOppsTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- BTC 5-Min Engine -->
  <div>
    <div class="section-header">
      <h2>BTC 5-Min Snipe</h2>
      <span class="badge badge-btc">Snipe V2</span>
    </div>

    <div class="grid" style="grid-template-columns: 1fr 1fr;">
      <div class="card">
        <div class="card-title">Session P&L</div>
        <div class="card-value" id="btcPnl">$0.00</div>
        <div class="card-sub" id="btcRecord">0W / 0L / 0F</div>
        <div class="progress-bar"><div class="progress-fill fill-cyan" id="btcWinBar" style="width:0%"></div></div>
      </div>
      <div class="card">
        <div class="card-title">Bankroll</div>
        <div class="card-value" id="btcBankroll">$20.00</div>
        <div class="card-sub" id="btcRoundsSub">0 rounds completed</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 12px;">
      <div class="card-title">BTC Stats</div>
      <div class="stat-row"><span class="stat-label">Session Loss</span><span class="stat-value pnl-neg" id="btcSessionLoss">$0.00</span></div>
      <div class="stat-row"><span class="stat-label">Win Rate</span><span class="stat-value" id="btcWinRate">0%</span></div>
      <div class="stat-row"><span class="stat-label">Best Round</span><span class="stat-value pnl-pos" id="btcBestRound">--</span></div>
      <div class="stat-row"><span class="stat-label">Worst Round</span><span class="stat-value pnl-neg" id="btcWorstRound">--</span></div>
      <div class="stat-row"><span class="stat-label">Avg PnL / Round</span><span class="stat-value" id="btcAvgPnlStat">--</span></div>
    </div>

    <!-- Completed Rounds -->
    <div class="table-wrap">
      <div style="padding:8px 12px;background:var(--bg3);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--dim);">
        Completed Rounds
      </div>
      <div class="scrollable">
        <table>
          <thead><tr><th>Market</th><th>Result</th><th>P&L</th><th>Orders</th><th>Open</th><th>Close</th></tr></thead>
          <tbody id="btcRoundsTable"></tbody>
        </table>
      </div>
    </div>

    <!-- Completed Weather Trades -->
    <div class="table-wrap">
      <div style="padding:8px 12px;background:var(--bg3);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--dim);">
        Completed Weather Trades
      </div>
      <div class="scrollable">
        <table>
          <thead><tr><th>City</th><th>Date</th><th>Bracket</th><th>Result</th><th>P&L</th><th>Edge</th></tr></thead>
          <tbody id="wxCompletedTable"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<div class="footer">
  Satriales Dual Engine &mdash; Paper Trading &mdash; Auto-refreshes every 2s
</div>

<script>
function pnlClass(v) { return v > 0.001 ? 'pnl-pos' : v < -0.001 ? 'pnl-neg' : 'pnl-zero'; }
function pnlStr(v) { return (v >= 0 ? '+' : '') + '$' + v.toFixed(2); }
function pctStr(v) { return (v * 100).toFixed(1) + '%'; }
function edgeClass(e) { return e >= 0.15 ? 'edge-high' : e >= 0.08 ? 'edge-med' : 'edge-low'; }
function shortSlug(s) {
  if (!s) return '--';
  // BTC slugs: "btc-updown-5m-1776507900" → readable time
  if (s.startsWith('btc-updown-5m-')) {
    const ts = parseInt(s.replace('btc-updown-5m-','')) * 1000;
    if (!isNaN(ts)) return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }
  // Weather slugs
  return s.replace('highest-temperature-in-','').replace('lowest-temperature-in-','').replace(/-on-/,' ').replace(/-/g,' ');
}

function update(data) {
  const wx = data.weather;
  const btc = data.btc;
  const c = data.combined;

  // Combined
  const el = (id) => document.getElementById(id);
  el('combinedPnl').textContent = pnlStr(c.totalPnl);
  el('combinedPnl').className = 'card-value ' + pnlClass(c.totalPnl);
  el('combinedSub').textContent = c.totalTrades + ' total trades';
  el('combinedWinRate').textContent = c.totalTrades > 0 ? (c.winRate * 100).toFixed(0) + '%' : '--';
  el('combinedRecord').textContent = (wx.wins + btc.wins) + 'W / ' + (wx.losses + btc.losses) + 'L';
  el('totalBankroll').textContent = '$' + c.totalBankroll.toFixed(2);
  el('totalBankroll').className = 'card-value ' + pnlClass(c.totalBankroll - 40);
  el('bankrollBreakdown').textContent = 'WX $' + wx.bankroll.toFixed(2) + ' + BTC $' + btc.bankroll.toFixed(2);

  // Weather
  el('wxPnl').textContent = pnlStr(wx.totalPnl);
  el('wxPnl').className = 'card-value ' + pnlClass(wx.totalPnl);
  el('wxRecord').textContent = wx.wins + 'W / ' + wx.losses + 'L';
  el('wxBankroll').textContent = '$' + wx.bankroll.toFixed(2);
  el('wxPending').textContent = wx.pending.length + ' pending trades';
  el('wxTotalTrades').textContent = wx.totalTrades;
  const wxWR = wx.totalTrades > 0 ? (wx.wins / wx.totalTrades * 100).toFixed(0) + '%' : '--';
  el('wxWinRate').textContent = wxWR;
  el('wxWinBar').style.width = wx.totalTrades > 0 ? (wx.wins / wx.totalTrades * 100) + '%' : '0%';

  // Weather avg edge
  const allWxTrades = [...wx.pending, ...wx.completed];
  if (allWxTrades.length > 0) {
    const avgEdge = allWxTrades.reduce((s,t) => s + (t.edge||0), 0) / allWxTrades.length;
    el('wxAvgEdge').textContent = (avgEdge * 100).toFixed(1) + '%';
  }
  if (wx.completed.length > 0) {
    const pnls = wx.completed.map(t => t.pnl || 0);
    el('wxBestTrade').textContent = pnlStr(Math.max(...pnls));
    el('wxWorstTrade').textContent = pnlStr(Math.min(...pnls));
  }

  // Weather pending table
  let pendingHTML = '';
  for (const t of wx.pending.slice(0, 20)) {
    pendingHTML += '<tr>' +
      '<td>' + (t.city||'') + '</td>' +
      '<td>' + (t.date||'') + '</td>' +
      '<td>' + (t.bracket||'') + '</td>' +
      '<td class="' + (t.action==='BUY_YES'?'action-yes':'action-no') + '">' + (t.action||'') + '</td>' +
      '<td class="' + edgeClass(t.edge||0) + '">' + ((t.edge||0)*100).toFixed(1) + '%</td>' +
      '<td>$' + (t.cost||0).toFixed(2) + '</td>' +
    '</tr>';
  }
  el('wxPendingTable').innerHTML = pendingHTML || '<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:16px">No pending trades</td></tr>';

  // Weather opportunities table
  let oppsHTML = '';
  for (const o of (wx.recentOpportunities || []).slice(0, 25)) {
    const edge = parseFloat(o.edge || '0');
    oppsHTML += '<tr>' +
      '<td>' + (o.city||'') + '</td>' +
      '<td>' + (o.date||'') + '</td>' +
      '<td>' + (o.bracket||'') + '</td>' +
      '<td>' + pctStr(parseFloat(o.forecast_prob||'0')) + '</td>' +
      '<td>' + pctStr(parseFloat(o.market_price||'0')) + '</td>' +
      '<td class="' + edgeClass(edge) + '">+' + (edge*100).toFixed(1) + '%</td>' +
    '</tr>';
  }
  el('wxOppsTable').innerHTML = oppsHTML || '<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:16px">No opportunities detected yet</td></tr>';

  // Weather completed table
  let wxCompHTML = '';
  for (const t of wx.completed.slice(-20).reverse()) {
    const outcome = t.outcome || '--';
    wxCompHTML += '<tr>' +
      '<td>' + (t.city||'') + '</td>' +
      '<td>' + (t.date||'') + '</td>' +
      '<td>' + (t.bracket||'') + '</td>' +
      '<td class="' + (outcome==='WIN'?'pnl-pos':'pnl-neg') + '">' + outcome + '</td>' +
      '<td class="' + pnlClass(t.pnl||0) + '">' + pnlStr(t.pnl||0) + '</td>' +
      '<td class="' + edgeClass(t.edge||0) + '">' + ((t.edge||0)*100).toFixed(1) + '%</td>' +
    '</tr>';
  }
  el('wxCompletedTable').innerHTML = wxCompHTML || '<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:16px">No completed trades yet</td></tr>';

  // BTC
  el('btcPnl').textContent = pnlStr(btc.sessionPnl);
  el('btcPnl').className = 'card-value ' + pnlClass(btc.sessionPnl);
  el('btcRecord').textContent = btc.wins + 'W / ' + btc.losses + 'L / ' + btc.flats + 'F';
  el('btcBankroll').textContent = '$' + btc.bankroll.toFixed(2);
  el('btcBankroll').className = 'card-value ' + pnlClass(btc.bankroll - 20);
  el('btcRoundsSub').textContent = btc.roundsCompleted + ' rounds completed';
  el('btcSessionLoss').textContent = pnlStr(btc.sessionLoss);
  const btcWR = btc.roundsCompleted > 0 ? ((btc.wins / btc.roundsCompleted) * 100).toFixed(0) + '%' : '--';
  el('btcWinRate').textContent = btcWR;
  el('btcWinBar').style.width = btc.roundsCompleted > 0 ? (btc.wins / btc.roundsCompleted * 100) + '%' : '0%';

  if (btc.completedRounds.length > 0) {
    const pnls = btc.completedRounds.map(r => r.pnl);
    el('btcBestRound').textContent = pnlStr(Math.max(...pnls));
    el('btcWorstRound').textContent = pnlStr(Math.min(...pnls));
    el('btcAvgPnlStat').textContent = pnlStr(btc.avgPnl);
    el('btcAvgPnlStat').className = 'stat-value ' + pnlClass(btc.avgPnl);
  }

  // BTC rounds table
  let btcHTML = '';
  for (const r of btc.completedRounds.slice(-20).reverse()) {
    btcHTML += '<tr>' +
      '<td>' + shortSlug(r.slug) + '</td>' +
      '<td>' + (r.resolution || '--') + '</td>' +
      '<td class="' + pnlClass(r.pnl) + '">' + pnlStr(r.pnl) + '</td>' +
      '<td>' + (r.orderCount || 0) + '</td>' +
      '<td>' + (r.openPrice ? '$' + r.openPrice.toFixed(0) : '--') + '</td>' +
      '<td>' + (r.closePrice ? '$' + r.closePrice.toFixed(0) : '--') + '</td>' +
    '</tr>';
  }
  el('btcRoundsTable').innerHTML = btcHTML || '<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:16px">No completed rounds yet</td></tr>';

  // Status
  el('statusDot').style.background = 'var(--green)';
  el('statusText').textContent = 'Live';
  el('lastUpdate').textContent = new Date().toLocaleTimeString();
}

// Poll every 2 seconds
async function poll() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    update(data);
  } catch (e) {
    document.getElementById('statusDot').style.background = 'var(--red)';
    document.getElementById('statusText').textContent = 'Disconnected';
  }
}

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
}

// ─── HTTP Server ────────────────────────────────────────────────────

export function startDashboard(port: number = parseInt(process.env.PORT || "3000")): void {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/state") {
        return new Response(JSON.stringify(getState()), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      if (url.pathname === "/api/stream") {
        // SSE stream
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const send = () => {
              try {
                const data = JSON.stringify(getState());
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              } catch {}
            };
            send();
            const interval = setInterval(send, 2000);
            req.signal.addEventListener("abort", () => clearInterval(interval));
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // Serve dashboard HTML
      return new Response(getDashboardHTML(), {
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  console.log(`\n  Dashboard: http://localhost:${port}\n`);
}
