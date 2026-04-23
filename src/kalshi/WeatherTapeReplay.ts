/**
 * Kalshi Weather Tape Replay — "Intrinsic Winner" strategy backtest.
 *
 * The tape analysis showed Kalshi weather takers lose money in cheap brackets
 * (<$0.30) and make money in the $0.70-0.95 zone. This is the classic
 * "buy intrinsic, beat fade" pattern.
 *
 * New strategy:
 *   1. At T hours before close, for each event:
 *      - Find the bracket the market thinks is most likely (highest yes_price)
 *      - If that price is in [minPrice, maxPrice], it's a candidate
 *   2. Buy the favorite at its quoted price (approximated from last trade)
 *   3. Hold to resolution
 *   4. Count wins/losses against Kalshi's actual result
 *
 * This is a one-leg-per-event strategy (not a ladder).
 */

import type { Tape, TapeTrade, TapeMarket, TapeEvent } from "./WeatherTapeCollector";

export interface ReplayConfig {
  /** Hours before close to enter (mid of 4-12h profitable zone) */
  entryHoursBefore: number;
  /** Tolerance window — accept trades within ±this many hours of target */
  entryWindowHours: number;
  /** Only buy if favorite is priced at or above this */
  minPrice: number;
  /** Skip if favorite is priced above this (too close to $1) */
  maxPrice: number;
  /** Budget per bet (USD) */
  betSize: number;
  /** Kalshi fee on net winnings */
  feeRate: number;
  /** Minimum yes_price gap between favorite and #2 (avoid near-tie bets) */
  minFavoriteGap: number;
}

export const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  entryHoursBefore: 8,
  entryWindowHours: 2,
  minPrice: 0.70,
  maxPrice: 0.95,
  betSize: 3,
  feeRate: 0.07,
  minFavoriteGap: 0.05,
};

export interface ReplayBet {
  eventTicker: string;
  city?: string;
  date?: string;
  bracketTicker: string;
  bracketLabel?: string;
  entryTimeIso: string;
  entryPrice: number;
  runnerUpPrice: number;
  shares: number;
  cost: number;
  result: "yes" | "no" | "unknown";
  won: boolean | null;
  pnl: number;
  fee: number;
}

