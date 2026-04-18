/**
 * Whale-tracker shared types.
 *
 * We treat every individual trade from Kalshi's trade feed as a sample.
 * `VolumeTracker` aggregates into per-market rolling windows; the
 * `WhaleDetector` applies thresholds to flag high-conviction signals.
 *
 * Dollar notional per trade: contracts × yes_price cents / 100
 *   (one Kalshi contract pays $1.00 on resolution, so yes_price/100
 *    is the dollar cost of the YES side)
 */

import type { KalshiTrade } from "../types";

export interface MarketWindow {
  ticker: string;
  /** Start of the rolling window (ms epoch) */
  windowStart: number;
  tradeCount: number;
  contracts: number;
  /** Sum of contracts × yes_price/100 in USD */
  notionalUsd: number;
  /** Contracts where taker_side was yes (bought yes, aggressed on yes ask) */
  yesTakerContracts: number;
  /** Contracts where taker_side was no */
  noTakerContracts: number;
  /** Running VWAP (yes price cents) */
  vwapYesCents: number;
  /** Min / max yes_price seen in window */
  minYesCents: number;
  maxYesCents: number;
  firstYesCents: number;
  lastYesCents: number;
  trades: KalshiTrade[];
}

export interface WhaleSignal {
  ticker: string;
  windowSec: number;
  notionalUsd: number;
  contracts: number;
  directionalityPct: number;  // 0..1, fraction of contracts on dominant taker side
  dominantSide: "yes" | "no";
  priceMoveCents: number;     // lastYesCents - firstYesCents
  vwapYesCents: number;
  trades: number;
  /** Z-score of this window's notional vs the trailing baseline mean+stddev */
  notionalZScore: number;
  reason: string;
}
