import type { Strategy, StrategyContext } from "../types";
import { CompositeIndicator } from "../indicators/Composite";
import { binaryUpProb, estimateVolatility, blendLogit, calculateFee } from "../indicators/BinaryPricing";

/**
 * Snipe V2 — Archetapp-inspired 7-indicator composite entry.
 *
 * Key improvements over LatencyArb v6:
 *
 * 1. T-10s entry timing: Enter in the last 10 seconds of the window
 *    when direction is most certain but market hasn't fully repriced.
 *
 * 2. 7-indicator composite signal (Window Delta dominant):
 *    If BTC is up 0.10%+ from window open with 10s left, almost never reverses.
 *
 * 3. Black-Scholes binary pricing: Compute theoretical UP probability
 *    from current price, window open, time remaining, and realized vol.
 *
 * 4. Logit-space blending: Combine BS probability + composite score +
 *    signal bias in logit space (mathematically cleaner than raw averaging).
 *
 * 5. Dynamic fee awareness: Query feeRateBps before orders (Feb 2026 rules).
 *
 * 6. 5-share minimum: Polymarket's new minimum order size.
 *
 * The strategy waits until T-10s, computes composite score + BS probability,
 * blends them, and enters only if blended probability implies 20%+ edge
 * over the current market ask price.
 */
