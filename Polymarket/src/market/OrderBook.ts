import { ReconnectingWebSocket } from "../net/ReconnectingWebSocket";
import { PriceLevelMap } from "./PriceLevelMap";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export type BookSide = "UP" | "DOWN";

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookSnapshot {
  upAsks: BookLevel[];
  upBids: BookLevel[];
  downAsks: BookLevel[];
  downBids: BookLevel[];
  timestamp: number;
}

interface WSBookMessage {
  event_type: string;
  asset_id?: string;
  market?: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  changes?: Array<{ price: string; size: string; side: string }>;
  // price_change events
  price?: string;
  side?: string;
  size?: string;
}

export class OrderBook {
  private ws: ReconnectingWebSocket | null = null;
  private tokenIds: [string, string]; // [UP, DOWN]

  // UP side books
  private upAsks = new PriceLevelMap("asc");
  private upBids = new PriceLevelMap("desc");

  // DOWN side books
  private downAsks = new PriceLevelMap("asc");
  private downBids = new PriceLevelMap("desc");

  private ready = false;
  private onReadyCallback: (() => void) | null = null;

  constructor(tokenIdUp: string, tokenIdDown: string) {
    this.tokenIds = [tokenIdUp, tokenIdDown];
  }

  /** Subscribe to the order book WebSocket. */
  connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.onReadyCallback = resolve;

      this.ws = new ReconnectingWebSocket({
        url: WS_URL,
        onOpen: () => {
          // Subscribe to both token order books
          this.ws!.send(
            JSON.stringify({
              type: "market",
              assets_ids: this.tokenIds,
            }),
          );
        },
        onMessage: (data) => {
          this.handleMessage(typeof data === "string" ? data : data.toString());
        },
        onError: (err) => {
          console.error("[OrderBook] WebSocket error:", err.message);
        },
      });

      this.ws.connect();
    });
  }

  /** Disconnect from the WebSocket. */
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.ready = false;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Best ask price and liquidity for a side. */
  bestAskInfo(side: BookSide): { price: number; size: number } | null {
    const map = side === "UP" ? this.upAsks : this.downAsks;
    return map.best();
  }

  /** Best bid price and liquidity for a side. */
  bestBidInfo(side: BookSide): { price: number; size: number } | null {
    const map = side === "UP" ? this.upBids : this.downBids;
    return map.best();
  }

  /** Best ask price for a side, or null. */
  bestAskPrice(side: BookSide): number | null {
    return this.bestAskInfo(side)?.price ?? null;
  }

  /** Best bid price for a side, or null. */
  bestBidPrice(side: BookSide): number | null {
    return this.bestBidInfo(side)?.price ?? null;
  }

  /** Current spread for a side. */
  spread(side: BookSide): number | null {
    const ask = this.bestAskPrice(side);
    const bid = this.bestBidPrice(side);
    if (ask === null || bid === null) return null;
    return ask - bid;
  }

  /** Total liquidity available on the ask side up to a price. */
  askLiquidityUpTo(side: BookSide, maxPrice: number): number {
    const map = side === "UP" ? this.upAsks : this.downAsks;
    return map.sizeUpTo(maxPrice);
  }

  /** Top N levels for a side. */
  topAsks(side: BookSide, n: number = 5): BookLevel[] {
    const map = side === "UP" ? this.upAsks : this.downAsks;
    return map.topLevels(n);
  }

  topBids(side: BookSide, n: number = 5): BookLevel[] {
    const map = side === "UP" ? this.upBids : this.downBids;
    return map.topLevels(n);
  }

  /** Get a full snapshot of the book state. */
  snapshot(): BookSnapshot {
    return {
      upAsks: this.topAsks("UP", 10),
      upBids: this.topBids("UP", 10),
      downAsks: this.topAsks("DOWN", 10),
      downBids: this.topBids("DOWN", 10),
      timestamp: Date.now(),
    };
  }

  /** Get the asks/bids PriceLevelMap directly. */
  getAsks(side: BookSide): PriceLevelMap {
    return side === "UP" ? this.upAsks : this.downAsks;
  }

  getBids(side: BookSide): PriceLevelMap {
    return side === "UP" ? this.upBids : this.downBids;
  }

  private handleMessage(raw: string): void {
    let msgs: WSBookMessage[];
    try {
      const parsed = JSON.parse(raw);
      msgs = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return;
    }

    for (const msg of msgs) {
      if (msg.event_type === "book") {
        this.handleBookSnapshot(msg);
      } else if (msg.event_type === "price_change") {
        this.handlePriceChange(msg);
      }
    }
  }

  private handleBookSnapshot(msg: WSBookMessage): void {
    const assetId = msg.asset_id;
    if (!assetId) return;

    const isUp = assetId === this.tokenIds[0];
    const asks = isUp ? this.upAsks : this.downAsks;
    const bids = isUp ? this.upBids : this.downBids;

    asks.clear();
    bids.clear();

    if (msg.asks) {
      for (const level of msg.asks) {
        asks.set(parseFloat(level.price), parseFloat(level.size));
      }
    }

    if (msg.bids) {
      for (const level of msg.bids) {
        bids.set(parseFloat(level.price), parseFloat(level.size));
      }
    }

    if (!this.ready) {
      this.ready = true;
      this.onReadyCallback?.();
      this.onReadyCallback = null;
    }
  }

  private handlePriceChange(msg: WSBookMessage): void {
    const assetId = msg.asset_id;
    if (!assetId || !msg.price || !msg.size || !msg.side) return;

    const isUp = assetId === this.tokenIds[0];
    const price = parseFloat(msg.price);
    const size = parseFloat(msg.size);

    let map: PriceLevelMap;
    if (msg.side === "BUY" || msg.side === "buy") {
      map = isUp ? this.upBids : this.downBids;
    } else {
      map = isUp ? this.upAsks : this.downAsks;
    }

    map.set(price, size);
  }
}
