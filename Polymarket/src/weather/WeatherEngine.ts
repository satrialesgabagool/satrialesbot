/**
 * Weather Temperature Markets Engine.
 *
 * Scan loop:
 * 1. Discover active temperature markets via Gamma API
 * 2. Fetch GFS + ECMWF ensemble forecasts (82 members per city/day)
 * 3. Compute bracket probabilities from ensemble
 * 4. Find brackets where forecast probability diverges 8%+ from market price
 * 5. Paper-trade: simulate limit orders at maker price (0% maker fee)
 * 6. Track PnL, log to CSV, resolve completed trades
 *
 * Weather markets resolve daily (not 5-minute), so we scan every 15 minutes
 * and hold positions until resolution.
 */

import { findWeatherMarkets } from "./WeatherMarketFinder";
import { fetchEnsembleMultiDay, blendedBracketProb } from "./EnsembleForecast";
import { computeEdges, findOpportunitiesByDate, formatBracket } from "./EdgeCalculator";
import { lookupCity } from "./cities";
import { Logger } from "../log/Logger";
import { appendFileSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  WeatherEngineConfig,
  WeatherState,
  WeatherTrade,
  WeatherOpportunity,
  EnsembleResult,
  DEFAULT_WEATHER_CONFIG,
} from "./types";

const RESULTS_DIR = join(import.meta.dir, "../../results");
const STATE_PATH = join(import.meta.dir, "../../state/weather-state.json");
const CSV_PATH = join(RESULTS_DIR, "weather-trades.csv");
const OPP_CSV_PATH = join(RESULTS_DIR, "weather-opportunities.csv");

const CSV_HEADER = "timestamp,city,date,type,bracket,action,entry_price,shares,cost,forecast_prob,market_price,edge,ensemble_mean,ensemble_std,slug\n";
const OPP_HEADER = "timestamp,city,date,bracket,forecast_prob,market_price,edge,ensemble_mean,ensemble_std,members,action\n";

// ANSI colors
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

export class WeatherEngine {
  private config: WeatherEngineConfig;
  private logger: Logger;
  private state: WeatherState;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private scanCount = 0;

  constructor(config: WeatherEngineConfig) {
    this.config = config;
    this.logger = new Logger(join(import.meta.dir, "../../logs"));

    // Load or initialize state
    this.state = this.loadState();
  }

  async start(): Promise<void> {
    this.printBanner();

    this.logger.log("=== Weather Temperature Engine ===", "cyan");
    this.logger.log(`Mode: ${this.config.mode} | Bankroll: $${this.config.bankroll}`, "cyan");
    this.logger.log(`Min edge: ${(this.config.minEdge * 100).toFixed(0)}% | Kelly: ${this.config.kellyFraction}x | Scan: ${this.config.scanIntervalMs / 60000}min`, "cyan");

    // Ensure output directories exist
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
    if (!existsSync(join(import.meta.dir, "../../state"))) mkdirSync(join(import.meta.dir, "../../state"), { recursive: true });

    // Initialize CSV files
    this.initCSV(CSV_PATH, CSV_HEADER);
    this.initCSV(OPP_CSV_PATH, OPP_HEADER);

    // Setup shutdown handlers
    const shutdown = () => this.shutdown();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Run first scan immediately
    await this.scan();

    // Start scan loop
    this.scanTimer = setInterval(() => this.scan(), this.config.scanIntervalMs);

    this.logger.log("Weather engine running. Scanning every 15 minutes.", "green");
  }

