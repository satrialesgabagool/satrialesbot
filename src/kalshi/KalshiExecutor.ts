/**
 * KalshiExecutor — wraps KalshiClient with safety rails for live trading.
 *
 * Responsibilities:
 *   1. Enforce hard caps (max deployed, max per-order, daily loss cap)
 *   2. Check kill switch before every order
 *   3. Place IOC limit buy orders and wait for fill
 *   4. Reconcile against Kalshi's actual portfolio
 *   5. Track daily PnL for loss cap enforcement
 *
 * This is the ONLY place in the codebase that places real orders.
 * All live trading paths MUST go through placeOrder().
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { KalshiClient } from "./KalshiClient";
import type { CreateOrderRequest, KalshiBalance } from "./types";
import { parseDollars, parseCount } from "./types";

export interface ExecutorConfig {
  /** Maximum total USD deployed across all open positions */
  maxDeployedUSD: number;
  /** Maximum USD spent on any single order */
  maxPerOrderUSD: number;
  /** Halt all trading if today's realized PnL goes below this (negative number) */
  dailyLossCapUSD: number;
  /** Path to kill switch file — if exists, no orders fire */
  killSwitchPath: string;
  /** Prompt user to confirm the first live order each run */
  confirmFirstOrder: boolean;
  /** How long to wait for an IOC order to fill (ms) */
  orderTimeoutMs: number;
  /** Set true for demo-api.kalshi.co, false for production */
  useDemo: boolean;
  /** Persist daily PnL tracker to this path */
  dailyTrackerPath: string;
}

export interface PlacementRequest {
  ticker: string;
  side: "yes" | "no";
  askPrice: number;   // price to pay per share (0-1)
  maxShares: number;  // how many to try to fill
  budget: number;     // max USD to spend
  clientOrderId?: string;
}

export interface PlacementResult {
  success: boolean;
  orderId?: string;
  filledShares: number;
  filledCostUSD: number;  // actual USD spent including the stake (pre-fee)
  avgPriceDollars: number;
  feePaidUSD: number;
  rejectReason?: string;
}

interface DailyTracker {
  date: string;           // YYYY-MM-DD
  realizedPnL: number;    // realized today in USD
  ordersPlaced: number;
  ordersFilled: number;
  firstOrderConfirmed: boolean;
}

export class KalshiExecutor {
  private client: KalshiClient;
  private config: ExecutorConfig;
  private log: (msg: string, color?: string) => void;

