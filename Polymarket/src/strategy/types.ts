import type { OrderBook, BookSide } from "../market/OrderBook";
import type { TickerTracker } from "../market/TickerTracker";
import type { ISignalSnapshot } from "../signals/SignalSnapshot";
import type { SignalEvent } from "../signals/types";
import type { TrackedOrder } from "../engine/types";

export interface OrderRequest {
  tokenId: string;
  action: "buy" | "sell";
  price: number;
  shares: number;
  orderType?: "GTC" | "FOK"; // default GTC
  expireAtMs: number;
  onFilled?: (filledShares: number) => void;
  onExpired?: () => void;
  onFailed?: (reason: string) => void;
}

/**
 * The strategy context — the sole interface between a strategy and the engine.
 */
export interface StrategyContext {
  // --- Market Info (read-only) ---
  readonly slug: string;
  readonly tokenIdUp: string;
  readonly tokenIdDown: string;
  readonly slotStartMs: number;
  readonly slotEndMs: number;

  // --- Live Data ---
  readonly orderBook: OrderBook;
  readonly ticker: TickerTracker;
  readonly signals: ISignalSnapshot;

  // --- Order State ---
  readonly pendingOrders: ReadonlyArray<TrackedOrder>;
  readonly orderHistory: ReadonlyArray<{ action: "buy" | "sell"; price: number; shares: number }>;

  // --- Actions ---
  postOrders(orders: OrderRequest[]): void;
  cancelOrders(orderIds: string[]): Promise<{ canceled: string[]; notCanceled: Record<string, string> }>;
  emergencySells(orderIds: string[]): Promise<void>;
  getOrderById(orderId: string): Promise<TrackedOrder | undefined>;

  // --- Guards ---
  blockBuys(): void;
  blockSells(): void;

  // --- Lifecycle ---
  hold(): () => void; // returns release function
  log(msg: string, color?: "green" | "yellow" | "red" | "cyan" | "dim"): void;

  // --- Market Data ---
  getMarketResult(): { openPrice?: number; closePrice?: number } | undefined;
}

/**
 * A strategy is a single async function that receives the context,
 * sets up orders and callbacks, and optionally returns a cleanup function.
 */
export type Strategy = (ctx: StrategyContext) => Promise<(() => void) | void>;
