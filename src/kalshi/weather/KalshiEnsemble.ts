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

import {
  fetchEnsembleForecast,
  ensembleBracketProbability,
} from "../../weather/WeatherEnsemble";
import { loadPaidSources, type ForecastSource, type DailyTempForecast } from "./sources";

/**
 * Kalshi series use short abbreviations (lax, chi, mia…) but the free-tier
 * ensemble in WeatherEnsemble.ts keys by full city names. This alias map
 * bridges the gap. The fuzzy matcher handles cases like "chi" ⊂ "chicago",
 * but "lax" ↔ "los angeles" has no substring overlap, so an explicit alias
 * is required.
 */
const CITY_ALIASES: Record<string, string> = {
  lax: "los angeles",
  la: "los angeles",
  sf: "san francisco",
  phx: "phoenix",
  dc: "washington",
};

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
  // Resolve Kalshi abbreviations to full city names for the free-tier
  // ensemble (e.g. "lax" → "los angeles"). Paid sources already handle
  // abbreviations via their own CITY_COORDS.
  const resolvedCity = CITY_ALIASES[city.toLowerCase()] ?? city;

  // 1. Free-tier ensemble (Open-Meteo models + NOAA NWS for US cities).
  const free = await fetchEnsembleForecast(resolvedCity, daysAhead);

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

/**
 * Re-export ensembleBracketProbability from the shared module as
 * `bracketProbability`. Same Abramowitz & Stegun Gaussian CDF + RSS
 * sigma combination — no need to duplicate it here.
 *
 * Signature: (ensembleF, spreadF, lowF, highF, hoursUntilResolution) → [0,1]
 */
export const bracketProbability = ensembleBracketProbability;
