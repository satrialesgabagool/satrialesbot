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
export const KALSHI_WEATHER_CITIES: KalshiWeatherCity[] = [
  { seriesTicker: "KXHIGHNY",  city: "New York City", lat: 40.7128, lon: -74.0060, nwsWfo: "okx" },
  { seriesTicker: "KXHIGHCHI", city: "Chicago",       lat: 41.8781, lon: -87.6298, nwsWfo: "lot" },
  { seriesTicker: "KXHIGHMIA", city: "Miami",         lat: 25.7617, lon: -80.1918, nwsWfo: "mfl" },
  { seriesTicker: "KXHIGHLAX", city: "Los Angeles",   lat: 34.0522, lon: -118.2437, nwsWfo: "lox" },
  { seriesTicker: "KXHIGHAUS", city: "Austin",        lat: 30.2672, lon: -97.7431, nwsWfo: "ewx" },
  { seriesTicker: "KXHIGHDEN", city: "Denver",        lat: 39.7392, lon: -104.9903, nwsWfo: "bou" },
  { seriesTicker: "KXHIGHATL", city: "Atlanta",       lat: 33.7490, lon: -84.3880, nwsWfo: "ffc" },
  { seriesTicker: "KXHIGHDAL", city: "Dallas",        lat: 32.7767, lon: -96.7970, nwsWfo: "fwd" },
  { seriesTicker: "KXHIGHSEA", city: "Seattle",       lat: 47.6062, lon: -122.3321, nwsWfo: "sew" },
  { seriesTicker: "KXHIGHHOU", city: "Houston",       lat: 29.7604, lon: -95.3698, nwsWfo: "hgx" },
  { seriesTicker: "KXHIGHPHX", city: "Phoenix",       lat: 33.4484, lon: -112.0740, nwsWfo: "psr" },
  { seriesTicker: "KXHIGHBOS", city: "Boston",        lat: 42.3601, lon: -71.0589, nwsWfo: "box" },
  { seriesTicker: "KXHIGHLAS", city: "Las Vegas",     lat: 36.1699, lon: -115.1398, nwsWfo: "vef" },
  { seriesTicker: "KXHIGHMIN", city: "Minneapolis",   lat: 44.9778, lon: -93.2650, nwsWfo: "mpx" },
  { seriesTicker: "KXHIGHPHI", city: "Philadelphia",  lat: 39.9526, lon: -75.1652, nwsWfo: "phi" },
  { seriesTicker: "KXHIGHSF",  city: "San Francisco", lat: 37.7749, lon: -122.4194, nwsWfo: "mtr" },
  { seriesTicker: "KXHIGHSA",  city: "San Antonio",   lat: 29.4241, lon: -98.4936, nwsWfo: "ewx" },
  { seriesTicker: "KXHIGHDC",  city: "Washington DC", lat: 38.9072, lon: -77.0369, nwsWfo: "lwx" },
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
  let seriesToQuery = KALSHI_WEATHER_CITIES;
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

      results.push({
        eventId: event.event_ticker,
        title: event.title,
        slug: event.event_ticker,
        city: cityInfo.city,
        date,
        endDate: closeTime,
        brackets,
        unit: "F",
        type: "high",   // Kalshi KXHIGH = daily high temp
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