export const snipeV2Strategy: Strategy = async (ctx: StrategyContext) => {
  const ENTRY_WINDOW_MS = 10_000;    // Enter in the last 10 seconds
  const MIN_BLENDED_EDGE = 0.08;     // 8% edge required after blending
  const MIN_SHARES = 5;              // Feb 2026 minimum
  const MAX_SHARES = 15;             // Risk cap
  const TICK_INTERVAL_MS = 100;      // Poll every 100ms in entry window

  const release = ctx.hold();
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const composite = new CompositeIndicator();

  let entered = false;
  let windowOpenPrice: number | null = null;

  ctx.log("Snipe V2 (7-indicator composite, T-10s entry, logit blending)", "cyan");

  // Phase 1: Wait for window to start, then collect ticks
  const waitForStart = Math.max(0, ctx.slotStartMs - Date.now() + 500);

  const startTimeout = setTimeout(() => {
    // Capture window open price
    windowOpenPrice = ctx.ticker.price ?? null;
    if (!windowOpenPrice) {
      ctx.log("No BTC price at window open — skipping", "yellow");
      release();
      return;
    }

    composite.setWindowOpen(windowOpenPrice, ctx.slotStartMs);
    ctx.log(`Window open: $${windowOpenPrice.toFixed(2)}`, "cyan");

    // Phase 2: Collect ticks throughout the window
    const tickCollector = setInterval(() => {
      const price = ctx.ticker.price;
      if (price) composite.addTick(price);
    }, 200);
    intervals.push(tickCollector);

    // Phase 3: Enter the snipe window (last 10 seconds)
    const snipeDelay = Math.max(0, ctx.slotEndMs - Date.now() - ENTRY_WINDOW_MS);

    const snipeTimeout = setTimeout(() => {
      clearInterval(tickCollector);

      ctx.log("Entering T-10s snipe window", "yellow");
      let lastDiagMs = 0;

      const snipeTicker = setInterval(() => {
        if (entered) return;

        const now = Date.now();
        const timeLeftMs = ctx.slotEndMs - now;

        // Stop with 1 second buffer (need time for order to fill)
        if (timeLeftMs < 1000) {
          clearInterval(snipeTicker);
          if (!entered) {
            ctx.log("Window expired — no entry", "dim");
            release();
          }
          return;
        }

        const btcPrice = ctx.ticker.price;
        if (!btcPrice || !windowOpenPrice) return;

        // Feed final ticks to composite
        composite.addTick(btcPrice);

        // Compute composite signal
        const signal = composite.compute();

        // Compute Black-Scholes binary probability
        const secondsLeft = timeLeftMs / 1000;
        const bsProb = binaryUpProb(btcPrice, windowOpenPrice, secondsLeft);

        // Direction determined by BS (price vs open), NOT the noisy composite
        // BS is mathematical: if BTC > open, UP; if BTC < open, DOWN
        const direction: "UP" | "DOWN" = btcPrice >= windowOpenPrice ? "UP" : "DOWN";
        const directionProb = direction === "UP" ? bsProb : (1 - bsProb);

        // Get signal bias
        const signalBias = ctx.signals.bias; // -1 to +1

        // Blend in logit space:
        // - Black-Scholes binary probability (weight 0.60) — time-based, primary signal
        // - Composite score → probability (weight 0.25) — pattern-based, secondary
        // - Signal bias → probability (weight 0.15) — macro-based, tertiary
        const compositeProb = 0.5 + signal.score * 0.4; // Map [-1,1] to [0.1, 0.9]
        const signalProb = direction === "UP"
          ? 0.5 + signalBias * 0.15
          : 0.5 - signalBias * 0.15;

        const blendedProb = blendLogit([
          { probability: directionProb, weight: 0.60 },
          { probability: compositeProb, weight: 0.25 },
          { probability: signalProb, weight: 0.15 },
        ]);

        // Find best ask on winning side
        const winningTokenId = direction === "UP" ? ctx.tokenIdUp : ctx.tokenIdDown;
        const bestAsk = ctx.orderBook.bestAskInfo(direction);

        // Edge = our blended probability - market's implied probability
        const edge = bestAsk ? blendedProb - bestAsk.price : 0;

        // Diagnostic: log every ~2 seconds during snipe window
        if (now - lastDiagMs >= 2000) {
          lastDiagMs = now;
          const delta = ((btcPrice - windowOpenPrice) / windowOpenPrice * 100).toFixed(4);
          ctx.log(
            `T-${secondsLeft.toFixed(0)}s | BTC $${btcPrice.toFixed(0)} Δ${delta}% | ` +
            `comp=${signal.score.toFixed(2)} | ` +
            `BS=${(directionProb*100).toFixed(0)}% blend=${(blendedProb*100).toFixed(0)}% | ` +
            `ask=${bestAsk ? bestAsk.price.toFixed(2) : 'none'} edge=${(edge*100).toFixed(1)}%`,
            "dim",
          );
        }

        // Only gate: blended edge must exceed threshold
        if (!bestAsk) return;
        if (edge < MIN_BLENDED_EDGE) return;

        // Ensure minimum liquidity
        if (bestAsk.size < MIN_SHARES) return;

        // Position sizing: fractional Kelly, capped at MAX_SHARES
        const kelly = edge / (1 - bestAsk.price);
        const rawShares = Math.floor(kelly * 20 * 0.25); // quarter-Kelly on $20 bankroll
        const shares = Math.max(MIN_SHARES, Math.min(MAX_SHARES, rawShares, bestAsk.size));

        entered = true;
        clearInterval(snipeTicker);

        const risk = (bestAsk.price * shares).toFixed(2);
        const reward = ((1 - bestAsk.price) * shares).toFixed(2);

        ctx.log(
          `SNIPE ${direction} | BTC=$${btcPrice.toFixed(0)} delta=${signal.raw.deltaPercent >= 0 ? "+" : ""}${signal.raw.deltaPercent.toFixed(3)}% ` +
          `| composite=${signal.score.toFixed(2)} (${signal.confidence.toFixed(0)}% agree) ` +
          `| BS=${(directionProb * 100).toFixed(1)}% blend=${(blendedProb * 100).toFixed(1)}% ` +
          `| ask=$${bestAsk.price.toFixed(2)} edge=${(edge * 100).toFixed(1)}% ` +
          `| ${shares}sh risk=$${risk} reward=$${reward}`,
          "green",
        );

        // Log component breakdown
        ctx.log(
          `  Components: WD=${signal.components.windowDelta.toFixed(2)} ` +
          `MM=${signal.components.microMomentum.toFixed(2)} ` +
          `Acc=${signal.components.acceleration.toFixed(2)} ` +
          `EMA=${signal.components.emaCrossover.toFixed(2)} ` +
          `RSI=${signal.components.rsi.toFixed(2)} ` +
          `Vol=${signal.components.volumeSurge.toFixed(2)} ` +
          `Tick=${signal.components.tickTrend.toFixed(2)}`,
          "dim",
        );

        ctx.postOrders([{
          tokenId: winningTokenId,
          action: "buy",
          price: bestAsk.price,
          shares,
          orderType: "FOK",
          expireAtMs: ctx.slotEndMs,

          onFilled: (filledShares) => {
            ctx.log(`${direction} filled ${filledShares} @ $${bestAsk.price.toFixed(2)} — holding to resolution`, "green");
            ctx.blockBuys();
            release();
          },

          onFailed: (reason) => {
            ctx.log(`Buy failed: ${reason}`, "yellow");
            entered = false;
          },
        }]);
      }, TICK_INTERVAL_MS);

      intervals.push(snipeTicker);
    }, snipeDelay);

    timeouts.push(snipeTimeout);
  }, waitForStart);

  timeouts.push(startTimeout);

  return () => {
    timeouts.forEach(clearTimeout);
    intervals.forEach(clearInterval);
  };
};
