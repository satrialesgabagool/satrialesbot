import type {
  ClientInterface,
  OrderPlacement,
  PlacementResult,
  CancelResult,
  OrderStatus,
} from "./ClientInterface";
import type { OrderBook } from "../market/OrderBook";
import { SimWallet } from "../wallet/SimWallet";

interface SimOrder {
  orderId: string;
  placement: OrderPlacement;
  status: "open" | "filled" | "canceled";
  filledShares: number;
  placedAtMs: number;
}

let orderCounter = 0;
function nextOrderId(): string {
  return `sim-${++orderCounter}-${Date.now()}`;
}

// Simulated latency range (ms)
const MIN_LATENCY = 50;
const MAX_LATENCY = 200;

/**
 * Paper trading client that simulates order fills against the real order book.
 * No actual orders are placed on Polymarket.
 */
export class SimClient implements ClientInterface {
  private orderBook: OrderBook;
  private wallet: SimWallet;
  private orders: Map<string, SimOrder> = new Map();
  private tokenIds: [string, string]; // [UP, DOWN]

  constructor(orderBook: OrderBook, wallet: SimWallet, tokenIdUp: string, tokenIdDown: string) {
    this.orderBook = orderBook;
    this.wallet = wallet;
    this.tokenIds = [tokenIdUp, tokenIdDown];
  }

  async placeOrders(placements: OrderPlacement[]): Promise<PlacementResult[]> {
    // Simulate network latency
    await this.simulateLatency();

    const results: PlacementResult[] = [];

    for (const placement of placements) {
      const result = this.placeSingle(placement);
      results.push(result);
    }

    return results;
  }

  async cancelOrders(orderIds: string[]): Promise<CancelResult> {
    await this.simulateLatency();

    const canceled: string[] = [];
    const notCanceled: Record<string, string> = {};

    for (const id of orderIds) {
      const order = this.orders.get(id);
      if (!order) {
        notCanceled[id] = "Order not found";
        continue;
      }
      if (order.status !== "open") {
        notCanceled[id] = `Order is ${order.status}`;
        continue;
      }

      order.status = "canceled";

      // Release reservations
      if (order.placement.action === "buy") {
        this.wallet.releaseBalance(order.placement.price * order.placement.shares);
      } else {
        this.wallet.releaseShares(order.placement.tokenId, order.placement.shares);
      }

      canceled.push(id);
    }

    return { canceled, notCanceled };
  }

  async getOrderStatus(orderId: string): Promise<OrderStatus | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;

    return {
      orderId: order.orderId,
      status: order.status,
      filledShares: order.filledShares,
      originalShares: order.placement.shares,
    };
  }

  async getBalance(): Promise<number> {
    return this.wallet.availableBalance;
  }

  async getShares(tokenId: string): Promise<number> {
    return this.wallet.getAvailableShares(tokenId);
  }

  /** Get the wallet for direct access (used by engine for PnL). */
  getWallet(): SimWallet {
    return this.wallet;
  }

  /**
   * Tick: check all open orders against current book state.
   * Called every engine tick (~100ms).
   * Returns list of order IDs that were filled this tick.
   */
  tick(): string[] {
    const filled: string[] = [];

    for (const order of this.orders.values()) {
      if (order.status !== "open") continue;

      if (this.checkFill(order)) {
        filled.push(order.orderId);
      }
    }

    return filled;
  }

  /** Get all open orders. */
  getOpenOrders(): SimOrder[] {
    return Array.from(this.orders.values()).filter((o) => o.status === "open");
  }

  private placeSingle(placement: OrderPlacement): PlacementResult {
    const orderId = nextOrderId();

    // Validate balance/shares
    if (placement.action === "buy") {
      const cost = placement.price * placement.shares;
      if (!this.wallet.reserveBalance(cost)) {
        return { orderId, accepted: false, reason: "Insufficient balance" };
      }
    } else {
      if (!this.wallet.reserveShares(placement.tokenId, placement.shares)) {
        return { orderId, accepted: false, reason: "Insufficient shares" };
      }
    }

    const simOrder: SimOrder = {
      orderId,
      placement,
      status: "open",
      filledShares: 0,
      placedAtMs: Date.now(),
    };

    this.orders.set(orderId, simOrder);

    // FOK: must fill immediately or fail
    if (placement.orderType === "FOK") {
      if (this.checkFill(simOrder)) {
        return { orderId, accepted: true, filledImmediately: true, filledShares: simOrder.filledShares };
      } else {
        // FOK rejected
        simOrder.status = "canceled";
        if (placement.action === "buy") {
          this.wallet.releaseBalance(placement.price * placement.shares);
        } else {
          this.wallet.releaseShares(placement.tokenId, placement.shares);
        }
        return {
          orderId,
          accepted: false,
          reason: "FOK order could not be fully filled",
        };
      }
    }

    return { orderId, accepted: true };
  }

  /**
   * Check if an order can fill against the current book.
   * Returns true if the order was filled.
   */
  private checkFill(order: SimOrder): boolean {
    const { placement } = order;
    const side = this.getSide(placement.tokenId);
    if (!side) return false;

    if (placement.action === "buy") {
      // Buy fills when best ask <= our price
      const bestAsk = this.orderBook.bestAskInfo(side);
      if (!bestAsk || bestAsk.price > placement.price) return false;

      // Check liquidity
      const availableShares = this.orderBook.askLiquidityUpTo(side, placement.price);
      const fillShares = Math.min(placement.shares, availableShares);
      if (fillShares <= 0) return false;

      // FOK requires full fill
      if (placement.orderType === "FOK" && fillShares < placement.shares) return false;

      // Execute fill
      order.filledShares = fillShares;
      order.status = "filled";

      const cost = bestAsk.price * fillShares; // Fill at best ask, not our limit
      this.wallet.debit(cost);
      this.wallet.addShares(placement.tokenId, fillShares);

      return true;
    } else {
      // Sell fills when best bid >= our price
      const bestBid = this.orderBook.bestBidInfo(side);
      if (!bestBid || bestBid.price < placement.price) return false;

      const fillShares = Math.min(placement.shares, bestBid.size);
      if (fillShares <= 0) return false;

      if (placement.orderType === "FOK" && fillShares < placement.shares) return false;

      order.filledShares = fillShares;
      order.status = "filled";

      const proceeds = bestBid.price * fillShares;
      this.wallet.removeShares(placement.tokenId, fillShares);
      this.wallet.credit(proceeds);

      return true;
    }
  }

  private getSide(tokenId: string): "UP" | "DOWN" | null {
    if (tokenId === this.tokenIds[0]) return "UP";
    if (tokenId === this.tokenIds[1]) return "DOWN";
    return null;
  }

  private simulateLatency(): Promise<void> {
    const ms = MIN_LATENCY + Math.random() * (MAX_LATENCY - MIN_LATENCY);
    return new Promise((r) => setTimeout(r, ms));
  }
}
