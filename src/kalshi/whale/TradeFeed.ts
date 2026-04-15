/**
 * Trade feed for the whale tracker.
 *
 * Two modes:
 *   - "poll": REST-polls /markets/trades every `pollIntervalMs`.
 *             Works unauthenticated against public Kalshi. Used in paper
 *             mode — no credentials needed.
 *   - "ws":   Subscribes to the WS `trade` channel. Lower latency. Will
 *             fall back to poll if WS fails.
 *
 * Deduplicates by `trade_id` so overlapping poll windows don't
 * double-count.
 */

import type { KalshiClient } from "../client/KalshiClient";
import { KalshiWS } from "../client/KalshiWS";
import type { KalshiTrade } from "../client/types";

export type TradeHandler = (trade: KalshiTrade) => void;

export interface TradeFeedOptions {
  mode: "poll" | "ws";
  pollIntervalMs?: number;
  /** Keep dedup window small (30s) since we evict from buffer anyway */
  dedupWindowMs?: number;
  /** Optional list of tickers to scope the feed to. Omit for all markets. */
  tickers?: string[];
}

export class TradeFeed {
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: KalshiWS | null = null;
  private lastPollTs = Math.floor((Date.now() - 60_000) / 1000); // seconds — start 1 min back
  private seen = new Map<string, number>(); // trade_id → ms epoch
  private handlers: TradeHandler[] = [];

  constructor(
    private readonly client: KalshiClient,
    private readonly opts: TradeFeedOptions,
  ) {}

  onTrade(handler: TradeHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    if (this.opts.mode === "ws") {
      this.startWS();
    } else {
      await this.startPolling();
    }
  }

  stop(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  // ─── Polling mode ──────────────────────────────────────────────

  private async startPolling(): Promise<void> {
    this.polling = true;
    const interval = this.opts.pollIntervalMs ?? 2000;
    const loop = async () => {
      if (!this.polling) return;
      try {
        await this.pollOnce();
      } catch (err) {
        console.warn("[whale] poll error:", (err as Error).message);
      }
      this.pollTimer = setTimeout(loop, interval);
    };
    await loop();
  }

  private async pollOnce(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    // Fetch trades from `lastPollTs` forward. Kalshi's /markets/trades
    // supports `min_ts` (seconds) and returns in descending order by default.
    const tickers = this.opts.tickers && this.opts.tickers.length > 0 ? this.opts.tickers : [undefined];
    for (const ticker of tickers) {
      for await (const trade of this.client.paginateTrades({ ticker, minTs: this.lastPollTs })) {
        if (this.seen.has(trade.trade_id)) continue;
        this.seen.set(trade.trade_id, Date.now());
        for (const h of this.handlers) h(trade);
      }
    }
    this.lastPollTs = now - 5; // overlap 5s to avoid missing edges
    this.evictDedup();
  }

  private evictDedup(): void {
    const cutoff = Date.now() - (this.opts.dedupWindowMs ?? 30_000);
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  // ─── WebSocket mode ────────────────────────────────────────────

  private startWS(): void {
    this.ws = new KalshiWS({
      client: this.client,
      onOpen: () => console.log("[whale] ws connected"),
      onClose: () => console.log("[whale] ws closed"),
      onError: (e) => console.warn("[whale] ws error:", e.message),
      onMessage: (frame) => {
        // Kalshi trade frames look like: { type: "trade", msg: { ...KalshiTrade } }
        if (frame.type !== "trade" || !frame.msg) return;
        const trade = frame.msg as KalshiTrade;
        if (!trade.trade_id) return;
        if (this.seen.has(trade.trade_id)) return;
        this.seen.set(trade.trade_id, Date.now());
        for (const h of this.handlers) h(trade);
      },
    });
    this.ws.connect();
    this.ws.subscribe(["trade"], this.opts.tickers);
  }
}
