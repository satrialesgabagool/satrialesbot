#!/usr/bin/env bun
/**
 * Generalized 15M edge analyzer — runs the golden-bucket comparison across
 * every 15M series present in kalshi_tape.db so we can see whether the
 * BTC-verified snipe edge translates to ETH/SOL/XRP/DOGE.
 *
 * Output shape:
 *   - OVERALL: fills, WR, pnl/share per series
 *   - GOLDEN: time<60s × price 0.70-0.95 per series (the snipe zone)
 *   - PRICE DECILE: WR + pnl/share per price bucket, per series
 *
 * KXBTC15M baseline from the first run: 92.25% WR / +$0.029/share / 1,857 fills
 */

import { Database } from "bun:sqlite";

const db = new Database("kalshi_tape.db", { readonly: true });

const PNL = `
  CASE
    WHEN t.taker_side='yes' AND m.result='yes' THEN 1.0 - t.yes_price
    WHEN t.taker_side='yes' AND m.result='no'  THEN -t.yes_price
    WHEN t.taker_side='no'  AND m.result='no'  THEN 1.0 - t.no_price
    WHEN t.taker_side='no'  AND m.result='yes' THEN -t.no_price
  END`;
const SECS = `(julianday(m.close_time) - julianday(t.created_time)) * 86400.0`;
const PAID = `CASE WHEN t.taker_side='yes' THEN t.yes_price ELSE t.no_price END`;

function pct(n: number | null | undefined): string {
  return ((n ?? 0) * 100).toFixed(2) + "%";
}
function money(n: number | null | undefined, sign = true): string {
  const v = n ?? 0;
  const s = (sign && v >= 0 ? "+" : "") + v.toFixed(4);
  return "$" + s.padStart(8);
}
function num(n: number | null | undefined): string {
  return Math.round(n ?? 0).toLocaleString();
}

function hr(s: string = "") { console.log(s); }

// ─── Discover which 15M series we've collected ────────────────────────

const present = db.query<{ series: string; n_mkts: number; n_trades: number }, []>(`
  SELECT m.series_ticker AS series,
         COUNT(DISTINCT m.ticker) AS n_mkts,
         COUNT(t.trade_id) AS n_trades
  FROM markets m
  LEFT JOIN trades t ON t.ticker = m.ticker
  WHERE m.tape_collected_at IS NOT NULL
    AND m.series_ticker LIKE '%15M'
  GROUP BY m.series_ticker
  ORDER BY n_trades DESC
`).all();

if (!present.length) {
  console.log("No 15M series tape found. Run kalshi-tape-collect.ts first.");
  process.exit(0);
}

hr("=".repeat(95));
hr("15M series — snipe edge comparison");
hr("=".repeat(95));
hr("");
hr("Collected series in kalshi_tape.db:");
for (const r of present) {
  hr(`  ${r.series.padEnd(12)} ${String(r.n_mkts).padStart(4)} markets  ${num(r.n_trades).padStart(10)} trades`);
}

// ─── Overall stats per series ─────────────────────────────────────────

function overallRow(series: string) {
  return db.query<{
    n: number; contracts: number; wr: number; avg_pnl: number; total_pnl: number;
  }, [string]>(`
    SELECT
      COUNT(*) n,
      SUM(t.count_fp) contracts,
      SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
      AVG(${PNL}) avg_pnl,
      SUM(t.count_fp * (${PNL})) total_pnl
    FROM trades t JOIN markets m ON t.ticker=m.ticker
    WHERE m.tape_collected_at IS NOT NULL
      AND m.series_ticker = ?
  `).get(series);
}

hr("");
hr("=".repeat(95));
hr("OVERALL TAKER STATS (held-to-settlement, all price zones, all times)");
hr("=".repeat(95));
hr(
  "  " + "series".padEnd(12) +
  "   fills".padStart(9) +
  "    contracts".padStart(12) +
  "     wr%".padStart(9) +
  "    pnl/sh".padStart(11) +
  "       total".padStart(13),
);
hr("  " + "-".repeat(70));
for (const s of present) {
  const r = overallRow(s.series);
  hr(
    `  ${s.series.padEnd(12)} ` +
    `${num(r?.n).padStart(9)} ` +
    `${num(r?.contracts).padStart(11)} ` +
    `${pct(r?.wr).padStart(8)} ` +
    `${money(r?.avg_pnl)} ` +
    `${money(r?.total_pnl, false).padStart(12)}`,
  );
}

