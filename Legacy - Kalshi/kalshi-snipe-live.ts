#!/usr/bin/env bun
/**
 * Satriales · Kalshi BTC Snipe Trader — TypeScript entry point.
 *
 * Paper mode (default, safe): production market data, no real orders.
 * Live mode (--live + creds): authenticated RSA-PSS orders.
 * GUI mode (--gui): serves a local web dashboard on http://127.0.0.1:5173.
 *
 * Usage:
 *   bun run kalshi-snipe-live.ts                         # paper, no GUI
 *   bun run kalshi-snipe-live.ts --gui                   # paper + GUI
 *   bun run kalshi-snipe-live.ts --gui --port 5200
 *   bun run kalshi-snipe-live.ts --hours 8 --bankroll 50
 *   bun run kalshi-snipe-live.ts --demo --live           # live on demo env
 *   bun run kalshi-snipe-live.ts --live                  # LIVE PROD (5s abort window)
 *
 * Env vars for live mode:
 *   KALSHI_API_KEY_ID        (or KALSHI_KEY_ID — Python naming, also accepted)
 *   KALSHI_PRIVATE_KEY_PATH  (PEM file)
 *   KALSHI_PRIVATE_KEY_PEM   (inline PEM string — alt to path)
 */

import { KalshiClient } from "./src/kalshi/KalshiClient";
import { KalshiSnipeHunter, DEFAULT_CONFIG } from "./src/kalshi/KalshiSnipeHunter";
import { KalshiSnipeServer } from "./src/kalshi/KalshiSnipeServer";
import { loadCredentialsFromEnv, loadCredentials } from "./src/kalshi/KalshiAuth";

// ─── CLI parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function argVal<T>(flag: string, parse: (s: string) => T, fallback: T): T {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v == null) return fallback;
  return parse(v);
}

const HOURS         = argVal("--hours",       parseFloat, NaN);
const BANKROLL      = argVal("--bankroll",    parseFloat, DEFAULT_CONFIG.initialBankroll);
const GUI           = hasFlag("--gui");
const PORT          = argVal("--port",        parseInt,   5173);
const HOST          = argVal("--host",        (s) => s,   "127.0.0.1");
const DEMO          = hasFlag("--demo");
const LIVE          = hasFlag("--live");
const DB_PATH       = argVal("--db",          (s) => s,   "kalshi_snipe.db");
const KELLY_FRAC    = argVal("--kelly",       parseFloat, NaN);
const NO_KELLY      = hasFlag("--no-kelly");
const LOG_PATH      = argVal("--log",         (s) => s,   "snipe_log.jsonl");

// ─── Banner ───────────────────────────────────────────────────────────

function printBanner(): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  SATRIALES · KALSHI BTC SNIPE TRADER (TypeScript)                ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`  Mode:       ${LIVE ? "LIVE" : "PAPER"}${DEMO ? " (demo env)" : " (production market data)"}`);
  console.log(`  Bankroll:   $${BANKROLL.toFixed(2)}`);
  console.log(`  Max hours:  ${Number.isFinite(HOURS) ? HOURS : "unlimited"}`);
  console.log(`  GUI:        ${GUI ? `http://${HOST}:${PORT}` : "disabled (run with --gui)"}`);
  console.log(`  DB:         ${DB_PATH}`);
  console.log(`  Log:        ${LOG_PATH}`);
  console.log("");
}

async function main(): Promise<void> {
  printBanner();

  const creds = loadCredentialsFromEnv() ?? (() => {
    // Fallback: Python-style env var names
    const id = process.env.KALSHI_KEY_ID;
    const path = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (id && path) return loadCredentials(id, path);
    return null;
  })();

  if (LIVE && !creds) {
    console.error("--live requires KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PATH (or _PEM).");
    console.error("Refusing to start in live mode without creds.");
    process.exit(1);
  }

  if (LIVE && !DEMO) {
    console.warn("");
    console.warn("⚠️  LIVE MODE on PRODUCTION — real money at stake.");
    console.warn("⚠️  5 seconds to abort (Ctrl+C)...");
    await new Promise((r) => setTimeout(r, 5000));
  }

  const client = new KalshiClient({
    demo: DEMO,
    credentials: creds ?? undefined,
  });

  const cfg: Partial<typeof DEFAULT_CONFIG> = { initialBankroll: BANKROLL };
  if (NO_KELLY) cfg.useKelly = false;
  if (Number.isFinite(KELLY_FRAC)) cfg.kellyFraction = KELLY_FRAC;

  const hunter = new KalshiSnipeHunter({
    config: cfg,
    dbPath: DB_PATH,
    client,
    live: LIVE,
    logPath: LOG_PATH,
  });

  // Wire Ctrl+C to graceful stop
  process.on("SIGINT", () => {
    console.log("\nSIGINT — stopping...");
    hunter.stop();
  });

  let server: KalshiSnipeServer | null = null;
  if (GUI) {
    server = new KalshiSnipeServer(hunter, { port: PORT, hostname: HOST });
    server.start();
  }

  try {
    await hunter.run(Number.isFinite(HOURS) ? HOURS : undefined);
  } finally {
    server?.stop();
  }
}

main().catch((err) => {
  console.error("[kalshi-snipe-live] fatal:", err);
  process.exit(1);
});