export interface ReplayResult {
  config: ReplayConfig;
  bets: ReplayBet[];
  summary: {
    total: number;
    wins: number;
    losses: number;
    unresolved: number;
    winRate: number;
    totalCost: number;
    totalPnL: number;
    roi: number;
    avgEntry: number;
  };
  perCity: Record<string, { bets: number; wins: number; cost: number; pnl: number; roi: number }>;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Find the last trade that occurred before targetTime (within windowHours tolerance). */
function lastTradeBefore(
  trades: TapeTrade[],
  targetTimeMs: number,
  windowHours: number,
): TapeTrade | null {
  const windowMs = windowHours * 60 * 60 * 1000;
  const earliest = targetTimeMs - windowMs;
  let best: TapeTrade | null = null;
  let bestTime = -Infinity;
  for (const t of trades) {
    const tMs = new Date(t.created_time).getTime();
    if (tMs > targetTimeMs) continue;
    if (tMs < earliest) continue;
    if (tMs > bestTime) {
      best = t;
      bestTime = tMs;
    }
  }
  return best;
}

/** Price a taker YES share would pay, derived from a trade (use yes_price directly). */
function impliedYesPrice(t: TapeTrade): number {
  // Kalshi trades include both yes_price and no_price; they sum to ~1.
  // We use yes_price directly (it's what a YES taker paid).
  if (t.yes_price > 0) return t.yes_price;
  if (t.no_price > 0) return 1 - t.no_price;
  return 0;
}

// ─── Main replay ────────────────────────────────────────────────────

export function replay(tape: Tape, config: Partial<ReplayConfig> = {}): ReplayResult {
  const cfg: ReplayConfig = { ...DEFAULT_REPLAY_CONFIG, ...config };
  const bets: ReplayBet[] = [];

  // Index trades by ticker for fast lookup
  const tradesByTicker = new Map<string, TapeTrade[]>();
  for (const t of tape.trades) {
    if (!tradesByTicker.has(t.ticker)) tradesByTicker.set(t.ticker, []);
    tradesByTicker.get(t.ticker)!.push(t);
  }

  for (const event of tape.events) {
    // Find close time from any market (they all share it for weather events)
    const closeTimeStr = event.markets.find(m => m.close_time)?.close_time;
    if (!closeTimeStr) continue;
    const closeMs = new Date(closeTimeStr).getTime();
    const targetMs = closeMs - cfg.entryHoursBefore * 60 * 60 * 1000;

    // For each bracket in this event, get its price at target time
    const bracketPrices: { market: TapeMarket; price: number; trade: TapeTrade }[] = [];
    for (const m of event.markets) {
      const trades = tradesByTicker.get(m.ticker) ?? [];
      const snap = lastTradeBefore(trades, targetMs, cfg.entryWindowHours);
      if (!snap) continue;
      const px = impliedYesPrice(snap);
      if (px <= 0) continue;
      bracketPrices.push({ market: m, price: px, trade: snap });
    }

    if (bracketPrices.length < 2) continue;  // need at least 2 brackets to identify a favorite

    // Sort descending — favorite is first
    bracketPrices.sort((a, b) => b.price - a.price);
    const favorite = bracketPrices[0];
    const runnerUp = bracketPrices[1];

    // Filter: favorite in profitable price zone?
    if (favorite.price < cfg.minPrice || favorite.price > cfg.maxPrice) continue;

    // Filter: meaningful gap between favorite and #2?
    if (favorite.price - runnerUp.price < cfg.minFavoriteGap) continue;

    // Compute shares + cost + P&L
    const shares = Math.floor(cfg.betSize / favorite.price);
    if (shares < 1) continue;
    const cost = shares * favorite.price;

    const result = (favorite.market.result === "yes" || favorite.market.result === "no")
      ? favorite.market.result
      : "unknown";

    let won: boolean | null = null;
    let pnl = 0;
    let fee = 0;
    if (result !== "unknown") {
      // We always bet YES on the favorite. Win if result === "yes"
      won = result === "yes";
      if (won) {
        const payout = shares * 1.0;
        const gross = payout - cost;
        fee = gross * cfg.feeRate;
        pnl = gross - fee;
      } else {
        pnl = -cost;
      }
    }

    bets.push({
      eventTicker: event.event_ticker,
      city: event.city,
      date: event.date,
      bracketTicker: favorite.market.ticker,
      bracketLabel: favorite.market.yes_sub_title,
      entryTimeIso: favorite.trade.created_time,
      entryPrice: Math.round(favorite.price * 1000) / 1000,
      runnerUpPrice: Math.round(runnerUp.price * 1000) / 1000,
      shares,
      cost: Math.round(cost * 100) / 100,
      result,
      won,
      pnl: Math.round(pnl * 100) / 100,
      fee: Math.round(fee * 100) / 100,
    });
  }

  // Summary
  const resolved = bets.filter(b => b.won !== null);
  const wins = resolved.filter(b => b.won).length;
  const losses = resolved.filter(b => b.won === false).length;
  const totalCost = bets.reduce((s, b) => s + b.cost, 0);
  const totalPnL = resolved.reduce((s, b) => s + b.pnl, 0);
  const totalEntry = bets.reduce((s, b) => s + b.entryPrice, 0);

  const perCity: Record<string, any> = {};
  for (const b of bets) {
    const c = b.city ?? "?";
    perCity[c] ??= { bets: 0, wins: 0, cost: 0, pnl: 0 };
    perCity[c].bets++;
    if (b.won) perCity[c].wins++;
    perCity[c].cost += b.cost;
    if (b.won !== null) perCity[c].pnl += b.pnl;
  }
  for (const k of Object.keys(perCity)) {
    perCity[k].roi = perCity[k].cost > 0 ? perCity[k].pnl / perCity[k].cost : 0;
  }

  return {
    config: cfg,
    bets,
    summary: {
      total: bets.length,
      wins,
      losses,
      unresolved: bets.length - resolved.length,
      winRate: resolved.length > 0 ? wins / resolved.length : 0,
      totalCost: Math.round(totalCost * 100) / 100,
      totalPnL: Math.round(totalPnL * 100) / 100,
      roi: totalCost > 0 ? totalPnL / totalCost : 0,
      avgEntry: bets.length > 0 ? totalEntry / bets.length : 0,
    },
    perCity,
  };
}
