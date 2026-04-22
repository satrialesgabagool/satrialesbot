#!/usr/bin/env bun
/**
 * Satriales Weather Trading Simulator — Kalshi Edition
 *
 * Same ladder strategy as the Polymarket version, but pulls markets
 * from Kalshi's KXHIGH (daily high temperature) series.
 *
 * Kalshi differences:
 *   - ~6 brackets per event (vs Polymarket's ~11)
 *   - US cities only (NYC, Chicago, Miami, LA, Austin, Denver, etc.)
 *   - Resolution via NWS Daily Climate Report
 *   - CFTC-regulated, USD-denominated
 *
 * Usage:
 *   bun run kalshi-weather-live.ts --instant              # quick test
 *   bun run kalshi-weather-live.ts --balance 500          # sim mode
 *   bun run kalshi-weather-live.ts --min-edge 0.15 --ladder-budget 15
 */

import { WeatherSimulator, type WeatherPosition } from "./src/weather/WeatherSimulator";
import { findKalshiWeatherMarkets } from "./src/kalshi/KalshiWeatherFinder";

// ─── Parse CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);

function argVal(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  return idx >= 0 ? parseFloat(args[idx + 1]) : fallback;
}

const BALANCE = argVal("--balance", 500);
const MIN_EDGE = argVal("--min-edge", 0.15);
const LADDER_BUDGET = argVal("--ladder-budget", 15);
const MAX_LEGS = argVal("--max-legs", 6);
const SCAN_INTERVAL_MIN = argVal("--scan-interval", 5);
const DAYS_AHEAD = argVal("--days-ahead", 3);
const MAX_SPREAD = argVal("--max-spread", 4.0);
const INSTANT_RESOLVE = args.includes("--instant");
const FRESH_START = args.includes("--fresh");
const RESUME = !FRESH_START;

// ─── ANSI helpers ────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  blue: "\x1b[34m",
};

function colorPnl(pnl: number): string {
  if (pnl > 0) return `${c.green}+$${pnl.toFixed(2)}${c.reset}`;
  if (pnl < 0) return `${c.red}-$${Math.abs(pnl).toFixed(2)}${c.reset}`;
  return `${c.dim}$0.00${c.reset}`;
}

function colorEdge(edge: number): string {
  const pct = (edge * 100).toFixed(1);
  if (edge >= 0.30) return `${c.green}+${pct}%${c.reset}`;
  if (edge >= 0.15) return `${c.yellow}+${pct}%${c.reset}`;
  return `${c.dim}+${pct}%${c.reset}`;
}

function colorBalance(bal: number, start: number): string {
  const pct = ((bal / start) * 100).toFixed(0);
  const color = bal > start ? c.green : bal < start * 0.5 ? c.red : bal < start * 0.8 ? c.yellow : c.white;
  return `${color}$${bal.toFixed(2)} (${pct}%)${c.reset}`;
}

function pad(s: string, len: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, len - visible.length));
}

function logLine(msg: string, color?: string) {
  const ts = new Date().toLocaleTimeString();
  const prefix = `  ${c.dim}${ts}${c.reset}`;
  const colorCode = color ? (c as any)[color] ?? "" : "";
  const resetCode = color ? c.reset : "";
  console.log(`${prefix} ${colorCode}${msg}${resetCode}`);
}

// ─── Banner ──────────────────────────────────────────────────────────
function printBanner() {
  console.log(`
${c.blue}${c.bold}  ╔═══════════════════════════════════════════╗
  ║   SATRIALES WEATHER TRADING — KALSHI      ║
  ║      Ladder Strategy + Multi-Model        ║
  ╚═══════════════════════════════════════════╝${c.reset}

  ${c.dim}Exchange:${c.reset}          ${c.blue}${c.bold}Kalshi${c.reset} (KXHIGH series)
  ${c.dim}Starting balance:${c.reset}  ${c.bold}$${BALANCE.toFixed(2)}${c.reset}
  ${c.dim}Min edge:${c.reset}          ${(MIN_EDGE * 100).toFixed(0)}%
  ${c.dim}Ladder budget:${c.reset}     $${LADDER_BUDGET.toFixed(2)} per market (up to ${MAX_LEGS} legs)
  ${c.dim}Scan interval:${c.reset}     ${SCAN_INTERVAL_MIN} min
  ${c.dim}Days ahead:${c.reset}        ${DAYS_AHEAD}
  ${c.dim}Models:${c.reset}            Open-Meteo + ECMWF + GFS + NOAA
  ${c.dim}Max model spread:${c.reset}  ±${MAX_SPREAD.toFixed(0)}°F
  ${c.dim}Sizing:${c.reset}            Edge-weighted, 2x bonus on brackets ≤$0.10
  ${c.dim}Resolution:${c.reset}        ${INSTANT_RESOLVE ? "Instant (needs past dates)" : "NWS Daily Climate Report (sim: Open-Meteo archive)"}
  ${c.dim}State:${c.reset}             ${FRESH_START ? "Fresh start" : WeatherSimulator.hasSavedState() ? "Resuming from saved state" : "New session"}
  ${c.dim}State file:${c.reset}        state/weather-sim.json
  ${c.dim}Results CSV:${c.reset}       results/weather-trades.csv
  ${c.dim}Press Ctrl+C to stop${c.reset}
`);
}

