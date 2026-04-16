#!/usr/bin/env bun
/**
 * Satriales · Kalshi BTC Tape Analyzer — TypeScript entry point.
 *
 * Reads kalshi_tape.db and prints taker-side PnL bucketed by time-to-
 * close, price, size, strike_type, and a time×price cross-tab. Use
 * --bot-compare to also print the bot's own trades vs tape baseline.
 *
 * Usage:
 *   bun run kalshi-tape-report.ts
 *   bun run kalshi-tape-report.ts --bot-compare
 *   bun run kalshi-tape-report.ts --db kalshi_tape.db --bot-db kalshi_snipe.db
 *   bun run kalshi-tape-report.ts --out kalshi_tape_report.txt
 */

import { TapeAnalyzer } from "./src/tape/TapeAnalyzer";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
function hasFlag(n: string): boolean { return args.includes(n); }
function argVal<T>(flag: string, parse: (s: string) => T, fallback: T): T {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v == null ? fallback : parse(v);
}

const DB      = argVal("--db",     (s) => s, "kalshi_tape.db");
const BOT_DB  = argVal("--bot-db", (s) => s, "kalshi_snipe.db");
const COMPARE = hasFlag("--bot-compare");
const OUT     = argVal("--out",    (s) => s, "");

async function main(): Promise<void> {
  const buf: string[] = [];
  const capture = (s: string) => { buf.push(s); if (!OUT) console.log(s); };

  const analyzer = new TapeAnalyzer(DB, { log: capture });
  try {
    analyzer.printFullReport({ botDbPath: COMPARE ? BOT_DB : undefined });
  } finally {
    analyzer.close();
  }

  if (OUT) {
    writeFileSync(OUT, buf.join("\n"), "utf-8");
    console.log(`Wrote report to ${OUT} (${buf.length} lines)`);
  }
}

main().catch((err) => {
  console.error("[kalshi-tape-report] fatal:", err);
  process.exit(1);
});
