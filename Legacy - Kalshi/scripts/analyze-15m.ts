#!/usr/bin/env bun
/**
 * One-off analysis: does the snipe edge translate to KXBTC15M?
 *
 * Reproduces the key bucket tables from TapeAnalyzer but filters to
 * series_ticker='KXBTC15M'. Compares golden bucket (time<60s × price
 * 0.70-0.95) against the KXBTCD/KXBTC baseline (89.24% WR, +$0.046/share).
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

// Core WHERE — applied to every aggregate
const WHERE_15M = `
  WHERE m.tape_collected_at IS NOT NULL
    AND m.series_ticker = 'KXBTC15M'
`;
const WHERE_BTCD = `
  WHERE m.tape_collected_at IS NOT NULL
    AND m.series_ticker IN ('KXBTCD','KXBTC')
`;

function hr(s: string) {
  console.log(s);
}

function pct(n: number) { return (n * 100).toFixed(2) + "%"; }
function money(n: number, sign = true): string {
  const s = (sign && n >= 0 ? "+" : "") + n.toFixed(4);
  return "$" + s.padStart(8);
}
function num(n: number | null | undefined): string {
  return Math.round(n ?? 0).toLocaleString();
}

// ─── Overall ──────────────────────────────────────────────────────────

function overall(label: string, whereClause: string): void {
  const r = db.query<{
    n: number; contracts: number; wr: number; avg_pnl: number; total_pnl: number;
  }, []>(`
    SELECT
      COUNT(*) n,
      SUM(t.count_fp) contracts,
      SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
      AVG(${PNL}) avg_pnl,
      SUM(t.count_fp * (${PNL})) total_pnl
    FROM trades t JOIN markets m ON t.ticker=m.ticker
    ${whereClause}
  `).get();
  hr(`${label.padEnd(30)} fills=${num(r?.n).padStart(9)}  ` +
     `ct=${num(r?.contracts).padStart(11)}  wr=${pct(r?.wr ?? 0).padStart(7)}  ` +
     `pnl/sh=${money(r?.avg_pnl ?? 0)}  total=${money(r?.total_pnl ?? 0, false).padStart(12)}`);
}

// ─── Time × Price cross-tab ───────────────────────────────────────────

function crosstab(label: string, whereClause: string): void {
  hr("");
  hr(`=== TIME × PRICE CROSS-TAB — ${label} ===`);
  hr("  t_bucket   p_bucket        fills  contracts     wr%     pnl/sh      total");
  hr("  " + "-".repeat(72));
  const rows = db.query<{
    t_bucket: string; p_bucket: string; n: number; contracts: number;
    wr: number; avg_pnl: number; total_pnl: number;
  }, []>(`
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
      SUM(t.count_fp) contracts,
      SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
      AVG(${PNL}) avg_pnl,
      SUM(t.count_fp * (${PNL})) total_pnl
    FROM trades t JOIN markets m ON t.ticker=m.ticker
    ${whereClause}
    GROUP BY t_bucket, p_bucket
    ORDER BY t_bucket, p_bucket
  `).all();
  for (const r of rows) {
    hr(
      `  ${r.t_bucket.padEnd(10)} ${r.p_bucket.padEnd(14)} ` +
      `${num(r.n).padStart(7)} ${num(r.contracts).padStart(10)} ` +
      `${pct(r.wr).padStart(7)} ${money(r.avg_pnl)} ` +
      `${money(r.total_pnl, false).padStart(12)}`,
    );
  }
}

// ─── By time-to-close ─────────────────────────────────────────────────

function byTime(label: string, whereClause: string): void {
  hr("");
  hr(`=== BY TIME-TO-CLOSE — ${label} ===`);
  hr("  bucket               fills   contracts     wr%     pnl/sh       total");
  hr("  " + "-".repeat(68));
  const rows = db.query<{
    bucket: string; mins: number; n: number; contracts: number;
    wr: number; avg_pnl: number; total_pnl: number;
  }, []>(`
    SELECT
      CASE
        WHEN ${SECS} < 15   THEN '00_<15s'
        WHEN ${SECS} < 30   THEN '01_<30s'
        WHEN ${SECS} < 60   THEN '02_<60s'
        WHEN ${SECS} < 120  THEN '03_<120s'
        WHEN ${SECS} < 300  THEN '04_<5m'
        WHEN ${SECS} < 600  THEN '05_<10m'
        ELSE                     '06_10m+'
      END bucket,
      MIN(${SECS}) mins,
      COUNT(*) n, SUM(t.count_fp) contracts,
      SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
      AVG(${PNL}) avg_pnl,
      SUM(t.count_fp * (${PNL})) total_pnl
    FROM trades t JOIN markets m ON t.ticker=m.ticker
    ${whereClause}
    GROUP BY bucket
    ORDER BY mins
  `).all();
  for (const r of rows) {
    hr(
      `  ${r.bucket.padEnd(18)} ${num(r.n).padStart(7)} ${num(r.contracts).padStart(11)} ` +
      `${pct(r.wr).padStart(7)} ${money(r.avg_pnl)}  ${money(r.total_pnl, false).padStart(12)}`,
    );
  }
}

// ─── Golden bucket comparison ─────────────────────────────────────────

function goldenBucket(label: string, whereClause: string): void {
  const r = db.query<{
    n: number; contracts: number; wr: number; avg_pnl: number; total_pnl: number;
  }, []>(`
    SELECT COUNT(*) n, SUM(t.count_fp) contracts,
           SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
           AVG(${PNL}) avg_pnl,
           SUM(t.count_fp * (${PNL})) total_pnl
    FROM trades t JOIN markets m ON t.ticker=m.ticker
    ${whereClause}
      AND ${SECS} < 60
      AND ${PAID} BETWEEN 0.70 AND 0.95
  `).get();
  hr(`${label.padEnd(30)} ` +
     `fills=${num(r?.n).padStart(6)}  ct=${num(r?.contracts).padStart(9)}  ` +
     `wr=${pct(r?.wr ?? 0).padStart(7)}  pnl/sh=${money(r?.avg_pnl ?? 0)}  ` +
     `total=${money(r?.total_pnl ?? 0, false).padStart(10)}`);
}

// ─── Run ──────────────────────────────────────────────────────────────

hr("=".repeat(85));
hr("KXBTC15M vs KXBTCD/KXBTC — tape comparison (held-to-settlement PnL)");
hr("=".repeat(85));

hr("");
hr("OVERALL TAKER STATS:");
overall("  KXBTCD+KXBTC (baseline)", WHERE_BTCD);
overall("  KXBTC15M (new 24h pull)", WHERE_15M);

hr("");
hr("GOLDEN BUCKET (time<60s × price 0.70-0.95):");
goldenBucket("  KXBTCD+KXBTC (baseline)", WHERE_BTCD);
goldenBucket("  KXBTC15M", WHERE_15M);

crosstab("KXBTC15M", WHERE_15M);
byTime("KXBTC15M", WHERE_15M);

// Also break 15M out by price independently
hr("");
hr("=== BY TAKER-PAID PRICE — KXBTC15M ===");
hr("  bucket              fills   contracts     wr%    pnl/sh      total");
hr("  " + "-".repeat(66));
const prows = db.query<{
  bucket: string; p: number; n: number; contracts: number;
  wr: number; avg_pnl: number; total_pnl: number;
}, []>(`
  SELECT
    CASE
      WHEN ${PAID} < 0.05 THEN '[0.00, 0.05)'
      WHEN ${PAID} < 0.15 THEN '[0.05, 0.15)'
      WHEN ${PAID} < 0.30 THEN '[0.15, 0.30)'
      WHEN ${PAID} < 0.50 THEN '[0.30, 0.50)'
      WHEN ${PAID} < 0.70 THEN '[0.50, 0.70)'
      WHEN ${PAID} < 0.85 THEN '[0.70, 0.85)'
      WHEN ${PAID} < 0.95 THEN '[0.85, 0.95)'
      ELSE                     '[0.95, 1.00]'
    END bucket,
    MIN(${PAID}) p,
    COUNT(*) n, SUM(t.count_fp) contracts,
    SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
    AVG(${PNL}) avg_pnl, SUM(t.count_fp * (${PNL})) total_pnl
  FROM trades t JOIN markets m ON t.ticker=m.ticker
  ${WHERE_15M}
  GROUP BY bucket ORDER BY p
`).all();
for (const r of prows) {
  hr(
    `  ${r.bucket.padEnd(18)} ${num(r.n).padStart(7)} ${num(r.contracts).padStart(11)} ` +
    `${pct(r.wr).padStart(7)} ${money(r.avg_pnl)} ${money(r.total_pnl, false).padStart(12)}`,
  );
}

hr("");
hr("=".repeat(85));
hr("INTERPRETATION:");
hr("  - Baseline golden bucket is 89.24% WR / +$0.046/share from the 159k-trade study.");
hr("  - If KXBTC15M shows WR >= 85% in the same bucket, the snipe thesis translates.");
hr("  - If pnl/share is comparably positive, the bot can trade 15M markets as-is.");
hr("=".repeat(85));

db.close();
