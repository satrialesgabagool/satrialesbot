#!/usr/bin/env bun
/**
 * Kalshi Weather Tape — Multi-Strategy Comparison.
 *
 * Replays many strategies against the same tape and prints a comparison table.
 *
 * Tested strategies:
 *   - INTRINSIC variants (buy market favorite, various price zones + entry times)
 *   - FADE variants (bet against favorite — the losing taker approach)
 *   - LADDER variants (buy multiple brackets around favorite)
 *   - LATE-SNIPE (buy near-certain winner very close to close)
 *   - WIDE (any price range combination)
 */

import { readFileSync, existsSync } from "fs";
import { replay, type ReplayConfig } from "./src/kalshi/WeatherTapeReplay";
import type { Tape, TapeTrade, TapeMarket, TapeEvent } from "./src/kalshi/WeatherTapeCollector";

const args = process.argv.slice(2);
const idx = args.indexOf("--tape");
const TAPE_PATH = idx >= 0 ? args[idx + 1] : "data/kalshi-weather-tape.json";

if (!existsSync(TAPE_PATH)) {
  console.error(`❌ Tape not found: ${TAPE_PATH}. Run kalshi-tape-collect.ts first.`);
  process.exit(1);
}

const tape: Tape = JSON.parse(readFileSync(TAPE_PATH, "utf-8"));

// ─── Strategy definitions ───────────────────────────────────────────

interface StrategyConfig {
  name: string;
  description: string;
  config: Partial<ReplayConfig>;
  // Optional custom replay (for non-intrinsic strategies)
  customReplay?: (tape: Tape) => { bets: number; wins: number; losses: number; totalCost: number; totalPnL: number; avgEntry: number };
}

const strategies: StrategyConfig[] = [
  // --- INTRINSIC variants (the current strategy) ---
  { name: "intrinsic_default", description: "Favorite $0.70-$0.95, 8h (±4h)", config: { entryHoursBefore: 8, entryWindowHours: 4, minPrice: 0.70, maxPrice: 0.95, minFavoriteGap: 0.05 } },
  { name: "intrinsic_tight",   description: "Favorite $0.80-$0.95, 8h (±4h)", config: { entryHoursBefore: 8, entryWindowHours: 4, minPrice: 0.80, maxPrice: 0.95, minFavoriteGap: 0.05 } },
  { name: "intrinsic_wide",    description: "Favorite $0.60-$0.95, 8h (±4h)", config: { entryHoursBefore: 8, entryWindowHours: 4, minPrice: 0.60, maxPrice: 0.95, minFavoriteGap: 0.05 } },
  { name: "intrinsic_early",   description: "Favorite $0.60-$0.85, 12h (±4h)", config: { entryHoursBefore: 12, entryWindowHours: 4, minPrice: 0.60, maxPrice: 0.85, minFavoriteGap: 0.05 } },
  { name: "intrinsic_late",    description: "Favorite $0.70-$0.95, 4h (±2h)", config: { entryHoursBefore: 4, entryWindowHours: 2, minPrice: 0.70, maxPrice: 0.95, minFavoriteGap: 0.05 } },
  { name: "intrinsic_latest",  description: "Favorite $0.70-$0.95, 2h (±1h)", config: { entryHoursBefore: 2, entryWindowHours: 1, minPrice: 0.70, maxPrice: 0.95, minFavoriteGap: 0.05 } },
  { name: "intrinsic_sweet",   description: "Favorite $0.70-$0.85 (high PnL/sh zone), 8h", config: { entryHoursBefore: 8, entryWindowHours: 4, minPrice: 0.70, maxPrice: 0.85, minFavoriteGap: 0.05 } },
  { name: "intrinsic_nogap",   description: "Favorite $0.70-$0.95, 8h, no gap filter", config: { entryHoursBefore: 8, entryWindowHours: 4, minPrice: 0.70, maxPrice: 0.95, minFavoriteGap: 0 } },
  { name: "intrinsic_hgap",    description: "Favorite $0.70-$0.95, 8h, gap ≥ $0.15", config: { entryHoursBefore: 8, entryWindowHours: 4, minPrice: 0.70, maxPrice: 0.95, minFavoriteGap: 0.15 } },
];

// ─── Custom: FADE (buy against the favorite) ───────────────────────

