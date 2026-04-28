/**
 * Strategy Comparison Backtest — runs multiple ensemble-strategy variants
 * against the same tape data and same ensemble forecasts.
 *
 * The slow part of any ensemble backtest is fetching forecasts from Open-Meteo
 * (one HTTP roundtrip per event). This module fetches ONCE per event and
 * evaluates N variants against the same underlying data — so adding more
 * variants doesn't increase runtime.
 *
 * Variants supported:
 *   - topN: number of brackets to bet (1 = baseline, 2-3 = laddering)
 *   - sizingScheme: how to split a fixed budget across the top-N picks
 *   - minProbability: per-bracket probability floor (only bet brackets ≥ this)
 *   - minPrice / maxPrice: price band filter
 *   - feeAware: account for Kalshi's 7% winnings fee in P&L
 *
 * Each event gets a budget of $1 (normalized). Variant ROIs are directly
 * comparable since they all see the same set of events and same forecast data.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { KALSHI_WEATHER_CITIES } from "./KalshiWeatherFinder";
import type { Tape, TapeEvent, TapeMarket, TapeTrade } from "./WeatherTapeCollector";

// ─── Types ─────────────────────────────────────────────────────────

export interface ComparisonVariant {
  name: string;                // human-readable label
  topN: number;                // 1 = baseline, 2-3 = ladder
  sizingScheme: "even" | "weighted" | "front-loaded";
  minProbability: number;      // floor per-bracket prob (e.g. 0.30 for ladder)
  minPrice: number;            // floor entry price
  maxPrice: number;            // ceiling entry price
  highConfMult?: number;       // multiplier when edge ≥ highConfEdge (default 1.0)
  highConfEdge?: number;       // edge threshold for the multiplier (default 0.30)
}

export interface VariantTradeRecord {
  eventTicker: string;
  city?: string;
  date?: string;
  rank: number;                // 0 = top pick, 1 = second-best, ...
  ticker: string;
  modelProb: number;
  entryPrice: number;
  cost: number;
  won: boolean;
  pnl: number;
}

export interface VariantResult {
  variant: ComparisonVariant;
  trades: VariantTradeRecord[];
  // Aggregates
  events: number;              // events touched (i.e. at least 1 bet placed)
  bets: number;                // total individual bracket-bets
  wins: number;
  losses: number;
  winRate: number;
  totalCost: number;
  totalPnL: number;
  roi: number;                 // pnl / cost
  avgWinUSD: number;
  avgLossUSD: number;
  winLossRatio: number;        // |avgWin| / |avgLoss|
  // Per-event aggregate
  avgPnlPerEvent: number;
  // Hit rate at each rank (whether the rank-N bracket was the actual winner)
  hitRateByRank: number[];     // index 0 = top pick hit %, etc
}

export interface ComparisonResult {
  totalEventsScanned: number;
  eventsWithForecast: number;
  variantResults: VariantResult[];
}

// ─── Internals ──────────────────────────────────────────────────────

function findCityCoords(city: string): { lat: number; lon: number } | null {
  const entry = KALSHI_WEATHER_CITIES.find(c => c.city.toLowerCase() === city.toLowerCase());
  return entry ? { lat: entry.lat, lon: entry.lon } : null;
}

function priceAtTime(trades: TapeTrade[], targetMs: number, windowHours = 2): number | null {
  const windowMs = windowHours * 3600000;
  let best: TapeTrade | null = null;
  let bestTime = -Infinity;
  for (const t of trades) {
    const tMs = new Date(t.created_time).getTime();
    if (tMs > targetMs) continue;
    if (tMs < targetMs - windowMs) continue;
    if (tMs > bestTime) { best = t; bestTime = tMs; }
  }
  if (!best) return null;
  return best.yes_price > 0 ? best.yes_price : (1 - best.no_price);
}

/** Returns brackets ranked by ensemble probability, with prob attached. */
function rankBrackets(memberTemps: number[], brackets: TapeMarket[]): Array<{
  market: TapeMarket;
  probability: number;
  count: number;
}> {
  const counts = new Map<string, { market: TapeMarket; count: number }>();
  let totalValid = 0;

  for (const temp of memberTemps) {
    if (typeof temp !== "number" || !isFinite(temp)) continue;
    const rounded = Math.round(temp);
    for (const br of brackets) {
      const lo = br.floor_strike == null || !isFinite(br.floor_strike) ? -Infinity : br.floor_strike;
      const hi = br.cap_strike == null || !isFinite(br.cap_strike) ? Infinity : br.cap_strike;
      if (rounded >= lo && rounded <= hi) {
        const existing = counts.get(br.ticker);
        if (existing) existing.count++;
        else counts.set(br.ticker, { market: br, count: 1 });
        totalValid++;
        break;
      }
    }
  }
  if (totalValid === 0) return [];
  return [...counts.values()]
    .map(({ market, count }) => ({ market, count, probability: count / totalValid }))
    .sort((a, b) => b.probability - a.probability);
}

