#!/usr/bin/env bun
/**
 * Run both trading engines simultaneously.
 *
 * Launches:
 *   1. Weather Temperature Markets engine (scans every 15 min)
 *   2. BTC 5-Min Snipe V2 engine (runs continuously)
 *
 * Both run in paper mode by default ($20 bankroll each).
 * Results are written to results/ directory for analysis.
 *
 * Usage:
 *   bun run run-both.ts                   # Both engines, paper mode
 *   bun run run-both.ts --btc-only        # BTC snipe only
 *   bun run run-both.ts --weather-only    # Weather only
 *   bun run run-both.ts --bankroll 50     # Custom bankroll
 *
 * Ctrl+C stops both gracefully.
 */

import { spawn, type ChildProcess } from "child_process";
import { join } from "path";

// ANSI colors
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

// Parse args
const args = process.argv.slice(2);
const btcOnly = args.includes("--btc-only");
const weatherOnly = args.includes("--weather-only");
const bankrollIdx = args.indexOf("--bankroll");
const bankroll = bankrollIdx >= 0 ? args[bankrollIdx + 1] : "20";
const btcStrategy = args.includes("--strategy") ?
  args[args.indexOf("--strategy") + 1] : "snipe-v2";

const processes: { name: string; proc: ChildProcess }[] = [];

function log(prefix: string, color: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!clean) return;
  console.log(`${C.dim}[${ts}]${C.reset} ${color}[${prefix}]${C.reset} ${clean}`);
}

function launchWeather(): ChildProcess {
  log("ORCH", C.cyan, "Starting Weather Temperature Engine...");

  const proc = spawn("bun", [
    "run", "src/weather/index.ts",
    "--bankroll", bankroll,
    "--min-edge", "0.08",
    "--scan-interval", "15",
  ], {
    cwd: import.meta.dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  proc.stdout?.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) log("WX", C.blue, line);
    }
  });

  proc.stderr?.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) log("WX", C.red, line);
    }
  });

  proc.on("close", (code) => {
    log("WX", code === 0 ? C.green : C.red, `Weather engine exited (code ${code})`);
  });

  return proc;
}

function launchBTC(): ChildProcess {
  log("ORCH", C.cyan, `Starting BTC 5-Min Engine (strategy: ${btcStrategy})...`);

  const proc = spawn("bun", [
    "run", "src/index.ts",
    "--strategy", btcStrategy,
    "--rounds", "-1",
    "--always-log",
  ], {
    cwd: import.meta.dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WALLET_BALANCE: bankroll },
  });

  proc.stdout?.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!clean) continue;

      // Filter noise, show important events
      if (clean.includes("SNIPE") || clean.includes("ARB") ||
          clean.includes("filled") || clean.includes("DONE") ||
          clean.includes("Session PnL") || clean.includes("market:") ||
          clean.includes("Components:") || clean.includes("Error") ||
          clean.includes("Engine") || clean.includes("===")) {
        log("BTC", C.magenta, line);
      }
    }
  });

  proc.stderr?.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) log("BTC", C.red, line);
    }
  });

  proc.on("close", (code) => {
    log("BTC", code === 0 ? C.green : C.red, `BTC engine exited (code ${code})`);
  });

  return proc;
}

// Graceful shutdown
function shutdownAll() {
  log("ORCH", C.yellow, "Shutting down all engines...");
  for (const { name, proc } of processes) {
    if (!proc.killed) {
      log("ORCH", C.yellow, `Stopping ${name}...`);
      proc.kill("SIGTERM");
    }
  }

  // Force kill after 10 seconds
  setTimeout(() => {
    for (const { proc } of processes) {
      if (!proc.killed) proc.kill("SIGKILL");
    }
    process.exit(0);
  }, 10_000);
}

process.on("SIGINT", shutdownAll);
process.on("SIGTERM", shutdownAll);

// ─── Main ───────────────────────────────────────────────────────────

console.log(`
${C.cyan}${C.bold}  ╔═══════════════════════════════════════════════╗
  ║          SATRIALES DUAL ENGINE                ║
  ║   Weather + BTC 5-Min · Running in Parallel   ║
  ╚═══════════════════════════════════════════════╝${C.reset}

  ${C.dim}Bankroll:${C.reset}    $${bankroll} per engine
  ${C.dim}Weather:${C.reset}     ${weatherOnly || !btcOnly ? "ACTIVE (15-min scan)" : "DISABLED"}
  ${C.dim}BTC 5-Min:${C.reset}   ${btcOnly || !weatherOnly ? `ACTIVE (${btcStrategy})` : "DISABLED"}
  ${C.dim}Mode:${C.reset}        Paper trading (sim)
  ${C.dim}Results:${C.reset}     results/weather-trades.csv + results/simulations.csv
  ${C.dim}Logs:${C.reset}        logs/
`);

// Launch engines
if (!btcOnly) {
  const weatherProc = launchWeather();
  processes.push({ name: "Weather", proc: weatherProc });
}

if (!weatherOnly) {
  // Small delay so weather starts first (less output interleaving)
  setTimeout(() => {
    const btcProc = launchBTC();
    processes.push({ name: "BTC", proc: btcProc });
  }, 2000);
}

log("ORCH", C.green, "Both engines launched. Press Ctrl+C to stop.");
log("ORCH", C.dim, "Weather data → results/weather-trades.csv, weather-opportunities.csv");
log("ORCH", C.dim, "BTC data → results/simulations.csv, logs/");
