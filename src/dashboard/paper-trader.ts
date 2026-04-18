#!/usr/bin/env bun
/**
 * Gas-bot Paper Trader — LIVE + ACCELERATED modes.
 *
 * A simulation engine that:
 *   1. Watches the scanner JSONL for `strategy: "weather"` signals
 *   2. Gates them through edge / cooldown / daily-cap filters so only
 *      2-5 high-conviction trades fire per day (not one every 3 seconds)
 *   3. Opens positions with real stake accounting and a real resolution
 *      timestamp drawn from the market's `close_time` (not a 15-second
 *      countdown)
 *   4. Tracks a live "current price" between open and close — either
 *      polled from Kalshi or simulated via a Brownian bridge anchored
 *      to a pre-drawn outcome
 *   5. Resolves at the real close time with Kalshi's 7%-of-net-winnings
 *      fee applied
 *   6. Writes a rich state JSON that the dashboard renders with all the
 *      columns the spec calls for (countdown, current price, unrealized
 *      P&L, in-the-money, return %, etc.)
 *
 * Two modes:
 *   --mode=live         Real wall clock. Resolve times are absolute.
 *   --mode=backtest     Compressed clock: 1 real sec = --time-scale sim min.
 *                       Price path uses Brownian bridge → pre-drawn outcome.
 *
 * Example:
 *   bun run src/dashboard/paper-trader.ts --mode live --balance 1000
 *   bun run src/dashboard/paper-trader.ts --mode backtest --time-scale 60
 *
 * See src/dashboard/README.md for the full flag list and the validation
 * tests in src/dashboard/__tests__/trading-math.test.ts for the math.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs";
import { join } from "path";

import {
  accelPrice,
  edgeGate,
  formatCountdown,
  isInTheMoney,
  KALSHI_FEE_RATE,
  kalshiFee,
  localDateKey,
  localMidnightIso,
  seededUniform,
  settlePosition,
  unrealizedPnl,
} from "./trading-math";
import { KalshiClient } from "../kalshi/KalshiClient";
import { parseDollars, type KalshiMarket } from "../kalshi/types";

// ─── CLI parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argStr(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}
function argNum(name: string, fallback: number): number {
  const v = argStr(name, String(fallback));
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

const MODE = (argStr("mode", "live").toUpperCase() as "LIVE" | "BACKTEST");
const TIME_SCALE = argNum("time-scale", 60);       // BACKTEST: 1 real sec = N sim min
const START_BALANCE = argNum("balance", 1000);     // starting cash
const POSITION_SIZE = argNum("size", 50);          // dollars per trade
const MIN_EDGE = argNum("min-edge", 0.08);         // decimal, 0.08 = 8%
const MAX_PER_DAY = argNum("max-per-day", 5);      // cap
const COOLDOWN_MIN = argNum("cooldown-min", 30);   // minutes between trades (scaled in BACKTEST)
const PRICE_POLL_MIN = argNum("price-poll-min", 5); // minutes between price refreshes
const LOCAL_TZ = argStr("tz", "America/New_York"); // timezone for daily-cap reset
// Skip penny brackets — phantom liquidity on Kalshi. This matches the real
// scanner's `minBracketPrice = 0.03` convention, a touch more conservative
// because we also use it as a position-size sanity check (at $0.02, a $50
// stake buys 2500 contracts — unrealistic fills for a bracket market).
const MIN_ENTRY_PRICE = argNum("min-entry-price", 0.05);

// ─── Paths ─────────────────────────────────────────────────────────────

const RESULTS_DIR = "results";
const STATE_DIR = "state";
const JSONL_PATH = join(RESULTS_DIR, "high-conviction.jsonl");
const STATE_PATH = join(STATE_DIR, "weather-sim.json");
const RESULTS_LOG = join(RESULTS_DIR, `paper-trades-${MODE.toLowerCase()}.jsonl`);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Types ─────────────────────────────────────────────────────────────

interface Signal {
  timestamp: string;
  strategy: "weather" | "whale";
  eventTicker: string;
  marketTicker: string;
  side: string;
  yesPrice: number;       // cents 1..99
  conviction: number;
  edgeBps: number;
  reason: string;
  metadata?: {
    city?: string;
    type?: "high" | "low";
    resolveDate?: string;
    hoursLeft?: number;
    resolvesAtIso?: string;    // absolute close_time — emitted by scanner (new)
    bracketLowF?: number | null;
    bracketHighF?: number | null;
    trueProb?: number;
    marketProb?: number;
    probMethod?: string;
    [k: string]: unknown;
  };
}

/** Short display name like "NYC High 2026-04-17 [78-79°F]". */
function marketName(sig: Signal): string {
  const m = sig.metadata ?? {};
  const city = (m.city as string) ?? "?";
  const date = (m.resolveDate as string) ?? "?";
  const type = (m.type as string) ?? "high";
  const lo = m.bracketLowF;
  const hi = m.bracketHighF;
  const bracket =
    typeof lo === "number" && isFinite(lo) && typeof hi === "number" && isFinite(hi)
      ? `[${lo}-${hi}°F]`
      : typeof hi === "number" && isFinite(hi)
      ? `[≤${hi}°F]`
      : typeof lo === "number" && isFinite(lo)
      ? `[≥${lo}°F]`
      : "";
  return `${city} ${type} ${date} ${bracket}`.trim();
}