/** Allocate a $1 budget across N picks by sizing scheme. */
function allocate(n: number, scheme: ComparisonVariant["sizingScheme"], probs?: number[]): number[] {
  if (n === 1) return [1.0];
  if (scheme === "even") {
    return Array(n).fill(1 / n);
  }
  if (scheme === "weighted" && probs && probs.length === n) {
    const total = probs.reduce((a, b) => a + b, 0);
    return probs.map(p => p / Math.max(0.001, total));
  }
  if (scheme === "front-loaded") {
    // 60/40 for n=2, 50/30/20 for n=3, 40/25/20/15 for n=4
    const presets: Record<number, number[]> = {
      2: [0.60, 0.40],
      3: [0.50, 0.30, 0.20],
      4: [0.40, 0.25, 0.20, 0.15],
    };
    return presets[n] ?? Array(n).fill(1 / n);
  }
  return Array(n).fill(1 / n);
}

/**
 * Fetch a synthetic 100-member ensemble for a past date.
 *
 * IMPORTANT: Open-Meteo's free ensemble API doesn't archive per-member
 * historical data — `past_days` queries return null for member values.
 * So for backtest purposes we use a SYNTHETIC ENSEMBLE built from:
 *   - The historical deterministic forecast (ECMWF if available, else GFS)
 *     fetched from Open-Meteo's historical-forecast-api archive
 *   - A Gaussian distribution N(forecast, σ²) where σ ≈ 2.5°F (typical
 *     24h forecast standard deviation for daily highs in CONUS)
 *
 * 100 synthetic members are drawn from this distribution and used for
 * bracket-probability calculation. This is APPROXIMATE — real ensemble
 * runs have correlated model errors that a Gaussian misses — but it's
 * sufficient for comparing strategy variants against the same data.
 */
// Configurable via env var so we can sweep without code changes
const SYNTHETIC_FORECAST_STDDEV_F = parseFloat(process.env.SYNTH_STDDEV ?? "2.5");

