#!/usr/bin/env bun
/**
 * Paper Trading Simulator
 *
 * Watches the scanner signal file (JSONL) and simulates placing real trades
 * with a starting balance. Positions resolve after a delay, mimicking the
 * feel of live Kalshi weather trading without needing API access.
 *
 * How it works:
 *   1. Reads new signals from the same JSONL file the scanners write to
 *   2. For each weather signal: buys YES contracts at the market price
 *   3. Positions stay "open" for a configurable delay (simulates hours→seconds)
 *   4. On resolution: determines win/loss using the model probability + randomness
 *   5. Writes full portfolio state to state/weather-sim.json every update
 *   6. The dashboard's Simulator tab reads that file via SSE and renders it live
 *
 * Run: bun run src/dashboard/paper-trader.ts [--balance 500] [--size 5] [--speed 10]
 *
 *   --balance   Starting cash balance in dollars (default: 500)
 *   --size      Position size per trade in dollars (default: 5)
 *   --speed     Resolution speed in seconds, how long positions stay open (default: 15)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "fs";
import { join } from "path";

// ─── Config ────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function argVal(name: string, fallback: number): number {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return parseFloat(args[idx + 1]);
  return fallback;
}

const START_BALANCE = argVal("balance", 500);
const POSITION_SIZE = argVal("size", 5);
const RESOLVE_SECONDS = argVal("speed", 15); // how many seconds before a position resolves

// ─── Paths ─────────────────────────────────────────────────────────
const RESULTS_DIR = "results";
const JSONL_PATH = join(RESULTS_DIR, "high-conviction.jsonl");
const STATE_DIR = "state";
const STATE_PATH = join(STATE_DIR, "weather-sim.json");

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Types ─────────────────────────────────────────────────────────
interface Signal {
  timestamp: string;
  strategy: "weather" | "whale";
  eventTicker: string;
  marketTicker: string;
  side: string;
  yesPrice: number;
  conviction: number;
  edgeBps: number;
  reason: string;
  metadata?: {
    city?: string;
    type?: string;
    resolveDate?: string;
    hoursLeft?: number;
    notionalUsd?: number;
    zScore?: number;
    [key: string]: unknown;
  };
}

interface OpenPosition {
  id: number;
  city: string;
  date: string;
  type: string;
  bracket: string;
  lowF: number;
  highF: number;
  shares: number;
  entryPrice: number;
  cost: number;
  forecastProb: number;
  edge: number;
  hoursToResolution: number;
  placedAt: number;      // timestamp ms when trade was placed
  resolvesAt: number;    // timestamp ms when trade resolves
  marketTicker: string;
  strategy: string;
}

interface ClosedPosition {
  city: string;
  date: string;
  bracket: string;
  entry: number;
  won: boolean;
  actualTemp: number | null;
  pnl: number;
  closedAt: string;
}

interface SimState {
  balance: number;
  deployed: number;
  totalPnl: number;
  wins: number;
  losses: number;
  positions: OpenPosition[];
  closedPositions: ClosedPosition[];
  scans: number;
  savedAt: string;
  startBalance: number;
  positionSize: number;
}

// ─── State ─────────────────────────────────────────────────────────
let nextId = 1;
const state: SimState = {
  balance: START_BALANCE,
  deployed: 0,
  totalPnl: 0,
  wins: 0,
  losses: 0,
  positions: [],
  closedPositions: [],
  scans: 0,
  savedAt: new Date().toISOString(),
  startBalance: START_BALANCE,
  positionSize: POSITION_SIZE,
};

let processedLines = 0; // how many JSONL lines we've already handled

// ─── Helpers ───────────────────────────────────────────────────────

/** Parse a bracket string like "KXHIGHNY-26APR16-T65" into components */
function parseMarketTicker(ticker: string): {
  city: string;
  lowF: number;
  highF: number;
  bracket: string;
} {
  // Format: KXHIGH<CITY>-26APR<DD>-T<temp>
  const tempMatch = ticker.match(/T(\d+)$/);
  const lowF = tempMatch ? parseInt(tempMatch[1]) : 70;
  const highF = lowF + 2; // Kalshi brackets are typically 2°F wide

  // Extract city code from ticker
  const cityMatch = ticker.match(/KXHIGH([A-Z]+)-/);
  const cityCode = cityMatch ? cityMatch[1] : "???";

  const cityNames: Record<string, string> = {
    NY: "New York", CHI: "Chicago", MIA: "Miami",
    LAX: "Los Angeles", DEN: "Denver", AUS: "Austin",
    BOS: "Boston", DAL: "Dallas", SEA: "Seattle",
    ATL: "Atlanta",
  };

  return {
    city: cityNames[cityCode] || cityCode,
    lowF,
    highF,
    bracket: `${lowF}-${highF}°F`,
  };
}

