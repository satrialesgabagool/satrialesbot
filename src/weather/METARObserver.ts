/**
 * NOAA METAR same-day lock detector.
 *
 * Kalshi KXHIGH markets resolve on the NWS Daily Climate Report, which
 * pulls from the ASOS observation at each city's primary airport station.
 * Once the observed temperature has peaked and started falling, the day's
 * high is effectively locked even before official resolution — you can
 * read it off the hourly METAR reports.
 *
 * This module fetches the last ~12h of METAR observations from the free
 * aviationweather.gov API, identifies the day's peak temperature, and
 * decides whether the peak is "locked" (peak aged ≥ 2h AND current temp
 * meaningfully below peak AND past typical peak hour).
 *
 * When locked, the weather scanner can replace forecast-derived bracket
 * probabilities with near-certain values (observed-in-bracket → 98%,
 * observed-outside → 2%) — a near-arbitrage opportunity if the Kalshi
 * market hasn't fully priced it yet.
 *
 * Free, no API key needed. Endpoint:
 *   https://aviationweather.gov/api/data/metar?ids=KJFK&format=json&hours=12
 */

import { fetchWithRetry } from "../net/fetchWithRetry";

/**
 * City → primary ASOS station for NWS daily high resolution.
 *
 * These are the stations the NWS Daily Climate Report typically pulls
 * from. NYC uses Central Park (KNYC) which is the city-center climate
 * station; airports like JFK/LGA can diverge 2-5°F on a hot day.
 *
 * Sourced from NWS climate station listings (xmACIS2). Where the primary
 * is ambiguous (Houston, Dallas, DC) we pick the one NWS reports in the
 * CF6 daily climate message.
 */
export const CITY_TO_STATION: Record<string, { station: string; tz: string }> = {
  "new york city":  { station: "KNYC", tz: "America/New_York" },
  "nyc":            { station: "KNYC", tz: "America/New_York" },
  "ny":             { station: "KNYC", tz: "America/New_York" },
  "chicago":        { station: "KORD", tz: "America/Chicago" },
  "chi":            { station: "KORD", tz: "America/Chicago" },
  "miami":          { station: "KMIA", tz: "America/New_York" },
  "mia":            { station: "KMIA", tz: "America/New_York" },
  "los angeles":    { station: "KLAX", tz: "America/Los_Angeles" },
  "lax":            { station: "KLAX", tz: "America/Los_Angeles" },
  "la":             { station: "KLAX", tz: "America/Los_Angeles" },
  "austin":         { station: "KAUS", tz: "America/Chicago" },
  "aus":            { station: "KAUS", tz: "America/Chicago" },
  "denver":         { station: "KDEN", tz: "America/Denver" },
  "den":            { station: "KDEN", tz: "America/Denver" },
  "atlanta":        { station: "KATL", tz: "America/New_York" },
  "atl":            { station: "KATL", tz: "America/New_York" },
  "dallas":         { station: "KDFW", tz: "America/Chicago" },
  "dal":            { station: "KDFW", tz: "America/Chicago" },
  "dfw":            { station: "KDFW", tz: "America/Chicago" },
  "seattle":        { station: "KSEA", tz: "America/Los_Angeles" },
  "sea":            { station: "KSEA", tz: "America/Los_Angeles" },
  "houston":        { station: "KIAH", tz: "America/Chicago" },
  "hou":            { station: "KIAH", tz: "America/Chicago" },
  "phoenix":        { station: "KPHX", tz: "America/Phoenix" }, // no DST
  "phx":            { station: "KPHX", tz: "America/Phoenix" },
  "boston":         { station: "KBOS", tz: "America/New_York" },
  "bos":            { station: "KBOS", tz: "America/New_York" },
  "las vegas":      { station: "KLAS", tz: "America/Los_Angeles" },
  "las":            { station: "KLAS", tz: "America/Los_Angeles" },
  "lv":             { station: "KLAS", tz: "America/Los_Angeles" },
  "minneapolis":    { station: "KMSP", tz: "America/Chicago" },
  "min":            { station: "KMSP", tz: "America/Chicago" },
  "msp":            { station: "KMSP", tz: "America/Chicago" },
  "philadelphia":   { station: "KPHL", tz: "America/New_York" },
  "phi":            { station: "KPHL", tz: "America/New_York" },
  "phl":            { station: "KPHL", tz: "America/New_York" },
  "san francisco":  { station: "KSFO", tz: "America/Los_Angeles" },
  "sf":             { station: "KSFO", tz: "America/Los_Angeles" },
  "sfo":            { station: "KSFO", tz: "America/Los_Angeles" },
  "san antonio":    { station: "KSAT", tz: "America/Chicago" },
  "sa":             { station: "KSAT", tz: "America/Chicago" },
  "washington dc":  { station: "KDCA", tz: "America/New_York" },
  "washington":     { station: "KDCA", tz: "America/New_York" },
  "dc":             { station: "KDCA", tz: "America/New_York" },
};

