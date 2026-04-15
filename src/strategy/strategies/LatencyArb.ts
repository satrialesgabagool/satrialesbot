import type { Strategy, StrategyContext } from "../types";

/**
 * Latency Arbitrage Strategy
 *
 * Exploits the structural lag between CEX prices (Binance) and Polymarket odds.
 * When BTC moves on Binance, it takes ~2-3 seconds for Polymarket order book
 * to reflect the new reality. This strategy:
 *
 * 1. Continuously compares BTC price from Binance against the Polymarket
 *    "price to beat" (the reference price for the 5-min market)
 * 2. When BTC is significantly above/below the price to beat, and the
 *    Polymarket odds haven't caught up yet (the winning side is still cheap),
 *    it enters aggressively
 * 3. Sells quickly for a small profit once odds adjust, or holds to resolution
 *
 * This is the same approach that produced a 98% win rate on documented
 * on-chain wallets. The edge is speed + the structural lag.
 */
export const latencyArbStrategy: Strategy = async (ctx: StrategyContext) => {
  // --- Configuration v5 ---
  // KEY FIX: v4 entered at $0.50 on a $52 gap — but $0.50 = coin flip.
  // The arb only works when the ask HASN'T caught up to the BTC move yet.
  // MAX_ENTRY $0.45 means the market is pricing 55% odds on that side,
  // but BTC gap says it should be 70-90%. That's a real mispricing.
  const SHARES_PER_TRADE = 10;
  const MIN_GAP_USD = 40; // Lower gap to catch more opportunities
  const MAX_ENTRY_PRICE = 0.45; // ONLY enter if ask hasn't caught up (was $0.50 — too loose)
  const SELL_TARGET = 0.01; // Quick scalp — don't wait for $0.02
  const STOP_LOSS = 0.03;
  const TICK_INTERVAL_MS = 200;
  const ENTRY_COOLDOWN_MS = 5000;
  const WIND_DOWN_BUFFER_MS = 60_000; // 60s wind-down (was 90s — more trading time)

  // --- State ---
  const release = ctx.hold();
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  let entryPrice: number | null = null;
  let entryTokenId: string | null = null;
  let entrySide: "UP" | "DOWN" | null = null;
  let sharesHeld = 0;
  let lastEntryMs = 0;
  let tradingActive = true;

  ctx.log("Latency Arb strategy started", "cyan");

  // Wait for the market to open
  const waitMs = Math.max(0, ctx.slotStartMs - Date.now() + 2000); // +2s for book to settle

  const startTimeout = setTimeout(() => {
    // Get the "price to beat" — the BTC price at market open
    const marketResult = ctx.getMarketResult();
    let priceToBeat = marketResult?.openPrice;

    // If not available from market data, estimate from the order book
    // When UP and DOWN are both near 0.50, BTC is near the price to beat
    if (!priceToBeat) {
      priceToBeat = ctx.ticker.price;
      if (priceToBeat) {
        ctx.log(`Using current BTC as price to beat: $${priceToBeat.toFixed(0)}`, "dim");
      }
    }

    if (!priceToBeat) {
      ctx.log("No BTC price available — skipping round", "yellow");
      release();
      return;
    }

    ctx.log(`Price to beat: $${priceToBeat.toFixed(2)}`, "cyan");

    // --- Main tick loop: scan for latency arb opportunities ---
    const ticker = setInterval(() => {
      if (!tradingActive) return;

      const now = Date.now();
      const timeLeft = ctx.slotEndMs - now;

      // Stop entering near the end
      if (timeLeft < WIND_DOWN_BUFFER_MS) {
        tradingActive = false;
        if (sharesHeld > 0) {
          ctx.log(`Holding ${sharesHeld} shares to resolution (${(timeLeft / 1000).toFixed(0)}s left)`, "dim");
        } else {
          release();
        }
        return;
      }

      // Cooldown between entries
      if (now - lastEntryMs < ENTRY_COOLDOWN_MS) return;

      // Already in a position — manage it
      if (sharesHeld > 0 && entryPrice && entrySide) {
        managePosition();
        return;
      }

      // --- Look for arb opportunity ---
      const btcPrice = ctx.ticker.price;
      if (!btcPrice) return;

      const gap = btcPrice - priceToBeat!;
      const absGap = Math.abs(gap);

      // Not enough gap for a trade
      if (absGap < MIN_GAP_USD) return;

      // Determine which side wins
      const winningSide: "UP" | "DOWN" = gap > 0 ? "UP" : "DOWN";
      const winningTokenId = winningSide === "UP" ? ctx.tokenIdUp : ctx.tokenIdDown;

      // Check if the winning side is still cheap (odds haven't caught up)
      const bestAsk = ctx.orderBook.bestAskInfo(winningSide);
      if (!bestAsk) return;

      // If the ask is already high, odds have caught up — no edge
      if (bestAsk.price > MAX_ENTRY_PRICE) return;

      // The cheaper the ask while the gap is large, the better the arb
      // Estimated true probability based on BTC gap magnitude
      const trueProb = absGap > 100 ? 0.90 : absGap > 75 ? 0.85 : absGap > 50 ? 0.75 : 0.65;
      const impliedProb = bestAsk.price;
      const edge = trueProb - impliedProb;

      if (edge < 0.15) return; // Need at least 15% edge (was 5% — too loose, entered at $0.50)

      // Check liquidity
      if (bestAsk.size < SHARES_PER_TRADE) return;

      ctx.log(
        `ARB: BTC=$${btcPrice.toFixed(0)} gap=${gap > 0 ? "+" : ""}$${gap.toFixed(0)} | ${winningSide} ask=$${bestAsk.price.toFixed(2)} edge=${(edge * 100).toFixed(1)}%`,
        "green",
      );

      // Execute! FOK buy at best ask
      entryPrice = bestAsk.price;
      entryTokenId = winningTokenId;
      entrySide = winningSide;
      lastEntryMs = now;

      ctx.postOrders([
        {
          tokenId: winningTokenId,
          action: "buy",
          price: bestAsk.price,
          shares: Math.min(SHARES_PER_TRADE, bestAsk.size),
          orderType: "FOK",
          expireAtMs: ctx.slotEndMs,

          onFilled: (filledShares) => {
            sharesHeld = filledShares;
            ctx.log(
              `${winningSide} bought ${filledShares} @ $${bestAsk.price.toFixed(2)}`,
              "green",
            );
            ctx.blockBuys();

            // Place sell at target
            const sellPrice = Math.min(0.95, bestAsk.price + SELL_TARGET);
            ctx.postOrders([
              {
                tokenId: winningTokenId,
                action: "sell",
                price: sellPrice,
                shares: filledShares,
                orderType: "GTC",
                expireAtMs: ctx.slotEndMs - WIND_DOWN_BUFFER_MS,

                onFilled: (soldShares) => {
                  const profit = (sellPrice - bestAsk.price) * soldShares;
                  ctx.log(
                    `SOLD ${soldShares} @ $${sellPrice.toFixed(2)} profit=$${profit.toFixed(2)}`,
                    "green",
                  );
                  sharesHeld = 0;
                  entryPrice = null;
                  release();
                },

                onExpired: () => {
                  // Sell didn't fill — hold to resolution
                  ctx.log("Sell expired — holding to resolution", "yellow");
                  sharesHeld = 0;
                  release();
                },

                onFailed: (reason) => {
                  ctx.log(`Sell failed: ${reason} — holding to resolution`, "red");
                  sharesHeld = 0;
                  release();
                },
              },
            ]);
          },

          onFailed: (reason) => {
            ctx.log(`Buy failed: ${reason}`, "dim");
            entryPrice = null;
            entryTokenId = null;
            entrySide = null;
          },
        },
      ]);
    }, TICK_INTERVAL_MS);

    intervals.push(ticker);

    // --- Position management (stop-loss) ---
    function managePosition() {
      if (!entrySide || !entryPrice || sharesHeld === 0) return;

      const bestBid = ctx.orderBook.bestBidInfo(entrySide);
      if (!bestBid) return;

      // Stop-loss: exit if bid drops below entry - threshold
      if (bestBid.price < entryPrice - STOP_LOSS) {
        ctx.log(
          `STOP LOSS: ${entrySide} bid=$${bestBid.price.toFixed(2)} < entry=$${entryPrice.toFixed(2)} - $${STOP_LOSS}`,
          "red",
        );

        tradingActive = false;

        // Emergency sell all pending sells, then re-place at bid
        const sellIds = ctx.pendingOrders
          .filter((o) => o.action === "sell")
          .map((o) => o.orderId);

        if (sellIds.length > 0) {
          ctx.emergencySells(sellIds).then(() => {
            sharesHeld = 0;
            entryPrice = null;
            release();
          });
        } else {
          // Place a direct FOK sell at bid
          ctx.postOrders([
            {
              tokenId: entryTokenId!,
              action: "sell",
              price: bestBid.price,
              shares: sharesHeld,
              orderType: "FOK",
              expireAtMs: ctx.slotEndMs,
              onFilled: () => {
                sharesHeld = 0;
                entryPrice = null;
                release();
              },
              onFailed: () => {
                // Hold to resolution
                sharesHeld = 0;
                release();
              },
            },
          ]);
        }
      }
    }
  }, waitMs);

  timeouts.push(startTimeout);

  return () => {
    tradingActive = false;
    timeouts.forEach(clearTimeout);
    intervals.forEach(clearInterval);
  };
};
