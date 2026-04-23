/**
 * Kalshi Weather Tape Collector.
 *
 * Pulls all resolved KXHIGH (daily high temperature) markets from the past N days
 * and every trade on every market. Writes to a JSON tape file for replay analysis.
 *
 * For each trade we store:
 *   - ticker (the bracket)
 *   - event_ticker (the city+date)
 *   - taker_side (yes or no)
 *   - price, size, timestamp
 *   - market result (yes = winner, no = loser) — known because event has resolved
 *
 * Reconstruction at scan time:
 *   - "What did the market look like 24h before close?" → use last trade before that moment
 *   - "What would a $3 order have cost?" → walk the order book snapshot (if we have one)
 *     or fall back to last-traded price
 *
 * Output: data/kalshi-weather-tape.json
 */

import { KalshiClient } from "./KalshiClient";
import { KALSHI_WEATHER_CITIES } from "./KalshiWeatherFinder";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export interface TapeTrade {
  trade_id?: string;
  ticker: string;              // e.g. KXHIGHAUS-26APR19-B71.5
  event_ticker: string;         // e.g. KXHIGHAUS-26APR19
  created_time: string;         // ISO
  taker_side: "yes" | "no";
  count: number;
  yes_price: number;            // DOLLARS (0.01-0.99)
  no_price: number;             // DOLLARS
}

export interface TapeMarket {
  ticker: string;
  event_ticker: string;
  yes_sub_title?: string;
  floor_strike?: number;
  cap_strike?: number;
  status: string;
  result?: "yes" | "no" | string;
  close_time?: string;
  expiration_time?: string;
  volume?: number;
}

export interface TapeEvent {
  event_ticker: string;
  series_ticker?: string;
  city?: string;           // derived from series lookup
  date?: string;           // derived from event ticker suffix
  title?: string;
  strike_date?: string;
  markets: TapeMarket[];
}

export interface Tape {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  seriesScanned: string[];
  events: TapeEvent[];
  trades: TapeTrade[];
  summary: {
    eventsTotal: number;
    marketsTotal: number;
    tradesTotal: number;
    byCity: Record<string, { events: number; markets: number; trades: number }>;
  };
}

export interface CollectorOptions {
  daysBack: number;          // how many days of history to pull
  client: KalshiClient;
  outputPath: string;
  log?: (msg: string) => void;
  onProgress?: (pct: number, msg: string) => void;
}

/** Extract the YYYYMMDD date from an event ticker like "KXHIGHAUS-26APR19" → "2026-04-19" */
function parseEventDate(eventTicker: string): string | null {
  const m = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const [, yy, monStr, dd] = m;
  const months: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const mm = months[monStr];
  if (!mm) return null;
  return `20${yy}-${mm}-${dd}`;
}

export async function collectWeatherTape(opts: CollectorOptions): Promise<Tape> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { client, daysBack, outputPath } = opts;

  // Time window: past N days ending now (include all resolved events)
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - daysBack * 86400;
  const windowStartIso = new Date(windowStart * 1000).toISOString();
  const windowEndIso = new Date(now * 1000).toISOString();

  log(`Collecting tape from ${windowStartIso} to ${windowEndIso} (past ${daysBack} days)`);

  const allEvents: TapeEvent[] = [];
  const allTrades: TapeTrade[] = [];

  for (const cityEntry of KALSHI_WEATHER_CITIES) {
    log(`  Scanning ${cityEntry.seriesTicker} (${cityEntry.city})...`);

    // Get all events in window, both settled and open
    let events: any[] = [];
    let cursor: string | undefined;
    let page = 0;
    do {
      const res = await client.getEvents({
        series_ticker: cityEntry.seriesTicker,
        limit: 200,
        cursor,
        with_nested_markets: true,
      } as any);
      events.push(...(res.events ?? []));
      cursor = (res as any).cursor || undefined;
      page++;
    } while (cursor && page < 10);

    // Filter to events whose date falls within our window
    events = events.filter((e: any) => {
      const d = parseEventDate(e.event_ticker ?? "");
      if (!d) return false;
      const ts = new Date(d + "T23:59:59Z").getTime() / 1000;
      return ts >= windowStart && ts <= now;
    });

    log(`    Found ${events.length} events in window`);

    for (const ev of events) {
      const markets = ev.markets ?? [];
      const date = parseEventDate(ev.event_ticker) ?? "unknown";

      const tapeEvent: TapeEvent = {
        event_ticker: ev.event_ticker,
        series_ticker: ev.series_ticker,
        city: cityEntry.city,
        date,
        title: ev.title,
        strike_date: ev.strike_date,
        markets: markets.map((m: any): TapeMarket => ({
          ticker: m.ticker,
          event_ticker: ev.event_ticker,
          yes_sub_title: m.yes_sub_title,
          floor_strike: m.floor_strike,
          cap_strike: m.cap_strike,
          status: m.status,
          result: m.result,
          close_time: m.close_time,
          expiration_time: m.expiration_time,
          volume: parseFloat(m.volume_fp ?? "0"),
        })),
      };
      allEvents.push(tapeEvent);

      // Pull trades for each market in this event
      for (const m of markets) {
        if (m.status !== "finalized" && m.status !== "settled") continue;  // only completed markets
        try {
          const trades = await client.getAllTrades({
            ticker: m.ticker,
            min_ts: windowStart,
            max_ts: now,
            maxPages: 20,
          });
          for (const t of trades) {
            allTrades.push({
              trade_id: t.trade_id,
              ticker: m.ticker,
              event_ticker: ev.event_ticker,
              created_time: t.created_time,
              taker_side: t.taker_side,
              count: parseFloat(t.count_fp ?? t.count ?? "0"),
              // Kalshi returns these as string dollars e.g. "0.0100"
              yes_price: parseFloat(t.yes_price_dollars ?? "0"),
              no_price: parseFloat(t.no_price_dollars ?? "0"),
            });
          }
        } catch (err: any) {
          log(`      Trade fetch failed for ${m.ticker}: ${err?.message}`);
        }
      }
    }
  }

  // Build summary stats
  const byCity: Record<string, { events: number; markets: number; trades: number }> = {};
  for (const ev of allEvents) {
    const city = ev.city ?? "?";
    byCity[city] ??= { events: 0, markets: 0, trades: 0 };
    byCity[city].events++;
    byCity[city].markets += ev.markets.length;
  }
  for (const t of allTrades) {
    const ev = allEvents.find(e => e.event_ticker === t.event_ticker);
    const city = ev?.city ?? "?";
    byCity[city] ??= { events: 0, markets: 0, trades: 0 };
    byCity[city].trades++;
  }

  const tape: Tape = {
    generatedAt: new Date().toISOString(),
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    seriesScanned: KALSHI_WEATHER_CITIES.map(c => c.seriesTicker),
    events: allEvents,
    trades: allTrades,
    summary: {
      eventsTotal: allEvents.length,
      marketsTotal: allEvents.reduce((s, e) => s + e.markets.length, 0),
      tradesTotal: allTrades.length,
      byCity,
    },
  };

  // Write to disk
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(tape, null, 2));
  log(`\nTape written to ${outputPath}`);
  log(`  Events: ${tape.summary.eventsTotal}`);
  log(`  Markets: ${tape.summary.marketsTotal}`);
  log(`  Trades: ${tape.summary.tradesTotal}`);
  log(`  Size: ${(JSON.stringify(tape).length / 1024 / 1024).toFixed(1)} MB`);

  return tape;
}
