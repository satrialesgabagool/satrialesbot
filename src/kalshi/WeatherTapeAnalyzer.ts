/**
 * Kalshi Weather Tape Analyzer.
 *
 * Two analyses on a collected tape:
 *
 * 1. BUCKET ANALYSIS (like clog's 159k BTC trade study) — treats every taker fill
 *    as a "held to settlement" position. For each fill, compute realized P&L using
 *    the market's actual resolution. Bucket by price, time-to-close, city, bracket type.
 *    Answers: "Does KXHIGH tape have any profitable price/time zones?"
 *
 * 2. STRATEGY REPLAY — simulates what OUR bot (with current filters) would have done
 *    at a representative entry moment (e.g. 12-24h before close). Uses real tape prices.
 *    Compares against actual resolution. Answers: "Does our strategy have edge?"
 */

import type { Tape, TapeTrade, TapeMarket, TapeEvent } from "./WeatherTapeCollector";

// Kalshi 7% fee on net winnings (after cost), no fee on losses
const FEE_RATE = 0.07;

/** Realized PnL per share (assuming held to settlement). Prices are already in dollars. */
function realizedPnL(t: TapeTrade, result: "yes" | "no" | string | undefined): number {
  if (!result || (result !== "yes" && result !== "no")) return 0;
  const won = t.taker_side === result;
  const entryPrice = t.taker_side === "yes" ? t.yes_price : t.no_price;
  if (won) {
    const gross = 1.0 - entryPrice;
    const fee = gross * FEE_RATE;
    return gross - fee;
  } else {
    return -entryPrice;
  }
}

/** Bucket by price (dollars, 0-1 scale). */
function priceBucket(priceDollars: number): string {
  const p = priceDollars;
  if (p < 0.05) return "00_<0.05";
  if (p < 0.15) return "01_0.05-0.15";
  if (p < 0.30) return "02_0.15-0.30";
  if (p < 0.50) return "03_0.30-0.50";
  if (p < 0.70) return "04_0.50-0.70";
  if (p < 0.85) return "05_0.70-0.85";
  if (p <= 0.95) return "06_0.85-0.95";
  return "07_0.95+";
}

/** Bucket by time-to-close */
function timeBucket(tradeTime: string, closeTime?: string): string {
  if (!closeTime) return "?";
  const delta = (new Date(closeTime).getTime() - new Date(tradeTime).getTime()) / 1000 / 60; // minutes
  if (delta < 0) return "99_post-close";
  if (delta < 60) return "01_<1h";
  if (delta < 240) return "02_1-4h";
  if (delta < 720) return "03_4-12h";
  if (delta < 1440) return "04_12-24h";
  if (delta < 2880) return "05_24-48h";
  return "06_>48h";
}

/** Bucket by bracket type (interior vs tail) */
function bracketType(mkt: TapeMarket): "tail_low" | "tail_high" | "interior" | "?" {
  const title = mkt.yes_sub_title ?? "";
  if (title.includes("or below")) return "tail_low";
  if (title.includes("or above")) return "tail_high";
  if (title.includes(" to ")) return "interior";
  return "?";
}

export interface BucketStats {
  bucket: string;
  fills: number;
  shares: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;   // sum of (shares × per-share PnL)
  pnlPerShare: number;
  avgPrice: number;
}

function newStats(bucket: string): BucketStats {
  return { bucket, fills: 0, shares: 0, wins: 0, losses: 0, winRate: 0, totalPnL: 0, pnlPerShare: 0, avgPrice: 0 };
}

function finalize(s: BucketStats): BucketStats {
  s.winRate = (s.wins + s.losses) > 0 ? s.wins / (s.wins + s.losses) : 0;
  s.pnlPerShare = s.shares > 0 ? s.totalPnL / s.shares : 0;
  s.avgPrice = s.shares > 0 ? s.avgPrice / s.shares : 0;
  return s;
}

// ─── Bucket analysis ────────────────────────────────────────────────

export function bucketAnalysis(tape: Tape) {
  const byPrice: Record<string, BucketStats> = {};
  const byTime: Record<string, BucketStats> = {};
  const byBracket: Record<string, BucketStats> = {};
  const byCity: Record<string, BucketStats> = {};
  const byPriceTime: Record<string, BucketStats> = {};

  // Index markets by ticker for quick lookup
  const marketLookup = new Map<string, { market: TapeMarket; event: TapeEvent }>();
  for (const ev of tape.events) {
    for (const m of ev.markets) {
      marketLookup.set(m.ticker, { market: m, event: ev });
    }
  }

  for (const t of tape.trades) {
    const lookup = marketLookup.get(t.ticker);
    if (!lookup) continue;
    const { market, event } = lookup;
    if (market.result !== "yes" && market.result !== "no") continue;

    const pnlShare = realizedPnL(t, market.result);
    const sharePrice = t.taker_side === "yes" ? t.yes_price : t.no_price;
    const won = (t.taker_side === market.result);

    const pBucket = priceBucket(sharePrice);
    const tBucket = timeBucket(t.created_time, market.close_time);
    const bBucket = bracketType(market);
    const cBucket = event.city ?? "?";
    const ptBucket = `${pBucket}_${tBucket}`;

    for (const [map, key] of [
      [byPrice, pBucket],
      [byTime, tBucket],
      [byBracket, bBucket],
      [byCity, cBucket],
      [byPriceTime, ptBucket],
    ] as const) {
      map[key] ??= newStats(key);
      map[key].fills++;
      map[key].shares += t.count;
      if (won) map[key].wins++;
      else map[key].losses++;
      map[key].totalPnL += t.count * pnlShare;
      map[key].avgPrice += t.count * sharePrice;
    }
  }

  const sortAndFinalize = (m: Record<string, BucketStats>) =>
    Object.values(m).map(finalize).sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    byPrice: sortAndFinalize(byPrice),
    byTime: sortAndFinalize(byTime),
    byBracket: sortAndFinalize(byBracket),
    byCity: sortAndFinalize(byCity),
    byPriceTime: sortAndFinalize(byPriceTime),
  };
}

// ─── Overall summary ────────────────────────────────────────────────

export function overallSummary(tape: Tape) {
  let fills = 0, wins = 0, losses = 0, totalPnL = 0, totalShares = 0;
  const marketLookup = new Map<string, TapeMarket>();
  for (const ev of tape.events) for (const m of ev.markets) marketLookup.set(m.ticker, m);

  for (const t of tape.trades) {
    const m = marketLookup.get(t.ticker);
    if (!m || (m.result !== "yes" && m.result !== "no")) continue;
    const pnlShare = realizedPnL(t, m.result);
    const won = t.taker_side === m.result;
    fills++;
    totalShares += t.count;
    if (won) wins++; else losses++;
    totalPnL += t.count * pnlShare;
  }

  return {
    fills,
    wins,
    losses,
    winRate: (wins + losses) > 0 ? wins / (wins + losses) : 0,
    totalPnL,
    pnlPerShare: totalShares > 0 ? totalPnL / totalShares : 0,
    totalShares,
  };
}
