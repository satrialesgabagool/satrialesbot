#!/usr/bin/env bun
/**
 * Strategy Comparison — runs ensemble backtest across multiple variants
 * (baseline, ladders, sizing schemes) against the same tape data.
 *
 * Usage:
 *   bun kalshi-strategy-comparison.ts
 *   bun kalshi-strategy-comparison.ts --tape data/kalshi-weather-tape.json
 *   bun kalshi-strategy-comparison.ts --series low                    # KXLOW
 *   bun kalshi-strategy-comparison.ts --tape data/kxlow-tape.json --series low
 */

import { readFileSync, existsSync } from "fs";
import { runComparisonBacktest, type ComparisonVariant } from "./src/kalshi/StrategyComparisonBacktest";
import type { Tape } from "./src/kalshi/WeatherTapeCollector";

const args = process.argv.slice(2);
function argVal<T>(flag: string, fallback: T, parse: (s: string) => T = String as any): T {
  const idx = args.indexOf(flag);
  return idx >= 0 ? parse(args[idx + 1]) : fallback;
}

const TAPE_PATH = argVal("--tape", "data/kalshi-weather-tape.json");
const SERIES = argVal("--series", "high") as "high" | "low";
const HOURS = argVal("--hours", 24, parseInt);

if (!existsSync(TAPE_PATH)) {
  console.error(`Tape not found: ${TAPE_PATH}`);
  process.exit(1);
}

const tape: Tape = JSON.parse(readFileSync(TAPE_PATH, "utf-8"));

// ─── Define variants to compare ────────────────────────────────────
// All use the same price band ($0.07-$0.30) and confidence-tiered sizing
// (1.5× at edge ≥30%) — matching the live bot config. The ONLY thing
// that varies is laddering depth + sizing scheme.

const baseSettings = {
  minPrice: 0.07,
  maxPrice: 0.30,
  highConfMult: 1.5,
  highConfEdge: 0.30,
};

const variants: ComparisonVariant[] = [
  {
    name: "BASELINE  (top-1, no ladder)",
    topN: 1,
    sizingScheme: "even",
    minProbability: 0.40,
    ...baseSettings,
  },
  {
    name: "LADDER-2  even split (50/50)",
    topN: 2,
    sizingScheme: "even",
    minProbability: 0.30,        // lower floor lets 2nd pick qualify
    ...baseSettings,
  },
  {
    name: "LADDER-2  front-loaded (60/40)",
    topN: 2,
    sizingScheme: "front-loaded",
    minProbability: 0.30,
    ...baseSettings,
  },
  {
    name: "LADDER-2  prob-weighted",
    topN: 2,
    sizingScheme: "weighted",
    minProbability: 0.30,
    ...baseSettings,
  },
  {
    name: "LADDER-3  front-loaded (50/30/20)",
    topN: 3,
    sizingScheme: "front-loaded",
    minProbability: 0.20,
    ...baseSettings,
  },
  {
    name: "LADDER-3  prob-weighted",
    topN: 3,
    sizingScheme: "weighted",
    minProbability: 0.20,
    ...baseSettings,
  },
];

// ─── Run ────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║   ENSEMBLE STRATEGY COMPARISON                                       ║
║   ${SERIES.toUpperCase()} forecast · entry T-${HOURS}h · ${variants.length} variants                   ║
╚══════════════════════════════════════════════════════════════════════╝

Tape: ${TAPE_PATH}
  ${tape.summary.eventsTotal} events · ${tape.summary.tradesTotal} trades · ${tape.seriesScanned.length} series
  Window: ${tape.windowStart.slice(0,10)} → ${tape.windowEnd.slice(0,10)}

