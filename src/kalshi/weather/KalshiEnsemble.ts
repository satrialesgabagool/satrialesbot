/**
 * Kalshi-facing weather ensemble.
 *
 * Layers on top of the existing free-tier ensemble in
 * src/weather/WeatherEnsemble.ts (Open-Meteo × 3 models + NOAA NWS)
 * by pulling in additional paid sources (OpenWeather, Tomorrow.io,
 * Visual Crossing, WeatherAPI, Pirate Weather) when their API keys
 * are configured.
 *
 * The output `KalshiEnsembleDay` gives:
 *   - highF mean across all available sources (unweighted)
 *   - spreadF  = population stddev across sources (agreement signal)
 *   - agreement score 0..1 based on how tight spread is
 *   - per-source breakdown
 *
 * Consumers (WeatherScanner) convert (highF, spread, hoursUntilResolve)
 * → bracket probability via Gaussian CDF. Spread is RSS-combined with a
 * horizon-dependent base sigma so wider disagreement → wider distribution
 * → lower confidence in any single bracket.
 */

import { fetchEnsembleForecast } from "../../weather/WeatherEnsemble";
import { loadPaidSources, type ForecastSource, type DailyTempForecast } from "./sources";

export interface SourceSample {
  source: string;
  highF: number;
  lowF: number;
}

export interface KalshiEnsembleDay {
  date: string;
  ensembleHighF: number;
  ensembleLowF: number;
  spreadHighF: number;
  spreadLowF: number;
  /** 0..1 — 1.0 = perfect agreement, falls off as spread grows */
  agreement: number;
  sources: SourceSample[];
  sourceCount: number;
}

export interface KalshiEnsembleForecast {
  city: string;
  fetchedAt: string;
  days: KalshiEnsembleDay[];
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

/** Maps spread (°F) to an agreement score 0..1 using a simple exponential decay. */
function agreementScore(spreadF: number): number {
  // At spread=0 → 1.0; at spread=5°F → ~0.37; at spread=10°F → ~0.14
  return Math.exp(-spreadF / 5);
}

export async function fetchKalshiEnsemble(
  city: string,
  daysAhead = 3,
  extraSources: ForecastSource[] = loadPaidSources(),
): Promise<KalshiEnsembleForecast | null> {
  // 1. Free-tier ensemble (Open-Meteo models + NOAA NWS for US cities).
  const free = await fetchEnsembleForecast(city, daysAhead);

  // 2. Paid sources in parallel, filtering to configured ones only.
  const activePaid = extraSources.filter((s) => s.isConfigured());
  const paidResults = await Promise.all(activePaid.map((s) => s.fetch(city, daysAhead)));

  // Collect per-date samples from all sources.
  const byDate = new Map<string, SourceSample[]>();

  if (free) {
    for (const day of free.forecasts) {
      for (const m of day.models) {
        if (!byDate.has(day.date)) byDate.set(day.date, []);
        byDate.get(day.date)!.push({ source: m.name, highF: m.highF, lowF: m.lowF });
      }
    }
  }

  for (const res of paidResults) {
    if (!res) continue;
    for (const d of res.days) {
      if (!byDate.has(d.date)) byDate.set(d.date, []);
      byDate.get(d.date)!.push({ source: res.sourceName, highF: d.highF, lowF: d.lowF });
    }
  }

  if (byDate.size === 0) return null;

  const days: KalshiEnsembleDay[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const samples = byDate.get(date)!;
    if (samples.length === 0) continue;
    const highs = samples.map((s) => s.highF);
    const lows = samples.map((s) => s.lowF);
    const ensembleHighF = mean(highs);
    const ensembleLowF = mean(lows);
    const spreadHighF = stddev(highs);
    const spreadLowF = stddev(lows);
    days.push({
      date,
      ensembleHighF: Math.round(ensembleHighF * 10) / 10,
      ensembleLowF: Math.round(ensembleLowF * 10) / 10,
      spreadHighF: Math.round(spreadHighF * 10) / 10,
      spreadLowF: Math.round(spreadLowF * 10) / 10,
      agreement: Math.round(agreementScore(spreadHighF) * 100) / 100,
      sources: samples,
      sourceCount: samples.length,
    });
  }

  return {
    city,
    fetchedAt: new Date().toISOString(),
    days,
  };
}

/** Gaussian CDF via Abramowitz & Stegun approximation. */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p =
    d *
    Math.exp(-(x * x) / 2) *
    (0.3193815 * t -
      0.3565638 * t * t +
      1.781478 * t * t * t -
      1.8212560 * t * t * t * t +
      1.3302744 * t * t * t * t * t);
  return x >= 0 ? 1 - p : p;
}

/**
 * Probability that the actual value falls in [lowF, highF], given a
 * Gaussian with mean=ensembleF and sigma = RSS(baseSigma, spread).
 *
 * Use ±0.5°F rounding margin (Kalshi brackets are integer-bounded).
 * Pass −Infinity for lowF or +Infinity for highF on the tail brackets.
 */
export function bracketProbability(
  ensembleF: number,
  spreadF: number,
  lowF: number,
  highF: number,
  hoursUntilResolution: number,
): number {
  const baseSigma =
    hoursUntilResolution <= 12
      ? 1.5
      : hoursUntilResolution <= 24
        ? 2.0
        : hoursUntilResolution <= 48
          ? 3.0
          : hoursUntilResolution <= 72
            ? 4.0
            : 5.0;

  const sigma = Math.sqrt(baseSigma ** 2 + spreadF ** 2);

  const zLow = isFinite(lowF) ? (lowF - 0.5 - ensembleF) / sigma : -Infinity;
  const zHigh = isFinite(highF) ? (highF + 0.5 - ensembleF) / sigma : Infinity;

  const pLow = isFinite(zLow) ? normCdf(zLow) : 0;
  const pHigh = isFinite(zHigh) ? normCdf(zHigh) : 1;

  return Math.max(0, Math.min(1, pHigh - pLow));
}
