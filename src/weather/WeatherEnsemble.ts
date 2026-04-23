/**
 * Multi-model weather forecast ensemble.
 *
 * Fetches forecasts from multiple Open-Meteo model endpoints
 * and NOAA (US cities), then averages them for a more robust
 * probability estimate. Ensemble spread (model disagreement)
 * is used to adjust sigma — when models disagree, we widen
 * our uncertainty.
 *
 * Models used:
 *  - Open-Meteo best_match (default, blends multiple NWP)
 *  - ECMWF IFS (European Centre, gold standard global model)
 *  - GFS (NOAA's Global Forecast System)
 *  - NOAA NWS point forecast (US cities only, hyper-local)
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { fetchGFSEnsemble } from "./GFSEnsemble";

// City coordinates — US cities use NWS Daily Climate Report station (airport ASOS),
// NOT city center, because Kalshi resolves against that station's reading.
// International cities keep city center coords (Polymarket resolution varies).
const CITY_COORDS: Record<string, { lat: number; lon: number; country: "US" | "INT" }> = {
  // US cities — airport/NWS CLI station coords (Kalshi + Polymarket)
  "new york city": { lat: 40.7790, lon: -73.9692, country: "US" },  // Central Park (KNYC)
  "nyc":           { lat: 40.7790, lon: -73.9692, country: "US" },  // Central Park (KNYC)
  "chicago":       { lat: 41.7860, lon: -87.7524, country: "US" },  // Midway (KMDW)
  "miami":         { lat: 25.7933, lon: -80.2906, country: "US" },  // MIA (KMIA)
  "los angeles":   { lat: 33.9425, lon: -118.4081, country: "US" }, // LAX (KLAX)
  "austin":        { lat: 30.1945, lon: -97.6699, country: "US" },  // Bergstrom (KAUS)
  "denver":        { lat: 39.8617, lon: -104.6732, country: "US" }, // DIA (KDEN)
  "atlanta":       { lat: 33.6367, lon: -84.4281, country: "US" },  // Hartsfield (KATL)
  "dallas":        { lat: 32.8968, lon: -97.0380, country: "US" },  // DFW (KDFW)
  "seattle":       { lat: 47.4490, lon: -122.3093, country: "US" }, // Sea-Tac (KSEA)
  "houston":       { lat: 29.6454, lon: -95.2789, country: "US" },  // Hobby (KHOU)
  "phoenix":       { lat: 33.4343, lon: -112.0117, country: "US" }, // Sky Harbor (KPHX)
  "boston":         { lat: 42.3631, lon: -71.0064, country: "US" },  // Logan (KBOS)
  "las vegas":     { lat: 36.0803, lon: -115.1524, country: "US" }, // Reid (KLAS)
  "minneapolis":   { lat: 44.8820, lon: -93.2218, country: "US" },  // MSP (KMSP)
  "philadelphia":  { lat: 39.8721, lon: -75.2407, country: "US" },  // PHL (KPHL)
  "san francisco": { lat: 37.6188, lon: -122.3754, country: "US" }, // SFO (KSFO)
  "san antonio":   { lat: 29.5340, lon: -98.4691, country: "US" },  // SAT (KSAT)
  "washington dc": { lat: 38.8514, lon: -77.0377, country: "US" },  // Reagan (KDCA)
  // International cities (Polymarket)
  "london": { lat: 51.5074, lon: -0.1278, country: "INT" },
  "paris": { lat: 48.8566, lon: 2.3522, country: "INT" },
  "tokyo": { lat: 35.6762, lon: 139.6503, country: "INT" },
  "seoul": { lat: 37.5665, lon: 126.9780, country: "INT" },
  "beijing": { lat: 39.9042, lon: 116.4074, country: "INT" },
  "shanghai": { lat: 31.2304, lon: 121.4737, country: "INT" },
  "hong kong": { lat: 22.3193, lon: 114.1694, country: "INT" },
  "taipei": { lat: 25.0330, lon: 121.5654, country: "INT" },
  "toronto": { lat: 43.6532, lon: -79.3832, country: "INT" },
  "mexico city": { lat: 19.4326, lon: -99.1332, country: "INT" },
  "madrid": { lat: 40.4168, lon: -3.7038, country: "INT" },
  "ankara": { lat: 39.9334, lon: 32.8597, country: "INT" },
  "wellington": { lat: -41.2865, lon: 174.7762, country: "INT" },
};

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

export interface EnsembleDayForecast {
  date: string;
  models: {
    name: string;
    highC: number;
    highF: number;
    lowC: number;
    lowF: number;
  }[];
  // Ensemble stats
  ensembleHighF: number;  // mean of all models
  ensembleLowF: number;
  ensembleHighC: number;
  ensembleLowC: number;
  spreadHighF: number;    // std dev across models (disagreement)
  spreadLowF: number;
  modelCount: number;
  /**
   * GFS 31-member ensemble distribution (°F) when available. When present,
   * bracket probability is computed empirically by counting members in the
   * bracket instead of from a Gaussian approximation — captures fat tails.
   */
  highFMembers?: number[];
  lowFMembers?: number[];
}