Fetching ensemble forecasts (one per event, reused across variants)...
`);

const startMs = Date.now();
const result = await runComparisonBacktest(tape, variants, {
  entryHoursBefore: HOURS,
  series: SERIES,
  log: (msg) => console.log(msg),
});
const durSec = ((Date.now() - startMs) / 1000).toFixed(1);

console.log(`\nForecasts fetched in ${durSec}s · ${result.eventsWithForecast}/${result.totalEventsScanned} events had forecast data\n`);

// ─── Comparison table ─────────────────────────────────────────────

console.log("─".repeat(120));
console.log(
  `  ${"Variant".padEnd(36)}` +
  ` ${"Bets".padStart(5)}` +
  ` ${"Events".padStart(7)}` +
  ` ${"WR".padStart(7)}` +
  ` ${"W/L".padStart(7)}` +
  ` ${"AvgWin".padStart(8)}` +
  ` ${"AvgLoss".padStart(9)}` +
  ` ${"P&L/$".padStart(8)}` +
  ` ${"ROI".padStart(8)}`
);
console.log("─".repeat(120));

// Print baseline first, then sort the rest by ROI
const baselineResult = result.variantResults[0];
const others = result.variantResults.slice(1).sort((a, b) => b.roi - a.roi);
const ordered = [baselineResult, ...others];

for (const r of ordered) {
  const wrPct = (r.winRate * 100).toFixed(1) + "%";
  const wlRatio = r.winLossRatio.toFixed(2) + "×";
  const avgW = "+$" + r.avgWinUSD.toFixed(3);
  const avgL = "$" + r.avgLossUSD.toFixed(3);
  const roiPct = (r.roi >= 0 ? "+" : "") + (r.roi * 100).toFixed(1) + "%";
  const pnl = (r.totalPnL >= 0 ? "+$" : "-$") + Math.abs(r.totalPnL).toFixed(2);
  console.log(
    `  ${r.variant.name.padEnd(36)}` +
    ` ${String(r.bets).padStart(5)}` +
    ` ${String(r.events).padStart(7)}` +
    ` ${wrPct.padStart(7)}` +
    ` ${wlRatio.padStart(7)}` +
    ` ${avgW.padStart(8)}` +
    ` ${avgL.padStart(9)}` +
    ` ${pnl.padStart(8)}` +
    ` ${roiPct.padStart(8)}`
  );
}

console.log("─".repeat(120));
console.log();

// ─── Hit rate by rank — does the 2nd-best bracket actually win sometimes? ───

console.log("HIT RATE BY RANK (across each variant's eligible events)");
console.log("─".repeat(80));
console.log(`  ${"Variant".padEnd(36)}  rank-1   rank-2   rank-3`);
console.log("─".repeat(80));
for (const r of ordered) {
  const rates = r.hitRateByRank.slice(0, 3).map(h => (h * 100).toFixed(1) + "%");
  console.log(
    `  ${r.variant.name.padEnd(36)}  ${rates[0].padStart(6)}   ${rates[1].padStart(6)}   ${rates[2].padStart(6)}`
  );
}
console.log("─".repeat(80));
console.log();

// ─── Best variant + recommendation ─────────────────────────────────

const best = result.variantResults.reduce((a, b) => b.roi > a.roi ? b : a);
const baseline = result.variantResults[0];
const lift = best.roi - baseline.roi;
const liftPctOfBase = baseline.roi !== 0 ? (lift / Math.abs(baseline.roi)) * 100 : Infinity;

console.log(`BEST VARIANT: ${best.variant.name}`);
console.log(`  ROI: ${(best.roi * 100).toFixed(1)}% vs baseline ${(baseline.roi * 100).toFixed(1)}%`);
console.log(`  Lift over baseline: ${lift > 0 ? "+" : ""}${(lift * 100).toFixed(1)} percentage points`);
console.log(`  Total P&L on $1/event budget: ${best.totalPnL >= 0 ? "+$" : "-$"}${Math.abs(best.totalPnL).toFixed(2)} (${best.bets} bets across ${best.events} events)`);
console.log(`  Implied dollar P&L if scaled to $16/event: ${best.totalPnL >= 0 ? "+$" : "-$"}${Math.abs(best.totalPnL * 16).toFixed(2)}`);
console.log();

// Note about caveats
console.log("CAVEATS:");
console.log(`  - All variants use the same ${result.eventsWithForecast} events with forecast data.`);
console.log(`  - Backtest fetches 'past_days' forecasts which has mild hindsight bias, but it`);
console.log(`    affects all variants equally — RELATIVE comparison is meaningful.`);
console.log(`  - Real-world fills may differ slightly from tape's last-trade price.`);
console.log(`  - 7% Kalshi fee on net winnings is included in P&L.`);
console.log();
