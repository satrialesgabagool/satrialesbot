/**
 * Kalshi Weather Market Finder
 *
 * Discovers active temperature markets on Kalshi and maps them
 * to the same WeatherMarket/TempBracket interface used by the simulator.
 *
 * Kalshi weather series use NHIGH (daily high) contracts:
 *   Series:  KXHIGHNY, KXHIGHCHI, KXHIGHMIA, etc.
 *   Events:  KXHIGHNY-26APR15 (one per city per day)
 *   Markets: KXHIGHNY-26APR15-T52 (one per temperature bracket)
 *
 * Each event has ~6 brackets: 4 middle (2°F wide) + 2 edge brackets.
 * Resolution: NWS Daily Climate Report.
 */

import { KalshiClient } from "./KalshiClient";
import { parseDollars, type KalshiEvent, type KalshiMarket } from "./types";
import type { WeatherMarket, TempBracket } from "../weather/WeatherMarketFinder";

// ─── Known Kalshi weather series ────────────────────────────────────

export interface KalshiWeatherCity {
  seriesTicker: string;
  city: string;
  lat: number;
  lon: number;
  /** NWS WFO code for resolution lookups */
  nwsWfo?: string;
}

/**
 * Known KXHIGH series tickers.
 * This list is expanded dynamically if unknown series are found.
 */
// Coordinates use the NWS Daily Climate Report station (airport ASOS), NOT city center.
// Kalshi resolves against this station's reading — forecasting for the wrong point
// introduces systematic bias (up to 2-5°F for coastal/elevation mismatches).
export const KALSHI_WEATHER_CITIES: KalshiWeatherCity[] = [
  { seriesTicker: "KXHIGHNY",  city: "New York City", lat: 40.7790, lon: -73.9692, nwsWfo: "okx" },  // Central Park (KNYC)
  { seriesTicker: "KXHIGHCHI", city: "Chicago",       lat: 41.7860, lon: -87.7524, nwsWfo: "lot" },  // Midway (KMDW)
  { seriesTicker: "KXHIGHMIA", city: "Miami",         lat: 25.7933, lon: -80.2906, nwsWfo: "mfl" },  // MIA (KMIA)
  { seriesTicker: "KXHIGHLAX", city: "Los Angeles",   lat: 33.9425, lon: -118.4081, nwsWfo: "lox" }, // LAX (KLAX)
  { seriesTicker: "KXHIGHAUS", city: "Austin",        lat: 30.1945, lon: -97.6699, nwsWfo: "ewx" },  // Bergstrom (KAUS)
  { seriesTicker: "KXHIGHDEN", city: "Denver",        lat: 39.8617, lon: -104.6732, nwsWfo: "bou" }, // DIA (KDEN)
  { seriesTicker: "KXHIGHATL", city: "Atlanta",       lat: 33.6367, lon: -84.4281, nwsWfo: "ffc" },  // Hartsfield (KATL)
  { seriesTicker: "KXHIGHDAL", city: "Dallas",        lat: 32.8968, lon: -97.0380, nwsWfo: "fwd" },  // DFW (KDFW)
  { seriesTicker: "KXHIGHSEA", city: "Seattle",       lat: 47.4490, lon: -122.3093, nwsWfo: "sew" }, // Sea-Tac (KSEA)
  { seriesTicker: "KXHIGHHOU", city: "Houston",       lat: 29.6454, lon: -95.2789, nwsWfo: "hgx" },  // Hobby (KHOU)
  { seriesTicker: "KXHIGHPHX", city: "Phoenix",       lat: 33.4343, lon: -112.0117, nwsWfo: "psr" }, // Sky Harbor (KPHX)
  { seriesTicker: "KXHIGHBOS", city: "Boston",        lat: 42.3631, lon: -71.0064, nwsWfo: "box" },  // Logan (KBOS)
  { seriesTicker: "KXHIGHLAS", city: "Las Vegas",     lat: 36.0803, lon: -115.1524, nwsWfo: "vef" }, // Reid (KLAS)
  { seriesTicker: "KXHIGHMIN", city: "Minneapolis",   lat: 44.8820, lon: -93.2218, nwsWfo: "mpx" },  // MSP (KMSP)
  { seriesTicker: "KXHIGHPHI", city: "Philadelphia",  lat: 39.8721, lon: -75.2407, nwsWfo: "phi" },  // PHL (KPHL)
  { seriesTicker: "KXHIGHSF",  city: "San Francisco", lat: 37.6188, lon: -122.3754, nwsWfo: "mtr" }, // SFO (KSFO)
  { seriesTicker: "KXHIGHSA",  city: "San Antonio",   lat: 29.5340, lon: -98.4691, nwsWfo: "ewx" },  // SAT (KSAT)
  { seriesTicker: "KXHIGHDC",  city: "Washington DC", lat: 38.8514, lon: -77.0377, nwsWfo: "lwx" },  // Reagan (KDCA)
];