export interface EnsembleForecast {
  city: string;
  forecasts: EnsembleDayForecast[];
  fetchedAt: string;
}

// ─── Open-Meteo model endpoints ──────────────────────────────────────

async function fetchOpenMeteoModel(
  modelUrl: string,
  modelName: string,
  lat: number,
  lon: number,
  days: number,
): Promise<{ date: string; highC: number; lowC: number }[] | null> {
  try {
    // ECMWF bias_correction uses nearby station observations to post-process raw NWP,
    // reducing systematic errors — especially valuable when all models share NWP heritage
    const biasParam = modelName === "ecmwf" ? "&bias_correction=true" : "";
    const url = `${modelUrl}?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${Math.min(days + 1, 16)}${biasParam}`;
    const res = await fetchWithRetry(url, {}, { timeoutMs: 10_000 });
    const data = await res.json();
    if (!data.daily) return null;

    return (data.daily.time as string[]).map((date: string, i: number) => ({
      date,
      highC: data.daily.temperature_2m_max[i],
      lowC: data.daily.temperature_2m_min[i],
    }));
  } catch {
    return null;
  }
}

// ─── NOAA NWS forecast (US only) ────────────────────────────────────

async function fetchNOAA(lat: number, lon: number): Promise<{ date: string; highC: number; lowC: number }[] | null> {
  try {
    // Step 1: Get the forecast grid
    const pointUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
    const pointRes = await fetchWithRetry(pointUrl, {}, { timeoutMs: 10_000, maxRetries: 1 });
    const pointData = await pointRes.json();
    const forecastUrl = pointData.properties?.forecast;
    if (!forecastUrl) return null;

    // Step 2: Get the forecast
    const fcRes = await fetchWithRetry(forecastUrl, {
      headers: { "User-Agent": "Satriales/1.0 (weather-trading-bot)" },
    }, { timeoutMs: 10_000, maxRetries: 1 });
    const fcData = await fcRes.json();
    const periods = fcData.properties?.periods;
    if (!Array.isArray(periods)) return null;

    // NOAA returns day/night periods. Group by date.
    const byDate = new Map<string, { highs: number[]; lows: number[] }>();
    for (const p of periods) {
      const date = p.startTime?.split("T")[0];
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, { highs: [], lows: [] });
      const entry = byDate.get(date)!;

      const tempC = p.temperatureUnit === "F"
        ? (p.temperature - 32) * 5 / 9
        : p.temperature;

      if (p.isDaytime) entry.highs.push(tempC);
      else entry.lows.push(tempC);
    }

    const results: { date: string; highC: number; lowC: number }[] = [];
    for (const [date, { highs, lows }] of byDate) {
      if (highs.length === 0 || lows.length === 0) continue;
      results.push({
        date,
        highC: Math.max(...highs),
        lowC: Math.min(...lows),
      });
    }

    return results;
  } catch {
    return null;
  }
}

// ─── Ensemble builder ────────────────────────────────────────────────

