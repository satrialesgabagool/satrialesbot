#!/usr/bin/env bun
/**
 * Kalshi-ww-bot unified CLI.
 *
 *   bun run src/kalshi/cli.ts weather           # run weather scanner only
 *   bun run src/kalshi/cli.ts whale             # run whale scanner only
 *   bun run src/kalshi/cli.ts both              # run both concurrently
 *
 * Paper-only today. Hits Kalshi demo API by default. Set KALSHI_ENV=prod
 * and provide KALSHI_ACCESS_KEY + KALSHI_PRIVATE_KEY_PEM to authenticate
 * against production (read-only is unauthed on both; auth only matters
 * once we add order placement).
 *
 * High-conviction rows stream to RESULTS_DIR/high-conviction.csv
 * (default: ./results/high-conviction.csv).
 */

import { Command } from "commander";
import { join } from "path";
import { KalshiClient } from "./client/KalshiClient";
import { HighConvictionLog } from "./output/HighConvictionLog";
import { WeatherScanner, DEFAULT_WEATHER_SCANNER_CONFIG } from "./weather/WeatherScanner";
import { WhaleScanner, DEFAULT_WHALE_SCANNER_CONFIG } from "./whale/WhaleScanner";

function buildClient(): KalshiClient {
  const env = (process.env.KALSHI_ENV as "demo" | "prod" | undefined) ?? "demo";
  return new KalshiClient({
    env,
    accessKey: process.env.KALSHI_ACCESS_KEY,
    privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM,
  });
}

function buildLog(): HighConvictionLog {
  const resultsDir = process.env.RESULTS_DIR ?? "results";
  const path = join(resultsDir, "high-conviction.csv");
  return new HighConvictionLog(path);
}

function wireShutdown(stops: (() => void)[]): void {
  const shutdown = (signal: string) => {
    console.log(`\n[cli] ${signal} received — shutting down`);
    for (const stop of stops) {
      try {
        stop();
      } catch {}
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function header(): void {
  console.log(`
╔═══════════════════════════════════════════╗
║   K A L S H I   W E A T H E R & W H A L E  ║
║   scanner (paper)                           ║
╚═══════════════════════════════════════════╝
`);
}

const program = new Command();

program.name("kalshi-ww-bot").description("Kalshi weather-ensemble + whale scanner").version("0.1.0");

program
  .command("weather")
  .description("Run the weather-ensemble edge scanner")
  .option("--min-edge-bps <n>", "Minimum edge bps to emit (default 1000 = 10%)", String(DEFAULT_WEATHER_SCANNER_CONFIG.minEdgeBps))
  .option("--max-spread <f>", "Max ensemble °F spread (default 4)", String(DEFAULT_WEATHER_SCANNER_CONFIG.maxSpreadF))
  .option("--max-horizon <h>", "Max hours until resolution (default 48)", String(DEFAULT_WEATHER_SCANNER_CONFIG.maxHorizonHours))
  .option("--interval <s>", "Scan cadence in seconds (default 300)", String(DEFAULT_WEATHER_SCANNER_CONFIG.intervalMs / 1000))
  .action(async (opts) => {
    header();
    const client = buildClient();
    const log = buildLog();
    const scanner = new WeatherScanner(client, log, {
      ...DEFAULT_WEATHER_SCANNER_CONFIG,
      minEdgeBps: parseInt(opts.minEdgeBps, 10),
      maxSpreadF: parseFloat(opts.maxSpread),
      maxHorizonHours: parseInt(opts.maxHorizon, 10),
      intervalMs: parseInt(opts.interval, 10) * 1000,
    });
    wireShutdown([() => scanner.stop()]);
    await scanner.start();
  });

program
  .command("whale")
  .description("Run the whale-flow scanner")
  .option("--min-notional <usd>", "Minimum window notional USD (default 5000)", String(DEFAULT_WHALE_SCANNER_CONFIG.detector.minNotionalUsd))
  .option("--min-directionality <pct>", "Dominant-side threshold 0..1 (default 0.7)", String(DEFAULT_WHALE_SCANNER_CONFIG.detector.minDirectionality))
  .option("--min-z <z>", "Minimum z-score vs baseline (default 3)", String(DEFAULT_WHALE_SCANNER_CONFIG.detector.minZScore))
  .option("--short-window <s>", "Short window seconds (default 300)", String(DEFAULT_WHALE_SCANNER_CONFIG.volume.shortWindowMs / 1000))
  .option("--baseline-window <s>", "Baseline window seconds (default 3600)", String(DEFAULT_WHALE_SCANNER_CONFIG.volume.baselineWindowMs / 1000))
  .option("--feed <mode>", "Feed mode: poll | ws (default poll)", "poll")
  .action(async (opts) => {
    header();
    const client = buildClient();
    const log = buildLog();
    const scanner = new WhaleScanner(client, log, {
      ...DEFAULT_WHALE_SCANNER_CONFIG,
      volume: {
        shortWindowMs: parseInt(opts.shortWindow, 10) * 1000,
        baselineWindowMs: parseInt(opts.baselineWindow, 10) * 1000,
      },
      detector: {
        ...DEFAULT_WHALE_SCANNER_CONFIG.detector,
        minNotionalUsd: parseFloat(opts.minNotional),
        minDirectionality: parseFloat(opts.minDirectionality),
        minZScore: parseFloat(opts.minZ),
      },
      feed: {
        ...DEFAULT_WHALE_SCANNER_CONFIG.feed,
        mode: opts.feed === "ws" ? "ws" : "poll",
      },
    });
    wireShutdown([() => scanner.stop()]);
    await scanner.start();
  });

program
  .command("both")
  .description("Run weather + whale scanners concurrently")
  .action(async () => {
    header();
    const client = buildClient();
    const log = buildLog();
    const weather = new WeatherScanner(client, log);
    const whale = new WhaleScanner(client, log);
    wireShutdown([() => weather.stop(), () => whale.stop()]);
    await Promise.all([weather.start(), whale.start()]);
  });

program.parse();
