#!/usr/bin/env bun
/**
 * Kalshi Weather Tape Collector — runner.
 *
 * Pulls past N days of KXHIGH markets + every trade on each market.
 * Output: data/kalshi-weather-tape.json
 *
 * Usage:
 *   ~/.bun/bin/bun kalshi-tape-collect.ts --days 14
 *   ~/.bun/bin/bun kalshi-tape-collect.ts --days 30 --out data/tape-30d.json
 */

import { KalshiClient } from "./src/kalshi/KalshiClient";
import { loadCredentialsFromEnv } from "./src/kalshi/KalshiAuth";
import { collectWeatherTape } from "./src/kalshi/WeatherTapeCollector";

const args = process.argv.slice(2);
function argVal<T>(flag: string, fallback: T, parse: (s: string) => T = String as any): T {
  const idx = args.indexOf(flag);
  return idx >= 0 ? parse(args[idx + 1]) : fallback;
}

const DAYS_BACK = argVal("--days", 14, parseInt);
const OUT_PATH = argVal("--out", "data/kalshi-weather-tape.json");

// Credentials are optional for market-data pulls, but auth makes pagination cleaner
const creds = loadCredentialsFromEnv();
const client = new KalshiClient({ demo: false, credentials: creds ?? undefined });

console.log(`
  ╔═══════════════════════════════════════════╗
  ║   KALSHI WEATHER TAPE COLLECTOR           ║
  ╚═══════════════════════════════════════════╝

  Days back: ${DAYS_BACK}
  Output:    ${OUT_PATH}
  Auth:      ${creds ? "YES (faster pagination)" : "NO (public only)"}

`);

await collectWeatherTape({
  daysBack: DAYS_BACK,
  client,
  outputPath: OUT_PATH,
  log: (msg) => console.log(msg),
});

console.log("\n✓ Tape collection complete.\n");
