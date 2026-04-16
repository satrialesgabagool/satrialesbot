/**
 * Discovers Kalshi Bitcoin markets — their series, event cadence,
 * strike structure, and liquidity.
 *
 * Kalshi BTC markets run on several series tickers. The ones we care
 * about are short-horizon binary markets (hourly / multi-hour range
 * or "above/below" markets) that resemble Polymarket's 5m/15m Up-Down
 * format as closely as possible.
 *
 * Run directly:
 *   bun run src/kalshi/KalshiBTCFinder.ts
 */

import { KalshiClient } from "./KalshiClient";
import {
  parseDollars,
  parseCount,
  type KalshiEvent,
  type KalshiMarket,
} from "./types";

// Known BTC series tickers on Kalshi. We'll probe each and see which
// actually return events. The naming has evolved over time:
//   KXBTCD     = BTC daily close
//   KXBTC      = generic BTC
//   KXBTCRES   = BTC reserves markets
//   KXBTCMAX   = BTC high within period
//   KXBTCMIN   = BTC low within period
//   KXBTCWEEK  = weekly BTC settlement
//   KXBTCH     = hourly BTC (the one closest to our use case)
// If the API replies empty for any of these, we skip it.
const BTC_SERIES_CANDIDATES = [
  "KXBTC",
  "KXBTCD",
  "KXBTCH",
  "KXBTCHR",
  "KXBTCMAX",
  "KXBTCMIN",
  "KXBTCRES",
  "KXBTCWEEK",
  "KXBTCINTRO",
  "KXBTCSURGE",
];

interface SeriesSummary {
  series: string;
  eventCount: number;
  openEventCount: number;
  sampleEvent?: KalshiEvent;
  sampleMarkets?: KalshiMarket[];
  shortestHorizonMin?: number;
  strikeTypes?: Set<string>;
  totalVolume24h?: number;
  totalOpenInterest?: number;
}

function minutesUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.round((ts - Date.now()) / 60_000);
}

async function inspectSeries(client: KalshiClient, series: string): Promise<SeriesSummary | null> {
  try {
    // First pull OPEN events with nested markets — that's the live book
    const openRes = await client.getEvents({
      series_ticker: series,
      status: "open",
      with_nested_markets: true,
      limit: 50,
    });
    const allRes = await client.getEvents({
      series_ticker: series,
      limit: 5,
    });

    const eventCount = allRes.events.length;
    const openEvents = openRes.events;

    if (eventCount === 0 && openEvents.length === 0) return null;

    const sample = openEvents[0] ?? allRes.events[0];
    const sampleMarkets = sample?.markets ?? [];

    // Compute shortest horizon across OPEN events
    const horizons: number[] = [];
    for (const e of openEvents) {
      for (const m of e.markets ?? []) {
        const mins = minutesUntil(m.close_time);
        if (mins !== null && mins > 0) horizons.push(mins);
      }
    }

    // Aggregate volume / OI
    let volume24h = 0;
    let oi = 0;
    const strikes = new Set<string>();
    for (const e of openEvents) {
      for (const m of e.markets ?? []) {
        volume24h += parseCount(m.volume_24h_fp);
        oi += parseCount(m.open_interest_fp);
        if (m.strike_type) strikes.add(m.strike_type);
      }
    }

    return {
      series,
      eventCount,
      openEventCount: openEvents.length,
      sampleEvent: sample,
      sampleMarkets: sampleMarkets.slice(0, 6),
      shortestHorizonMin: horizons.length ? Math.min(...horizons) : undefined,
      strikeTypes: strikes,
      totalVolume24h: volume24h,
      totalOpenInterest: oi,
    };
  } catch (err) {
    return null;
  }
}

