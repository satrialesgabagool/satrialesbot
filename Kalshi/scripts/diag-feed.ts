#!/usr/bin/env bun
/**
 * Verify KalshiBTCFeed.getLiveBtcEvents() now returns currently-firable
 * events across all three series with the status=open fix.
 */
import { KalshiClient } from "../src/kalshi/KalshiClient";
import { KalshiBTCFeed } from "../src/kalshi/KalshiBTCFeed";

const client = new KalshiClient({ demo: false });
const feed = new KalshiBTCFeed(client);

const nowS = Math.floor(Date.now() / 1000);
const fmt = (t: number) => {
  const dt = t - nowS;
  const sign = dt >= 0 ? "+" : "";
  return `${sign}${(dt / 60).toFixed(1)}m`;
};

const evs = await feed.getLiveBtcEvents(true);
console.log(`getLiveBtcEvents() returned ${evs.length} events`);
console.log("");

const bySeries = new Map<string, number>();
for (const e of evs) {
  bySeries.set(e.series_ticker, (bySeries.get(e.series_ticker) ?? 0) + 1);
}
for (const [s, n] of bySeries) console.log(`  ${s}: ${n} events`);
console.log("");

for (const e of evs) {
  const strikeTs = e.strike_date ? Date.parse(e.strike_date) / 1000 : 0;
  const mkts = e.markets ?? [];
  const active = mkts.filter((m) => m.status === "active" || (m.status as string) === "open").length;
  console.log(
    `  ${e.event_ticker.padEnd(28)} ${e.series_ticker.padEnd(10)} ` +
    `strike=${e.strike_date ?? "—"} (${strikeTs ? fmt(strikeTs) : "—"})  ` +
    `mkts=${mkts.length} active=${active}`,
  );
}

console.log("");
console.log("Checking spot + pickPrimaryEvent:");
const spot = await feed.getPrice("btc");
console.log(`  BTC spot: $${spot.toLocaleString()}`);
const primary = feed.pickPrimaryEvent(evs);
if (primary) {
  const strikeTs = Date.parse(primary.strike_date!) / 1000;
  console.log(`  primary: ${primary.event_ticker} (${primary.series_ticker}) strike=${fmt(strikeTs)}`);
} else {
  console.log(`  primary: none`);
}