/**
 * Determine if a trade wins.
 *
 * Uses the model probability (which is yesPrice/100 + edge) as the
 * "true" probability, then rolls the dice. Higher-edge trades are
 * more likely to win, but nothing is guaranteed — just like real trading.
 */
function rollOutcome(signal: Signal): { won: boolean; simulatedActual: number } {
  const marketProb = signal.yesPrice / 100;
  const edge = signal.edgeBps / 10000;
  // Our model thinks the true probability is market + edge
  const modelProb = Math.min(0.95, Math.max(0.05, marketProb + edge));

  const won = Math.random() < modelProb;

  // Simulate an "actual temperature" for display
  const parsed = parseMarketTicker(signal.marketTicker);
  const midBracket = (parsed.lowF + parsed.highF) / 2;
  if (won) {
    // Actual falls within the bracket
    return { won, simulatedActual: midBracket + (Math.random() - 0.5) };
  } else {
    // Actual falls outside the bracket
    const offset = 3 + Math.random() * 5;
    return { won, simulatedActual: midBracket + (Math.random() > 0.5 ? offset : -offset) };
  }
}

function saveState(): void {
  state.savedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Core Logic ────────────────────────────────────────────────────

function placeTrade(signal: Signal): void {
  // Skip if we can't afford it
  if (state.balance < POSITION_SIZE) {
    console.log(`  ⚠️  Insufficient balance ($${state.balance.toFixed(2)}) — skipping`);
    return;
  }

  const entryPrice = signal.yesPrice / 100; // e.g., 15 cents = 0.15
  const shares = Math.floor(POSITION_SIZE / entryPrice); // how many contracts we can buy
  if (shares <= 0) return;

  const cost = shares * entryPrice;
  const parsed = parseMarketTicker(signal.marketTicker);
  const modelProb = Math.min(0.95, entryPrice + signal.edgeBps / 10000);

  const now = Date.now();
  // Resolve time: base + random jitter to stagger resolutions
  const jitter = (Math.random() - 0.5) * RESOLVE_SECONDS * 0.6;
  const resolveMs = (RESOLVE_SECONDS + jitter) * 1000;

  const position: OpenPosition = {
    id: nextId++,
    city: signal.metadata?.city || parsed.city,
    date: signal.metadata?.resolveDate || new Date().toISOString().split("T")[0],
    type: signal.side.toUpperCase(),
    bracket: parsed.bracket,
    lowF: parsed.lowF,
    highF: parsed.highF,
    shares,
    entryPrice,
    cost,
    forecastProb: modelProb,
    edge: signal.edgeBps / 10000,
    hoursToResolution: resolveMs / 3600000,
    placedAt: now,
    resolvesAt: now + resolveMs,
    marketTicker: signal.marketTicker,
    strategy: signal.strategy,
  };

  state.balance -= cost;
  state.deployed += cost;
  state.positions.push(position);

  const emoji = signal.strategy === "weather" ? "🌤️" : "🐋";
  console.log(
    `  ${emoji} OPEN  #${position.id} ${position.city} ${position.bracket} ` +
    `| ${shares} shares @ $${entryPrice.toFixed(2)} = $${cost.toFixed(2)} ` +
    `| resolves in ${(resolveMs / 1000).toFixed(0)}s`
  );

  saveState();
}

function resolvePositions(): void {
  const now = Date.now();
  const toResolve = state.positions.filter((p) => now >= p.resolvesAt);
  if (toResolve.length === 0) return;

  for (const pos of toResolve) {
    // Build a fake signal to roll outcome
    const fakeSignal: Signal = {
      timestamp: new Date().toISOString(),
      strategy: pos.strategy as "weather" | "whale",
      eventTicker: "",
      marketTicker: pos.marketTicker,
      side: pos.type.toLowerCase(),
      yesPrice: pos.entryPrice * 100,
      conviction: pos.forecastProb,
      edgeBps: pos.edge * 10000,
      reason: "",
    };

    const { won, simulatedActual } = rollOutcome(fakeSignal);

    // P&L calculation:
    //   WIN:  payout = shares * $1.00 - cost  (YES pays $1 per share if bracket hits)
    //   LOSS: payout = -cost                  (lose entire entry cost)
    const pnl = won ? pos.shares * 1.0 - pos.cost : -pos.cost;

    state.balance += won ? pos.shares * 1.0 : 0; // get back $1/share on win
    state.deployed -= pos.cost;
    state.totalPnl += pnl;
    if (won) state.wins++;
    else state.losses++;

    // Remove from open, add to closed
    state.positions = state.positions.filter((p) => p.id !== pos.id);
    state.closedPositions.push({
      city: pos.city,
      date: pos.date,
      bracket: pos.bracket,
      entry: pos.entryPrice,
      won,
      actualTemp: Math.round(simulatedActual * 10) / 10,
      pnl,
      closedAt: new Date().toISOString(),
    });

    const emoji = won ? "✅" : "❌";
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    console.log(
      `  ${emoji} CLOSE #${pos.id} ${pos.city} ${pos.bracket} ` +
      `| ${won ? "WON" : "LOST"} ${pnlStr} ` +
      `| actual: ${simulatedActual.toFixed(1)}°F ` +
      `| balance: $${state.balance.toFixed(2)}`
    );
  }

  saveState();
}

function checkForNewSignals(): void {
  if (!existsSync(JSONL_PATH)) return;

  let lines: string[];
  try {
    const raw = readFileSync(JSONL_PATH, "utf-8").trim();
    if (!raw) return;
    lines = raw.split("\n");
  } catch {
    return;
  }

  // Only process lines we haven't seen yet
  if (lines.length <= processedLines) return;

  const newLines = lines.slice(processedLines);
  processedLines = lines.length;
  state.scans++;

  for (const line of newLines) {
    try {
      const signal = JSON.parse(line) as Signal;
      placeTrade(signal);
    } catch {
      // Skip malformed lines
    }
  }
}

// Update hoursToResolution on each tick for the dashboard display.
// Only save to disk every 5 seconds — the dashboard SSE polls at 5s anyway
// so saving more frequently than that just wastes disk I/O and causes chart lag.
let lastCountdownSave = 0;
function updateCountdowns(): void {
  const now = Date.now();
  for (const pos of state.positions) {
    pos.hoursToResolution = Math.max(0, (pos.resolvesAt - now) / 3600000);
  }
  if (now - lastCountdownSave > 5000) {
    lastCountdownSave = now;
    saveState();
  }
}

// ─── Main Loop ─────────────────────────────────────────────────────
console.log(`
╔═══════════════════════════════════════════════════╗
║   GAS-BOT PAPER TRADER                           ║
╚═══════════════════════════════════════════════════╝

  Starting balance:  $${START_BALANCE.toFixed(2)}
  Position size:     $${POSITION_SIZE.toFixed(2)}
  Resolution time:   ~${RESOLVE_SECONDS}s per trade
  Signal source:     ${JSONL_PATH}
  State output:      ${STATE_PATH}

  Watching for new signals... (Ctrl+C to stop)
`);

// Skip any signals already in the file (start fresh)
if (existsSync(JSONL_PATH)) {
  try {
    const existing = readFileSync(JSONL_PATH, "utf-8").trim();
    processedLines = existing ? existing.split("\n").length : 0;
    console.log(`  Skipping ${processedLines} existing signals, waiting for new ones...\n`);
  } catch {
    processedLines = 0;
  }
}

// Save initial state
saveState();

// Check for new signals every 2 seconds
const signalPoll = setInterval(checkForNewSignals, 2000);

// Resolve matured positions every 1 second
const resolvePoll = setInterval(resolvePositions, 1000);

// Update countdown timers every 3 seconds
const countdownPoll = setInterval(updateCountdowns, 3000);

// Status line every 30 seconds
const statusPoll = setInterval(() => {
  const openCount = state.positions.length;
  const closedCount = state.closedPositions.length;
  const winRate = state.wins + state.losses > 0
    ? ((state.wins / (state.wins + state.losses)) * 100).toFixed(1)
    : "0.0";
  console.log(
    `\n  📊 Status: $${state.balance.toFixed(2)} balance ` +
    `| ${openCount} open, ${closedCount} closed ` +
    `| ${state.wins}W/${state.losses}L (${winRate}%) ` +
    `| P&L: ${state.totalPnl >= 0 ? "+" : ""}$${state.totalPnl.toFixed(2)}\n`
  );
}, 30_000);

// Clean shutdown
process.on("SIGINT", () => {
  clearInterval(signalPoll);
  clearInterval(resolvePoll);
  clearInterval(countdownPoll);
  clearInterval(statusPoll);

  console.log(`
╔═══════════════════════════════════════════════════╗
║   SESSION SUMMARY                                 ║
╠═══════════════════════════════════════════════════╣
║   Start balance:  $${START_BALANCE.toFixed(2).padEnd(36)}║
║   End balance:    $${state.balance.toFixed(2).padEnd(36)}║
║   Total P&L:      ${(state.totalPnl >= 0 ? "+" : "")}$${state.totalPnl.toFixed(2).padEnd(35)}║
║   ROI:            ${((state.totalPnl / START_BALANCE) * 100).toFixed(1)}%${" ".repeat(34 - ((state.totalPnl / START_BALANCE) * 100).toFixed(1).length)}║
║   Trades:         ${state.wins}W / ${state.losses}L${" ".repeat(32 - `${state.wins}W / ${state.losses}L`.length)}║
║   Open positions: ${state.positions.length}${" ".repeat(36 - state.positions.length.toString().length)}║
╚═══════════════════════════════════════════════════╝
  `);
  saveState();
  process.exit(0);
});
