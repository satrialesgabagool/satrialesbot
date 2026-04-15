#!/usr/bin/env bun
/**
 * Satriales Live Runner
 *
 * Runs all strategies in parallel with a shared starting balance.
 * Prints a live dashboard to terminal. Stops when a strategy goes broke.
 *
 * Usage: bun run live.ts --balance 100
 *        bun run live.ts --balance 50 --strategies simulation,latency-arb
 */

import { spawn, type ChildProcess } from "child_process";
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Config ───────────────────────────────────────────────────────────
const ALL_STRATEGIES = ["simulation", "signal-momentum", "latency-arb", "observer"];

const args = process.argv.slice(2);
const balanceIdx = args.indexOf("--balance");
const stratIdx = args.indexOf("--strategies");

const STARTING_BALANCE = balanceIdx >= 0 ? parseFloat(args[balanceIdx + 1]) : 100;
const ACTIVE_STRATEGIES = stratIdx >= 0
  ? args[stratIdx + 1].split(",").map(s => s.trim())
  : ALL_STRATEGIES;

const STATE_DIR = join(import.meta.dir, "state");
const RESULTS_DIR = join(import.meta.dir, "results");
const CSV_PATH = join(RESULTS_DIR, "live-results.csv");
const POLL_INTERVAL_MS = 3_000;

// ─── CSV setup ────────────────────────────────────────────────────────
const CSV_HEADER = "timestamp,strategy,round,slug,pnl,result,balance,session_pnl,wins,losses,flats\n";
if (!existsSync(RESULTS_DIR)) require("fs").mkdirSync(RESULTS_DIR, { recursive: true });
if (!existsSync(CSV_PATH) || readFileSync(CSV_PATH, "utf-8").trim() === "") {
  writeFileSync(CSV_PATH, CSV_HEADER);
}

// ─── ANSI helpers ─────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgBlack: "\x1b[40m",
};

function colorPnl(pnl: number): string {
  if (pnl > 0) return `${c.green}+$${pnl.toFixed(2)}${c.reset}`;
  if (pnl < 0) return `${c.red}-$${Math.abs(pnl).toFixed(2)}${c.reset}`;
  return `${c.dim}$0.00${c.reset}`;
}

function colorBalance(bal: number, start: number): string {
  const pct = ((bal / start) * 100).toFixed(0);
  const color = bal > start ? c.green : bal < start * 0.5 ? c.red : bal < start * 0.8 ? c.yellow : c.white;
  return `${color}$${bal.toFixed(2)} (${pct}%)${c.reset}`;
}

function pad(s: string, len: number): string {
  // Strip ANSI for length calc
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, len - visible.length));
}

// ─── State tracking ───────────────────────────────────────────────────
interface StrategyState {
  name: string;
  process: ChildProcess | null;
  pnl: number;
  balance: number;
  rounds: number;
  wins: number;
  losses: number;
  flats: number;
  lastRoundPnl: number;
  alive: boolean;
  lastRoundSlug: string;
}

const state: Map<string, StrategyState> = new Map();
for (const name of ACTIVE_STRATEGIES) {
  state.set(name, {
    name,
    process: null,
    pnl: 0,
    balance: STARTING_BALANCE,
    rounds: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    lastRoundPnl: 0,
    alive: true,
    lastRoundSlug: "",
  });
}

// ─── Banner ───────────────────────────────────────────────────────────
function printBanner() {
  console.log(`
${c.cyan}${c.bold}  ╔═══════════════════════════════════════════╗
  ║          S A T R I A L E S   L I V E       ║
  ║       Polymarket BTC 5m Trading Engine      ║
  ╚═══════════════════════════════════════════════╝${c.reset}

  ${c.dim}Starting balance:${c.reset} ${c.bold}$${STARTING_BALANCE.toFixed(2)}${c.reset} per strategy
  ${c.dim}Strategies:${c.reset}      ${ACTIVE_STRATEGIES.join(", ")}
  ${c.dim}Stop condition:${c.reset}  balance reaches $0
  ${c.dim}Results CSV:${c.reset}    results/live-results.csv
  ${c.dim}Observer CSV:${c.reset}   results/observer.csv + results/crossovers.csv
  ${c.dim}Press Ctrl+C to stop${c.reset}
`);
}