export interface METARObservation {
  station: string;
  time: string;   // UTC ISO
  tempC: number;
  tempF: number;
}

export interface METARLockResult {
  city: string;
  station: string;
  /** Local date the target market resolves on (e.g. "2026-04-16"). */
  localDate: string;
  /** Highest temperature observed today (°F). */
  peakTempF: number;
  /** UTC ISO of the peak observation. */
  peakTimeUtc: string;
  /** Hours since peak was observed. A peak older than 2-3 hours is unlikely to be broken later in the day. */
  peakAgeHours: number;
  /** Most recent observation temperature (°F). */
  currentTempF: number;
  /** Local-time hour of the most recent observation (0-23). */
  currentLocalHour: number;
  /** Number of observations used. */
  observationCount: number;
  /**
   * True when the day's high is effectively locked:
   *  1. peak is ≥ 2 hours old, AND
   *  2. current temp is ≥ 1.5°F below peak, AND
   *  3. local hour ≥ 15 (past typical peak window 2-4pm)
   */
  locked: boolean;
  reason: string;
}

function cToF(c: number): number {
  return c * 9 / 5 + 32;
}

/**
 * Get the local date + hour for a UTC ISO timestamp in a given timezone.
 * Uses Intl.DateTimeFormat to avoid pulling in a tz library.
 */
function localFields(utcIso: string, tz: string): { date: string; hour: number } {
  const d = new Date(utcIso);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // hour "24" can appear at midnight in some locales; normalize to 0
    hour: (parseInt(parts.hour, 10) || 0) % 24,
  };
}

/**
 * Fetch raw METAR observations for a station. Returns last N hours of
 * observations sorted chronologically. Returns null on network error.
 */
