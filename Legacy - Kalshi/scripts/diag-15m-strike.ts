#!/usr/bin/env bun
/**
 * Pull a live KXBTC15M market and print every field that could contain a
 * strike so we can fix getStrikePrice.
 */
import { KalshiClient } from "../src/kalshi/KalshiClient";

const client = new KalshiClient({ demo: false });
const res = await client.getEvents({
  series_ticker: "KXBTC15M",
  status: "open",
  with_nested_markets: true,
  limit: 5,
});
const evs = res.events ?? [];
for (const e of evs) {
  const m = (e.markets ?? [])[0];
  if (!m) continue;
  console.log(`Event: ${e.event_ticker}`);
  console.log(`  strike_date: ${e.strike_date}`);
  console.log(`Market: ${m.ticker}`);
  console.log(`  yes_sub_title:  ${m.yes_sub_title}`);
  console.log(`  no_sub_title:   ${m.no_sub_title}`);
  console.log(`  floor_strike:   ${m.floor_strike}`);
  console.log(`  cap_strike:     ${m.cap_strike}`);
  console.log(`  strike_type:    ${m.strike_type}`);
  console.log(`  expiration_value: ${m.expiration_value}`);
  console.log(`  rules_primary:  ${m.rules_primary?.slice(0, 200)}`);
  console.log(`  status:         ${m.status}`);
  console.log(`  open_time:      ${m.open_time}`);
  console.log(`  close_time:     ${m.close_time}`);
  console.log(`  yes_bid/ask:    ${m.yes_bid_dollars} / ${m.yes_ask_dollars}`);
}
// And also an ETH/SOL/XRP/DOGE one for comparison
for (const series of ["KXETH15M", "KXSOL15M", "KXXRP15M", "KXDOGE15M"]) {
  console.log("");
  console.log("-".repeat(70));
  const r = await client.getEvents({
    series_ticker: series,
    status: "open",
    with_nested_markets: true,
    limit: 1,
  });
  const e = (r.events ?? [])[0];
  const m = e?.markets?.[0];
  if (!m) { console.log(`${series}: no open market`); continue; }
  console.log(`${series}: ${m.ticker}`);
  console.log(`  yes_sub_title:  ${m.yes_sub_title}`);
  console.log(`  floor_strike:   ${m.floor_strike}`);
  console.log(`  cap_strike:     ${m.cap_strike}`);
  console.log(`  strike_type:    ${m.strike_type}`);
  console.log(`  expiration_value: ${m.expiration_value}`);
}
