import { ReconnectingWebSocket } from "../net/ReconnectingWebSocket";
import type { TickerSource } from "../util/config";

interface TickerEntry {
  price: number;
  updatedAt: number;
  source: TickerSource;
}

const BINANCE_WS = "wss://stream.binance.us:9443/ws/btcusdt@trade";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

const STALE_THRESHOLD_MS = 5000;
const DIVERGENCE_ALERT_USD = 50;

export class TickerTracker {
  private sources: Map<TickerSource, TickerEntry> = new Map();
  private connections: ReconnectingWebSocket[] = [];
  private activeSources: TickerSource[];

  constructor(sources: TickerSource[]) {
    this.activeSources = sources;
  }

  /** Start all configured price feeds. */
  start(): void {
    for (const source of this.activeSources) {
      switch (source) {
        case "binance":
          this.connectBinance();
          break;
        case "coinbase":
          this.connectCoinbase();
          break;
        case "polymarket":
          // Polymarket ticker comes from the order book / market data
          // We'll update it externally via setPrice()
          break;
      }
    }
  }

  /** Stop all feeds. */
  stop(): void {
    for (const ws of this.connections) {
      ws.close();
    }
    this.connections = [];
  }

  /** Manually set a price (used by Polymarket feed or external source). */
  setPrice(source: TickerSource, price: number): void {
    this.sources.set(source, { price, updatedAt: Date.now(), source });
  }

  /** Get the best available BTC price. Priority: polymarket > binance > coinbase. */
  get price(): number | undefined {
    const priority: TickerSource[] = ["polymarket", "binance", "coinbase"];
    for (const src of priority) {
      const entry = this.sources.get(src);
      if (entry && Date.now() - entry.updatedAt < STALE_THRESHOLD_MS) {
        return entry.price;
      }
    }
    // Return any non-stale source
    for (const entry of this.sources.values()) {
      if (Date.now() - entry.updatedAt < STALE_THRESHOLD_MS) {
        return entry.price;
      }
    }
    return undefined;
  }

  /** Get price from a specific source. */
  priceFrom(source: TickerSource): number | undefined {
    const entry = this.sources.get(source);
    if (!entry) return undefined;
    if (Date.now() - entry.updatedAt > STALE_THRESHOLD_MS) return undefined;
    return entry.price;
  }

  /** Compute max divergence between sources in USD. */
  get divergence(): number | null {
    const prices: number[] = [];
    for (const entry of this.sources.values()) {
      if (Date.now() - entry.updatedAt < STALE_THRESHOLD_MS) {
        prices.push(entry.price);
      }
    }
    if (prices.length < 2) return null;
    return Math.max(...prices) - Math.min(...prices);
  }

  /** Check if divergence exceeds alert threshold. */
  get isDiverging(): boolean {
    const div = this.divergence;
    return div !== null && div > DIVERGENCE_ALERT_USD;
  }

  /** Check if all sources are fresh. */
  get allFresh(): boolean {
    for (const source of this.activeSources) {
      if (source === "polymarket") continue; // Updated externally
      const entry = this.sources.get(source);
      if (!entry || Date.now() - entry.updatedAt > STALE_THRESHOLD_MS) return false;
    }
    return true;
  }

  /** Get a summary for logging. */
  summary(): Record<string, number | null> {
    const result: Record<string, number | null> = {};
    for (const source of this.activeSources) {
      result[source] = this.priceFrom(source) ?? null;
    }
    result.divergence = this.divergence;
    return result;
  }

  private connectBinance(): void {
    const ws = new ReconnectingWebSocket({
      url: BINANCE_WS,
      onMessage: (data) => {
        try {
          const msg = JSON.parse(typeof data === "string" ? data : data.toString());
          if (msg.p) {
            this.setPrice("binance", parseFloat(msg.p));
          }
        } catch {}
      },
    });
    ws.connect();
    this.connections.push(ws);
  }

  private connectCoinbase(): void {
    const ws = new ReconnectingWebSocket({
      url: COINBASE_WS,
      onOpen: () => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: ["BTC-USD"],
            channels: ["ticker"],
          }),
        );
      },
      onMessage: (data) => {
        try {
          const msg = JSON.parse(typeof data === "string" ? data : data.toString());
          if (msg.type === "ticker" && msg.price) {
            this.setPrice("coinbase", parseFloat(msg.price));
          }
        } catch {}
      },
    });
    ws.connect();
    this.connections.push(ws);
  }
}
