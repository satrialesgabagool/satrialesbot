/**
 * Winner Price Analysis — the ceiling of opportunity for forecast-based strategy.
 *
 * For each resolved event, finds:
 *   - The winning bracket (from Kalshi's `result` field)
 *   - That bracket's market price at various times before close
 *
 * Answers: "If we had perfect foresight, how cheaply could we have bought winners?"
 * If winners are consistently cheap pre-close, forecast infrastructure has room to
 * capture that gap. If they're already expensive, the market figures it out first.
 */

import type { Tape, TapeTrade, TapeEvent, TapeMarket } from "./WeatherTapeCollector";

/** Find the last trade price before a given target time (within window) */
function priceAtTime(
  trades: TapeTrade[],
  targetMs: number,
  windowHours: number,
): number | null {
  const windowMs = windowHours * 3600000;
  let best: TapeTrade | null = null;
  let bestTime = -Infinity;
  for (const t of trades) {
    const tMs = new Date(t.created_time).getTime();
    if (tMs > targetMs) continue;
    if (tMs < targetMs - windowMs) continue;
    if (tMs > bestTime) { best = t; bestTime = tMs; }
  }
  if (!best) return null;
  return best.yes_price > 0 ? best.yes_price : (1 - best.no_price);
}

export interface WinnerSnapshot {
  eventTicker: string;
  city?: string;
  date?: string;
  winnerTicker: string;
  winnerLabel?: string;
  priceByHours: Record<string, number | null>;  // "T-2h", "T-4h", ..., "T-36h"
}

export function winnerPriceAnalysis(tape: Tape): WinnerSnapshot[] {
  const tradesByTicker = new Map<string, TapeTrade[]>();
  for (const t of tape.trades) {
    if (!tradesByTicker.has(t.ticker)) tradesByTicker.set(t.ticker, []);
    tradesByTicker.get(t.ticker)!.push(t);
  }

  const horizons = [2, 4, 6, 8, 12, 18, 24, 36];  // hours before close
  const snapshots: WinnerSnapshot[] = [];

  for (const event of tape.events) {
    // Find the winner bracket
    const winner = event.markets.find(m => m.result === "yes");
    if (!winner) continue;
    const closeStr = event.markets.find(m => m.close_time)?.close_time;
    if (!closeStr) continue;
    const closeMs = new Date(closeStr).getTime();

    const trades = tradesByTicker.get(winner.ticker) ?? [];
    const priceByHours: Record<string, number | null> = {};
    for (const h of horizons) {
      const targetMs = closeMs - h * 3600000;
      priceByHours[`T-${h}h`] = priceAtTime(trades, targetMs, 2);
    }

    snapshots.push({
      eventTicker: event.event_ticker,
      city: event.city,
      date: event.date,
      winnerTicker: winner.ticker,
      winnerLabel: winner.yes_sub_title,
      priceByHours,
    });
  }
  return snapshots;
}

/** Statistics on winner prices at each horizon */
export function summarizeWinnerPrices(snapshots: WinnerSnapshot[]) {
  const horizons = Object.keys(snapshots[0]?.priceByHours ?? {});
  const summary: Record<string, {
    n: number;
    mean: number;
    median: number;
    p25: number;
    p75: number;
    cheapCount: number;    // count priced ≤$0.40
    verycheapCount: number; // count priced ≤$0.20
  }> = {};

  for (const h of horizons) {
    const prices = snapshots
      .map(s => s.priceByHours[h])
      .filter((p): p is number => p !== null && !isNaN(p))
      .sort((a, b) => a - b);
    if (prices.length === 0) {
      summary[h] = { n: 0, mean: 0, median: 0, p25: 0, p75: 0, cheapCount: 0, verycheapCount: 0 };
      continue;
    }
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const median = prices[Math.floor(prices.length / 2)];
    const p25 = prices[Math.floor(prices.length * 0.25)];
    const p75 = prices[Math.floor(prices.length * 0.75)];
    const cheapCount = prices.filter(p => p <= 0.40).length;
    const verycheapCount = prices.filter(p => p <= 0.20).length;
    summary[h] = { n: prices.length, mean, median, p25, p75, cheapCount, verycheapCount };
  }
  return summary;
}
