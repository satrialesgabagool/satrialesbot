/**
 * Weather-ensemble edge scanner for Kalshi.
 *
 * For each active Kalshi weather event:
 *   1. Fetch the Kalshi ensemble forecast (free-tier + any configured paid sources)
 *   2. Find the ensemble day matching the event's resolve date
 *   3. For each bracket, compute ensemble probability → compare to yes_ask/100
 *   4. Emit rows where:
 *        edge_bps  >= minEdgeBps
 *        spreadF   <= maxSpreadF     (tight ensemble agreement)
 *        hoursLeft <= maxHorizon     (short enough that forecasts are reliable)
 *   5. Append each hit to the shared high-conviction CSV.
 *
 * Conviction score combines edge size, agreement score, and source count:
 *     conviction = edge_bps/10000 × agreement × min(1, sourceCount/5)
 *
 * This is the "quant" side of strategy 1 — no auto-execution; just a
 * detector that writes opportunities to disk for you to review.
 */

import { findKalshiWeatherMarkets } from "../KalshiWeatherFinder";
import type { WeatherMarket, TempBracket } from "../../weather/WeatherMarketFinder";
import { HighConvictionLog, type HighConvictionRow } from "../output/HighConvictionLog";
import { bracketProbability, fetchKalshiEnsemble, type KalshiEnsembleDay } from "./KalshiEnsemble";

export interface WeatherScannerConfig {
  minEdgeBps: number;       // e.g. 500 → 5% edge required
  maxSpreadF: number;       // e.g. 4 → skip if ensemble disagrees > 4°F
  maxHorizonHours: number;  // e.g. 48 → only trade brackets closing within 48h
  minSources: number;       // e.g. 2 → need at least 2 forecast sources agreeing
  minLiquidity: number;     // e.g. 100 → skip if bracket has < 100 liquidity score
  intervalMs: number;       // scan cadence
}

export const DEFAULT_WEATHER_SCANNER_CONFIG: WeatherScannerConfig = {
  minEdgeBps: 1000, // 10% edge
  maxSpreadF: 4,
  maxHorizonHours: 48,
  minSources: 3,
  minLiquidity: 50,
  intervalMs: 5 * 60 * 1000, // 5 minutes
};

export class WeatherScanner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private scanCount = 0;

  constructor(
    private readonly log: HighConvictionLog,
    private readonly config: WeatherScannerConfig = DEFAULT_WEATHER_SCANNER_CONFIG,
  ) {}

  async start(): Promise<void> {
    console.log(`[weather] scanner started — cadence=${this.config.intervalMs / 1000}s`);
    await this.runOnce();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log(`[weather] scanner stopped after ${this.scanCount} scans`);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (err) {
        console.error("[weather] scan error:", (err as Error).message);
      }
      this.schedule();
    }, this.config.intervalMs);
  }

  private async runOnce(): Promise<void> {
    this.scanCount++;
    const t0 = Date.now();
    const markets = await findKalshiWeatherMarkets({ daysAhead: 3 });
    console.log(`[weather] scan #${this.scanCount}: ${markets.length} active markets`);

    // Group markets by city so we only hit each weather API once per city per scan.
    const cities = [...new Set(markets.map((m) => m.city))];
    const ensembleByCity = new Map<string, Awaited<ReturnType<typeof fetchKalshiEnsemble>>>();
    await Promise.all(
      cities.map(async (city) => {
        ensembleByCity.set(city, await fetchKalshiEnsemble(city, 3));
      }),
    );

    let hits = 0;
    for (const market of markets) {
      const ensemble = ensembleByCity.get(market.city);
      if (!ensemble) continue;

      const day = ensemble.days.find((d) => d.date === market.date);
      if (!day) continue;

      if (day.sourceCount < this.config.minSources) continue;
      if (day.spreadHighF > this.config.maxSpreadF) continue;

      const hoursLeft = (new Date(market.endDate).getTime() - Date.now()) / 3_600_000;
      if (hoursLeft > this.config.maxHorizonHours || hoursLeft <= 0) continue;

      for (const b of market.brackets) {
        if (b.liquidity < this.config.minLiquidity) continue;

        const row = this.evaluateBracket(market, b, day, hoursLeft);
        if (row) {
          this.log.append(row);
          hits++;
        }
      }
    }

    const dt = Date.now() - t0;
    console.log(`[weather] scan #${this.scanCount} done: ${hits} hits in ${dt}ms`);
  }

  private evaluateBracket(
    market: WeatherMarket,
    b: TempBracket,
    day: KalshiEnsembleDay,
    hoursLeft: number,
  ): HighConvictionRow | null {
    const ensembleMean = market.type === "high" ? day.ensembleHighF : day.ensembleLowF;
    const spread = market.type === "high" ? day.spreadHighF : day.spreadLowF;

    const trueProb = bracketProbability(ensembleMean, spread, b.lowF, b.highF, hoursLeft);
    const marketProb = b.outcomePrices[0];
    const edge = trueProb - marketProb;
    const edgeBps = Math.round(edge * 10000);

    // Only want BUY-YES opportunities (trueProb > marketProb → undervalued yes).
    if (edgeBps < this.config.minEdgeBps) return null;

    const conviction =
      edge * day.agreement * Math.min(1, day.sourceCount / 5);

    return {
      timestamp: new Date().toISOString(),
      strategy: "weather",
      eventTicker: market.eventId,
      marketTicker: b.slug,
      side: "yes",
      yesPrice: Math.round(b.outcomePrices[0] * 100),
      sizeContracts: 0, // scanner only — no sizing here
      conviction: Math.round(conviction * 10000) / 10000,
      edgeBps,
      reason: formatReason(market, b, day, trueProb, marketProb, hoursLeft),
      metadata: {
        city: market.city,
        type: market.type,
        resolveDate: market.date,
        hoursLeft: Math.round(hoursLeft * 10) / 10,
        ensembleF: ensembleMean,
        spreadF: spread,
        sourceCount: day.sourceCount,
        agreement: day.agreement,
        bracketLowF: isFinite(b.lowF) ? b.lowF : null,
        bracketHighF: isFinite(b.highF) ? b.highF : null,
        trueProb: Math.round(trueProb * 10000) / 10000,
        marketProb: Math.round(marketProb * 10000) / 10000,
        volume24h: b.volume,
        liquidity: b.liquidity,
      },
    };
  }
}

function formatReason(
  market: WeatherMarket,
  b: TempBracket,
  day: KalshiEnsembleDay,
  trueProb: number,
  marketProb: number,
  hoursLeft: number,
): string {
  const lo = isFinite(b.lowF) ? `${b.lowF}` : "-∞";
  const hi = isFinite(b.highF) ? `${b.highF}` : "+∞";
  return (
    `${market.city} ${market.type} ${market.date} [${lo},${hi}°F]: ` +
    `ensemble=${day.ensembleHighF.toFixed(1)}°F±${day.spreadHighF.toFixed(1)} ` +
    `(${day.sourceCount} sources, agree=${day.agreement.toFixed(2)}), ` +
    `model_p=${(trueProb * 100).toFixed(1)}% vs market=${(marketProb * 100).toFixed(1)}%, ` +
    `h=${hoursLeft.toFixed(1)}h`
  );
}
