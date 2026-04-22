#!/usr/bin/env bun
/**
 * Weather Temperature Markets — CLI entry point.
 *
 * Usage:
 *   bun run src/weather/index.ts                  # Paper trade, $20 bankroll
 *   bun run src/weather/index.ts --bankroll 50    # Custom bankroll
 *   bun run src/weather/index.ts --min-edge 0.10  # 10% min edge (default 8%)
 *   bun run src/weather/index.ts --cities nyc,chicago  # Focus on specific cities
 *   bun run src/weather/index.ts --scan-once      # Single scan, no loop
 */

import { WeatherEngine } from "./WeatherEngine";
import { DEFAULT_WEATHER_CONFIG, type WeatherEngineConfig } from "./types";

function parseArgs(): WeatherEngineConfig {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_WEATHER_CONFIG };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--bankroll":
        config.bankroll = parseFloat(args[++i]) || 20;
        break;
      case "--min-edge":
        config.minEdge = parseFloat(args[++i]) || 0.08;
        break;
      case "--kelly":
        config.kellyFraction = parseFloat(args[++i]) || 0.25;
        break;
      case "--max-position":
        config.maxPositionPct = parseFloat(args[++i]) || 0.25;
        break;
      case "--scan-interval":
        config.scanIntervalMs = (parseFloat(args[++i]) || 15) * 60 * 1000;
        break;
      case "--days-ahead":
        config.daysAhead = parseInt(args[++i]) || 3;
        break;
      case "--cities":
        config.cities = args[++i].split(",").map(c => c.trim());
        break;
      case "--prod":
      case "--live":
        config.mode = "prod";
        break;
      case "--scan-once":
        // Will be handled after engine creation
        break;
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();
  const scanOnce = process.argv.includes("--scan-once");

  // Safety: require explicit --live flag for production
  if (config.mode === "prod") {
    console.log("\x1b[31mPRODUCTION MODE — Real funds will be used!\x1b[0m");
    console.log("Press Ctrl+C within 5 seconds to abort...");
    await new Promise(r => setTimeout(r, 5000));
  }

  const engine = new WeatherEngine(config);

  if (scanOnce) {
    // Run a single scan and exit
    await engine.start();
    engine.shutdown();
    process.exit(0);
  } else {
    await engine.start();
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
