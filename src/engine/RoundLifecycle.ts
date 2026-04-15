import {
  RoundPhase,
  type TrackedOrder,
  type OrderHistoryEntry,
  type RoundResult,
} from "./types";
import type { Strategy, StrategyContext, OrderRequest } from "../strategy/types";
import type { OrderBook, BookSide } from "../market/OrderBook";
import type { TickerTracker } from "../market/TickerTracker";
import type { ISignalSnapshot } from "../signals/SignalSnapshot";
import type { SimClient } from "../client/SimClient";
import type { Logger } from "../log/Logger";

export interface RoundConfig {
  slug: string;
  tokenIdUp: string;
  tokenIdDown: string;
  slotStartMs: number;
  slotEndMs: number;
  strategy: Strategy;
  orderBook: OrderBook;
  ticker: TickerTracker;
  signals: ISignalSnapshot;
  client: SimClient;
  logger: Logger;
}

export class RoundLifecycle {
  private config: RoundConfig;
  private phase: RoundPhase = RoundPhase.INIT;
  private pendingOrders: TrackedOrder[] = [];
  private orderHistory: OrderHistoryEntry[] = [];
  private callbacks = new Map<
    string,
    { onFilled?: (s: number) => void; onExpired?: () => void; onFailed?: (r: string) => void }
  >();
  private strategyCleanup: (() => void) | null = null;
  private strategyLocks = 0;
  private buysBlocked = false;
  private sellsBlocked = false;
  private ticking = false;
  private openPrice?: number;
  private closePrice?: number;
  private done = false;
  private result: RoundResult | null = null;

  constructor(config: RoundConfig) {
    this.config = config;
  }

  get slug(): string {
    return this.config.slug;
  }

  get currentPhase(): RoundPhase {
    return this.phase;
  }

  get isDone(): boolean {
    return this.done;
  }

  get roundResult(): RoundResult | null {
    return this.result;
  }

