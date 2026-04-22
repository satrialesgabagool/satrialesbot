#!/usr/bin/env bun
/**
 * Diagnostic: what do min_close_ts / max_close_ts actually filter on?
 *
 * The bot ran for 36 min with 0 snipes. Investigation suggested the API is
 * ignoring max_close_ts. This script tests each series with several window
 * widths and prints the raw closeTs/strikeDate distribution so we can see
 * exactly what's being filtered (if anything).
 */
import { KalshiClient } from "../src/kalshi/KalshiClient";

const client = new KalshiClient({ demo: false });
const nowS = Math.floor(Date.now() / 1000);
const nowIso = new Date(nowS * 1000).toISOString();

console.log("=".repeat(78));
console.log(`Diagnostic: Kalshi /events min_close_ts + max_close_ts behavior`);
console.log(`now = ${nowIso}  (${nowS})`);
console.log("=".repeat(78));

async function probe(series: string, window: { min?: number; max?: number; label: string }) {
  const params: Record<string, unknown> = {
    series_ticker: series,
    with_nested_markets: true,
    limit: 50,
  };
  if (window.min != null) params.min_close_ts = nowS + window.min;
  if (window.max != null) params.max_close_ts = nowS + window.max;

  try {
    const res = await client.getEvents(params as never);
    const evs = res.events ?? [];
    const strikeTimes = evs
      .map((e) => {
        const t = e.strike_date ? Date.parse(e.strike_date) / 1000 : 0;
        return t;
      })
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    const marketCloses = evs
      .flatMap((e) => e.markets ?? [])
      .map((m) => (m.close_time ? Date.parse(m.close_time) / 1000 : 0))
      .filter((t) => t > 0)
      .sort((a, b) => a - b);

    const fmt = (t: number) => {
      const dt = t - nowS;
      const sign = dt >= 0 ? "+" : "";
      const h = dt / 3600;
      return `${new Date(t * 1000).toISOString().slice(11, 19)}Z (${sign}${h.toFixed(2)}h)`;
    };

    console.log("");
    console.log(`[${series}] ${window.label}`);
    console.log(`  returned: ${evs.length} events, ${marketCloses.length} markets`);
    if (strikeTimes.length) {
      console.log(`  strike_date range:  ${fmt(strikeTimes[0])}  ..  ${fmt(strikeTimes[strikeTimes.length - 1])}`);
    }
    if (marketCloses.length) {
      console.log(`  market close range: ${fmt(marketCloses[0])}  ..  ${fmt(marketCloses[marketCloses.length - 1])}`);
    }
    // Bucket by hours-from-now
    const buckets = new Map<string, number>();
    for (const t of marketCloses) {
      const h = Math.floor((t - nowS) / 3600);
      const key = h < 0 ? `past` : `${h}h`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const keys = [...buckets.keys()].sort();
    if (keys.length) {
      console.log(`  bucket (hours-from-now): ${keys.map((k) => `${k}=${buckets.get(k)}`).join(" ")}`);
    }
    // Show first 3 event tickers + their close times
    for (const e of evs.slice(0, 3)) {
      const m = e.markets?.[0];
      const mc = m?.close_time ? Date.parse(m.close_time) / 1000 : 0;
      console.log(`    e=${e.event_ticker.padEnd(24)} strike=${e.strike_date ?? "—"}  mkt_close=${mc ? fmt(mc) : "—"}  status=${m?.status ?? "—"}`);
    }
  } catch (err) {
    console.log(`[${series}] ${window.label}  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const series = ["KXBTCD", "KXBTC", "KXBTC15M"];
const windows = [
  { label: "no filter (defaults)" },
  { min: 0, label: "min_close_ts=now" },
  { min: 0, max: 900, label: "min_close_ts=now, max_close_ts=now+15m" },
  { min: 0, max: 1800, label: "min_close_ts=now, max_close_ts=now+30m" },
  { min: 0, max: 3600, label: "min_close_ts=now, max_close_ts=now+1h" },
  { min: 0, max: 86400, label: "min_close_ts=now, max_close_ts=now+24h" },
];

for (const s of series) {
  console.log("");
  console.log("─".repeat(78));
  for (const w of windows) {
    await probe(s, w);
  }
}

console.log("");
console.log("=".repeat(78));
console.log("INTERPRETATION:");
console.log("  - If 'no filter' and 'max_close_ts=now+15m' return identical event sets,");
console.log("    the filter is being IGNORED.");
console.log("  - If market close_time falls OUTSIDE [now, now+window], filter applies");
console.log("    to a different field (e.g., event.strike_date vs market.close_time).");
console.log("  - The distribution buckets reveal what the default sort order is.");
console.log("=".repeat(78));
