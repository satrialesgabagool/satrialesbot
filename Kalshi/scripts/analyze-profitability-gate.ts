#!/usr/bin/env bun
/**
 * Backtest the profitability gate against the historical tape.
 *
 * CRITICAL CONSTRAINT: one entry per market per settlement window.
 * The bot fires at most once per market ticker. For each resolved 15M
 * market, we find the EARLIEST trade on the winning side whose price
 * falls in our gate range — that's the simulated entry. If no qualifying
 * trade exists, the bot would have sat that window out.
 *
 * The tape contains thousands of trades per market from all participants;
 * counting every one would overcount by ~100x.
 */
import { Database } from "bun:sqlite";

const db = new Database("kalshi_tape.db", { readonly: true });

// ─── Gate parameters ───────────────────────────────────────────────
const TIME_MIN = 10;
const TIME_MAX = 300;
const PRICE_MIN = 0.70;
const PRICE_MAX = 0.85;
const ASSUMED_WR = 0.789;
const MARGIN = 0.05;
const EFFECTIVE_MAX = ASSUMED_WR - MARGIN; // 0.739

const SERIES = ["KXBTC15M", "KXXRP15M", "KXDOGE15M"];
const SERIES_SQL = SERIES.map(s => `'${s}'`).join(",");

// SQL building blocks
const SECS = `(julianday(m.close_time) - julianday(t.created_time)) * 86400.0`;

// ─── Data overview ─────────────────────────────────────────────────
interface RangeRow { earliest: string; latest: string; total: number; markets: number }
const range = db.query<RangeRow, []>(`
  SELECT MIN(m.close_time) AS earliest, MAX(m.close_time) AS latest,
         COUNT(DISTINCT m.ticker) AS markets,
         (SELECT COUNT(*) FROM trades t2 JOIN markets m2 ON t2.ticker = m2.ticker
          WHERE m2.series_ticker IN (${SERIES_SQL}) AND m2.result IS NOT NULL) AS total
  FROM markets m
  WHERE m.series_ticker IN (${SERIES_SQL}) AND m.result IS NOT NULL
`).get()!;

const hours = ((new Date(range.latest).getTime() - new Date(range.earliest).getTime()) / 3_600_000).toFixed(1);

console.log("═".repeat(100));
console.log("PROFITABILITY GATE BACKTEST — ONE ENTRY PER SETTLEMENT WINDOW");
console.log("═".repeat(100));
console.log(`Data window    : ${range.earliest}  →  ${range.latest}  (${hours}h)`);
console.log(`Resolved mkts  : ${range.markets} markets across ${SERIES.join(", ")}`);
console.log(`Raw trades      : ${range.total.toLocaleString()} (NOT the same as bot entries)`);
console.log(`Assumed WR      : ${(ASSUMED_WR * 100).toFixed(1)}%   Margin: ${(MARGIN * 100).toFixed(0)}%   Effective max: $${EFFECTIVE_MAX.toFixed(3)}`);
console.log("");

// ─── Simulate bot entry for each market ────────────────────────────
// For each resolved market, find the EARLIEST trade on the winning side
// in the time window. This is the price our bot would have entered at.
// The bot determines the winner from intrinsic (spot vs strike), which
// at settlement is equivalent to the eventual result.

interface MarketRow {
  ticker: string;
  series_ticker: string;
  result: string;
  close_time: string;
}

const allMarkets = db.query<MarketRow, []>(`
  SELECT ticker, series_ticker, result, close_time
  FROM markets
  WHERE series_ticker IN (${SERIES_SQL})
    AND result IS NOT NULL
  ORDER BY close_time
`).all();

interface SimEntry {
  ticker: string;
  series: string;
  result: string;       // "yes" or "no"
  entryPrice: number;   // what the bot paid
  side: "YES" | "NO";   // what the bot bought
  secsToClose: number;
  won: boolean;
  pnl: number;
}

