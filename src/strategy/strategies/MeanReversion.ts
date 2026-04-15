import type { Strategy, StrategyContext } from "../types";

/**
 * Dip Buyer v5.
 *
 * LESSONS FROM v4 (0W-5L, -$24.85):
 * - $0.48 entry = coin flip. Every trade lost.
 * - Stop losses ($0.02) trigger on normal bid volatility. Every time.
 * - Scalp targets ($0.01) never fill — spread too tight.
 *
 * FIX: Enter cheaper ($0.43), hold to resolution, no stops.
 * Risk $2.15 to win $2.85 per trade. Need 43% win rate.
 */
export const simulationStrategy: Strategy = async (ctx: StrategyContext) => {
  const BUY_SHARES = 5;
  const MAX_ENTRY_PRICE = 0.43;
  const SCAN_INTERVAL_MS = 500;
  const SCAN_START_DELAY_MS = 5_000;
  const STOP_SCAN_MS = 60_000; // Stop scanning 1 min before close

  const release = ctx.hold();
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  let entered = false;

  ctx.log("Dip Buyer v5 (ask <= $0.43, hold to resolution, no stops)", "cyan");

  const scanStart = ctx.slotStartMs + SCAN_START_DELAY_MS;
  const scanEnd = ctx.slotEndMs - STOP_SCAN_MS;
  const waitMs = Math.max(0, scanStart - Date.now());

  const startTimeout = setTimeout(() => {
    const scanner = setInterval(() => {
      if (entered || Date.now() > scanEnd) {
        if (!entered) {
          ctx.log("No ask <= $0.43 found during window — skipping", "dim");
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

      ctx.log(`ENTRY: ${side} @ $${buyPrice.toFixed(2)} × ${shares} | Risk $${risk} → Win $${reward}`, "green");

      ctx.postOrders([{
        tokenId,
        action: "buy",
        price: buyPrice,
        shares,
        orderType: "FOK",
        expireAtMs: ctx.slotEndMs,

        onFilled: (filledShares) => {
          ctx.log(`${side} bought ${filledShares} @ $${buyPrice.toFixed(2)} — holding to resolution`, "green");
          ctx.blockBuys();
          // No sell, no stop. Hold to resolution.
          release();
        },

        onFailed: (reason) => {
          ctx.log(`Buy failed: ${reason} — resuming scan`, "yellow");
          entered = false;
        },
        onExpired: () => {
          ctx.log("Buy expired — resuming scan", "yellow");
          entered = false;
        },
      }]);
    }, SCAN_INTERVAL_MS);

    intervals.push(scanner);
  }, waitMs);

  timeouts.push(startTimeout);
  return () => { timeouts.forEach(clearTimeout); intervals.forEach(clearInterval); };
};
