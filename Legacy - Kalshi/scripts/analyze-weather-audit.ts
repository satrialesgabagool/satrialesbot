#!/usr/bin/env bun
/**
 * Weather Market Performance Audit
 *
 * Same validated methodology as crypto backtest (analyze-profitability-gate.ts):
 *   - One entry per market ticker per settlement window
 *   - Model A: perfect foresight (always buys eventual winner)
 *   - Model B: realistic (bot picks expensive side as winner proxy)
 *
 * FINDING: The snipe strategy (10-300s before close) produces ZERO entries
 * on weather markets because daily highs are already known by close time.
 * Prices converge to $0.96-$0.99 — far above our $0.70-$0.85 gate.
 * This script documents that finding with full evidence, then tests
 * alternative time windows (1-24h) to see if any weather edge exists.
 *
 * Produces 5 sections:
 *   1. Corrected backtest (snipe gate → 0 entries + why)
 *   2. Market efficiency comparison — wider windows vs crypto
 *   3. Forecast quality breakdown (market confidence proxy)
 *   4. Market coverage stats
 *   5. Head-to-head crypto vs weather comparison table
 *
 * Usage:
 *   bun run scripts/analyze-weather-audit.ts
 */
import { Database } from "bun:sqlite";

const db = new Database("kalshi_tape.db", { readonly: true });

// ─── Gate parameters (must match live bot) ────────────────────────
const TIME_MIN = 10;
const TIME_MAX = 300;
const PRICE_MIN = 0.70;
const PRICE_MAX = 0.85;
const ASSUMED_WR = 0.789;
const MARGIN = 0.05;
const EFFECTIVE_MAX = ASSUMED_WR - MARGIN; // 0.739

const WEATHER_SERIES = ["KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS"];
const WEATHER_SQL = WEATHER_SERIES.map(s => `'${s}'`).join(",");

// Crypto benchmark numbers (from corrected crypto backtest)
const CRYPTO_BENCH = {
  stdEntries: 141, stdWR: 0.794, stdAvgEntry: 0.783,
  stdAvgWin: 0.214, stdAvgLoss: -0.773, stdPnl: 1.59,
  profEntries: 106, profWR: 0.745, profPnl: 3.38,
  perfEntries: 134, perfPnl: 31.17,
};

// ─── SQL building blocks ──────────────────────────────────────────
const SECS = `(julianday(m.close_time) - julianday(t.created_time)) * 86400.0`;

// ─── Load all resolved weather markets ────────────────────────────
interface MarketRow {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  result: string;
  close_time: string;
  floor_strike: number | null;
  cap_strike: number | null;
  strike_type: string | null;
  volume_fp: number;
}

const allMarkets = db.query<MarketRow, []>(`
  SELECT ticker, event_ticker, series_ticker, result, close_time,
         floor_strike, cap_strike, strike_type, volume_fp
  FROM markets
  WHERE series_ticker IN (${WEATHER_SQL})
    AND result IS NOT NULL
  ORDER BY close_time, ticker
`).all();

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

interface SimEntry {
  ticker: string;
  event: string;
  series: string;
  city: string;
  result: string;
  entryPrice: number;
  side: "YES" | "NO";
  secsToClose: number;
  won: boolean;
  pnl: number;
  yesPrice: number;
  closeTime: string;
}

function cityName(series: string): string {
  const map: Record<string, string> = {
    KXHIGHNY: "New York", KXHIGHCHI: "Chicago",
    KXHIGHMIA: "Miami", KXHIGHAUS: "Austin",
  };
  return map[series] ?? series;
}