/**
 * Daily-LOW temperature series — Kalshi uses a different naming pattern
 * than KXHIGH. The series prefix is `KXLOWT` (note the T) and several
 * city codes differ from their KXHIGH equivalents:
 *   KXHIGHNY  → KXLOWTNYC   (NY → NYC)
 *   KXHIGHLAS → KXLOWTLV    (LAS → LV)
 *   KXHIGHSF  → KXLOWTSFO   (SF → SFO)
 *   KXHIGHSA  → KXLOWTSATX  (SA → SATX)
 *   KXHIGHPHI → KXLOWTPHIL  (PHI → PHIL)
 * Other cities use the same code with the KXLOWT prefix.
 *
 * Note: Kalshi posts KXLOW events less consistently than KXHIGH (some
 * cities have 0 active events at any given time). The finder gracefully
 * handles empty series — they just contribute no candidate markets.
 */
export const KALSHI_WEATHER_LOW_CITIES: KalshiWeatherCity[] = [
  { seriesTicker: "KXLOWTNYC",  city: "New York City", lat: 40.7790, lon: -73.9692, nwsWfo: "okx" },
  { seriesTicker: "KXLOWTCHI",  city: "Chicago",       lat: 41.7860, lon: -87.7524, nwsWfo: "lot" },
  { seriesTicker: "KXLOWTMIA",  city: "Miami",         lat: 25.7933, lon: -80.2906, nwsWfo: "mfl" },
  { seriesTicker: "KXLOWTLAX",  city: "Los Angeles",   lat: 33.9425, lon: -118.4081, nwsWfo: "lox" },
  { seriesTicker: "KXLOWTAUS",  city: "Austin",        lat: 30.1945, lon: -97.6699, nwsWfo: "ewx" },
  { seriesTicker: "KXLOWTDEN",  city: "Denver",        lat: 39.8617, lon: -104.6732, nwsWfo: "bou" },
  { seriesTicker: "KXLOWTATL",  city: "Atlanta",       lat: 33.6367, lon: -84.4281, nwsWfo: "ffc" },
  { seriesTicker: "KXLOWTDAL",  city: "Dallas",        lat: 32.8968, lon: -97.0380, nwsWfo: "fwd" },
  { seriesTicker: "KXLOWTSEA",  city: "Seattle",       lat: 47.4490, lon: -122.3093, nwsWfo: "sew" },
  { seriesTicker: "KXLOWTHOU",  city: "Houston",       lat: 29.6454, lon: -95.2789, nwsWfo: "hgx" },
  { seriesTicker: "KXLOWTPHX",  city: "Phoenix",       lat: 33.4343, lon: -112.0117, nwsWfo: "psr" },
  { seriesTicker: "KXLOWTBOS",  city: "Boston",        lat: 42.3631, lon: -71.0064, nwsWfo: "box" },
  { seriesTicker: "KXLOWTLV",   city: "Las Vegas",     lat: 36.0803, lon: -115.1524, nwsWfo: "vef" },
  { seriesTicker: "KXLOWTMIN",  city: "Minneapolis",   lat: 44.8820, lon: -93.2218, nwsWfo: "mpx" },
  { seriesTicker: "KXLOWTPHIL", city: "Philadelphia",  lat: 39.8721, lon: -75.2407, nwsWfo: "phi" },
  { seriesTicker: "KXLOWTSFO",  city: "San Francisco", lat: 37.6188, lon: -122.3754, nwsWfo: "mtr" },
  { seriesTicker: "KXLOWTSATX", city: "San Antonio",   lat: 29.5340, lon: -98.4691, nwsWfo: "ewx" },
  { seriesTicker: "KXLOWTDC",   city: "Washington DC", lat: 38.8514, lon: -77.0377, nwsWfo: "lwx" },
  // Cities only available on the LOW series (no parallel KXHIGH)
  { seriesTicker: "KXLOWTOKC",  city: "Oklahoma City", lat: 35.3931, lon: -97.6007, nwsWfo: "oun" },
  { seriesTicker: "KXLOWTNOLA", city: "New Orleans",   lat: 29.9934, lon: -90.2580, nwsWfo: "lix" },
];

// Singleton client for market data (no auth needed)
let _client: KalshiClient | null = null;

function getClient(demo: boolean = false): KalshiClient {
  // For market data reads, use production API (demo may have different markets)
  if (!_client) {
    _client = new KalshiClient({ demo });
  }
  return _client;
}

