/**
 * GFS 31-member ensemble fetcher (GEFS via Open-Meteo).
 *
 * The current weather strategy approximates the forecast distribution as a
 * Gaussian around the mean of several point-forecast models. That understates
 * fat tails — when the ensemble has meaningful bimodal or skewed shape, the
 * Gaussian assumption mis-prices bracket tails.
 *
 * This module pulls the *full* GEFS distribution (1 control + 30 perturbed
 * members = 31 total) from Open-Meteo's ensemble-api endpoint. The members
 * can be used in `ensembleBracketProbability()` to compute an *empirical*
 * probability — just count how many of the 31 members land inside the
 * bracket — instead of forcing a Gaussian shape.
 *
 * Free, no API key required. Endpoint:
 *   https://ensemble-api.open-meteo.com/v1/ensemble
 *
 * ADDITIVE: this doesn't replace the existing ensemble. When GFS members
 * are unavailable (API hiccup, city not covered, etc.), the Gaussian path
 * still runs. Members are a quality upgrade, not a dependency.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";

export interface GFSDayMembers {
  date: string;
  /** Daily high (°F) per member. Length up to 31; can be shorter if some members have missing data. */
  highF_members: number[];
  /** Daily low (°F) per member. */
  lowF_members: number[];
}

export interface GFSEnsembleResult {
  city: string;
  days: GFSDayMembers[];
  fetchedAt: string;
}

/**
 * City → coordinates. Intentionally decoupled from WeatherEnsemble's map so
 * this module can evolve independently (e.g. add airport-specific lat/lon
 * for METAR alignment). Keep the union of Kalshi KXHIGH cities + their
 * abbreviations.
 */
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  // Full names
  "new york city": { lat: 40.7128, lon: -74.0060 },
  "chicago": { lat: 41.8781, lon: -87.6298 },
  "miami": { lat: 25.7617, lon: -80.1918 },
  "los angeles": { lat: 34.0522, lon: -118.2437 },
  "austin": { lat: 30.2672, lon: -97.7431 },
  "denver": { lat: 39.7392, lon: -104.9903 },
  "atlanta": { lat: 33.7490, lon: -84.3880 },
  "dallas": { lat: 32.7767, lon: -96.7970 },
  "seattle": { lat: 47.6062, lon: -122.3321 },
  "houston": { lat: 29.7604, lon: -95.3698 },
  "phoenix": { lat: 33.4484, lon: -112.0740 },
  "boston": { lat: 42.3601, lon: -71.0589 },
  "las vegas": { lat: 36.1699, lon: -115.1398 },
  "minneapolis": { lat: 44.9778, lon: -93.2650 },
  "philadelphia": { lat: 39.9526, lon: -75.1652 },
  "san francisco": { lat: 37.7749, lon: -122.4194 },
  "washington": { lat: 38.9072, lon: -77.0369 },
  // Kalshi abbreviations
  "nyc": { lat: 40.7128, lon: -74.0060 },
  "ny": { lat: 40.7128, lon: -74.0060 },
  "lax": { lat: 34.0522, lon: -118.2437 },
  "la": { lat: 34.0522, lon: -118.2437 },
  "chi": { lat: 41.8781, lon: -87.6298 },
  "mia": { lat: 25.7617, lon: -80.1918 },
  "aus": { lat: 30.2672, lon: -97.7431 },
  "den": { lat: 39.7392, lon: -104.9903 },
  "atl": { lat: 33.7490, lon: -84.3880 },
  "dfw": { lat: 32.7767, lon: -96.7970 },
  "sea": { lat: 47.6062, lon: -122.3321 },
  "hou": { lat: 29.7604, lon: -95.3698 },
  "phx": { lat: 33.4484, lon: -112.0740 },
  "bos": { lat: 42.3601, lon: -71.0589 },
  "lv": { lat: 36.1699, lon: -115.1398 },
  "msp": { lat: 44.9778, lon: -93.2650 },
  "phl": { lat: 39.9526, lon: -75.1652 },
  "sf": { lat: 37.7749, lon: -122.4194 },
  "sfo": { lat: 37.7749, lon: -122.4194 },
  "dc": { lat: 38.9072, lon: -77.0369 },
};

function resolveCity(city: string): { lat: number; lon: number } | null {
  const key = city.toLowerCase().trim();
  if (CITY_COORDS[key]) return CITY_COORDS[key];
  // Fuzzy substring fallback (e.g. "Los Angeles, CA" → "los angeles")
  const match = Object.keys(CITY_COORDS).find(
    (k) => k.includes(key) || (key.length >= 3 && key.includes(k)),
  );
  return match ? CITY_COORDS[match] : null;
}

