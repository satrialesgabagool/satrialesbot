/**
 * GFS 31-member ensemble fetcher (GEFS via Open-Meteo).
 *
 * Our standard ensemble approximates the forecast distribution as a Gaussian
 * around the mean of several point-forecast models. That understates fat tails —
 * when the ensemble has meaningful bimodal or skewed shape, the Gaussian
 * assumption mis-prices bracket tails. This is precisely the bug we saw on
 * April 15-16 (NYC ≥92°F getting 19% when the true tail was ~3%).
 *
 * This module pulls the *full* GEFS distribution (1 control + 30 perturbed
 * members = 31 total) from Open-Meteo's ensemble-api endpoint. The members
 * are used by `empiricalBracketProbability()` to compute probability by
 * counting how many of the 31 members land inside the bracket — instead
 * of forcing a Gaussian shape.
 *
 * Free, no API key required. Endpoint:
 *   https://ensemble-api.open-meteo.com/v1/ensemble
 *
 * ADDITIVE: this doesn't replace the existing ensemble. When GFS members
 * are unavailable (API hiccup, city not covered, etc.), the Gaussian path
 * still runs. Members are a quality upgrade, not a dependency.
 *
 * Coords are the NWS airport stations (same as WeatherEnsemble.ts) so the
 * 31 members reflect conditions at the exact point Kalshi resolves against.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";

/**
 * City → coordinates. Uses the same NWS airport ASOS station coords as
 * WeatherEnsemble.ts so the ensemble is anchored to Kalshi's resolution point.
 * Includes Kalshi abbreviations for fuzzy matching.
 */
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  // Full names — airport ASOS station coords (match WeatherEnsemble.ts)
  "new york city": { lat: 40.7790, lon: -73.9692 },   // Central Park (KNYC)
  "chicago":       { lat: 41.7860, lon: -87.7524 },   // Midway (KMDW)
  "miami":         { lat: 25.7933, lon: -80.2906 },   // MIA (KMIA)
  "los angeles":   { lat: 33.9425, lon: -118.4081 },  // LAX (KLAX)
  "austin":        { lat: 30.1945, lon: -97.6699 },   // Bergstrom (KAUS)
  "denver":        { lat: 39.8617, lon: -104.6732 },  // DIA (KDEN)
  "atlanta":       { lat: 33.6367, lon: -84.4281 },   // Hartsfield (KATL)
  "dallas":        { lat: 32.8968, lon: -97.0380 },   // DFW (KDFW)
  "seattle":       { lat: 47.4490, lon: -122.3093 },  // Sea-Tac (KSEA)
  "houston":       { lat: 29.6454, lon: -95.2789 },   // Hobby (KHOU)
  "phoenix":       { lat: 33.4343, lon: -112.0117 },  // Sky Harbor (KPHX)
  "boston":         { lat: 42.3631, lon: -71.0064 },   // Logan (KBOS)
  "las vegas":     { lat: 36.0803, lon: -115.1524 },  // Reid (KLAS)
  "minneapolis":   { lat: 44.8820, lon: -93.2218 },   // MSP (KMSP)
  "philadelphia":  { lat: 39.8721, lon: -75.2407 },   // PHL (KPHL)
  "san francisco": { lat: 37.6188, lon: -122.3754 },  // SFO (KSFO)
  "san antonio":   { lat: 29.5340, lon: -98.4691 },   // SAT (KSAT)
  "washington dc": { lat: 38.8514, lon: -77.0377 },   // Reagan (KDCA)
  // Kalshi abbreviations
  "nyc": { lat: 40.7790, lon: -73.9692 },
  "ny":  { lat: 40.7790, lon: -73.9692 },
  "lax": { lat: 33.9425, lon: -118.4081 },
  "la":  { lat: 33.9425, lon: -118.4081 },
  "chi": { lat: 41.7860, lon: -87.7524 },
  "mia": { lat: 25.7933, lon: -80.2906 },
  "aus": { lat: 30.1945, lon: -97.6699 },
  "den": { lat: 39.8617, lon: -104.6732 },
  "atl": { lat: 33.6367, lon: -84.4281 },
  "dfw": { lat: 32.8968, lon: -97.0380 },
  "dal": { lat: 32.8968, lon: -97.0380 },
  "sea": { lat: 47.4490, lon: -122.3093 },
  "hou": { lat: 29.6454, lon: -95.2789 },
  "phx": { lat: 33.4343, lon: -112.0117 },
  "bos": { lat: 42.3631, lon: -71.0064 },
  "lv":  { lat: 36.0803, lon: -115.1524 },
  "las": { lat: 36.0803, lon: -115.1524 },
  "msp": { lat: 44.8820, lon: -93.2218 },
  "phl": { lat: 39.8721, lon: -75.2407 },
  "phi": { lat: 39.8721, lon: -75.2407 },
  "sf":  { lat: 37.6188, lon: -122.3754 },
  "sfo": { lat: 37.6188, lon: -122.3754 },
  "sa":  { lat: 29.5340, lon: -98.4691 },
  "dc":  { lat: 38.8514, lon: -77.0377 },
};