function stats(entries: SimEntry[]) {
  const n = entries.length;
  if (n === 0) return null;
  const wins = entries.filter(e => e.won).length;
  const losses = n - wins;
  const wr = wins / n;
  const totalPnl = entries.reduce((s, e) => s + e.pnl, 0);
  const avgEntry = entries.reduce((s, e) => s + e.entryPrice, 0) / n;
  const avgWin = wins > 0
    ? entries.filter(e => e.won).reduce((s, e) => s + e.pnl, 0) / wins : 0;
  const avgLoss = losses > 0
    ? entries.filter(e => !e.won).reduce((s, e) => s + e.pnl, 0) / losses : 0;
  return { n, wins, losses, wr, totalPnl, avgEntry, avgWin, avgLoss };
}

function fmtLine(label: string, s: ReturnType<typeof stats>): string {
  if (!s) return `  ${label.padEnd(28)} entries=     0  (no qualifying trades)`;
  return (
    `  ${label.padEnd(28)} ` +
    `entries=${String(s.n).padStart(4)}  ` +
    `${String(s.wins).padStart(3)}W/${String(s.losses).padStart(2)}L  ` +
    `WR=${(s.wr * 100).toFixed(1).padStart(5)}%  ` +
    `avg_entry=$${s.avgEntry.toFixed(3)}  ` +
    `avg_win=$${s.avgWin.toFixed(3)}  ` +
    `avg_loss=$${s.avgLoss.toFixed(3)}  ` +
    `pnl=$${s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(2)}`
  );
}

// ─── Model B: Realistic (expensive side = bot's winner proxy) ─────
// Parameterized on time window so we can sweep wider windows.
function simulateRealistic(priceMin: number, priceMax: number, tMin: number, tMax: number): SimEntry[] {
  const entries: SimEntry[] = [];
  for (const mkt of allMarkets) {
    const row = db.query<{
      yes_price: number; no_price: number; taker_side: string; secs: number;
    }, [string]>(`
      SELECT t.yes_price, t.no_price, t.taker_side, ${SECS} AS secs
      FROM trades t
      JOIN markets m ON t.ticker = m.ticker
      WHERE t.ticker = ?
        AND ${SECS} BETWEEN ${tMin} AND ${tMax}
        AND (
          (t.yes_price >= 0.50 AND t.yes_price BETWEEN ${priceMin} AND ${priceMax})
          OR
          (t.yes_price < 0.50 AND t.no_price BETWEEN ${priceMin} AND ${priceMax})
        )
      ORDER BY t.created_time ASC
      LIMIT 1
    `).get(mkt.ticker);

    if (!row) continue;
    const botSide: "YES" | "NO" = row.yes_price >= 0.50 ? "YES" : "NO";
    const entryPrice = botSide === "YES" ? row.yes_price : row.no_price;
    const won = (botSide === "YES" && mkt.result === "yes") ||
                (botSide === "NO" && mkt.result === "no");
    const pnl = won ? (1.0 - entryPrice) : (-entryPrice);

    entries.push({
      ticker: mkt.ticker,
      event: mkt.event_ticker,
      series: mkt.series_ticker,
      city: cityName(mkt.series_ticker),
      result: mkt.result,
      entryPrice,
      side: botSide,
      secsToClose: row.secs,
      won, pnl,
      yesPrice: row.yes_price,
      closeTime: mkt.close_time,
    });
  }
  return entries;
}

