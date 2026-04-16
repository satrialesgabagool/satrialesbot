#!/usr/bin/env bun
/**
 * Demo data seeder for the dashboard.
 *
 * Writes fake scanner signals to the JSONL file every few seconds
 * so you can see the dashboard update in real-time without running
 * the actual scanners (which need live Kalshi API access).
 *
 * Usage: bun run src/dashboard/seed-demo.ts
 *
 * What it does:
 *   1. Creates the results/ directory if it doesn't exist
 *   2. Every 3 seconds, generates a random weather edge or whale signal
 *   3. Appends it to results/high-conviction.jsonl (same file the real scanners write)
 *   4. The dashboard's SSE stream picks up the new line and pushes it to your browser
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const RESULTS_DIR = "results";
const JSONL_PATH = join(RESULTS_DIR, "high-conviction.jsonl");

if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

const CITIES = ["New York City", "Chicago", "Miami", "Los Angeles", "Denver", "Austin", "Boston"];
const SERIES = ["KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHLAX", "KXHIGHDEN", "KXHIGHAUS", "KXHIGHBOS"];

function randomWeatherSignal() {
  const i = Math.floor(Math.random() * CITIES.length);
  const city = CITIES[i];
  const series = SERIES[i];
  const date = new Date();
  date.setDate(date.getDate() + Math.floor(Math.random() * 3));
  const dateStr = date.toISOString().split("T")[0];
  const lowF = 60 + Math.floor(Math.random() * 30);
  const highF = lowF + 1 + Math.floor(Math.random() * 3);
  const edgeBps = 800 + Math.floor(Math.random() * 2500);
  const yesPrice = 5 + Math.floor(Math.random() * 30);
  const conviction = Math.round((edgeBps / 10000) * 0.8 * 1000) / 1000;

  return {
    timestamp: new Date().toISOString(),
    strategy: "weather" as const,
    eventTicker: `${series}-26APR${dateStr.slice(8)}`,
    marketTicker: `${series}-26APR${dateStr.slice(8)}-T${lowF}`,
    side: "yes",
    yesPrice,
    sizeContracts: 0,
    conviction,
    edgeBps,
    reason: `${city} high ${dateStr} [${lowF},${highF}°F]: ensemble=74.2°F±1.8 (4 src), model_p=${(yesPrice / 100 + edgeBps / 10000).toFixed(1)}% vs market=${(yesPrice / 100).toFixed(1)}%`,
    metadata: { city, type: "high", resolveDate: dateStr, hoursLeft: 12 + Math.random() * 36 },
  };
}

function randomWhaleSignal() {
  const i = Math.floor(Math.random() * CITIES.length);
  const series = SERIES[i];
  const notional = 5000 + Math.floor(Math.random() * 20000);
  const z = 3 + Math.random() * 4;
  const side = Math.random() > 0.5 ? "yes" : "no";

  return {
    timestamp: new Date().toISOString(),
    strategy: "whale" as const,
    eventTicker: "",
    marketTicker: `${series}-26APR16-T${70 + Math.floor(Math.random() * 20)}`,
    side,
    yesPrice: 30 + Math.floor(Math.random() * 40),
    sizeContracts: 0,
    conviction: Math.round(z * 0.15 * 1000) / 1000,
    edgeBps: 0,
    reason: `$${(notional / 1000).toFixed(1)}k ${side} flow in 5min, z=${z.toFixed(1)}, ${80 + Math.floor(Math.random() * 20)}% directional`,
    metadata: { notionalUsd: notional, zScore: z, windowSec: 300 },
  };
}

console.log("Seeding demo data to", JSONL_PATH);
console.log("Press Ctrl+C to stop\n");

let count = 0;
const interval = setInterval(() => {
  // 70% chance weather, 30% chance whale
  const signal = Math.random() > 0.3 ? randomWeatherSignal() : randomWhaleSignal();
  appendFileSync(JSONL_PATH, JSON.stringify(signal) + "\n");
  count++;
  console.log(`  #${count} ${signal.strategy} → ${signal.marketTicker}`);
}, 3000);

process.on("SIGINT", () => {
  clearInterval(interval);
  console.log(`\nSeeded ${count} demo signals. Dashboard should show them!`);
  process.exit(0);
});
