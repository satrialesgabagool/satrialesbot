/**
 * Kalshi REST client.
 *
 * Covers the endpoints we need for the weather-ensemble and whale-tracker
 * strategies. All read endpoints work unauthenticated against the public
 * Kalshi API — signed headers are only attached when `accessKey` +
 * `privateKeyPem` are supplied in config.
 *
 * All prices returned/accepted are in CENTS (1..99).
 */

import { fetchWithRetry } from "../../net/fetchWithRetry";
import { signRequest } from "./auth";
import {
  KALSHI_ENDPOINTS,
  type KalshiClientConfig,
  type KalshiEvent,
  type KalshiMarket,
  type KalshiOrderbook,
  type KalshiTrade,
  type KalshiPaginatedResponse,
} from "./types";

export class KalshiClient {
  readonly baseUrl: string;
  readonly wsUrl: string;
  private readonly accessKey?: string;
  private readonly privateKeyPem?: string;

  constructor(private readonly config: KalshiClientConfig) {
    const endpoint = KALSHI_ENDPOINTS[config.env];
    this.baseUrl = config.baseUrlOverride ?? endpoint.base;
    this.wsUrl = config.wsUrlOverride ?? endpoint.ws;
    this.accessKey = config.accessKey;
    this.privateKeyPem = config.privateKeyPem;
  }

  get isAuthenticated(): boolean {
    return !!(this.accessKey && this.privateKeyPem);
  }

  // ─── Core request plumbing ─────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<T> {
    const search = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";

    const pathWithPrefix = new URL(this.baseUrl + path).pathname + search;
    const signed = signRequest(method, new URL(this.baseUrl + path).pathname, this.accessKey, this.privateKeyPem);

    const res = await fetchWithRetry(this.baseUrl + path + search, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...signed,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    return (await res.json()) as T;
  }

  // ─── Events ────────────────────────────────────────────────────────

  /**
   * List events (paginated). Use `seriesTicker` to scope to e.g.
   * "KXHIGHNY" for NYC high-temp events.
   */
  async listEvents(opts: {
    seriesTicker?: string;
    status?: "open" | "closed" | "settled";
    cursor?: string;
    limit?: number;
    withNestedMarkets?: boolean;
  } = {}): Promise<KalshiPaginatedResponse<KalshiEvent>> {
    return this.request<KalshiPaginatedResponse<KalshiEvent>>("GET", "/events", {
      series_ticker: opts.seriesTicker,
      status: opts.status,
      cursor: opts.cursor,
      limit: opts.limit,
      with_nested_markets: opts.withNestedMarkets,
    });
  }

  async getEvent(eventTicker: string, withNestedMarkets = true): Promise<{ event: KalshiEvent; markets?: KalshiMarket[] }> {
    return this.request("GET", `/events/${encodeURIComponent(eventTicker)}`, {
      with_nested_markets: withNestedMarkets,
    });
  }

  // ─── Markets ───────────────────────────────────────────────────────

  async listMarkets(opts: {
    eventTicker?: string;
    seriesTicker?: string;
    status?: "initialized" | "active" | "closed" | "determined" | "settled";
    tickers?: string[];
    cursor?: string;
    limit?: number;
    minCloseTs?: number;
    maxCloseTs?: number;
  } = {}): Promise<KalshiPaginatedResponse<KalshiMarket>> {
    return this.request<KalshiPaginatedResponse<KalshiMarket>>("GET", "/markets", {
      event_ticker: opts.eventTicker,
      series_ticker: opts.seriesTicker,
      status: opts.status,
      tickers: opts.tickers?.join(","),
      cursor: opts.cursor,
      limit: opts.limit,
      min_close_ts: opts.minCloseTs,
      max_close_ts: opts.maxCloseTs,
    });
  }

  async getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    return this.request("GET", `/markets/${encodeURIComponent(ticker)}`);
  }

  async getOrderbook(ticker: string, depth = 10): Promise<{ orderbook: KalshiOrderbook }> {
    return this.request("GET", `/markets/${encodeURIComponent(ticker)}/orderbook`, {
      depth,
    });
  }

  // ─── Trades ────────────────────────────────────────────────────────

  /**
   * List recent trades across one or all markets. Used by the whale
   * tracker in REST-polling mode.
   */
  async listTrades(opts: {
    ticker?: string;
    cursor?: string;
    limit?: number;
    minTs?: number;
    maxTs?: number;
  } = {}): Promise<KalshiPaginatedResponse<KalshiTrade>> {
    return this.request<KalshiPaginatedResponse<KalshiTrade>>("GET", "/markets/trades", {
      ticker: opts.ticker,
      cursor: opts.cursor,
      limit: opts.limit,
      min_ts: opts.minTs,
      max_ts: opts.maxTs,
    });
  }

  // ─── Paginated helpers ────────────────────────────────────────────

  async *paginateEvents(
    opts: Omit<Parameters<KalshiClient["listEvents"]>[0], "cursor"> = {},
  ): AsyncGenerator<KalshiEvent> {
    let cursor: string | undefined = undefined;
    while (true) {
      const page = await this.listEvents({ ...opts, cursor });
      for (const ev of page.events ?? []) yield ev;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  async *paginateMarkets(
    opts: Omit<Parameters<KalshiClient["listMarkets"]>[0], "cursor"> = {},
  ): AsyncGenerator<KalshiMarket> {
    let cursor: string | undefined = undefined;
    while (true) {
      const page = await this.listMarkets({ ...opts, cursor });
      for (const m of page.markets ?? []) yield m;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  async *paginateTrades(
    opts: Omit<Parameters<KalshiClient["listTrades"]>[0], "cursor"> = {},
  ): AsyncGenerator<KalshiTrade> {
    let cursor: string | undefined = undefined;
    while (true) {
      const page = await this.listTrades({ ...opts, cursor });
      for (const t of page.trades ?? []) yield t;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }
}
