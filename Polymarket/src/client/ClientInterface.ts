export interface OrderPlacement {
  tokenId: string;
  action: "buy" | "sell";
  price: number;
  shares: number;
  orderType: "GTC" | "FOK";
}

export interface PlacementResult {
  orderId: string;
  accepted: boolean;
  reason?: string;
  /** For FOK orders that fill immediately during placement. */
  filledImmediately?: boolean;
  filledShares?: number;
}

export interface CancelResult {
  canceled: string[];
  notCanceled: Record<string, string>; // orderId -> reason
}

export interface OrderStatus {
  orderId: string;
  status: "open" | "filled" | "canceled";
  filledShares: number;
  originalShares: number;
}

/**
 * Abstract client interface for trading operations.
 * Implemented by SimClient (paper) and PolymarketClient (real).
 */
export interface ClientInterface {
  /** Place one or more orders. Returns placement results. */
  placeOrders(orders: OrderPlacement[]): Promise<PlacementResult[]>;

  /** Cancel orders by ID. */
  cancelOrders(orderIds: string[]): Promise<CancelResult>;

  /** Check the status of an order. */
  getOrderStatus(orderId: string): Promise<OrderStatus | null>;

  /** Get available USDC balance. */
  getBalance(): Promise<number>;

  /** Get available shares for a token. */
  getShares(tokenId: string): Promise<number>;
}
