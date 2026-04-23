#!/usr/bin/env bun
/**
 * Kalshi Weather Tape Analyzer — runner.
 *
 * Reads a collected tape and prints the bucket analysis.
 *
 * Usage:
 *   ~/.bun/bin/bun kalshi-tape-report.ts
 *   ~/.bun/bin/bun kalshi-tape-report.ts --tape data/kalshi-weather-tape.json
 */

import { readFileSync, existsSync } from "fs";
import { bucketAnalysis, overallSummary, type BucketStats } from "./src/kalshi/WeatherTapeAnalyzer";
import type { Tape } from "./src/kalshi/WeatherTapeCollector";

const args = process.argv.slice(2);
const idx = args.indexOf("--tape");
const TAPE_PATH = idx >= 0 ? args[idx + 1] : "data/kalshi-weather-tape.json";

if (!existsSync(TAPE_PATH)) {
  console.error(`❌ Tape file not found: ${TAPE_PATH}`);
  console.error(`Run kalshi-tape-collect.ts first.`);
  process.exit(1);
}

const tape: Tape = JSON.parse(readFileSync(TAPE_PATH, "utf-8"));

console.log(`\n╔═══════════════════════════════════════════╗`);
console.log(`║   KALSHI WEATHER TAPE ANALYSIS            ║`);
console.log(`╚═══════════════════════════════════════════╝\n`);
console.log(`Window:     ${tape.windowStart.slice(0, 10)} → ${tape.windowEnd.slice(0, 10)}`);
console.log(`Generated:  ${tape.generatedAt}`);
console.log(`Events:     ${tape.summary.eventsTotal}`);
console.log(`Markets:    ${tape.summary.marketsTotal}`);
console.log(`Trades:     ${tape.summary.tradesTotal}`);
console.log();

const sum = overallSummary(tape);
console.log(`── OVERALL (takers held to settlement) ──`);
console.log(`  Fills:        ${sum.fills}`);
console.log(`  Wins/Losses:  ${sum.wins}W-${sum.losses}L  (${(sum.winRate * 100).toFixed(1)}% WR)`);
console.log(`  Total shares: ${sum.totalShares.toFixed(0)}`);
console.log(`  Total PnL:    $${sum.totalPnL.toFixed(2)}`);
console.log(`  Per-share:    $${sum.pnlPerShare.toFixed(4)}`);
console.log();

const tableRow = (s: BucketStats) => {
  const pnlStr = (s.totalPnL >= 0 ? "+" : "") + s.totalPnL.toFixed(2);
  const perShare = (s.pnlPerShare >= 0 ? "+" : "") + s.pnlPerShare.toFixed(4);
  const price = s.avgPrice.toFixed(3);
  return `  ${s.bucket.padEnd(28)}  ${String(s.fills).padStart(7)}  ${s.wins}W-${s.losses}L  ${(s.winRate * 100).toFixed(1).padStart(5)}%  $${price}  ${pnlStr.padStart(9)}  ${perShare}/sh`;
};

function section(title: string, stats: BucketStats[]) {
  console.log(`── ${title} ──`);
  console.log(`  ${"Bucket".padEnd(28)}  ${"Fills".padStart(7)}  W-L          WR     AvgPx   TotalPnL    Per-share`);
  for (const s of stats) console.log(tableRow(s));
  console.log();
}

const buckets = bucketAnalysis(tape);
section("BY PRICE BUCKET", buckets.byPrice);
section("BY TIME-TO-CLOSE", buckets.byTime);
section("BY BRACKET TYPE", buckets.byBracket);
section("BY CITY", buckets.byCity);

// Top 15 price × time combined buckets by total PnL magnitude
const topCombined = [...buckets.byPriceTime]
  .filter(s => s.fills >= 10)  // ignore tiny samples
  .sort((a, b) => b.totalPnL - a.totalPnL)
  .slice(0, 15);
section("TOP PRICE × TIME COMBOS (≥10 fills, sorted by PnL)", topCombined);

console.log(`────────────────────────────────────────────`);
console.log(`Key questions to ask:`);
console.log(`  • Which price bucket is most profitable? (look for +PnL + high WR)`);
console.log(`  • Does "close to resolution + cheap" bleed like BTC?`);
console.log(`  • Is our usual entry zone ($0.05-0.20) actually profitable?`);
console.log(`  • Which city has positive per-share PnL?`);
console.log();
