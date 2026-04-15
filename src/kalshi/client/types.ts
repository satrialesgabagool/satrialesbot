/**
 * Kalshi Trade API v2 types.
 *
 * Reference: https://trading-api.readme.io/reference/ (Kalshi docs)
 *
 * Pricing is in CENTS (integers 1–99). A YES contract at `yes_price=63`
 * means the market thinks 63% probability. A filled contract costs
 * `yes_price` cents (≈ $0.63) and pays $1.00 if YES resolves true.
 *
 * Event → Market hierarchy:
 *   An "event" (e.g. KXHIGHNY-25APR15) groups mutually-exclusive
 *   "markets" (e.g. KXHIGHNY-25APR15-T71.5 = "high ≤ 71.5°F").
 *   Each market is an independent YES/NO binary.
 */

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  sub_title?: string;
  title: string;
  mutually_exclusive?: boolean;
  category?: string;
  markets?: KalshiMarket[];
  strike_date?: string;
  strike_period?: string;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;           // "binary" | "scalar" | ...
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  open_time: string;
  close_time: string;
  expiration_time?: string;
  status: "initialized" | "active" | "closed" | "determined" | "settled";
  yes_bid: number;               // cents
  yes_ask: number;               // cents
  no_bid: number;                // cents
  no_ask: number;                // cents
  last_price: number;            // cents
  previous_yes_bid?: number;
  previous_yes_ask?: number;
  previous_price?: number;
  volume: number;                // contracts traded today
  volume_24h: number;
  open_interest: number;
  liquidity: number;             // cents × contracts available
  result?: "yes" | "no" | "";
  can_close_early?: boolean;
  expiration_value?: string;
  category?: string;
  risk_limit_cents?: number;
  strike_type?: string;          // "between" | "greater" | "less" | "structured" | ...
  floor_strike?: number;
  cap_strike?: number;
  custom_strike?: Record<string, unknown>;
  rules_primary?: string;
  rules_secondary?: string;
  response_price_units?: string;
  notional_value?: number;
}

export interface KalshiOrderbookSide {
  price: number;
  quantity: number;
}

export interface KalshiOrderbook {
  yes: [number, number][];  // [price_cents, quantity][]
  no: [number, number][];
}

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  count: number;                 // contracts
  yes_price: number;             // cents
  no_price: number;              // cents
  taker_side: "yes" | "no";      // which side hit the book
  created_time: string;          // ISO8601
}

export interface KalshiPaginatedResponse<T> {
  cursor: string;
  /* one of these keys will be populated depending on the endpoint */
  events?: T[];
  markets?: T[];
  trades?: T[];
}

// ─── Config ──────────────────────────────────────────────────────────

export interface KalshiClientConfig {
  /** "demo" or "prod" — picks base URL & WS URL */
  env: "demo" | "prod";
  /** API access key ID from Kalshi dashboard. Not required for public read endpoints. */
  accessKey?: string;
  /** PEM-encoded RSA private key matching the access key's public half. */
  privateKeyPem?: string;
  /** Override base URL (testing). */
  baseUrlOverride?: string;
  /** Override WS URL (testing). */
  wsUrlOverride?: string;
}

export const KALSHI_ENDPOINTS = {
  demo: {
    base: "https://demo-api.kalshi.co/trade-api/v2",
    ws: "wss://demo-api.kalshi.co/trade-api/ws/v2",
  },
  prod: {
    base: "https://api.elections.kalshi.com/trade-api/v2",
    ws: "wss://api.elections.kalshi.com/trade-api/ws/v2",
  },
} as const;
