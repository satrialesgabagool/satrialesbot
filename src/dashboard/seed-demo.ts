#!/usr/bin/env bun
/**
 * Demo signal seeder for the dashboard.
 *
 * Writes fake scanner signals to the JSONL file on a configurable cadence so
 * you can see the dashboard's Live Feed tab populate and the paper trader
 * open a realistic 2–5 trades per day (after its edge / cooldown / daily-cap
 * gates fire).
 *
 * Signals emitted:
 *
 *   • weather — KXHIGH bracket signals with full metadata (resolvesAtIso,
 *     bracketLowF/highF, trueProb, marketProb, probMethod). Edge is drawn
 *     from [5%, 22%] so some signals pass the paper-trader's 8% gate and
 *     some don't — mirroring real scanner output where not every hit is a
 *     high-conviction trade.
 *
 *   • whale — volume-spike signals. Display only; paper-trader ignores them
 *     because the current strategy only trades weather.
 *
 *  Usage:
 *
 *    bun run src/dashboard/seed-demo.ts                       # default
 *    bun run src/dashboard/seed-demo.ts --rate-sec 20         # emit every 20s
 *    bun run src/dashboard/seed-demo.ts --rate-sec 5 --burst  # rapid for dev
 *
 *  Important: the paper-trader's gates (min-edge, cooldown, max-per-day) are
 *  what keep the TRADE count realistic — not the signal emission rate. The
 *  real scanner emits a similar firehose; we filter downstream.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

import { localMidnightIso } from "./trading-math";

// ─── CLI ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argNum(name: string, fallback: number): number {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    const n = parseFloat(args[idx + 1]);
    if (!isNaN(n)) return n;
  }
  return fallback;
}
const RATE_SEC = argNum("rate-sec", 15);      // seconds between signals
const LOCAL_TZ = "America/New_York";

const RESULTS_DIR = "results";
const JSONL_PATH = join(RESULTS_DIR, "high-conviction.jsonl");
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

// ─── City catalog ──────────────────────────────────────────────────────

interface CityDef {
  city: string;
  series: string;      // Kalshi event-series prefix (KXHIGH+code)
  tempCenter: number;  // seasonally-plausible high in °F
  tempSpread: number;  // ensemble spread in °F
}

const CITIES: CityDef[] = [
  { city: "New York City", series: "KXHIGHNY",  tempCenter: 72, tempSpread: 3 },
  { city: "Chicago",       series: "KXHIGHCHI", tempCenter: 64, tempSpread: 4 },
  { city: "Miami",         series: "KXHIGHMIA", tempCenter: 84, tempSpread: 2 },
  { city: "Los Angeles",   series: "KXHIGHLAX", tempCenter: 76, tempSpread: 3 },
  { city: "Denver",        series: "KXHIGHDEN", tempCenter: 68, tempSpread: 5 },
  { city: "Austin",        series: "KXHIGHAUS", tempCenter: 82, tempSpread: 3 },
  { city: "Boston",        series: "KXHIGHBOS", tempCenter: 66, tempSpread: 4 },
];

// ─── Helpers ───────────────────────────────────────────────────────────

/** "2026-04-18" for a date `daysAhead` days from today. */
function resolveDateFromToday(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().split("T")[0];
}

