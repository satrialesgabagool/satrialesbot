#!/usr/bin/env bun
/**
 * Satriales Dashboard — launches both trading engines + web GUI.
 *
 * Starts:
 *   1. Dashboard HTTP server on port 3000 (this process)
 *   2. Weather Temperature Markets engine (child process)
 *   3. BTC 5-Min Snipe V2 engine (child process)
 *
 * The dashboard reads state files written by both engines and serves
 * a live-updating web UI at http://localhost:3000.
 *
 * Usage:
 *   bun run dashboard.ts                        # Full dashboard + both engines
 *   bun run dashboard.ts --btc-only             # Dashboard + BTC only
 *   bun run dashboard.ts --weather-only         # Dashboard + Weather only
 *   bun run dashboard.ts --dashboard-only       # Dashboard only (no engines)
 *   bun run dashboard.ts --port 8080            # Custom port
 *   bun run dashboard.ts --bankroll 50          # Custom bankroll
 *   bun run dashboard.ts --strategy snipe-v2    # BTC strategy
 *
 * Ctrl+C stops everything gracefully.
 */

import { spawn, type ChildProcess } from "child_process";
import { startDashboard } from "./src/dashboard/server";

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
const dashboardOnly = args.includes("--dashboard-only");
const portIdx = args.indexOf("--port");
const port = portIdx >= 0
  ? parseInt(args[portIdx + 1]) || 3000
  : parseInt(process.env.PORT || "3000");
const bankrollIdx = args.indexOf("--bankroll");
const bankroll = bankrollIdx >= 0 ? args[bankrollIdx + 1] : "20";
const strategyIdx = args.indexOf("--strategy");
const btcStrategy = strategyIdx >= 0 ? args[strategyIdx + 1] : "snipe-v2";

const children: { name: string; proc: ChildProcess }[] = [];

function log(prefix: string, color: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!clean) return;
  console.log(`${C.dim}[${ts}]${C.reset} ${color}[${prefix}]${C.reset} ${clean}`);
}

function launchWeather(): ChildProcess {
  log("DASH", C.blue, "Starting Weather Temperature Engine...");

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

  proc.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) log("WX", C.blue, line);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) log("WX", C.red, line);
    }
  });

  proc.on("close", (code) => {
    log("WX", code === 0 ? C.green : C.red, `Weather engine exited (code ${code})`);
  });

  return proc;
}

function launchBTC(): ChildProcess {
  log("DASH", C.magenta, `Starting BTC 5-Min Engine (${btcStrategy})...`);

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

  proc.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!clean) continue;
      // Show key BTC events in log
      if (clean.includes("SNIPE") || clean.includes("ARB") ||
          clean.includes("filled") || clean.includes("DONE") ||
          clean.includes("Session PnL") || clean.includes("market:") ||
          clean.includes("Components:") || clean.includes("Error") ||
          clean.includes("Engine") || clean.includes("===")) {
        log("BTC", C.magenta, line);
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
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
  log("DASH", C.yellow, "Shutting down...");
  for (const { name, proc } of children) {
    if (!proc.killed) {
      log("DASH", C.yellow, `Stopping ${name}...`);
      proc.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const { proc } of children) {
      if (!proc.killed) proc.kill("SIGKILL");
    }
    process.exit(0);
  }, 10_000);
}

process.on("SIGINT", shutdownAll);
process.on("SIGTERM", shutdownAll);

// ─── Main ───────────────────────────────────────────────────────────

const runWeather = !btcOnly && !dashboardOnly;
const runBtc = !weatherOnly && !dashboardOnly;

console.log(`
${C.cyan}${C.bold}  ╔═══════════════════════════════════════════════╗
  ║        SATRIALES TRADING DASHBOARD            ║
  ║   Weather + BTC 5-Min · Live Statistics GUI   ║
  ╚═══════════════════════════════════════════════╝${C.reset}

  ${C.dim}Dashboard:${C.reset}   ${C.cyan}http://localhost:${port}${C.reset}
  ${C.dim}Bankroll:${C.reset}    $${bankroll} per engine
  ${C.dim}Weather:${C.reset}     ${runWeather ? `${C.green}ACTIVE${C.reset} (15-min scan)` : `${C.red}DISABLED${C.reset}`}
  ${C.dim}BTC 5-Min:${C.reset}   ${runBtc ? `${C.green}ACTIVE${C.reset} (${btcStrategy})` : `${C.red}DISABLED${C.reset}`}
  ${C.dim}Mode:${C.reset}        Paper trading (sim)
`);

// 1. Start dashboard server (in this process)
startDashboard(port);

// 2. Auto-open browser after a short delay for the server to be ready
setTimeout(() => {
  const url = `http://localhost:${port}`;
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
    log("DASH", C.cyan, `Opened browser → ${url}`);
  } catch {
    log("DASH", C.dim, `Open ${url} in your browser`);
  }
}, 1000);

// 3. Launch child engines
if (runWeather) {
  const weatherProc = launchWeather();
  children.push({ name: "Weather", proc: weatherProc });
}

if (runBtc) {
  // Small delay so weather starts first
  setTimeout(() => {
    const btcProc = launchBTC();
    children.push({ name: "BTC", proc: btcProc });
  }, 2000);
}

if (!runWeather && !runBtc) {
  log("DASH", C.cyan, "Dashboard-only mode — reading existing state files");
}

log("DASH", C.green, `Dashboard running at http://localhost:${port}`);