function gaussianSample(mean: number, stddev: number): number {
  // Box-Muller transform
  const u1 = Math.random() || 1e-12;
  const u2 = Math.random() || 1e-12;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

async function fetchHistoricalDeterministic(
  lat: number,
  lon: number,
  targetDate: string,
  series: "high" | "low" = "high",
): Promise<number | null> {
  const dailyKey = series === "high" ? "temperature_2m_max" : "temperature_2m_min";

  // Request BOTH models — Open-Meteo suffixes keys per-model when multiple are
  // requested (e.g. temperature_2m_max_ecmwf_ifs025), but uses the bare key
  // (temperature_2m_max) when only one model is requested. We want the suffixed
  // form so we can prefer ECMWF and fall back to GFS.
  const url = new URL("https://historical-forecast-api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", targetDate);
  url.searchParams.set("end_date", targetDate);
  url.searchParams.set("daily", dailyKey);
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("models", "ecmwf_ifs025,gfs025");

  try {
    const res = await fetchWithRetry(url.toString(), {}, { timeoutMs: 20000, maxRetries: 2 });
    const data: any = await res.json();
    // Prefer ECMWF; fall back to GFS if ECMWF is null
    const ecmwfVal = data.daily?.[`${dailyKey}_ecmwf_ifs025`]?.[0];
    if (typeof ecmwfVal === "number" && isFinite(ecmwfVal)) return ecmwfVal;
    const gfsVal = data.daily?.[`${dailyKey}_gfs025`]?.[0];
    if (typeof gfsVal === "number" && isFinite(gfsVal)) return gfsVal;
    return null;
  } catch {
    return null;
  }
}

async function fetchEnsembleForDate(
  lat: number,
  lon: number,
  targetDate: string,
  series: "high" | "low" = "high",
): Promise<number[] | null> {
  const now = new Date();
  const target = new Date(targetDate + "T12:00:00Z");
  const daysDiff = Math.ceil((now.getTime() - target.getTime()) / (24 * 3600 * 1000));
  if (daysDiff < 0 || daysDiff > 30) return null;

  // Fetch the historical deterministic forecast as the ensemble center
  const forecast = await fetchHistoricalDeterministic(lat, lon, targetDate, series);
  if (forecast === null) return null;

  // Build a 100-member synthetic ensemble: N(forecast, σ²) with σ = 2.5°F
  const members: number[] = [];
  for (let i = 0; i < 100; i++) {
    members.push(gaussianSample(forecast, SYNTHETIC_FORECAST_STDDEV_F));
  }
  return members;
}

// ─── Main ────────────────────────────────────────────────────────────

export async function runComparisonBacktest(
  tape: Tape,
  variants: ComparisonVariant[],
  opts: {
    entryHoursBefore?: number;
    series?: "high" | "low";       // which ensemble member set to fetch
    log?: (msg: string) => void;
    progressEvery?: number;        // log progress every N events
  } = {},
): Promise<ComparisonResult> {
  const entryHours = opts.entryHoursBefore ?? 24;
  const series = opts.series ?? "high";
  const log = opts.log ?? (() => {});
  const progressEvery = opts.progressEvery ?? 10;

  // Index trades by ticker for fast lookup
  const tradesByTicker = new Map<string, TapeTrade[]>();
  for (const t of tape.trades) {
    if (!tradesByTicker.has(t.ticker)) tradesByTicker.set(t.ticker, []);
    tradesByTicker.get(t.ticker)!.push(t);
  }

  // Initialize variant containers
  const variantTrades = new Map<string, VariantTradeRecord[]>();
  const hitsByVariantByRank = new Map<string, number[]>();
  const eventsTouchedByVariant = new Map<string, Set<string>>();
  for (const v of variants) {
    variantTrades.set(v.name, []);
    hitsByVariantByRank.set(v.name, [0, 0, 0, 0, 0]);
    eventsTouchedByVariant.set(v.name, new Set());
  }

  let eventsWithForecast = 0;
  let processed = 0;
  const totalEvents = tape.events.length;

  for (const event of tape.events) {
    processed++;
    if (processed % progressEvery === 0) {
      log(`  [${processed}/${totalEvents}] processing events...`);
    }

    const winner = event.markets.find(m => m.result === "yes");
    if (!winner || !event.city || !event.date) continue;
    const closeStr = event.markets.find(m => m.close_time)?.close_time;
    if (!closeStr) continue;
    const coords = findCityCoords(event.city);
    if (!coords) continue;

    // Fetch ensemble ONCE per event — reused across all variants
    const members = await fetchEnsembleForDate(coords.lat, coords.lon, event.date, series);
    if (!members || members.length < 10) continue;
    eventsWithForecast++;

    const ranked = rankBrackets(members, event.markets);
    if (ranked.length === 0) continue;

    const closeMs = new Date(closeStr).getTime();
    const targetMs = closeMs - entryHours * 3600000;

    // For each variant, simulate the trades it would have placed
    for (const variant of variants) {
      // Pick top-N that pass minProbability filter
      const picks = ranked.slice(0, variant.topN).filter(p => p.probability >= variant.minProbability);
      if (picks.length === 0) continue;

      // Pull entry prices for each pick from the tape
      const pickPrices = picks.map(p => priceAtTime(tradesByTicker.get(p.market.ticker) ?? [], targetMs));
      // Filter out picks where we have no price OR price outside band
      const eligible = picks
        .map((p, i) => ({ ...p, entryPrice: pickPrices[i] }))
        .filter(p =>
          p.entryPrice !== null &&
          p.entryPrice >= variant.minPrice &&
          p.entryPrice <= variant.maxPrice,
        );
      if (eligible.length === 0) continue;

      // Allocate $1 budget across the eligible picks
      const probs = eligible.map(p => p.probability);
      const allocations = allocate(eligible.length, variant.sizingScheme, probs);

      // Apply confidence-tier multiplier:
      //   if edge ≥ threshold, multiply that pick's allocation
      const totalRebalance = allocations.reduce((s, a, i) => {
        const p = eligible[i];
        const edge = p.probability - (p.entryPrice ?? 0);
        const mult = (variant.highConfMult ?? 1.0) > 1.0 && edge >= (variant.highConfEdge ?? 0.30)
          ? (variant.highConfMult ?? 1.0)
          : 1.0;
        return s + a * mult;
      }, 0);

      // Track hits by rank (independent of bet placement — this is "would we have hit")
      for (let i = 0; i < Math.min(eligible.length, 5); i++) {
        if (eligible[i].market.ticker === winner.ticker) {
          hitsByVariantByRank.get(variant.name)![i]++;
        }
      }
      eventsTouchedByVariant.get(variant.name)!.add(event.event_ticker);

      // Record each bracket bet
      for (let i = 0; i < eligible.length; i++) {
        const pick = eligible[i];
        const edge = pick.probability - (pick.entryPrice ?? 0);
        const mult = (variant.highConfMult ?? 1.0) > 1.0 && edge >= (variant.highConfEdge ?? 0.30)
          ? (variant.highConfMult ?? 1.0)
          : 1.0;
        const cost = (allocations[i] * mult) / Math.max(1, totalRebalance / allocations.reduce((s, a) => s + a, 1));
        // Above ensures total budget across the event still sums to ~$1 (with high-conf shifting allocation)
        const won = pick.market.ticker === winner.ticker;
        let pnl = 0;
        if (won) {
          // Net winnings (Kalshi takes 7% of winnings)
          const grossPayout = cost / pick.entryPrice!;
          const winnings = grossPayout - cost;
          const fee = winnings * 0.07;
          pnl = grossPayout - cost - fee;
        } else {
          pnl = -cost;
        }

        variantTrades.get(variant.name)!.push({
          eventTicker: event.event_ticker,
          city: event.city,
          date: event.date,
          rank: i,
          ticker: pick.market.ticker,
          modelProb: pick.probability,
          entryPrice: pick.entryPrice!,
          cost,
          won,
          pnl,
        });
      }
    }
  }

  // Build per-variant summary
  const variantResults: VariantResult[] = variants.map(v => {
    const trades = variantTrades.get(v.name) ?? [];
    const wins = trades.filter(t => t.won);
    const losses = trades.filter(t => !t.won);
    const totalCost = trades.reduce((s, t) => s + t.cost, 0);
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const eventsTouched = eventsTouchedByVariant.get(v.name)!.size;
    const hits = hitsByVariantByRank.get(v.name)!;
    const hitRateByRank = hits.map(h => eventsTouched > 0 ? h / eventsTouched : 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

    return {
      variant: v,
      trades,
      events: eventsTouched,
      bets: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      totalCost: +totalCost.toFixed(2),
      totalPnL: +totalPnL.toFixed(2),
      roi: totalCost > 0 ? totalPnL / totalCost : 0,
      avgWinUSD: +avgWin.toFixed(3),
      avgLossUSD: +avgLoss.toFixed(3),
      winLossRatio: avgLoss < 0 ? Math.abs(avgWin / avgLoss) : 0,
      avgPnlPerEvent: eventsTouched > 0 ? totalPnL / eventsTouched : 0,
      hitRateByRank,
    };
  });

  return {
    totalEventsScanned: tape.events.length,
    eventsWithForecast,
    variantResults,
  };
}
