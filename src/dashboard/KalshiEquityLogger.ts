/**
 * Periodically snapshots Kalshi cash + portfolio value to a CSV so the
 * dashboard can draw a ground-truth equity curve across bot restarts.
 *
 * - Runs in-process with the dashboard (long-running anyway).
 * - Safe to run alongside the bots; both can read Kalshi, no coordination needed.
 * - Gracefully no-ops if the Kalshi client is null or the API errors —
 *   this is diagnostic telemetry, not trading.
 * - Append-only CSV; safe across restarts. Read side sorts by timestamp.
 *
 * CSV schema: timestamp_iso,cash_usd,portfolio_value_usd
 */

import { KalshiClient } from "../kalshi/KalshiClient";
import { existsSync, appendFileSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";

export interface EquitySnapshot {
  t: string;
  cashUSD: number;
  portfolioValueUSD: number;
}

export interface EquityLogger {
  start(): void;
  stop(): void;
  readSeries(): EquitySnapshot[];
}

export function createEquityLogger(opts: {
  client: KalshiClient | null;
  csvPath: string;
  intervalMs: number;
  log?: (msg: string) => void;
}): EquityLogger {
  const { client, csvPath, intervalMs, log = () => {} } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSampleAt = 0;

  async function snapshot() {
    if (!client) return;
    // Safety: never sample faster than intervalMs (in case of manual re-entry)
    if (Date.now() - lastSampleAt < intervalMs - 1000) return;
    try {
      const bal = await client.getBalance();
      const cash = (bal.balance ?? 0) / 100;
      const pv = (bal.portfolio_value ?? 0) / 100;
      ensureCsv(csvPath);
      const row = `${new Date().toISOString()},${cash.toFixed(2)},${pv.toFixed(2)}\n`;
      appendFileSync(csvPath, row, "utf-8");
      lastSampleAt = Date.now();
      log(`Equity snapshot logged: cash $${cash.toFixed(2)} · pv $${pv.toFixed(2)}`);
    } catch (err: any) {
      log(`Equity snapshot failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  return {
    start() {
      if (timer) return;
      if (!client) {
        log("Equity logger disabled (Kalshi not configured)");
        return;
      }
      // Fire once immediately to populate the first point, then schedule
      void snapshot();
      timer = setInterval(() => { void snapshot(); }, intervalMs);
      log(`Equity logger started (every ${Math.round(intervalMs / 60_000)}min → ${csvPath})`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    readSeries(): EquitySnapshot[] {
      if (!existsSync(csvPath)) return [];
      try {
        const text = readFileSync(csvPath, "utf-8");
        const lines = text.split("\n").slice(1).filter(l => l.trim().length > 0);
        const rows: EquitySnapshot[] = [];
        for (const line of lines) {
          const [t, cash, pv] = line.split(",");
          const cashNum = parseFloat(cash);
          const pvNum = parseFloat(pv);
          if (!t || !isFinite(cashNum) || !isFinite(pvNum)) continue;
          rows.push({ t, cashUSD: cashNum, portfolioValueUSD: pvNum });
        }
        // Sort by timestamp so restarts don't leave the chart zig-zagging
        rows.sort((a, b) => a.t.localeCompare(b.t));
        return rows;
      } catch {
        return [];
      }
    },
  };
}

function ensureCsv(path: string) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "timestamp,cash_usd,portfolio_value_usd\n", "utf-8");
}