export async function fetchEnsembleForecast(
  city: string,
  daysAhead: number = 3,
): Promise<EnsembleForecast | null> {
  const cityKey = city.toLowerCase();
  const coords = CITY_COORDS[cityKey];
  if (!coords) {
    // Try fuzzy match
    const key = Object.keys(CITY_COORDS).find(
      k => k.includes(cityKey) || cityKey.includes(k)
    );
    if (!key) return null;
    return fetchEnsembleForecast(key, daysAhead);
  }

  const { lat, lon, country } = coords;

  // Fetch from multiple models in parallel
  const modelFetches: Promise<{ name: string; data: { date: string; highC: number; lowC: number }[] | null }>[] = [
    fetchOpenMeteoModel("https://api.open-meteo.com/v1/forecast", "open-meteo", lat, lon, daysAhead)
      .then(data => ({ name: "open-meteo", data })),
    fetchOpenMeteoModel("https://api.open-meteo.com/v1/ecmwf", "ecmwf", lat, lon, daysAhead)
      .then(data => ({ name: "ecmwf", data })),
    fetchOpenMeteoModel("https://api.open-meteo.com/v1/gfs", "gfs", lat, lon, daysAhead)
      .then(data => ({ name: "gfs", data })),
  ];

  // Add NOAA for US cities
  if (country === "US") {
    modelFetches.push(
      fetchNOAA(lat, lon).then(data => ({ name: "noaa", data }))
    );
  }

  // Also fetch GFS 31-member ensemble in parallel (for empirical prob calc)
  const gfsMembersPromise = fetchGFSEnsemble(city, daysAhead);

  const [results, gfsEnsemble] = await Promise.all([
    Promise.all(modelFetches),
    gfsMembersPromise,
  ]);

  // Build a lookup: date → { highFMembers, lowFMembers }
  const gfsMembersByDate = new Map<string, { highs: number[]; lows: number[] }>();
  if (gfsEnsemble) {
    for (const d of gfsEnsemble.days) {
      gfsMembersByDate.set(d.date, { highs: d.highF_members, lows: d.lowF_members });
    }
  }

  // Collect all dates across models
  const allDates = new Set<string>();
  const modelData = new Map<string, Map<string, { highC: number; lowC: number }>>();

  for (const { name, data } of results) {
    if (!data) continue;
    const dateMap = new Map<string, { highC: number; lowC: number }>();
    for (const d of data) {
      allDates.add(d.date);
      dateMap.set(d.date, { highC: d.highC, lowC: d.lowC });
    }
    modelData.set(name, dateMap);
  }

  if (modelData.size === 0) return null;

  // Build ensemble for each date
  const forecasts: EnsembleDayForecast[] = [];
  const sortedDates = [...allDates].sort();

  for (const date of sortedDates) {
    const models: EnsembleDayForecast["models"] = [];
    const highsF: number[] = [];
    const lowsF: number[] = [];

    for (const [name, dateMap] of modelData) {
      const d = dateMap.get(date);
      if (!d) continue;
      const highF = cToF(d.highC);
      const lowF = cToF(d.lowC);
      models.push({ name, highC: d.highC, highF, lowC: d.lowC, lowF });
      highsF.push(highF);
      lowsF.push(lowF);
    }

    if (models.length === 0) continue;

    const meanHighF = highsF.reduce((a, b) => a + b, 0) / highsF.length;
    const meanLowF = lowsF.reduce((a, b) => a + b, 0) / lowsF.length;

    // Standard deviation (spread) across models
    const spreadHighF = models.length > 1
      ? Math.sqrt(highsF.reduce((s, h) => s + (h - meanHighF) ** 2, 0) / highsF.length)
      : 0;
    const spreadLowF = models.length > 1
      ? Math.sqrt(lowsF.reduce((s, l) => s + (l - meanLowF) ** 2, 0) / lowsF.length)
      : 0;

    const gfsForDate = gfsMembersByDate.get(date);
    forecasts.push({
      date,
      models,
      ensembleHighF: Math.round(meanHighF * 10) / 10,
      ensembleLowF: Math.round(meanLowF * 10) / 10,
      ensembleHighC: Math.round((meanHighF - 32) * 5 / 9 * 10) / 10,
      ensembleLowC: Math.round((meanLowF - 32) * 5 / 9 * 10) / 10,
      spreadHighF: Math.round(spreadHighF * 10) / 10,
      spreadLowF: Math.round(spreadLowF * 10) / 10,
      modelCount: models.length,
      highFMembers: gfsForDate?.highs,
      lowFMembers: gfsForDate?.lows,
    });
  }

  return {
    city,
    forecasts,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Compute bracket probability using ensemble forecast.
 *
 * Key improvement: sigma is the RSS of base forecast error + model spread.
 * When models disagree, uncertainty widens → probabilities spread out.
 * When models agree, sigma stays tight → confident probability peaks.
 */
export function ensembleBracketProbability(
  ensembleHighF: number,
  modelSpreadF: number,
  bracketLowF: number,
  bracketHighF: number,
  hoursUntilResolution: number,
  /** Optional: GFS 31-member distribution. When provided with ≥10 members,
   *  computes empirical probability (count in bracket / total) instead of
   *  Gaussian — captures fat tails, bimodality, and skew. */
  members?: number[],
): number {
  // Empirical path: count members in bracket with continuity correction.
  // Laplace smoothing (α=0.5) prevents 0%/100% for narrow brackets.
  if (members && members.length >= 10) {
    const loCut = (bracketLowF != null && isFinite(bracketLowF)) ? bracketLowF - 0.5 : -Infinity;
    const hiCut = (bracketHighF != null && isFinite(bracketHighF)) ? bracketHighF + 0.5 : Infinity;
    let count = 0;
    for (const m of members) {
      if (m >= loCut && m <= hiCut) count++;
    }
    const alpha = 0.5;
    return (count + alpha) / (members.length + 2 * alpha);
  }

  // Gaussian fallback
  // Base sigma from forecast horizon
  const baseSigma = hoursUntilResolution <= 12 ? 1.5
    : hoursUntilResolution <= 24 ? 2.0
    : hoursUntilResolution <= 48 ? 3.0
    : hoursUntilResolution <= 72 ? 4.0
    : 5.0;

  // Combined sigma: RSS of base forecast error + model disagreement
  const sigma = Math.sqrt(baseSigma ** 2 + modelSpreadF ** 2);

  // Gaussian CDF
  function normCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327;
    const p = d * Math.exp(-x * x / 2) * (
      0.3193815 * t - 0.3565638 * t * t + 1.781478 * t * t * t
      - 1.8212560 * t * t * t * t + 1.3302744 * t * t * t * t * t
    );
    return x >= 0 ? 1 - p : p;
  }

  const zLow = isFinite(bracketLowF) ? (bracketLowF - 0.5 - ensembleHighF) / sigma : -Infinity;
  const zHigh = isFinite(bracketHighF) ? (bracketHighF + 0.5 - ensembleHighF) / sigma : Infinity;

  const pLow = isFinite(zLow) ? normCdf(zLow) : 0;
  const pHigh = isFinite(zHigh) ? normCdf(zHigh) : 1;

  return Math.max(0, Math.min(1, pHigh - pLow));
}