  constructor(client: KalshiClient, config: ExecutorConfig, log?: (msg: string, color?: string) => void) {
    this.client = client;
    this.config = config;
    this.log = log ?? ((msg) => console.log(msg));

    // Ensure tracker directory exists
    const dir = dirname(config.dailyTrackerPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // ─── Pre-order safety checks ────────────────────────────────────

  /** Kill switch: if the file exists, trading is halted. */
  killSwitchActive(): boolean {
    return existsSync(this.config.killSwitchPath);
  }

  private loadTracker(): DailyTracker {
    const today = new Date().toISOString().slice(0, 10);
    if (existsSync(this.config.dailyTrackerPath)) {
      try {
        const t = JSON.parse(readFileSync(this.config.dailyTrackerPath, "utf-8")) as DailyTracker;
        // Reset if it's a new day
        if (t.date !== today) {
          return { date: today, realizedPnL: 0, ordersPlaced: 0, ordersFilled: 0, firstOrderConfirmed: false };
        }
        return t;
      } catch {}
    }
    return { date: today, realizedPnL: 0, ordersPlaced: 0, ordersFilled: 0, firstOrderConfirmed: false };
  }

  private saveTracker(t: DailyTracker) {
    writeFileSync(this.config.dailyTrackerPath, JSON.stringify(t, null, 2));
  }

  recordRealizedPnL(delta: number) {
    const t = this.loadTracker();
    t.realizedPnL += delta;
    this.saveTracker(t);
  }

  /** Snapshot of current Kalshi portfolio state */
  async fetchPortfolioSnapshot(): Promise<{
    cashUSD: number;
    portfolioValueUSD: number;
    openPositionCount: number;
    totalDeployedUSD: number;
  }> {
    const balance = await this.client.getBalance();
    const cashUSD = (balance.balance ?? 0) / 100;
    const portfolioValueUSD = (balance.portfolio_value ?? 0) / 100;
    const { market_positions = [] } = await this.client.getPositions({ limit: 200 });
    const openPositions = market_positions.filter((p: any) => (p.position ?? 0) > 0);
    const totalDeployedUSD = openPositions.reduce((s: number, p: any) => {
      return s + parseDollars(p.market_exposure_dollars) || 0;
    }, 0);
    return {
      cashUSD,
      portfolioValueUSD,
      openPositionCount: openPositions.length,
      totalDeployedUSD,
    };
  }

  /** Run all safety checks before placing an order. Returns null if all pass. */
  async preFlightChecks(req: PlacementRequest): Promise<string | null> {
    // 1. Kill switch
    if (this.killSwitchActive()) {
      return `kill switch active (${this.config.killSwitchPath} exists)`;
    }

    // 2. Per-order USD cap
    if (req.budget > this.config.maxPerOrderUSD) {
      return `order budget $${req.budget.toFixed(2)} exceeds per-order cap $${this.config.maxPerOrderUSD.toFixed(2)}`;
    }

    // 3. Daily loss cap
    const tracker = this.loadTracker();
    if (tracker.realizedPnL <= this.config.dailyLossCapUSD) {
      return `daily loss cap hit: realized $${tracker.realizedPnL.toFixed(2)} ≤ cap $${this.config.dailyLossCapUSD.toFixed(2)}`;
    }

    // 4. Total deployed cap (check live Kalshi portfolio)
    try {
      const snap = await this.fetchPortfolioSnapshot();
      if (snap.totalDeployedUSD + req.budget > this.config.maxDeployedUSD) {
        return `total deployed $${snap.totalDeployedUSD.toFixed(2)} + order $${req.budget.toFixed(2)} would exceed cap $${this.config.maxDeployedUSD.toFixed(2)}`;
      }
    } catch (err: any) {
      return `failed to fetch portfolio for cap check: ${err?.message}`;
    }

    return null; // all checks passed
  }

  // ─── Order placement ────────────────────────────────────────────

  async placeOrder(req: PlacementRequest): Promise<PlacementResult> {
    const reject = (reason: string): PlacementResult => ({
      success: false,
      filledShares: 0,
      filledCostUSD: 0,
      avgPriceDollars: 0,
      feePaidUSD: 0,
      rejectReason: reason,
    });

    // Pre-flight safety
    const preFlightError = await this.preFlightChecks(req);
    if (preFlightError) {
      this.log(`  ✗ REJECT ${req.ticker}: ${preFlightError}`, "red");
      return reject(preFlightError);
    }

    // Fetch the live order book. We treat req.askPrice as our MAXIMUM acceptable
    // price; the actual order price uses the book's best ask (which may be lower
    // or higher than req.askPrice).
    let availableShares = 0;
    let bookBestAsk = 0;
    try {
      const book = await this.client.getOrderBook(req.ticker);
      // Kalshi book: orderbook_fp.yes_dollars = YES bids,
      //              orderbook_fp.no_dollars = NO bids (= YES asks at 1 − price).
      // To BUY YES we lift NO bids — each NO bid at $X represents a seller
      // willing to sell YES at $(1 − X).
      const levels = (book as any).orderbook_fp?.[req.side === "yes" ? "no_dollars" : "yes_dollars"];
      if (Array.isArray(levels) && levels.length > 0) {
        for (const [priceStr, countStr] of levels) {
          const impliedAskDollars = 1 - parseFloat(priceStr);
          const size = parseFloat(countStr);
          if (!isFinite(impliedAskDollars) || !isFinite(size) || size <= 0) continue;
          if (impliedAskDollars <= req.askPrice + 0.001) {
            availableShares += size;
            if (!bookBestAsk || impliedAskDollars < bookBestAsk) bookBestAsk = impliedAskDollars;
          }
        }
      }
    } catch (err: any) {
      this.log(`  orderbook fetch failed: ${err?.message} — proceeding with requested size`, "dim");
      availableShares = req.maxShares;
      bookBestAsk = req.askPrice;
    }

    if (availableShares === 0) {
      this.log(`  ✗ REJECT ${req.ticker}: no resting volume at or below $${req.askPrice.toFixed(2)} (book is higher or empty)`, "yellow");
      return reject(`no resting volume ≤ $${req.askPrice.toFixed(2)}`);
    }

    // Use book's actual best ask (or our max if fetch failed) as the order price.
    // This guarantees at least 1 share can match (the one at bookBestAsk).
    const effectiveOrderPrice = bookBestAsk || req.askPrice;

    // First-order confirmation gate
    const tracker = this.loadTracker();
    if (this.config.confirmFirstOrder && !tracker.firstOrderConfirmed) {
      this.log("", "");
      this.log("  ⚠️  FIRST LIVE ORDER OF THE DAY", "yellow");
      this.log(`     Ticker: ${req.ticker}`, "yellow");
      this.log(`     Side: ${req.side.toUpperCase()} @ $${req.askPrice.toFixed(3)}`, "yellow");
      this.log(`     Max spend: $${req.budget.toFixed(2)}`, "yellow");
      this.log(`     Env: ${this.config.useDemo ? "DEMO (fake money)" : "PRODUCTION (real money)"}`, "yellow");
      this.log("  Set KALSHI_CONFIRM_FIRST_ORDER=yes and retry to proceed.", "yellow");

      // Require explicit env var for the first order confirmation
      if (process.env.KALSHI_CONFIRM_FIRST_ORDER !== "yes") {
        return reject("first order not confirmed (set KALSHI_CONFIRM_FIRST_ORDER=yes)");
      }
      tracker.firstOrderConfirmed = true;
      this.saveTracker(tracker);
      this.log("  First order confirmed — proceeding.", "green");
    }

    // Size shares based on WORST-case price (our limit = req.askPrice) to ensure
    // buy_max_cost allows the order to fully match across book levels.
    const budgetShares = Math.floor(req.budget / req.askPrice);
    const requestedShares = Math.min(req.maxShares, budgetShares);
    const maxShares = Math.min(requestedShares, Math.floor(availableShares));
    if (maxShares < 1) {
      return reject(`budget/book mismatch (budget $${req.budget.toFixed(2)}, limit $${req.askPrice.toFixed(3)}, book has ${availableShares.toFixed(0)} shares ≤ limit)`);
    }
    this.log(`  book: ${availableShares.toFixed(0)} shares ≤ $${req.askPrice.toFixed(2)} (best ask $${effectiveOrderPrice.toFixed(3)}). Ordering ${maxShares} at limit $${req.askPrice.toFixed(3)}.`, "dim");

    // Sanitize client_order_id — Kalshi requires alphanumeric + hyphens, no dots.
    const tickerSafe = req.ticker.replace(/[^A-Za-z0-9-]/g, "");
    const clientOrderId = req.clientOrderId ?? `sat-${Date.now()}-${tickerSafe.slice(-10)}`;

    // Bid at the MAX acceptable price (req.askPrice), not best ask. That way
    // Kalshi can sweep multiple book levels if the top level is thin. We've
    // already validated there's enough cumulative depth ≤ req.askPrice.
    const limitCents = Math.round(req.askPrice * 100);
    const orderReq: CreateOrderRequest = {
      ticker: req.ticker,
      side: req.side,
      action: "buy",
      count: maxShares,
      yes_price: req.side === "yes" ? limitCents : undefined,
      no_price: req.side === "no" ? limitCents : undefined,
      client_order_id: clientOrderId,
      time_in_force: "immediate_or_cancel",
      buy_max_cost: Math.ceil(maxShares * req.askPrice * 100) + 10,
    };

    this.log(`  → Placing IOC buy ${req.side.toUpperCase()} ${maxShares} @ limit $${req.askPrice.toFixed(3)} (best ask $${effectiveOrderPrice.toFixed(3)}) [${req.ticker}]`, "cyan");

    let orderResponse;
    try {
      orderResponse = await this.client.createOrder(orderReq);
    } catch (err: any) {
      this.log(`  ✗ ORDER ERROR: ${err?.message}`, "red");
      return reject(`order API error: ${err?.message}`);
    }

    const order = orderResponse.order;
    const filledShares = parseCount(order.fill_count_fp);
    const filledCostDollars = parseDollars(order.taker_fill_cost_dollars) + parseDollars(order.maker_fill_cost_dollars);
    const totalFee = parseDollars(order.taker_fees_dollars) + parseDollars(order.maker_fees_dollars);

    // Update tracker
    const t = this.loadTracker();
    t.ordersPlaced++;
    if (filledShares > 0) t.ordersFilled++;
    this.saveTracker(t);

    if (filledShares === 0) {
      this.log(`  ✗ UNFILLED: IOC order did not fill (${order.status})`, "yellow");
      return reject(`IOC unfilled (${order.status})`);
    }

    const avgPrice = filledShares > 0 ? filledCostDollars / filledShares : 0;
    this.log(
      `  ✓ FILLED: ${filledShares} shares @ avg $${avgPrice.toFixed(3)} = $${filledCostDollars.toFixed(2)} (+$${totalFee.toFixed(2)} fee)`,
      "green"
    );

    return {
      success: true,
      orderId: order.order_id,
      filledShares,
      filledCostUSD: filledCostDollars,
      avgPriceDollars: avgPrice,
      feePaidUSD: totalFee,
    };
  }

  /** Log current day's tracker for visibility */
  logDailyStatus() {
    const t = this.loadTracker();
    this.log(
      `  Daily: ${t.ordersFilled}/${t.ordersPlaced} filled, realized $${t.realizedPnL.toFixed(2)} / cap $${this.config.dailyLossCapUSD.toFixed(2)}`,
      "dim"
    );
  }
}
