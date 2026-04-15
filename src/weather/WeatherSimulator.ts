/**
 * Weather Market Trading Simulator v2 — Ladder Strategy
 *
 * Inspired by neobrother-style temperature laddering:
 * Buy 4-6 adjacent brackets per market, accept most expire worthless,
 * because one winner at $0.01-$0.10 pays 10-100x.
 *
 * Uses multi-model ensemble forecasts (Open-Meteo + ECMWF + GFS + NOAA)
 * for robust probability estimates. Model disagreement widens sigma.
 *
 * Targets ≥30% edge brackets, with heavier sizing on cheap ones.
 */

import { findWeatherMarkets, type WeatherMarket, type TempBracket } from "./WeatherMarketFinder";
import { fetchEnsembleForecast, ensembleBracketProbability, type EnsembleForecast } from "./WeatherEnsemble";
import { fetchWithRetry } from "../net/fetchWithRetry";
import { appendFileSync, existsSync, writeFileSync, readFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";

// City coordinates for archive API lookups
const CITY_COORDS: Record<string, [number, number]> = {
  "new york city": [40.7128, -74.0060],
  "atlanta": [33.7490, -84.3880],
  "dallas": [32.7767, -96.7970],
  "seattle": [47.6062, -122.3321],
  "london": [51.5074, -0.1278],
  "paris": [48.8566, 2.3522],
  "tokyo": [35.6762, 139.6503],
  "seoul": [37.5665, 126.9780],
  "beijing": [39.9042, 116.4074],
  "shanghai": [31.2304, 121.4737],
  "hong kong": [22.3193, 114.1694],
  "taipei": [25.0330, 121.5654],
  "toronto": [43.6532, -79.3832],
  "mexico city": [19.4326, -99.1332],
  "madrid": [40.4168, -3.7038],
  "ankara": [39.9334, 32.8597],
  "wellington": [-41.2865, 174.7762],
};

// ─── Types ───────────────────────────────────────────────────────────

export interface WeatherPosition {
  id: string;
  market: WeatherMarket;
  bracket: TempBracket;
  shares: number;
  entryPrice: number;
  cost: number;
  forecastTempF: number;
  forecastProb: number;
  edge: number;
  modelSpreadF: number;    // ensemble disagreement at entry
  modelCount: number;      // how many models contributed
  hoursToResolution: number;
  entryTime: string;
  status: "open" | "won" | "lost";
  pnl: number;
  resolvedAt?: string;
  resolvedTempF?: number;
  ladderGroup?: string;    // groups ladder positions (city+date)
}

export interface SimulatorConfig {
  startingBalance: number;
  minEdge: number;             // minimum edge to enter (0.30 = 30%)
  ladderBudget: number;        // total $ per market ladder
  maxLadderLegs: number;       // max brackets per market (4-6)
  maxTotalPositions: number;
  scanIntervalMs: number;
  daysAhead: number;
  resolveWithNoise: boolean;
  cheapBracketBonus: boolean;  // overweight cheap brackets ($0.01-$0.10)
  maxModelSpreadF: number;     // skip markets where models disagree more than this
}

export interface SimulatorState {
  balance: number;
  deployed: number;
  positions: WeatherPosition[];
  closedPositions: WeatherPosition[];
  totalPnl: number;
  wins: number;
  losses: number;
  scansCompleted: number;
}

const DEFAULT_CONFIG: SimulatorConfig = {
  startingBalance: 500,
  minEdge: 0.15,
  ladderBudget: 15,        // $15 spread across 4-6 brackets per market
  maxLadderLegs: 6,
  maxTotalPositions: 50,
  scanIntervalMs: 5 * 60 * 1000,
  daysAhead: 3,
  resolveWithNoise: true,
  cheapBracketBonus: true,
  maxModelSpreadF: 4.0,    // skip when models disagree by >4°F
};

const RESULTS_DIR = join(import.meta.dir, "../../results");
const STATE_DIR = join(import.meta.dir, "../../state");
const TRADES_CSV = join(RESULTS_DIR, "weather-trades.csv");
const STATE_PATH = join(STATE_DIR, "weather-sim.json");
const TRADES_HEADER = "timestamp,action,city,date,type,bracket,shares,price,cost,forecast_temp_f,forecast_prob,edge,model_spread,models,hours_to_res,pnl,balance\n";

/** Serializable snapshot of simulator state for persistence */
interface PersistedState {
  config: SimulatorConfig;
  balance: number;
  deployed: number;
  positions: WeatherPosition[];
  closedPositions: WeatherPosition[];
  totalPnl: number;
  wins: number;
  losses: number;
  scansCompleted: number;
  positionCounter: number;
  savedAt: string;
}

// ─── Simulator ───────────────────────────────────────────────────────

export class WeatherSimulator {
  private config: SimulatorConfig;
  private state: SimulatorState;
  private positionCounter = 0;
  private running = false;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  // Callbacks for terminal runner
  onLog?: (msg: string, color?: string) => void;
  onPositionOpened?: (pos: WeatherPosition) => void;
  onPositionClosed?: (pos: WeatherPosition) => void;
  onScanComplete?: (opportunities: number) => void;
  onDashboardUpdate?: () => void;

  constructor(config?: Partial<SimulatorConfig>, resume: boolean = false) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Try to resume from saved state
    if (resume) {
      const loaded = this.loadState();
      if (loaded) {
        this.state = {
          balance: loaded.balance,
          deployed: loaded.deployed,
          positions: loaded.positions,
          closedPositions: loaded.closedPositions,
          totalPnl: loaded.totalPnl,
          wins: loaded.wins,
          losses: loaded.losses,
          scansCompleted: loaded.scansCompleted,
        };
        this.positionCounter = loaded.positionCounter;
        this.log(
          `Resumed from state: $${loaded.balance.toFixed(2)} balance, ` +
          `${loaded.positions.length} open positions, ` +
          `${loaded.wins}W-${loaded.losses}L, saved ${loaded.savedAt}`,
          "cyan"
        );
      } else {
        this.state = this.freshState();
      }
    } else {
      this.state = this.freshState();
    }

    this.ensureCSV();
  }

  private freshState(): SimulatorState {
    return {
      balance: this.config.startingBalance,
      deployed: 0,
      positions: [],
      closedPositions: [],
      totalPnl: 0,
      wins: 0,
      losses: 0,
      scansCompleted: 0,
    };
  }

  get snapshot(): Readonly<SimulatorState> {
    return this.state;
  }

  get cfg(): Readonly<SimulatorConfig> {
    return this.config;
  }

  // ─── State persistence ───────────────────────────────────────────

  private saveState() {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

    const persisted: PersistedState = {
      config: this.config,
      balance: this.state.balance,
      deployed: this.state.deployed,
      positions: this.state.positions,
      closedPositions: this.state.closedPositions.slice(-50), // keep last 50 to avoid unbounded growth
      totalPnl: this.state.totalPnl,
      wins: this.state.wins,
      losses: this.state.losses,
      scansCompleted: this.state.scansCompleted,
      positionCounter: this.positionCounter,
      savedAt: new Date().toISOString(),
    };

    // Atomic write: temp file then rename
    const tmpPath = STATE_PATH + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(persisted, null, 2), "utf-8");
    renameSync(tmpPath, STATE_PATH);
  }

  private loadState(): PersistedState | null {
    if (!existsSync(STATE_PATH)) return null;
    try {
      const raw = readFileSync(STATE_PATH, "utf-8");
      const data = JSON.parse(raw) as PersistedState;
      // Validate it has open positions or recent activity
      if (data.positions && data.balance !== undefined) return data;
      return null;
    } catch {
      return null;
    }
  }

  /** Check if a saved state exists */
  static hasSavedState(): boolean {
    return existsSync(STATE_PATH);
  }

  /** Delete saved state (fresh start) */
  static clearSavedState() {
    if (existsSync(STATE_PATH)) {
      writeFileSync(STATE_PATH, "");
    }
  }

  // ─── CSV ─────────────────────────────────────────────────────────

  private ensureCSV() {
    if (!existsSync(RESULTS_DIR)) require("fs").mkdirSync(RESULTS_DIR, { recursive: true });
    if (!existsSync(TRADES_CSV) || readFileSync(TRADES_CSV, "utf-8").trim() === "") {
      writeFileSync(TRADES_CSV, TRADES_HEADER);
    }
  }

  private logTrade(action: string, pos: WeatherPosition) {
    const bracketStr = this.bracketLabel(pos.bracket);
    const row = [
      new Date().toISOString(),
      action,
      pos.market.city,
      pos.market.date,
      pos.market.type,
      bracketStr,
      pos.shares,
      pos.entryPrice.toFixed(4),
      pos.cost.toFixed(2),
      pos.forecastTempF.toFixed(1),
      pos.forecastProb.toFixed(4),
      pos.edge.toFixed(4),
      pos.modelSpreadF.toFixed(1),
      pos.modelCount,
      pos.hoursToResolution.toFixed(1),
      pos.pnl.toFixed(2),
      this.state.balance.toFixed(2),
    ].join(",") + "\n";
    appendFileSync(TRADES_CSV, row);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  bracketLabel(b: TempBracket): string {
    if (!isFinite(b.lowF) && isFinite(b.highF)) return `≤${b.highF}°F`;
    if (isFinite(b.lowF) && !isFinite(b.highF)) return `≥${b.lowF}°F`;
    return `${b.lowF}-${b.highF}°F`;
  }

  private log(msg: string, color?: string) {
    this.onLog?.(msg, color);
  }

  /** Gaussian random using Box-Muller transform */
  private gaussianRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /**
   * Allocate ladder budget across brackets.
   * Cheap brackets (≤$0.10) get 2x weight — that's where the 10-100x payoffs live.
   * Sizing is proportional to edge × cheapness bonus.
   */
  private allocateLadder(
    candidates: Array<{ bracket: TempBracket; prob: number; edge: number }>,
    totalBudget: number,
  ): Array<{ bracket: TempBracket; prob: number; edge: number; allocation: number }> {
    // Weight = edge × cheapness multiplier
    let totalWeight = 0;
    const weighted = candidates.map(c => {
      const price = c.bracket.outcomePrices[0];
      const cheapBonus = this.config.cheapBracketBonus && price <= 0.10 ? 2.0
        : this.config.cheapBracketBonus && price <= 0.20 ? 1.5
        : 1.0;
      const weight = c.edge * cheapBonus;
      totalWeight += weight;
      return { ...c, weight };
    });

    return weighted.map(c => ({
      bracket: c.bracket,
      prob: c.prob,
      edge: c.edge,
      allocation: totalWeight > 0
        ? Math.max(1, Math.round((c.weight / totalWeight) * totalBudget))
        : Math.round(totalBudget / candidates.length),
    }));
  }

  // ─── Core Loop ───────────────────────────────────────────────────

  async start() {
    this.running = true;
    this.log("Weather simulator v2 started (ladder strategy + ensemble forecasts)", "cyan");

    // Initial scan
    await this.scanAndTrade();

    // Periodic scan
    this.scanTimer = setInterval(async () => {
      if (!this.running) return;
      await this.scanAndTrade();
    }, this.config.scanIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.saveState();
  }

  // ─── Scan & Trade (Ladder Strategy) ──────────────────────────────

  async scanAndTrade() {
    this.log("Scanning weather markets...", "cyan");

    // 1. Check for resolved positions first
    await this.checkResolutions();

    // 2. Find markets
    let markets: WeatherMarket[];
    try {
      markets = await findWeatherMarkets({ daysAhead: this.config.daysAhead });
    } catch (err) {
      this.log(`Scan failed: ${err}`, "red");
      return;
    }

    this.log(`Found ${markets.length} active weather markets`, "dim");

    if (markets.length === 0) {
      this.state.scansCompleted++;
      this.onScanComplete?.(0);
      return;
    }

    // 3. Fetch ensemble forecasts (parallel, cached per city)
    const ensembleCache = new Map<string, EnsembleForecast | null>();
    const uniqueCities = [...new Set(markets.map(m => m.city.toLowerCase()))];

    this.log(`Fetching ensemble forecasts for ${uniqueCities.length} cities (Open-Meteo + ECMWF + GFS + NOAA)...`, "dim");

    await Promise.all(
      uniqueCities.map(async city => {
        ensembleCache.set(city, await fetchEnsembleForecast(city, this.config.daysAhead + 1));
      })
    );

    // 4. Evaluate each market with ladder strategy
    let opportunitiesFound = 0;

    for (const market of markets) {
      // Skip if already have positions in this market
      const existingPositions = this.state.positions.filter(
        p => p.market.eventId === market.eventId
      );
      if (existingPositions.length > 0) continue;

      // Total position limit
      if (this.state.positions.length >= this.config.maxTotalPositions) break;

      // Get ensemble forecast
      const ensemble = ensembleCache.get(market.city.toLowerCase());
      if (!ensemble) continue;

      const dayForecast = ensemble.forecasts.find(f => f.date === market.date);
      if (!dayForecast) continue;

      const forecastTempF = market.type === "high" ? dayForecast.ensembleHighF : dayForecast.ensembleLowF;
      const spreadF = market.type === "high" ? dayForecast.spreadHighF : dayForecast.spreadLowF;
      const endDate = new Date(market.endDate);
      const hoursToRes = Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60));

      // Log ensemble info
      const modelNames = dayForecast.models.map(m => m.name).join("+");

      // Skip markets where models disagree too much — no reliable edge
      if (spreadF > this.config.maxModelSpreadF) {
        this.log(
          `SKIP ${market.city} ${market.date} (${market.type}): spread=±${spreadF.toFixed(1)}°F > ${this.config.maxModelSpreadF}°F limit [${modelNames}]`,
          "yellow"
        );
        continue;
      }

      this.log(
        `${market.city} ${market.date} (${market.type}): ` +
        `ensemble=${forecastTempF.toFixed(0)}°F spread=±${spreadF.toFixed(1)}°F [${modelNames}]`,
        "dim"
      );

      // Evaluate ALL brackets for edge
      const candidates: Array<{ bracket: TempBracket; prob: number; edge: number }> = [];

      for (const bracket of market.brackets) {
        const prob = ensembleBracketProbability(
          forecastTempF, spreadF, bracket.lowF, bracket.highF, hoursToRes
        );
        const marketPrice = bracket.outcomePrices[0];

        // Skip dead brackets
        if (marketPrice < 0.005 || marketPrice > 0.95) continue;

        const edge = prob - marketPrice;
        if (edge >= this.config.minEdge) {
          candidates.push({ bracket, prob, edge });
        }
      }

      if (candidates.length === 0) continue;

      // Sort by edge, take top N for the ladder
      candidates.sort((a, b) => b.edge - a.edge);
      const ladderLegs = candidates.slice(0, this.config.maxLadderLegs);

      // Allocate budget across ladder legs
      const availableBudget = Math.min(
        this.config.ladderBudget,
        this.state.balance - this.state.deployed
      );
      if (availableBudget < 2) continue;

      const allocations = this.allocateLadder(ladderLegs, availableBudget);
      const ladderGroup = `${market.city}-${market.date}-${market.type}`;
      let ladderCost = 0;
      let ladderLegsOpened = 0;

      this.log(
        `LADDER ${market.city} ${market.date} (${market.type}) — ` +
        `${allocations.length} legs, budget=$${availableBudget.toFixed(2)}`,
        "cyan"
      );

      for (const { bracket, prob, edge, allocation } of allocations) {
        const entryPrice = bracket.outcomePrices[0];
        const shares = Math.floor(allocation / entryPrice);
        if (shares < 1) continue;

        const cost = shares * entryPrice;
        if (cost > this.state.balance - this.state.deployed) continue;

        const pos: WeatherPosition = {
          id: `WP-${++this.positionCounter}`,
          market,
          bracket,
          shares,
          entryPrice,
          cost,
          forecastTempF,
          forecastProb: prob,
          edge,
          modelSpreadF: spreadF,
          modelCount: dayForecast.modelCount,
          hoursToResolution: hoursToRes,
          entryTime: new Date().toISOString(),
          status: "open",
          pnl: 0,
          ladderGroup,
        };

        this.state.positions.push(pos);
        this.state.deployed += cost;
        this.state.balance -= cost;
        ladderCost += cost;
        ladderLegsOpened++;

        this.logTrade("BUY", pos);
        this.onPositionOpened?.(pos);
        opportunitiesFound++;

        const payoff = (shares * 1.0 / cost).toFixed(0);
        this.log(
          `  LEG ${this.bracketLabel(bracket)} ` +
          `${shares}sh @ $${entryPrice.toFixed(2)} ($${cost.toFixed(2)}) ` +
          `prob=${(prob * 100).toFixed(0)}% edge=+${(edge * 100).toFixed(0)}% ` +
          `payoff=${payoff}:1`,
          "green"
        );
      }

      if (ladderLegsOpened > 0) {
        this.log(
          `  → ${ladderLegsOpened} legs opened, total cost=$${ladderCost.toFixed(2)}`,
          "cyan"
        );
      }
    }

    this.state.scansCompleted++;
    this.saveState();
    this.onScanComplete?.(opportunitiesFound);
    this.onDashboardUpdate?.();
  }

  // ─── Fetch actual recorded temperature ──────────────────────────

  private cToF(c: number): number {
    return Math.round((c * 9 / 5 + 32) * 10) / 10;
  }

  /**
   * Fetch the real recorded high/low from Open-Meteo archive API.
   * Returns null if data isn't available yet (archive has ~1-2 day lag).
   */
  private async fetchActualTemp(
    city: string,
    date: string,
    type: "high" | "low",
  ): Promise<{ tempF: number; source: string } | null> {
    // Find coordinates
    const key = Object.keys(CITY_COORDS).find(
      k => k === city.toLowerCase() || city.toLowerCase().includes(k) || k.includes(city.toLowerCase())
    );
    if (!key) return null;
    const [lat, lon] = CITY_COORDS[key];

    // Try Open-Meteo archive API first (most reliable for past data)
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${date}&end_date=${date}`;
      const res = await fetchWithRetry(url, { timeout: 10_000 }, { maxRetries: 1 });
      const data = await res.json();

      if (data.daily?.time?.length > 0) {
        const tempC = type === "high"
          ? data.daily.temperature_2m_max[0]
          : data.daily.temperature_2m_min[0];

        if (tempC !== null && tempC !== undefined) {
          return { tempF: this.cToF(tempC), source: "archive" };
        }
      }
    } catch {}

    // Fallback: try the forecast API (has recent past days via past_days param)
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&past_days=5&forecast_days=1`;
      const res = await fetchWithRetry(url, { timeout: 10_000 }, { maxRetries: 1 });
      const data = await res.json();

      if (data.daily?.time) {
        const idx = (data.daily.time as string[]).indexOf(date);
        if (idx >= 0) {
          const tempC = type === "high"
            ? data.daily.temperature_2m_max[idx]
            : data.daily.temperature_2m_min[idx];

          if (tempC !== null && tempC !== undefined) {
            return { tempF: this.cToF(tempC), source: "forecast-pastdays" };
          }
        }
      }
    } catch {}

    return null;
  }

  // ─── Resolution ──────────────────────────────────────────────────

  async checkResolutions() {
    const now = Date.now();
    const toResolve: WeatherPosition[] = [];
    const notReady: WeatherPosition[] = [];

    for (const pos of this.state.positions) {
      const endMs = new Date(pos.market.endDate).getTime();
      if (now >= endMs) {
        toResolve.push(pos);
      }
    }

    if (toResolve.length === 0) return;

    // Group by market for batch resolution
    const byMarket = new Map<string, WeatherPosition[]>();
    for (const pos of toResolve) {
      const key = pos.market.eventId;
      if (!byMarket.has(key)) byMarket.set(key, []);
      byMarket.get(key)!.push(pos);
    }

    const resolved: WeatherPosition[] = [];

    for (const [_, positions] of byMarket) {
      const market = positions[0].market;

      // Fetch ACTUAL recorded temperature
      const actual = await this.fetchActualTemp(market.city, market.date, market.type);

      if (!actual) {
        // Data not available yet — keep positions open, will retry next scan
        this.log(
          `PENDING ${market.city} ${market.date} (${market.type}) — ` +
          `actual temp not yet available, will retry next scan`,
          "yellow"
        );
        continue;
      }

      const actualTempF = actual.tempF;
      const ladderCost = positions.reduce((s, p) => s + p.cost, 0);
      this.log(
        `RESOLVING ${market.city} ${market.date} (${market.type}) — ` +
        `Actual: ${actualTempF}°F [${actual.source}] ` +
        `(${positions.length} legs, $${ladderCost.toFixed(2)} deployed)`,
        "magenta"
      );

      let ladderPnl = 0;

      for (const pos of positions) {
        const b = pos.bracket;
        const inBracket = actualTempF >= (isFinite(b.lowF) ? b.lowF : -Infinity)
          && actualTempF <= (isFinite(b.highF) ? b.highF : Infinity);

        if (inBracket) {
          const payout = pos.shares * 1.0;
          pos.pnl = payout - pos.cost;
          pos.status = "won";
          this.state.balance += payout;
          this.state.wins++;
          this.log(
            `  WON  ${this.bracketLabel(b)} → ${pos.shares}sh × $1.00 = $${payout.toFixed(2)} (cost $${pos.cost.toFixed(2)}) → +$${pos.pnl.toFixed(2)}`,
            "green"
          );
        } else {
          pos.pnl = -pos.cost;
          pos.status = "lost";
          this.state.losses++;
          this.log(
            `  LOST ${this.bracketLabel(b)} → -$${pos.cost.toFixed(2)}`,
            "red"
          );
        }

        pos.resolvedAt = new Date().toISOString();
        pos.resolvedTempF = actualTempF;
        this.state.deployed -= pos.cost;
        this.state.totalPnl += pos.pnl;
        ladderPnl += pos.pnl;

        this.logTrade(pos.status === "won" ? "WON" : "LOST", pos);
        this.onPositionClosed?.(pos);
      }

      const ladderColor = ladderPnl >= 0 ? "green" : "red";
      this.log(
        `  LADDER NET: ${ladderPnl >= 0 ? "+" : ""}$${ladderPnl.toFixed(2)} ` +
        `(${positions.filter(p => p.status === "won").length} hit / ${positions.length} legs)`,
        ladderColor
      );

      resolved.push(...positions);
    }

    if (resolved.length === 0) return;

    // Move only resolved positions to closed (keep pending ones open)
    this.state.closedPositions.push(...resolved);
    this.state.positions = this.state.positions.filter(p => p.status === "open");
    this.saveState();
    this.onDashboardUpdate?.();
  }

  // ─── Manual trigger for testing ──────────────────────────────────

  /**
   * Force-resolve all positions. Only works for past dates where
   * actual temperature data is available from the archive API.
   * Future-dated positions will stay as PENDING.
   */
  async forceResolveAll() {
    for (const pos of this.state.positions) {
      pos.market = { ...pos.market, endDate: new Date(Date.now() - 1000).toISOString() };
    }
    await this.checkResolutions();
  }
}
