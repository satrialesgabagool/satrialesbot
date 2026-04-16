#!/usr/bin/env bun
/**
 * Satriales · Kalshi BTC Tape Collector — TypeScript entry point.
 *
 * Archives every anonymous fill on settled KXBTCD / KXBTC markets into
 * kalshi_tape.db for post-hoc analysis. Idempotent: re-runs skip
 * already-collected markets.
 *
 * Usage:
 *   bun run kalshi-tape-collect.ts                       # 24h default
 *   bun run kalshi-tape-collect.ts --hours 48 --min-volume 500
 *   bun run kalshi-tape-collect.ts --dry-run             # print plan only
 *   bun run kalshi-tape-collect.ts --force               # re-collect all
 *   bun run kalshi-tape-collect.ts --series KXBTCD       # single series
 *
 * Runs against production Kalshi market data. No auth needed (tape is
 * public), but the request-throttle is conservative (150ms) to keep us
 * under rate limits even on long runs.
 */

import { KalshiClient } from "./src/kalshi/KalshiClient";
import { TapeDB } from "./src/storage/TapeDB";
import { TapeCollector, DEFAULT_SERIES } from "./src/tape/TapeCollector";

const args = process.argv.slice(2);

function hasFlag(n: string): boolean { return args.includes(n); }
function argVal<T>(flag: string, parse: (s: string) => T, fallback: T): T {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v == null ? fallback : parse(v);
}
function allArgs(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
}

const HOURS      = argVal("--hours",      parseFloat, 24);
const MIN_VOLUME = argVal("--min-volume", parseFloat, 100);
const DRY_RUN    = hasFlag("--dry-run");
const FORCE      = hasFlag("--force");
const DB_PATH    = argVal("--db",         (s) => s,   "kalshi_tape.db");
const THROTTLE   = argVal("--throttle",   parseInt,   150);
const SERIES     = (() => {
  const s = allArgs("--series");
  return s.length ? s : (DEFAULT_SERIES as readonly string[]);
})();

async function main(): Promise<void> {
  // Production Kalshi — no creds needed for public tape data
  const client = new KalshiClient({ demo: false });
  const db = new TapeDB(DB_PATH);

  const collector = new TapeCollector(client, db, {
    interRequestDelayMs: THROTTLE,
  });

  try {
    const summary = await collector.run({
      hoursBack: HOURS,
      minVolume: MIN_VOLUME,
      dryRun: DRY_RUN,
      force: FORCE,
      series: SERIES,
    });

    // Non-zero exit on failures so cron/CI can alert
    if (summary.nFailures > 0 && !DRY_RUN) {
      process.exit(2);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[kalshi-tape-collect] fatal:", err);
  process.exit(1);
});
