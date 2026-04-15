/**
 * OpenWeatherMap One Call 3.0 adapter.
 *
 * Free tier: 1000 calls/day, requires API key.
 * https://openweathermap.org/api/one-call-3
 *
 * Returns daily high/low from `daily[]`. Temps returned in Kelvin
 * when no units param is passed; we request `units=imperial` for °F.
 *
 * Set OPENWEATHER_API_KEY to enable.
 */

import { fetchWithRetry } from "../../../net/fetchWithRetry";
import { resolveCoords, type ForecastSource, type SourceForecast } from "./types";

export class OpenWeatherSource implements ForecastSource {
  readonly name = "openweather";
  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async fetch(city: string, daysAhead: number): Promise<SourceForecast | null> {
    if (!this.apiKey) return null;
    const coords = resolveCoords(city);
    if (!coords) return null;

    try {
      const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${coords.lat}&lon=${coords.lon}&exclude=minutely,hourly,alerts&units=imperial&appid=${this.apiKey}`;
      const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, { maxRetries: 2 });
      const data = (await res.json()) as {
        daily?: { dt: number; temp: { max: number; min: number } }[];
      };
      if (!Array.isArray(data.daily)) return null;

      const days = data.daily.slice(0, daysAhead + 1).map((d) => ({
        date: new Date(d.dt * 1000).toISOString().slice(0, 10),
        highF: Math.round(d.temp.max),
        lowF: Math.round(d.temp.min),
        type: "forecast" as const,
      }));

      return { sourceName: this.name, city, fetchedAt: new Date().toISOString(), days };
    } catch {
      return null;
    }
  }
}
