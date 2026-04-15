import type { Strategy, StrategyContext } from "../types";

/**
 * Late Conviction Strategy v5.
 *
 * KEY INSIGHT from 20+ rounds of data:
 * Markets open at 50/50 and stay there until late in the window.
 * Only in the last 2-3 minutes do prices diverge as the outcome
 * becomes clearer. This strategy waits for that late-window conviction.
 *
 * - Waits until 2.5 min remaining
 * - Checks if either side's ask has dropped to <= $0.35 (65%+ odds)
 * - If yes: buy cheap side with FOK, hold to resolution (no sell target)
 * - If no: skip — the outcome is still uncertain
 * - No sell target — hold to resolution for $1.00 payout
 * - Risk: $3.50 per trade (buy at $0.35) but win $6.50 (payout $1 - $0.35)
 * - Only need 35% win rate to break even (vs 96% needed in v1!)
 */
export const signalMomentumStrategy: Strategy = async (ctx: StrategyContext) => {
  const BUY_SHARES = 5; // Smaller position — higher risk per trade
  const MAX_ENTRY_PRICE = 0.35; // Only buy when 65%+ confident
  const SCAN_INTERVAL_MS = 200; // Fast scan in the final minutes
  const LATE_ENTRY_MS = 150_000; // Start scanning 2.5 min before close
  const STOP_SCAN_MS = 30_000; // Stop 30s before close (resolution lock)

  const release = ctx.hold();
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  let entered = false;

  ctx.log("Late Conviction v5 started (enter at 2.5min remaining, hold to resolution)", "cyan");

  const scanStart = ctx.slotEndMs - LATE_ENTRY_MS;
  const scanEnd = ctx.slotEndMs - STOP_SCAN_MS;
  const waitMs = Math.max(0, scanStart - Date.now());

  const startTimeout = setTimeout(() => {
    ctx.log("Entering late-window scan phase...", "dim");

    const scanner = setInterval(() => {
      if (entered || Date.now() > scanEnd) {
        if (!entered) {
          ctx.log("No conviction (ask never <= $0.35) — skipping", "dim");
          clearInterval(scanner);
          release();
        }
        return;
      }

      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");

      let side: "UP" | "DOWN" | null = null;
      let bestAsk: { price: number; size: number } | null = null;

      if (upAsk && upAsk.price <= MAX_ENTRY_PRICE) {
        side = "UP";
        bestAsk = upAsk;
      }
      if (downAsk && downAsk.price <= MAX_ENTRY_PRICE) {
        if (!side || downAsk.price < bestAsk!.price) {
          side = "DOWN";
          bestAsk = downAsk;
        }
      }

      if (!side || !bestAsk) return;

      // Late conviction entry — buy and hold to resolution
      entered = true;
      clearInterval(scanner);

      const tokenId = side === "UP" ? ctx.tokenIdUp : ctx.tokenIdDown;
      const buyPrice = bestAsk.price;
      const potentialProfit = ((1 - buyPrice) * Math.min(BUY_SHARES, bestAsk.size)).toFixed(2);

      ctx.log(
        `LATE ENTRY: ${side} @ $${buyPrice.toFixed(2)} (${bestAsk.size.toFixed(0)} avail) | If correct: +$${potentialProfit} | If wrong: -$${(buyPrice * Math.min(BUY_SHARES, bestAsk.size)).toFixed(2)}`,
        "green",
      );

      ctx.postOrders([
        {
          tokenId,
          action: "buy",
          price: buyPrice,
          shares: Math.min(BUY_SHARES, bestAsk.size),
          orderType: "FOK",
          expireAtMs: ctx.slotEndMs,

          onFilled: (filledShares) => {
            ctx.log(`${side} bought ${filledShares} @ $${buyPrice.toFixed(2)} — holding to resolution`, "green");
            // No sell — hold to resolution for $1 payout
            // The round lifecycle will handle resolution
            release();
          },

          onFailed: (reason) => {
            ctx.log(`Buy failed: ${reason}`, "yellow");
            entered = false; // Try again
          },

          onExpired: () => {
            ctx.log("Buy expired", "yellow");
            release();
          },
        },
      ]);
    }, SCAN_INTERVAL_MS);

    intervals.push(scanner);
  }, waitMs);

  timeouts.push(startTimeout);
  return () => { timeouts.forEach(clearTimeout); intervals.forEach(clearInterval); };
};
