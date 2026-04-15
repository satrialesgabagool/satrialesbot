#!/usr/bin/env bun
/**
 * Smoke test for the Kalshi-ww-bot scaffold.
 *
 * Exercises:
 *   1. KalshiClient.listEvents against demo (unauthenticated read)
 *   2. fetchKalshiEnsemble for NYC (free-tier: Open-Meteo + NOAA)
 *   3. bracketProbability math
 *   4. HighConvictionLog CSV write round-trip
 *
 * Does NOT start any long-running scheduler. Run:
 *   bun run src/kalshi/smoke.ts
 */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { KalshiClient } from "./client/KalshiClient";
import { fetchKalshiEnsemble, bracketProbability } from "./weather/KalshiEnsemble";
import { HighConvictionLog } from "./output/HighConvictionLog";

function section(name: string): void {
  console.log(`\n─── ${name} ──────────────────────────────`);
}

async function main() {
  let pass = 0;
  let fail = 0;

  // 1. Kalshi demo reachability
  section("Kalshi demo: list events (no auth required)");
  try {
    const client = new KalshiClient({ env: "demo" });
    const page = await client.listEvents({ status: "open", limit: 5 });
    const count = (page.events ?? []).length;
    console.log(`  ${count} events returned`);
    if (count > 0) {
      const sample = page.events![0];
      console.log(`  sample: ${sample.event_ticker} / ${sample.title}`);
    }
    console.log("  PASS");
    pass++;
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    fail++;
  }

  // 2. Weather ensemble for NYC
  section("Ensemble forecast: NYC, 3 days");
  try {
    const ensemble = await fetchKalshiEnsemble("nyc", 3);
    if (!ensemble || ensemble.days.length === 0) throw new Error("empty ensemble");
    for (const day of ensemble.days.slice(0, 3)) {
      console.log(
        `  ${day.date}: high=${day.ensembleHighF}°F ±${day.spreadHighF} ` +
          `(${day.sourceCount} sources, agree=${day.agreement})`,
      );
    }
    console.log("  PASS");
    pass++;
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    fail++;
  }

  // 3. bracketProbability sanity check
  section("bracketProbability math");
  try {
    // Ensemble says 72°F ± 1°F with 24h horizon. Probability of being
    // in [70, 74] bracket should be high; [50, 55] should be near zero;
    // [68, 72] should be moderate.
    const pCenter = bracketProbability(72, 1, 70, 74, 24);
    const pCold = bracketProbability(72, 1, 50, 55, 24);
    const pEdge = bracketProbability(72, 1, 68, 72, 24);
    console.log(`  p([70,74]|μ=72,σ≈2.2) = ${(pCenter * 100).toFixed(1)}%`);
    console.log(`  p([50,55]|μ=72,σ≈2.2) = ${(pCold * 100).toFixed(6)}%`);
    console.log(`  p([68,72]|μ=72,σ≈2.2) = ${(pEdge * 100).toFixed(1)}%`);
    if (pCenter > 0.7 && pCold < 0.001 && pEdge > 0.3 && pEdge < 0.7) {
      console.log("  PASS");
      pass++;
    } else {
      throw new Error("probabilities out of expected ranges");
    }
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    fail++;
  }

  // 4. CSV write round-trip
  section("HighConvictionLog CSV write");
  const dir = mkdtempSync(join(tmpdir(), "kw-smoke-"));
  const csvPath = join(dir, "hc.csv");
  try {
    const log = new HighConvictionLog(csvPath);
    log.append({
      timestamp: new Date().toISOString(),
      strategy: "weather",
      eventTicker: "KXHIGHNY-TEST",
      marketTicker: "KXHIGHNY-TEST-T72.5",
      side: "yes",
      yesPrice: 48,
      sizeContracts: 0,
      conviction: 0.42,
      edgeBps: 1500,
      reason: "smoke test — with, comma and \"quotes\"",
      metadata: { test: true, n: 1 },
    });
    const contents = readFileSync(csvPath, "utf-8");
    const lines = contents.trim().split("\n");
    console.log(`  csv header: ${lines[0].slice(0, 60)}...`);
    console.log(`  csv row: ${lines[1].slice(0, 80)}...`);
    if (lines.length === 2 && lines[1].includes("KXHIGHNY-TEST")) {
      console.log("  PASS");
      pass++;
    } else {
      throw new Error("CSV shape unexpected");
    }
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
    fail++;
  } finally {
    try {
      rmSync(dir, { recursive: true });
    } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