// For each gate configuration, simulate entries
function simulate(priceMin: number, priceMax: number, timeMin: number, timeMax: number): SimEntry[] {
  const entries: SimEntry[] = [];

  for (const mkt of allMarkets) {
    // The bot buys the winning side. result='yes' → buy YES, result='no' → buy NO.
    const winningSide = mkt.result; // "yes" or "no"

    // Find the EARLIEST qualifying trade on the winning side in the time window.
    // For YES winner: look at taker_side='yes' trades (someone bought YES at yes_price).
    // For NO winner: look at taker_side='no' trades (someone bought NO at no_price).
    const priceCol = winningSide === "yes" ? "t.yes_price" : "t.no_price";

    const row = db.query<{ price: number; secs: number }, [string]>(`
      SELECT ${priceCol} AS price, ${SECS} AS secs
      FROM trades t
      JOIN markets m ON t.ticker = m.ticker
      WHERE t.ticker = ?
        AND t.taker_side = '${winningSide}'
        AND ${SECS} BETWEEN ${timeMin} AND ${timeMax}
        AND ${priceCol} BETWEEN ${priceMin} AND ${priceMax}
      ORDER BY t.created_time ASC
      LIMIT 1
    `).get(mkt.ticker);

    if (!row) continue; // no qualifying trade — bot sits this window out

    const won = true; // we bought the winning side by construction
    const pnl = 1.0 - row.price;
    entries.push({
      ticker: mkt.ticker,
      series: mkt.series_ticker,
      result: mkt.result,
      entryPrice: row.price,
      side: winningSide === "yes" ? "YES" : "NO",
      secsToClose: row.secs,
      won,
      pnl,
    });
  }
  return entries;
}

// But wait — the bot doesn't have perfect foresight. It uses spot vs strike
// to guess the winner. Sometimes it's WRONG (that's where losses come from).
// We need to also simulate entries on the LOSING side to get realistic WR.
//
// Approach: for each market, check BOTH sides. The bot picks the side that
// its intrinsic check would choose. In the tape, we can't know spot at scan
// time, but we can use a realistic proxy: look at the market's yes_price at
// entry time. If yes_price > 0.50, the bot would likely identify YES as
// the winner (it's the expensive side). If < 0.50, NO.
//
// Then check if that was actually correct.

function simulateRealistic(priceMin: number, priceMax: number, timeMin: number, timeMax: number): SimEntry[] {
  const entries: SimEntry[] = [];

  for (const mkt of allMarkets) {
    // Find the EARLIEST trade in the time window where either side's entry
    // price is in our gate range and the market consensus (yes price relative
    // to 0.50) determines which side the bot picks.
    //
    // Bot logic: if yes_ask > 0.50 → intrinsic = YES → buy YES at yes_price
    //            if yes_ask < 0.50 → intrinsic = NO  → buy NO at no_price
    //
    // We check both taker sides. A taker_side='yes' trade tells us yes_price
    // (what someone paid for YES). A taker_side='no' trade tells us no_price.
    // Either way, we know both prices since yes_price + no_price ≈ 1.

    const row = db.query<{
      yes_price: number; no_price: number; taker_side: string; secs: number;
    }, [string]>(`
      SELECT t.yes_price, t.no_price, t.taker_side, ${SECS} AS secs
      FROM trades t
      JOIN markets m ON t.ticker = m.ticker
      WHERE t.ticker = ?
        AND ${SECS} BETWEEN ${timeMin} AND ${timeMax}
        AND (
          (t.yes_price >= 0.50 AND t.yes_price BETWEEN ${priceMin} AND ${priceMax})
          OR
          (t.yes_price < 0.50 AND t.no_price BETWEEN ${priceMin} AND ${priceMax})
        )
      ORDER BY t.created_time ASC
      LIMIT 1
    `).get(mkt.ticker);

    if (!row) continue;

    // Bot picks the expensive side (market consensus = intrinsic proxy)
    const botSide: "YES" | "NO" = row.yes_price >= 0.50 ? "YES" : "NO";
    const entryPrice = botSide === "YES" ? row.yes_price : row.no_price;
    const won = (botSide === "YES" && mkt.result === "yes") ||
                (botSide === "NO" && mkt.result === "no");
    const pnl = won ? (1.0 - entryPrice) : (-entryPrice);

    entries.push({
      ticker: mkt.ticker,
      series: mkt.series_ticker,
      result: mkt.result,
      entryPrice,
      side: botSide,
      secsToClose: row.secs,
      won,
      pnl,
    });
  }
  return entries;
}

