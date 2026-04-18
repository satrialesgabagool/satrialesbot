/**
 * Whale scanner — stalks large directional flows on Kalshi.
 *
 * Flow:
 *   1. TradeFeed streams trades into VolumeTracker.
 *   2. Every `evalIntervalMs`, for each market that saw activity,
 *      compute the short-window MarketWindow + notional z-score.
 *   3. WhaleDetector applies thresholds; any passing signal gets
 *      rate-limited (one alert per market per `alertCooldownMs`) and
 *      emitted to the HighConvictionLog.
 *
 * Deliberately no auto-execution: this strategy is about front-running
 * yourself, not racing someone else's order. We just detect and log.
 */

import type { KalshiClient } from "../KalshiClient";
import { HighConvictionLog, type HighConvictionRow } from "../output/HighConvictionLog";
import { TradeFeed, type TradeFeedOptions } from "./TradeFeed";
import { VolumeTracker, type VolumeTrackerConfig } from "./VolumeTracker";
import { WhaleDetector, type WhaleDetectorConfig, DEFAULT_WHALE_CONFIG } from "./WhaleDetector";

export interface WhaleScannerConfig {
  volume: VolumeTrackerConfig;
  detector: WhaleDetectorConfig;
  feed: TradeFeedOptions;
  evalIntervalMs: number;
  alertCooldownMs: number;
}

export const DEFAULT_WHALE_SCANNER_CONFIG: WhaleScannerConfig = {
  volume: {
    shortWindowMs: 5 * 60 * 1000,   // 5-minute whale window
    baselineWindowMs: 60 * 60 * 1000, // 1-hour baseline
  },
  detector: DEFAULT_WHALE_CONFIG,
  feed: { mode: "poll", pollIntervalMs: 2000 },
  evalIntervalMs: 15_000, // evaluate every 15s
  alertCooldownMs: 10 * 60 * 1000, // one alert per market per 10min
};

export class WhaleScanner {
  private readonly feed: TradeFeed;
  private readonly tracker: VolumeTracker;
  private readonly detector: WhaleDetector;
  private evalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAlertAt = new Map<string, number>();
  private stopped = false;
  private trades = 0;

  constructor(
    private readonly client: KalshiClient,
    private readonly log: HighConvictionLog,
    private readonly config: WhaleScannerConfig = DEFAULT_WHALE_SCANNER_CONFIG,
  ) {
    this.tracker = new VolumeTracker(config.volume);
    this.detector = new WhaleDetector(config.detector);
    this.feed = new TradeFeed(client, config.feed);
    this.feed.onTrade((t) => {
      this.tracker.ingest(t);
      this.trades++;
    });
  }

  async start(): Promise<void> {
    console.log(
      `[whale] scanner started — feed=${this.config.feed.mode}, ` +
        `shortWin=${this.config.volume.shortWindowMs / 1000}s, ` +
        `baseline=${this.config.volume.baselineWindowMs / 1000}s, ` +
        `minNotional=$${this.config.detector.minNotionalUsd}`,
    );
    await this.feed.start();
    this.scheduleEval();
  }

  stop(): void {
    this.stopped = true;
    this.feed.stop();
    if (this.evalTimer) clearTimeout(this.evalTimer);
    console.log(`[whale] scanner stopped after ingesting ${this.trades} trades`);
  }

  private scheduleEval(): void {
    if (this.stopped) return;
    this.evalTimer = setTimeout(() => {
      try {
        this.evaluateOnce();
      } catch (err) {
        console.error("[whale] eval error:", (err as Error).message);
      }
      this.scheduleEval();
    }, this.config.evalIntervalMs);
  }

  private evaluateOnce(): void {
    const now = Date.now();
    let hits = 0;
    for (const ticker of this.tracker.tickers()) {
      const lastAlert = this.lastAlertAt.get(ticker) ?? 0;
      if (now - lastAlert < this.config.alertCooldownMs) continue;

      const window = this.tracker.getShortWindow(ticker, now);
      if (!window) continue;
      const z = this.tracker.notionalZScore(ticker, now);
      const signal = this.detector.evaluate(window, z);
      if (!signal) continue;

      const conviction = this.detector.convictionScore(signal);
      const row: HighConvictionRow = {
        timestamp: new Date().toISOString(),
        strategy: "whale",
        eventTicker: "", // whale strategy doesn't know the event; market ticker is enough
        marketTicker: signal.ticker,
        side: signal.dominantSide,
        yesPrice: Math.round(signal.vwapYesCents),
        sizeContracts: 0,
        conviction,
        edgeBps: 0, // not a pricing edge — it's a flow signal
        reason: signal.reason,
        metadata: {
          windowSec: signal.windowSec,
          notionalUsd: signal.notionalUsd,
          contracts: signal.contracts,
          directionalityPct: signal.directionalityPct,
          priceMoveCents: signal.priceMoveCents,
          trades: signal.trades,
          zScore: signal.notionalZScore,
          vwapYesCents: signal.vwapYesCents,
        },
      };
      this.log.append(row);
      this.lastAlertAt.set(ticker, now);
      hits++;
      console.log(`[whale] HIT ${signal.ticker}: ${signal.reason}`);
    }

    if (hits === 0 && this.trades > 0 && this.trades % 500 === 0) {
      console.log(`[whale] ${this.trades} trades ingested, no whales yet`);
    }
  }
}