export interface Position {
  id: number;
  marketTicker: string;
  eventTicker: string;
  city: string;
  marketName: string;
  direction: "YES" | "NO";
  bracket: string;
  lowF: number | null;
  highF: number | null;

  contracts: number;
  entryPrice: number;           // dollars 0..1
  modelProbAtEntry: number;     // dollars 0..1
  edgeAtEntry: number;          // modelProb − entryPrice, decimal
  stake: number;                // contracts × entryPrice
  maxPayout: number;            // contracts × 1.00

  // Timing
  placedAtMs: number;           // sim-clock ms
  placedAtIso: string;
  resolvesAtMs: number;         // sim-clock ms
  resolvesAtIso: string;

  // Live state (updated on each tick)
  currentPrice: number;
  unrealizedPnl: number;
  status: "OPEN" | "IN_THE_MONEY" | "OUT_OF_MONEY";

  // Pre-drawn outcome (sealed at open; resolution reveals it)
  outcomeWin: 0 | 1;
  rngSeed: number;              // for accelPrice determinism

  // Reason the signal was accepted
  signalReason: string;
  probMethod: string;
}

export interface Closed extends Position {
  resolvedAtMs: number;
  resolvedAtIso: string;
  won: boolean;
  grossPayout: number;
  feesPaid: number;
  netPnl: number;                // after fees
  returnPct: number;
  finalPayout: number;
}

interface SimState {
  mode: "LIVE" | "BACKTEST";
  timeScale: number;

  // Time tracking. In LIVE mode simNowMs ≡ Date.now() on each tick.
  // In BACKTEST mode simNowMs advances by (realDeltaMs × timeScale × 60).
  simStartedAtMs: number;       // wall-clock when sim began
  simNowMs: number;             // simulated clock
  realLastTickMs: number;       // wall-clock of last tick (for BACKTEST time advance)

  // Account
  startBalance: number;
  availableCash: number;
  unrealizedPnlTotal: number;
  realizedPnl: number;
  totalPortfolioValue: number;

  // Counters
  wins: number;
  losses: number;
  totalFeesPaid: number;
  winCountByEdge: number;       // for avg-edge-captured stat
  winEdgeSum: number;

  // Throttles
  tradesTodayDate: string;
  tradesTodayCount: number;
  lastTradeAtMs: number | null;

  // Positions
  openPositions: Position[];
  closedPositions: Closed[];

  // Throughput
  scans: number;
  savedAt: string;

  // Config echo — shown in the dashboard header
  config: {
    mode: "LIVE" | "BACKTEST";
    timeScale: number;
    startBalance: number;
    positionSize: number;
    minEdge: number;
    minEntryPrice: number;
    maxPerDay: number;
    cooldownMin: number;
    pricePollMin: number;
    localTz: string;
    kalshiFeeRate: number;
  };
}

let nextId = 1;