// ─── Parse Kalshi market into TempBracket ───────────────────────────

function parseKalshiBracket(market: KalshiMarket): TempBracket | null {
  const yesAsk = parseDollars(market.yes_ask_dollars);
  const yesBid = parseDollars(market.yes_bid_dollars);
  const noAsk = parseDollars(market.no_ask_dollars);
  const noBid = parseDollars(market.no_bid_dollars);

  // Use mid price if both bid and ask exist, otherwise use ask
  const yesPrice = (yesBid > 0 && yesAsk > 0)
    ? (yesBid + yesAsk) / 2
    : yesAsk > 0 ? yesAsk : yesBid;
  const noPrice = 1 - yesPrice;

  if (yesPrice <= 0) return null;

  // Parse temperature bounds from yes_sub_title first (ground truth),
  // then fall back to floor_strike / cap_strike / strike_type.
  //
  // Kalshi convention (verified from API):
  //   strike_type=less,    cap=84         → title "83° or below" → highF = cap - 1
  //   strike_type=greater, floor=91       → title "92° or above" → lowF = floor + 1
  //   strike_type=between, floor=84 cap=85 → title "84° to 85°" → both inclusive
  let lowF: number;
  let highF: number;

  // Prefer parsing from the actual title text
  const fromTitle = parseBracketFromTitle(market.yes_sub_title);
  if (fromTitle) {
    lowF = fromTitle.lowF;
    highF = fromTitle.highF;
  } else {
    const strike = market.strike_type;
    const floor = market.floor_strike;
    const cap = market.cap_strike;

    if (strike === "less" || strike === "less_or_equal") {
      lowF = -Infinity;
      highF = (cap ?? NaN) - 1;  // Kalshi cap is exclusive: cap=84 → "83° or below"
    } else if (strike === "greater" || strike === "greater_or_equal") {
      lowF = (floor ?? NaN) + 1; // Kalshi floor is exclusive: floor=91 → "92° or above"
      highF = Infinity;
    } else if (strike === "between" && floor !== undefined && cap !== undefined) {
      lowF = floor;
      highF = cap;
    } else {
      return null;
    }
  }

  if (isNaN(lowF) && isNaN(highF)) return null;

  // Convert to Celsius
  const lowC = isFinite(lowF) ? Math.round(((lowF - 32) * 5) / 9 * 10) / 10 : lowF;
  const highC = isFinite(highF) ? Math.round(((highF - 32) * 5) / 9 * 10) / 10 : highF;

  return {
    question: market.yes_sub_title,
    slug: market.ticker,
    conditionId: market.ticker,           // Kalshi ticker serves as condition ID
    clobTokenIds: [market.ticker, ""],    // Kalshi uses ticker for both sides
    outcomePrices: [yesPrice, noPrice],
    lowF,
    highF,
    lowC,
    highC,
    endDate: market.close_time,
    volume: parseFloat(market.volume_fp) || 0,
    liquidity: parseFloat(market.open_interest_fp) || 0,
    // Kalshi-specific extras stored on the object
    _kalshiTicker: market.ticker,
    _yesBid: yesBid,
    _yesAsk: yesAsk,
    _yesBidSize: parseFloat(market.yes_bid_size_fp) || 0,
    _yesAskSize: parseFloat(market.yes_ask_size_fp) || 0,
    _status: market.status,
  } as TempBracket & Record<string, unknown>;
}

/**
 * Fallback: parse bracket bounds from the yes_sub_title text.
 * Handles "52°F or below", "88°F or higher", "80-81°F", etc.
 */
function parseBracketFromTitle(title: string): { lowF: number; highF: number } | null {
  // "52°F or below" / "52 or below"
  const belowMatch = title.match(/(\d+)\s*°?F?\s+or\s+(below|less)/i);
  if (belowMatch) return { lowF: -Infinity, highF: parseInt(belowMatch[1]) };

  // "88°F or higher" / "88 or higher"
  const aboveMatch = title.match(/(\d+)\s*°?F?\s+or\s+(higher|more|above)/i);
  if (aboveMatch) return { lowF: parseInt(aboveMatch[1]), highF: Infinity };

  // "80-81°F" / "80 to 81"
  const rangeMatch = title.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (rangeMatch) return { lowF: parseInt(rangeMatch[1]), highF: parseInt(rangeMatch[2]) };

  return null;
}

// ─── Parse event date from event_ticker ─────────────────────────────

/**
 * Extract date from Kalshi event ticker.
 * Format: KXHIGHNY-26APR15 → 2026-04-15
 */