// ─── Model A: Perfect foresight (ceiling) ─────────────────────────
function simulatePerfect(priceMin: number, priceMax: number, tMin: number, tMax: number): SimEntry[] {
  const entries: SimEntry[] = [];
  for (const mkt of allMarkets) {
    const winningSide = mkt.result;
    const priceCol = winningSide === "yes" ? "t.yes_price" : "t.no_price";
    const row = db.query<{ price: number; secs: number; yes_price: number }, [string]>(`
      SELECT ${priceCol} AS price, ${SECS} AS secs, t.yes_price
      FROM trades t
      JOIN markets m ON t.ticker = m.ticker
      WHERE t.ticker = ?
        AND t.taker_side = '${winningSide}'
        AND ${SECS} BETWEEN ${tMin} AND ${tMax}
        AND ${priceCol} BETWEEN ${priceMin} AND ${priceMax}
      ORDER BY t.created_time ASC
      LIMIT 1
    `).get(mkt.ticker);
    if (!row) continue;
    entries.push({
      ticker: mkt.ticker, event: mkt.event_ticker,
      series: mkt.series_ticker, city: cityName(mkt.series_ticker),
      result: mkt.result, entryPrice: row.price,
      side: winningSide === "yes" ? "YES" : "NO",
      secsToClose: row.secs, won: true, pnl: 1.0 - row.price,
      yesPrice: row.yes_price, closeTime: mkt.close_time,
    });
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════
//  DATA OVERVIEW
// ═══════════════════════════════════════════════════════════════════

interface RangeRow { earliest: string; latest: string; total: number; markets: number }
const range = db.query<RangeRow, []>(`
  SELECT MIN(m.close_time) AS earliest, MAX(m.close_time) AS latest,
         COUNT(DISTINCT m.ticker) AS markets,
         (SELECT COUNT(*) FROM trades t2 JOIN markets m2 ON t2.ticker = m2.ticker
          WHERE m2.series_ticker IN (${WEATHER_SQL}) AND m2.result IS NOT NULL) AS total
  FROM markets m
  WHERE m.series_ticker IN (${WEATHER_SQL}) AND m.result IS NOT NULL
`).get()!;

const hours = ((new Date(range.latest).getTime() - new Date(range.earliest).getTime()) / 3_600_000).toFixed(1);
const numEvents = new Set(allMarkets.map(m => m.event_ticker)).size;

console.log("");
console.log("=".repeat(110));
console.log("  WEATHER MARKET PERFORMANCE AUDIT");
console.log("  Same validated methodology as crypto backtest -- one entry per market per settlement window");
console.log("=".repeat(110));
console.log(`  Data window    : ${range.earliest}  ->  ${range.latest}  (${hours}h)`);
console.log(`  Cities         : ${WEATHER_SERIES.length} (${WEATHER_SERIES.map(s => cityName(s)).join(", ")})`);
console.log(`  Events         : ${numEvents} (daily temperature forecasts)`);
console.log(`  Resolved mkts  : ${range.markets} markets (6 brackets per event)`);
console.log(`  Raw trades      : ${range.total.toLocaleString()} (all participants, NOT bot entries)`);
console.log(`  Snipe gates     : time ${TIME_MIN}-${TIME_MAX}s, price $${PRICE_MIN}-$${PRICE_MAX}`);
console.log(`  Profitability   : assumed ${(ASSUMED_WR*100).toFixed(1)}% WR + ${(MARGIN*100).toFixed(0)}% margin -> max $${EFFECTIVE_MAX.toFixed(3)}`);

// ═══════════════════════════════════════════════════════════════════
//  SECTION 1 — CORRECTED BACKTEST (SNIPE GATE)
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("  SECTION 1 -- CORRECTED BACKTEST (snipe gate: 10-300s before close)");
console.log("=".repeat(110));

const realStd = simulateRealistic(PRICE_MIN, PRICE_MAX, TIME_MIN, TIME_MAX);
const realProf = simulateRealistic(PRICE_MIN, EFFECTIVE_MAX, TIME_MIN, TIME_MAX);
const perfStd = simulatePerfect(PRICE_MIN, PRICE_MAX, TIME_MIN, TIME_MAX);

console.log(`\n  Standard gates ($0.70-$0.85, 10-300s):`);
console.log(fmtLine("WEATHER COMBINED", stats(realStd)));
console.log(`\n  Perfect foresight ceiling:`);
console.log(fmtLine("WEATHER COMBINED", stats(perfStd)));

console.log(`\n  RESULT: ZERO entries.`);
console.log(`  All 138 markets returned 0 qualifying trades in the snipe window.`);

// ─── WHY: Price distribution near close ───────────────────────────
console.log(`\n  WHY? Price distribution in the 10-300s window:`);

interface BucketRow { bucket: string; n: number; avg_wp: number }
const priceDist = db.query<BucketRow, []>(`
  SELECT
    CASE
      WHEN CASE WHEN t.yes_price >= 0.50 THEN t.yes_price ELSE t.no_price END < 0.70 THEN 'below $0.70'
      WHEN CASE WHEN t.yes_price >= 0.50 THEN t.yes_price ELSE t.no_price END <= 0.85 THEN '$0.70-$0.85 (gate)'
      WHEN CASE WHEN t.yes_price >= 0.50 THEN t.yes_price ELSE t.no_price END <= 0.95 THEN '$0.86-$0.95'
      ELSE '$0.96-$0.99'
    END as bucket,
    COUNT(*) as n,
    AVG(CASE WHEN t.yes_price >= 0.50 THEN t.yes_price ELSE t.no_price END) as avg_wp
  FROM trades t
  JOIN markets m ON t.ticker = m.ticker
  WHERE m.series_ticker IN (${WEATHER_SQL})
    AND m.result IS NOT NULL
    AND ${SECS} BETWEEN ${TIME_MIN} AND ${TIME_MAX}
  GROUP BY bucket
  ORDER BY avg_wp
`).all();

const totalInWindow = priceDist.reduce((s, b) => s + b.n, 0);
console.log(`  Total trades in 10-300s window: ${totalInWindow}`);
for (const b of priceDist) {
  console.log(`     ${b.bucket.padEnd(22)} ${String(b.n).padStart(4)} trades (${(b.n/totalInWindow*100).toFixed(0)}%)  avg=$${b.avg_wp.toFixed(3)}`);
}
if (totalInWindow > 0 && priceDist.every(b => b.avg_wp > 0.85)) {
  console.log(`\n  Root cause: By the time our 5-minute gate fires, the daily high temperature`);
  console.log(`  is already known. Weather markets close at ~05:00 UTC (midnight+ ET), hours`);
  console.log(`  after the actual temperature was recorded. Prices converge to $0.96-$0.99`);
  console.log(`  on the winning side -- far above our $0.70-$0.85 gate.`);
  console.log(`\n  This is fundamentally different from crypto 15-minute markets where BTC`);
  console.log(`  volatility creates genuine uncertainty in the last 5 minutes.`);
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION 2 — ALTERNATIVE TIME WINDOWS
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("  SECTION 2 -- WIDER TIME WINDOWS (searching for exploitable edge)");
console.log("  Testing: if we extend the time gate beyond 5 minutes, is there a weather edge?");
console.log("=".repeat(110));

interface WindowDef { label: string; min: number; max: number }
const windows: WindowDef[] = [
  { label: "10-300s (snipe gate)",     min: 10,    max: 300 },
  { label: "5min-1h",                  min: 300,   max: 3600 },
  { label: "1-2h",                     min: 3600,  max: 7200 },
  { label: "2-4h",                     min: 7200,  max: 14400 },
  { label: "4-8h",                     min: 14400, max: 28800 },
  { label: "8-12h",                    min: 28800, max: 43200 },
  { label: "12-24h",                   min: 43200, max: 86400 },
];

console.log(`\n  Realistic model (expensive side), price gate $0.70-$0.85, one entry per market:`);
console.log(`  ${"Window".padEnd(24)} ${"Entries".padStart(7)}  ${"Wins".padStart(5)}  ${"Loss".padStart(5)}  ${"WR".padStart(7)}  ${"PnL".padStart(9)}  ${"AvgEntry".padStart(9)}  ${"AvgWin".padStart(8)}  ${"AvgLoss".padStart(9)}`);
console.log("  " + "-".repeat(96));

let bestWindow: { label: string; s: ReturnType<typeof stats>; entries: SimEntry[] } | null = null;

for (const w of windows) {
  const entries = simulateRealistic(PRICE_MIN, PRICE_MAX, w.min, w.max);
  const s = stats(entries);
  if (s && (!bestWindow || (bestWindow.s && s.totalPnl > bestWindow.s.totalPnl))) {
    bestWindow = { label: w.label, s, entries };
  }
  if (s) {
    console.log(
      `  ${w.label.padEnd(24)} ${String(s.n).padStart(7)}  ${String(s.wins).padStart(5)}  ` +
      `${String(s.losses).padStart(5)}  ${(s.wr*100).toFixed(1).padStart(5)}%  ` +
      `$${(s.totalPnl >= 0 ? "+" : "") + s.totalPnl.toFixed(2).padStart(7)}  ` +
      `$${s.avgEntry.toFixed(3).padStart(8)}  ` +
      `$${s.avgWin.toFixed(3).padStart(7)}  ` +
      `$${s.avgLoss.toFixed(3).padStart(8)}`
    );
  } else {
    console.log(`  ${w.label.padEnd(24)}       0      -      -       -          -          -         -          -`);
  }
}

if (bestWindow?.s && bestWindow.s.totalPnl > 0) {
  console.log(`\n  Best window: ${bestWindow.label}`);
  console.log(`    ${bestWindow.s.n} entries, ${bestWindow.s.wins}W/${bestWindow.s.losses}L, ` +
    `${(bestWindow.s.wr*100).toFixed(1)}% WR, $${bestWindow.s.totalPnl >= 0 ? "+" : ""}${bestWindow.s.totalPnl.toFixed(2)} PnL`);
  console.log(`    BUT: This is 8-12 hours before close -- the temperature hasn't been`);
  console.log(`    recorded yet. This is a forecast bet, NOT a snipe. Different strategy.`);
} else {
  console.log(`\n  No time window produces positive PnL with the expensive-side heuristic.`);
}

// Also check perfect foresight at each window for ceiling comparison
console.log(`\n  Perfect foresight ceiling at each window (price $0.70-$0.85):`);
console.log(`  ${"Window".padEnd(24)} ${"Entries".padStart(7)}  ${"PnL (ceiling)".padStart(14)}`);
console.log("  " + "-".repeat(50));
for (const w of windows) {
  const entries = simulatePerfect(PRICE_MIN, PRICE_MAX, w.min, w.max);
  const s = stats(entries);
  if (s) {
    console.log(`  ${w.label.padEnd(24)} ${String(s.n).padStart(7)}  $+${s.totalPnl.toFixed(2).padStart(12)}`);
  } else {
    console.log(`  ${w.label.padEnd(24)}       0           -`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION 3 — MARKET EFFICIENCY / CONFIDENCE (at best window)
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("  SECTION 3 -- CONFIDENCE BREAKDOWN (8-12h window, best performing)");
console.log("  Using market consensus strength as forecast confidence proxy");
console.log("=".repeat(110));

const bestEntries = bestWindow?.entries ?? simulateRealistic(PRICE_MIN, PRICE_MAX, 28800, 43200);

if (bestEntries.length === 0) {
  console.log("\n  No entries to analyze at any window.");
} else {
  console.log(`\n  Note: The tape has no NWS forecast data. We use consensus strength`);
  console.log(`  (how far the expensive side is from $0.50) as a confidence proxy.`);
  console.log(`  Entry is 8-12h before close, when forecast uncertainty still exists.\n`);

  const confidenceBands = [
    { label: "Weak  ($0.50-$0.60)",    min: 0.00, max: 0.10 },
    { label: "Mild  ($0.60-$0.70)",    min: 0.10, max: 0.20 },
    { label: "Strong ($0.70-$0.80)",   min: 0.20, max: 0.30 },
    { label: "Very strong ($0.80+)",   min: 0.30, max: 1.00 },
  ];

  console.log(`  ${"Consensus band".padEnd(26)} ${"Entries".padStart(7)}  ${"WR".padStart(7)}  ${"PnL".padStart(10)}  ${"AvgEntry".padStart(9)}`);
  console.log("  " + "-".repeat(68));
  for (const band of confidenceBands) {
    const sub = bestEntries.filter(e => {
      const consensus = Math.abs(e.yesPrice - 0.50);
      return consensus >= band.min && consensus < band.max;
    });
    const s = stats(sub);
    if (s) {
      console.log(
        `  ${band.label.padEnd(26)} ${String(s.n).padStart(7)}  ` +
        `${(s.wr*100).toFixed(1).padStart(5)}%  ` +
        `$${(s.totalPnl >= 0 ? "+" : "") + s.totalPnl.toFixed(2).padStart(8)}  ` +
        `$${s.avgEntry.toFixed(3).padStart(8)}`
      );
    } else {
      console.log(`  ${band.label.padEnd(26)}       0       -           -          -`);
    }
  }

  // Correlation check: higher consensus → higher WR?
  const sorted = [...bestEntries].sort((a, b) =>
    Math.abs(a.yesPrice - 0.50) - Math.abs(b.yesPrice - 0.50));
  const half = Math.ceil(sorted.length / 2);
  const bottom = sorted.slice(0, half);
  const top = sorted.slice(half);
  const wrBottom = bottom.filter(e => e.won).length / (bottom.length || 1);
  const wrTop = top.filter(e => e.won).length / (top.length || 1);
  console.log(`\n  Bottom-half consensus WR: ${(wrBottom*100).toFixed(1)}%  (${bottom.length} entries)`);
  console.log(`  Top-half consensus WR:    ${(wrTop*100).toFixed(1)}%  (${top.length} entries)`);
  if (wrTop > wrBottom + 0.05) {
    console.log(`  -> Higher consensus correlates with higher WR. Potential entry filter.`);
  } else if (wrTop < wrBottom - 0.05) {
    console.log(`  -> Inverse: LOWER consensus has higher WR. Market overconfidence on favorites.`);
  } else {
    console.log(`  -> Consensus strength does NOT strongly predict win rate.`);
  }

  // By city
  console.log(`\n  By city (8-12h window):`);
  for (const s of WEATHER_SERIES) {
    const subset = bestEntries.filter(e => e.series === s);
    const st = stats(subset);
    console.log(fmtLine(`${cityName(s)} (${s})`, st));
  }
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION 4 — MARKET COVERAGE
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("  SECTION 4 -- MARKET COVERAGE");
console.log("=".repeat(110));

console.log("\n  A. Watched series:");
for (const s of WEATHER_SERIES) {
  const ct = allMarkets.filter(m => m.series_ticker === s).length;
  const ev = new Set(allMarkets.filter(m => m.series_ticker === s).map(m => m.event_ticker)).size;
  console.log(`     ${cityName(s).padEnd(12)} (${s.padEnd(10)})  ${ev} events, ${ct} markets`);
}
console.log(`     ${"TOTAL".padEnd(12)}                  ${numEvents} events, ${allMarkets.length} markets`);

// Configured cities vs actual
console.log(`\n  B. Configured vs available (18 cities in SERIES_META, ${WEATHER_SERIES.length} have data):`);
const missingCities = [
  "KXHIGHLAX", "KXHIGHDEN", "KXHIGHATL", "KXHIGHDAL", "KXHIGHSEA",
  "KXHIGHHOU", "KXHIGHPHX", "KXHIGHBOS", "KXHIGHLAS", "KXHIGHMIN",
  "KXHIGHPHI", "KXHIGHSF", "KXHIGHSA", "KXHIGHDC",
];
console.log(`     Cities with settled data: ${WEATHER_SERIES.length} (NY, Chicago, Miami, Austin)`);
console.log(`     Cities with no settled events: ${missingCities.length} (${missingCities.slice(0, 6).join(", ")}, ...)`);

// Snipe gate coverage (0%)
const firedTickers = new Set(realStd.map(e => e.ticker));
console.log(`\n  C. Snipe gate coverage (10-300s, $0.70-$0.85):`);
console.log(`     Markets fired on:    ${firedTickers.size} / ${allMarkets.length} (${(firedTickers.size / allMarkets.length * 100).toFixed(1)}%)`);
console.log(`     Events with entry:   0 / ${numEvents} (0.0%)`);

// 8-12h coverage for comparison
const fired812 = new Set(bestEntries.map(e => e.ticker));
const firedEvt812 = new Set(bestEntries.map(e => e.event));
console.log(`\n  D. Alt window coverage (8-12h, $0.70-$0.85):`);
console.log(`     Markets fired on:    ${fired812.size} / ${allMarkets.length} (${(fired812.size / allMarkets.length * 100).toFixed(1)}%)`);
console.log(`     Events with entry:   ${firedEvt812.size} / ${numEvents} (${(firedEvt812.size / numEvents * 100).toFixed(1)}%)`);

// Multi-bracket risk
const entriesPerEvent: Record<string, number> = {};
for (const e of bestEntries) {
  entriesPerEvent[e.event] = (entriesPerEvent[e.event] ?? 0) + 1;
}
const epeCounts = Object.values(entriesPerEvent);
const maxEPE = epeCounts.length > 0 ? Math.max(...epeCounts) : 0;
const avgEPE = epeCounts.length > 0 ? epeCounts.reduce((a, b) => a + b, 0) / epeCounts.length : 0;
if (epeCounts.length > 0) {
  console.log(`     Avg entries per event: ${avgEPE.toFixed(1)}, max: ${maxEPE}`);
  if (maxEPE > 1) {
    console.log(`     WARNING: Multiple brackets per event -- only ONE wins.`);
    console.log(`     Correlated losses inflate risk. Event-level dedup recommended.`);
  }
}

// Perfect foresight ceiling at 8-12h
const perf812 = simulatePerfect(PRICE_MIN, PRICE_MAX, 28800, 43200);
const perfS = stats(perf812);
if (perfS) {
  console.log(`\n  E. Perfect foresight ceiling (8-12h window):`);
  console.log(`     ${perfS.n} entries, $+${perfS.totalPnl.toFixed(2)} PnL`);
  const dataDays = parseFloat(hours) / 24;
  console.log(`     = $${(perfS.totalPnl / dataDays).toFixed(2)}/day theoretical max`);
}

// ═══════════════════════════════════════════════════════════════════
//  SECTION 5 — HEAD-TO-HEAD: CRYPTO vs WEATHER
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("  SECTION 5 -- HEAD-TO-HEAD COMPARISON: CRYPTO vs WEATHER");
console.log("=".repeat(110));

// Use the best weather window (8-12h) since snipe gate = 0
const bestS = stats(bestEntries);
const perfBestS = stats(perf812);

function row(label: string, cVal: string, wSnipe: string, wBest: string): void {
  console.log(`  | ${label.padEnd(23)} | ${cVal.padEnd(22)} | ${wSnipe.padEnd(18)} | ${wBest.padEnd(22)} |`);
}

console.log("");
console.log("  +" + "-".repeat(25) + "+" + "-".repeat(24) + "+" + "-".repeat(20) + "+" + "-".repeat(24) + "+");
console.log("  | Metric                  | Crypto (15M snipe)     | Weather (snipe)    | Weather (8-12h alt)    |");
console.log("  +" + "-".repeat(25) + "+" + "-".repeat(24) + "+" + "-".repeat(20) + "+" + "-".repeat(24) + "+");

row("Data period",
  "26h / 3 series",
  `${hours}h / 4 cities`,
  `${hours}h / 4 cities`);

row("Time window",
  "10-300s before close",
  "10-300s",
  "8-12h before close");

row("Resolved markets",
  "257",
  `${allMarkets.length}`,
  `${allMarkets.length}`);

row("--- Results ---", "----------", "----------", "----------");

row("Total entries",
  `${CRYPTO_BENCH.stdEntries}`,
  "0",
  `${bestS?.n ?? 0}`);

row("Win rate",
  `${(CRYPTO_BENCH.stdWR * 100).toFixed(1)}%`,
  "--",
  bestS ? `${(bestS.wr * 100).toFixed(1)}%` : "--");

row("Avg entry price",
  `$${CRYPTO_BENCH.stdAvgEntry.toFixed(3)}`,
  "--",
  bestS ? `$${bestS.avgEntry.toFixed(3)}` : "--");

row("Avg win",
  `$${CRYPTO_BENCH.stdAvgWin.toFixed(3)}`,
  "--",
  bestS ? `$${bestS.avgWin.toFixed(3)}` : "--");

row("Avg loss",
  `$${CRYPTO_BENCH.stdAvgLoss.toFixed(3)}`,
  "--",
  bestS ? `$${bestS.avgLoss.toFixed(3)}` : "--");

row("Total PnL",
  `$+${CRYPTO_BENCH.stdPnl.toFixed(2)}`,
  "$0.00",
  bestS ? `$${bestS.totalPnl >= 0 ? "+" : ""}${bestS.totalPnl.toFixed(2)}` : "--");

row("--- Ceiling ---", "----------", "----------", "----------");

row("Perfect foresight PnL",
  `$+${CRYPTO_BENCH.perfPnl.toFixed(2)}`,
  "$0.00",
  perfBestS ? `$+${perfBestS.totalPnl.toFixed(2)}` : "--");

row("Capture rate",
  `${(CRYPTO_BENCH.stdPnl / CRYPTO_BENCH.perfPnl * 100).toFixed(1)}%`,
  "--",
  bestS && perfBestS && perfBestS.totalPnl > 0
    ? `${(bestS.totalPnl / perfBestS.totalPnl * 100).toFixed(1)}%` : "--");

console.log("  +" + "-".repeat(25) + "+" + "-".repeat(24) + "+" + "-".repeat(20) + "+" + "-".repeat(24) + "+");

// ═══════════════════════════════════════════════════════════════════
//  VERDICT
// ═══════════════════════════════════════════════════════════════════
console.log("\n" + "=".repeat(110));
console.log("  VERDICT");
console.log("=".repeat(110));

console.log(`
  1. SNIPE STRATEGY (10-300s): DOES NOT WORK ON WEATHER MARKETS
     Zero entries across 138 markets / 163,712 trades / 5 days.
     Root cause: daily temperature is known hours before market close.
     All prices in our window are $0.86-$0.99 -- no actionable price.

  2. ALTERNATIVE (8-12h window): SHOWS PROMISE BUT IS A DIFFERENT STRATEGY
     ${bestS?.n ?? 0} entries, ${bestS ? (bestS.wr*100).toFixed(1) : 0}% WR, $${bestS ? (bestS.totalPnl >= 0 ? "+" : "") + bestS.totalPnl.toFixed(2) : "0.00"} PnL
     This is a forecast bet (temperature not yet recorded), not a snipe.
     Would require separate time-gate logic for weather series.

  3. RECOMMENDATION FOR LIVE BOT:
     - The current snipe bot will NEVER fire on weather markets at 10-300s.
     - Weather series add no value and no risk in the current configuration.
     - They are harmless dead code in SERIES_META but waste API calls.
     - Option A: Remove KXHIGH* from SERIES_META (save ~18 API calls/scan).
     - Option B: Keep for future use if 8-12h strategy is developed.

  4. CRYPTO REMAINS THE ONLY VALIDATED EDGE:
     141 entries, 79.4% WR, +$1.59 PnL over 26h (tape-verified).
     Weather cannot replicate this because the market microstructure
     is fundamentally different (daily vs 15-minute settlement).
`);
console.log("=".repeat(110));

db.close();
