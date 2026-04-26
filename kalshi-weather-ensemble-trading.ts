#!/usr/bin/env bun
/**
 * Kalshi Weather ENSEMBLE FORECAST live trading runner.
 *
 * Uses 82-member GFS+ECMWF ensemble to pick winning brackets at T-24h window,
 * entering while prices are still uncertain. Runs as a SEPARATE instance
 * from the intrinsic-winner bot — isolated state, logs, trades, daily tracker.
 *
 * REQUIRED env:
 *   KALSHI_API_KEY_ID
 *   KALSHI_PRIVATE_KEY_PATH  (or KALSHI_PRIVATE_KEY_PEM)
 *   KALSHI_CONFIRM_FIRST_ORDER=yes   (required for first live order of the day)
 *
 * Usage:
 *   bun kalshi-weather-ensemble-trading.ts --demo                     (fake money)
 *   bun kalshi-weather-ensemble-trading.ts --i-understand             (REAL $, prod)
 *
 * Safety:
 *   - --i-understand required for production
 *   - Kill switch: touch state/HALT_TRADING_ENSEMBLE  (stops all ensemble orders)
 *   - Hard caps enforced: max deployed, max per order, daily loss limit
 *   - Isolated state — does NOT conflict with intrinsic bot
 */

import { WeatherSimulator } from "./src/weather/WeatherSimulator";
import { findKalshiWeatherMarkets } from "./src/kalshi/KalshiWeatherFinder";
import { KalshiClient } from "./src/kalshi/KalshiClient";
import { loadCredentialsFromEnv } from "./src/kalshi/KalshiAuth";
import { KalshiExecutor } from "./src/kalshi/KalshiExecutor";
import { acquireBotLock } from "./src/util/BotLock";

const args = process.argv.slice(2);
function argVal(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  return idx >= 0 ? parseFloat(args[idx + 1]) : fallback;
}
const hasFlag = (f: string) => args.includes(f);

const USE_DEMO = hasFlag("--demo");
const I_UNDERSTAND = hasFlag("--i-understand");
const FRESH = hasFlag("--fresh");

// Tight defaults for ensemble strategy on $100 bankroll. Tuned 2026-04-26
// based on first 16 closed trades:
//   maxPrice 0.30 (was 0.50): mid-price entries lost reliably (0/6 above 0.30)
//   minPrice 0.07 (new):      sub-7¢ "lottery tickets" hit 0/4, drag on returns
//   highConfMult 1.5 (new):   30%+ edge had 50% WR / +390% ROI vs 25% baseline
const MAX_DEPLOYED_USD = argVal("--max-deployed", 100);
const MAX_PER_ORDER_USD = argVal("--max-per-order", 15);
const DAILY_LOSS_CAP_USD = -Math.abs(argVal("--daily-loss", 30));
const BET_SIZE = argVal("--bet-size", 10);
const MIN_PROB = argVal("--min-prob", 0.40);
const MAX_PRICE = argVal("--max-price", 0.30);
const MIN_PRICE = argVal("--min-price", 0.07);
const HIGH_CONF_MULT = argVal("--high-conf-mult", 1.5);
const HIGH_CONF_EDGE = argVal("--high-conf-edge", 0.30);
const ENTRY_HOURS = argVal("--entry-hours", 24);
const WINDOW_HOURS = argVal("--window-hours", 12);
const SCAN_INTERVAL_MIN = argVal("--scan-interval", 5);

// ─── Isolated state for this instance ────────────────────────────────
const STATE_PATH = "state/weather-ensemble-sim.json";
const TRADES_CSV = "results/weather-ensemble-trades.csv";
const KILL_SWITCH = "state/HALT_TRADING_ENSEMBLE";
const DAILY_TRACKER = "state/kalshi-ensemble-daily-tracker.json";

// ─── Colors ─────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

function logLine(msg: string, color?: string) {
  const ts = new Date().toLocaleTimeString();
  const prefix = `  ${c.dim}${ts}${c.reset}`;
  const colorCode = color ? (c as any)[color] ?? "" : "";
  const resetCode = color ? c.reset : "";
  console.log(`${prefix} ${colorCode}${msg}${resetCode}`);
}

// ─── Safety gate ────────────────────────────────────────────────────