// ─── Dashboard ───────────────────────────────────────────────────────
function printDashboard(sim: WeatherSimulator) {
  const s = sim.snapshot;
  const now = new Date().toLocaleTimeString();
  const divider = "─".repeat(100);

  console.log(`\n${c.dim}${divider}${c.reset}`);
  console.log(`${c.bold}  KALSHI DASHBOARD${c.reset}  ${c.dim}${now}${c.reset}  ${c.dim}Scan #${s.scansCompleted}${c.reset}\n`);

  // Open positions grouped by ladder
  if (s.positions.length > 0) {
    console.log(`  ${c.bold}OPEN LADDERS${c.reset} (${s.positions.length} legs)\n`);

    const ladders = new Map<string, typeof s.positions>();
    for (const pos of s.positions) {
      const key = pos.ladderGroup ?? pos.id;
      if (!ladders.has(key)) ladders.set(key, []);
      ladders.get(key)!.push(pos);
    }

    for (const [group, legs] of ladders) {
      const m = legs[0].market;
      const totalCost = legs.reduce((s, l) => s + l.cost, 0);
      const hrs = Math.max(0, (new Date(m.endDate).getTime() - Date.now()) / 3600000);
      const spreadInfo = legs[0].modelSpreadF > 0 ? ` spread=±${legs[0].modelSpreadF.toFixed(1)}°F` : "";

      console.log(
        `  ${c.bold}${m.city}${c.reset} ${m.date} (${m.type}) — ` +
        `forecast=${legs[0].forecastTempF.toFixed(0)}°F${spreadInfo} ` +
        `${c.dim}${legs.length} legs, $${totalCost.toFixed(2)} deployed, ${hrs.toFixed(0)}h to res${c.reset}`
      );

      for (const pos of legs) {
        const label = sim.bracketLabel(pos.bracket);
        const payoff = (pos.shares * 1.0 / pos.cost).toFixed(0);
        console.log(
          `    ${pad(label, 14)} ${pad(pos.shares + "sh", 8)} ` +
          `@ $${pos.entryPrice.toFixed(2)} ($${pos.cost.toFixed(2)}) ` +
          `prob=${(pos.forecastProb * 100).toFixed(0)}% ` +
          `${colorEdge(pos.edge)}  ${payoff}:1`
        );
      }
      console.log("");
    }
  }

  // Recent results
  if (s.closedPositions.length > 0) {
    const closedLadders = new Map<string, typeof s.closedPositions>();
    for (const pos of s.closedPositions) {
      const key = pos.ladderGroup ?? pos.id;
      if (!closedLadders.has(key)) closedLadders.set(key, []);
      closedLadders.get(key)!.push(pos);
    }

    const ladderEntries = [...closedLadders.entries()].slice(-5);
    console.log(`  ${c.bold}RECENT LADDERS${c.reset} (last ${ladderEntries.length} of ${closedLadders.size})\n`);

    for (const [_, legs] of ladderEntries) {
      const m = legs[0].market;
      const ladderPnl = legs.reduce((s, l) => s + l.pnl, 0);
      const ladderCost = legs.reduce((s, l) => s + l.cost, 0);
      const hits = legs.filter(l => l.status === "won").length;
      const pnlColor = ladderPnl >= 0 ? c.green : c.red;

      console.log(
        `  ${c.bold}${m.city}${c.reset} ${m.date} (${m.type}) → ` +
        `actual=${legs[0].resolvedTempF ?? "?"}°F  ` +
        `${hits}/${legs.length} hit  ` +
        `${pnlColor}${ladderPnl >= 0 ? "+" : ""}$${ladderPnl.toFixed(2)}${c.reset} ` +
        `${c.dim}(cost $${ladderCost.toFixed(2)})${c.reset}`
      );

      for (const pos of legs) {
        const label = sim.bracketLabel(pos.bracket);
        const resultIcon = pos.status === "won" ? `${c.green}HIT${c.reset}` : `${c.red}   ${c.reset}`;
        console.log(
          `    ${resultIcon} ${pad(label, 14)} @ $${pos.entryPrice.toFixed(2)}  ${colorPnl(pos.pnl)}`
        );
      }
      console.log("");
    }
  }

  // Summary
  const totalCapital = BALANCE;
  const currentBalance = s.balance + s.deployed;
  const wr = s.wins + s.losses > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(0) : "—";

  const closedLadders = new Map<string, typeof s.closedPositions>();
  for (const pos of s.closedPositions) {
    const key = pos.ladderGroup ?? pos.id;
    if (!closedLadders.has(key)) closedLadders.set(key, []);
    closedLadders.get(key)!.push(pos);
  }
  const ladderWins = [...closedLadders.values()].filter(
    legs => legs.reduce((s, l) => s + l.pnl, 0) > 0
  ).length;
  const ladderTotal = closedLadders.size;
  const ladderWr = ladderTotal > 0 ? ((ladderWins / ladderTotal) * 100).toFixed(0) : "—";

  console.log(`  ${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log(`  ${pad("Exchange:", 22)} ${c.blue}${c.bold}Kalshi${c.reset}`);
  console.log(`  ${pad("Balance:", 22)} ${colorBalance(currentBalance, totalCapital)}`);
  console.log(`  ${pad("Available:", 22)} ${c.white}$${s.balance.toFixed(2)}${c.reset}`);
  console.log(`  ${pad("Deployed:", 22)} ${c.white}$${Math.abs(s.deployed).toFixed(2)}${c.reset} (${s.positions.length} legs)`);
  console.log(`  ${pad("Total P&L:", 22)} ${colorPnl(s.totalPnl)}`);
  console.log(`  ${pad("Leg W/L:", 22)} ${c.white}${s.wins}W-${s.losses}L${c.reset} (${wr}% per leg)`);
  console.log(`  ${pad("Ladder W/L:", 22)} ${c.white}${ladderWins}W-${ladderTotal - ladderWins}L${c.reset} (${ladderWr}% per ladder)`);
  console.log(`${c.dim}${divider}${c.reset}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  if (FRESH_START) {
    WeatherSimulator.clearSavedState();
  }

  // Wire up the Kalshi market finder
  const kalshiFinder = (opts?: { city?: string; daysAhead?: number }) =>
    findKalshiWeatherMarkets({ ...opts, demo: false });

  const sim = new WeatherSimulator({
    startingBalance: BALANCE,
    minEdge: MIN_EDGE,
    ladderBudget: LADDER_BUDGET,
    maxLadderLegs: MAX_LEGS,
    maxTotalPositions: 50,
    scanIntervalMs: SCAN_INTERVAL_MIN * 60 * 1000,
    daysAhead: DAYS_AHEAD,
    resolveWithNoise: true,
    cheapBracketBonus: true,
    maxModelSpreadF: MAX_SPREAD,
    marketFinder: kalshiFinder,
    exchange: "kalshi",
  }, RESUME);

  sim.onLog = logLine;
  sim.onPositionOpened = () => {};
  sim.onPositionClosed = () => {};

  sim.onScanComplete = (opps) => {
    const s = sim.snapshot;
    if (opps > 0) {
      logLine(`Scan complete: ${opps} legs across ladders (${s.positions.length} total open)`, "cyan");
    } else {
      logLine(`Scan complete: no new opportunities (${s.positions.length} open legs)`, "dim");
    }
  };

  sim.onDashboardUpdate = () => {
    printDashboard(sim);
  };

  // Graceful shutdown
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${c.yellow}  Shutting down...${c.reset}\n`);
    sim.stop();
    printDashboard(sim);
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start simulator
  await sim.start();

  // Instant resolve mode
  if (INSTANT_RESOLVE) {
    const s = sim.snapshot;
    if (s.positions.length > 0) {
      console.log(`\n${c.yellow}  --instant mode: force-resolving ${s.positions.length} positions...${c.reset}\n`);
      await sim.forceResolveAll();
      printDashboard(sim);
    } else {
      console.log(`\n${c.yellow}  --instant mode: no positions to resolve${c.reset}\n`);
    }
    process.exit(0);
  }

  // Periodic dashboard refresh
  setInterval(() => {
    if (!shuttingDown && sim.snapshot.positions.length > 0) {
      printDashboard(sim);
    }
  }, 2 * 60 * 1000);

  // Heartbeat
  let lastOutput = Date.now();
  const origLog = console.log;
  console.log = (...a: any[]) => { lastOutput = Date.now(); origLog(...a); };

  setInterval(() => {
    if (Date.now() - lastOutput > 55_000) {
      const s = sim.snapshot;
      origLog(`  ${c.dim}[${new Date().toLocaleTimeString()}] ${s.positions.length} open legs, next scan in ${Math.ceil(SCAN_INTERVAL_MIN - ((Date.now() % (SCAN_INTERVAL_MIN * 60000)) / 60000))} min...${c.reset}`);
      lastOutput = Date.now();
    }
  }, 60_000);
}

main().catch(err => {
  console.error(`FATAL: ${err}`);
  process.exit(1);
});
