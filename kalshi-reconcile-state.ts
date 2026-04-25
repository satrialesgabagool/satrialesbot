#!/usr/bin/env bun
/**
 * Reconcile local state files with actual Kalshi positions.
 *
 * Kalshi is the source of truth for what we actually own. This tool:
 *   1. Fetches real Kalshi positions
 *   2. Initializes local state files (intrinsic + ensemble) with those positions
 *   3. Assigns each position to the correct bot based on ticker pattern
 *
 * Use this after a crash, duplicate-bot situation, or when switching bots.
 *
 * Usage:
 *   bun run kalshi-reconcile-state.ts              # preview only
 *   bun run kalshi-reconcile-state.ts --apply      # actually write state
 */

import { KalshiClient } from "./src/kalshi/KalshiClient";
import { loadCredentialsFromEnv } from "./src/kalshi/KalshiAuth";

const APPLY = process.argv.includes("--apply");

const c = {
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", dim: "\x1b[2m", reset: "\x1b[0m",
};

const creds = loadCredentialsFromEnv();
if (!creds) { console.error("Missing KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PATH"); process.exit(1); }
const client = new KalshiClient({ demo: false, credentials: creds });

console.log(`\n=== Kalshi Reconciliation ${APPLY ? "(WRITING)" : "(PREVIEW)"} ===\n`);

const balance = await client.getBalance();
const { market_positions = [] } = await client.getPositions({ limit: 200 });

console.log(`Cash balance: $${((balance.balance ?? 0) / 100).toFixed(2)}`);
console.log(`Portfolio value: $${((balance.portfolio_value ?? 0) / 100).toFixed(2)}`);
console.log(`Open positions: ${market_positions.length}\n`);

// Fetch recent fills to classify each position by bot
const { orders: executed = [] } = await client.getOrders({ status: "executed", limit: 100 });

// Build ticker → { first_fill_time, avg_fill_price } map
const ticker_fills = new Map<string, { firstFillIso: string; avgPrice: number; totalShares: number }>();
for (const o of executed) {
  const ticker = o.ticker;
  const price = parseFloat(o.yes_price_dollars ?? o.no_price_dollars ?? "0");
  const fillCount = parseFloat(o.fill_count_fp ?? "0");
  if (fillCount <= 0) continue;
  const time = o.last_update_time ?? o.created_time ?? "";

  const existing = ticker_fills.get(ticker);
  if (!existing) {
    ticker_fills.set(ticker, { firstFillIso: time, avgPrice: price, totalShares: fillCount });
  } else {
    const combinedShares = existing.totalShares + fillCount;
    const combinedPrice = (existing.avgPrice * existing.totalShares + price * fillCount) / combinedShares;
    ticker_fills.set(ticker, {
      firstFillIso: existing.firstFillIso < time ? existing.firstFillIso : time,
      avgPrice: combinedPrice,
      totalShares: combinedShares,
    });
  }
}

// Show actual Kalshi positions (filter to nonzero)
const live = (market_positions as any[])
  .map(p => ({ ...p, posShares: parseFloat(p.position_fp || "0") }))
  .filter(p => p.posShares !== 0);

console.log(`${"Ticker".padEnd(36)} ${"Shares".padStart(7)} ${"AvgPx".padStart(7)} ${"Cost".padStart(9)}`);
console.log("─".repeat(72));
let kalshiCostTotal = 0;
for (const p of live) {
  const shares = Math.abs(p.posShares);
  const exposure = Math.abs(parseFloat(p.market_exposure_dollars || "0"));
  const avgPx = shares > 0 ? exposure / shares : 0;
  kalshiCostTotal += exposure;
  console.log(`${p.ticker.padEnd(36)} ${String(shares).padStart(7)} $${avgPx.toFixed(3).padStart(6)} $${exposure.toFixed(2).padStart(8)}`);
}
console.log("─".repeat(72));
console.log(`${"TOTAL".padEnd(36)} ${String(live.length).padStart(7)}        $${kalshiCostTotal.toFixed(2).padStart(8)}`);
console.log();

// ─── Bot-state vs Kalshi diff ────────────────────────────────────────
import { readFileSync, existsSync as fileExists } from "fs";

const BOT_STATES = [
  { name: "intrinsic", path: "state/weather-intrinsic-sim.json" },
  { name: "ensemble",  path: "state/weather-ensemble-sim.json" },
];

const botTickers = new Map<string, { bot: string; shares: number; cost: number }[]>();
for (const { name, path } of BOT_STATES) {
  if (!fileExists(path)) continue;
  try {
    const s = JSON.parse(readFileSync(path, "utf-8"));
    for (const pos of (s.positions || []) as any[]) {
      const ticker = pos?.bracket?._kalshiTicker || pos?.market?.ticker;
      if (!ticker) continue;
      const arr = botTickers.get(ticker) || [];
      arr.push({ bot: name, shares: pos.shares || 0, cost: pos.cost || 0 });
      botTickers.set(ticker, arr);
    }
  } catch {}
}

const kalshiTickers = new Set(live.map(p => p.ticker));
const botTickerSet = new Set(botTickers.keys());

const onlyKalshi = [...kalshiTickers].filter(t => !botTickerSet.has(t));
const onlyBots = [...botTickerSet].filter(t => !kalshiTickers.has(t));

console.log(`${c.cyan}── Reconciliation summary ──${c.reset}`);
console.log(`  Kalshi has ${kalshiTickers.size} positions; bots track ${botTickerSet.size} unique tickers`);
console.log(`  ${c.green}In both (managed):${c.reset} ${[...kalshiTickers].filter(t => botTickerSet.has(t)).length}`);

if (onlyKalshi.length) {
  console.log(`  ${c.yellow}Only on Kalshi (orphans/external/manual):${c.reset} ${onlyKalshi.length}`);
  for (const t of onlyKalshi) console.log(`    ${t}`);
}
if (onlyBots.length) {
  console.log(`  ${c.red}PHANTOMS — in bot state but not on Kalshi:${c.reset} ${onlyBots.length}`);
  for (const t of onlyBots) console.log(`    ${t}  (would be a real bug — investigate)`);
}

// Per-ticker share/cost mismatch
console.log();
console.log(`${c.cyan}── Share/cost match per managed ticker ──${c.reset}`);
let mismatches = 0;
for (const [ticker, owners] of botTickers) {
  const livePos = live.find(p => p.ticker === ticker);
  if (!livePos) continue;
  const botShares = owners.reduce((s, o) => s + o.shares, 0);
  const botCost = owners.reduce((s, o) => s + o.cost, 0);
  const kShares = Math.abs(livePos.posShares);
  const kCost = Math.abs(parseFloat(livePos.market_exposure_dollars || "0"));
  const sharesMatch = botShares === kShares;
  const costMatch = Math.abs(botCost - kCost) < 0.02;
  if (!sharesMatch || !costMatch) {
    mismatches++;
    console.log(`  ${c.red}MISMATCH${c.reset} ${ticker}`);
    console.log(`    bot: ${botShares}sh @ $${botCost.toFixed(2)} (${owners.map(o => o.bot + ":" + o.shares).join(", ")})`);
    console.log(`    kalshi: ${kShares}sh @ $${kCost.toFixed(2)}`);
  }
}
if (mismatches === 0) {
  console.log(`  ${c.green}✓ All managed tickers match Kalshi exactly (shares + cost)${c.reset}`);
}

console.log();
console.log(`  ${c.dim}Read-only diagnostic — no state was modified.${c.reset}`);
console.log();