function freshState(): SimState {
  const now = Date.now();
  return {
    mode: MODE,
    timeScale: TIME_SCALE,
    simStartedAtMs: now,
    simNowMs: now,
    realLastTickMs: now,

    startBalance: START_BALANCE,
    availableCash: START_BALANCE,
    unrealizedPnlTotal: 0,
    realizedPnl: 0,
    totalPortfolioValue: START_BALANCE,

    wins: 0,
    losses: 0,
    totalFeesPaid: 0,
    winCountByEdge: 0,
    winEdgeSum: 0,

    tradesTodayDate: localDateKey(now, LOCAL_TZ),
    tradesTodayCount: 0,
    lastTradeAtMs: null,

    openPositions: [],
    closedPositions: [],

    scans: 0,
    savedAt: new Date().toISOString(),

    config: {
      mode: MODE,
      timeScale: TIME_SCALE,
      startBalance: START_BALANCE,
      positionSize: POSITION_SIZE,
      minEdge: MIN_EDGE,
      minEntryPrice: MIN_ENTRY_PRICE,
      maxPerDay: MAX_PER_DAY,
      cooldownMin: COOLDOWN_MIN,
      pricePollMin: PRICE_POLL_MIN,
      localTz: LOCAL_TZ,
      kalshiFeeRate: KALSHI_FEE_RATE,
    },
  };
}

const state: SimState = freshState();
let processedLines = 0;

// ─── State I/O ─────────────────────────────────────────────────────────

/**
 * Atomic save: write to tmp then rename. Single writer (one process), so
 * we don't need a cross-process mutex — the `saveState()` calls in this
 * file are serialized by the JS event loop.
 */
function saveState(): void {
  state.savedAt = new Date().toISOString();
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  try {
    renameSync(tmp, STATE_PATH);
  } catch {
    // On Windows, renameSync can fail if the target is open for reading.
    // Fall back to direct write — a momentary partial file is acceptable
    // because the SSE stream re-reads on the next poll tick anyway.
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  }
}

function logResult(entry: Record<string, unknown>): void {
  try {
    require("fs").appendFileSync(RESULTS_LOG, JSON.stringify(entry) + "\n");
  } catch {}
}

// ─── Clock ─────────────────────────────────────────────────────────────

/**
 * Advance the simulated clock. In LIVE mode this is a no-op since simNowMs
 * tracks wall-clock. In BACKTEST mode, one real second of wall time advances
 * simNowMs by `timeScale` simulated minutes — so timeScale=60 means a
 * minute of real time is an hour of sim time, turning a 12-hour resolution
 * window into 12 real minutes.
 */
function tickClock(): void {
  const now = Date.now();
  if (state.mode === "LIVE") {
    state.simNowMs = now;
  } else {
    const dtReal = now - state.realLastTickMs;
    state.simNowMs += dtReal * state.timeScale * 60;
  }
  state.realLastTickMs = now;
}

// ─── Signal ingestion → trade placement ────────────────────────────────

/**
 * Derive everything we need from a signal. Prefers `metadata.trueProb` +
 * `metadata.marketProb` (real scanner output) over the `yesPrice + edgeBps`
 * math (demo seeder output), because the scanner already rounded/clipped
 * them and the demo seeder's edge math can overshoot 1.0.
 */
function deriveEntry(
  sig: Signal,
): { entryPrice: number; modelProb: number; edge: number } | null {
  const m = sig.metadata ?? {};
  const entry =
    typeof m.marketProb === "number" ? m.marketProb : sig.yesPrice / 100;
  let model =
    typeof m.trueProb === "number" ? m.trueProb : entry + sig.edgeBps / 10000;
  // Clip model prob into a plausible [0.01, 0.99] range — a demo seeder
  // that pumps edgeBps=2500 on a yesPrice=80 signal would otherwise produce
  // modelProb=1.05 and break the Bernoulli draw below.
  model = Math.max(0.01, Math.min(0.99, model));
  const edge = model - entry;
  if (entry <= 0 || entry >= 1) return null;
  return { entryPrice: entry, modelProb: model, edge };
}

/**
 * Parse bracket bounds for display + in-the-money labeling. Prefers
 * metadata.bracketLowF/highF (authoritative); falls back to parsing
 * "KXHIGHNY-26APR16-T65" where T65 is the lower strike.
 */
function extractBracket(sig: Signal): { lowF: number | null; highF: number | null; label: string } {
  const m = sig.metadata ?? {};
  const lo = typeof m.bracketLowF === "number" ? m.bracketLowF : null;
  const hi = typeof m.bracketHighF === "number" ? m.bracketHighF : null;
  if (lo !== null && hi !== null) {
    const loLabel = isFinite(lo) ? `${lo}` : "-∞";
    const hiLabel = isFinite(hi) ? `${hi}` : "+∞";
    return { lowF: lo, highF: hi, label: `${loLabel}-${hiLabel}°F` };
  }
  const tMatch = sig.marketTicker.match(/T(\d+)(?:[A-Z].*)?$/);
  if (tMatch) {
    const l = parseInt(tMatch[1], 10);
    return { lowF: l, highF: l + 1, label: `${l}-${l + 1}°F` };
  }
  return { lowF: null, highF: null, label: "?" };
}