// ─── Dashboard ────────────────────────────────────────────────────────
function printDashboard() {
  const now = new Date().toLocaleTimeString();
  const divider = "─".repeat(78);

  console.log(`\n${c.dim}${divider}${c.reset}`);
  console.log(`${c.bold}  DASHBOARD${c.reset}  ${c.dim}${now}${c.reset}\n`);

  // Header
  console.log(
    `  ${c.dim}${pad("Strategy", 20)} ${pad("Balance", 22)} ${pad("PnL", 16)} ${pad("W-L-F", 10)} ${pad("Rounds", 8)} Last${c.reset}`
  );

  for (const s of state.values()) {
    const status = s.alive ? ` ${c.green}LIVE${c.reset}` : s.balance <= 0 ? ` ${c.red}BUSTED${c.reset}` : ` ${c.dim}STOPPED${c.reset}`;
    const wr = s.rounds > 0 ? ` ${((s.wins / s.rounds) * 100).toFixed(0)}%` : "";
    console.log(
      `  ${pad(s.name + status, 20)} ${pad(colorBalance(s.balance, STARTING_BALANCE), 22)} ${pad(colorPnl(s.pnl), 16)} ${pad(`${s.wins}-${s.losses}-${s.flats}${wr}`, 10)} ${pad(String(s.rounds), 8)} ${colorPnl(s.lastRoundPnl)}`
    );
  }

  // Total
  const totalPnl = Array.from(state.values()).reduce((sum, s) => sum + s.pnl, 0);
  const totalBalance = Array.from(state.values()).reduce((sum, s) => sum + s.balance, 0);
  const totalStart = STARTING_BALANCE * state.size;
  console.log(`\n  ${c.bold}${pad("TOTAL", 20)}${c.reset} ${pad(colorBalance(totalBalance, totalStart), 22)} ${colorPnl(totalPnl)}`);
  console.log(`${c.dim}${divider}${c.reset}\n`);
}

// ─── Spawn a strategy process ─────────────────────────────────────────
function spawnStrategy(name: string): ChildProcess {
  const proc = spawn("bun", [
    "run", "src/index.ts",
    "--strategy", name,
    "--rounds", "-1",
    "--always-log",
  ], {
    cwd: import.meta.dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      MAX_SESSION_LOSS: String(STARTING_BALANCE),
      WALLET_BALANCE: String(STARTING_BALANCE),
    },
  });

  // Forward key output lines
  proc.stdout?.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!line) continue;

      // Show highlights and status updates
      if (
        line.includes("buy filled") || line.includes("sold") ||
        line.includes("STOP LOSS") || line.includes("ENTRY:") ||
        line.includes("LATE ENTRY") || line.includes("ARB:") ||
        line.includes("CROSSOVER") || line.includes("Reprice") ||
        line.includes("expired") || line.includes("holding to resolution") ||
        line.includes("Found market") || line.includes("Round started") ||
        line.includes("DONE") || line.includes("skipping") ||
        line.includes("No ") || line.includes("started") ||
        line.includes("Waiting") || line.includes("Engine started") ||
        line.includes("price to beat") || line.includes("recording phase") ||
        line.includes("flushed") || line.includes("high-freq")
      ) {
        const tag = `${c.magenta}[${name}]${c.reset}`;
        console.log(`  ${tag} ${raw.trim()}`);
      }
    }
  });

  proc.stderr?.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.log(`  ${c.red}[${name} ERR]${c.reset} ${line}`);
  });

  proc.on("close", (code) => {
    const s = state.get(name);
    if (s) {
      if (!isShuttingDown) s.alive = false;
      s.process = null;
    }
    if (!isShuttingDown) {
      console.log(`  ${c.yellow}[${name}]${c.reset} Process exited (code ${code})`);
      checkAllDone();
    }
  });

  return proc;
}