// ─── Golden bucket per series ─────────────────────────────────────────

function goldenRow(series: string) {
  return db.query<{
    n: number; contracts: number; wr: number; avg_pnl: number; total_pnl: number;
  }, [string]>(`
    SELECT COUNT(*) n, SUM(t.count_fp) contracts,
           SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
           AVG(${PNL}) avg_pnl,
           SUM(t.count_fp * (${PNL})) total_pnl
    FROM trades t JOIN markets m ON t.ticker=m.ticker
    WHERE m.tape_collected_at IS NOT NULL
      AND m.series_ticker = ?
      AND ${SECS} < 60
      AND ${PAID} BETWEEN 0.70 AND 0.95
  `).get(series);
}

hr("");
hr("=".repeat(95));
hr("GOLDEN BUCKET — time<60s × price 0.70-0.95 (the snipe zone)");
hr("=".repeat(95));
hr(
  "  " + "series".padEnd(12) +
  "   fills".padStart(9) +
  "    contracts".padStart(12) +
  "     wr%".padStart(9) +
  "    pnl/sh".padStart(11) +
  "       total".padStart(13),
);
hr("  " + "-".repeat(70));
for (const s of present) {
  const r = goldenRow(s.series);
  hr(
    `  ${s.series.padEnd(12)} ` +
    `${num(r?.n).padStart(9)} ` +
    `${num(r?.contracts).padStart(11)} ` +
    `${pct(r?.wr).padStart(8)} ` +
    `${money(r?.avg_pnl)} ` +
    `${money(r?.total_pnl, false).padStart(12)}`,
  );
}

// ─── Time × price cross-tab per series ────────────────────────────────

function crosstab(series: string) {
  return db.query<{
    t_bucket: string; p_bucket: string; n: number; wr: number; avg_pnl: number;
  }, [string]>(`
    SELECT
      CASE
        WHEN ${SECS} < 60   THEN '01_<60s'
        WHEN ${SECS} < 300  THEN '02_<5m'
        WHEN ${SECS} < 1800 THEN '03_<30m'
        ELSE                     '04_30m+'
      END AS t_bucket,
      CASE
        WHEN ${PAID} < 0.30 THEN 'A_<0.30'
        WHEN ${PAID} < 0.70 THEN 'B_0.30-0.70'
        WHEN ${PAID} < 0.95 THEN 'C_0.70-0.95'
        ELSE                     'D_>=0.95'
      END AS p_bucket,
      COUNT(*) n,
      SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
      AVG(${PNL}) avg_pnl
    FROM trades t JOIN markets m ON t.ticker=m.ticker
    WHERE m.tape_collected_at IS NOT NULL
      AND m.series_ticker = ?
    GROUP BY t_bucket, p_bucket
    ORDER BY t_bucket, p_bucket
  `).all(series);
}

for (const s of present) {
  hr("");
  hr(`=== TIME × PRICE CROSS-TAB — ${s.series} ===`);
  hr("  t_bucket   p_bucket        fills     wr%      pnl/sh");
  hr("  " + "-".repeat(55));
  for (const r of crosstab(s.series)) {
    hr(
      `  ${r.t_bucket.padEnd(10)} ${r.p_bucket.padEnd(14)} ` +
      `${num(r.n).padStart(7)} ${pct(r.wr).padStart(7)} ${money(r.avg_pnl)}`,
    );
  }
}

// ─── Interpretation ───────────────────────────────────────────────────

hr("");
hr("=".repeat(95));
hr("INTERPRETATION GUIDE:");
hr("  - KXBTC15M baseline (prior run): 92.25% WR / +$0.029/share / 1,857 fills");
hr("  - Any series with WR >= 85% in the golden bucket has a real snipe edge.");
hr("  - WR < 75% in golden bucket = don't trade it — our gate assumptions fail.");
hr("  - Compare pnl/share: if positive AND fills are healthy (>500), it's live-ready.");
hr("=".repeat(95));

db.close();
