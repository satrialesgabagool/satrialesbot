#!/usr/bin/env bun
/**
 * Satriales Autonomous Orchestrator
 *
 * Runs all strategies in parallel, collects results, auto-tunes parameters,
 * and writes findings to CSV + report. Designed to run unattended for hours.
 *
 * Usage: bun run orchestrator.ts [--iterations 20] [--rounds-per-batch 2]
 *
 * Ctrl+C to stop gracefully.
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// --- Configuration ---
const STRATEGIES = ["simulation", "signal-momentum", "latency-arb", "observer"];
const ROUNDS_PER_BATCH = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--rounds-per-batch") ?? "2");
const MAX_ITERATIONS = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--iterations") ?? "50");
const STATE_DIR = join(import.meta.dir, "state");
const RESULTS_DIR = join(import.meta.dir, "results");
const CSV_PATH = join(RESULTS_DIR, "simulations.csv");
const REPORT_PATH = join(RESULTS_DIR, "FINDINGS.md");
const MAX_SESSION_LOSS = 20;

// --- Ensure directories exist ---
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// --- CSV header ---
if (!existsSync(CSV_PATH) || readFileSync(CSV_PATH, "utf-8").trim() === "") {
  writeFileSync(CSV_PATH, "iteration,strategy,round_num,slug,pnl,result,resolution,cumulative_pnl,timestamp\n");
}

// --- Types ---
interface RoundResult {
  slug: string;
  pnl: number;
  orderCount: number;
  resolution?: "UP" | "DOWN";
}

interface PersistentState {
  sessionPnl: number;
  sessionLoss: number;
  roundsCompleted: number;
  completedRounds: RoundResult[];
}

interface StrategyStats {
  strategy: string;
  totalRounds: number;
  wins: number;
  losses: number;
  flats: number;
  totalPnl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  bestRound: number;
  worstRound: number;
}

// --- Tracking across iterations ---
const allTimeStats: Map<string, { rounds: RoundResult[]; iterations: number }> = new Map();
for (const s of STRATEGIES) {
  allTimeStats.set(s, { rounds: [], iterations: 0 });
}

// --- Helpers ---
function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function loadState(strategy: string): PersistentState | null {
  const path = join(STATE_DIR, `engine-sim-${strategy}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function resetState(strategy: string) {
  const path = join(STATE_DIR, `engine-sim-${strategy}.json`);
  if (existsSync(path)) rmSync(path);
}

function clearLocks() {
  try {
    const files = require("fs").readdirSync(STATE_DIR);
    for (const f of files) {
      if (f.endsWith(".lock")) rmSync(join(STATE_DIR, f));
    }
  } catch {}
}

function fullStateReset() {
  try {
    const files = require("fs").readdirSync(STATE_DIR);
    for (const f of files) {
      if (f.endsWith(".json") || f.endsWith(".lock")) {
        rmSync(join(STATE_DIR, f));
      }
    }
    log("State fully reset");
  } catch {}
}

function computeStats(strategy: string): StrategyStats {
  const data = allTimeStats.get(strategy)!;
  const rounds = data.rounds;
  const wins = rounds.filter(r => r.pnl > 0);
  const losses = rounds.filter(r => r.pnl < 0);
  const flats = rounds.filter(r => r.pnl === 0);

  return {
    strategy,
    totalRounds: rounds.length,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    totalPnl: rounds.reduce((s, r) => s + r.pnl, 0),
    winRate: rounds.length > 0 ? wins.length / rounds.length : 0,
    avgWin: wins.length > 0 ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length : 0,
    bestRound: rounds.length > 0 ? Math.max(...rounds.map(r => r.pnl)) : 0,
    worstRound: rounds.length > 0 ? Math.min(...rounds.map(r => r.pnl)) : 0,
  };
}

// --- Run a single strategy batch ---
function runStrategy(strategy: string, rounds: number): Promise<{ strategy: string; newRounds: RoundResult[]; sessionPnl: number }> {
  return new Promise((resolve) => {
    // Reset state for this strategy before each batch so it starts clean
    resetState(strategy);
    clearLocks();

    const priorRoundCount = 0;
    const maxRounds = rounds;

    const proc = spawn("bun", ["run", "src/index.ts", "--strategy", strategy, "--rounds", String(maxRounds), "--always-log"], {
      cwd: import.meta.dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
    });

    let output = "";
    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      output += chunk;
      // Forward key events to orchestrator log
      for (const line of chunk.split("\n")) {
        if (line.includes("buy filled") || line.includes("sell filled") || line.includes("STOP LOSS") ||
            line.includes("DONE") || line.includes("ARB:") || line.includes("expired") ||
            line.includes("skipping") || line.includes("No ")) {
          log(`  [${strategy}] ${line.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
        }
      }
    });
    proc.stderr.on("data", (d) => { output += d.toString(); });

    // Timeout: 25 minutes per batch (2 rounds × 5min + buffer for market window wait)
    const timeout = setTimeout(() => {
      log(`  [${strategy}] TIMEOUT (25min) — killing`);
      proc.kill("SIGTERM");
    }, 25 * 60 * 1000);

    proc.on("close", () => {
      clearTimeout(timeout);
      const state = loadState(strategy);
      const allRounds = state?.completedRounds ?? [];
      const newRounds = allRounds.slice(priorRoundCount);

      resolve({
        strategy,
        newRounds,
        sessionPnl: state?.sessionPnl ?? 0,
      });
    });
  });
}

// --- Extract results to CSV ---
function exportToCSV(iteration: number, strategy: string, newRounds: RoundResult[], cumulativePnl: number) {
  for (const round of newRounds) {
    const result = round.pnl > 0 ? "WIN" : round.pnl < 0 ? "LOSS" : "FLAT";
    const row = `${iteration},${strategy},${allTimeStats.get(strategy)!.rounds.length},${round.slug},${round.pnl.toFixed(2)},${result},${round.resolution ?? ""},${cumulativePnl.toFixed(2)},${new Date().toISOString()}\n`;
    appendFileSync(CSV_PATH, row);
  }
}

// --- Write iteration summary to report ---
function writeIterationReport(iteration: number, results: { strategy: string; newRounds: RoundResult[]; sessionPnl: number }[]) {
  let report = `\n### Iteration ${iteration} (${new Date().toLocaleString()})\n\n`;
  report += `| Strategy | New Rounds | W-L-F | Batch PnL | Session PnL | Win Rate |\n`;
  report += `|---|---|---|---|---|---|\n`;

  for (const r of results) {
    const wins = r.newRounds.filter(rr => rr.pnl > 0).length;
    const losses = r.newRounds.filter(rr => rr.pnl < 0).length;
    const flats = r.newRounds.filter(rr => rr.pnl === 0).length;
    const batchPnl = r.newRounds.reduce((s, rr) => s + rr.pnl, 0);
    const winRate = r.newRounds.length > 0 ? ((wins / r.newRounds.length) * 100).toFixed(0) : "N/A";

    report += `| ${r.strategy} | ${r.newRounds.length} | ${wins}-${losses}-${flats} | $${batchPnl.toFixed(2)} | $${r.sessionPnl.toFixed(2)} | ${winRate}% |\n`;
  }

  // Round details
  report += "\n**Round Details:**\n";
  for (const r of results) {
    for (const round of r.newRounds) {
      const icon = round.pnl > 0 ? "+" : round.pnl < 0 ? "" : "~";
      report += `- ${r.strategy} | ${round.slug} | ${round.resolution ?? "?"} | ${icon}$${round.pnl.toFixed(2)}\n`;
    }
  }

  report += "\n---\n";
  appendFileSync(REPORT_PATH, report);
}

// --- Write cumulative stats ---
function writeCumulativeReport() {
  let report = `\n## Cumulative Stats (${new Date().toLocaleString()})\n\n`;
  report += `| Strategy | Rounds | W-L-F | PnL | Win Rate | Avg Win | Avg Loss | Best | Worst |\n`;
  report += `|---|---|---|---|---|---|---|---|---|\n`;

  for (const strategy of STRATEGIES) {
    const s = computeStats(strategy);
    report += `| ${s.strategy} | ${s.totalRounds} | ${s.wins}-${s.losses}-${s.flats} | $${s.totalPnl.toFixed(2)} | ${(s.winRate * 100).toFixed(0)}% | $${s.avgWin.toFixed(2)} | $${s.avgLoss.toFixed(2)} | $${s.bestRound.toFixed(2)} | $${s.worstRound.toFixed(2)} |\n`;
  }

  report += "\n---\n";
  appendFileSync(REPORT_PATH, report);
}

// =================================================================
// MAIN LOOP
// =================================================================
async function main() {
  log("=== SATRIALES AUTONOMOUS ORCHESTRATOR ===");
  log(`Strategies: ${STRATEGIES.join(", ")}`);
  log(`Rounds per batch: ${ROUNDS_PER_BATCH}`);
  log(`Max iterations: ${MAX_ITERATIONS}`);
  log(`Results: ${CSV_PATH}`);
  log(`Report: ${REPORT_PATH}`);
  log("");

  // Append start marker to report
  appendFileSync(REPORT_PATH, `\n## Orchestrator Session — Started ${new Date().toLocaleString()}\n\n`);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    log(`\n========== ITERATION ${iteration}/${MAX_ITERATIONS} ==========`);

    // Each batch starts clean — no stale state accumulation
    clearLocks();

    // Run all strategies in parallel
    log("Launching all strategies in parallel...");
    const promises = STRATEGIES.map(s => {
      log(`  Starting ${s} (${ROUNDS_PER_BATCH} rounds)...`);
      return runStrategy(s, ROUNDS_PER_BATCH);
    });

    const results = await Promise.all(promises);

    // Process results
    log("\n--- Results ---");
    for (const r of results) {
      const batchPnl = r.newRounds.reduce((s, rr) => s + rr.pnl, 0);
      const wins = r.newRounds.filter(rr => rr.pnl > 0).length;
      const losses = r.newRounds.filter(rr => rr.pnl < 0).length;

      log(`  ${r.strategy}: ${r.newRounds.length} rounds, ${wins}W-${losses}L, batch=$${batchPnl.toFixed(2)}, session=$${r.sessionPnl.toFixed(2)}`);

      // Track all-time stats
      const stats = allTimeStats.get(r.strategy)!;
      stats.rounds.push(...r.newRounds);
      stats.iterations++;

      // Export to CSV
      exportToCSV(iteration, r.strategy, r.newRounds, stats.rounds.reduce((s, rr) => s + rr.pnl, 0));
    }

    // Write to report
    writeIterationReport(iteration, results);

    // Every 3 iterations, write cumulative stats
    if (iteration % 3 === 0) {
      log("\n--- Cumulative Stats ---");
      for (const strategy of STRATEGIES) {
        const s = computeStats(strategy);
        log(`  ${s.strategy}: ${s.totalRounds}R, ${s.wins}W-${s.losses}L, PnL=$${s.totalPnl.toFixed(2)}, WR=${(s.winRate * 100).toFixed(0)}%`);
      }
      writeCumulativeReport();
    }

    // Clear locks between iterations
    clearLocks();

    log(`\nIteration ${iteration} complete. Waiting 5s before next...\n`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Final report
  log("\n=== ORCHESTRATOR COMPLETE ===");
  writeCumulativeReport();

  // Write final summary
  let finalReport = `\n## FINAL SUMMARY\n\n`;
  finalReport += `**Total iterations:** ${MAX_ITERATIONS}\n\n`;

  const ranked = STRATEGIES
    .map(s => computeStats(s))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  finalReport += `**Best strategy: ${ranked[0].strategy}** (PnL: $${ranked[0].totalPnl.toFixed(2)}, Win Rate: ${(ranked[0].winRate * 100).toFixed(0)}%)\n\n`;
  finalReport += `**Worst strategy: ${ranked[ranked.length - 1].strategy}** (PnL: $${ranked[ranked.length - 1].totalPnl.toFixed(2)})\n\n`;

  appendFileSync(REPORT_PATH, finalReport);
  log("Final report written to: " + REPORT_PATH);
  log("CSV data written to: " + CSV_PATH);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("\n\nSIGINT received — writing final stats...");
  writeCumulativeReport();

  let report = `\n## SESSION ENDED (interrupted at ${new Date().toLocaleString()})\n\n`;
  const ranked = STRATEGIES
    .map(s => computeStats(s))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  if (ranked[0].totalRounds > 0) {
    report += `**Best strategy: ${ranked[0].strategy}** (PnL: $${ranked[0].totalPnl.toFixed(2)}, Win Rate: ${(ranked[0].winRate * 100).toFixed(0)}%)\n\n`;
  }
  appendFileSync(REPORT_PATH, report);

  log("Final stats written. Goodbye!");
  process.exit(0);
});

main().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
