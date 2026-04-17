/**
 * Pure trading math. Kept isolated from any I/O so it can be exhaustively
 * unit-tested (see paper-trader.test.ts). No imports of fs / Date.now /
 * Math.random — callers inject time + RNG so tests are deterministic.
 *
 * Every function here is a pure function of its inputs. Keep it that way.
 */

// ─── Kalshi fee structure ──────────────────────────────────────────────
//
// Kalshi's published fee schedule charges a fee on winning trades only,
// assessed as a fraction of NET WINNINGS (payout − stake), not gross payout.
// The spec we're coding to uses 7% — adjust KALSHI_FEE_RATE if Kalshi's
// actual public rate differs (they have tiered / variable fees historically,
// so this is a simplification; but it's directionally correct and far better
// than the pre-audit code which charged 0%).
//
// Example:
//   Buy 100 contracts YES at $0.42. Market resolves YES (win).
//   Gross payout      = 100 × $1.00 = $100.00
//   Stake             = 100 × $0.42 = $42.00
//   Net winnings      = $100.00 − $42.00 = $58.00
//   Fee (7%)          = $58.00 × 0.07 = $4.06
//   Net P&L           = Net winnings − Fee = $58.00 − $4.06 = $53.94
//   Realized proceeds = Stake returned ($42) + Net P&L ($53.94) = $95.94
//
// Losing trades pay no fee: P&L = −stake.

export const KALSHI_FEE_RATE = 0.07;

/**
 * Fee charged on a closed position. Only winning trades pay a fee, and only
 * on the winnings (not on the stake the trader already had skin in).
 */
export function kalshiFee(
  contracts: number,
  entryPrice: number,
  won: boolean,
  feeRate: number = KALSHI_FEE_RATE,
): number {
  if (!won) return 0;
  const netWinningsPerContract = Math.max(0, 1.0 - entryPrice);
  return round2(contracts * netWinningsPerContract * feeRate);
}

/**
 * Full settlement of a binary-outcome position.
 *
 *   stake        = contracts × entryPrice  (cash deducted from balance when opened)
 *   grossPayout  = contracts × $1.00  if won, else $0
 *   fee          = 7% of net winnings (0 if loss)
 *   netPnl       = grossPayout − stake − fee  (win)    or  −stake (loss)
 *   finalPayout  = grossPayout − fee  (what lands back in the wallet)
 *   returnPct    = netPnl / stake
 */
export interface SettlementResult {
  stake: number;
  grossPayout: number;
  fee: number;
  netPnl: number;
  finalPayout: number;
  returnPct: number;
}

export function settlePosition(
  contracts: number,
  entryPrice: number,
  won: boolean,
  feeRate: number = KALSHI_FEE_RATE,
): SettlementResult {
  const stake = round2(contracts * entryPrice);
  const grossPayout = won ? round2(contracts * 1.0) : 0;
  const fee = kalshiFee(contracts, entryPrice, won, feeRate);
  const netPnl = won ? round2(grossPayout - stake - fee) : round2(-stake);
  const finalPayout = round2(grossPayout - fee);
  const returnPct = stake > 0 ? round4(netPnl / stake) : 0;
  return { stake, grossPayout, fee, netPnl, finalPayout, returnPct };
}

// ─── Unrealized P&L / in-the-money ─────────────────────────────────────

/**
 * Unrealized P&L at the current market price.
 *
 * For a YES position: unrealized = (currentPrice − entryPrice) × contracts.
 * This is the price movement in dollars (contracts × price = dollar value).
 *
 * Unlike settlement, unrealized P&L does NOT subtract a fee — the fee only
 * hits on win (at resolution), so open positions aren't penalized by it.
 * When the position resolves we use `settlePosition` and the fee shows up
 * there.
 */
export function unrealizedPnl(
  contracts: number,
  entryPrice: number,
  currentPrice: number,
): number {
  return round2((currentPrice - entryPrice) * contracts);
}

/**
 * "In-the-money" means the market currently prices the position above
 * where we bought. For YES positions that's currentPrice > entryPrice.
 * A small epsilon prevents flipping status on rounding noise.
 */
export function isInTheMoney(
  entryPrice: number,
  currentPrice: number,
  eps: number = 0.005,
): boolean {
  return currentPrice - entryPrice > eps;
}

// ─── Price path for ACCELERATED mode ───────────────────────────────────

/**
 * Simulated price path: a Brownian bridge anchored at (T0, P0) and (T1, W)
 * where W is the pre-drawn resolution outcome (1 if the trade wins, 0 if
 * it loses). Used by the accelerated backtest mode to give the dashboard
 * something meaningful to display between open and close — otherwise the
 * "current price" would just flatline at the entry.
 *
 * Shape:
 *   price(t) = P0 + (W − P0) × u   (linear drift toward outcome)
 *            + σ × sqrt(u × (1−u)) × ε(t)   (noise, zeroed at endpoints)
 *
 * where u = (t − T0) / (T1 − T0) and ε is a Gaussian sample deterministic
 * per `seed + t` so re-reading state doesn't get jitter.
 */
