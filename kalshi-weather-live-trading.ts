#!/usr/bin/env bun
/**
 * Kalshi Weather LIVE Trading Runner
 *
 * This runs the bot in LIVE mode — places REAL orders via Kalshi's API.
 * Use Kalshi's demo environment (`--demo`) first to validate order mechanics
 * before ever touching production money.
 *
 * Required env vars (set before running):
 *   KALSHI_API_KEY_ID            — your API key UUID
 *   KALSHI_PRIVATE_KEY_PATH      — path to RSA private key PEM
 *     OR
 *   KALSHI_PRIVATE_KEY_PEM       — PEM contents inline
 *
 * Optional:
 *   KALSHI_CONFIRM_FIRST_ORDER=yes   — required on first order each day
 *
 * Usage:
 *   bun run kalshi-weather-live-trading.ts --demo                    (FAKE MONEY, demo env)
 *   bun run kalshi-weather-live-trading.ts --demo --max-deployed 20  (demo with $20 cap)
 *   bun run kalshi-weather-live-trading.ts                           (PRODUCTION — requires --i-understand)
 *
 * Safety:
 *   - `--demo` uses Kalshi's fake-money demo environment
 *   - Production requires `--i-understand` flag AND KALSHI_CONFIRM_FIRST_ORDER=yes
 *   - Hard caps enforced: max deployed, max per-order, daily loss limit
 *   - Kill switch: `touch state/HALT_TRADING` to stop all orders instantly
 */

import { WeatherSimulator } from "./src/weather/WeatherSimulator";
import { findKalshiWeatherMarkets } from "./src/kalshi/KalshiWeatherFinder";
import { KalshiClient } from "./src/kalshi/KalshiClient";
import { loadCredentialsFromEnv } from "./src/kalshi/KalshiAuth";
import { KalshiExecutor } from "./src/kalshi/KalshiExecutor";
import { acquireBotLock } from "./src/util/BotLock";

// Isolated state paths so this bot doesn't collide with the paper bot
const STATE_PATH = "state/weather-intrinsic-sim.json";
const TRADES_CSV = "results/weather-intrinsic-trades.csv";
const KILL_SWITCH = "state/HALT_TRADING";
const DAILY_TRACKER = "state/kalshi-intrinsic-daily-tracker.json";

const args = process.argv.slice(2);
function argVal(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  return idx >= 0 ? parseFloat(args[idx + 1]) : fallback;
}
function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const USE_DEMO = hasFlag("--demo");
const I_UNDERSTAND = hasFlag("--i-understand");
const FRESH = hasFlag("--fresh");

// Tight defaults for first live runs
const MAX_DEPLOYED_USD = argVal("--max-deployed", 20);
const MAX_PER_ORDER_USD = argVal("--max-per-order", 3);
const DAILY_LOSS_CAP_USD = -Math.abs(argVal("--daily-loss", 10));  // always negative
const MIN_EDGE = argVal("--min-edge", 0.10);
const LADDER_BUDGET = argVal("--ladder-budget", 3);
const MAX_LEGS = argVal("--max-legs", 2);
const SCAN_INTERVAL_MIN = argVal("--scan-interval", 5);

// ─── Color helpers ──────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function logLine(msg: string, color?: string) {
  const ts = new Date().toLocaleTimeString();
  const prefix = `  ${c.dim}${ts}${c.reset}`;
  const colorCode = color ? (c as any)[color] ?? "" : "";
  const resetCode = color ? c.reset : "";
  console.log(`${prefix} ${colorCode}${msg}${resetCode}`);
}

// ─── Safety gates ───────────────────────────────────────────────────

function assertProductionConfirmation() {
  if (USE_DEMO) return;
  if (!I_UNDERSTAND) {
    console.error(`
${c.red}${c.bold}  ⚠ PRODUCTION MODE REFUSED${c.reset}

  You're trying to run live trading against REAL money on production Kalshi.
  To proceed, add the flag ${c.yellow}--i-understand${c.reset} to confirm you've read:

  1. The bot will place REAL orders on Kalshi using your account
  2. Hard caps are set to:
       max deployed:  $${MAX_DEPLOYED_USD.toFixed(2)}
       max per order: $${MAX_PER_ORDER_USD.toFixed(2)}
       daily loss:    -$${Math.abs(DAILY_LOSS_CAP_USD).toFixed(2)}
  3. Every first order of the day requires KALSHI_CONFIRM_FIRST_ORDER=yes
  4. Kill switch:  ${c.cyan}touch state/HALT_TRADING${c.reset}  (stops all orders)

  Recommended: test with ${c.yellow}--demo${c.reset} first (fake money, Kalshi demo env).
`);
    process.exit(1);
  }
}

// ─── Banner ─────────────────────────────────────────────────────────