// ─── Poll state files for balance updates ─────────────────────────────
function pollState() {
  let anyChange = false;

  for (const s of state.values()) {
    if (!s.alive) continue;

    const path = join(STATE_DIR, `engine-sim-${s.name}.json`);
    if (!existsSync(path)) continue;

    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const newRounds = raw.roundsCompleted ?? 0;
      const newPnl = raw.sessionPnl ?? 0;

      if (newRounds > s.rounds) {
        const prevRounds = s.rounds;

        // New round completed
        const roundPnl = newPnl - s.pnl;
        s.lastRoundPnl = roundPnl;
        s.pnl = newPnl;
        s.balance = STARTING_BALANCE + newPnl;
        s.rounds = newRounds;

        // Count W/L/F from completedRounds
        const completed = raw.completedRounds ?? [];
        s.wins = completed.filter((r: any) => r.pnl > 0).length;
        s.losses = completed.filter((r: any) => r.pnl < 0).length;
        s.flats = completed.filter((r: any) => r.pnl === 0).length;

        if (completed.length > 0) {
          s.lastRoundSlug = completed[completed.length - 1].slug ?? "";
        }

        // Export new rounds to CSV
        for (let i = prevRounds; i < completed.length; i++) {
          const r = completed[i];
          const result = r.pnl > 0 ? "WIN" : r.pnl < 0 ? "LOSS" : "FLAT";
          const bal = STARTING_BALANCE + completed.slice(0, i + 1).reduce((sum: number, rr: any) => sum + rr.pnl, 0);
          const cumPnl = completed.slice(0, i + 1).reduce((sum: number, rr: any) => sum + rr.pnl, 0);
          const row = `${new Date().toISOString()},${s.name},${i + 1},${r.slug},${r.pnl.toFixed(2)},${result},${bal.toFixed(2)},${cumPnl.toFixed(2)},${s.wins},${s.losses},${s.flats}\n`;
          appendFileSync(CSV_PATH, row);
        }

        anyChange = true;

        // Check if busted
        if (s.balance <= 0) {
          console.log(`\n  ${c.red}${c.bold}[${s.name}] BUSTED — balance hit $${s.balance.toFixed(2)}${c.reset}`);
          s.alive = false;
          s.process?.kill("SIGTERM");
        }
      }
    } catch {}
  }

  if (anyChange) {
    printDashboard();
  }
}

// ─── Check if all strategies are done ─────────────────────────────────
function checkAllDone() {
  const alive = Array.from(state.values()).filter(s => s.alive);
  if (alive.length === 0) {
    console.log(`\n${c.red}${c.bold}  All strategies finished.${c.reset}\n`);
    printDashboard();
    process.exit(0);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────
let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n\n${c.yellow}  Shutting down...${c.reset}\n`);
  for (const s of state.values()) {
    s.process?.kill("SIGTERM");
  }
  setTimeout(() => {
    printDashboard();
    process.exit(0);
  }, 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Main ─────────────────────────────────────────────────────────────
printBanner();

// Launch all strategies
for (const s of state.values()) {
  s.process = spawnStrategy(s.name);
  console.log(`  ${c.green}Started${c.reset} ${s.name} (PID ${s.process.pid})`);
}

console.log("");

// Poll for state changes
setInterval(pollState, POLL_INTERVAL_MS);

// Heartbeat — show we're alive every 30s during quiet periods
let lastOutputTime = Date.now();
const origLog = console.log;
console.log = (...args: any[]) => { lastOutputTime = Date.now(); origLog(...args); };

setInterval(() => {
  if (Date.now() - lastOutputTime > 25_000) {
    const anyAlive = Array.from(state.values()).some(s => s.alive);
    if (anyAlive) {
      origLog(`  ${c.dim}[${new Date().toLocaleTimeString()}] Waiting for market window...${c.reset}`);
      lastOutputTime = Date.now();
    }
  }
}, 30_000);

// Print dashboard every 5 minutes
setInterval(() => {
  const anyAlive = Array.from(state.values()).some(s => s.alive);
  if (anyAlive) printDashboard();
}, 5 * 60 * 1000);
