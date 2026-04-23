#!/usr/bin/env bun
/**
 * Kalshi Weather Tape Replay — intrinsic-winner strategy runner.
 *
 * Reads the tape and simulates the new strategy against historical resolutions.
 *
 * Usage:
 *   ~/.bun/bin/bun kalshi-tape-replay.ts
 *   ~/.bun/bin/bun kalshi-tape-replay.ts --hours 6 --min-price 0.75
 *   ~/.bun/bin/bun kalshi-tape-replay.ts --tape data/kalshi-weather-tape.json --bet-size 3
 */

import { readFileSync, existsSync } from "fs";
import { replay, DEFAULT_REPLAY_CONFIG } from "./src/kalshi/WeatherTapeReplay";
import type { Tape } from "./src/kalshi/WeatherTapeCollector";

const args = process.argv.slice(2);
function argVal<T>(flag: string, fallback: T, parse: (s: string) => T = String as any): T {
  const idx = args.indexOf(flag);
  return idx >= 0 ? parse(args[idx + 1]) : fallback;
}

const TAPE_PATH = argVal("--tape", "data/kalshi-weather-tape.json");
const HOURS = argVal("--hours", DEFAULT_REPLAY_CONFIG.entryHoursBefore, parseFloat);
const WINDOW = argVal("--window", DEFAULT_REPLAY_CONFIG.entryWindowHours, parseFloat);
const MIN_PRICE = argVal("--min-price", DEFAULT_REPLAY_CONFIG.minPrice, parseFloat);
const MAX_PRICE = argVal("--max-price", DEFAULT_REPLAY_CONFIG.maxPrice, parseFloat);
const BET_SIZE = argVal("--bet-size", DEFAULT_REPLAY_CONFIG.betSize, parseFloat);
const MIN_GAP = argVal("--min-gap", DEFAULT_REPLAY_CONFIG.minFavoriteGap, parseFloat);
const VERBOSE = args.includes("--verbose");

if (!existsSync(TAPE_PATH)) {
  console.error(`❌ Tape not found: ${TAPE_PATH}`);
  process.exit(1);
}

const tape: Tape = JSON.parse(readFileSync(TAPE_PATH, "utf-8"));

console.log(`
╔═══════════════════════════════════════════╗
║   KALSHI TAPE REPLAY — INTRINSIC STRATEGY ║
╚═══════════════════════════════════════════╝

Config:
  Entry:        ${HOURS}h before close (±${WINDOW}h window)
  Price range:  $${MIN_PRICE.toFixed(2)} - $${MAX_PRICE.toFixed(2)}
  Min gap:      $${MIN_GAP.toFixed(2)} above runner-up
  Bet size:     $${BET_SIZE.toFixed(2)} per event
  Fee:          7% on net winnings

Tape: ${tape.summary.eventsTotal} events, ${tape.summary.tradesTotal} trades
Window: ${tape.windowStart.slice(0, 10)} → ${tape.windowEnd.slice(0, 10)}
`);

const result = replay(tape, {
  entryHoursBefore: HOURS,
  entryWindowHours: WINDOW,
  minPrice: MIN_PRICE,
  maxPrice: MAX_PRICE,
  betSize: BET_SIZE,
  minFavoriteGap: MIN_GAP,
});

console.log(`── RESULTS ──`);
console.log(`  Bets placed:     ${result.summary.total}`);
console.log(`  Resolved:        ${result.summary.wins + result.summary.losses} (${result.summary.unresolved} unresolved)`);
console.log(`  W/L:             ${result.summary.wins}W-${result.summary.losses}L (${(result.summary.winRate * 100).toFixed(1)}% WR)`);
console.log(`  Avg entry:       $${result.summary.avgEntry.toFixed(3)}`);
console.log(`  Total cost:      $${result.summary.totalCost.toFixed(2)}`);
const pnlSign = result.summary.totalPnL >= 0 ? "+" : "";
console.log(`  Total PnL:       ${pnlSign}$${result.summary.totalPnL.toFixed(2)}`);
console.log(`  ROI:             ${pnlSign}${(result.summary.roi * 100).toFixed(1)}%`);
console.log();

console.log(`── PER CITY ──`);
console.log(`  ${"City".padEnd(16)} ${"Bets".padStart(5)}  ${"W".padStart(3)}  ${"Cost".padStart(8)}  ${"PnL".padStart(9)}  ${"ROI".padStart(6)}`);
const cities = Object.entries(result.perCity).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [city, s] of cities) {
  const pnlStr = (s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2);
  const roiStr = (s.roi >= 0 ? "+" : "") + (s.roi * 100).toFixed(1) + "%";
  console.log(`  ${city.padEnd(16)} ${String(s.bets).padStart(5)}  ${String(s.wins).padStart(3)}  $${s.cost.toFixed(2).padStart(7)}  $${pnlStr.padStart(8)}  ${roiStr.padStart(6)}`);
}
console.log();

if (VERBOSE) {
  console.log(`── BETS ──`);
  console.log(`  ${"Date".padEnd(11)} ${"City".padEnd(15)} ${"Bracket".padEnd(12)} ${"Entry".padStart(7)} ${"RunUp".padStart(7)} ${"Result".padStart(6)} ${"PnL".padStart(8)}`);
  for (const b of result.bets) {
    const res = b.won === null ? "?" : b.won ? "WIN" : "LOSS";
    const pnlStr = b.won === null ? "-" : (b.pnl >= 0 ? "+" : "") + b.pnl.toFixed(2);
    console.log(`  ${(b.date ?? "").padEnd(11)} ${(b.city ?? "?").padEnd(15)} ${(b.bracketLabel ?? "?").padEnd(12)} $${b.entryPrice.toFixed(3).padStart(5)} $${b.runnerUpPrice.toFixed(3).padStart(5)} ${res.padStart(6)} $${pnlStr.padStart(7)}`);
  }
}