export interface GFSDayMembers {
  date: string;
  /** Daily high (°F) per member. Length up to 31. */
  highF_members: number[];
  /** Daily low (°F) per member. */
  lowF_members: number[];
}

export interface GFSEnsembleResult {
  city: string;
  days: GFSDayMembers[];
  fetchedAt: string;
}

function resolveCity(city: string): { lat: number; lon: number } | null {
  const key = city.toLowerCase().trim();
  if (CITY_COORDS[key]) return CITY_COORDS[key];
  const match = Object.keys(CITY_COORDS).find(
    (k) => k.includes(key) || (key.length >= 3 && key.includes(k)),
  );
  return match ? CITY_COORDS[match] : null;
}

/**
 * Identify ensemble member keys in an Open-Meteo response.
 *
 * With `models=gfs025,ecmwf_ifs025` Open-Meteo returns 82 total members:
 *   GFS (NCEP GEFS025): 1 control + 30 perturbed = 31
 *     - temperature_2m_ncep_gefs025                      (control)
 *     - temperature_2m_member01_ncep_gefs025 … member30  (30 members)
 *   ECMWF (IFS 0.25°): 1 control + 50 perturbed = 51
 *     - temperature_2m_ecmwf_ifs025_ensemble             (control)
 *     - temperature_2m_member01_ecmwf_ifs025_ensemble … member50
 *
 * Match any key starting with `temperature_2m` that has array values.
 * This handles both single-model and multi-model responses uniformly.
 */
function findMemberKeys(hourly: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const k of Object.keys(hourly)) {
    if (k === "time") continue;
    if (!k.startsWith("temperature_2m")) continue;
    if (!Array.isArray(hourly[k])) continue;
    keys.push(k);
  }
  return keys;
}

/**
 * Fetch combined GFS+ECMWF 82-member ensemble for a city, aggregate hourly
 * values into daily highs/lows per member. Returns null on network error /
 * missing city.
 *
 * 82 members total (31 GFS + 51 ECMWF) is materially better than 31:
 * - Tighter empirical probability estimates (1/82 ≈ 1.2% resolution)
 * - Captures multi-model skew that single-family ensembles miss
 * - Helps when GFS and ECMWF disagree (classic "weather pattern uncertainty")
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
  // gfs025: 1 control + 30 perturbed = 31 GFS members
  // ecmwf_ifs025: 1 control + 50 perturbed = 51 ECMWF members
  // Total: 82 members for empirical bracket probability
  url.searchParams.set("models", "gfs025,ecmwf_ifs025");
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
    // Require at least half the members to have valid data; partial days at
    // the edge of the forecast window otherwise pollute the distribution.
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
 * (`ensembleBracketProbability`): a member value of 71.8 counts in bracket
 * [72, 74] just as the Gaussian integrates down to 71.5.
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
  const loCut = (bracketLowF != null && isFinite(bracketLowF)) ? bracketLowF - 0.5 : -Infinity;
  const hiCut = (bracketHighF != null && isFinite(bracketHighF)) ? bracketHighF + 0.5 : Infinity;
  let count = 0;
  for (const m of members) {
    if (m >= loCut && m <= hiCut) count++;
  }
  const alpha = 0.5;
  return (count + alpha) / (members.length + 2 * alpha);
}