export async function fetchMETAR(
  station: string,
  hours: number = 12,
): Promise<METARObservation[] | null> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json&hours=${hours}`;
  try {
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "Kalshi-bot (weather-lock-detector)" } },
      { timeoutMs: 10_000, maxRetries: 1 },
    );
    const data = await res.json();
    if (!Array.isArray(data)) return null;

    const obs: METARObservation[] = [];
    for (const row of data) {
      // Response fields: `icaoId`, `reportTime` (e.g. "2026-04-16 21:51:00"), `temp` (°C)
      if (!row || typeof row.temp !== "number" || !isFinite(row.temp)) continue;
      const reportTime = row.reportTime as string | undefined;
      if (!reportTime) continue;
      // Report time is UTC without a Z suffix — add one.
      const utcIso = reportTime.includes("T")
        ? reportTime.endsWith("Z") ? reportTime : reportTime + "Z"
        : reportTime.replace(" ", "T") + "Z";
      obs.push({
        station: row.icaoId ?? station,
        time: utcIso,
        tempC: row.temp,
        tempF: Math.round(cToF(row.temp) * 10) / 10,
      });
    }
    obs.sort((a, b) => a.time.localeCompare(b.time));
    return obs;
  } catch {
    return null;
  }
}

/**
 * Decide whether today's high is locked for a given city on a given local date.
 *
 * `targetLocalDate` is the city's local calendar date the market resolves on
 * (e.g. "2026-04-16"). Only observations from that local date are considered
 * for peak determination — we don't want yesterday's peak leaking in around
 * midnight.
 */
export async function detectSameDayLock(
  city: string,
  targetLocalDate: string,
  opts: { peakAgeMinHours?: number; dropBelowPeakF?: number; minLocalHour?: number } = {},
): Promise<METARLockResult | null> {
  const station = CITY_TO_STATION[city.toLowerCase()];
  if (!station) return null;

  const peakAgeMinHours = opts.peakAgeMinHours ?? 2;
  const dropBelowPeakF = opts.dropBelowPeakF ?? 1.5;
  const minLocalHour = opts.minLocalHour ?? 15;

  const obs = await fetchMETAR(station.station, 14);
  if (!obs || obs.length === 0) return null;

  // Filter to observations whose *local* date matches the target date.
  const todays: { o: METARObservation; localHour: number }[] = [];
  for (const o of obs) {
    const { date, hour } = localFields(o.time, station.tz);
    if (date === targetLocalDate) todays.push({ o, localHour: hour });
  }
  if (todays.length === 0) return null;

  // Identify peak.
  let peakIdx = 0;
  for (let i = 1; i < todays.length; i++) {
    if (todays[i].o.tempF > todays[peakIdx].o.tempF) peakIdx = i;
  }
  const peak = todays[peakIdx].o;
  const latest = todays[todays.length - 1].o;
  const latestLocalHour = todays[todays.length - 1].localHour;

  const peakAgeHours = (new Date(latest.time).getTime() - new Date(peak.time).getTime()) / 3_600_000;
  const dropFromPeak = peak.tempF - latest.tempF;

  let locked = true;
  const reasons: string[] = [];
  if (peakAgeHours < peakAgeMinHours) {
    locked = false;
    reasons.push(`peak only ${peakAgeHours.toFixed(1)}h old (need ≥${peakAgeMinHours})`);
  }
  if (dropFromPeak < dropBelowPeakF) {
    locked = false;
    reasons.push(`only ${dropFromPeak.toFixed(1)}°F below peak (need ≥${dropBelowPeakF})`);
  }
  if (latestLocalHour < minLocalHour) {
    locked = false;
    reasons.push(`local hour ${latestLocalHour} (need ≥${minLocalHour})`);
  }

  const reason = locked
    ? `locked: peak=${peak.tempF}°F @ ${peak.time}, ${peakAgeHours.toFixed(1)}h ago, current=${latest.tempF}°F (${dropFromPeak.toFixed(1)}°F below)`
    : `unlocked: ${reasons.join("; ")}`;

  return {
    city,
    station: station.station,
    localDate: targetLocalDate,
    peakTempF: peak.tempF,
    peakTimeUtc: peak.time,
    peakAgeHours: Math.round(peakAgeHours * 10) / 10,
    currentTempF: latest.tempF,
    currentLocalHour: latestLocalHour,
    observationCount: todays.length,
    locked,
    reason,
  };
}

/**
 * Probability that a bracket will resolve YES given an observed locked peak.
 *
 * Uses the same continuity correction as the forecast math (±0.5°F) so
 * near-boundary observations don't artificially jump between near-0 and
 * near-1. Returns 0.98 / 0.02 instead of hard 1.0 / 0.0 to account for:
 *  - late-evening cold-front / warm-front (rare but possible)
 *  - ASOS sensor glitches
 *  - the ~1% chance Kalshi resolves on a slightly different station reading
 */
export function lockedBracketProbability(
  peakTempF: number,
  bracketLowF: number,
  bracketHighF: number,
): number {
  const loCut = isFinite(bracketLowF) ? bracketLowF - 0.5 : -Infinity;
  const hiCut = isFinite(bracketHighF) ? bracketHighF + 0.5 : Infinity;
  const inBracket = peakTempF >= loCut && peakTempF <= hiCut;
  return inBracket ? 0.98 : 0.02;
}