/**
 * Identify GEFS member keys in an Open-Meteo ensemble response.
 *
 * The control run is exposed as bare `temperature_2m`, and the 30 perturbed
 * members are `temperature_2m_member01` through `temperature_2m_member30`.
 * Together → 31 members.
 */
function findMemberKeys(hourly: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (Array.isArray(hourly["temperature_2m"])) keys.push("temperature_2m");
  for (const k of Object.keys(hourly)) {
    if (/^temperature_2m_member\d+$/.test(k) && Array.isArray(hourly[k])) {
      keys.push(k);
    }
  }
  return keys;
}

/**
 * Fetch GEFS 31-member ensemble for a city, aggregate hourly values into
 * daily highs/lows per member.
 *
 * Returns null on network error, missing city, or empty response. Callers
 * should fall back to the Gaussian-only ensemble on null.
 */
export async function fetchGFSEnsemble(
  city: string,
  daysAhead: number = 3,
): Promise<GFSEnsembleResult | null> {
  const coords = resolveCity(city);
  if (!coords) return null;

  const url = new URL("https://ensemble-api.open-meteo.com/v1/ensemble");
  url.searchParams.set("latitude", coords.lat.toString());
  url.searchParams.set("longitude", coords.lon.toString());
  url.searchParams.set("hourly", "temperature_2m");
  // `gfs025` is NOAA's GEFS at 0.25° grid — gives the full 31-member set.
  // `gfs_seamless` blends GFS model runs but doesn't expose per-member keys.
  url.searchParams.set("models", "gfs025");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", Math.min(daysAhead + 1, 16).toString());

  let data: any;
  try {
    const res = await fetchWithRetry(url.toString(), {}, { timeoutMs: 15_000, maxRetries: 1 });
    data = await res.json();
  } catch {
    return null;
  }

  if (!data?.hourly?.time || !Array.isArray(data.hourly.time)) return null;

  const memberKeys = findMemberKeys(data.hourly);
  if (memberKeys.length === 0) return null;

  // Aggregate hourly temperatures → per-date daily max/min per member.
  const times: string[] = data.hourly.time;
  const dailyMax = new Map<string, number[]>();
  const dailyMin = new Map<string, number[]>();

  for (let i = 0; i < times.length; i++) {
    const date = times[i].split("T")[0];
    if (!dailyMax.has(date)) {
      dailyMax.set(date, new Array(memberKeys.length).fill(-Infinity));
      dailyMin.set(date, new Array(memberKeys.length).fill(Infinity));
    }
    const maxes = dailyMax.get(date)!;
    const mins = dailyMin.get(date)!;
    for (let m = 0; m < memberKeys.length; m++) {
      const series = data.hourly[memberKeys[m]] as unknown;
      if (!Array.isArray(series)) continue;
      const v = series[i];
      if (typeof v !== "number" || !isFinite(v)) continue;
      if (v > maxes[m]) maxes[m] = v;
      if (v < mins[m]) mins[m] = v;
    }
  }

  const days: GFSDayMembers[] = [];
  for (const date of [...dailyMax.keys()].sort()) {
    const highs = dailyMax.get(date)!.filter((v) => isFinite(v));
    const lows = dailyMin.get(date)!.filter((v) => isFinite(v));
    // Require at least half the members to have valid data for a day.
    // Anything less is usually a partial day at the edge of the forecast window.
    if (highs.length < Math.floor(memberKeys.length / 2)) continue;
    days.push({ date, highF_members: highs, lowF_members: lows });
  }

  if (days.length === 0) return null;

  return {
    city,
    days,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Empirical bracket probability from a set of forecast members.
 *
 * Uses the same continuity correction as the Gaussian path
 * (`ensembleBracketProbability`) so the two paths produce comparable numbers:
 * a member value of 71.8 counts in bracket [72, 74] just as the Gaussian
 * integrates down to 71.5.
 *
 * Laplace smoothing (α=0.5) prevents pathological 0% / 100% when no member
 * happens to land in a narrow bracket but the bracket is still plausible.
 */
export function empiricalBracketProbability(
  members: number[],
  bracketLowF: number,
  bracketHighF: number,
): number {
  if (members.length === 0) return 0;
  const loCut = isFinite(bracketLowF) ? bracketLowF - 0.5 : -Infinity;
  const hiCut = isFinite(bracketHighF) ? bracketHighF + 0.5 : Infinity;
  let count = 0;
  for (const m of members) {
    if (m >= loCut && m <= hiCut) count++;
  }
  // Laplace: prevent exactly 0/1 for narrow brackets + small samples.
  const alpha = 0.5;
  return (count + alpha) / (members.length + 2 * alpha);
}