function printBanner() {
  const envLabel = USE_DEMO
    ? `${c.yellow}${c.bold}DEMO (fake money)${c.reset}`
    : `${c.red}${c.bold}PRODUCTION (real money)${c.reset}`;
  console.log(`
${c.blue}${c.bold}  ╔═══════════════════════════════════════════╗
  ║   SATRIALES WEATHER — LIVE TRADING        ║
  ║   (Kalshi KXHIGH, real orders enabled)    ║
  ╚═══════════════════════════════════════════╝${c.reset}

  ${c.dim}Environment:${c.reset}       ${envLabel}
  ${c.dim}Strategy:${c.reset}          ${c.bold}INTRINSIC WINNER${c.reset} (buy favorite at $0.70-$0.95, 4-12h to close)
  ${c.dim}Max deployed:${c.reset}      ${c.bold}$${MAX_DEPLOYED_USD.toFixed(2)}${c.reset}
  ${c.dim}Max per order:${c.reset}     ${c.bold}$${MAX_PER_ORDER_USD.toFixed(2)}${c.reset}
  ${c.dim}Daily loss cap:${c.reset}    ${c.bold}-$${Math.abs(DAILY_LOSS_CAP_USD).toFixed(2)}${c.reset}
  ${c.dim}Scan interval:${c.reset}     ${SCAN_INTERVAL_MIN} min
  ${c.dim}Kill switch:${c.reset}       touch state/HALT_TRADING to halt
  ${c.dim}First order:${c.reset}       Requires KALSHI_CONFIRM_FIRST_ORDER=yes
`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  assertProductionConfirmation();

  // Lock — prevents multiple instances from running at once
  try {
    acquireBotLock("kalshi-intrinsic");
  } catch (err: any) {
    console.error(`${c.red}${err?.message}${c.reset}`);
    process.exit(1);
  }

  // Load credentials (fails safely if missing)
  const creds = loadCredentialsFromEnv();
  if (!creds) {
    console.error(`${c.red}  ✗ Missing Kalshi credentials (KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PATH).${c.reset}`);
    process.exit(1);
  }

  printBanner();

  // Build authenticated client + executor
  const client = new KalshiClient({ demo: USE_DEMO, credentials: creds });
  const executor = new KalshiExecutor(
    client,
    {
      maxDeployedUSD: MAX_DEPLOYED_USD,
      maxPerOrderUSD: MAX_PER_ORDER_USD,
      dailyLossCapUSD: DAILY_LOSS_CAP_USD,
      killSwitchPath: KILL_SWITCH,
      confirmFirstOrder: !USE_DEMO,
      orderTimeoutMs: 30_000,
      useDemo: USE_DEMO,
      dailyTrackerPath: DAILY_TRACKER,
    },
    logLine,
  );

  // Initial portfolio snapshot
  logLine("Fetching initial Kalshi portfolio...", "cyan");
  try {
    const snap = await executor.fetchPortfolioSnapshot();
    logLine(`Kalshi balance: $${snap.cashUSD.toFixed(2)} cash, $${snap.portfolioValueUSD.toFixed(2)} portfolio`, "green");
    logLine(`Currently deployed: $${snap.totalDeployedUSD.toFixed(2)} across ${snap.openPositionCount} positions`, "dim");
  } catch (err: any) {
    logLine(`Failed to fetch Kalshi portfolio: ${err?.message}`, "red");
    process.exit(1);
  }

  // Wire the simulator to Kalshi live trading
  const kalshiFinder = (opts?: { city?: string; daysAhead?: number }) =>
    findKalshiWeatherMarkets({ ...opts, demo: USE_DEMO });

  const sim = new WeatherSimulator({
    startingBalance: MAX_DEPLOYED_USD,   // treat bankroll as the cap
    minEdge: MIN_EDGE,
    ladderBudget: LADDER_BUDGET,
    maxLadderLegs: MAX_LEGS,
    maxTotalPositions: Math.ceil(MAX_DEPLOYED_USD / MAX_PER_ORDER_USD),
    scanIntervalMs: SCAN_INTERVAL_MIN * 60 * 1000,
    daysAhead: 2,
    resolveWithNoise: true,
    cheapBracketBonus: false,
    maxModelSpreadF: 4.0,
    minBracketPrice: 0.03,
    minYesBid: 0,
    maxTailSigma: 0.8,
    maxEdge: 0.40,
    maxHoursToEntry: 36,
    marketFinder: kalshiFinder,
    exchange: "kalshi",
    mode: "live",

    // INTRINSIC-WINNER STRATEGY — validated by 14d tape backtest (94% WR, +5.6% ROI).
    // Live data revised the upper bound on 2026-04-26 after 12 closed trades
    // showed the $0.85-$0.92 zone lost -$36 across 6 trades (W/L ratio 0.07×).
    // At $0.90 entry the win pays ~$0.07 net but the loss costs $0.90, requiring
    // ~91% WR to break even versus ~58% achieved. Lowering ceiling to $0.85.
    strategy: "intrinsic",
    intrinsicHoursBefore: 8,
    intrinsicWindowHours: 4,
    intrinsicMinPrice: 0.70,
    intrinsicMaxPrice: 0.85,
    intrinsicMinGap: 0.05,
    intrinsicBetSize: MAX_PER_ORDER_USD,

    snipeEnabled: false,
    snipeMaxPrice: 0.92,
    snipeBudget: 5,
    snipeMinConfidence: "likely_final",
    // Isolated paths — don't conflict with paper bot or ensemble bot
    stateFilePath: STATE_PATH,
    tradesCsvPath: TRADES_CSV,
    instanceName: "intrinsic",
  }, !FRESH);

  sim.executor = executor;
  sim.onLog = logLine;

  // Shutdown handler
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${c.yellow}  Shutting down live trading...${c.reset}`);
    executor.logDailyStatus();
    sim.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Go
  await sim.start();
}

main().catch((err) => {
  console.error(`${c.red}Fatal:${c.reset}`, err?.message ?? err);
  process.exit(1);
});
