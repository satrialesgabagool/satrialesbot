/**
 * WeatherObserver — fetches actual observed temperatures from NWS ASOS stations.
 *
 * Used by the snipe mode: once the daily high has been recorded (typically
 * by 5-6pm local), the outcome of the Kalshi KXHIGH market is effectively
 * known — but the market doesn't close until ~1am ET next day. If the
 * winning bracket's ask is still stale, that's a near-risk-free snipe.
 *
 * Data source: NWS API (api.weather.gov/stations/{ICAO}/observations)
 * - Free, no key required (just a User-Agent header)
 * - 5-minute observation frequency at most stations
 * - ~5 minute delay from observation to API availability
 * - Returns temperature in Celsius (we convert to Fahrenheit)
 */

import { fetchWithRetry } from "../net/fetchWithRetry";

// NWS requires *a* User-Agent; an email is recommended (not required) so they
// can contact you if your bot misbehaves. Set NWS_CONTACT_EMAIL in your .env
// to include one; otherwise a no-PII default is used.
const NWS_CONTACT_EMAIL = process.env.NWS_CONTACT_EMAIL?.trim();
const USER_AGENT = NWS_CONTACT_EMAIL
  ? `(Satriales Weather Bot, ${NWS_CONTACT_EMAIL})`
  : "(Satriales Weather Bot)";

/**
 * ICAO station codes for NWS Daily Climate Report resolution.
 * These are the stations Kalshi uses — must match our coordinate tables.
 */
export const CITY_STATIONS: Record<string, { icao: string; tzOffset: number }> = {
  // tzOffset = hours behind UTC (positive = west of UTC)
  "new york city": { icao: "KNYC", tzOffset: 4 },   // Central Park, EDT
  "chicago":       { icao: "KMDW", tzOffset: 5 },   // Midway, CDT
  "miami":         { icao: "KMIA", tzOffset: 4 },   // MIA, EDT
  "los angeles":   { icao: "KLAX", tzOffset: 7 },   // LAX, PDT
  "austin":        { icao: "KAUS", tzOffset: 5 },   // Bergstrom, CDT
  "denver":        { icao: "KDEN", tzOffset: 6 },   // DIA, MDT
  "atlanta":       { icao: "KATL", tzOffset: 4 },   // Hartsfield, EDT
  "dallas":        { icao: "KDFW", tzOffset: 5 },   // DFW, CDT
  "seattle":       { icao: "KSEA", tzOffset: 7 },   // Sea-Tac, PDT
  "houston":       { icao: "KHOU", tzOffset: 5 },   // Hobby, CDT
  "phoenix":       { icao: "KPHX", tzOffset: 7 },   // Sky Harbor, MST (no DST)
  "boston":         { icao: "KBOS", tzOffset: 4 },   // Logan, EDT
  "las vegas":     { icao: "KLAS", tzOffset: 7 },   // Reid, PDT
  "minneapolis":   { icao: "KMSP", tzOffset: 5 },   // MSP, CDT
  "philadelphia":  { icao: "KPHL", tzOffset: 4 },   // PHL, EDT
  "san francisco": { icao: "KSFO", tzOffset: 7 },   // SFO, PDT
  "san antonio":   { icao: "KSAT", tzOffset: 5 },   // SAT, CDT
  "washington dc": { icao: "KDCA", tzOffset: 4 },   // Reagan, EDT
};

export interface ObservedTemp {
  city: string;
  date: string;              // YYYY-MM-DD (local date)
  station: string;           // ICAO code
  highF: number;             // running daily high in Fahrenheit
  observationCount: number;  // how many readings went into this
  latestObsTime: string;     // ISO timestamp of most recent observation
  confidence: "partial" | "likely_final" | "final";
}

