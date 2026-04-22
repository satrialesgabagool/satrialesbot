#!/usr/bin/env bun
/**
 * Project the expected PnL under the new gates:
 *   time: <300s (prime+late only, no wide)
 *   price: 0.70-0.85 (tighter max)
 * Compare against old gates (time<600s, price 0.70-0.95).
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

function query(label: string, timeMax: number, priceMin: number, priceMax: number) {
  const series = ["KXBTC15M", "KXXRP15M", "KXDOGE15M"];
  for (const s of series) {
    const r = db.query<{
      n: number; wr: number; avg_pnl: number; total_pnl: number;
      avg_win: number; avg_loss: number;
    }, [string]>(`
      SELECT COUNT(*) n,
        SUM(CASE WHEN (${PNL})>0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr,
        AVG(${PNL}) avg_pnl,
        SUM(t.count_fp * (${PNL})) total_pnl,
        AVG(CASE WHEN (${PNL})>0 THEN ${PNL} END) avg_win,
        AVG(CASE WHEN (${PNL})<0 THEN ${PNL} END) avg_loss
      FROM trades t JOIN markets m ON t.ticker=m.ticker
      WHERE m.tape_collected_at IS NOT NULL
        AND m.series_ticker = ?
        AND ${SECS} < ${timeMax}
        AND ${PAID} BETWEEN ${priceMin} AND ${priceMax}
    `).get(s);
    if (!r || !r.n) continue;
    const breakeven = r.avg_loss ? Math.abs(r.avg_loss) / (Math.abs(r.avg_loss) + (r.avg_win ?? 0)) : 0;
    console.log(
      `  ${s.padEnd(12)} fills=${String(r.n).padStart(6)}  ` +
      `WR=${(r.wr*100).toFixed(1).padStart(5)}%  ` +
      `avg_win=$${(r.avg_win??0).toFixed(3)}  avg_loss=$${(r.avg_loss??0).toFixed(3)}  ` +
      `breakeven=${(breakeven*100).toFixed(1)}%  ` +
      `pnl/sh=$${(r.avg_pnl>=0?"+":"") + r.avg_pnl.toFixed(4)}  ` +
      `total=$${r.total_pnl.toFixed(0)}`
    );
  }
}

console.log("=".repeat(110));
console.log("OLD GATES: time<600s, price 0.70-0.95");
console.log("=".repeat(110));
query("old", 600, 0.70, 0.95);

console.log("");
console.log("=".repeat(110));
console.log("NEW GATES: time<300s (no wide), price 0.70-0.85");
console.log("=".repeat(110));
query("new", 300, 0.70, 0.85);

console.log("");
console.log("=".repeat(110));
console.log("AGGRESSIVE: time<120s (prime only), price 0.70-0.85");
console.log("=".repeat(110));
query("agg", 120, 0.70, 0.85);

console.log("");
console.log("=".repeat(110));
console.log("GOLDEN: time<60s, price 0.70-0.85");
console.log("=".repeat(110));
query("gold", 60, 0.70, 0.85);

db.close();
