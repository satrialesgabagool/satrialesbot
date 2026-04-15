import type { Strategy, StrategyContext } from "../types";

/**
 * Selective Entry Strategy v4.
 *
 * KEY INSIGHT: Markets always open at ~50/50. Prices only diverge
 * during the window as BTC moves. Instead of checking once at entry,
 * we scan continuously and enter when conditions are met.
 *
 * - Scans every 500ms for an ask <= $0.48
 * - Stops scanning 2.5 min before close (need exit time)
 * - If conditions are never met, skip the round ($0.00)
 * - $0.01 profit target, $0.02 stop-loss
 */
export const simulationStrategy: Strategy = async (ctx: StrategyContext) => {
  const BUY_SHARES = 10;
  const MAX_ENTRY_PRICE = 0.48; // Only buy if ask <= $0.48
  const PROFIT_TARGET = 0.01;
  const STOP_LOSS = 0.02;
  const EARLY_EXIT_MS = 150_000; // Exit 2.5 min before close
  const SCAN_INTERVAL_MS = 500; // Check every 500ms
  const SCAN_START_DELAY_MS = 5_000; // Start scanning 5s in
  const STOP_CHECK_MS = 500;

  const release = ctx.hold();
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  let entryPrice: number | null = null;
  let entrySide: "UP" | "DOWN" | null = null;
  let entryTokenId: string | null = null;
  let sharesHeld = 0;
  let entered = false;

  ctx.log("Selective v4 started (continuous scan for ask <= $0.48)", "cyan");

  const scanStart = ctx.slotStartMs + SCAN_START_DELAY_MS;
  const scanEnd = ctx.slotEndMs - EARLY_EXIT_MS;
  const waitMs = Math.max(0, scanStart - Date.now());

  const startTimeout = setTimeout(() => {
    // Continuously scan for entry opportunity
    const scanner = setInterval(() => {
      if (entered || Date.now() > scanEnd) {
        if (!entered) {
          ctx.log("No ask <= $0.48 found during window — skipping", "dim");
          clearInterval(scanner);
          release();
        }
        return;
      }

      const upAsk = ctx.orderBook.bestAskInfo("UP");
      const downAsk = ctx.orderBook.bestAskInfo("DOWN");

      // Check if either side meets our threshold
      let side: "UP" | "DOWN" | null = null;
      let bestAsk: { price: number; size: number } | null = null;

      if (upAsk && upAsk.price <= MAX_ENTRY_PRICE) {
        if (!downAsk || upAsk.price <= downAsk.price) {
          side = "UP";
          bestAsk = upAsk;
        }
      }
      if (downAsk && downAsk.price <= MAX_ENTRY_PRICE) {
        if (!side || downAsk.price < bestAsk!.price) {
          side = "DOWN";
          bestAsk = downAsk;
        }
      }

      if (!side || !bestAsk) return; // Keep scanning

      // Found an entry!
      entered = true;
      clearInterval(scanner);

      const tokenId = side === "UP" ? ctx.tokenIdUp : ctx.tokenIdDown;
      const buyPrice = bestAsk.price;
      const sellPrice = Math.min(0.95, buyPrice + PROFIT_TARGET);

      entryPrice = buyPrice;
      entrySide = side;
      entryTokenId = tokenId;

      ctx.log(
        `ENTRY: ${side} ask=$${buyPrice.toFixed(2)} (${bestAsk.size.toFixed(0)} shares) | Target: $${sellPrice.toFixed(2)} | Stop: $${(buyPrice - STOP_LOSS).toFixed(2)}`,
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
            ctx.log(`${side} buy filled: ${filledShares} @ $${buyPrice.toFixed(2)}`, "green");
            ctx.blockBuys();
            sharesHeld = filledShares;

            ctx.postOrders([
              {
                tokenId,
                action: "sell",
                price: sellPrice,
                shares: filledShares,
                orderType: "GTC",
                expireAtMs: ctx.slotEndMs - EARLY_EXIT_MS,

                onFilled: (soldShares) => {
                  const profit = (sellPrice - buyPrice) * soldShares;
                  ctx.log(`${side} sold ${soldShares} @ $${sellPrice.toFixed(2)} (+$${profit.toFixed(2)})`, "green");
                  sharesHeld = 0;
                  release();
                },

                onExpired: () => {
                  ctx.log("Sell expired — early exit (2.5 min left)", "yellow");
                  const ids = ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId);
                  ctx.emergencySells(ids).then(() => { sharesHeld = 0; release(); });
                },

                onFailed: (reason) => {
                  ctx.log(`Sell failed: ${reason}`, "red");
                  sharesHeld = 0;
                  release();
                },
              },
            ]);

            // Stop-loss monitor
            const stopCheck = setInterval(() => {
              if (sharesHeld === 0 || !entryPrice || !entrySide) {
                clearInterval(stopCheck);
                return;
              }
              const bid = ctx.orderBook.bestBidInfo(entrySide);
              if (!bid) return;

              if (bid.price < entryPrice - STOP_LOSS) {
                ctx.log(`STOP LOSS: ${entrySide} bid=$${bid.price.toFixed(2)}`, "red");
                clearInterval(stopCheck);
                const ids = ctx.pendingOrders.filter(o => o.action === "sell").map(o => o.orderId);
                if (ids.length > 0) {
                  ctx.emergencySells(ids).then(() => { sharesHeld = 0; release(); });
                } else {
                  ctx.postOrders([{
                    tokenId: entryTokenId!, action: "sell", price: bid.price,
                    shares: sharesHeld, orderType: "FOK", expireAtMs: ctx.slotEndMs,
                    onFilled: () => { sharesHeld = 0; release(); },
                    onFailed: () => { sharesHeld = 0; release(); },
                  }]);
                }
              }
            }, STOP_CHECK_MS);
            intervals.push(stopCheck);
          },

          onFailed: (reason) => {
            ctx.log(`Buy failed: ${reason} — resuming scan`, "yellow");
            entered = false; // Allow scanner to try again
          },
          onExpired: () => {
            ctx.log("Buy expired — resuming scan", "yellow");
            entered = false;
          },
        },
      ]);
    }, SCAN_INTERVAL_MS);

    intervals.push(scanner);
  }, waitMs);

  timeouts.push(startTimeout);
  return () => { timeouts.forEach(clearTimeout); intervals.forEach(clearInterval); };
};