export function accelPrice(
  t: number,
  T0: number,
  T1: number,
  entryPrice: number,
  outcomeWin: 0 | 1,
  opts: {
    volatility?: number;
    /** RNG injected so tests are deterministic */
    rng?: (seedKey: number) => number;
    /** Position ID or similar — combined with rounded-t to produce a stable "tick" key */
    seed?: number;
  } = {},
): number {
  if (t <= T0) return entryPrice;
  if (t >= T1) return outcomeWin;
  const u = (t - T0) / (T1 - T0);
  const mean = entryPrice + (outcomeWin - entryPrice) * u;
  const volatility = opts.volatility ?? 0.15;
  const sigma = volatility * Math.sqrt(u * (1 - u));
  const seedKey = (opts.seed ?? 0) * 1000 + Math.floor(t / 1000); // 1s buckets
  const eps = opts.rng ? normalFromUniform(opts.rng(seedKey)) : 0;
  return clip01(mean + sigma * eps, 0.01, 0.99);
}

// ─── Edge / conviction gates ───────────────────────────────────────────

/**
 * Should this signal open a trade right now? Returns the reject reason
 * (or null if it passes all gates).
 *
 *   minEdge      — absolute edge in decimal (0.08 = 8%)
 *   maxPerDay    — max trades in a rolling 24h window (the caller handles counter reset at local midnight)
 *   cooldownMs   — min milliseconds since last trade
 */
export interface EdgeGateInput {
  edge: number;           // modelProb − entryPrice
  tradesToday: number;
  lastTradeAtMs: number | null;
  simNowMs: number;
  minEdge: number;
  maxPerDay: number;
  cooldownMs: number;
}

export function edgeGate(x: EdgeGateInput): string | null {
  if (x.edge < x.minEdge) {
    return `edge ${(x.edge * 100).toFixed(1)}% < min ${(x.minEdge * 100).toFixed(1)}%`;
  }
  if (x.tradesToday >= x.maxPerDay) {
    return `daily cap reached (${x.tradesToday}/${x.maxPerDay})`;
  }
  if (x.lastTradeAtMs !== null && x.simNowMs - x.lastTradeAtMs < x.cooldownMs) {
    const remaining = x.cooldownMs - (x.simNowMs - x.lastTradeAtMs);
    return `cooldown ${Math.ceil(remaining / 60000)}m remaining`;
  }
  return null;
}

// ─── Countdown formatting ──────────────────────────────────────────────

/** "Resolves in 4h 22m" / "Resolves in 58s" / "Resolved" */
export function formatCountdown(msUntil: number): string {
  if (msUntil <= 0) return "Resolved";
  const totalSec = Math.floor(msUntil / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `Resolves in ${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `Resolves in ${m}m ${s.toString().padStart(2, "0")}s`;
  return `Resolves in ${s}s`;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function clip01(x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Box-Muller-ish: map a uniform in [0,1) to a standard normal. */
function normalFromUniform(u: number): number {
  // Rejection-free: use two uniforms from a LCG seeded by the input.
  // This is not cryptographic — it's just enough randomness for a price path.
  const u1 = Math.max(1e-9, u);
  const u2 = ((u * 9301 + 49297) % 233280) / 233280;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Deterministic uniform RNG from a seed key. Used for the price path so
 * two reads of the same (position, time) bucket yield the same price,
 * making the state reproducible across SSE reconnects.
 */
export function seededUniform(seedKey: number): number {
  // xorshift-ish; seed 0 is fine
  let x = seedKey | 0;
  if (x === 0) x = 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) % 1_000_000) / 1_000_000;
}

/**
 * Local-date key (YYYY-MM-DD) for a given timestamp in a given timezone.
 * Used to roll the daily-trade counter at local midnight (not UTC midnight).
 */
export function localDateKey(
  timestampMs: number,
  timezone: string = "America/New_York",
): string {
  const d = new Date(timestampMs);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * If a signal only carries a `resolveDate` (YYYY-MM-DD) and a `timezone`,
 * compute the ISO timestamp of local midnight — the moment Kalshi KXHIGH
 * markets resolve against the NWS Daily Climate Report for that local day.
 * (The NWS report is published hours later, but the market's close_time is
 * conventionally set to local midnight; this is the fallback when the
 * signal omits `resolvesAtIso`.)
 */
export function localMidnightIso(
  localDate: string,
  timezone: string = "America/New_York",
): string {
  // Build a Date representing 00:00:00 in the given timezone by formatting
  // a naive noon-UTC of that date in the TZ, then back-solving the offset.
  const noonUtc = new Date(`${localDate}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(noonUtc);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
  // offsetPart looks like "GMT-4" or "GMT+5:30"
  const m = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return `${localDate}T00:00:00Z`;
  const sign = m[1] === "+" ? 1 : -1;
  const hours = parseInt(m[2], 10);
  const mins = parseInt(m[3] ?? "0", 10);
  const offsetMin = sign * (hours * 60 + mins);
  const utcOfLocalMidnightMs = new Date(`${localDate}T00:00:00Z`).getTime() - offsetMin * 60_000;
  return new Date(utcOfLocalMidnightMs).toISOString();
}