function formatMarket(m: KalshiMarket): string {
  const yesBid = parseDollars(m.yes_bid_dollars);
  const yesAsk = parseDollars(m.yes_ask_dollars);
  const mins = minutesUntil(m.close_time);
  const spread = yesAsk - yesBid;
  return [
    `    ${m.ticker.padEnd(42)}`,
    `yes=${yesBid.toFixed(2)}/${yesAsk.toFixed(2)}`,
    `(spread=${spread.toFixed(2)})`,
    `vol24h=${parseCount(m.volume_24h_fp).toFixed(0)}`,
    `oi=${parseCount(m.open_interest_fp).toFixed(0)}`,
    mins !== null ? `closes=${mins}m` : "",
    m.strike_type ? `[${m.strike_type}]` : "",
  ].join(" ");
}

async function main() {
  const a = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
    cyan: "\x1b[36m", magenta: "\x1b[35m",
  };

  console.log(`\n${a.cyan}${a.bold}  KALSHI BTC MARKET SURVEY${a.reset}\n`);

  // Production = read-only, no auth needed for events/markets
  const client = new KalshiClient({ demo: false });
  console.log(`  ${a.dim}Environment: ${client.environment}${a.reset}\n`);

  const summaries: SeriesSummary[] = [];
  for (const series of BTC_SERIES_CANDIDATES) {
    process.stdout.write(`  probing ${series.padEnd(14)} … `);
    const summary = await inspectSeries(client, series);
    if (!summary) {
      console.log(`${a.dim}no events${a.reset}`);
      continue;
    }
    console.log(
      `${a.green}${summary.openEventCount} open${a.reset}, ` +
      `${summary.eventCount} total, ` +
      `vol24h=${(summary.totalVolume24h ?? 0).toFixed(0)}, ` +
      `oi=${(summary.totalOpenInterest ?? 0).toFixed(0)}, ` +
      `min-horizon=${summary.shortestHorizonMin ?? "—"}m`,
    );
    summaries.push(summary);
  }

  if (summaries.length === 0) {
    console.log(`\n  ${a.red}No BTC series found. Kalshi may have renamed them or the API is rate-limiting.${a.reset}\n`);
    return;
  }

  // Deep dive into each live series
  for (const s of summaries) {
    if (s.openEventCount === 0) continue;
    console.log(`\n${a.bold}  ▸ ${s.series}${a.reset}  ${a.dim}${s.sampleEvent?.title ?? ""}${a.reset}`);
    console.log(
      `    events: ${s.openEventCount} open / ${s.eventCount} total  ` +
      `strikes: ${Array.from(s.strikeTypes ?? []).join(", ")}  ` +
      `vol24h=${s.totalVolume24h?.toFixed(0)}  oi=${s.totalOpenInterest?.toFixed(0)}`,
    );
    if (s.sampleEvent) {
      console.log(`    sample event: ${s.sampleEvent.event_ticker}`);
      console.log(`    strike_date: ${s.sampleEvent.strike_date ?? "—"}`);
    }
    for (const m of s.sampleMarkets ?? []) {
      console.log(formatMarket(m));
    }
  }

  // Summary: which series is best for sniping?
  console.log(`\n${a.bold}  SNIPE-SUITABILITY RANKING${a.reset}`);
  console.log(`  (shortest horizon with real liquidity = best snipe target)\n`);

  const ranked = summaries
    .filter(s => s.openEventCount > 0 && (s.shortestHorizonMin ?? Infinity) < 24 * 60)
    .sort((a, b) => {
      const liqA = (a.totalVolume24h ?? 0) + (a.totalOpenInterest ?? 0);
      const liqB = (b.totalVolume24h ?? 0) + (b.totalOpenInterest ?? 0);
      return liqB - liqA;
    });

  for (const s of ranked) {
    const liq = (s.totalVolume24h ?? 0) + (s.totalOpenInterest ?? 0);
    const rating =
      liq > 5000 ? `${a.green}GOOD${a.reset}` :
      liq > 500 ? `${a.yellow}THIN${a.reset}` :
      `${a.red}DEAD${a.reset}`;
    console.log(
      `  ${s.series.padEnd(14)}  ${rating}  ` +
      `horizon≥${s.shortestHorizonMin}m  liquidity=${liq.toFixed(0)}  ` +
      `${s.openEventCount} live events`,
    );
  }

  console.log();
}

main().catch(err => {
  console.error(`FATAL: ${err}`);
  process.exit(1);
});
