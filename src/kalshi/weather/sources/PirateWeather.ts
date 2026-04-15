/**
 * Pirate Weather adapter — Dark Sky API-compatible.
 *
 * Free tier: 10k calls/month. Requires API key (free signup).
 * https://docs.pirateweather.net/
 *
 * Set PIRATEWEATHER_API_KEY to enable.
 */

import { fetchWithRetry } from "../../../net/fetchWithRetry";
import { resolveCoords, type ForecastSource, type SourceForecast } from "./types";

export class PirateWeatherSource implements ForecastSource {
  readonly name = "pirateweather";
  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async fetch(city: string, daysAhead: number): Promise<SourceForecast | null> {
    if (!this.apiKey) return null;
    const coords = resolveCoords(city);
    if (!coords) return null;

    try {
      const url =
        `https://api.pirateweather.net/forecast/${this.apiKey}/${coords.lat},${coords.lon}` +
        `?units=us&exclude=minutely,hourly,alerts,currently`;
      const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, { maxRetries: 2 });
      const data = (await res.json()) as {
        daily?: {
          data?: { time: number; temperatureHigh: number; temperatureLow: number }[];
        };
      };
      const daily = data.daily?.data;
      if (!Array.isArray(daily)) return null;

      return {
        sourceName: this.name,
        city,
        fetchedAt: new Date().toISOString(),
        days: daily.slice(0, daysAhead + 1).map((d) => ({
          date: new Date(d.time * 1000).toISOString().slice(0, 10),
          highF: Math.round(d.temperatureHigh),
          lowF: Math.round(d.temperatureLow),
          type: "forecast" as const,
        })),
      };
    } catch {
      return null;
    }
  }
}