// Cache to avoid hammering the API
const _cache = new Map<string, { data: ObservedTemp; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch today's observed daily high for a city from NWS ASOS station.
 *
 * Returns null if the station has no data or the city isn't mapped.
 */
export async function fetchObservedHigh(
  city: string,
  date?: string, // YYYY-MM-DD, defaults to today in the city's local time
): Promise<ObservedTemp | null> {
  const cityKey = city.toLowerCase();
  const stationInfo = CITY_STATIONS[cityKey];
  if (!stationInfo) return null;

  const { icao, tzOffset } = stationInfo;

  // Determine the local date for this city
  const now = new Date();
  const localNow = new Date(now.getTime() - tzOffset * 60 * 60 * 1000);
  const localDate = date ?? localNow.toISOString().slice(0, 10);

  // Check cache
  const cacheKey = `${icao}-${localDate}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  // Build the start time for today (midnight local → UTC)
  const startUTC = new Date(`${localDate}T00:00:00Z`);
  startUTC.setHours(startUTC.getHours() + tzOffset); // midnight local → UTC
  const startISO = startUTC.toISOString();

  const url = `https://api.weather.gov/stations/${icao}/observations?start=${startISO}&limit=500`;

  try {
    const res = await fetchWithRetry(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/geo+json",
        },
      },
      { timeoutMs: 15_000, maxRetries: 2 },
    );

    const data = await res.json();
    const features = data?.features;
    if (!Array.isArray(features) || features.length === 0) return null;

    // Extract temperature readings, filter nulls
    let maxTempC = -Infinity;
    let latestObs = "";
    let count = 0;

    for (const f of features) {
      const props = f?.properties;
      if (!props) continue;
      const tempC = props.temperature?.value;
      if (typeof tempC !== "number" || !isFinite(tempC)) continue;

      count++;
      if (tempC > maxTempC) {
        maxTempC = tempC;
      }
      // Observations are newest-first; track the latest
      if (!latestObs && props.timestamp) {
        latestObs = props.timestamp;
      }
    }

    if (count === 0 || !isFinite(maxTempC)) return null;

    const highF = Math.round((maxTempC * 9 / 5 + 32) * 10) / 10;

    // Determine confidence based on local hour
    const localHour = localNow.getUTCHours(); // already shifted to local
    let confidence: ObservedTemp["confidence"];
    if (localHour >= 20) {
      confidence = "final";        // 8pm+ local — high is locked
    } else if (localHour >= 17) {
      confidence = "likely_final"; // 5-8pm — very likely final
    } else {
      confidence = "partial";      // before 5pm — could still climb
    }

    const result: ObservedTemp = {
      city,
      date: localDate,
      station: icao,
      highF,
      observationCount: count,
      latestObsTime: latestObs,
      confidence,
    };

    _cache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err) {
    // Don't crash the bot if NWS API is down
    return null;
  }
}

/**
 * Fetch observed highs for all mapped cities in parallel.
 */
export async function fetchAllObservedHighs(
  date?: string,
): Promise<Map<string, ObservedTemp>> {
  const results = new Map<string, ObservedTemp>();

  const entries = Object.entries(CITY_STATIONS);
  const promises = entries.map(async ([city]) => {
    const obs = await fetchObservedHigh(city, date);
    if (obs) results.set(city, obs);
  });

  await Promise.all(promises);
  return results;
}

/**
 * Given an observed temp and a list of brackets, find the winning bracket.
 * Returns the bracket index or -1 if no match.
 */
export function findWinningBracket(
  observedHighF: number,
  brackets: Array<{ lowF: number; highF: number }>,
): number {
  // NWS Daily Climate Report rounds to whole degrees, so 89.6°F resolves
  // as 90°F on Kalshi. Round to match the resolution convention.
  const roundedF = Math.round(observedHighF);

  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i];
    // Explicit null check — isFinite(null) returns true in JS (null coerces to 0)
    const lo = (b.lowF != null && isFinite(b.lowF)) ? b.lowF : -Infinity;
    const hi = (b.highF != null && isFinite(b.highF)) ? b.highF : Infinity;
    // Kalshi convention: interior brackets "86° to 87°" means 86 ≤ temp ≤ 87
    // Tail brackets: "≤85°F" matches anything ≤85, "≥88°F" matches ≥88
    if (roundedF >= lo && roundedF <= hi) {
      return i;
    }
  }
  return -1;
}
