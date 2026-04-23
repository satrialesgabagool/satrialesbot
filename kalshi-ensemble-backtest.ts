#!/usr/bin/env bun
/**
 * Runs the ensemble-forecast backtest and prints results.
 *
 * Usage:
 *   ~/.bun/bin/bun kalshi-ensemble-backtest.ts
 *   ~/.bun/bin/bun kalshi-ensemble-backtest.ts --hours 24 --min-prob 0.40 --max-price 0.60
 */

import { readFileSync, existsSync } from "fs";
import { runEnsembleBacktest } from "./src/kalshi/WeatherEnsembleBacktest";
import type { Tape } from "./src/kalshi/WeatherTapeCollector";

const args = process.argv.slice(2);
function argVal<T>(flag: string, fallback: T, parse: (s: string) => T = String as any): T {
  const idx = args.indexOf(flag);
  return idx >= 0 ? parse(args[idx + 1]) : fallback;
}

const TAPE_PATH = argVal("--tape", "data/kalshi-weather-tape.json");
const HOURS = argVal("--hours", 24, parseInt);
const MIN_PROB = argVal("--min-prob", 0.40, parseFloat);
const MAX_PRICE = argVal("--max-price", 0.60, parseFloat);

if (!existsSync(TAPE_PATH)) {
  console.error(`Tape not found: ${TAPE_PATH}`);
  process.exit(1);
}

const tape: Tape = JSON.parse(readFileSync(TAPE_PATH, "utf-8"));

console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
console.log(`║   ENSEMBLE FORECAST BACKTEST                                     ║`);
console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);
console.log(`Tape: ${tape.summary.eventsTotal} events`);
console.log(`Entry at T-${HOURS}h, min ensemble prob ${MIN_PROB}, max price $${MAX_PRICE.toFixed(2)}\n`);
console.log(`Fetching 82-member ensembles for each event (this takes 2-5 min)...\n`);

const startMs = Date.now();
const result = await runEnsembleBacktest(tape, {
  entryHoursBefore: HOURS,
  minProbability: MIN_PROB,
  maxEntryPrice: MAX_PRICE,
  log: (msg) => { /* silent by default */ },
});
const durSec = ((Date.now() - startMs) / 1000).toFixed(1);

console.log(`Done in ${durSec}s.\n`);

// Summary
const s = result.summary;
console.log(`── ENSEMBLE ACCURACY ──`);
console.log(`  Events:          ${s.totalEvents}`);
console.log(`  With forecast:   ${s.eventsWithForecast}`);
console.log(`  Correct picks:   ${s.correctPicks} / ${s.eventsWithForecast} = ${(s.accuracy * 100).toFixed(1)}%`);
console.log();
console.log(`── SIMULATED P&L (at T-${HOURS}h entry, if ensemble prob ≥ ${MIN_PROB} & price ≤ $${MAX_PRICE}) ──`);
console.log(`  Bets placed:     ${s.bets}`);
console.log(`  Wins/Losses:     ${s.wins}W-${s.losses}L (${s.wins + s.losses > 0 ? (s.wins / (s.wins + s.losses) * 100).toFixed(1) : "—"}% WR)`);
console.log(`  Avg entry:       $${s.avgEntryPrice.toFixed(3)}`);
console.log(`  Break-even WR:   ${(s.breakEvenWR * 100).toFixed(1)}% (need WR above this to profit at these prices)`);
console.log(`  Total cost:      $${s.totalCost.toFixed(2)}`);
const pnlSign = s.totalPnL >= 0 ? "+" : "";
console.log(`  Total PnL:       ${pnlSign}$${s.totalPnL.toFixed(2)}`);
console.log(`  ROI:             ${pnlSign}${(s.roi * 100).toFixed(1)}%`);
console.log();

// Per-prediction detail (first 20)
console.log(`── SAMPLE PREDICTIONS (first 20) ──`);
console.log(`  ${"Event".padEnd(22)} ${"Predicted".padEnd(14)} ${"Actual".padEnd(14)} ${"Prob".padStart(5)} ${"Px@24h".padStart(7)} ${"Outcome".padStart(8)}`);
for (const p of result.predictions.slice(0, 20)) {
  const prob = (p.predictedProb * 100).toFixed(0) + "%";
  const px = p.entryPriceAt24h === null ? "—" : "$" + p.entryPriceAt24h.toFixed(2);
  const outcome = p.correct ? "✓ CORRECT" : "✗ wrong";
  console.log(`  ${(p.eventTicker.slice(0, 22)).padEnd(22)} ${(p.predictedLabel ?? "—").slice(0, 14).padEnd(14)} ${(p.actualLabel ?? "—").slice(0, 14).padEnd(14)} ${prob.padStart(5)} ${px.padStart(7)} ${outcome.padStart(8)}`);
}
console.log();

// Accuracy by city
const cities = new Map<string, { correct: number; total: number }>();
for (const p of result.predictions) {
  const c = p.city ?? "?";
  if (!cities.has(c)) cities.set(c, { correct: 0, total: 0 });
  const s = cities.get(c)!;
  if (p.predictedTicker !== null) {
    s.total++;
    if (p.correct) s.correct++;
  }
}
console.log(`── ACCURACY BY CITY ──`);
for (const [city, s] of [...cities].sort((a, b) => (b[1].correct / Math.max(1, b[1].total)) - (a[1].correct / Math.max(1, a[1].total)))) {
  if (s.total === 0) continue;
  console.log(`  ${city.padEnd(16)} ${String(s.correct).padStart(3)}/${String(s.total).padStart(3)} = ${(s.correct / s.total * 100).toFixed(0).padStart(3)}%`);
}
console.log();
