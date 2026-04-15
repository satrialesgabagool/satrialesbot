import type { StrategyContext } from "./types";
import type { BookSide } from "../market/OrderBook";

export interface PriceSignal {
  cancel(): void;
}

/**
 * Poll the order book until the best ask on `side` reaches or exceeds `targetPrice`.
 * Calls `onReached(price)` when the condition is met.
 */
export function waitForAsk(
  ctx: StrategyContext,
  side: BookSide,
  targetPrice: number,
  onReached: (price: number) => void,
  pollMs: number = 100,
): PriceSignal {
  let canceled = false;

  const check = () => {
    if (canceled) return;
    const info = ctx.orderBook.bestAskInfo(side);
    if (info && info.price >= targetPrice) {
      onReached(info.price);
      return;
    }
    setTimeout(check, pollMs);
  };

  setTimeout(check, pollMs);

  return {
    cancel() {
      canceled = true;
    },
  };
}

/**
 * Poll the order book until the best bid on `side` drops to or below `targetPrice`.
 * Calls `onReached(price)` when the condition is met.
 */
export function waitForBid(
  ctx: StrategyContext,
  side: BookSide,
  targetPrice: number,
  onReached: (price: number) => void,
  pollMs: number = 100,
): PriceSignal {
  let canceled = false;

  const check = () => {
    if (canceled) return;
    const info = ctx.orderBook.bestBidInfo(side);
    if (info && info.price <= targetPrice) {
      onReached(info.price);
      return;
    }
    setTimeout(check, pollMs);
  };

  setTimeout(check, pollMs);

  return {
    cancel() {
      canceled = true;
    },
  };
}
