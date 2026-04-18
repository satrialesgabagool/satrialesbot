/**
 * Weather forecast fetcher using Open-Meteo (free, no API key).
 *
 * Returns hourly temperature forecasts and daily high/low for any location.
 * Accuracy is excellent 12-24 hours out, good 2-3 days out.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";

const OPEN_METEO_API = "https://api.open-meteo.com/v1/forecast";

// City coordinates (lat, lon)
const CITY_COORDS: Record<string, [number, number]> = {
  "new york city": [40.7128, -74.0060],
  "nyc": [40.7128, -74.0060],
  "atlanta": [33.7490, -84.3880],
  "dallas": [32.7767, -96.7970],
  "seattle": [47.6062, -122.3321],
  "london": [51.5074, -0.1278],
  "paris": [48.8566, 2.3522],
  "tokyo": [35.6762, 139.6503],
  "seoul": [37.5665, 126.9780],
  "beijing": [39.9042, 116.4074],
  "shanghai": [31.2304, 121.4737],
  "hong kong": [22.3193, 114.1694],
  "taipei": [25.0330, 121.5654],
  "toronto": [43.6532, -79.3832],
  "mexico city": [19.4326, -99.1332],
  "madrid": [40.4168, -3.7038],
  "ankara": [39.9334, 32.8597],
  "wellington": [-41.2865, 174.7762],
};

export interface DailyForecast {
  date: string; // YYYY-MM-DD
  highC: number;
  lowC: number;
  highF: number;
  lowF: number;
  hourlyTempsC: number[]; // 24 values
  hourlyTempsF: number[];
}

export interface ForecastResult {
  city: string;
  lat: number;
  lon: number;
  forecasts: DailyForecast[];
  fetchedAt: string;
}

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

export async function fetchForecast(city: string, daysAhead: number = 3): Promise<ForecastResult | null> {
  const coords = CITY_COORDS[city.toLowerCase()];
  if (!coords) {
    // Try to find a close match
    const key = Object.keys(CITY_COORDS).find(k => k.includes(city.toLowerCase()) || city.toLowerCase().includes(k));
    if (!key) return null;
    return fetchForecast(key, daysAhead);
  }

  const [lat, lon] = coords;

  try {
    const url = `${OPEN_METEO_API}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${Math.min(daysAhead + 1, 16)}`;

    const res = await fetchWithRetry(url, {}, { timeoutMs: 10_000 });
    const data = await res.json();

    if (!data.daily || !data.hourly) return null;

    const forecasts: DailyForecast[] = [];
    const dailyDates = data.daily.time as string[];
    const dailyHighs = data.daily.temperature_2m_max as number[];
    const dailyLows = data.daily.temperature_2m_min as number[];
    const hourlyTemps = data.hourly.temperature_2m as number[];

    for (let i = 0; i < dailyDates.length; i++) {
      const dayHourly = hourlyTemps.slice(i * 24, (i + 1) * 24);
      forecasts.push({
        date: dailyDates[i],
        highC: dailyHighs[i],
        lowC: dailyLows[i],
        highF: cToF(dailyHighs[i]),
        lowF: cToF(dailyLows[i]),
        hourlyTempsC: dayHourly,
        hourlyTempsF: dayHourly.map(cToF),
      });
    }

    return {
      city,
      lat,
      lon,
      forecasts,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    return null;
  }
}

/**
 * Calculate the probability that the actual high temperature falls within a bracket.
 *
 * Uses forecast high as the mean, with a standard deviation based on
 * forecast horizon (closer = tighter distribution).
 *
 * Typical forecast accuracy:
 * - 12h out: ±2°F (σ ≈ 1.5°F)
 * - 24h out: ±3°F (σ ≈ 2°F)
 * - 48h out: ±4°F (σ ≈ 3°F)
 * - 72h out: ±5°F (σ ≈ 4°F)
 */
export function bracketProbability(
  forecastHighF: number,
  bracketLowF: number,
  bracketHighF: number,
  hoursUntilResolution: number,
): number {
  // Standard deviation grows with forecast horizon
  const sigma = hoursUntilResolution <= 12 ? 1.5
    : hoursUntilResolution <= 24 ? 2.0
    : hoursUntilResolution <= 48 ? 3.0
    : hoursUntilResolution <= 72 ? 4.0
    : 5.0;

  // Gaussian CDF approximation
  function normCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327; // 1/sqrt(2*pi)
    const p = d * Math.exp(-x * x / 2) * (0.3193815 * t - 0.3565638 * t * t + 1.781478 * t * t * t - 1.8212560 * t * t * t * t + 1.3302744 * t * t * t * t * t);
    return x >= 0 ? 1 - p : p;
  }

  const zLow = isFinite(bracketLowF) ? (bracketLowF - 0.5 - forecastHighF) / sigma : -Infinity;
  const zHigh = isFinite(bracketHighF) ? (bracketHighF + 0.5 - forecastHighF) / sigma : Infinity;

  const pLow = isFinite(zLow) ? normCdf(zLow) : 0;
  const pHigh = isFinite(zHigh) ? normCdf(zHigh) : 1;

  return Math.max(0, Math.min(1, pHigh - pLow));
}
