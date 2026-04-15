/**
 * Tomorrow.io adapter.
 *
 * Free tier: 500 calls/day, 25 rpm. Requires API key.
 * https://docs.tomorrow.io/reference/get-timelines
 *
 * We hit the `timelines` endpoint with `timesteps=1d` and pull
 * temperatureMax / temperatureMin from the daily values.
 *
 * Tomorrow returns Celsius by default — we pass `units=imperial`.
 *
 * Set TOMORROW_API_KEY to enable.
 */

import { fetchWithRetry } from "../../../net/fetchWithRetry";
import { resolveCoords, type ForecastSource, type SourceForecast } from "./types";

export class TomorrowSource implements ForecastSource {
  readonly name = "tomorrow";
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
        `https://api.tomorrow.io/v4/weather/forecast` +
        `?location=${coords.lat},${coords.lon}` +
        `&timesteps=1d&units=imperial&apikey=${this.apiKey}`;
      const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, { maxRetries: 2 });
      const data = (await res.json()) as {
        timelines?: {
          daily?: {
            time: string;
            values: { temperatureMax: number; temperatureMin: number };
          }[];
        };
      };
      const daily = data.timelines?.daily;
      if (!Array.isArray(daily)) return null;

      const days = daily.slice(0, daysAhead + 1).map((d) => ({
        date: d.time.slice(0, 10),
        highF: Math.round(d.values.temperatureMax),
        lowF: Math.round(d.values.temperatureMin),
        type: "forecast" as const,
      }));

      return { sourceName: this.name, city, fetchedAt: new Date().toISOString(), days };
    } catch {
      return null;
    }
  }
}
