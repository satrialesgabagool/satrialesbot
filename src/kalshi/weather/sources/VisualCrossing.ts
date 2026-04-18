/**
 * Visual Crossing Timeline adapter.
 *
 * Free tier: 1000 records/day (one day = one record). Requires API key.
 * https://www.visualcrossing.com/resources/documentation/weather-api/timeline-weather-api/
 *
 * Endpoint supports ISO date ranges directly. `unitGroup=us` → °F.
 *
 * Set VISUALCROSSING_API_KEY to enable.
 */

import { fetchWithRetry } from "../../../net/fetchWithRetry";
import { resolveCoords, type ForecastSource, type SourceForecast } from "./types";

export class VisualCrossingSource implements ForecastSource {
  readonly name = "visualcrossing";
  constructor(private readonly apiKey: string | undefined) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async fetch(city: string, daysAhead: number): Promise<SourceForecast | null> {
    if (!this.apiKey) return null;
    const coords = resolveCoords(city);
    if (!coords) return null;

    try {
      const today = new Date();
      const end = new Date(today);
      end.setDate(end.getDate() + daysAhead);
      const iso = (d: Date) => d.toISOString().slice(0, 10);

      const url =
        `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/` +
        `${coords.lat},${coords.lon}/${iso(today)}/${iso(end)}` +
        `?unitGroup=us&include=days&key=${this.apiKey}&contentType=json`;
      const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, { maxRetries: 2 });
      const data = (await res.json()) as {
        days?: { datetime: string; tempmax: number; tempmin: number }[];
      };
      if (!Array.isArray(data.days)) return null;

      const days = data.days.map((d) => ({
        date: d.datetime,
        highF: Math.round(d.tempmax),
        lowF: Math.round(d.tempmin),
        type: "forecast" as const,
      }));

      return { sourceName: this.name, city, fetchedAt: new Date().toISOString(), days };
    } catch {
      return null;
    }
  }
}
