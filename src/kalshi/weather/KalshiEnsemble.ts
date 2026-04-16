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
import { fetchGFSEnsemble } from "../../weather/GFSEnsemble";
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
  /**
   * Full GEFS 31-member distribution for the day's high (°F), when available.
   * Consumers prefer this over (mean, spread) because it captures the real
   * shape of the forecast distribution — fat tails, bimodality, skew — that
   * the Gaussian approximation misses. Absent when Open-Meteo's ensemble API
   * errored or the city isn't covered.
   */
  highFMembers?: number[];
  /** Same as highFMembers but for daily lows. Used by KXLOW markets. */
  lowFMembers?: number[];
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

  // 1-3. Fetch free-tier, GFS 31-member, and paid sources in parallel.
  //   - free:   Open-Meteo single-value models (ecmwf, gfs, best_match) + NOAA NWS
  //   - gfs:    Full GEFS 31-member ensemble via Open-Meteo ensemble-api
  //   - paid:   Configured paid APIs (OpenWeather, Tomorrow.io, etc.)
  // GFS 31-member is additive — its daily mean *also* participates as one
  // "source" in the point-mean calculation, but the full member array is
  // carried through for empirical bracket-probability computation.
  const activePaid = extraSources.filter((s) => s.isConfigured());
  const [free, gfs, ...paidResults] = await Promise.all([
    fetchEnsembleForecast(resolvedCity, daysAhead),
    fetchGFSEnsemble(resolvedCity, daysAhead),
    ...activePaid.map((s) => s.fetch(city, daysAhead)),
  ]);

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

  // GFS 31-member: add the member mean as one more "source" for the
  // aggregated mean/spread, AND keep the full member array keyed by date
  // (with the raw GEFS mean) so we can shift it to the aggregated center
  // later. The shift preserves the *shape* of the GEFS distribution
  // (variance, skew, fat tails) while the *center* uses the full-ensemble
  // consensus — otherwise a case like LAX where GEFS=74°F but ECMWF/NOAA=80°F
  // would let empirical probability cluster around 74°F while the scanner's
  // ensembleHighF (pulled toward 79°F) would be inconsistent.
  interface GFSDayRaw { highMembers: number[]; lowMembers: number[]; highMean: number; lowMean: number }
  const gfsRawByDate = new Map<string, GFSDayRaw>();
  if (gfs) {
    for (const d of gfs.days) {
      const highMean = d.highF_members.length > 0
        ? d.highF_members.reduce((a, b) => a + b, 0) / d.highF_members.length
        : NaN;
      const lowMean = d.lowF_members.length > 0
        ? d.lowF_members.reduce((a, b) => a + b, 0) / d.lowF_members.length
        : NaN;
      if (isFinite(highMean) && isFinite(lowMean)) {
        if (!byDate.has(d.date)) byDate.set(d.date, []);
        byDate.get(d.date)!.push({
          source: "gfs-ensemble(31m)",
          highF: Math.round(highMean * 10) / 10,
          lowF: Math.round(lowMean * 10) / 10,
        });
        gfsRawByDate.set(d.date, {
          highMembers: d.highF_members,
          lowMembers: d.lowF_members,
          highMean,
          lowMean,
        });
      }
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

    // Shift GEFS members so they're centered on the aggregated consensus
    // instead of on GEFS's own mean. Preserves the distributional shape
    // while keeping the empirical probability consistent with the
    // scanner's `ensembleHighF` center.
    const raw = gfsRawByDate.get(date);
    let highFMembers: number[] | undefined;
    let lowFMembers: number[] | undefined;
    if (raw) {
      const highShift = ensembleHighF - raw.highMean;
      const lowShift = ensembleLowF - raw.lowMean;
      highFMembers = raw.highMembers.map((m) => m + highShift);
      lowFMembers = raw.lowMembers.map((m) => m + lowShift);
    }

    days.push({
      date,
      ensembleHighF: Math.round(ensembleHighF * 10) / 10,
      ensembleLowF: Math.round(ensembleLowF * 10) / 10,
      spreadHighF: Math.round(spreadHighF * 10) / 10,
      spreadLowF: Math.round(spreadLowF * 10) / 10,
      agreement: Math.round(agreementScore(spreadHighF) * 100) / 100,
      sources: samples,
      sourceCount: samples.length,
      highFMembers,
      lowFMembers,
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