function runFade(tape: Tape, minPrice: number, maxPrice: number, entryH: number, windowH: number, betSize: number) {
  let bets = 0, wins = 0, losses = 0, cost = 0, pnl = 0, totalEntry = 0;
  const FEE = 0.07;
  const tradesByTicker = new Map<string, TapeTrade[]>();
  for (const t of tape.trades) {
    if (!tradesByTicker.has(t.ticker)) tradesByTicker.set(t.ticker, []);
    tradesByTicker.get(t.ticker)!.push(t);
  }

  for (const event of tape.events) {
    const closeStr = event.markets.find(m => m.close_time)?.close_time;
    if (!closeStr) continue;
    const closeMs = new Date(closeStr).getTime();
    const targetMs = closeMs - entryH * 3600000;
    const windowMs = windowH * 3600000;

    // Price each bracket at target time
    const priced: { m: TapeMarket; price: number }[] = [];
    for (const m of event.markets) {
      const trades = tradesByTicker.get(m.ticker) ?? [];
      let best: TapeTrade | null = null;
      let bestTime = -Infinity;
      for (const t of trades) {
        const tMs = new Date(t.created_time).getTime();
        if (tMs > targetMs || tMs < targetMs - windowMs) continue;
        if (tMs > bestTime) { best = t; bestTime = tMs; }
      }
      if (!best) continue;
      const p = best.yes_price > 0 ? best.yes_price : 1 - best.no_price;
      priced.push({ m, price: p });
    }
    if (priced.length < 2) continue;

    // Fade: buy the CHEAP brackets (not the favorite)
    const cheapBrackets = priced.filter(p => p.price >= minPrice && p.price <= maxPrice);
    for (const pr of cheapBrackets) {
      const shares = Math.floor(betSize / pr.price);
      if (shares < 1) continue;
      const c = shares * pr.price;
      bets++;
      cost += c;
      totalEntry += pr.price;
      const result = pr.m.result;
      if (result === "yes") {
        wins++;
        const gross = shares * 1 - c;
        pnl += gross - gross * FEE;
      } else if (result === "no") {
        losses++;
        pnl += -c;
      }
    }
  }

  return { bets, wins, losses, totalCost: cost, totalPnL: pnl, avgEntry: bets > 0 ? totalEntry / bets : 0 };
}

// ─── Custom: LADDER (buy top-N brackets proportional to edge) ──────

function runLadder(tape: Tape, entryH: number, windowH: number, budget: number, maxLegs: number, minPrice: number, maxPrice: number) {
  let bets = 0, wins = 0, losses = 0, cost = 0, pnl = 0, totalEntry = 0;
  const FEE = 0.07;
  const tradesByTicker = new Map<string, TapeTrade[]>();
  for (const t of tape.trades) {
    if (!tradesByTicker.has(t.ticker)) tradesByTicker.set(t.ticker, []);
    tradesByTicker.get(t.ticker)!.push(t);
  }

  for (const event of tape.events) {
    const closeStr = event.markets.find(m => m.close_time)?.close_time;
    if (!closeStr) continue;
    const closeMs = new Date(closeStr).getTime();
    const targetMs = closeMs - entryH * 3600000;
    const windowMs = windowH * 3600000;

    const priced: { m: TapeMarket; price: number }[] = [];
    for (const m of event.markets) {
      const trades = tradesByTicker.get(m.ticker) ?? [];
      let best: TapeTrade | null = null;
      let bestTime = -Infinity;
      for (const t of trades) {
        const tMs = new Date(t.created_time).getTime();
        if (tMs > targetMs || tMs < targetMs - windowMs) continue;
        if (tMs > bestTime) { best = t; bestTime = tMs; }
      }
      if (!best) continue;
      const p = best.yes_price > 0 ? best.yes_price : 1 - best.no_price;
      priced.push({ m, price: p });
    }
    if (priced.length < 2) continue;

    // Buy top maxLegs brackets in range, split budget equally
    const candidates = priced
      .filter(p => p.price >= minPrice && p.price <= maxPrice)
      .sort((a, b) => b.price - a.price)
      .slice(0, maxLegs);
    if (candidates.length === 0) continue;

    const perLeg = budget / candidates.length;
    for (const pr of candidates) {
      const shares = Math.floor(perLeg / pr.price);
      if (shares < 1) continue;
      const c = shares * pr.price;
      bets++;
      cost += c;
      totalEntry += pr.price;
      const result = pr.m.result;
      if (result === "yes") {
        wins++;
        const gross = shares * 1 - c;
        pnl += gross - gross * FEE;
      } else if (result === "no") {
        losses++;
        pnl += -c;
      }
    }
  }
  return { bets, wins, losses, totalCost: cost, totalPnL: pnl, avgEntry: bets > 0 ? totalEntry / bets : 0 };
}

// ─── Run all strategies ───────────────────────────────────────────

