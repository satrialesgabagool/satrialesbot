import type { Strategy, StrategyContext } from "../types";

/**
 * Late Conviction v6.
 *
 * LESSONS FROM v5 (0 trades in 8 rounds — $0.35 never hit):
 * The $0.35 threshold was too tight. Loosening to $0.40 to actually
 * generate trades while maintaining good risk/reward.
 *
 * - Waits until 2 min remaining (was 2.5 — tighter window for clearer signal)
 * - Buys cheapest side if ask <= $0.40
 * - Hold to resolution — no stops, no scalp
 * - Risk $2.00 to win $3.00. Need 40% win rate.
 */
export const signalMomentumStrategy: Strategy = async (ctx: StrategyContext) => {
  const BUY_SHARES = 5;
  const MAX_ENTRY_PRICE = 0.40;
  const SCAN_INTERVAL_MS = 200;
  const LATE_ENTRY_MS = 120_000; // Start scanning 2 min before close
  const STOP_SCAN_MS = 30_000;   // Stop 30s before close

  const release = ctx.hold();
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  let entered = false;

  ctx.log("Late Conviction v6 (ask <= $0.40, last 2 min, hold to resolution)", "cyan");

  const scanStart = ctx.slotEndMs - LATE_ENTRY_MS;
  const scanEnd = ctx.slotEndMs - STOP_SCAN_MS;
  const waitMs = Math.max(0, scanStart - Date.now());

  const startTimeout = setTimeout(() => {
    ctx.log("Entering late-window scan phase...", "dim");

    const scanner = setInterval(() => {
      if (entered || Date.now() > scanEnd) {
        if (!entered) {
          ctx.log("No conviction (ask never <= $0.40) — skipping", "dim");
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

      entered = true;
      clearInterval(scanner);

      const tokenId = side === "UP" ? ctx.tokenIdUp : ctx.tokenIdDown;
      const buyPrice = bestAsk.price;
      const shares = Math.min(BUY_SHARES, bestAsk.size);
      const risk = (buyPrice * shares).toFixed(2);
      const reward = ((1 - buyPrice) * shares).toFixed(2);

      ctx.log(`LATE ENTRY: ${side} @ $${buyPrice.toFixed(2)} × ${shares} | Risk $${risk} → Win $${reward}`, "green");

      ctx.postOrders([{
        tokenId,
        action: "buy",
        price: buyPrice,
        shares,
        orderType: "FOK",
        expireAtMs: ctx.slotEndMs,

        onFilled: (filledShares) => {
          ctx.log(`${side} bought ${filledShares} @ $${buyPrice.toFixed(2)} — holding to resolution`, "green");
          release();
        },

        onFailed: (reason) => {
          ctx.log(`Buy failed: ${reason}`, "yellow");
          entered = false;
        },
        onExpired: () => {
          ctx.log("Buy expired", "yellow");
          release();
        },
      }]);
    }, SCAN_INTERVAL_MS);

    intervals.push(scanner);
  }, waitMs);

  timeouts.push(startTimeout);
  return () => { timeouts.forEach(clearTimeout); intervals.forEach(clearInterval); };
};