function parseEventDate(eventTicker: string): string | null {
  // Match the date portion: 2-digit year + 3-letter month + 2-digit day
  const match = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;

  const year = 2000 + parseInt(match[1]);
  const monthMap: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04",
    MAY: "05", JUN: "06", JUL: "07", AUG: "08",
    SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const month = monthMap[match[2]];
  if (!month) return null;

  const day = match[3];
  return `${year}-${month}-${day}`;
}

/**
 * Extract city from event's series_ticker by matching known cities.
 */
function findCityForSeries(seriesTicker: string): KalshiWeatherCity | null {
  return KALSHI_WEATHER_CITIES.find(c => c.seriesTicker === seriesTicker) ?? null;
}

// ─── Main finder function ───────────────────────────────────────────

export interface FindKalshiWeatherOptions {
  /** Filter to specific city name */
  city?: string;
  /** How many days ahead to look (default 3) */
  daysAhead?: number;
  /** Use demo API (default false — demo may have fewer markets) */
  demo?: boolean;
  /** Also include daily-LOW temp markets (KXLOW*). Default false for back-compat. */
  includeLows?: boolean;
}

/**
 * Find active Kalshi weather markets and return them in the same
 * WeatherMarket/TempBracket format used by the simulator.
 */
export async function findKalshiWeatherMarkets(
  options?: FindKalshiWeatherOptions,
): Promise<WeatherMarket[]> {
  const client = getClient(options?.demo);
  const results: WeatherMarket[] = [];

  // Determine which series to query
  let seriesToQuery = options?.includeLows
    ? [...KALSHI_WEATHER_CITIES, ...KALSHI_WEATHER_LOW_CITIES]
    : KALSHI_WEATHER_CITIES;
  if (options?.city) {
    seriesToQuery = seriesToQuery.filter(
      c => c.city.toLowerCase().includes(options!.city!.toLowerCase())
    );
  }

  // Fetch events in batches of 5 to stay under Kalshi's 20/sec rate limit.
  // Each request includes nested markets, so they're heavier than simple GETs.
  const BATCH_SIZE = 5;
  const allResults: { cityInfo: KalshiWeatherCity; events: KalshiEvent[] }[] = [];

  for (let i = 0; i < seriesToQuery.length; i += BATCH_SIZE) {
    const batch = seriesToQuery.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (cityInfo) => {
        try {
          const res = await client.getEvents({
            series_ticker: cityInfo.seriesTicker,
            with_nested_markets: true,
            limit: 5, // only need recent events
          });
          return { cityInfo, events: res.events };
        } catch {
          return { cityInfo, events: [] as KalshiEvent[] };
        }
      })
    );
    allResults.push(...batchResults);

    // Small pause between batches to respect rate limits
    if (i + BATCH_SIZE < seriesToQuery.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  for (const { cityInfo, events } of allResults) {
    for (const event of events) {
      const date = parseEventDate(event.event_ticker);
      if (!date) continue;

      // Filter by days ahead
      if (options?.daysAhead !== undefined) {
        const eventDate = new Date(date + "T00:00:00");
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + options.daysAhead);
        if (eventDate > maxDate) continue;
      }

      // Parse nested markets into brackets
      const brackets: TempBracket[] = [];
      const markets = event.markets ?? [];

      for (const market of markets) {
        if (market.status !== "active" && market.status !== "determined") continue;
        const bracket = parseKalshiBracket(market);
        if (bracket) brackets.push(bracket);
      }

      if (brackets.length === 0) continue;

      // Sort brackets by lower bound
      brackets.sort((a, b) => {
        const aLow = isFinite(a.lowF) ? a.lowF : -999;
        const bLow = isFinite(b.lowF) ? b.lowF : -999;
        return aLow - bLow;
      });

      // Find close time from first market
      const closeTime = markets[0]?.close_time ?? event.strike_date ?? "";

      // Detect KXHIGH vs KXLOW from the event ticker; brackets and bot logic
      // are otherwise identical.
      const marketType: "high" | "low" = event.event_ticker.startsWith("KXLOW") ? "low" : "high";

      results.push({
        eventId: event.event_ticker,
        title: event.title,
        slug: event.event_ticker,
        city: cityInfo.city,
        date,
        endDate: closeTime,
        brackets,
        unit: "F",
        type: marketType,
      });
    }
  }

  // Sort by date, then city
  results.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    return dateCmp !== 0 ? dateCmp : a.city.localeCompare(b.city);
  });

  return results;
}

/**
 * Get coordinates for a Kalshi weather city (for forecast lookups).
 */
export function getKalshiCityCoords(city: string): { lat: number; lon: number } | null {
  const match = KALSHI_WEATHER_CITIES.find(
    c => c.city.toLowerCase() === city.toLowerCase()
  );
  return match ? { lat: match.lat, lon: match.lon } : null;
}