console.log(`\n╔════════════════════════════════════════════════════════════╗`);
console.log(`║   KALSHI WEATHER — STRATEGY COMPARISON                     ║`);
console.log(`╚════════════════════════════════════════════════════════════╝\n`);
console.log(`Tape: ${tape.summary.eventsTotal} events, ${tape.summary.tradesTotal} trades`);
console.log(`Window: ${tape.windowStart.slice(0, 10)} → ${tape.windowEnd.slice(0, 10)}\n`);

interface Row {
  name: string;
  description: string;
  bets: number;
  wins: number;
  losses: number;
  winRate: number;
  totalCost: number;
  totalPnL: number;
  roi: number;
  avgEntry: number;
}

const rows: Row[] = [];

// Intrinsic variants
for (const s of strategies) {
  const r = replay(tape, s.config);
  rows.push({
    name: s.name,
    description: s.description,
    bets: r.summary.total,
    wins: r.summary.wins,
    losses: r.summary.losses,
    winRate: r.summary.winRate,
    totalCost: r.summary.totalCost,
    totalPnL: r.summary.totalPnL,
    roi: r.summary.roi,
    avgEntry: r.summary.avgEntry,
  });
}

// FADE strategies
for (const [label, minP, maxP] of [["fade_deep_<0.15", 0.01, 0.15], ["fade_shallow_0.15-0.30", 0.15, 0.30], ["fade_mid_0.30-0.50", 0.30, 0.50]] as const) {
  const r = runFade(tape, minP, maxP, 8, 4, 3);
  rows.push({
    name: label,
    description: `Buy all brackets $${minP.toFixed(2)}-$${maxP.toFixed(2)}, 8h, $3 each`,
    bets: r.bets, wins: r.wins, losses: r.losses,
    winRate: (r.wins + r.losses) > 0 ? r.wins / (r.wins + r.losses) : 0,
    totalCost: r.totalCost, totalPnL: r.totalPnL,
    roi: r.totalCost > 0 ? r.totalPnL / r.totalCost : 0,
    avgEntry: r.avgEntry,
  });
}

// LADDER strategies
for (const [label, maxLegs, minP, maxP] of [["ladder_3leg_0.50-0.95", 3, 0.50, 0.95], ["ladder_all_top3_0.30-0.95", 3, 0.30, 0.95]] as const) {
  const r = runLadder(tape, 8, 4, 15, maxLegs, minP, maxP);
  rows.push({
    name: label,
    description: `Buy top-${maxLegs} brackets $${minP.toFixed(2)}-$${maxP.toFixed(2)}, 8h, $15 total budget`,
    bets: r.bets, wins: r.wins, losses: r.losses,
    winRate: (r.wins + r.losses) > 0 ? r.wins / (r.wins + r.losses) : 0,
    totalCost: r.totalCost, totalPnL: r.totalPnL,
    roi: r.totalCost > 0 ? r.totalPnL / r.totalCost : 0,
    avgEntry: r.avgEntry,
  });
}

// Sort by ROI descending
rows.sort((a, b) => b.roi - a.roi);

// Print table
const pad = (s: any, len: number, right = false) => {
  const str = String(s);
  return right ? str.padStart(len) : str.padEnd(len);
};

const c = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

console.log(`${c.bold}${pad("Strategy", 28)}  ${pad("Bets", 5, true)}  ${pad("WR", 7, true)}  ${pad("AvgPx", 8, true)}  ${pad("Cost", 10, true)}  ${pad("PnL", 11, true)}  ${pad("ROI", 8, true)}${c.reset}`);
console.log("─".repeat(90));

for (const r of rows) {
  const color = r.roi > 0.02 ? c.green : r.roi < -0.02 ? c.red : c.yellow;
  const pnlSign = r.totalPnL >= 0 ? "+" : "";
  const roiStr = (r.roi >= 0 ? "+" : "") + (r.roi * 100).toFixed(1) + "%";
  console.log(
    `${color}${pad(r.name, 28)}${c.reset}  ${pad(r.bets, 5, true)}  ${pad((r.winRate * 100).toFixed(0) + "%", 7, true)}  ${pad("$" + r.avgEntry.toFixed(3), 8, true)}  ${pad("$" + r.totalCost.toFixed(2), 10, true)}  ${color}${pad(pnlSign + "$" + r.totalPnL.toFixed(2), 11, true)}${c.reset}  ${color}${pad(roiStr, 8, true)}${c.reset}`
  );
}

console.log();
console.log("─".repeat(90));
console.log(`${c.dim}Green = profitable (ROI > 2%)   Yellow = marginal   Red = losing (ROI < -2%)${c.reset}`);
console.log();

// Print strategy descriptions
console.log(`${c.bold}Strategy details:${c.reset}`);
for (const r of rows) {
  console.log(`  ${pad(r.name, 28)}  ${c.dim}${r.description}${c.reset}`);
}
console.log();
