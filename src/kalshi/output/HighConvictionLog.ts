/**
 * Shared high-conviction trade log.
 *
 * Both scanners (weather, whale) append to the same CSV so you can
 * sort/filter across strategies in Excel / pandas / duckdb.
 *
 * Schema (v1):
 *   timestamp       ISO8601 UTC
 *   strategy        "weather" | "whale"
 *   event_ticker    Kalshi event ticker (may be empty for whale hits)
 *   market_ticker   Kalshi market ticker
 *   side            "yes" | "no"
 *   yes_price       cents (1-99)
 *   size_contracts  suggested size, 0 if scanner-only
 *   conviction      strategy-specific 0..1-ish score
 *   edge_bps        basis points of estimated edge
 *   reason          human-readable one-liner
 *   metadata_json   strategy-specific JSON blob for later analysis
 *
 * Atomic: appends are line-buffered via fs.appendFileSync so a crash
 * mid-scan doesn't corrupt the CSV. We flush on every row since
 * scanner cadence is low (seconds, not microseconds).
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface HighConvictionRow {
  timestamp: string;
  strategy: "weather" | "whale";
  eventTicker: string;
  marketTicker: string;
  side: "yes" | "no";
  yesPrice: number;
  sizeContracts: number;
  conviction: number;
  edgeBps: number;
  reason: string;
  metadata: Record<string, unknown>;
}

const HEADER =
  "timestamp,strategy,event_ticker,market_ticker,side,yes_price,size_contracts,conviction,edge_bps,reason,metadata_json\n";

export class HighConvictionLog {
  constructor(private readonly path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, HEADER);
  }

  append(row: HighConvictionRow): void {
    // CSV for Excel / pandas analysis
    const line =
      [
        row.timestamp,
        row.strategy,
        row.eventTicker,
        row.marketTicker,
        row.side,
        row.yesPrice,
        row.sizeContracts,
        row.conviction,
        row.edgeBps,
        csvEscape(row.reason),
        csvEscape(JSON.stringify(row.metadata)),
      ].join(",") + "\n";
    appendFileSync(this.path, line);

    // JSONL for the web dashboard (same data, structured format)
    const jsonlPath = this.path.replace(/\.csv$/, ".jsonl");
    appendFileSync(jsonlPath, JSON.stringify(row) + "\n");
  }
}

function csvEscape(s: string): string {
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
