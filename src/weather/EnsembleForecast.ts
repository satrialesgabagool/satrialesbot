/**
 * GFS + ECMWF Ensemble Forecast via Open-Meteo.
 *
 * Fetches 82 independent temperature forecasts per location/day:
 * - GFS (NCEP GEFS): 1 control + 30 members = 31
 * - ECMWF IFS 0.25: 1 control + 50 members = 51
 *
 * Why ensembles beat single-model forecasts:
 * - Real uncertainty quantification (not assumed Gaussian)
 * - Captures multi-modality (e.g. "40% chance the front arrives")
 * - Model spread adapts to weather pattern (stable high = tight, approaching front = wide)
 * - The legacy code used fixed sigma by time horizon — this adapts automatically
 *
 * We compute bracket probabilities as:
 * 1. Collect 82 temperature values
 * 2. Fit Gaussian (mean, sigma) from ensemble members
 * 3. Use normal CDF to compute bracket probability
 *
 * This is mathematically cleaner than raw empirical counting
 * (which gives probabilities in steps of 1/82 = 1.2%).
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { CITIES, lookupCity, type CityInfo } from "./cities";
import type { EnsembleResult } from "./types";

const ENSEMBLE_API = "https://ensemble-api.open-meteo.com/v1/ensemble";

// ─── API response parsing ───────────────────────────────────────────

/**
 * Fetch ensemble forecast for a city on a specific date.
 *
 * Returns 82 temperature values (31 GFS + 51 ECMWF) for the daily max temp.
 */
export async function fetchEnsemble(
  cityKey: string,
  targetDate: string, // YYYY-MM-DD
  type: "high" | "low" = "high",
): Promise<EnsembleResult | null> {
  const results = await fetchEnsembleMultiDay(cityKey, [targetDate], type);
  return results.get(targetDate) ?? null;
}

/**
 * Fetch ensemble forecasts for a city across MULTIPLE dates in ONE API call.
 * This is critical to avoid rate limiting: 1 call per city instead of 3.
 *
 * Open-Meteo returns all forecast days in a single response, so we parse
 * out the dates we need from the array.
 */
