/**
 * WeatherAPI.com adapter.
 *
 * Free tier: 1M calls/month, 3-day forecast on free. Requires API key.
 * https://www.weatherapi.com/docs/
 *
 * Set WEATHERAPI_API_KEY to enable.
 */

import { fetchWithRetry } from "../../../net/fetchWithRetry";
import { resolveCoords, type ForecastSource, type SourceForecast } from "./types";

export class WeatherAPISource implements ForecastSource {
  readonly name = "weatherapi";
  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async fetch(city: string, daysAhead: number): Promise<SourceForecast | null> {
    if (!this.apiKey) return null;
    const coords = resolveCoords(city);
    if (!coords) return null;

    try {
      const days = Math.min(daysAhead + 1, 14);
      const url =
        `https://api.weatherapi.com/v1/forecast.json` +
        `?key=${this.apiKey}&q=${coords.lat},${coords.lon}&days=${days}&aqi=no&alerts=no`;
      const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, { maxRetries: 2 });
      const data = (await res.json()) as {
        forecast?: {
          forecastday?: {
            date: string;
            day: { maxtemp_f: number; mintemp_f: number };
          }[];
        };
      };
      const fd = data.forecast?.forecastday;
      if (!Array.isArray(fd)) return null;

      return {
        sourceName: this.name,
        city,
        fetchedAt: new Date().toISOString(),
        days: fd.map((d) => ({
          date: d.date,
          highF: Math.round(d.day.maxtemp_f),
          lowF: Math.round(d.day.mintemp_f),
          type: "forecast" as const,
        })),
      };
    } catch {
      return null;
    }
  }
}