// ─── Report helper ─────────────────────────────────────────────────
function report(label: string, entries: SimEntry[]): void {
  if (entries.length === 0) {
    console.log(`  ${label.padEnd(28)} entries=     0  (no qualifying trades)`);
    return;
  }
  const n = entries.length;
  const wins = entries.filter(e => e.won).length;
  const losses = n - wins;
  const wr = wins / n;
  const totalPnl = entries.reduce((s, e) => s + e.pnl, 0);
  const avgPnl = totalPnl / n;
  const avgEntry = entries.reduce((s, e) => s + e.entryPrice, 0) / n;
  const avgWin = wins > 0
    ? entries.filter(e => e.won).reduce((s, e) => s + e.pnl, 0) / wins : 0;
  const avgLoss = losses > 0
    ? entries.filter(e => !e.won).reduce((s, e) => s + e.pnl, 0) / losses : 0;
  const be = avgLoss !== 0
    ? Math.abs(avgLoss) / (Math.abs(avgLoss) + avgWin) : 0;

  console.log(
    `  ${label.padEnd(28)} ` +
    `entries=${String(n).padStart(4)}  ` +
    `${String(wins).padStart(3)}W/${String(losses).padStart(2)}L  ` +
    `WR=${(wr * 100).toFixed(1).padStart(5)}%  ` +
    `avg_entry=$${avgEntry.toFixed(3)}  ` +
    `avg_win=$${avgWin.toFixed(3)}  ` +
    `avg_loss=$${avgLoss.toFixed(3)}  ` +
    `breakeven=${(be * 100).toFixed(1)}%  ` +
    `pnl=$${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`
  );
}

function reportBySeries(entries: SimEntry[]): void {
  for (const s of SERIES) {
    const subset = entries.filter(e => e.series === s);
    if (subset.length > 0) report(s, subset);
  }
  report("COMBINED", entries);
}

// ═══════════════════════════════════════════════════════════════════
//  RUN SIMULATIONS
// ═══════════════════════════════════════════════════════════════════

console.log("MODEL A — Perfect foresight (always buys the eventual winner)");
console.log("This is the CEILING — best possible outcome with our gates.");
console.log("─".repeat(100));

console.log("\n  Gate: time 10-300s + price 0.70-0.85");
const perfStd = simulate(PRICE_MIN, PRICE_MAX, TIME_MIN, TIME_MAX);
reportBySeries(perfStd);

console.log("\n  Gate: time 10-300s + profitability (0.70-0.739)");
const perfProf = simulate(PRICE_MIN, EFFECTIVE_MAX, TIME_MIN, TIME_MAX);
reportBySeries(perfProf);

console.log("");
console.log("═".repeat(100));
console.log("MODEL B — Realistic (bot picks expensive side as winner proxy)");
console.log("This models what the bot actually does: buy the side > $0.50.");
console.log("═".repeat(100));

console.log("\n  Gate: time 10-300s + price 0.70-0.85");
const realStd = simulateRealistic(PRICE_MIN, PRICE_MAX, TIME_MIN, TIME_MAX);
reportBySeries(realStd);

console.log("\n  Gate: time 10-300s + profitability (0.70-0.739)");
const realProf = simulateRealistic(PRICE_MIN, EFFECTIVE_MAX, TIME_MIN, TIME_MAX);
reportBySeries(realProf);

// ─── Stage breakdown (realistic model) ─────────────────────────────
console.log("\n  By stage (realistic, standard gates):");
const prime = realStd.filter(e => e.secsToClose <= 120);
const late = realStd.filter(e => e.secsToClose > 120 && e.secsToClose <= 300);
report("Prime ≤120s", prime);
report("Late 120-300s", late);