function assertProductionConfirmation() {
  if (USE_DEMO) return;
  if (!I_UNDERSTAND) {
    console.error(`
${c.red}${c.bold}  ⚠ ENSEMBLE BOT — PRODUCTION MODE REFUSED${c.reset}

  This runs REAL orders against production Kalshi using the ENSEMBLE
  FORECAST strategy. Backtest: 33% accuracy, +68% ROI on 17-bet sample.
  Statistical confidence is moderate — results may differ significantly.

  To proceed, add ${c.yellow}--i-understand${c.reset} and acknowledge:

  1. Strategy validation is EARLIER than the intrinsic bot (~17 bets vs real tape)
  2. Hard caps:
       max deployed:  $${MAX_DEPLOYED_USD.toFixed(2)}
       max per order: $${MAX_PER_ORDER_USD.toFixed(2)}
       daily loss:    -$${Math.abs(DAILY_LOSS_CAP_USD).toFixed(2)}
  3. Running alongside the existing intrinsic bot — both pull from the SAME
     Kalshi balance. Combined max exposure: $20 (intrinsic) + $100 (this) = $120
  4. Kill switch: ${c.cyan}touch state/HALT_TRADING_ENSEMBLE${c.reset}
  5. First order each day requires KALSHI_CONFIRM_FIRST_ORDER=yes

  Recommended: test with ${c.yellow}--demo${c.reset} first if possible.
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
${c.magenta}${c.bold}  ╔═══════════════════════════════════════════╗
  ║   SATRIALES WEATHER — ENSEMBLE FORECAST   ║
  ║   (82-member GFS+ECMWF at T-24h entry)    ║
  ╚═══════════════════════════════════════════╝${c.reset}

  ${c.dim}Environment:${c.reset}       ${envLabel}
  ${c.dim}Strategy:${c.reset}          ${c.bold}ENSEMBLE FORECAST${c.reset} (bet cheapest highest-prob bracket)
  ${c.dim}Max deployed:${c.reset}      ${c.bold}$${MAX_DEPLOYED_USD.toFixed(2)}${c.reset}
  ${c.dim}Max per order:${c.reset}     ${c.bold}$${MAX_PER_ORDER_USD.toFixed(2)}${c.reset}
  ${c.dim}Daily loss cap:${c.reset}    ${c.bold}-$${Math.abs(DAILY_LOSS_CAP_USD).toFixed(2)}${c.reset}
  ${c.dim}Bet size (base):${c.reset}   $${BET_SIZE.toFixed(2)}
  ${c.dim}High-conf size:${c.reset}    $${(BET_SIZE * HIGH_CONF_MULT).toFixed(2)} ${c.dim}(${HIGH_CONF_MULT.toFixed(1)}× when edge ≥ ${(HIGH_CONF_EDGE*100).toFixed(0)}%)${c.reset}
  ${c.dim}Min ensemble prob:${c.reset} ${(MIN_PROB * 100).toFixed(0)}%
  ${c.dim}Entry price band:${c.reset}  $${MIN_PRICE.toFixed(2)} – $${MAX_PRICE.toFixed(2)}
  ${c.dim}Entry window:${c.reset}      ${ENTRY_HOURS}h ± ${WINDOW_HOURS}h before close
  ${c.dim}Scan interval:${c.reset}     ${SCAN_INTERVAL_MIN} min
  ${c.dim}State file:${c.reset}        ${STATE_PATH}
  ${c.dim}Trades CSV:${c.reset}        ${TRADES_CSV}
  ${c.dim}Kill switch:${c.reset}       touch ${KILL_SWITCH}
`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  assertProductionConfirmation();

  // Lock — prevents multiple instances (this was the bug that caused duplicate orders)
  try {
    acquireBotLock("kalshi-ensemble");
  } catch (err: any) {
    console.error(`${c.red}${err?.message}${c.reset}`);
    process.exit(1);
  }

  const creds = loadCredentialsFromEnv();
  if (!creds) {
    console.error(`${c.red}  ✗ Missing KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PATH${c.reset}`);
    process.exit(1);
  }

  printBanner();

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

  logLine("Fetching Kalshi portfolio snapshot...", "cyan");
  try {
    const snap = await executor.fetchPortfolioSnapshot();
    logLine(`Kalshi balance: $${snap.cashUSD.toFixed(2)} cash, $${snap.portfolioValueUSD.toFixed(2)} portfolio`, "green");
    logLine(`Currently deployed: $${snap.totalDeployedUSD.toFixed(2)} across ${snap.openPositionCount} positions`, "dim");
  } catch (err: any) {
    logLine(`Failed to fetch portfolio: ${err?.message}`, "red");
    process.exit(1);
  }

  if (FRESH) WeatherSimulator.clearSavedState(STATE_PATH);

  const kalshiFinder = (opts?: { city?: string; daysAhead?: number }) =>
    findKalshiWeatherMarkets({ ...opts, demo: USE_DEMO });

  const sim = new WeatherSimulator({
    startingBalance: MAX_DEPLOYED_USD,
    minEdge: 0.10,
    ladderBudget: 15,
    maxLadderLegs: 6,
    maxTotalPositions: Math.ceil(MAX_DEPLOYED_USD / MAX_PER_ORDER_USD),
    scanIntervalMs: SCAN_INTERVAL_MIN * 60 * 1000,
    daysAhead: 3,
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
    strategy: "ensemble_forecast",
    ensembleHoursBefore: ENTRY_HOURS,
    ensembleWindowHours: WINDOW_HOURS,
    ensembleMinProb: MIN_PROB,
    ensembleMaxPrice: MAX_PRICE,
    ensembleMinPrice: MIN_PRICE,
    ensembleBetSize: BET_SIZE,
    ensembleHighConfMult: HIGH_CONF_MULT,
    ensembleHighConfEdge: HIGH_CONF_EDGE,
    snipeEnabled: false,
    snipeMaxPrice: 0.92, snipeBudget: 5, snipeMinConfidence: "likely_final",
    // Isolated paths
    stateFilePath: STATE_PATH,
    tradesCsvPath: TRADES_CSV,
    instanceName: "ensemble",
  }, !FRESH);

  sim.executor = executor;
  sim.onLog = logLine;

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${c.yellow}  Shutting down ensemble bot...${c.reset}`);
    executor.logDailyStatus();
    sim.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await sim.start();
}

main().catch((err) => {
  console.error(`${c.red}Fatal:${c.reset}`, err?.message ?? err);
  process.exit(1);
});
