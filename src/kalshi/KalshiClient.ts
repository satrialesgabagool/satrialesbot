/**
 * Kalshi REST API client.
 *
 * Handles market data (no auth needed) and authenticated operations
 * (orders, portfolio) when credentials are provided.
 *
 * Supports both production and demo environments.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { signRequest, type KalshiCredentials } from "./KalshiAuth";
import type {
  KalshiEvent,
  KalshiMarket,
  KalshiOrderBook,
  KalshiOrder,
  KalshiBalance,
  KalshiTrade,
  CreateOrderRequest,
  GetEventsResponse,
  GetMarketsResponse,
  GetPositionsResponse,
  GetTradesResponse,
  CreateOrderResponse,
} from "./types";

const PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";
const PROD_WS = "wss://api.elections.kalshi.com/trade-api/ws/v2";
const DEMO_WS = "wss://demo-api.kalshi.co/trade-api/ws/v2";

export interface KalshiClientConfig {
  /** Use demo environment (default: true for safety) */
  demo?: boolean;
  /** Credentials for authenticated endpoints (orders, portfolio) */
  credentials?: KalshiCredentials;
  /** Request timeout in ms */
  timeout?: number;
}

export class KalshiClient {
  private baseUrl: string;
  private creds: KalshiCredentials | null;
  private timeout: number;

  constructor(config?: KalshiClientConfig) {
    this.baseUrl = config?.demo !== false ? DEMO_BASE : PROD_BASE;
    this.creds = config?.credentials ?? null;
    this.timeout = config?.timeout ?? 10_000;
  }

  /** WebSocket URL for trade/ticker/orderbook streaming (whale tracker). */
  get wsUrl(): string {
    return this.baseUrl === DEMO_BASE ? DEMO_WS : PROD_WS;
  }

  get isDemo(): boolean {
    return this.baseUrl === DEMO_BASE;
  }

  get isAuthenticated(): boolean {
    return this.creds !== null;
  }