export async function fetchEnsembleMultiDay(
  cityKey: string,
  targetDates: string[],
  type: "high" | "low" = "high",
): Promise<Map<string, EnsembleResult>> {
  const results = new Map<string, EnsembleResult>();
  const city = lookupCity(cityKey);
  if (!city || targetDates.length === 0) return results;

  // Find max days ahead needed
  const now = new Date();
  let maxDaysAhead = 0;
  for (const date of targetDates) {
    const target = new Date(date + "T12:00:00Z");
    const days = Math.ceil((target.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (days > maxDaysAhead) maxDaysAhead = days;
  }

  if (maxDaysAhead < 1 || maxDaysAhead > 16) return results;

  const tempUnit = city.unit === "F" ? "fahrenheit" : "celsius";
  const dailyVar = type === "high" ? "temperature_2m_max" : "temperature_2m_min";

  try {
    const url = `${ENSEMBLE_API}?` + [
      `latitude=${city.lat}`,
      `longitude=${city.lon}`,
      `daily=${dailyVar}`,
      `temperature_unit=${tempUnit}`,
      `timezone=${encodeURIComponent(city.timezone)}`,
      `forecast_days=${Math.min(maxDaysAhead + 1, 16)}`,
      `models=gfs_seamless,ecmwf_ifs025`,
    ].join("&");

    const res = await fetchWithRetry(url, {}, { maxRetries: 3, timeoutMs: 15000, initialBackoffMs: 2000 });
    const data = await res.json();

    if (!data.daily) return results;

    const dates = data.daily.time as string[];

    // Extract results for each requested date
    for (const targetDate of targetDates) {
      const dateIdx = dates.indexOf(targetDate);
      if (dateIdx === -1) continue;

      const members: number[] = [];
      const gfsMembers: number[] = [];
      const ecmwfMembers: number[] = [];

      for (const [key, values] of Object.entries(data.daily)) {
        if (key === "time") continue;
        if (!key.startsWith(dailyVar)) continue;

        const arr = values as number[];
        const val = arr[dateIdx];
        if (val == null || !Number.isFinite(val)) continue;

        members.push(val);

        if (key.includes("ncep_gefs") || key.includes("gfs")) {
          gfsMembers.push(val);
        } else if (key.includes("ecmwf")) {
          ecmwfMembers.push(val);
        }
      }

      if (members.length < 10) continue;

      const mean = members.reduce((a, b) => a + b, 0) / members.length;
      const variance = members.reduce((s, v) => s + (v - mean) ** 2, 0) / members.length;
      const stdDev = Math.sqrt(variance);

      const gfsMean = gfsMembers.length > 0
        ? gfsMembers.reduce((a, b) => a + b, 0) / gfsMembers.length : mean;
      const ecmwfMean = ecmwfMembers.length > 0
        ? ecmwfMembers.reduce((a, b) => a + b, 0) / ecmwfMembers.length : mean;

      results.set(targetDate, {
        city: city.name,
        date: targetDate,
        members,
        mean: Math.round(mean * 10) / 10,
        stdDev: Math.round(stdDev * 10) / 10,
        min: Math.min(...members),
        max: Math.max(...members),
        modelBreakdown: {
          gfs: { mean: Math.round(gfsMean * 10) / 10, count: gfsMembers.length },
          ecmwf: { mean: Math.round(ecmwfMean * 10) / 10, count: ecmwfMembers.length },
        },
        fetchedAt: Date.now(),
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("429")) {
      // Rate limited — will retry on next scan
    } else {
      console.log(`[EnsembleForecast] ${city.name}: ${msg}`);
    }
  }

  return results;
}

// ─── Probability computation ────────────────────────────────────────

/**
 * Gaussian CDF approximation (Abramowitz and Stegun).
 * Accurate to 10^-7.
 */
function normCdf(x: number): number {
  if (!isFinite(x)) return x > 0 ? 1 : 0;

  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const p = d * Math.exp(-x * x / 2) * (
    0.3193815 * t
    - 0.3565638 * t * t
    + 1.781478 * t * t * t
    - 1.8212560 * t * t * t * t
    + 1.3302744 * t * t * t * t * t
  );
  return x >= 0 ? 1 - p : p;
}

/**
 * Compute bracket probability from ensemble forecast.
 *
 * For a bracket [low, high] with ensemble mean and stdDev:
 * - Computes P(low - 0.5 < T <= high + 0.5) using Gaussian CDF
 * - The ±0.5 accounts for rounding to whole degrees (Polymarket resolution)
 *
 * The sigma comes from the actual ensemble spread, NOT from a lookup table.
 * This is the key improvement over the legacy approach.
 */
export function ensembleBracketProb(
  ensemble: EnsembleResult,
  bracketLow: number,
  bracketHigh: number,
): number {
  const { mean, stdDev } = ensemble;

  // Floor sigma at 0.5 to avoid division by zero / infinite confidence
  const sigma = Math.max(0.5, stdDev);

  // Z-scores with ±0.5 for whole-degree rounding
  const zLow = isFinite(bracketLow) ? (bracketLow - 0.5 - mean) / sigma : -Infinity;
  const zHigh = isFinite(bracketHigh) ? (bracketHigh + 0.5 - mean) / sigma : Infinity;

  const pLow = isFinite(zLow) ? normCdf(zLow) : 0;
  const pHigh = isFinite(zHigh) ? normCdf(zHigh) : 1;

  return Math.max(0, Math.min(1, pHigh - pLow));
}

/**
 * Also compute empirical probability (count-based) as a cross-check.
 * If empirical and Gaussian disagree significantly, it indicates
 * non-normal distribution (skewness, multi-modality).
 */
export function empiricalBracketProb(
  ensemble: EnsembleResult,
  bracketLow: number,
  bracketHigh: number,
): number {
  const low = isFinite(bracketLow) ? bracketLow - 0.5 : -Infinity;
  const high = isFinite(bracketHigh) ? bracketHigh + 0.5 : Infinity;

  const count = ensemble.members.filter(v => v > low && v <= high).length;
  return count / ensemble.members.length;
}

/**
 * Blend Gaussian and empirical probabilities.
 *
 * Uses 70% Gaussian + 30% empirical to get smooth probabilities
 * that still respect ensemble distribution shape.
 */
export function blendedBracketProb(
  ensemble: EnsembleResult,
  bracketLow: number,
  bracketHigh: number,
): number {
  const gaussian = ensembleBracketProb(ensemble, bracketLow, bracketHigh);
  const empirical = empiricalBracketProb(ensemble, bracketLow, bracketHigh);

  // If empirical is 0 but gaussian thinks there's a chance, trust gaussian
  // (we might not have enough members to capture tail events)
  if (empirical === 0 && gaussian > 0.02) return gaussian;

  return 0.7 * gaussian + 0.3 * empirical;
}

/**
 * Fetch ensemble forecasts for multiple cities in parallel.
 * Batches requests to avoid overwhelming the API.
 */
export async function fetchEnsembleBatch(
  cities: string[],
  targetDate: string,
  type: "high" | "low" = "high",
  batchSize: number = 5,
): Promise<Map<string, EnsembleResult>> {
  const results = new Map<string, EnsembleResult>();

  for (let i = 0; i < cities.length; i += batchSize) {
    const batch = cities.slice(i, i + batchSize);
    const promises = batch.map(async (city) => {
      const result = await fetchEnsemble(city, targetDate, type);
      if (result) results.set(city, result);
    });
    await Promise.all(promises);
  }

  return results;
}
