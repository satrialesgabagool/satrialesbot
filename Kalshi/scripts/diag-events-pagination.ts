#!/usr/bin/env bun
/**
 * Follow-up diagnostic: the 50-event page for KXBTC15M covers strike_dates
 * 8h..20h from now. Events closing in the next 8 hours are missing.
 *
 * Test:
 *   A) Does the cursor work? Page through and see if nearest events appear.
 *   B) Does /markets?series_ticker=KXBTC15M&status=active return nearer ones?
 *   C) Does /events with status=open return something useful?
 */
import { KalshiClient } from "../src/kalshi/KalshiClient";

const client = new KalshiClient({ demo: false });
const nowS = Math.floor(Date.now() / 1000);
const fmt = (t: number) => {
  const dt = t - nowS;
  const sign = dt >= 0 ? "+" : "";
  return `${new Date(t * 1000).toISOString().slice(11, 19)}Z (${sign}${(dt / 3600).toFixed(2)}h)`;
};

console.log("=".repeat(78));
console.log(`now = ${new Date(nowS * 1000).toISOString()}`);
console.log("=".repeat(78));

// ─── A) Pagination ────────────────────────────────────────────────────

console.log("\n[A] paginate /events?series_ticker=KXBTC15M with cursor\n");
let cursor: string | undefined;
let page = 0;
const allStrikes: number[] = [];
do {
  const res = await client.getEvents({
    series_ticker: "KXBTC15M",
    with_nested_markets: true,
    limit: 200,
    cursor,
  });
  page++;
  const ts = (res.events ?? [])
    .map((e) => (e.strike_date ? Date.parse(e.strike_date) / 1000 : 0))
    .filter((t) => t > 0);
  ts.sort((a, b) => a - b);
  allStrikes.push(...ts);
  console.log(
    `  page ${page}: ${res.events?.length ?? 0} events  ` +
    `range ${ts.length ? fmt(ts[0]) : "—"} .. ${ts.length ? fmt(ts[ts.length - 1]) : "—"}  ` +
    `cursor=${res.cursor ? res.cursor.slice(0, 12) + "…" : "(none)"}`,
  );
  cursor = res.cursor || undefined;
  if (page >= 10) break; // safety
} while (cursor);
allStrikes.sort((a, b) => a - b);
console.log(
  `  total events: ${allStrikes.length}  ` +
  `nearest=${allStrikes.length ? fmt(allStrikes[0]) : "—"}  ` +
  `furthest=${allStrikes.length ? fmt(allStrikes[allStrikes.length - 1]) : "—"}`,
);
// Coverage check: how many in each 1h bucket 0-24h from now?
const hb = new Map<number, number>();
for (const t of allStrikes) {
  const h = Math.floor((t - nowS) / 3600);
  hb.set(h, (hb.get(h) ?? 0) + 1);
}
const hs = [...hb.keys()].sort((a, b) => a - b);
console.log(`  hour coverage: ${hs.map((h) => `${h}h=${hb.get(h)}`).join(" ")}`);

// ─── B) /markets status=active ───────────────────────────────────────

console.log("\n[B] /markets?series_ticker=KXBTC15M&status=open (paginated)\n");
cursor = undefined;
page = 0;
const marketCloses: Array<{ t: number; ticker: string; status: string }> = [];
do {
  try {
    const res = await client.getMarkets({
      series_ticker: "KXBTC15M",
      status: "open",
      limit: 200,
      cursor,
    });
    page++;
    for (const m of res.markets ?? []) {
      const t = m.close_time ? Date.parse(m.close_time) / 1000 : 0;
      if (t > 0) marketCloses.push({ t, ticker: m.ticker, status: m.status });
    }
    console.log(`  page ${page}: ${res.markets?.length ?? 0} markets  cursor=${res.cursor ? "yes" : "none"}`);
    cursor = res.cursor || undefined;
    if (page >= 10) break;
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    break;
  }
} while (cursor);
marketCloses.sort((a, b) => a.t - b.t);
const future = marketCloses.filter((m) => m.t >= nowS);
console.log(`  total markets: ${marketCloses.length}  future: ${future.length}`);
if (future.length) {
  console.log(`  nearest future: ${fmt(future[0].t)}  ${future[0].ticker}  status=${future[0].status}`);
  console.log(`  next 5:`);
  for (const m of future.slice(0, 5)) {
    console.log(`    ${m.ticker.padEnd(32)} close=${fmt(m.t)}  status=${m.status}`);
  }
}

// ─── C) /events status=open ────────────────────────────────────────────

console.log("\n[C] /events?series_ticker=KXBTC15M&status=open\n");
try {
  const res = await client.getEvents({
    series_ticker: "KXBTC15M",
    status: "open",
    with_nested_markets: true,
    limit: 200,
  });
  const evs = res.events ?? [];
  const ts = evs
    .map((e) => (e.strike_date ? Date.parse(e.strike_date) / 1000 : 0))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  console.log(`  returned ${evs.length} events`);
  if (ts.length) {
    console.log(`  range: ${fmt(ts[0])} .. ${fmt(ts[ts.length - 1])}`);
  }
  for (const e of evs.slice(0, 3)) {
    const m = e.markets?.[0];
    console.log(`    ${e.event_ticker.padEnd(28)} strike=${e.strike_date ?? "—"}  mkt_status=${m?.status ?? "—"}`);
  }
} catch (err) {
  console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
}

// ─── D) /events status=unopened — maybe 15M events are "unopened" before market opens ─────

console.log("\n[D] /events?series_ticker=KXBTC15M&status=unopened\n");
try {
  const res = await client.getEvents({
    series_ticker: "KXBTC15M",
    status: "unopened",
    with_nested_markets: true,
    limit: 200,
  });
  const evs = res.events ?? [];
  const ts = evs
    .map((e) => (e.strike_date ? Date.parse(e.strike_date) / 1000 : 0))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  console.log(`  returned ${evs.length} events`);
  if (ts.length) {
    console.log(`  range: ${fmt(ts[0])} .. ${fmt(ts[ts.length - 1])}`);
  }
  for (const e of evs.slice(0, 3)) {
    const m = e.markets?.[0];
    console.log(`    ${e.event_ticker.padEnd(28)} strike=${e.strike_date ?? "—"}  mkt_status=${m?.status ?? "—"}`);
  }
} catch (err) {
  console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
}

console.log("\n" + "=".repeat(78));