  get environment(): string {
    return this.isDemo ? "demo" : "production";
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    requireAuth: boolean = false,
  ): Promise<T> {
    if (requireAuth && !this.creds) {
      throw new Error("Kalshi credentials required for this operation");
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Sign if credentials available (even for public endpoints)
    if (this.creds) {
      const apiPath = `/trade-api/v2${path}`;
      Object.assign(headers, signRequest(this.creds, method, apiPath));
    }

    const opts: RequestInit & { timeout?: number } = {
      method,
      headers,
      timeout: this.timeout,
    };

    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetchWithRetry(url, opts, { maxRetries: 2 });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kalshi ${method} ${path}: ${res.status} ${res.statusText} — ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // ─── Public Market Data (no auth needed) ──────────────────────────

  /**
   * List events, optionally filtered by series.
   */
  async getEvents(params?: {
    series_ticker?: string;
    status?: "unopened" | "open" | "closed" | "settled";
    with_nested_markets?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<GetEventsResponse> {
    const qs = new URLSearchParams();
    if (params?.series_ticker) qs.set("series_ticker", params.series_ticker);
    if (params?.status) qs.set("status", params.status);
    if (params?.with_nested_markets) qs.set("with_nested_markets", "true");
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);

    const query = qs.toString();
    return this.request<GetEventsResponse>("GET", `/events${query ? `?${query}` : ""}`);
  }

  /**
   * Paginate through all events matching filters.
   */
  async getAllEvents(params?: {
    series_ticker?: string;
    status?: "unopened" | "open" | "closed" | "settled";
    with_nested_markets?: boolean;
  }): Promise<KalshiEvent[]> {
    const all: KalshiEvent[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.getEvents({
        ...params,
        limit: 200,
        cursor,
      });
      all.push(...res.events);
      cursor = res.cursor || undefined;
    } while (cursor);

    return all;
  }

  /**
   * List markets, optionally filtered by event or series.
   */
  async getMarkets(params?: {
    event_ticker?: string;
    series_ticker?: string;
    tickers?: string;
    status?: "unopened" | "open" | "closed" | "settled";
    limit?: number;
    cursor?: string;
  }): Promise<GetMarketsResponse> {
    const qs = new URLSearchParams();
    if (params?.event_ticker) qs.set("event_ticker", params.event_ticker);
    if (params?.series_ticker) qs.set("series_ticker", params.series_ticker);
    if (params?.status) qs.set("status", params.status);
    if (params?.tickers) qs.set("tickers", params.tickers);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);

    const query = qs.toString();
    return this.request<GetMarketsResponse>("GET", `/markets${query ? `?${query}` : ""}`);
  }

  /**
   * Get a single market by ticker. Uses the `tickers` filter on the public
   * markets endpoint — no auth required. Returns null if the market isn't
   * found (covers both 404s and empty `markets[]` responses).
   *
   * This is the hook the paper-trader uses to keep "current price" honest in
   * LIVE mode. Prefer the midpoint of (yes_bid, yes_ask); fall back to
   * last_price when the book is one-sided. See paper-trader.ts:refreshPrices.
   */
  async getMarket(ticker: string): Promise<KalshiMarket | null> {
    const res = await this.request<GetMarketsResponse>(
      "GET",
      `/markets?tickers=${encodeURIComponent(ticker)}`,
    );
    return res.markets?.[0] ?? null;
  }

  /**
   * Get a single market's order book.
   * Note: requires auth on Kalshi.
   */
  async getOrderBook(ticker: string, depth?: number): Promise<KalshiOrderBook> {
    const qs = depth ? `?depth=${depth}` : "";
    return this.request<KalshiOrderBook>("GET", `/markets/${ticker}/orderbook${qs}`, undefined, true);
  }

  // ─── Authenticated: Orders ────────────────────────────────────────

  /**
   * Place an order.
   */
  async createOrder(order: CreateOrderRequest): Promise<CreateOrderResponse> {
    return this.request<CreateOrderResponse>("POST", "/portfolio/orders", order, true);
  }

  /**
   * Cancel an order.
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request<void>("DELETE", `/portfolio/orders/${orderId}`, undefined, true);
  }

  // ─── Authenticated: Portfolio ─────────────────────────────────────

  /**
   * Get account balance (in cents).
   */
  async getBalance(): Promise<KalshiBalance> {
    return this.request<KalshiBalance>("GET", "/portfolio/balance", undefined, true);
  }

  /**
   * Get current positions.
   */
  async getPositions(params?: {
    event_ticker?: string;
    ticker?: string;
    limit?: number;
    cursor?: string;
  }): Promise<GetPositionsResponse> {
    const qs = new URLSearchParams();
    if (params?.event_ticker) qs.set("event_ticker", params.event_ticker);
    if (params?.ticker) qs.set("ticker", params.ticker);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);

    const query = qs.toString();
    return this.request<GetPositionsResponse>(
      "GET",
      `/portfolio/positions${query ? `?${query}` : ""}`,
      undefined,
      true,
    );
  }

  // ─── Trades (for whale tracker) ──────────────────────────────────

  /**
   * List recent trades across one or all markets.
   * Used by the whale tracker in REST-polling mode.
   */
  async listTrades(params?: {
    ticker?: string;
    limit?: number;
    cursor?: string;
    min_ts?: number;
    max_ts?: number;
  }): Promise<GetTradesResponse> {
    const qs = new URLSearchParams();
    if (params?.ticker) qs.set("ticker", params.ticker);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.min_ts) qs.set("min_ts", String(params.min_ts));
    if (params?.max_ts) qs.set("max_ts", String(params.max_ts));

    const query = qs.toString();
    return this.request<GetTradesResponse>("GET", `/markets/trades${query ? `?${query}` : ""}`);
  }

  /**
   * Paginate through all trades matching filters.
   */
  async *paginateTrades(params?: {
    ticker?: string;
    limit?: number;
    min_ts?: number;
    max_ts?: number;
  }): AsyncGenerator<KalshiTrade> {
    let cursor: string | undefined;
    do {
      const res = await this.listTrades({ ...params, cursor });
      for (const t of res.trades) yield t;
      cursor = res.cursor || undefined;
    } while (cursor);
  }

  // ─── Utility ──────────────────────────────────────────────────────

  /**
   * Quick health check — fetch a small batch of events.
   */
  async ping(): Promise<boolean> {
    try {
      await this.getEvents({ limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
}