/** Kalshi ticker codes use "26APR18" for 2026-04-18. */
function kalshiDateCode(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const mi = parseInt(m, 10) - 1;
  return `${y.slice(2)}${months[mi]}${d}`;
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Weather signal generator ──────────────────────────────────────────

/**
 * Generate a realistic KXHIGH weather-bracket signal.
 *
 *   • picks a city + a resolve-date within the next 2 days (cadence matches
 *     the real scanner's daysAhead=3 window minus "today already-resolved")
 *   • rolls an ensemble-mean around the city's seasonal center
 *   • picks a bracket near the ensemble mean (so trueProb is meaningful)
 *   • draws a market price with edge in [+5%, +22%] — some will pass the
 *     paper-trader's 8% gate, some won't
 *
 * Includes ALL metadata the paper-trader needs:
 *   • resolvesAtIso       — absolute close_time (local midnight of the day
 *                           AFTER resolveDate, because KXHIGH closes end-of-day)
 *   • bracketLowF/highF   — authoritative bracket bounds
 *   • trueProb/marketProb — so deriveEntry() uses precise values rather than
 *                           reverse-computing from yesPrice + edgeBps
 *   • probMethod          — tag for "where did this probability come from?"
 */
function randomWeatherSignal() {
  const cityDef = pick(CITIES);
  const daysAhead = Math.random() < 0.4 ? 0 : Math.random() < 0.75 ? 1 : 2;
  const resolveDate = resolveDateFromToday(daysAhead);
  const dateCode = kalshiDateCode(resolveDate);

  // Ensemble mean for the day
  const ensembleMean = Math.round(cityDef.tempCenter + rand(-3, 3));
  const spread = Math.max(1, cityDef.tempSpread + rand(-1, 1));

  // Bracket near (but not necessarily AT) the ensemble mean so probs vary.
  // Real KXHIGH brackets are 1°F wide — we mirror that.
  const bracketOffset = Math.floor(rand(-3, 4));  // ±3°F around mean
  const lowF = ensembleMean + bracketOffset;
  const highF = lowF + 1;

  // Approximate the true probability: Gaussian mass between lowF and highF.
  // Cheap CDF via erf-approx is fine for demo purposes.
  const trueProb = normalCdf(highF, ensembleMean, spread) - normalCdf(lowF, ensembleMean, spread);
  const trueProbClipped = Math.max(0.02, Math.min(0.95, trueProb));

  // Market price below trueProb (i.e. yes is under-priced → we want to BUY YES).
  // Edge drawn in [5%, 22%] — the paper-trader's 8% gate will filter.
  // marketProb floor=0.10 avoids penny-bracket trades: at $0.02 entry a $50
  // stake would imply 2500 contracts, which is more fill than a real Kalshi
  // bracket market has. Matching paper-trader's --min-entry-price default.
  const edge = rand(0.05, 0.22);
  const marketProb = Math.max(0.10, Math.min(0.90, trueProbClipped - edge));
  const yesPriceCents = Math.round(marketProb * 100);
  const edgeBps = Math.round((trueProbClipped - marketProb) * 10000);

  // Close time: KXHIGH markets resolve against the NWS report for the local
  // day, so close_time is conventionally set to local midnight of the NEXT
  // day (end-of-target-day in local time).
  const nextDay = new Date(`${resolveDate}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const resolvesAtIso = localMidnightIso(nextDay.toISOString().split("T")[0], LOCAL_TZ);
  const hoursLeft = (new Date(resolvesAtIso).getTime() - Date.now()) / 3_600_000;

  const marketTicker = `${cityDef.series}-${dateCode}-T${lowF}`;
  const eventTicker = `${cityDef.series}-${dateCode}`;

  const conviction = Math.round(edge * 0.85 * 1000) / 1000;

  return {
    timestamp: new Date().toISOString(),
    strategy: "weather" as const,
    eventTicker,
    marketTicker,
    side: "yes",
    yesPrice: yesPriceCents,
    sizeContracts: 0,
    conviction,
    edgeBps,
    reason:
      `${cityDef.city} high ${resolveDate} [${lowF}-${highF}°F]: ` +
      `ensemble=${ensembleMean.toFixed(1)}°F±${spread.toFixed(1)} ` +
      `(4 sources, agree=0.82), ` +
      `model_p=${(trueProbClipped * 100).toFixed(1)}% vs market=${(marketProb * 100).toFixed(1)}%, ` +
      `h=${hoursLeft.toFixed(1)}h`,
    metadata: {
      city: cityDef.city,
      type: "high" as const,
      resolveDate,
      hoursLeft: Math.round(hoursLeft * 10) / 10,
      // Absolute resolution timestamp so the paper-trader can compute a real
      // countdown without re-aging `hoursLeft`.
      resolvesAtIso,
      ensembleF: ensembleMean,
      spreadF: spread,
      sourceCount: 4,
      agreement: 0.82,
      bracketLowF: lowF,
      bracketHighF: highF,
      trueProb: Math.round(trueProbClipped * 10000) / 10000,
      marketProb: Math.round(marketProb * 10000) / 10000,
      volume24h: Math.round(rand(200, 3000)),
      liquidity: Math.round(rand(80, 500)),
      probMethod: "gaussian",
      gfsMembers: 0,
      lockStatus: "forecast",
      metarStation: null,
      metarPeakF: null,
      metarPeakAgeHours: null,
    },
  };
}

// ─── Whale signal generator ────────────────────────────────────────────

/**
 * Generate a volume-spike signal. These are DISPLAY-ONLY — the paper trader
 * ignores them because the current "weather-only" strategy doesn't know which
 * direction to take from a whale hit alone. They're still emitted here so the
 * dashboard's Live Feed shows both types.
 */
function randomWhaleSignal() {
  const cityDef = pick(CITIES);
  const resolveDate = resolveDateFromToday(Math.floor(rand(0, 3)));
  const dateCode = kalshiDateCode(resolveDate);
  const notional = Math.round(rand(5000, 25000));
  const z = Math.round(rand(3, 7) * 10) / 10;
  const side = Math.random() > 0.5 ? "yes" : "no";
  const temp = Math.round(cityDef.tempCenter + rand(-5, 5));

  return {
    timestamp: new Date().toISOString(),
    strategy: "whale" as const,
    eventTicker: `${cityDef.series}-${dateCode}`,
    marketTicker: `${cityDef.series}-${dateCode}-T${temp}`,
    side,
    yesPrice: 30 + Math.floor(rand(0, 40)),
    sizeContracts: 0,
    conviction: Math.round(z * 0.15 * 1000) / 1000,
    edgeBps: 0,
    reason: `$${(notional / 1000).toFixed(1)}k ${side} flow in 5min, z=${z}, ${80 + Math.floor(rand(0, 20))}% directional`,
    metadata: {
      notionalUsd: notional,
      zScore: z,
      windowSec: 300,
      city: cityDef.city,
    },
  };
}

// ─── Poor-man's Gaussian CDF (good enough for demo signals) ───────────

function normalCdf(x: number, mean: number, sigma: number): number {
  return 0.5 * (1 + erf((x - mean) / (sigma * Math.SQRT2)));
}
// Abramowitz & Stegun 7.1.26 approximation, max error ~1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

// ─── Main loop ─────────────────────────────────────────────────────────

console.log(`Seeding demo data to ${JSONL_PATH}`);
console.log(`  Cadence: 1 signal every ${RATE_SEC}s (mix of weather + whale)`);
console.log(`  (paper-trader gates filter signals → 2–5 trades/day)`);
console.log(`  Press Ctrl+C to stop.\n`);

let count = 0;
const interval = setInterval(() => {
  // 70% weather, 30% whale — mirrors the real scanner roughly
  const signal = Math.random() > 0.3 ? randomWeatherSignal() : randomWhaleSignal();
  appendFileSync(JSONL_PATH, JSON.stringify(signal) + "\n");
  count++;
  const tag = signal.strategy === "weather"
    ? `edge=${(signal.edgeBps / 100).toFixed(1)}%`
    : `z=${(signal.metadata as { zScore: number }).zScore}`;
  console.log(`  #${count} ${signal.strategy.padEnd(7)} ${signal.marketTicker}  ${tag}`);
}, RATE_SEC * 1000);

process.on("SIGINT", () => {
  clearInterval(interval);
  console.log(`\nSeeded ${count} demo signals. Dashboard should show them.`);
  process.exit(0);
});
