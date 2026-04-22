import type { Strategy, StrategyContext } from "../types";
import { appendFileSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Observer v2 — enhanced data collection, NO TRADING.
 *
 * Two recording phases:
 * 1. FULL WINDOW (every 5s): track gap direction + asks across entire round
 * 2. FINAL 90s (every 500ms): high-frequency capture for sniper data
 *
 * NEW: Detects crossover events — when gap flips sign (BTC crosses
 * the price to beat). Logs the losing-side ask at flip time, because
 * that's the cheap entry window before market makers reprice.
 *
 * Also tracks: ask reprice speed after crossovers, spread dynamics,
 * and whether the direction at T-10s predicts resolution.
 */

const BOOK_CSV = join(import.meta.dir, "../../../results/observer.csv");
const CROSSOVER_CSV = join(import.meta.dir, "../../../results/crossovers.csv");

const BOOK_HEADER = "timestamp,slug,seconds_left,btc_price,price_to_beat,gap,abs_gap,up_best_ask,up_ask_size,up_liq_below_50,up_liq_below_45,up_liq_below_40,down_best_ask,down_ask_size,down_liq_below_50,down_liq_below_45,down_liq_below_40,winning_side,winning_ask,losing_ask,spread_total\n";
const CROSSOVER_HEADER = "timestamp,slug,seconds_left,direction,btc_price,price_to_beat,gap,old_winner_ask,new_winner_ask,new_winner_liq_below_50,reprice_ms\n";

export const observerStrategy: Strategy = async (ctx: StrategyContext) => {
  const FULL_WINDOW_INTERVAL_MS = 5_000;
  const FINAL_PHASE_INTERVAL_MS = 500;
  const FINAL_PHASE_START_MS = 90_000;
  const STOP_MS = 3_000; // Record closer to resolution (was 5s)

  const release = ctx.hold();
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  const bookRows: string[] = [];
  const crossoverRows: string[] = [];

  // Ensure CSV headers
  for (const [path, header] of [[BOOK_CSV, BOOK_HEADER], [CROSSOVER_CSV, CROSSOVER_HEADER]] as const) {
    if (!existsSync(path) || readFileSync(path, "utf-8").trim() === "") {
      writeFileSync(path, header);
    }
  }

  // Capture price to beat early
  let priceToBeat: number | null = null;
  let lastGapSign: number = 0; // -1, 0, +1
  let lastCrossoverMs: number = 0;
  let crossoverNewWinnerAskAtFlip: number | null = null;

  const ptbCheck = setInterval(() => {
    if (!priceToBeat && ctx.ticker.price) {
      priceToBeat = ctx.ticker.price;
      ctx.log(`Observer v2: price to beat = $${priceToBeat.toFixed(2)}`, "dim");
    }
  }, 500);
  intervals.push(ptbCheck);

  ctx.log("Observer v2 started (full window + high-freq final 90s + crossover detection)", "cyan");

  // --- Phase 1: Full window recording (every 5s) ---
  const fullWindowStart = Math.max(0, ctx.slotStartMs + 5000 - Date.now());

  const phase1Timeout = setTimeout(() => {
    const fullRecorder = setInterval(() => {
      if (Date.now() > ctx.slotEndMs - FINAL_PHASE_START_MS) {
        clearInterval(fullRecorder);
        return;
      }
      recordSnapshot(5);
    }, FULL_WINDOW_INTERVAL_MS);
    intervals.push(fullRecorder);
  }, fullWindowStart);
  timeouts.push(phase1Timeout);

  // --- Phase 2: Final 90s high-frequency recording (every 500ms) ---
  const phase2Start = Math.max(0, ctx.slotEndMs - FINAL_PHASE_START_MS - Date.now());

  const phase2Timeout = setTimeout(() => {
    ctx.log("Observer v2: high-freq recording phase", "dim");

    const finalRecorder = setInterval(() => {
      if (Date.now() > ctx.slotEndMs - STOP_MS) {
        clearInterval(finalRecorder);
        flush();
        release();
        return;
      }
      recordSnapshot(0.5);
    }, FINAL_PHASE_INTERVAL_MS);
    intervals.push(finalRecorder);
  }, phase2Start);
  timeouts.push(phase2Timeout);

  function recordSnapshot(intervalSec: number) {
    const now = Date.now();
    const secondsLeft = (ctx.slotEndMs - now) / 1000;
    const btcPrice = ctx.ticker.price ?? 0;
    if (!priceToBeat) priceToBeat = btcPrice;

    const gap = btcPrice - priceToBeat;
    const absGap = Math.abs(gap);
    const currentSign = gap > 5 ? 1 : gap < -5 ? -1 : 0; // 5$ dead zone to avoid noise

    const upAsk = ctx.orderBook.bestAskInfo("UP");
    const downAsk = ctx.orderBook.bestAskInfo("DOWN");

    const upLiq50 = ctx.orderBook.askLiquidityUpTo("UP", 0.50);
    const upLiq45 = ctx.orderBook.askLiquidityUpTo("UP", 0.45);
    const upLiq40 = ctx.orderBook.askLiquidityUpTo("UP", 0.40);
    const downLiq50 = ctx.orderBook.askLiquidityUpTo("DOWN", 0.50);
    const downLiq45 = ctx.orderBook.askLiquidityUpTo("DOWN", 0.45);
    const downLiq40 = ctx.orderBook.askLiquidityUpTo("DOWN", 0.40);

    const winningSide = gap > 0 ? "UP" : gap < 0 ? "DOWN" : "EVEN";
    const winningAsk = winningSide === "UP" ? upAsk?.price : winningSide === "DOWN" ? downAsk?.price : null;
    const losingAsk = winningSide === "UP" ? downAsk?.price : winningSide === "DOWN" ? upAsk?.price : null;
    const spreadTotal = (upAsk?.price ?? 0) + (downAsk?.price ?? 0);

    // --- Crossover detection ---
    if (lastGapSign !== 0 && currentSign !== 0 && currentSign !== lastGapSign) {
      const direction = currentSign > 0 ? "BEAR_TO_BULL" : "BULL_TO_BEAR";
      // The "new winner" side was just the losing side — its ask should still be cheap
      const newWinnerSide = currentSign > 0 ? "UP" : "DOWN";
      const newWinnerAsk = newWinnerSide === "UP" ? upAsk : downAsk;
      const newWinnerLiq = newWinnerSide === "UP" ? upLiq50 : downLiq50;
      const oldWinnerAsk = newWinnerSide === "UP" ? downAsk : upAsk;

      crossoverNewWinnerAskAtFlip = newWinnerAsk?.price ?? null;
      lastCrossoverMs = now;

      const crossRow = [
        new Date().toISOString(),
        ctx.slug,
        secondsLeft.toFixed(1),
        direction,
        btcPrice.toFixed(2),
        priceToBeat.toFixed(2),
        gap.toFixed(2),
        oldWinnerAsk?.price.toFixed(2) ?? "",
        newWinnerAsk?.price.toFixed(2) ?? "",
        newWinnerLiq.toFixed(0),
        "", // reprice_ms — filled on next tick when ask changes
      ].join(",") + "\n";

      crossoverRows.push(crossRow);
      ctx.log(
        `CROSSOVER [${secondsLeft.toFixed(0)}s left] ${direction} | gap=$${gap.toFixed(0)} | new winner=${newWinnerSide} ask=$${newWinnerAsk?.price.toFixed(2) ?? "?"} (${newWinnerLiq.toFixed(0)} liq<$0.50)`,
        "cyan",
      );
    }

    // Track reprice speed after crossover
    if (crossoverNewWinnerAskAtFlip !== null && lastCrossoverMs > 0) {
      const newWinnerSide = currentSign > 0 ? "UP" : "DOWN";
      const currentAsk = newWinnerSide === "UP" ? upAsk?.price : downAsk?.price;
      if (currentAsk && currentAsk > crossoverNewWinnerAskAtFlip + 0.02) {
        const repriceMs = now - lastCrossoverMs;
        ctx.log(`Reprice detected: ${repriceMs}ms after crossover ($${crossoverNewWinnerAskAtFlip.toFixed(2)} → $${currentAsk.toFixed(2)})`, "green");
        // Update the last crossover row with reprice time
        if (crossoverRows.length > 0) {
          const lastRow = crossoverRows[crossoverRows.length - 1];
          crossoverRows[crossoverRows.length - 1] = lastRow.replace(/,\n$/, `,${repriceMs}\n`);
        }
        crossoverNewWinnerAskAtFlip = null;
      }
    }

    lastGapSign = currentSign;

    const row = [
      new Date().toISOString(),
      ctx.slug,
      secondsLeft.toFixed(1),
      btcPrice.toFixed(2),
      priceToBeat.toFixed(2),
      gap.toFixed(2),
      absGap.toFixed(2),
      upAsk?.price.toFixed(2) ?? "",
      upAsk?.size.toFixed(0) ?? "0",
      upLiq50.toFixed(0),
      upLiq45.toFixed(0),
      upLiq40.toFixed(0),
      downAsk?.price.toFixed(2) ?? "",
      downAsk?.size.toFixed(0) ?? "0",
      downLiq50.toFixed(0),
      downLiq45.toFixed(0),
      downLiq40.toFixed(0),
      winningSide,
      winningAsk?.toFixed(2) ?? "",
      losingAsk?.toFixed(2) ?? "",
      spreadTotal.toFixed(2),
    ].join(",") + "\n";

    bookRows.push(row);

    // Periodic log
    if (secondsLeft % 15 < intervalSec + 0.1) {
      ctx.log(
        `[${secondsLeft.toFixed(0)}s] gap=$${gap.toFixed(0)} | UP=$${upAsk?.price.toFixed(2) ?? "—"} DOWN=$${downAsk?.price.toFixed(2) ?? "—"} | spread=$${spreadTotal.toFixed(2)}`,
        "dim",
      );
    }
  }

  function flush() {
    if (bookRows.length > 0) {
      appendFileSync(BOOK_CSV, bookRows.join(""));
    }
    if (crossoverRows.length > 0) {
      appendFileSync(CROSSOVER_CSV, crossoverRows.join(""));
    }
    ctx.log(`Observer v2: flushed ${bookRows.length} book snapshots, ${crossoverRows.length} crossovers`, "cyan");
  }

  return () => { timeouts.forEach(clearTimeout); intervals.forEach(clearInterval); };
};
