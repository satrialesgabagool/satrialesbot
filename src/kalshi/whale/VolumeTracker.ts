/**
 * Per-market rolling window aggregator.
 *
 * Given a stream of trades, maintains two windows per market:
 *   - `short` (e.g. 5 min): the window we're hunting whales in
 *   - `baseline` (e.g. 60 min): the trailing baseline used for z-scores
 *
 * Both are implemented as a sliding time window over a deque of trades,
 * so memory is bounded by `baselineWindowMs / avg_trade_spacing`.
 */

import type { KalshiTrade } from "../types";
import type { MarketWindow } from "./types";

interface MarketBuffer {
  ticker: string;
  trades: KalshiTrade[]; // ascending by created_time (ms)
}

export interface VolumeTrackerConfig {
  shortWindowMs: number;
  baselineWindowMs: number;
}

export class VolumeTracker {
  private readonly byMarket = new Map<string, MarketBuffer>();

  constructor(private readonly config: VolumeTrackerConfig) {}

  ingest(t: KalshiTrade): void {
    let buf = this.byMarket.get(t.ticker);
    if (!buf) {
      buf = { ticker: t.ticker, trades: [] };
      this.byMarket.set(t.ticker, buf);
    }
    buf.trades.push(t);
    this.evict(buf, Date.now());
  }

  private evict(buf: MarketBuffer, nowMs: number): void {
    const cutoff = nowMs - this.config.baselineWindowMs;
    let i = 0;
    while (i < buf.trades.length && new Date(buf.trades[i].created_time).getTime() < cutoff) i++;
    if (i > 0) buf.trades.splice(0, i);
  }

  getShortWindow(ticker: string, nowMs = Date.now()): MarketWindow | null {
    return this.buildWindow(ticker, this.config.shortWindowMs, nowMs);
  }

  getBaselineWindow(ticker: string, nowMs = Date.now()): MarketWindow | null {
    return this.buildWindow(ticker, this.config.baselineWindowMs, nowMs);
  }

  private buildWindow(ticker: string, windowMs: number, nowMs: number): MarketWindow | null {
    const buf = this.byMarket.get(ticker);
    if (!buf) return null;
    const cutoff = nowMs - windowMs;
    const trades = buf.trades.filter((t) => new Date(t.created_time).getTime() >= cutoff);
    if (trades.length === 0) return null;

    let contracts = 0;
    let notionalUsd = 0;
    let yesTakerContracts = 0;
    let noTakerContracts = 0;
    let priceQtySum = 0;
    let minYes = Infinity;
    let maxYes = -Infinity;

    for (const t of trades) {
      contracts += t.count;
      notionalUsd += (t.count * t.yes_price) / 100;
      if (t.taker_side === "yes") yesTakerContracts += t.count;
      else noTakerContracts += t.count;
      priceQtySum += t.count * t.yes_price;
      if (t.yes_price < minYes) minYes = t.yes_price;
      if (t.yes_price > maxYes) maxYes = t.yes_price;
    }

    const vwapYesCents = contracts > 0 ? priceQtySum / contracts : 0;

    return {
      ticker,
      windowStart: cutoff,
      tradeCount: trades.length,
      contracts,
      notionalUsd,
      yesTakerContracts,
      noTakerContracts,
      vwapYesCents,
      minYesCents: minYes,
      maxYesCents: maxYes,
      firstYesCents: trades[0].yes_price,
      lastYesCents: trades[trades.length - 1].yes_price,
      trades,
    };
  }

  /**
   * Compute z-score of `shortWindow.notionalUsd` vs the trailing
   * baseline, by sub-windowing the baseline into non-overlapping
   * `shortWindowMs`-sized buckets and computing mean + stddev.
   */
  notionalZScore(ticker: string, nowMs = Date.now()): number {
    const buf = this.byMarket.get(ticker);
    if (!buf) return 0;
    const { shortWindowMs, baselineWindowMs } = this.config;
    const buckets = Math.floor(baselineWindowMs / shortWindowMs);
    if (buckets < 2) return 0;

    const short = this.getShortWindow(ticker, nowMs);
    if (!short) return 0;

    const samples: number[] = [];
    for (let i = 1; i < buckets; i++) {
      const end = nowMs - i * shortWindowMs;
      const start = end - shortWindowMs;
      let notional = 0;
      for (const t of buf.trades) {
        const ts = new Date(t.created_time).getTime();
        if (ts >= start && ts < end) notional += (t.count * t.yes_price) / 100;
      }
      samples.push(notional);
    }

    if (samples.length === 0) return 0;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length;
    const sd = Math.sqrt(variance);
    if (sd === 0) return short.notionalUsd > mean ? 10 : 0;
    return (short.notionalUsd - mean) / sd;
  }

  tickers(): string[] {
    return [...this.byMarket.keys()];
  }
}
