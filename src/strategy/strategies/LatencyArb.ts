import type { Strategy, StrategyContext } from "../types";

/**
 * Latency Arbitrage v6.
 *
 * LESSONS FROM v4-v5 (0W-2L):
 * - v4: Entered at $0.50 with $52 gap → coin flip, lost -$5.00
 * - v5: Entered at $0.45 with $44 gap → stop loss at $0.41, lost -$4.50
 * - Stop losses DON'T WORK in 5-min binaries. Natural bid volatility
 *   exceeds any reasonable stop threshold.
 *
 * FIX: Tighter entry ($0.42), bigger gap ($50), NO stop loss.
 * If the BTC gap is real, resolution pays $1. If not, we lose entry cost.
 * Risk $2.10 to win $2.90. Need 42% win rate.
 */
export const latencyArbStrategy: Strategy = async (ctx: StrategyContext) => {
  const SHARES_PER_TRADE = 5;
  const MIN_GAP_USD = 50;
  const MAX_ENTRY_PRICE = 0.42;
  const TICK_INTERVAL_MS = 200;
  const ENTRY_COOLDOWN_MS = 5000;
  const WIND_DOWN_BUFFER_MS = 60_000;

  const release = ctx.hold();
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  let entered = false;
  let lastEntryMs = 0;

  ctx.log("Latency Arb v6 (gap >= $50, ask <= $0.42, hold to resolution, no stops)", "cyan");

  const waitMs = Math.max(0, ctx.slotStartMs - Date.now() + 2000);

  const startTimeout = setTimeout(() => {
    let priceToBeat = ctx.ticker.price;

    if (!priceToBeat) {
      ctx.log("No BTC price available — skipping round", "yellow");
      release();
      return;
    }

    ctx.log(`Price to beat: $${priceToBeat.toFixed(2)}`, "cyan");

    const ticker = setInterval(() => {
      if (entered) return;

      const now = Date.now();
      const timeLeft = ctx.slotEndMs - now;

      if (timeLeft < WIND_DOWN_BUFFER_MS) {
        clearInterval(ticker);
        if (!entered) {
          ctx.log("No arb found — skipping", "dim");
          release();
        }
        return;
      }

      if (now - lastEntryMs < ENTRY_COOLDOWN_MS) return;

      const btcPrice = ctx.ticker.price;
      if (!btcPrice) return;

      const gap = btcPrice - priceToBeat!;
      const absGap = Math.abs(gap);
      if (absGap < MIN_GAP_USD) return;

      const winningSide: "UP" | "DOWN" = gap > 0 ? "UP" : "DOWN";
      const winningTokenId = winningSide === "UP" ? ctx.tokenIdUp : ctx.tokenIdDown;

      const bestAsk = ctx.orderBook.bestAskInfo(winningSide);
      if (!bestAsk || bestAsk.price > MAX_ENTRY_PRICE) return;

      // Edge: estimated true probability minus market implied probability
      const trueProb = absGap > 100 ? 0.90 : absGap > 75 ? 0.85 : absGap > 50 ? 0.75 : 0.65;
      const edge = trueProb - bestAsk.price;
      if (edge < 0.20) return; // Need at least 20% edge

      if (bestAsk.size < SHARES_PER_TRADE) return;

      entered = true;
      clearInterval(ticker);
      lastEntryMs = now;

      const shares = Math.min(SHARES_PER_TRADE, bestAsk.size);
      const risk = (bestAsk.price * shares).toFixed(2);
      const reward = ((1 - bestAsk.price) * shares).toFixed(2);

      ctx.log(
        `ARB: BTC=$${btcPrice.toFixed(0)} gap=${gap > 0 ? "+" : ""}$${gap.toFixed(0)} | ${winningSide} ask=$${bestAsk.price.toFixed(2)} edge=${(edge * 100).toFixed(1)}% | Risk $${risk} → Win $${reward}`,
        "green",
      );

      ctx.postOrders([{
        tokenId: winningTokenId,
        action: "buy",
        price: bestAsk.price,
        shares,
        orderType: "FOK",
        expireAtMs: ctx.slotEndMs,

        onFilled: (filledShares) => {
          ctx.log(`${winningSide} bought ${filledShares} @ $${bestAsk.price.toFixed(2)} — holding to resolution`, "green");
          ctx.blockBuys();
          // No sell target, no stop loss. Hold to resolution.
          release();
        },

        onFailed: (reason) => {
          ctx.log(`Buy failed: ${reason}`, "yellow");
          entered = false;
        },
      }]);
    }, TICK_INTERVAL_MS);

    intervals.push(ticker);
  }, waitMs);

  timeouts.push(startTimeout);
  return () => { timeouts.forEach(clearTimeout); intervals.forEach(clearInterval); };
};
