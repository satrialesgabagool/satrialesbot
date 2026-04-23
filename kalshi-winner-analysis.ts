#!/usr/bin/env bun
/**
 * Winner Price Analysis — the ceiling of opportunity for forecast-based strategy.
 *
 * Shows for each resolved event: how expensive was the actual winner at various
 * hours before close? If winners are consistently cheap (say, $0.30-$0.50) at
 * T-12h, then an accurate forecast could extract alpha by buying before the
 * market converges. If they're already $0.70+, the market figures it out first.
 */

import { readFileSync, existsSync } from "fs";
import { winnerPriceAnalysis, summarizeWinnerPrices } from "./src/kalshi/WeatherWinnerAnalysis";
import type { Tape } from "./src/kalshi/WeatherTapeCollector";

const args = process.argv.slice(2);
const idx = args.indexOf("--tape");
const TAPE_PATH = idx >= 0 ? args[idx + 1] : "data/kalshi-weather-tape.json";

if (!existsSync(TAPE_PATH)) {
  console.error(`Tape not found: ${TAPE_PATH}`);
  process.exit(1);
}

const tape: Tape = JSON.parse(readFileSync(TAPE_PATH, "utf-8"));
const snapshots = winnerPriceAnalysis(tape);
const summary = summarizeWinnerPrices(snapshots);

console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
console.log(`║   WINNER PRICE ANALYSIS — ceiling of forecast strategy           ║`);
console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);
console.log(`Tape: ${tape.summary.eventsTotal} events, ${tape.summary.tradesTotal} trades`);
console.log(`Winners analyzed: ${snapshots.length}\n`);

console.log(`How did the ACTUAL winning bracket's price evolve?`);
console.log();
console.log(`  ${"Horizon".padEnd(8)} ${"N".padStart(3)}  ${"Mean".padStart(6)}  ${"Median".padStart(6)}  ${"P25".padStart(6)}  ${"P75".padStart(6)}  ${"≤$0.40".padStart(7)}  ${"≤$0.20".padStart(7)}`);
console.log(`  ${"─".repeat(68)}`);
for (const [h, s] of Object.entries(summary)) {
  const cheapPct = s.n > 0 ? (s.cheapCount / s.n * 100).toFixed(0) + "%" : "—";
  const verycheapPct = s.n > 0 ? (s.verycheapCount / s.n * 100).toFixed(0) + "%" : "—";
  console.log(`  ${h.padEnd(8)} ${String(s.n).padStart(3)}  $${s.mean.toFixed(3)}  $${s.median.toFixed(3)}  $${s.p25.toFixed(3)}  $${s.p75.toFixed(3)}  ${cheapPct.padStart(7)}  ${verycheapPct.padStart(7)}`);
}

console.log();
console.log("Interpretation:");
console.log("  • If winners at T-12h are mostly $0.30-$0.50 → room for forecast edge");
console.log("  • If winners at T-12h are mostly $0.70+ → market beats us to it");
console.log("  • Large P75 / small P25 gap → variance means some events are easy to predict,");
console.log("    others surprise the market late");
console.log();

// Show a few specific examples
console.log(`Sample winners (15 random events):`);
console.log(`  ${"Event".padEnd(30)} ${"Winner".padEnd(16)} ${"T-24h".padStart(7)} ${"T-12h".padStart(7)} ${"T-8h".padStart(7)} ${"T-4h".padStart(7)} ${"T-2h".padStart(7)}`);
const sample = snapshots.slice(0, 15);
for (const s of sample) {
  const p24 = s.priceByHours["T-24h"];
  const p12 = s.priceByHours["T-12h"];
  const p8 = s.priceByHours["T-8h"];
  const p4 = s.priceByHours["T-4h"];
  const p2 = s.priceByHours["T-2h"];
  const fmt = (p: number | null) => p === null ? "—" : "$" + p.toFixed(2);
  console.log(`  ${(s.eventTicker.slice(0, 30)).padEnd(30)} ${(s.winnerLabel ?? "?").slice(0, 16).padEnd(16)} ${fmt(p24).padStart(7)} ${fmt(p12).padStart(7)} ${fmt(p8).padStart(7)} ${fmt(p4).padStart(7)} ${fmt(p2).padStart(7)}`);
}
console.log();
