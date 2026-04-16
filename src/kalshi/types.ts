/**
 * Kalshi API type definitions.
 *
 * Based on https://docs.kalshi.com/openapi.yaml
 * Prices are FixedPointDollars strings (e.g. "0.5600")
 * Counts are FixedPointCount strings (e.g. "10.00")
 * Balance values are in CENTS (divide by 100 for dollars)
 */

// ─── Events ─────────────────────────────────────────────────────────

export interface KalshiEvent {
  event_ticker: string;       // e.g. "KXHIGHNY-26APR15"
  series_ticker: string;      // e.g. "KXHIGHNY"
  title: string;              // e.g. "Highest temperature in NYC on April 15?"
  sub_title: string;
  collateral_return_type: string;
  mutually_exclusive: boolean;
  strike_date?: string;       // ISO datetime
  strike_period?: string;
  markets?: KalshiMarket[];   // only if with_nested_markets=true
  available_on_brokers: boolean;
  product_metadata?: Record<string, unknown>;
  last_updated_ts?: string;
}

export interface GetEventsResponse {
  events: KalshiEvent[];
  cursor: string;
}

// ─── Markets ────────────────────────────────────────────────────────

export type MarketStatus =
  | "initialized" | "inactive" | "active" | "closed"
  | "determined" | "disputed" | "amended" | "finalized";

export interface KalshiMarket {
  ticker: string;                   // e.g. "KXHIGHNY-26APR15-T52"
  event_ticker: string;
  market_type: "binary" | "scalar";
  yes_sub_title: string;            // e.g. "52°F or below"
  no_sub_title: string;
  created_time: string;
  updated_time: string;
  open_time: string;
  close_time: string;
  latest_expiration_time: string;
  settlement_timer_seconds: number;
  status: MarketStatus;
  notional_value_dollars: string;   // "1.0000" for binary
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  yes_bid_size_fp: string;
  yes_ask_size_fp: string;
  last_price_dollars: string;
  previous_yes_bid_dollars: string;
  previous_yes_ask_dollars: string;
  previous_price_dollars: string;
  volume_fp: string;
  volume_24h_fp: string;
  open_interest_fp: string;
  result: "yes" | "no" | "scalar" | "";
  can_close_early: boolean;
  fractional_trading_enabled: boolean;
  expiration_value: string;
  rules_primary: string;
  rules_secondary: string;
  // Temperature-specific fields
  floor_strike?: number;            // lower bound of bracket (e.g. 80)
  cap_strike?: number;              // upper bound of bracket (e.g. 81)
  strike_type?: StrikeType;
  // Fees
  fee_waiver_expiration_time?: string;
  expected_expiration_time?: string;
  settlement_value_dollars?: string;
  settlement_ts?: string;
}

export type StrikeType =
  | "greater" | "greater_or_equal"
  | "less" | "less_or_equal"
  | "between" | "functional"
  | "custom" | "structured";

export interface GetMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

// ─── Order Book ─────────────────────────────────────────────────────

export interface KalshiOrderBook {
  orderbook_fp: {
    yes_dollars: [string, string][];  // [price_dollars, count_fp]
    no_dollars: [string, string][];
  };
}

// ─── Orders ─────────────────────────────────────────────────────────

export interface CreateOrderRequest {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count?: number;
  count_fp?: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  client_order_id?: string;
  expiration_ts?: number;
  time_in_force?: "fill_or_kill" | "good_till_canceled" | "immediate_or_cancel";
  buy_max_cost?: number;
  post_only?: boolean;
  reduce_only?: boolean;
}

export interface KalshiOrder {
  order_id: string;
  user_id: string;
  client_order_id: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  status: "resting" | "canceled" | "executed";
  yes_price_dollars: string;
  no_price_dollars: string;
  fill_count_fp: string;
  remaining_count_fp: string;
  initial_count_fp: string;
  taker_fees_dollars: string;
  maker_fees_dollars: string;
  taker_fill_cost_dollars: string;
  maker_fill_cost_dollars: string;
  expiration_time?: string;
  created_time?: string;
  last_update_time?: string;
}

export interface CreateOrderResponse {
  order: KalshiOrder;
}

// ─── Portfolio ──────────────────────────────────────────────────────

export interface KalshiBalance {
  balance: number;            // cents
  portfolio_value: number;    // cents
  updated_ts: number;
}

export interface KalshiMarketPosition {
  ticker: string;
  total_traded_dollars: string;
  position_fp: string;              // negative = NO, positive = YES
  market_exposure_dollars: string;
  realized_pnl_dollars: string;
  resting_orders_count: number;
  fees_paid_dollars: string;
  last_updated_ts: string;
}

export interface KalshiEventPosition {
  event_ticker: string;
  total_cost_dollars: string;
  total_cost_shares_fp: string;
  event_exposure_dollars: string;
  realized_pnl_dollars: string;
  fees_paid_dollars: string;
}

export interface GetPositionsResponse {
  cursor?: string;
  market_positions: KalshiMarketPosition[];
  event_positions: KalshiEventPosition[];
}

// ─── Trades ────────────────────────────────────────────────────────

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  count: number;              // contracts
  yes_price: number;          // cents
  no_price: number;           // cents
  taker_side: "yes" | "no";   // which side hit the book
  created_time: string;       // ISO8601
}

export interface GetTradesResponse {
  trades: KalshiTrade[];
  cursor: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Parse FixedPointDollars string to number */
export function parseDollars(s: string): number {
  return parseFloat(s) || 0;
}

/** Parse FixedPointCount string to number */
export function parseCount(s: string): number {
  return parseFloat(s) || 0;
}

/** Format number as FixedPointDollars string */
export function toDollars(n: number): string {
  return n.toFixed(4);
}

/** Format number as FixedPointCount string */
export function toCount(n: number): string {
  return n.toFixed(2);
}
