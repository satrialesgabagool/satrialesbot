#!/usr/bin/env bun
/**
 * Kalshi Order Diagnostic — list any open/resting orders on your account.
 *
 * Use this to diagnose the 409 "order_already_exists" error — tells you
 * if there's a phantom order from a previous run that's blocking new ones.
 *
 * Usage:
 *   ~/.bun/bin/bun kalshi-check-orders.ts
 *   ~/.bun/bin/bun kalshi-check-orders.ts --cancel        (cancel all resting orders)
 */

import { KalshiClient } from "./src/kalshi/KalshiClient";
import { loadCredentialsFromEnv } from "./src/kalshi/KalshiAuth";

const args = process.argv.slice(2);
const DO_CANCEL = args.includes("--cancel");

const creds = loadCredentialsFromEnv();
if (!creds) {
  console.error("Missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY_PATH");
  process.exit(1);
}

const client = new KalshiClient({ demo: false, credentials: creds });

const balance = await client.getBalance();
console.log(`\nAccount state:`);
console.log(`  Cash balance:     $${((balance.balance ?? 0) / 100).toFixed(2)}`);
console.log(`  Portfolio value:  $${((balance.portfolio_value ?? 0) / 100).toFixed(2)}`);

const resting = await client.getOrders({ status: "resting", limit: 200 });
console.log(`\nResting (open) orders: ${resting.orders?.length ?? 0}`);
for (const o of resting.orders ?? []) {
  const px = o.yes_price_dollars ?? o.no_price_dollars ?? "?";
  console.log(`  [${o.status}] ${o.ticker.padEnd(32)} ${o.action} ${o.side}  count=${o.initial_count_fp ?? o.count}  fill=${o.fill_count_fp ?? "?"}  @ $${px}  id=${o.order_id}  client_id=${o.client_order_id}`);
}

if (DO_CANCEL && resting.orders?.length) {
  console.log(`\nCanceling ${resting.orders.length} resting orders...`);
  for (const o of resting.orders) {
    try {
      await client.cancelOrder(o.order_id);
      console.log(`  ✓ Canceled ${o.order_id}`);
    } catch (e: any) {
      console.log(`  ✗ Failed ${o.order_id}: ${e?.message}`);
    }
  }
}

// Also show executed orders from last 24h
const executed = await client.getOrders({ status: "executed", limit: 20 });
console.log(`\nRecently executed orders (last 20): ${executed.orders?.length ?? 0}`);
for (const o of executed.orders ?? []) {
  const px = o.yes_price_dollars ?? o.no_price_dollars ?? "?";
  console.log(`  [exec] ${o.ticker.padEnd(32)} ${o.action} ${o.side}  fill=${o.fill_count_fp}  @ $${px}  ${o.last_update_time ?? ""}`);
}
console.log();
