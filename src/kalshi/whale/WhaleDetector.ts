/**
 * Threshold-based whale signal detector.
 *
 * Emits a WhaleSignal when, over the short rolling window, ALL of:
 *   - window notional ≥ minNotionalUsd
 *   - directionality (dominant-side contracts / total) ≥ minDirectionality
 *   - z-score vs trailing baseline ≥ minZScore
 *   - trade count ≥ minTradeCount (filter out single-shot fills)
 *
 * Conviction score (0..1-ish):
 *   conviction = clip(notional / anchorNotional, 0, 1)
 *              × clip((directionality - 0.5) * 2, 0, 1)
 *              × clip(zscore / 5, 0, 1)
 *
 * Side of recommended action:
 *   If taker_side was dominantly YES, aggressive money was BUYING YES →
 *   model that as directional pressure. We flag it as a BUY-YES signal.
 *   (Take it or fade it is a strategy choice; scanner just reports.)
 */

import type { MarketWindow, WhaleSignal } from "./types";

export interface WhaleDetectorConfig {
  minNotionalUsd: number;
  minDirectionality: number;  // 0.5..1
  minZScore: number;
  minTradeCount: number;
  anchorNotionalUsd: number;  // notional that earns a 1.0 size score
}

export const DEFAULT_WHALE_CONFIG: WhaleDetectorConfig = {
  minNotionalUsd: 5000,
  minDirectionality: 0.7,
  minZScore: 3,
  minTradeCount: 5,
  anchorNotionalUsd: 50_000,
};

export class WhaleDetector {
  constructor(private readonly config: WhaleDetectorConfig = DEFAULT_WHALE_CONFIG) {}

  evaluate(w: MarketWindow, zScore: number): WhaleSignal | null {
    if (w.contracts === 0) return null;
    if (w.tradeCount < this.config.minTradeCount) return null;
    if (w.notionalUsd < this.config.minNotionalUsd) return null;
    if (zScore < this.config.minZScore) return null;

    const dominantSide: "yes" | "no" =
      w.yesTakerContracts >= w.noTakerContracts ? "yes" : "no";
    const directionality =
      dominantSide === "yes"
        ? w.yesTakerContracts / w.contracts
        : w.noTakerContracts / w.contracts;
    if (directionality < this.config.minDirectionality) return null;

    const windowSec = Math.round((Date.now() - w.windowStart) / 1000);
    const priceMove = w.lastYesCents - w.firstYesCents;

    const reason =
      `$${Math.round(w.notionalUsd).toLocaleString()} notional in ${windowSec}s, ` +
      `${(directionality * 100).toFixed(0)}% ${dominantSide.toUpperCase()}-taker, ` +
      `z=${zScore.toFixed(1)}, Δprice=${priceMove >= 0 ? "+" : ""}${priceMove}¢`;

    return {
      ticker: w.ticker,
      windowSec,
      notionalUsd: Math.round(w.notionalUsd * 100) / 100,
      contracts: w.contracts,
      directionalityPct: Math.round(directionality * 10000) / 10000,
      dominantSide,
      priceMoveCents: priceMove,
      vwapYesCents: Math.round(w.vwapYesCents * 10) / 10,
      trades: w.tradeCount,
      notionalZScore: Math.round(zScore * 100) / 100,
      reason,
    };
  }

  convictionScore(s: WhaleSignal): number {
    const sizeScore = Math.min(1, s.notionalUsd / this.config.anchorNotionalUsd);
    const dirScore = Math.max(0, Math.min(1, (s.directionalityPct - 0.5) * 2));
    const zScore = Math.max(0, Math.min(1, s.notionalZScore / 5));
    return Math.round(sizeScore * dirScore * zScore * 10000) / 10000;
  }
}
