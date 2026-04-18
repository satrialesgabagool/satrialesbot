/**
 * Forecast accuracy data for the dashboard.
 *
 * Compares ensemble forecasts against Open-Meteo archive actuals
 * to measure how accurate our models are.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { fetchEnsembleForecast } from "../weather/WeatherEnsemble";

// ─── Interfaces ─────────────────────────────────────────────────────

export interface DayComparison {
  city: string;
  date: string;
  forecastHighF: number;
  actualHighF: number;
  errorF: number;           // actual - forecast (positive = underestimated)
  forecastLowF: number;
  actualLowF: number;
  modelCount: number;
  spreadF: number;           // ensemble disagreement
}

export interface CityAccuracy {
  city: string;
  n: number;
  meanError: number;
  stddev: number;
  mae: number;              // mean absolute error
  maxAbsError: number;
  within2F: number;         // fraction
  within4F: number;
}

export interface AccuracyResult {
  period: { start: string; end: string };
  comparisons: DayComparison[];
  overall: CityAccuracy;
  byCity: CityAccuracy[];
}

// ─── Constants ──────────────────────────────────────────────────────

const CITIES: Record<string, [number, number]> = {
  "New York City": [40.7128, -74.0060],
  "Chicago": [41.8781, -87.6298],
  "Miami": [25.7617, -80.1918],
  "Los Angeles": [34.0522, -118.2437],
  "Dallas": [32.7767, -96.7970],
  "Seattle": [47.6062, -122.3321],
  "Atlanta": [33.7490, -84.3880],
  "Denver": [39.7392, -104.9903],
  "Boston": [42.3601, -71.0589],
};

// ─── Helpers ────────────────────────────────────────────────────────

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function computeCityAccuracy(city: string, comparisons: DayComparison[]): CityAccuracy {
  const n = comparisons.length;
  if (n === 0) {
    return { city, n: 0, meanError: 0, stddev: 0, mae: 0, maxAbsError: 0, within2F: 0, within4F: 0 };
  }

  const errors = comparisons.map((c) => c.errorF);
  const absErrors = errors.map((e) => Math.abs(e));

  const meanError = errors.reduce((s, e) => s + e, 0) / n;
  const mae = absErrors.reduce((s, e) => s + e, 0) / n;
  const maxAbsError = Math.max(...absErrors);

  // Population standard deviation
  const variance = errors.reduce((s, e) => s + (e - meanError) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  const within2F = errors.filter((e) => Math.abs(e) <= 2).length / n;
  const within4F = errors.filter((e) => Math.abs(e) <= 4).length / n;

  return {
    city,
    n,
    meanError: Math.round(meanError * 100) / 100,
    stddev: Math.round(stddev * 100) / 100,
    mae: Math.round(mae * 100) / 100,
    maxAbsError: Math.round(maxAbsError * 100) / 100,
    within2F: Math.round(within2F * 1000) / 1000,
    within4F: Math.round(within4F * 1000) / 1000,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

export async function fetchAccuracyData(daysBack: number = 7): Promise<AccuracyResult> {
  const now = new Date();
  const endDate = new Date(now.getTime() - 3 * 86400000);
  const startDate = new Date(now.getTime() - (daysBack + 2) * 86400000);

  const startStr = fmtDate(startDate);
  const endStr = fmtDate(endDate);

  const allComparisons: DayComparison[] = [];
  const cityAccuracies: CityAccuracy[] = [];

  for (const [cityName, [lat, lon]] of Object.entries(CITIES)) {
    try {
      // (a) Fetch actuals from Open-Meteo archive
      const archiveUrl =
        `https://archive-api.open-meteo.com/v1/archive` +
        `?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min` +
        `&timezone=auto&start_date=${startStr}&end_date=${endStr}`;
      const archiveRes = await fetchWithRetry(archiveUrl, {}, { timeoutMs: 15_000 });
      const archiveData = await archiveRes.json();

      if (!archiveData.daily?.time) continue;

      // Build a lookup: date -> { actualHighC, actualLowC }
      const actuals = new Map<string, { highC: number; lowC: number }>();
      for (let i = 0; i < archiveData.daily.time.length; i++) {
        const date = archiveData.daily.time[i];
        const highC = archiveData.daily.temperature_2m_max[i];
        const lowC = archiveData.daily.temperature_2m_min[i];
        if (highC != null && lowC != null) {
          actuals.set(date, { highC, lowC });
        }
      }

      // (b) Fetch forecast (includes past_days=7) from Open-Meteo
      const forecastUrl =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min` +
        `&timezone=auto&past_days=7&forecast_days=3`;
      const forecastRes = await fetchWithRetry(forecastUrl, {}, { timeoutMs: 15_000 });
      const forecastData = await forecastRes.json();

      // Build a lookup: date -> { forecastHighC, forecastLowC }
      const forecasts = new Map<string, { highC: number; lowC: number }>();
      if (forecastData.daily?.time) {
        for (let i = 0; i < forecastData.daily.time.length; i++) {
          const date = forecastData.daily.time[i];
          const highC = forecastData.daily.temperature_2m_max[i];
          const lowC = forecastData.daily.temperature_2m_min[i];
          if (highC != null && lowC != null) {
            forecasts.set(date, { highC, lowC });
          }
        }
      }

      // (c) Fetch ensemble forecast for model count + spread
      // WeatherEnsemble expects lowercase city names
      const ensembleKey = cityName.toLowerCase();
      let ensembleByDate = new Map<string, { modelCount: number; spreadF: number }>();

      try {
        const ensemble = await fetchEnsembleForecast(ensembleKey, 3);
        if (ensemble?.forecasts) {
          for (const day of ensemble.forecasts) {
            ensembleByDate.set(day.date, {
              modelCount: day.modelCount,
              spreadF: day.spreadHighF,
            });
          }
        }
      } catch {
        // Ensemble may not work for all cities — skip silently
      }

      // (d) For each date where both actual and forecast exist, create a DayComparison
      const cityComparisons: DayComparison[] = [];

      for (const [date, actual] of actuals) {
        const forecast = forecasts.get(date);
        if (!forecast) continue;

        const actualHighF = cToF(actual.highC);
        const forecastHighF = cToF(forecast.highC);
        const errorF = Math.round((actualHighF - forecastHighF) * 10) / 10;

        const ensembleInfo = ensembleByDate.get(date);

        const comparison: DayComparison = {
          city: cityName,
          date,
          forecastHighF,
          actualHighF,
          errorF,
          forecastLowF: cToF(forecast.lowC),
          actualLowF: cToF(actual.lowC),
          modelCount: ensembleInfo?.modelCount ?? 0,
          spreadF: ensembleInfo?.spreadF ?? 0,
        };

        cityComparisons.push(comparison);
        allComparisons.push(comparison);
      }

      // Compute city-level accuracy
      if (cityComparisons.length > 0) {
        cityAccuracies.push(computeCityAccuracy(cityName, cityComparisons));
      }
    } catch {
      // If a city fails entirely, skip it
      continue;
    }
  }

  // Compute overall accuracy across all cities
  const overall = computeCityAccuracy("overall", allComparisons);

  return {
    period: { start: startStr, end: endStr },
    comparisons: allComparisons,
    overall,
    byCity: cityAccuracies,
  };
}