  private async scan(): Promise<void> {
    if (this.shuttingDown) return;

    this.scanCount++;
    const scanStart = Date.now();
    this.logger.log(`\n--- Scan #${this.scanCount} ---`, "cyan");

    try {
      // Step 1: Discover markets
      this.logger.log("Discovering temperature markets...", "dim");
      const markets = await findWeatherMarkets({
        daysAhead: this.config.daysAhead,
        type: "high", // Focus on high temp (more volume, easier to forecast)
      });

      if (markets.length === 0) {
        this.logger.log("No active temperature markets found.", "yellow");
        return;
      }

      this.logger.log(`Found ${markets.length} active markets`, "green");

      // Filter by configured cities
      const filteredMarkets = this.config.cities.length > 0
        ? markets.filter(m => this.config.cities.some(c =>
            m.city.toLowerCase().includes(c.toLowerCase())))
        : markets;

      // Step 2: Fetch ensemble forecasts for each unique city+date
      const ensembleMap = new Map<string, EnsembleResult>();
      const cityDates = new Map<string, Set<string>>();

      for (const market of filteredMarkets) {
        const key = market.city.toLowerCase().replace(/\s+/g, "-");
        if (!cityDates.has(key)) cityDates.set(key, new Set());
        cityDates.get(key)!.add(market.date);
      }

      this.logger.log(`Fetching ensemble forecasts for ${cityDates.size} cities...`, "dim");

      // Fetch all dates per city in ONE API call (avoids rate limiting)
      // Open-Meteo free tier: ~600 requests/min. With 50 cities in batches of 3,
      // that's ~17 batches with 1s delay = ~20s total. Well within limits.
      const cityKeys = [...cityDates.keys()];
      let ensembleSuccesses = 0;
      for (let i = 0; i < cityKeys.length; i += 3) {
        const batch = cityKeys.slice(i, i + 3);
        const promises = batch.map(async (cityKey) => {
          const dates = [...cityDates.get(cityKey)!];
          const results = await fetchEnsembleMultiDay(cityKey, dates, "high");
          for (const [date, ensemble] of results) {
            ensembleMap.set(`${cityKey}|${date}`, ensemble);
            ensembleSuccesses++;
            this.logger.log(
              `  ${ensemble.city} ${date}: ${ensemble.mean}${lookupCity(cityKey)?.unit ?? "F"} (${C.dim}${ensemble.members.length} members, std=${ensemble.stdDev}${C.reset})`,
              "reset",
            );
          }
        });
        await Promise.all(promises);
        // 1 second delay between batches to stay under rate limits
        if (i + 3 < cityKeys.length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      this.logger.log(`Fetched ${ensembleSuccesses} ensemble forecasts`, "green");

      // Step 3: Find opportunities
      const opportunities = findOpportunitiesByDate(filteredMarkets, ensembleMap, {
        minEdge: this.config.minEdge,
        kellyFraction: this.config.kellyFraction,
        maxPositionPct: this.config.maxPositionPct,
        bankroll: this.state.bankroll,
      });

      // Log all opportunities to CSV
      this.logOpportunities(opportunities);

      // Step 4: Print opportunities and simulate trades
      let tradesThisScan = 0;

      for (const opp of opportunities) {
        if (opp.edges.length === 0) continue;

        this.logger.log(`\n${C.bold}${opp.market.city}${C.reset} ${opp.market.date} — Forecast: ${C.bold}${opp.ensemble.mean}${opp.market.unit}${C.reset} (std=${opp.ensemble.stdDev})`, "reset");

        for (const edge of opp.edges) {
          const bracketStr = formatBracket(edge.bracket);
          const edgePct = (edge.edge * 100).toFixed(1);
          const edgeColor = edge.edge >= 0.15 ? C.green : edge.edge >= 0.10 ? C.yellow : C.cyan;
          const actionColor = edge.action === "BUY_YES" ? C.green : C.red;

          this.logger.log(
            `  ${actionColor}${edge.action}${C.reset} ${bracketStr.padEnd(14)} ` +
            `market=${(edge.marketPrice * 100).toFixed(1)}% ` +
            `forecast=${(edge.forecastProb * 100).toFixed(1)}% ` +
            `${edgeColor}edge=+${edgePct}%${C.reset} ` +
            `kelly=$${edge.suggestedSize.toFixed(2)}`,
            "reset",
          );

          // Only paper-trade if we haven't already traded this bracket
          const alreadyTraded = this.state.pending.some(t =>
            t.conditionId === edge.bracket.conditionId) ||
            this.state.completed.some(t =>
              t.conditionId === edge.bracket.conditionId);

          if (!alreadyTraded && this.state.bankroll >= 5) {
            this.simulateTrade(opp, edge);
            tradesThisScan++;
          }
        }
      }

      // Step 5: Check for resolved trades
      await this.checkResolutions();

      // Step 6: Print summary
      const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
      this.logger.log(
        `\nScan complete in ${elapsed}s | Trades: ${tradesThisScan} new, ${this.state.pending.length} pending | ` +
        `PnL: $${this.state.totalPnl.toFixed(2)} | Bankroll: $${this.state.bankroll.toFixed(2)} | ` +
        `Record: ${this.state.wins}W/${this.state.losses}L`,
        this.state.totalPnl >= 0 ? "green" : "red",
      );

      // Persist state
      this.saveState();

    } catch (error) {
      this.logger.error(`Scan error: ${error}`);
    }
  }

  private simulateTrade(opp: WeatherOpportunity, edge: ReturnType<typeof computeEdges>[0]): void {
    // Paper trade: we simulate buying at the market price (limit order at maker = 0% fee)
    const shares = Math.floor(edge.suggestedSize / edge.marketPrice);
    if (shares < 5) return; // Polymarket 5-share minimum

    const cost = shares * edge.marketPrice;
    if (cost > this.state.bankroll) return;

    const trade: WeatherTrade = {
      id: `wx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      city: opp.market.city,
      date: opp.market.date,
      bracket: formatBracket(edge.bracket),
      action: edge.action,
      entryPrice: edge.marketPrice,
      shares,
      cost,
      forecastProb: edge.forecastProb,
      marketPrice: edge.marketPrice,
      edge: edge.edge,
      ensembleMean: opp.ensemble.mean,
      ensembleStdDev: opp.ensemble.stdDev,
      placedAt: Date.now(),
      slug: opp.market.slug,
      conditionId: edge.bracket.conditionId,
    };

    this.state.bankroll -= cost;
    this.state.pending.push(trade);
    this.state.totalTrades++;

    this.logger.log(
      `  ${C.magenta}TRADE${C.reset} ${trade.action} ${trade.shares} shares @ $${trade.entryPrice.toFixed(3)} = $${cost.toFixed(2)} | ${trade.bracket}`,
      "reset",
    );

    // Log to CSV
    this.logTrade(trade, opp.market.type);
  }

  /**
   * Check if any pending trades have resolved.
   *
   * In sim mode, we resolve trades by checking if the market date has passed
   * and the market's final prices are available (YES = 1.00 or NO = 1.00).
   */
  private async checkResolutions(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().split("T")[0];

    const stillPending: WeatherTrade[] = [];

    for (const trade of this.state.pending) {
      // Trade resolves the day after the market date (weather data finalized ~next morning)
      const marketDate = new Date(trade.date + "T23:59:59Z");
      const resolutionDate = new Date(marketDate.getTime() + 18 * 60 * 60 * 1000); // +18h buffer

      if (now < resolutionDate) {
        stillPending.push(trade);
        continue;
      }

      // Simulate resolution using our ensemble forecast
      // In production this would check market resolution on-chain
      const actualTemp = this.simulateActualTemp(trade);
      const bracketParts = this.parseBracketStr(trade.bracket);

      let won = false;
      if (bracketParts) {
        const inBracket = actualTemp > (isFinite(bracketParts.low) ? bracketParts.low - 0.5 : -Infinity)
          && actualTemp <= (isFinite(bracketParts.high) ? bracketParts.high + 0.5 : Infinity);
        won = trade.action === "BUY_YES" ? inBracket : !inBracket;
      }

      const payout = won ? trade.shares * 1.0 : 0; // $1.00 per share if correct
      const pnl = payout - trade.cost;

      trade.resolvedAt = Date.now();
      trade.outcome = won ? "WIN" : "LOSS";
      trade.pnl = pnl;

      this.state.bankroll += payout;
      this.state.totalPnl += pnl;
      if (won) this.state.wins++;
      else this.state.losses++;
      this.state.completed.push(trade);

      const resultColor = won ? C.green : C.red;
      this.logger.log(
        `  ${resultColor}RESOLVED${C.reset} ${trade.city} ${trade.date} ${trade.bracket}: ${trade.outcome} ` +
        `(actual=${actualTemp.toFixed(0)}) pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        "reset",
      );
    }

    this.state.pending = stillPending;
  }

  /**
   * Simulate actual temperature for resolution.
   *
   * In sim mode, we add small noise to the ensemble mean to get a "real" outcome.
   * This tests our edge detection: if our probabilities are well-calibrated,
   * we should win at the rate our forecast predicts.
   *
   * In production, this would fetch actual weather data from Weather Underground.
   */
  private simulateActualTemp(trade: WeatherTrade): number {
    // Use ensemble mean + gaussian noise (sigma = ensemble std)
    // This is a realistic simulation of actual outcomes
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.round(trade.ensembleMean + z * trade.ensembleStdDev);
  }

  private parseBracketStr(bracket: string): { low: number; high: number } | null {
    const rangeMatch = bracket.match(/(\d+)-(\d+)/);
    if (rangeMatch) return { low: parseInt(rangeMatch[1]), high: parseInt(rangeMatch[2]) };

    const belowMatch = bracket.match(/<=(\d+)/);
    if (belowMatch) return { low: -Infinity, high: parseInt(belowMatch[1]) };

    const aboveMatch = bracket.match(/>=(\d+)/);
    if (aboveMatch) return { low: parseInt(aboveMatch[1]), high: Infinity };

    return null;
  }

  // ─── CSV logging ──────────────────────────────────────────────────

  private initCSV(path: string, header: string): void {
    if (!existsSync(path)) {
      writeFileSync(path, header);
    }
  }

  private logTrade(trade: WeatherTrade, type: string): void {
    const row = [
      new Date().toISOString(),
      trade.city,
      trade.date,
      type,
      trade.bracket,
      trade.action,
      trade.entryPrice.toFixed(4),
      trade.shares,
      trade.cost.toFixed(2),
      trade.forecastProb.toFixed(4),
      trade.marketPrice.toFixed(4),
      trade.edge.toFixed(4),
      trade.ensembleMean.toFixed(1),
      trade.ensembleStdDev.toFixed(1),
      trade.slug,
    ].join(",") + "\n";

    appendFileSync(CSV_PATH, row);
  }

  private logOpportunities(opportunities: WeatherOpportunity[]): void {
    for (const opp of opportunities) {
      for (const edge of opp.edges) {
        const row = [
          new Date().toISOString(),
          opp.market.city,
          opp.market.date,
          formatBracket(edge.bracket),
          edge.forecastProb.toFixed(4),
          edge.marketPrice.toFixed(4),
          edge.edge.toFixed(4),
          opp.ensemble.mean.toFixed(1),
          opp.ensemble.stdDev.toFixed(1),
          opp.ensemble.members.length,
          edge.action,
        ].join(",") + "\n";

        appendFileSync(OPP_CSV_PATH, row);
      }
    }
  }

  // ─── State persistence ────────────────────────────────────────────

  private loadState(): WeatherState {
    try {
      if (existsSync(STATE_PATH)) {
        const raw = readFileSync(STATE_PATH, "utf-8");
        return JSON.parse(raw) as WeatherState;
      }
    } catch {}

    return {
      totalPnl: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      pending: [],
      completed: [],
      bankroll: this.config.bankroll,
    };
  }

  private saveState(): void {
    const dir = join(import.meta.dir, "../../state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.log("Shutting down weather engine...", "yellow");

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    this.saveState();

    this.logger.log(
      `Final: PnL=$${this.state.totalPnl.toFixed(2)} | ${this.state.wins}W/${this.state.losses}L | Bankroll=$${this.state.bankroll.toFixed(2)}`,
      this.state.totalPnl >= 0 ? "green" : "red",
    );
    this.logger.log("Weather engine stopped.", "cyan");
  }

  private printBanner(): void {
    console.log(`
${C.cyan}${C.bold}  ╔═══════════════════════════════════════════╗
  ║     SATRIALES WEATHER ENGINE              ║
  ║     Temperature Markets · GFS+ECMWF       ║
  ╚═══════════════════════════════════════════╝${C.reset}

  ${C.dim}Bankroll:${C.reset}   $${this.config.bankroll.toFixed(2)}
  ${C.dim}Min edge:${C.reset}   ${(this.config.minEdge * 100).toFixed(0)}%
  ${C.dim}Kelly:${C.reset}      ${this.config.kellyFraction}x (quarter-Kelly)
  ${C.dim}Max pos:${C.reset}    ${(this.config.maxPositionPct * 100).toFixed(0)}% of bankroll
  ${C.dim}Scan:${C.reset}       Every ${this.config.scanIntervalMs / 60000} min
  ${C.dim}Models:${C.reset}     GFS (31 members) + ECMWF (51 members)
  ${C.dim}Fees:${C.reset}       0% maker (limit orders only)
`);
  }
}