  /** Run one engine tick. Called every ~100ms by Engine. */
  async tick(): Promise<void> {
    if (this.ticking || this.done) return;
    this.ticking = true;

    try {
      switch (this.phase) {
        case RoundPhase.INIT:
          await this.tickInit();
          break;
        case RoundPhase.RUNNING:
          this.tickRunning();
          break;
        case RoundPhase.STOPPING:
          await this.tickStopping();
          break;
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Force shutdown from engine. */
  shutdown(): void {
    if (this.phase === RoundPhase.RUNNING) {
      this.phase = RoundPhase.STOPPING;
    }
  }

  // ---- Phase handlers ----

  private async tickInit(): Promise<void> {
    const { logger, orderBook, strategy } = this.config;

    if (!orderBook.isReady) return;

    logger.startRound(this.config.slug);
    logger.record("slot_start", {
      slug: this.config.slug,
      slotStart: this.config.slotStartMs,
      slotEnd: this.config.slotEndMs,
    });

    // Build the strategy context
    const ctx = this.buildContext();

    // Run the strategy function
    try {
      const cleanup = await strategy(ctx);
      if (typeof cleanup === "function") {
        this.strategyCleanup = cleanup;
      }
    } catch (error) {
      logger.error(`Strategy error: ${error}`);
    }

    this.phase = RoundPhase.RUNNING;
    logger.log(`[${this.config.slug}] RUNNING`, "green");
  }

  private tickRunning(): void {
    const now = Date.now();
    const { client, logger } = this.config;

    // Check sim client for fills
    const filledIds = client.tick();
    for (const orderId of filledIds) {
      this.handleFill(orderId);
    }

    // Check order expirations
    for (const order of this.pendingOrders) {
      if (order.status === "pending" || order.status === "open") {
        if (now >= order.expireAtMs) {
          this.handleExpire(order);
        }
      }
    }

    // Log order book snapshot every ~1 second
    if (now % 1000 < 110) {
      logger.record("orderbook_snapshot", this.config.orderBook.snapshot() as unknown as Record<string, unknown>);
      const tickerSummary = this.config.ticker.summary();
      logger.record("btc_ticker", tickerSummary);
    }

    // Transition to STOPPING
    if (now >= this.config.slotEndMs) {
      this.phase = RoundPhase.STOPPING;
      return;
    }

    // Also stop if no pending orders, no in-flight, no locks
    const activePending = this.pendingOrders.filter(
      (o) => o.status === "pending" || o.status === "open",
    );
    if (activePending.length === 0 && this.strategyLocks === 0) {
      this.phase = RoundPhase.STOPPING;
    }
  }

  private async tickStopping(): Promise<void> {
    const { client, logger } = this.config;

    // Cancel remaining buy orders
    const buyOrderIds = this.pendingOrders
      .filter((o) => o.action === "buy" && (o.status === "pending" || o.status === "open"))
      .map((o) => o.orderId);

    if (buyOrderIds.length > 0) {
      await client.cancelOrders(buyOrderIds);
      for (const id of buyOrderIds) {
        const order = this.pendingOrders.find((o) => o.orderId === id);
        if (order) order.status = "canceled";
      }
    }

    // Check if sells are still pending
    const pendingSells = this.pendingOrders.filter(
      (o) => o.action === "sell" && (o.status === "pending" || o.status === "open"),
    );

    if (pendingSells.length > 0 && Date.now() < this.config.slotEndMs) {
      // Wait for sells to fill
      const filledIds = client.tick();
      for (const id of filledIds) this.handleFill(id);
      return;
    }

    // Cancel any remaining sells
    if (pendingSells.length > 0) {
      const sellIds = pendingSells.map((o) => o.orderId);
      await client.cancelOrders(sellIds);
      for (const order of pendingSells) {
        order.status = "canceled";
      }
    }

    // Compute PnL
    this.computeResult();
    this.phase = RoundPhase.DONE;
    this.done = true;

    // Cleanup
    this.strategyCleanup?.();
    logger.record("resolution", this.result as unknown as Record<string, unknown>);
    logger.endRound();
    logger.log(
      `[${this.config.slug}] DONE — PnL: $${this.result!.pnl.toFixed(2)}`,
      this.result!.pnl >= 0 ? "green" : "red",
    );
  }

  // ---- Context builder ----

  private buildContext(): StrategyContext {
    const self = this;
    const { slug, tokenIdUp, tokenIdDown, slotStartMs, slotEndMs, orderBook, ticker, signals, logger } =
      this.config;

    return {
      slug,
      tokenIdUp,
      tokenIdDown,
      slotStartMs,
      slotEndMs,
      orderBook,
      ticker,
      signals,
      pendingOrders: self.pendingOrders,
      orderHistory: self.orderHistory,

      postOrders(orders: OrderRequest[]): void {
        for (const req of orders) {
          if (req.action === "buy" && self.buysBlocked) continue;
          if (req.action === "sell" && self.sellsBlocked) continue;

          const tracked: TrackedOrder = {
            orderId: "",
            tokenId: req.tokenId,
            action: req.action,
            orderType: req.orderType ?? "GTC",
            price: req.price,
            shares: req.shares,
            filledShares: 0,
            expireAtMs: req.expireAtMs,
            status: "pending",
            placedAtMs: Date.now(),
          };

          // Store callbacks
          const cbKey = `${Date.now()}-${Math.random()}`;

          // Place via client (async, fire-and-forget)
          self.config.client
            .placeOrders([
              {
                tokenId: req.tokenId,
                action: req.action,
                price: req.price,
                shares: req.shares,
                orderType: req.orderType ?? "GTC",
              },
            ])
            .then((results) => {
              const result = results[0];
              if (result.accepted) {
                tracked.orderId = result.orderId;

                // FOK orders may have filled immediately during placement
                if (result.filledImmediately && result.filledShares) {
                  tracked.status = "filled";
                  tracked.filledShares = result.filledShares;
                  tracked.filledAtMs = Date.now();
                  self.orderHistory.push({
                    action: req.action,
                    price: req.price,
                    shares: result.filledShares,
                    filledAtMs: Date.now(),
                  });
                  self.config.logger.record("order_filled", {
                    orderId: result.orderId,
                    action: req.action,
                    price: req.price,
                    shares: result.filledShares,
                    immediate: true,
                  });
                  req.onFilled?.(result.filledShares);
                } else {
                  tracked.status = "open";
                  self.callbacks.set(result.orderId, {
                    onFilled: req.onFilled,
                    onExpired: req.onExpired,
                    onFailed: req.onFailed,
                  });
                }
              } else {
                tracked.status = "failed";
                req.onFailed?.(result.reason ?? "Placement rejected");
              }
            })
            .catch((err) => {
              tracked.status = "failed";
              req.onFailed?.(String(err));
            });

          self.pendingOrders.push(tracked);
        }
      },

      async cancelOrders(orderIds: string[]) {
        return self.config.client.cancelOrders(orderIds);
      },

      async emergencySells(orderIds: string[]) {
        // Cancel existing sells, re-place at best bid as FOK
        await self.config.client.cancelOrders(orderIds);

        for (const id of orderIds) {
          const order = self.pendingOrders.find((o) => o.orderId === id);
          if (!order) continue;

          order.status = "canceled";
          const side: BookSide = order.tokenId === tokenIdUp ? "UP" : "DOWN";
          const bestBid = orderBook.bestBidPrice(side);
          if (!bestBid) continue;

          // Re-place as FOK at best bid
          self.config.client
            .placeOrders([
              {
                tokenId: order.tokenId,
                action: "sell",
                price: bestBid,
                shares: order.shares,
                orderType: "FOK",
              },
            ])
            .then((results) => {
              if (results[0].accepted) {
                const newTracked: TrackedOrder = {
                  orderId: results[0].orderId,
                  tokenId: order.tokenId,
                  action: "sell",
                  orderType: "FOK",
                  price: bestBid,
                  shares: order.shares,
                  filledShares: 0,
                  expireAtMs: slotEndMs,
                  status: "open",
                  placedAtMs: Date.now(),
                };
                self.pendingOrders.push(newTracked);
              }
            });
        }
      },

      async getOrderById(orderId: string) {
        return self.pendingOrders.find((o) => o.orderId === orderId);
      },

      blockBuys() {
        self.buysBlocked = true;
      },

      blockSells() {
        self.sellsBlocked = true;
      },

      hold() {
        self.strategyLocks++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            self.strategyLocks = Math.max(0, self.strategyLocks - 1);
          }
        };
      },

      log(msg: string, color?: "green" | "yellow" | "red" | "cyan" | "dim") {
        logger.log(`[${slug}] ${msg}`, color);
        logger.record("info", { message: msg });
      },

      getMarketResult() {
        return {
          openPrice: self.openPrice,
          closePrice: self.closePrice,
        };
      },
    };
  }

  // ---- Order event handlers ----

  private handleFill(orderId: string): void {
    const order = this.pendingOrders.find((o) => o.orderId === orderId);
    if (!order) return;

    // Get fill info from client
    this.config.client.getOrderStatus(orderId).then((status) => {
      if (!status) return;
      order.filledShares = status.filledShares;
      order.status = "filled";
      order.filledAtMs = Date.now();

      this.orderHistory.push({
        action: order.action,
        price: order.price,
        shares: order.filledShares,
        filledAtMs: Date.now(),
      });

      this.config.logger.record("order_filled", {
        orderId,
        action: order.action,
        price: order.price,
        shares: order.filledShares,
      });

      // Fire callback
      this.callbacks.get(orderId)?.onFilled?.(order.filledShares);
      this.callbacks.delete(orderId);
    });
  }

  private handleExpire(order: TrackedOrder): void {
    // Cancel via client
    this.config.client.cancelOrders([order.orderId]).then(() => {
      order.status = "expired";

      this.config.logger.record("order_expired", {
        orderId: order.orderId,
        action: order.action,
        price: order.price,
      });

      this.callbacks.get(order.orderId)?.onExpired?.();
      this.callbacks.delete(order.orderId);
    });
  }

  // ---- PnL ----

  private computeResult(): void {
    let pnl = 0;
    let orderCount = 0;

    // Sum up order-based PnL
    for (const entry of this.orderHistory) {
      if (entry.action === "buy") {
        pnl -= entry.price * entry.shares;
      } else {
        pnl += entry.price * entry.shares;
      }
      orderCount++;
    }

    // Resolve any remaining shares
    const wallet = this.config.client.getWallet();
    const upShares = wallet.getShares(this.config.tokenIdUp);
    const downShares = wallet.getShares(this.config.tokenIdDown);

    // Determine winner (would need actual market resolution)
    // For simulation, we check the BTC price vs open price
    const btcPrice = this.config.ticker.price;
    if (this.openPrice && btcPrice) {
      const upWon = btcPrice > this.openPrice;

      if (upShares > 0) {
        const payout = wallet.resolveShares(this.config.tokenIdUp, upWon);
        pnl += payout;
      }
      if (downShares > 0) {
        const payout = wallet.resolveShares(this.config.tokenIdDown, !upWon);
        pnl += payout;
      }

      this.result = {
        slug: this.config.slug,
        pnl,
        orderCount,
        resolution: upWon ? "UP" : "DOWN",
        openPrice: this.openPrice,
        closePrice: btcPrice,
      };
    } else {
      this.result = {
        slug: this.config.slug,
        pnl,
        orderCount,
      };
    }
  }
}
