/**
 * Common interface for weather forecast sources.
 *
 * The KalshiEnsemble combines results from all configured sources
 * (free + paid) into a single probability distribution.
 */

export interface DailyTempForecast {
  /** YYYY-MM-DD in the local timezone of the city */
  date: string;
  highF: number;
  lowF: number;
  /** "observed" = already happened (short horizon), "forecast" = future */
  type?: "observed" | "forecast";
}

export interface SourceForecast {
  sourceName: string;
  city: string;
  fetchedAt: string;
  days: DailyTempForecast[];
}

export interface ForecastSource {
  readonly name: string;
  /** Whether this source is configured (has API key or is key-free). */
  isConfigured(): boolean;
  /**
   * Fetch forecast for a city, up to `daysAhead` days out.
   * Return null if source fails or is unconfigured.
   */
  fetch(city: string, daysAhead: number): Promise<SourceForecast | null>;
}

/** Coordinates lookup shared across sources. Extend as Kalshi adds cities. */
export const CITY_COORDS: Record<string, { lat: number; lon: number; country: "US" | "INT" }> = {
  nyc: { lat: 40.7128, lon: -74.006, country: "US" },
  "new york city": { lat: 40.7128, lon: -74.006, country: "US" },
  lax: { lat: 33.9416, lon: -118.4085, country: "US" },
  "los angeles": { lat: 34.0522, lon: -118.2437, country: "US" },
  chi: { lat: 41.8781, lon: -87.6298, country: "US" },
  chicago: { lat: 41.8781, lon: -87.6298, country: "US" },
  mia: { lat: 25.7617, lon: -80.1918, country: "US" },
  miami: { lat: 25.7617, lon: -80.1918, country: "US" },
  aus: { lat: 30.2672, lon: -97.7431, country: "US" },
  austin: { lat: 30.2672, lon: -97.7431, country: "US" },
  den: { lat: 39.7392, lon: -104.9903, country: "US" },
  denver: { lat: 39.7392, lon: -104.9903, country: "US" },
  phi: { lat: 39.9526, lon: -75.1652, country: "US" },
  philadelphia: { lat: 39.9526, lon: -75.1652, country: "US" },
  bos: { lat: 42.3601, lon: -71.0589, country: "US" },
  boston: { lat: 42.3601, lon: -71.0589, country: "US" },
  dc: { lat: 38.9072, lon: -77.0369, country: "US" },
  washington: { lat: 38.9072, lon: -77.0369, country: "US" },
};

export function resolveCoords(city: string): { lat: number; lon: number; country: "US" | "INT" } | null {
  const key = city.toLowerCase().trim();
  if (CITY_COORDS[key]) return CITY_COORDS[key];
  const fuzzy = Object.keys(CITY_COORDS).find((k) => k.includes(key) || key.includes(k));
  return fuzzy ? CITY_COORDS[fuzzy] : null;
}

export function cToF(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}