function resolveIsoFromSignal(sig: Signal): string {
  const m = sig.metadata ?? {};
  if (typeof m.resolvesAtIso === "string" && m.resolvesAtIso.length >= 10) {
    return m.resolvesAtIso;
  }
  // Fall back to end-of-local-day in the configured timezone. This matches
  // the KXHIGH convention (markets resolve on the NWS Daily Climate Report,
  // close_time is local midnight for the resolution date).
  const date = typeof m.resolveDate === "string" ? m.resolveDate : null;
  if (date) {
    // Local midnight of the NEXT day, so the resolution moment is AFTER
    // the target day has ended. e.g. resolveDate=2026-04-17 → 2026-04-18T00:00 local.
    const nextDay = new Date(`${date}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextDateStr = nextDay.toISOString().split("T")[0];
    return localMidnightIso(nextDateStr, LOCAL_TZ);
  }
  // Last-resort fallback: 12h from now. Anchoring to the sim clock (not
  // real clock) so BACKTEST mode still respects timeScale.
  return new Date(state.simNowMs + 12 * 3600 * 1000).toISOString();
}

function rollDailyCounter(): void {
  const today = localDateKey(state.simNowMs, LOCAL_TZ);
  if (today !== state.tradesTodayDate) {
    state.tradesTodayDate = today;
    state.tradesTodayCount = 0;
  }
}

/**
 * Try to open a new position for this signal. Applies all gates:
 * - weather strategy only (whale signals are display-only)
 * - min-edge
 * - daily cap
 * - cooldown
 * - affordability
 * - dedup (same market-ticker + direction already open)
 */
function placeTrade(sig: Signal): void {
  // Gate 1: only weather signals produce trades. Whale signals are
  // information only — we don't know what direction to take from a whale
  // hit without additional confluence logic (that's the "combined signal"
  // work; not this PR).
  if (sig.strategy !== "weather") return;

  const entry = deriveEntry(sig);
  if (!entry) return;

  // Gate 1b: skip penny brackets. At entryPrice=$0.02 a $50 stake buys 2500
  // contracts — unrealistic fills in a real Kalshi bracket market.
  if (entry.entryPrice < MIN_ENTRY_PRICE) return;

  // Gate 2: edge / cap / cooldown.
  // The cooldown is a wall-clock value in BACKTEST too — but TIME_SCALE
  // means a real 30-min cooldown is 30 * timeScale sim-min, which is what
  // we want: "2-5 trades per SIM day", not "per real second".
  rollDailyCounter();
  const gateReason = edgeGate({
    edge: entry.edge,
    tradesToday: state.tradesTodayCount,
    lastTradeAtMs: state.lastTradeAtMs,
    simNowMs: state.simNowMs,
    minEdge: MIN_EDGE,
    maxPerDay: MAX_PER_DAY,
    cooldownMs: COOLDOWN_MIN * 60 * 1000,
  });
  if (gateReason) {
    // Not logged on every skip to avoid spamming — we'd flood the console
    // with the seed-demo pumping signals every few seconds.
    return;
  }

  // Gate 3: affordability. With a fixed position size, this only trips
  // when we've burned through our cash.
  if (state.availableCash < POSITION_SIZE) return;

  // Gate 4: dedup. Don't open two positions on the same market/direction.
  const dup = state.openPositions.find(
    (p) =>
      p.marketTicker === sig.marketTicker &&
      p.direction === (sig.side.toUpperCase() === "NO" ? "NO" : "YES"),
  );
  if (dup) return;

  // All gates passed — open the position.
  const contracts = Math.floor(POSITION_SIZE / entry.entryPrice);
  if (contracts <= 0) return;
  const stake = Math.round(contracts * entry.entryPrice * 100) / 100;

  const resolvesAtIso = resolveIsoFromSignal(sig);
  const resolvesAtMs = new Date(resolvesAtIso).getTime();

  // Pre-draw the outcome using model probability. This is what "paper
  // trading" means: the bot's *thesis* (modelProb) determines the outcome,
  // not the signal's market price. Real money would use real outcomes;
  // here we're measuring how well the bot's probability assignments play
  // out under their own lights.
  const outcomeWin: 0 | 1 = Math.random() < entry.modelProb ? 1 : 0;

  const bracket = extractBracket(sig);
  const direction: "YES" | "NO" = sig.side.toUpperCase() === "NO" ? "NO" : "YES";
  const placedAtMs = state.simNowMs;

  const pos: Position = {
    id: nextId++,
    marketTicker: sig.marketTicker,
    eventTicker: sig.eventTicker,
    city: (sig.metadata?.city as string) ?? "?",
    marketName: marketName(sig),
    direction,
    bracket: bracket.label,
    lowF: bracket.lowF,
    highF: bracket.highF,

    contracts,
    entryPrice: entry.entryPrice,
    modelProbAtEntry: entry.modelProb,
    edgeAtEntry: entry.edge,
    stake,
    maxPayout: Math.round(contracts * 100) / 100,

    placedAtMs,
    placedAtIso: new Date(placedAtMs).toISOString(),
    resolvesAtMs,
    resolvesAtIso,

    currentPrice: entry.entryPrice,
    unrealizedPnl: 0,
    status: "OPEN",

    outcomeWin,
    rngSeed: nextId,

    signalReason: sig.reason,
    probMethod: (sig.metadata?.probMethod as string) ?? "gaussian",
  };

  state.availableCash = round2(state.availableCash - stake);
  state.openPositions.push(pos);
  state.tradesTodayCount += 1;
  state.lastTradeAtMs = placedAtMs;

  const pctEdge = (entry.edge * 100).toFixed(1);
  const pctModel = (entry.modelProb * 100).toFixed(0);
  const pctMarket = (entry.entryPrice * 100).toFixed(0);
  console.log(
    `  OPEN #${pos.id} ${pos.marketName} ${direction} ` +
      `${contracts} @ $${entry.entryPrice.toFixed(2)} = $${stake.toFixed(2)} ` +
      `| Model: ${pctModel}% | Market: ${pctMarket}% | Edge: ${pctEdge}% | ` +
      `${formatCountdown(resolvesAtMs - placedAtMs)}`,
  );

  logResult({ event: "OPEN", position: pos });
  recomputePortfolio();
  saveState();
}

// ─── Price updates (on every tick) ─────────────────────────────────────

/**
 * Refresh current prices for all open positions.
 *
 * LIVE mode polls the real Kalshi `/markets?tickers=…` endpoint so the
 * dashboard's "current price" / "in-the-money" / "unrealized P&L" fields
 * reflect actual market state — not the old Brownian-bridge fiction.
 * BACKTEST mode (and any fetch failure in LIVE) falls back to
 * `accelPrice()` + the pre-drawn outcome so we stay usable offline and in
 * tests.
 *
 * Live polling is gated on `livePollingEnabled`, which only `start()`
 * flips on. That keeps the test suite (which imports the module but
 * doesn't call `start()`) from making real HTTP calls.
 *
 * Still-fiction (see LOSS_DIAGNOSIS §90/10): the final WIN/LOSS at
 * settlement still reads `pos.outcomeWin`, a pre-drawn Bernoulli.
 * Fixing that requires `KalshiClient.getMarketResult()` — scheduled
 * next PR (SIGNAL_IMPROVEMENTS item 1.1).
 */
let lastPricePollMs = 0;
let livePollingEnabled = false;
let livePollInflight = false;
let liveClient: KalshiClient | null = null;
let liveFetchFailures = 0;
const LIVE_FETCH_TIMEOUT_MS = 4_000;
const LIVE_FETCH_MAX_FAILURES_BEFORE_WARN = 3;

/** Lazy singleton — mirrors KalshiWeatherFinder's `getClient()` pattern. */
function getLiveClient(): KalshiClient {
  if (!liveClient) {
    liveClient = new KalshiClient({ demo: false, timeout: LIVE_FETCH_TIMEOUT_MS });
  }
  return liveClient;
}

/**
 * Compute an honest market price from a Kalshi market snapshot.
 *   - Prefer midpoint of (yes_bid, yes_ask) when both are non-zero
 *   - Else fall back to last_price
 *   - Else null (leave the position's currentPrice unchanged)
 * For NO positions, mirror around 1.0 (since YES + NO ≈ 1 on a binary
 * market, modulo the spread).
 */
function priceFromMarket(m: KalshiMarket, direction: "YES" | "NO"): number | null {
  const yesBid = parseDollars(m.yes_bid_dollars);
  const yesAsk = parseDollars(m.yes_ask_dollars);
  const last = parseDollars(m.last_price_dollars);

  let yesPrice: number | null = null;
  if (yesBid > 0 && yesAsk > 0 && yesAsk >= yesBid) {
    yesPrice = (yesBid + yesAsk) / 2;
  } else if (yesAsk > 0) {
    yesPrice = yesAsk;
  } else if (yesBid > 0) {
    yesPrice = yesBid;
  } else if (last > 0 && last < 1) {
    yesPrice = last;
  }

  if (yesPrice === null) return null;

  // Clamp into (0, 1) — Kalshi can briefly report 0 or 1 during settlement.
  const clamped = Math.max(0.01, Math.min(0.99, yesPrice));
  return direction === "YES" ? clamped : 1 - clamped;
}

/** Apply a new price to a position (shared by LIVE and Brownian paths). */
function applyPriceUpdate(pos: Position, newPrice: number): void {
  pos.currentPrice = round2(newPrice);
  pos.unrealizedPnl = unrealizedPnl(pos.contracts, pos.entryPrice, pos.currentPrice);
  pos.status = isInTheMoney(pos.entryPrice, pos.currentPrice)
    ? "IN_THE_MONEY"
    : pos.currentPrice < pos.entryPrice
    ? "OUT_OF_MONEY"
    : "OPEN";
}

/**
 * Brownian-bridge fallback. Used by BACKTEST mode always, and by LIVE
 * mode as a fallback when the HTTP fetch errors out.
 */
function refreshPricesBrownian(): void {
  for (const pos of state.openPositions) {
    const t = state.simNowMs;
    const price = accelPrice(
      t,
      pos.placedAtMs,
      pos.resolvesAtMs,
      pos.entryPrice,
      pos.outcomeWin,
      { seed: pos.rngSeed, rng: seededUniform },
    );
    applyPriceUpdate(pos, price);
  }
}

/**
 * LIVE path. Batches all open-position tickers into one
 * `/markets?tickers=…` call. Non-blocking — the tick loop runs every
 * 500ms and doesn't wait on this.
 */
async function refreshPricesLive(): Promise<void> {
  if (livePollInflight) return; // don't stack up pending fetches
  const positions = state.openPositions.slice(); // snapshot
  if (positions.length === 0) return;

  livePollInflight = true;
  try {
    const tickers = Array.from(new Set(positions.map((p) => p.marketTicker))).join(",");
    const client = getLiveClient();
    const res = await client.getMarkets({ tickers, limit: Math.max(20, positions.length) });
    const byTicker = new Map<string, KalshiMarket>();
    for (const m of res.markets ?? []) byTicker.set(m.ticker, m);

    const stalePositions: Position[] = [];
    for (const pos of state.openPositions) {
      const market = byTicker.get(pos.marketTicker);
      if (!market) {
        stalePositions.push(pos);
        continue;
      }
      const price = priceFromMarket(market, pos.direction);
      if (price === null) {
        stalePositions.push(pos);
        continue;
      }
      applyPriceUpdate(pos, price);
    }

    // For any ticker Kalshi didn't return or returned empty book, keep the
    // dashboard alive with a Brownian estimate — rather than a frozen price
    // that misleads for hours.
    for (const pos of stalePositions) {
      const t = state.simNowMs;
      const price = accelPrice(
        t, pos.placedAtMs, pos.resolvesAtMs, pos.entryPrice, pos.outcomeWin,
        { seed: pos.rngSeed, rng: seededUniform },
      );
      applyPriceUpdate(pos, price);
    }

    liveFetchFailures = 0;
    recomputePortfolio();
  } catch (err) {
    liveFetchFailures += 1;
    if (liveFetchFailures === 1 || liveFetchFailures % LIVE_FETCH_MAX_FAILURES_BEFORE_WARN === 0) {
      console.warn(
        `  [live-poll] Kalshi fetch failed (${liveFetchFailures} consecutive): ` +
          `${(err as Error).message}. Falling back to Brownian bridge for this tick.`,
      );
    }
    // Fallback so the dashboard still moves — same behavior as before.
    refreshPricesBrownian();
  } finally {
    livePollInflight = false;
  }
}

function refreshPrices(): void {
  if (state.openPositions.length === 0) return;
  const pollIntervalMs = Math.max(1, PRICE_POLL_MIN) * 60 * 1000;
  // BACKTEST: use sim clock. LIVE: use wall clock.
  const nowForPoll = state.mode === "LIVE" ? Date.now() : state.simNowMs;
  if (nowForPoll - lastPricePollMs < pollIntervalMs) return;
  lastPricePollMs = nowForPoll;

  if (state.mode === "LIVE" && livePollingEnabled) {
    // Fire-and-forget. The `livePollInflight` guard keeps us from
    // stacking pending fetches if the API is slow.
    void refreshPricesLive();
    return;
  }

  refreshPricesBrownian();
}

// ─── Resolution ────────────────────────────────────────────────────────

/**
 * Resolve any position whose `resolvesAtMs` has passed on the sim clock.
 * Fees are applied here — never on open.
 */
function resolvePositions(): void {
  const due = state.openPositions.filter((p) => state.simNowMs >= p.resolvesAtMs);
  if (due.length === 0) return;

  for (const pos of due) {
    const won = pos.outcomeWin === 1;
    const s = settlePosition(pos.contracts, pos.entryPrice, won);

    // Cash return: stake was already deducted on open, so on a win we add
    // back the final payout (gross − fee). On a loss we add nothing (the
    // stake stays deducted — it's lost).
    state.availableCash = round2(state.availableCash + s.finalPayout);
    state.realizedPnl = round2(state.realizedPnl + s.netPnl);
    state.totalFeesPaid = round2(state.totalFeesPaid + s.fee);

    if (won) {
      state.wins += 1;
      state.winCountByEdge += 1;
      state.winEdgeSum += pos.edgeAtEntry;
    } else {
      state.losses += 1;
    }

    const closed: Closed = {
      ...pos,
      currentPrice: won ? 1.0 : 0.0,
      unrealizedPnl: 0, // unrealized collapses into realized at resolution
      status: won ? "IN_THE_MONEY" : "OUT_OF_MONEY",
      resolvedAtMs: state.simNowMs,
      resolvedAtIso: new Date(state.simNowMs).toISOString(),
      won,
      grossPayout: s.grossPayout,
      feesPaid: s.fee,
      netPnl: s.netPnl,
      returnPct: s.returnPct,
      finalPayout: s.finalPayout,
    };

    state.openPositions = state.openPositions.filter((p) => p.id !== pos.id);
    state.closedPositions.push(closed);

    console.log(
      `  ${won ? "WIN " : "LOSS"} #${pos.id} ${pos.marketName} ` +
        `${won ? "+" : ""}$${s.netPnl.toFixed(2)} ` +
        `(stake $${s.stake.toFixed(2)}, payout $${s.grossPayout.toFixed(2)}, fee $${s.fee.toFixed(2)}) ` +
        `| cash $${state.availableCash.toFixed(2)}`,
    );
    logResult({ event: "CLOSE", position: closed });
  }

  recomputePortfolio();
  saveState();
}

function recomputePortfolio(): void {
  state.unrealizedPnlTotal = round2(
    state.openPositions.reduce((s, p) => s + p.unrealizedPnl, 0),
  );
  const openStakeMtm = round2(
    state.openPositions.reduce((s, p) => s + p.contracts * p.currentPrice, 0),
  );
  state.totalPortfolioValue = round2(state.availableCash + openStakeMtm);
}

// ─── Signal polling ────────────────────────────────────────────────────

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
  if (lines.length <= processedLines) return;
  const newLines = lines.slice(processedLines);
  processedLines = lines.length;
  state.scans += 1;
  for (const line of newLines) {
    try {
      const sig = JSON.parse(line) as Signal;
      placeTrade(sig);
    } catch {
      // malformed
    }
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function banner(): void {
  const cfg = state.config;
  console.log(`
╔═══════════════════════════════════════════════════╗
║   GAS-BOT PAPER TRADER  —  ${cfg.mode.padEnd(10)}              ║
╚═══════════════════════════════════════════════════╝

  Mode:                ${cfg.mode}${cfg.mode === "BACKTEST" ? ` (1 real sec = ${cfg.timeScale} sim min)` : ""}
  Starting balance:    $${cfg.startBalance.toFixed(2)}
  Position size:       $${cfg.positionSize.toFixed(2)} per trade
  Min edge:            ${(cfg.minEdge * 100).toFixed(1)}%
  Max trades/day:      ${cfg.maxPerDay}
  Cooldown:            ${cfg.cooldownMin} min${cfg.mode === "BACKTEST" ? " (sim time)" : ""}
  Price poll every:    ${cfg.pricePollMin} min
  Local timezone:      ${cfg.localTz}
  Kalshi fee rate:     ${(cfg.kalshiFeeRate * 100).toFixed(1)}% of net winnings

  Signal source:       ${JSONL_PATH}
  State output:        ${STATE_PATH}
  Trade log:           ${RESULTS_LOG}

  Press Ctrl+C to stop.
`);
}

function statusLine(): void {
  const { wins, losses, availableCash, realizedPnl, unrealizedPnlTotal, totalPortfolioValue } = state;
  const n = wins + losses;
  const winRate = n > 0 ? ((wins / n) * 100).toFixed(1) : "—";
  const avgEdge = state.winCountByEdge > 0 ? (state.winEdgeSum / state.winCountByEdge * 100).toFixed(1) : "—";
  console.log(
    `\n  STATUS [${state.mode}] ` +
      `Cash $${availableCash.toFixed(2)} | ` +
      `Open ${state.openPositions.length} | ` +
      `PV $${totalPortfolioValue.toFixed(2)} | ` +
      `Realized ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)} | ` +
      `Unrealized ${unrealizedPnlTotal >= 0 ? "+" : ""}$${unrealizedPnlTotal.toFixed(2)} | ` +
      `${wins}W/${losses}L (${winRate}%) | ` +
      `avg edge won: ${avgEdge}%\n`,
  );
}

function start(): void {
  banner();

  // Enable real Kalshi price polling for the LIVE trader. Tests import
  // this module without calling start(), so they never flip this flag
  // and never fire HTTP — keeps the test suite offline-safe.
  if (MODE === "LIVE") {
    livePollingEnabled = true;
    console.log("  [live-poll] Real Kalshi market polling: ENABLED (production API).\n");
  }

  // Skip signals that were already in the file when we started (they're stale)
  if (existsSync(JSONL_PATH)) {
    try {
      const existing = readFileSync(JSONL_PATH, "utf-8").trim();
      processedLines = existing ? existing.split("\n").length : 0;
      if (processedLines > 0) {
        console.log(`  Skipping ${processedLines} pre-existing signals; waiting for new ones.\n`);
      }
    } catch {}
  }

  saveState();

  // Tick loop. We wake up twice per second and do everything fast:
  // advance the sim clock → check new signals → refresh prices → resolve.
  const tickMs = 500;
  setInterval(() => {
    try {
      tickClock();
      checkForNewSignals();
      refreshPrices();
      resolvePositions();
      recomputePortfolio();
      // Throttle state writes: once per tick is fine (~2 Hz) but we
      // don't need to write if nothing changed. For simplicity we write
      // every tick — the file is small and the dashboard SSE polls it
      // on a 5s cadence anyway.
      saveState();
    } catch (err) {
      console.error("tick error:", (err as Error).message);
    }
  }, tickMs);

  setInterval(statusLine, 30_000);

  process.on("SIGINT", () => {
    console.log("\n  Shutting down paper trader.");
    saveState();
    statusLine();
    process.exit(0);
  });
}

// Run only when executed directly (not when imported by tests).
if (import.meta.main) {
  start();
}

// ─── Exports for tests ─────────────────────────────────────────────────
// Public surface so validation tests can drive the trader through its
// lifecycle without spawning a subprocess.
//
// The module owns a single `state` instance; tests reset it with __reset()
// between cases rather than re-importing the module (which would be a
// dance with require.cache invalidation under Bun). __reset() also rolls
// back nextId so ids start at 1 again — makes assertions readable.

function __reset(): void {
  Object.assign(state, freshState());
  nextId = 1;
  processedLines = 0;
  lastPricePollMs = 0;
}

/** Test hook: advance the sim clock by N milliseconds. */
function __advanceSimClock(ms: number): void {
  state.simNowMs += ms;
  state.realLastTickMs = Date.now();
}

export {
  state as __state,
  placeTrade as __placeTrade,
  refreshPrices as __refreshPrices,
  resolvePositions as __resolvePositions,
  recomputePortfolio as __recomputePortfolio,
  freshState as __freshState,
  saveState as __saveState,
  __reset,
  __advanceSimClock,
  type SimState,
  type Signal,
};
