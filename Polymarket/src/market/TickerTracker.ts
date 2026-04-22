import { ReconnectingWebSocket } from "../net/ReconnectingWebSocket";
import type { TickerSource } from "../util/config";

interface TickerEntry {
  price: number;
  updatedAt: number;
  source: TickerSource;
}

// Binance.com global — 10x higher volume than Binance US, faster price
// discovery. Falls back to Binance US if global is geo-blocked.
const BINANCE_WS = "wss://stream.binance.com:9443/ws/btcusdt@trade";
const BINANCE_US_WS = "wss://stream.binance.us:9443/ws/btcusdt@trade";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";

const STALE_THRESHOLD_MS = 5000;
const DIVERGENCE_ALERT_USD = 50;

export class TickerTracker {
  private sources: Map<TickerSource, TickerEntry> = new Map();
  private connections: ReconnectingWebSocket[] = [];
  private activeSources: TickerSource[];
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  // Keep named refs for watchdog reconnection
  private coinbaseWs: ReconnectingWebSocket | null = null;
  private binanceWs: ReconnectingWebSocket | null = null;

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

    // Watchdog: if any WebSocket feed goes stale for >30s, force reconnect.
    // This catches: silent connection death, maxRetries exhausted, hung sockets.
    this.watchdogTimer = setInterval(() => this.checkHealth(), 15_000);
  }

  /** Stop all feeds. */
  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const ws of this.connections) {
      ws.close();
    }
    this.connections = [];
    this.coinbaseWs = null;
    this.binanceWs = null;
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
    let useFallback = false;

    const makeWs = (url: string) => new ReconnectingWebSocket({
      url,
      onMessage: (data) => {
        try {
          const msg = JSON.parse(typeof data === "string" ? data : data.toString());
          if (msg.p) {
            this.setPrice("binance", parseFloat(msg.p));
          }
        } catch {}
      },
      onError: (err) => {
        // If global Binance fails (geo-blocked), fall back to Binance US
        if (!useFallback && url === BINANCE_WS) {
          useFallback = true;
          console.log("[TickerTracker] Binance global unreachable, falling back to Binance US");
          const fallback = makeWs(BINANCE_US_WS);
          fallback.connect();
          this.connections.push(fallback);
          this.binanceWs = fallback;
        }
      },
      maxRetries: url === BINANCE_WS ? 2 : 10, // fewer retries on global before fallback
    });

    const ws = makeWs(BINANCE_WS);
    ws.connect();
    this.connections.push(ws);
    this.binanceWs = ws;
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
    this.coinbaseWs = ws;
  }

  /**
   * Watchdog health check — runs every 15 seconds.
   * If a feed hasn't delivered a price in 30 seconds, force reconnect.
   * This is the safety net that prevents the bot from stalling permanently
   * when a WebSocket dies silently or exhausts its retry budget.
   */
  private checkHealth(): void {
    const STALE_LIMIT_MS = 30_000;
    const now = Date.now();

    for (const source of this.activeSources) {
      if (source === "polymarket") continue;

      const entry = this.sources.get(source);
      const age = entry ? now - entry.updatedAt : Infinity;

      if (age > STALE_LIMIT_MS) {
        const ws = source === "coinbase" ? this.coinbaseWs : this.binanceWs;
        if (ws) {
          console.log(
            `[TickerTracker] ${source} stale for ${(age / 1000).toFixed(0)}s — forcing reconnect`,
          );
          ws.forceReconnect();
        }
      }
    }
  }
}
