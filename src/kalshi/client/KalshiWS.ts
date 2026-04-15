/**
 * Kalshi WebSocket client (public channels only, for now).
 *
 * Wraps ReconnectingWebSocket and handles Kalshi's JSON protocol:
 *   → send: { id, cmd: "subscribe", params: { channels, market_tickers } }
 *   ← recv: { type, msg } frames per channel
 *
 * Public channels used here:
 *   - "trade"           — live trade prints (whale tracker)
 *   - "ticker"          — best bid/ask updates
 *   - "orderbook_delta" — full-depth diffs
 *
 * Private channels ("fill", "order", "position") require auth; wired
 * but disabled in paper mode.
 */

import { ReconnectingWebSocket } from "../../net/ReconnectingWebSocket";
import type { KalshiClient } from "./KalshiClient";

export type KalshiChannel =
  | "trade"
  | "ticker"
  | "ticker_v2"
  | "orderbook_delta"
  | "fill"
  | "order"
  | "position";

export interface KalshiWSMessage {
  type: string;
  sid?: number;
  seq?: number;
  msg?: unknown;
}

export interface KalshiWSOptions {
  client: KalshiClient;
  onMessage: (msg: KalshiWSMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
}

export class KalshiWS {
  private ws: ReconnectingWebSocket | null = null;
  private cmdId = 1;
  private pendingSubs: { channels: KalshiChannel[]; marketTickers?: string[] }[] = [];

  constructor(private readonly opts: KalshiWSOptions) {}

  connect(): void {
    this.ws = new ReconnectingWebSocket({
      url: this.opts.client.wsUrl,
      onOpen: () => {
        // Re-send any pending subscriptions after reconnect
        for (const sub of this.pendingSubs) this.sendSubscribe(sub.channels, sub.marketTickers);
        this.opts.onOpen?.();
      },
      onClose: () => this.opts.onClose?.(),
      onError: (e) => this.opts.onError?.(e),
      onMessage: (data) => {
        try {
          const parsed = JSON.parse(typeof data === "string" ? data : data.toString()) as KalshiWSMessage;
          this.opts.onMessage(parsed);
        } catch (err) {
          this.opts.onError?.(err as Error);
        }
      },
    });
    this.ws.connect();
  }

  /**
   * Subscribe to one or more channels. For market-scoped channels
   * (trade, ticker, orderbook_delta) you can optionally filter by
   * ticker list; omit to receive all markets.
   */
  subscribe(channels: KalshiChannel[], marketTickers?: string[]): void {
    this.pendingSubs.push({ channels, marketTickers });
    if (this.ws?.isConnected) this.sendSubscribe(channels, marketTickers);
  }

  private sendSubscribe(channels: KalshiChannel[], marketTickers?: string[]): void {
    const cmd: Record<string, unknown> = {
      id: this.cmdId++,
      cmd: "subscribe",
      params: { channels },
    };
    if (marketTickers && marketTickers.length > 0) {
      (cmd.params as Record<string, unknown>).market_tickers = marketTickers;
    }
    this.ws?.send(JSON.stringify(cmd));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
