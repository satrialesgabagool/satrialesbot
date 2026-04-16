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

  /**
   * Scan all configured series for active weather events.
   *
   * Rate limiting: Kalshi basic tier allows ~20 reads/sec. We batch
   * series in groups of BATCH_SIZE with BATCH_PAUSE_MS between batches
   * to stay well under the limit (matches feig's approach).
   */
  async findActive(): Promise<WeatherEvent[]> {
    const out: WeatherEvent[] = [];
    const BATCH_SIZE = 5;
    const BATCH_PAUSE_MS = 300;

    for (let i = 0; i < this.series.length; i += BATCH_SIZE) {
      if (i > 0) await sleep(BATCH_PAUSE_MS);

      const batch = this.series.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((s) => this.fetchSeriesEvents(s)),
      );

      for (const events of batchResults) {
        out.push(...events);
      }
    }

    return out;
  }

  private async fetchSeriesEvents(
    s: { ticker: string; city: string; type: "high" | "low" },
  ): Promise<WeatherEvent[]> {
    const out: WeatherEvent[] = [];
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
    return out;
  }
}

function marketToBracket(m: KalshiMarket): WeatherBracket | null {
  // Kalshi strike convention: strikes are EXCLUSIVE boundaries.
  //   strike_type="less"    + cap_strike=84   → actual bracket ≤ 83°F (cap exclusive)
  //   strike_type="greater" + floor_strike=91  → actual bracket ≥ 92°F (floor exclusive)
  //   strike_type="between" + floor=83, cap=86 → actual bracket 84–85°F (both exclusive)
  // Ref: feig branch already corrected for this; see PR review feedback.

  let lowF: number;
  let highF: number;
  const st = m.strike_type ?? "";

  if (st === "less" || (m.cap_strike !== undefined && m.floor_strike === undefined)) {
    // Tail-low bracket: "X°F or below" — cap is exclusive upper bound
    lowF = -Infinity;
    highF = m.cap_strike !== undefined ? m.cap_strike - 1 : Infinity;
  } else if (st === "greater" || (m.floor_strike !== undefined && m.cap_strike === undefined)) {
    // Tail-high bracket: "X°F or above" — floor is exclusive lower bound
    lowF = m.floor_strike !== undefined ? m.floor_strike + 1 : -Infinity;
    highF = Infinity;
  } else if (m.floor_strike !== undefined && m.cap_strike !== undefined) {
    // Middle bracket: "X–Y°F" — both strikes exclusive
    lowF = m.floor_strike + 1;
    highF = m.cap_strike - 1;
  } else {
    return null; // no usable strike data
  }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferResolveDate(ev: KalshiEvent, markets: KalshiMarket[]): string {
  if (ev.strike_date) return ev.strike_date.slice(0, 10);
  // Fall back to close_time date.
  return markets[0].close_time.slice(0, 10);
}
