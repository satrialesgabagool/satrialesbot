/**
 * Kalshi weather-market finder.
 *
 * Kalshi organizes daily temperature contracts as "series" with
 * date-dated events, each containing multiple mutually-exclusive
 * markets (brackets). Series patterns observed on Kalshi:
 *
 *   KXHIGHNY  — NYC daily high temperature
 *   KXHIGHLAX — LAX daily high
 *   KXHIGHCHI — Chicago daily high
 *   KXHIGHMIA — Miami daily high
 *   KXHIGHAUS — Austin daily high
 *   KXHIGHDEN — Denver daily high
 *   KXHIGHPHI — Philadelphia daily high
 *   KXHIGHBOS — Boston daily high
 *   KXLOWNY   — NYC daily low (equivalent series exist per city)
 *
 * Note: Kalshi does rename/add series over time. Patterns above may
 * shift — the finder accepts a configurable list so we can update
 * without touching anything downstream.
 *
 * A "bracket" market's strike is carried on the market object as
 * `floor_strike` / `cap_strike` (°F). Open-ended tail brackets use
 * only one side (e.g. `cap_strike` present, `floor_strike` missing
 * → "below X°F").
 */

import type { KalshiClient } from "../client/KalshiClient";
import type { KalshiEvent, KalshiMarket } from "../client/types";

export interface WeatherBracket {
  marketTicker: string;
  eventTicker: string;
  title: string;
  lowF: number; // -Infinity for open tail
  highF: number; // +Infinity for open tail
  yesAsk: number; // cents (100 if no ask)
  yesBid: number; // cents
  volume24h: number;
  liquidity: number;
  closeTime: string; // ISO8601
}

export interface WeatherEvent {
  eventTicker: string;
  seriesTicker: string;
  title: string;
  city: string;
  type: "high" | "low";
  resolveDate: string; // YYYY-MM-DD in resolution timezone
  closeTime: string;
  brackets: WeatherBracket[];
}

/** Default list of weather series to scan. Override via ctor options. */
export const DEFAULT_WEATHER_SERIES: { ticker: string; city: string; type: "high" | "low" }[] = [
  { ticker: "KXHIGHNY", city: "nyc", type: "high" },
  { ticker: "KXHIGHLAX", city: "lax", type: "high" },
  { ticker: "KXHIGHCHI", city: "chi", type: "high" },
  { ticker: "KXHIGHMIA", city: "mia", type: "high" },
  { ticker: "KXHIGHAUS", city: "aus", type: "high" },
  { ticker: "KXHIGHDEN", city: "den", type: "high" },
  { ticker: "KXHIGHPHI", city: "phi", type: "high" },
  { ticker: "KXHIGHBOS", city: "bos", type: "high" },
  { ticker: "KXLOWNY", city: "nyc", type: "low" },
];

export interface WeatherMarketFinderOptions {
  series?: { ticker: string; city: string; type: "high" | "low" }[];
}

export class WeatherMarketFinder {
  private readonly series: { ticker: string; city: string; type: "high" | "low" }[];

  constructor(
    private readonly client: KalshiClient,
    opts: WeatherMarketFinderOptions = {},
  ) {
    this.series = opts.series ?? DEFAULT_WEATHER_SERIES;
  }

  async findActive(): Promise<WeatherEvent[]> {
    const out: WeatherEvent[] = [];

    for (const s of this.series) {
      try {
        const events: KalshiEvent[] = [];
        for await (const e of this.client.paginateEvents({
          seriesTicker: s.ticker,
          status: "open",
          withNestedMarkets: true,
        })) {
          events.push(e);
        }

        for (const ev of events) {
          const markets = (ev.markets ?? []).filter((m) => m.status === "active");
          if (markets.length === 0) continue;

          const brackets = markets.map(marketToBracket).filter((b): b is WeatherBracket => !!b);
          if (brackets.length === 0) continue;

          out.push({
            eventTicker: ev.event_ticker,
            seriesTicker: ev.series_ticker,
            title: ev.title,
            city: s.city,
            type: s.type,
            resolveDate: inferResolveDate(ev, markets),
            closeTime: markets[0].close_time,
            brackets,
          });
        }
      } catch (err) {
        // Soft-fail per series so one outage doesn't kill the whole scan.
        console.warn(`[WeatherMarketFinder] series ${s.ticker} failed:`, (err as Error).message);
      }
    }

    return out;
  }
}

function marketToBracket(m: KalshiMarket): WeatherBracket | null {
  const lowF = m.floor_strike !== undefined ? m.floor_strike : -Infinity;
  const highF = m.cap_strike !== undefined ? m.cap_strike : Infinity;
  if (lowF === -Infinity && highF === Infinity) return null;
  return {
    marketTicker: m.ticker,
    eventTicker: m.event_ticker,
    title: m.title,
    lowF,
    highF,
    yesAsk: m.yes_ask > 0 ? m.yes_ask : 100,
    yesBid: m.yes_bid,
    volume24h: m.volume_24h,
    liquidity: m.liquidity,
    closeTime: m.close_time,
  };
}

function inferResolveDate(ev: KalshiEvent, markets: KalshiMarket[]): string {
  if (ev.strike_date) return ev.strike_date.slice(0, 10);
  // Fall back to close_time date.
  return markets[0].close_time.slice(0, 10);
}