// ─── Self-calibration table ────────────────────────────────────────
console.log("\n" + "═".repeat(100));
console.log("SELF-CALIBRATION: realistic model at different effective max prices");
console.log("─".repeat(100));
console.log("  AssumedWR  EffMax  Entries  WR(actual)  TotalPnL  AvgPnL/entry");
console.log("  ─────────  ──────  ───────  ──────────  ────────  ────────────");
for (const wrPct of [75, 78.9, 80, 82, 85, 88, 90, 95, 100]) {
  const wr = wrPct / 100;
  const effMax = Math.min(wr - MARGIN, PRICE_MAX);
  if (effMax <= PRICE_MIN) {
    console.log(`  ${wrPct.toFixed(1).padStart(7)}%  $${effMax.toFixed(3)}  (below floor)`);
    continue;
  }
  const entries = simulateRealistic(PRICE_MIN, effMax, TIME_MIN, TIME_MAX);
  const n = entries.length;
  if (n === 0) { console.log(`  ${wrPct.toFixed(1).padStart(7)}%  $${effMax.toFixed(3)}  (no entries)`); continue; }
  const wins = entries.filter(e => e.won).length;
  const totalPnl = entries.reduce((s, e) => s + e.pnl, 0);
  console.log(
    `  ${wrPct.toFixed(1).padStart(7)}%  $${effMax.toFixed(3)}  ` +
    `${String(n).padStart(5)}    ` +
    `${(wins/n*100).toFixed(1).padStart(5)}%     ` +
    `$${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2).padStart(7)}  ` +
    `$${(totalPnl/n >= 0 ? "+" : "") + (totalPnl/n).toFixed(3)}`
  );
}

// ─── Detailed trade log (realistic, standard gates) ────────────────
console.log("\n" + "═".repeat(100));
console.log("SAMPLE ENTRIES (realistic model, standard 0.70-0.85, first 20)");
console.log("─".repeat(100));
for (const e of realStd.slice(0, 20)) {
  const tag = e.won ? "WIN " : "LOSS";
  console.log(
    `  ${tag} ${e.series.padEnd(11)} ${e.ticker.padEnd(30)} ` +
    `${e.side} @${e.entryPrice.toFixed(3)}  ` +
    `${e.secsToClose.toFixed(0).padStart(4)}s to close  ` +
    `pnl=$${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(3)}  ` +
    `result=${e.result}`
  );
}

// ─── Verdict ───────────────────────────────────────────────────────
console.log("\n" + "═".repeat(100));
console.log("VERDICT");
console.log("─".repeat(100));

const nStd = realStd.length;
const nProf = realProf.length;
const wrStd = realStd.filter(e => e.won).length / nStd;
const wrProf = realProf.length > 0 ? realProf.filter(e => e.won).length / nProf : 0;
const pnlStd = realStd.reduce((s, e) => s + e.pnl, 0);
const pnlProf = realProf.reduce((s, e) => s + e.pnl, 0);

console.log(`  Max possible entries (resolved markets): ${allMarkets.length}`);
console.log(`  Standard gates (0.70-0.85):      ${nStd} entries, ${(wrStd*100).toFixed(1)}% WR, $${pnlStd >= 0 ? "+" : ""}${pnlStd.toFixed(2)} PnL`);
console.log(`  With profitability (≤${EFFECTIVE_MAX.toFixed(3)}):  ${nProf} entries, ${(wrProf*100).toFixed(1)}% WR, $${pnlProf >= 0 ? "+" : ""}${pnlProf.toFixed(2)} PnL`);
console.log(`  Entries cut: ${nStd - nProf} (${((nStd - nProf)/nStd*100).toFixed(1)}%)`);
const pnlCut = pnlStd - pnlProf;
if (pnlCut > 0) {
  console.log(`  ⚠️  PnL lost by profitability gate: $${pnlCut.toFixed(2)}`);
} else {
  console.log(`  ✅ Profitability gate saved: $${Math.abs(pnlCut).toFixed(2)}`);
}
console.log("═".repeat(100));

db.close();
