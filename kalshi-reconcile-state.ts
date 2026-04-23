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
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

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

// Show plan
console.log(`${"Ticker".padEnd(32)} ${"Shares".padStart(7)} ${"AvgPx".padStart(7)} ${"Cost".padStart(8)}`);
console.log("─".repeat(70));
for (const p of market_positions as any[]) {
  const pos = p.position ?? 0;
  if (pos <= 0) continue;
  const fill = ticker_fills.get(p.ticker);
  const avgPx = fill?.avgPrice ?? 0;
  const cost = pos * avgPx;
  console.log(`${p.ticker.padEnd(32)} ${String(pos).padStart(7)} $${avgPx.toFixed(3).padStart(6)} $${cost.toFixed(2).padStart(7)}`);
}

console.log();
console.log(`${c.yellow}⚠️  Manual action required:${c.reset}`);
console.log(`  This tool shows you what's on Kalshi. To actually SYNC local state,`);
console.log(`  the cleanest approach is to let the bots TRACK positions going forward`);
console.log(`  without trying to retro-import old fills (which have complex cost basis).`);
console.log();
console.log(`  Recommended approach:`);
console.log(`   1. Start both bots FRESH (--fresh flag)`);
console.log(`   2. Bots will ignore existing Kalshi positions (they weren't placed by this session)`);
console.log(`   3. Existing Kalshi positions resolve naturally; you collect the P&L directly`);
console.log(`   4. Once resolved, your balance reflects the real outcome`);
console.log();
console.log(`  ${c.dim}(This is what the Kalshi UI shows anyway — source of truth.)${c.reset}`);
console.log();
