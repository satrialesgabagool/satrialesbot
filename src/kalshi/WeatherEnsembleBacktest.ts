/**
 * Ensemble Forecast Backtest — does our 82-member ensemble pick winners early?
 *
 * For each resolved event in the tape:
 *   1. Fetch what our 82-member ensemble would have predicted
 *      (using ensemble-api past_days — has some hindsight bias but directional)
 *   2. Count members landing in each Kalshi bracket → empirical probability
 *   3. Pick the bracket with highest ensemble probability
 *   4. Check if that matches Kalshi's actual winner
 *   5. If it does, simulate buying at the tape's price at T-24h
 *
 * Results tell us:
 *   - Ensemble accuracy (% of time we correctly pick the winner)
 *   - Average entry price for correct picks
 *   - Simulated ROI vs break-even threshold
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { CITY_STATIONS } from "../weather/WeatherObserver";
import { KALSHI_WEATHER_CITIES } from "./KalshiWeatherFinder";
import type { Tape, TapeEvent, TapeMarket, TapeTrade } from "./WeatherTapeCollector";

export interface EnsembleBacktestResult {
  predictions: EnsemblePrediction[];
  summary: {
    totalEvents: number;
    eventsWithForecast: number;
    correctPicks: number;
    accuracy: number;
    bets: number;
    wins: number;
    losses: number;
    totalCost: number;
    totalPnL: number;
    roi: number;
    avgEntryPrice: number;
    breakEvenWR: number;
  };
}

export interface EnsemblePrediction {
  eventTicker: string;
  city?: string;
  date?: string;
  // What our ensemble predicted
  predictedTicker: string | null;
  predictedLabel?: string;
  predictedProb: number;       // fraction of members landing in this bracket
  memberCount: number;
  // What actually happened
  actualTicker: string;
  actualLabel?: string;
  correct: boolean;
  // Trade simulation
  entryPriceAt24h: number | null;
  entryPriceAt12h: number | null;
  won: boolean | null;
  pnl: number;
  cost: number;
}

function findCityCoords(city: string): { lat: number; lon: number } | null {
  const entry = KALSHI_WEATHER_CITIES.find(c => c.city.toLowerCase() === city.toLowerCase());
  if (!entry) return null;
  return { lat: entry.lat, lon: entry.lon };
}

/** Find the last trade price for a ticker before a target time (within 2h window) */
function priceAtTime(trades: TapeTrade[], targetMs: number): number | null {
  const windowMs = 2 * 3600000;
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

/** Given an ensemble temp array and Kalshi brackets, find the bracket with most members */
function pickBracket(
  memberTemps: number[],
  brackets: TapeMarket[],
): { ticker: string; label?: string; probability: number } | null {
  const counts = new Map<string, number>();
  let totalValid = 0;

  for (const temp of memberTemps) {
    if (typeof temp !== "number" || !isFinite(temp)) continue;
    // Round to match Kalshi's integer resolution convention
    const rounded = Math.round(temp);

    for (const br of brackets) {
      const lo = br.floor_strike == null || !isFinite(br.floor_strike) ? -Infinity : br.floor_strike;
      const hi = br.cap_strike == null || !isFinite(br.cap_strike) ? Infinity : br.cap_strike;
      if (rounded >= lo && rounded <= hi) {
        counts.set(br.ticker, (counts.get(br.ticker) ?? 0) + 1);
        totalValid++;
        break;
      }
    }
  }

  if (totalValid === 0) return null;
  // Find max
  let bestTicker: string | null = null;
  let bestCount = 0;
  for (const [ticker, count] of counts) {
    if (count > bestCount) { bestTicker = ticker; bestCount = count; }
  }
  if (!bestTicker) return null;
  const market = brackets.find(m => m.ticker === bestTicker);
  return {
    ticker: bestTicker,
    label: market?.yes_sub_title,
    probability: bestCount / totalValid,
  };
}

/** Fetch ensemble forecast members for a city, for a specific target date */
async function fetchEnsembleForDate(
  lat: number,
  lon: number,
  targetDate: string,   // YYYY-MM-DD
): Promise<number[] | null> {
  const now = new Date();
  const target = new Date(targetDate + "T12:00:00Z");
  const daysDiff = Math.ceil((now.getTime() - target.getTime()) / (24 * 3600 * 1000));
  if (daysDiff < 0 || daysDiff > 30) return null;  // out of range

  const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("daily", "temperature_2m_max");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("past_days", String(Math.min(daysDiff + 2, 31)));
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("models", "gfs025,ecmwf_ifs025");

  try {
    const res = await fetchWithRetry(url.toString(), {}, { timeoutMs: 20000, maxRetries: 2 });
    const data: any = await res.json();
    const times: string[] = data.daily?.time ?? [];
    const idx = times.indexOf(targetDate);
    if (idx === -1) return null;

    const members: number[] = [];
    for (const key of Object.keys(data.daily ?? {})) {
      if (key === "time") continue;
      if (!key.startsWith("temperature_2m_max")) continue;
      const val = data.daily[key][idx];
      if (typeof val === "number" && isFinite(val)) members.push(val);
    }
    return members;
  } catch {
    return null;
  }
}

export async function runEnsembleBacktest(
  tape: Tape,
  opts: {
    minProbability?: number;   // only "bet" if ensemble gives at least this probability
    maxEntryPrice?: number;    // only bet if entry price ≤ this
    entryHoursBefore?: number; // which horizon's price to use
    log?: (msg: string) => void;
  } = {},
): Promise<EnsembleBacktestResult> {
  const minProb = opts.minProbability ?? 0.40;
  const maxPrice = opts.maxEntryPrice ?? 0.60;
  const entryHours = opts.entryHoursBefore ?? 24;
  const log = opts.log ?? (() => {});

  // Index trades by ticker for quick lookup
  const tradesByTicker = new Map<string, TapeTrade[]>();
  for (const t of tape.trades) {
    if (!tradesByTicker.has(t.ticker)) tradesByTicker.set(t.ticker, []);
    tradesByTicker.get(t.ticker)!.push(t);
  }

  const predictions: EnsemblePrediction[] = [];
  let eventsWithForecast = 0;

  for (const event of tape.events) {
    const winner = event.markets.find(m => m.result === "yes");
    if (!winner || !event.city || !event.date) continue;
    const closeStr = event.markets.find(m => m.close_time)?.close_time;
    if (!closeStr) continue;

    const coords = findCityCoords(event.city);
    if (!coords) continue;

    log(`  Fetching ensemble for ${event.city} ${event.date}...`);
    const members = await fetchEnsembleForDate(coords.lat, coords.lon, event.date);
    if (!members || members.length < 10) {
      predictions.push({
        eventTicker: event.event_ticker,
        city: event.city, date: event.date,
        predictedTicker: null, predictedProb: 0,
        memberCount: members?.length ?? 0,
        actualTicker: winner.ticker, actualLabel: winner.yes_sub_title,
        correct: false,
        entryPriceAt24h: null, entryPriceAt12h: null,
        won: null, pnl: 0, cost: 0,
      });
      continue;
    }

    eventsWithForecast++;

    // Pick bracket with max ensemble members
    const pick = pickBracket(members, event.markets);
    if (!pick) continue;

    const correct = pick.ticker === winner.ticker;

    // Get entry prices at T-24h and T-12h for the PREDICTED bracket
    const closeMs = new Date(closeStr).getTime();
    const tradesForPick = tradesByTicker.get(pick.ticker) ?? [];
    const entryPriceAt24h = priceAtTime(tradesForPick, closeMs - 24 * 3600000);
    const entryPriceAt12h = priceAtTime(tradesForPick, closeMs - 12 * 3600000);

    const entryPrice = entryHours === 24 ? entryPriceAt24h
                     : entryHours === 12 ? entryPriceAt12h
                     : priceAtTime(tradesForPick, closeMs - entryHours * 3600000);

    // Simulate the bet
    let won: boolean | null = null;
    let pnl = 0;
    let cost = 0;
    if (entryPrice !== null && pick.probability >= minProb && entryPrice <= maxPrice) {
      won = correct;
      const shares = 1; // normalize to per-share
      cost = shares * entryPrice;
      if (won) {
        const gross = shares - cost;
        const fee = gross * 0.07;
        pnl = gross - fee;
      } else {
        pnl = -cost;
      }
    }

    predictions.push({
      eventTicker: event.event_ticker,
      city: event.city, date: event.date,
      predictedTicker: pick.ticker, predictedLabel: pick.label,
      predictedProb: pick.probability,
      memberCount: members.length,
      actualTicker: winner.ticker, actualLabel: winner.yes_sub_title,
      correct,
      entryPriceAt24h, entryPriceAt12h,
      won, pnl, cost,
    });
  }

  // Summary
  const correctPicks = predictions.filter(p => p.correct).length;
  const betsPlaced = predictions.filter(p => p.cost > 0);
  const wins = betsPlaced.filter(p => p.won).length;
  const losses = betsPlaced.filter(p => p.won === false).length;
  const totalCost = betsPlaced.reduce((s, p) => s + p.cost, 0);
  const totalPnL = betsPlaced.reduce((s, p) => s + p.pnl, 0);
  const avgEntry = betsPlaced.length > 0 ? betsPlaced.reduce((s, p) => s + p.cost, 0) / betsPlaced.length : 0;

  return {
    predictions,
    summary: {
      totalEvents: predictions.length,
      eventsWithForecast,
      correctPicks,
      accuracy: eventsWithForecast > 0 ? correctPicks / eventsWithForecast : 0,
      bets: betsPlaced.length,
      wins,
      losses,
      totalCost: Math.round(totalCost * 100) / 100,
      totalPnL: Math.round(totalPnL * 100) / 100,
      roi: totalCost > 0 ? totalPnL / totalCost : 0,
      avgEntryPrice: avgEntry,
      breakEvenWR: avgEntry > 0 ? avgEntry / (avgEntry + (1 - avgEntry) * 0.93) : 0,
    },
  };
}
