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
import { fetchObservedHigh, findWinningBracket, type ObservedTemp } from "./WeatherObserver";
import { detectSameDayLock, lockedBracketProbability, type METARLockResult } from "./METARObserver";
import { kalshiFee } from "./KalshiFees";
import { fetchWithRetry } from "../net/fetchWithRetry";
import { KalshiClient } from "../kalshi/KalshiClient";
import type { KalshiExecutor } from "../kalshi/KalshiExecutor";
import { appendFileSync, existsSync, writeFileSync, readFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";

/** Pluggable market finder — allows swapping Polymarket for Kalshi */
export type MarketFinderFn = (options?: {
  city?: string;
  daysAhead?: number;
}) => Promise<WeatherMarket[]>;

// City coordinates for archive API lookups
// US cities use NWS CLI station (airport ASOS) — matches resolution source
const CITY_COORDS: Record<string, [number, number]> = {
  "new york city": [40.7790, -73.9692],  // Central Park (KNYC)
  "atlanta":       [33.6367, -84.4281],  // Hartsfield (KATL)
  "dallas":        [32.8968, -97.0380],  // DFW (KDFW)
  "seattle":       [47.4490, -122.3093], // Sea-Tac (KSEA)
  "chicago":       [41.7860, -87.7524],  // Midway (KMDW)
  "miami":         [25.7933, -80.2906],  // MIA (KMIA)
  "los angeles":   [33.9425, -118.4081], // LAX (KLAX)
  "austin":        [30.1945, -97.6699],  // Bergstrom (KAUS)
  "denver":        [39.8617, -104.6732], // DIA (KDEN)
  "houston":       [29.6454, -95.2789],  // Hobby (KHOU)
  "phoenix":       [33.4343, -112.0117], // Sky Harbor (KPHX)
  "boston":         [42.3631, -71.0064],  // Logan (KBOS)
  "las vegas":     [36.0803, -115.1524], // Reid (KLAS)
  "minneapolis":   [44.8820, -93.2218],  // MSP (KMSP)
  "philadelphia":  [39.8721, -75.2407],  // PHL (KPHL)
  "san francisco": [37.6188, -122.3754], // SFO (KSFO)
  "san antonio":   [29.5340, -98.4691],  // SAT (KSAT)
  "washington dc": [38.8514, -77.0377],  // Reagan (KDCA)
  // International cities (Polymarket) — city center coords
  "london":      [51.5074, -0.1278],
  "paris":       [48.8566, 2.3522],
  "tokyo":       [35.6762, 139.6503],
  "seoul":       [37.5665, 126.9780],
  "beijing":     [39.9042, 116.4074],
  "shanghai":    [31.2304, 121.4737],
  "hong kong":   [22.3193, 114.1694],
  "taipei":      [25.0330, 121.5654],
  "toronto":     [43.6532, -79.3832],
  "mexico city": [19.4326, -99.1332],
  "madrid":      [40.4168, -3.7038],
  "ankara":      [39.9334, 32.8597],
  "wellington":  [-41.2865, 174.7762],
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
  /** Minimum bracket price to consider (skip penny brackets with no liquidity) */
  minBracketPrice: number;
  /** Minimum yes_bid required (ensures there's a real buyer — 0 means no ask) */
  minYesBid: number;
  /** Maximum bracket distance from forecast in sigmas — skips unreliable tail bets */
  maxTailSigma: number;
  /** Maximum edge to accept (skip "too good to be true" bets — market probably knows) */
  maxEdge: number;
  /** Maximum hours-to-resolution at entry time — blocks far-horizon bets where NWP error is too wide */
  maxHoursToEntry: number;
  /** Custom market finder function — defaults to Polymarket's findWeatherMarkets */
  marketFinder?: MarketFinderFn;
  /** Exchange label for display/logging */
  exchange?: "polymarket" | "kalshi";

  /**
   * Trading mode:
   *   - "paper" (default): fills against simulated prices, no real orders
   *   - "live": places REAL orders via KalshiExecutor (production OR demo)
   * For "live", pass a KalshiExecutor in the constructor.
   */
  mode?: "paper" | "live";

  // ─── Strategy selection ─────────────────────────────────────────
  /**
   * Which scan strategy to run:
   *  - "ladder": multi-bracket edge-weighted ladder (original — unprofitable)
   *  - "intrinsic": buy the market's favorite bracket at $0.70-$0.95
   *  - "ensemble_forecast": use 82-member GFS+ECMWF ensemble to pick winners
   *    at T-24h entry, before market convergence. Tape backtest +68% ROI on 17 bets.
   */
  strategy?: "ladder" | "intrinsic" | "ensemble_forecast";
  /** Hours before close to target for intrinsic entry (default 8) */
  intrinsicHoursBefore?: number;
  /** Tolerance window — accept markets within ±this hours of target (default 4) */
  intrinsicWindowHours?: number;
  /** Min favorite price (default 0.70) */
  intrinsicMinPrice?: number;
  /** Max favorite price (default 0.95) */
  intrinsicMaxPrice?: number;
  /** Min gap between favorite and runner-up (default 0.05) */
  intrinsicMinGap?: number;
  /** Budget per intrinsic bet (default 3) */
  intrinsicBetSize?: number;

  // ─── Ensemble-forecast strategy ─────────────────────────────────
  /** Hours before close to evaluate (default 24) */
  ensembleHoursBefore?: number;
  /** Tolerance window hours (default 12 — wide to catch opportunities) */
  ensembleWindowHours?: number;
  /** Min ensemble probability to bet (default 0.40) */
  ensembleMinProb?: number;
  /** Max entry price in dollars (default 0.30 — entries above this lose
   *  reliably per live data; the cheapest brackets carry the strategy) */
  ensembleMaxPrice?: number;
  /** Min entry price in dollars (default 0.07 — entries below this are
   *  lottery tickets that historically don't hit; the win rate at sub-5¢
   *  was 0/4 in early live data) */
  ensembleMinPrice?: number;
  /** Budget per bet (default 10). Actual bet size is multiplied by the
   *  high-confidence multiplier when edge is large; see ensembleHighConfMult. */
  ensembleBetSize?: number;
  /** Multiplier applied to ensembleBetSize when edge ≥ ensembleHighConfEdge.
   *  Default 1.5 — bets 50% more capital on high-conviction setups.
   *  Always still capped by KalshiExecutor's maxPerOrderUSD. */
  ensembleHighConfMult?: number;
  /** Edge threshold above which the high-conf multiplier kicks in (default 0.30) */
  ensembleHighConfEdge?: number;

  // ─── Multi-bracket ladder mode (opt-in) ──────────────────────────
  /** Number of brackets per event to bet on. 1 (default) = single-bracket
   *  (current behavior). 2-3 = ladder mode that splits the bet across the
   *  top N highest-probability brackets. Backtest evidence suggests +13-17pp
   *  ROI lift at top-3 vs top-1 with prob-weighted sizing. */
  ensembleLadderTopN?: number;
  /** Min probability for a non-top pick to qualify in ladder mode. The top
   *  pick still uses ensembleMinProb. Default 0.20 — letting the rank-2/3
   *  bracket qualify even when its prob is well below the top pick's. */
  ensembleLadderMinProb?: number;
  /** Sizing scheme across the top-N picks:
   *    "even"          → equal split (e.g. 50/50 for n=2)
   *    "front-loaded"  → preset (60/40 for n=2, 50/30/20 for n=3)
   *    "weighted"      → split proportional to model probabilities
   *  Default "weighted". */
  ensembleLadderSizing?: "even" | "front-loaded" | "weighted";

  // ─── KXLOW (daily-low-temp) markets opt-in ──────────────────────
  /** Include KXLOW (daily-low) markets alongside KXHIGH. Default false.
   *  When enabled, the simulator queries both market types and dispatches
   *  to lowF_members vs highF_members based on each market's `type` field. */
  ensembleIncludeLows?: boolean;

  // ─── Persistence overrides (for running multiple bots in parallel) ─
  /** Custom state file path (defaults to state/weather-sim.json) */
  stateFilePath?: string;
  /** Custom trades CSV path (defaults to results/weather-trades.csv) */
  tradesCsvPath?: string;
  /** Instance name for logging (default "sim") */
  instanceName?: string;

  // ─── Snipe mode ─────────────────────────────────────────────────
  /** Enable late-day sniping — buy the winning bracket after actual temp is observed */
  snipeEnabled: boolean;
  /** Max price to pay for the winning bracket (e.g., 0.92 = need ≥8% edge) */
  snipeMaxPrice: number;
  /** Budget per snipe (single bracket, not a ladder) */
  snipeBudget: number;
  /** Minimum confidence level to fire: "partial" | "likely_final" | "final" */
  snipeMinConfidence: "partial" | "likely_final" | "final";
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
  minEdge: 0.10,           // backtest shows 0.10 yields +152% ROI vs 0.15 at +39% (5-run mean)
  ladderBudget: 15,        // $15 spread across 4-6 brackets per market
  maxLadderLegs: 6,
  maxTotalPositions: 50,
  scanIntervalMs: 5 * 60 * 1000,
  daysAhead: 3,
  resolveWithNoise: true,
  cheapBracketBonus: false,  // deprecated — sizing is now pure edge-weighted
  maxModelSpreadF: 4.0,    // skip when models disagree by >4°F
  minBracketPrice: 0.03,   // skip $0.01-$0.02 brackets (no real liquidity)
  minYesBid: 0,            // 0 = don't filter by bid (Kalshi penny markets have no bids)
  maxTailSigma: 0.8,       // skip brackets where forecast is >0.8σ outside the bracket
  maxEdge: 0.40,           // skip suspiciously large edge (market probably knows better)
  maxHoursToEntry: 36,     // only enter within 36h of resolution — NWP error too wide beyond that
  exchange: "polymarket",
  // Snipe defaults (disabled by default — enable for Kalshi)
  snipeEnabled: false,
  snipeMaxPrice: 0.92,     // max 92¢ for the winner = min 8% return
  snipeBudget: 25,         // $25 per snipe (single winning bracket)
  snipeMinConfidence: "likely_final",
  // Strategy defaults
  strategy: "ladder",
  intrinsicHoursBefore: 8,
  intrinsicWindowHours: 4,
  intrinsicMinPrice: 0.70,
  intrinsicMaxPrice: 0.95,
  intrinsicMinGap: 0.05,
  intrinsicBetSize: 3,
  // Ensemble-forecast defaults — calibrated against early live data:
  // - maxPrice 0.30: entries $0.30+ lost 5/6 in first 16 trades
  // - minPrice 0.07: entries below 5¢ won 0/4 (too far OOM)
  // - highConfMult 1.5: edge≥30% trades had 50% WR / +390% ROI vs baseline 25%/+36%
  ensembleHoursBefore: 24,
  ensembleWindowHours: 12,
  ensembleMinProb: 0.40,
  ensembleMaxPrice: 0.30,
  ensembleMinPrice: 0.07,
  ensembleBetSize: 10,
  ensembleHighConfMult: 1.5,
  ensembleHighConfEdge: 0.30,
  // Multi-bracket ladder defaults — OFF by default, current single-bracket
  // behavior preserved. Set ensembleLadderTopN ≥ 2 to opt in.
  ensembleLadderTopN: 1,
  ensembleLadderMinProb: 0.20,
  ensembleLadderSizing: "weighted" as const,
  // KXLOW expansion — OFF by default for back-compat.
  ensembleIncludeLows: false,
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
  /** Markets we've already resolved — never re-buy these */
  resolvedMarketKeys: string[];
  /** Markets we've already placed ladders on (open or closed) — prevents duplicate ladders */
  activeLadderKeys: string[];
  /** Snipe keys we've fired — survives restarts, prevents re-orders on same ticker */
  snipedKeys?: string[];
  /** Intrinsic keys we've fired */
  intrinsicKeys?: string[];
  /** Ensemble keys we've fired */
  ensembleFiredKeys?: string[];
  savedAt: string;
}

// ─── Simulator ───────────────────────────────────────────────────────

export class WeatherSimulator {
  private config: SimulatorConfig;
  private state: SimulatorState;
  private positionCounter = 0;
  private running = false;
  /** Per-instance paths — overridable for running multiple bots in parallel */
  private statePath: string;
  private tradesCsv: string;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  /** Markets that have been fully resolved — never re-buy these (keyed as "city-date-type") */
  private resolvedMarketKeys = new Set<string>();
  /** Markets with active or closed ladders this session — prevents duplicate ladders */
  private activeLadderKeys = new Set<string>();

  // Callbacks for terminal runner
  onLog?: (msg: string, color?: string) => void;
  onPositionOpened?: (pos: WeatherPosition) => void;
  onPositionClosed?: (pos: WeatherPosition) => void;
  onScanComplete?: (opportunities: number) => void;
  onDashboardUpdate?: () => void;

  /** Live trading executor — must be set when config.mode === "live" */
  executor: KalshiExecutor | null = null;

  constructor(config?: Partial<SimulatorConfig>, resume: boolean = false) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.statePath = this.config.stateFilePath ?? STATE_PATH;
    this.tradesCsv = this.config.tradesCsvPath ?? TRADES_CSV;

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

        // Rebuild dedup sets from persisted keys + position data
        if (loaded.resolvedMarketKeys) {
          for (const key of loaded.resolvedMarketKeys) this.resolvedMarketKeys.add(key);
        }
        if (loaded.activeLadderKeys) {
          for (const key of loaded.activeLadderKeys) this.activeLadderKeys.add(key);
        }
        // Restore strategy-specific fire keys so restarts don't re-order same tickers
        if (loaded.snipedKeys) {
          for (const key of loaded.snipedKeys) this.snipedKeys.add(key);
        }
        if (loaded.intrinsicKeys) {
          for (const key of loaded.intrinsicKeys) this.intrinsicKeys.add(key);
        }
        if (loaded.ensembleFiredKeys) {
          for (const key of loaded.ensembleFiredKeys) this.ensembleFiredKeys.add(key);
        }
        // Also rebuild from actual positions
        for (const pos of loaded.closedPositions) {
          const key = `${pos.market.city.toLowerCase()}-${pos.market.date}-${pos.market.type}`;
          this.resolvedMarketKeys.add(key);
          this.activeLadderKeys.add(key);
        }
        for (const pos of loaded.positions) {
          const key = `${pos.market.city.toLowerCase()}-${pos.market.date}-${pos.market.type}`;
          this.activeLadderKeys.add(key);
          // If a position exists on a ticker, we've fired for it — add to all dedup sets
          if (pos.ladderGroup?.startsWith("intrinsic-")) this.intrinsicKeys.add(`intrinsic-${pos.market.city.toLowerCase()}-${pos.market.date}`);
          if (pos.ladderGroup?.startsWith("ensemble-")) this.ensembleFiredKeys.add(`ensemble-${pos.market.city.toLowerCase()}-${pos.market.date}`);
          if (pos.ladderGroup?.startsWith("snipe-")) this.snipedKeys.add(`snipe-${pos.market.city.toLowerCase()}-${pos.market.date}`);
        }

        this.log(
          `Resumed from state: $${loaded.balance.toFixed(2)} balance, ` +
          `${loaded.positions.length} open positions, ` +
          `${loaded.wins}W-${loaded.losses}L, ` +
          `${this.resolvedMarketKeys.size} resolved markets, saved ${loaded.savedAt}`,
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
      closedPositions: this.state.closedPositions.slice(-50),
      totalPnl: this.state.totalPnl,
      wins: this.state.wins,
      losses: this.state.losses,
      scansCompleted: this.state.scansCompleted,
      positionCounter: this.positionCounter,
      resolvedMarketKeys: [...this.resolvedMarketKeys],
      activeLadderKeys: [...this.activeLadderKeys],
      snipedKeys: [...this.snipedKeys],
      intrinsicKeys: [...this.intrinsicKeys],
      ensembleFiredKeys: [...this.ensembleFiredKeys],
      savedAt: new Date().toISOString(),
    };

    // Atomic write: temp file then rename
    const tmpPath = this.statePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(persisted, null, 2), "utf-8");
    renameSync(tmpPath, this.statePath);
  }

  private loadState(): PersistedState | null {
    if (!existsSync(this.statePath)) return null;
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      const data = JSON.parse(raw) as PersistedState;
      // Validate it has open positions or recent activity
      if (data.positions && data.balance !== undefined) return data;
      return null;
    } catch {
      return null;
    }
  }

  /** Check if a saved state exists (default path) */
  static hasSavedState(path: string = STATE_PATH): boolean {
    return existsSync(path);
  }

  /** Delete saved state (fresh start, default path) */
  static clearSavedState(path: string = STATE_PATH) {
    if (existsSync(path)) {
      writeFileSync(path, "");
    }
  }

  // ─── CSV ─────────────────────────────────────────────────────────

  private ensureCSV() {
    const dir = this.tradesCsv.substring(0, this.tradesCsv.lastIndexOf("/"));
    if (dir && !existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
    if (!existsSync(this.tradesCsv) || readFileSync(this.tradesCsv, "utf-8").trim() === "") {
      writeFileSync(this.tradesCsv, TRADES_HEADER);
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
    appendFileSync(this.tradesCsv, row);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  bracketLabel(b: TempBracket): string {
    // Use nullish/finite check — isFinite(null) returns true in JS (null → 0),
    // so we need an explicit null/undefined check for tail brackets restored from state
    const hasLow = b.lowF != null && isFinite(b.lowF);
    const hasHigh = b.highF != null && isFinite(b.highF);
    if (!hasLow && hasHigh) return `≤${b.highF}°F`;
    if (hasLow && !hasHigh) return `≥${b.lowF}°F`;
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
    // Weight = edge only. The cheap bracket bonus was removed after live sim
    // showed it amplified sizing on overpriced tail bets (our Gaussian model
    // overstates tail probabilities, and cheap brackets ARE the tails).
    // Size is now proportional to edge — confidence translates directly to $.
    let totalWeight = 0;
    const weighted = candidates.map(c => {
      const weight = c.edge;
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
    const snipeTag = this.config.snipeEnabled ? " + snipe mode" : "";
    this.log(`Weather simulator v2 started (ladder strategy + ensemble forecasts${snipeTag})`, "cyan");

    // One-time audit: check closed positions against Kalshi's official result.
    // Catches any past resolutions that used a fallback data source and got the
    // outcome wrong (e.g. METAR hourly peak missing the true daily max).
    if (this.config.exchange === "kalshi" && this.state.closedPositions.length > 0) {
      this.log("Auditing closed positions against Kalshi official results...", "cyan");
      await this.auditClosedPositions();
    }

    // Reconcile state counters (deployed/totalPnl/balance) from positions
    // as source of truth. Fixes any drift from bugs like missed balance
    // deductions on snipe entries (observed Apr 20 — $45 phantom balance).
    const { changes } = this.reconcileState();
    if (Object.keys(changes).length > 0) {
      this.log("State reconciliation applied:", "cyan");
      for (const [k, [b, a]] of Object.entries(changes)) {
        this.log(`  ${k}: ${b.toFixed(2)} → ${a.toFixed(2)}  (Δ ${(a - b).toFixed(2)})`, "yellow");
      }
      this.saveState();
    } else {
      this.log("State reconciliation: counters already consistent ✓", "dim");
    }

    // Dispatch to strategy
    const strategy = this.config.strategy ?? "ladder";
    const runScan = async () => {
      if (strategy === "intrinsic") {
        await this.scanForIntrinsicWinners();
        await this.checkResolutions();
      } else if (strategy === "ensemble_forecast") {
        await this.scanForEnsembleForecasts();
        await this.checkResolutions();
      } else {
        await this.scanAndTrade();
        if (this.config.snipeEnabled) await this.scanForSnipes();
      }
    };

    this.log(`Strategy: ${strategy}`, "cyan");
    await runScan();

    // Periodic scan
    this.scanTimer = setInterval(async () => {
      if (!this.running) return;
      await runScan();
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

    // 2. Find markets (uses pluggable finder — Polymarket or Kalshi)
    const finder = this.config.marketFinder ?? findWeatherMarkets;
    let markets: WeatherMarket[];
    try {
      markets = await finder({ daysAhead: this.config.daysAhead });
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
      const marketKey = `${market.city.toLowerCase()}-${market.date}-${market.type}`;

      // Skip if already resolved — prevents the re-buy loop bug
      if (this.resolvedMarketKeys.has(marketKey)) {
        continue;
      }

      // Skip if we already have an active/closed ladder on this market
      if (this.activeLadderKeys.has(marketKey)) {
        continue;
      }

      // Belt-and-suspenders: also check open positions by eventId
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

      // Horizon filter: skip far-out markets where forecast error is too wide.
      // Normal NWP error at 72h is 3-5°F — that covers 2-3 of our 2°F brackets,
      // so per-bracket probabilities are mostly noise. Wait until we're closer.
      if (hoursToRes > this.config.maxHoursToEntry) {
        this.log(
          `SKIP ${market.city} ${market.date} (${market.type}): ${hoursToRes.toFixed(1)}h horizon > ${this.config.maxHoursToEntry}h limit — forecast error too wide`,
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

      // GFS 31-member distribution for this day/side (if available).
      // When present, ensembleBracketProbability uses empirical counting.
      const members = market.type === "high"
        ? dayForecast.highFMembers
        : dayForecast.lowFMembers;

      for (const bracket of market.brackets) {
        const prob = ensembleBracketProbability(
          forecastTempF, spreadF, bracket.lowF, bracket.highF, hoursToRes, members
        );
        const marketPrice = bracket.outcomePrices[0];

        // Skip dead brackets
        if (marketPrice < 0.005 || marketPrice > 0.95) continue;

        // Liquidity filter: skip penny brackets with no real market
        // On Kalshi, $0.01 brackets typically have yes_bid=$0.00 — nobody is
        // actually offering to sell at that price. The "edge" is an illusion.
        if (marketPrice < this.config.minBracketPrice) continue;

        // Optional bid-side filter: if the bracket has _yesBid data, check it
        const yesBid = (bracket as any)._yesBid;
        if (this.config.minYesBid > 0 && typeof yesBid === "number" && yesBid < this.config.minYesBid) continue;

        // Tail-bracket filter: skip brackets whose nearest edge is more than
        // maxTailSigma σ AWAY from the forecast (i.e. forecast is outside the
        // bracket by a large margin). Our Gaussian overstates tail probs because
        // real weather errors are fatter-body/thinner-tail than N(μ,σ), and our
        // σ is model agreement (too narrow). This blocks "hope" bets on distant
        // brackets — NOT covering bets where forecast is inside the bracket.
        const effSigma = Math.max(1.5, Math.sqrt(
          (hoursToRes <= 12 ? 1.5 : hoursToRes <= 24 ? 2.0 : hoursToRes <= 48 ? 3.0 : hoursToRes <= 72 ? 4.0 : 5.0) ** 2
          + spreadF ** 2
        ));
        const bLow = (bracket.lowF != null && isFinite(bracket.lowF)) ? bracket.lowF : -Infinity;
        const bHigh = (bracket.highF != null && isFinite(bracket.highF)) ? bracket.highF : Infinity;
        // Distance from forecast to the nearest bracket edge, signed:
        // negative/zero if forecast is INSIDE the bracket (distance = 0)
        // positive if forecast is OUTSIDE the bracket (distance to near edge)
        let distAway = 0;
        if (forecastTempF < bLow) distAway = bLow - forecastTempF;
        else if (forecastTempF > bHigh) distAway = forecastTempF - bHigh;
        const distSigmas = distAway / effSigma;
        if (distSigmas > this.config.maxTailSigma) continue;

        const edge = prob - marketPrice;
        // Skip suspiciously large edges — if our model says +40% over the market,
        // the market probably knows something we don't (or our model is wrong).
        // Exception: if forecast is INSIDE the bracket (distAway=0), high edge
        // is legitimate — it's just thin market liquidity on an obvious bracket,
        // not market disagreement. Only apply maxEdge to tail bets.
        const isTailBet = distAway > 0;
        if (isTailBet && edge > this.config.maxEdge) continue;
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
        this.state.balance
      );
      if (availableBudget < 2) continue;

      const allocations = this.allocateLadder(ladderLegs, availableBudget);
      const ladderGroup = `${market.city}-${market.date}-${market.type}`;
      let ladderCost = 0;
      let ladderLegsOpened = 0;

      // Mark this market as having an active ladder BEFORE placing legs
      // This prevents duplicate ladders even if the next scan runs before legs are placed
      this.activeLadderKeys.add(marketKey);

      this.log(
        `LADDER ${market.city} ${market.date} (${market.type}) — ` +
        `${allocations.length} legs, budget=$${availableBudget.toFixed(2)}`,
        "cyan"
      );

      for (const { bracket, prob, edge, allocation } of allocations) {
        let entryPrice = bracket.outcomePrices[0];
        let shares = Math.floor(allocation / entryPrice);
        if (shares < 1) continue;

        let cost = shares * entryPrice;
        if (cost > this.state.balance) continue;

        // ─── LIVE MODE: place real Kalshi order ───
        if (this.config.mode === "live" && this.executor) {
          const ticker = (bracket as any)._kalshiTicker || (bracket as any).slug;
          if (!ticker) {
            this.log(`  SKIP: no Kalshi ticker for bracket`, "yellow");
            continue;
          }
          const result = await this.executor.placeOrder({
            ticker,
            side: "yes",
            askPrice: entryPrice,
            maxShares: shares,
            budget: allocation,
          });
          if (!result.success) {
            // Log reason and skip this leg — keep scanning
            continue;
          }
          // Update from actual fill
          shares = result.filledShares;
          entryPrice = result.avgPriceDollars;
          cost = result.filledCostUSD;
        }

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

  // ─── Snipe Mode ────────────────────────────────────────────────
  //
  // After the daily high is recorded (typically by 5-6pm local), the
  // outcome of the KXHIGH market is effectively known — but the market
  // stays open until ~1am ET. If the winning bracket's ask is stale
  // (still below $0.92), buy it for a near-guaranteed return.

  /** Set of snipe keys we've already fired — prevents duplicate snipes */
  private snipedKeys = new Set<string>();

  // ─── Intrinsic-winner strategy ─────────────────────────────────
  //
  // Tape analysis of 462k KXHIGH fills showed takers in cheap brackets
  // ($0.03-$0.30) lose ~$0.04/share, while takers in $0.70-$0.95 brackets
  // 4-12h before close win ~$0.05/share. This scan implements the
  // profitable side:
  //
  //   1. Each event: find the bracket the MARKET thinks is most likely
  //      (highest yes_ask/mid price).
  //   2. Verify favorite is in [minPrice, maxPrice] and has meaningful
  //      gap over runner-up.
  //   3. Verify time-to-close is in the 4-12h sweet spot.
  //   4. Buy the favorite. Hold to resolution.
  //
  // Tape replay: 17 bets, 94% WR, +5.6% ROI, no forecast needed.

  /** Set of intrinsic keys we've already fired — prevents duplicate bets per market */
  private intrinsicKeys = new Set<string>();

  // ─── Ensemble-forecast strategy ─────────────────────────────────
  //
  // Uses the 82-member GFS+ECMWF ensemble to identify the most likely winning
  // bracket at T-24h before close, entering while market prices are still
  // uncertain (avg ~$0.30-$0.50 for winners at this horizon per tape analysis).
  //
  // Tape backtest: ~33% accuracy, avg entry $0.20, +68% ROI on 17 bets.
  // Break-even WR at these prices is ~21%.

  /** Set of ensemble bets already fired per market */
  private ensembleFiredKeys = new Set<string>();

  async scanForEnsembleForecasts() {
    this.log("Ensemble-forecast scan — 82-member ensemble pick at T-24h window...", "magenta");

    const finder = this.config.marketFinder ?? findWeatherMarkets;
    let markets: WeatherMarket[];
    try {
      markets = await finder({ daysAhead: 2 });
    } catch (err) {
      this.log(`Ensemble scan fetch failed: ${err}`, "red");
      return;
    }

    const now = Date.now();
    const targetH = this.config.ensembleHoursBefore ?? 24;
    const windowH = this.config.ensembleWindowHours ?? 12;
    const minProb = this.config.ensembleMinProb ?? 0.40;
    const maxPrice = this.config.ensembleMaxPrice ?? 0.30;
    const minPrice = this.config.ensembleMinPrice ?? 0.07;
    const betSize = this.config.ensembleBetSize ?? 10;
    const highConfMult = this.config.ensembleHighConfMult ?? 1.5;
    const highConfEdge = this.config.ensembleHighConfEdge ?? 0.30;
    const ladderTopN = Math.max(1, this.config.ensembleLadderTopN ?? 1);
    const ladderMinProb = this.config.ensembleLadderMinProb ?? 0.20;
    const ladderSizing = this.config.ensembleLadderSizing ?? "weighted";
    const includeLows = this.config.ensembleIncludeLows ?? false;

    // Process both KXHIGH and (optionally) KXLOW markets. Dispatched per-market
    // to the right ensemble member set based on type.
    const eligibleMarkets = markets.filter(
      m => m.type === "high" || (includeLows && m.type === "low"),
    );
    let fired = 0;

    for (const market of eligibleMarkets) {
      // Include market.type in the dedup key so KXHIGH and KXLOW for the same
      // city+date are treated as separate fire targets.
      const key = `ensemble-${market.city.toLowerCase()}-${market.date}-${market.type}`;
      if (this.ensembleFiredKeys.has(key)) continue;

      const hoursToClose = (new Date(market.endDate).getTime() - now) / (1000 * 60 * 60);
      if (hoursToClose < targetH - windowH || hoursToClose > targetH + windowH) continue;

      // Fetch the 82-member ensemble forecast for this city
      const ensemble = await fetchEnsembleForecast(market.city, 3);
      if (!ensemble) {
        this.log(`ENSEMBLE skip ${market.city} ${market.type}: forecast fetch failed`, "dim");
        continue;
      }
      const dayForecast = ensemble.forecasts.find(f => f.date === market.date);
      if (!dayForecast) {
        this.log(`ENSEMBLE skip ${market.city} ${market.date} ${market.type}: no day forecast`, "dim");
        continue;
      }
      // Dispatch member array: highFMembers for KXHIGH, lowFMembers for KXLOW
      const members = market.type === "low" ? dayForecast.lowFMembers : dayForecast.highFMembers;
      const memberMean = market.type === "low" ? dayForecast.ensembleLowF : dayForecast.ensembleHighF;
      const memberSpread = market.type === "low" ? dayForecast.spreadLowF : dayForecast.spreadHighF;
      if (!members || members.length < 20) {
        this.log(`ENSEMBLE skip ${market.city} ${market.date} ${market.type}: no member data (${members?.length ?? 0})`, "dim");
        continue;
      }

      // Count members per bracket (using NWS rounding convention)
      const counts = new Map<string, number>();
      let totalValid = 0;
      for (const temp of members) {
        if (typeof temp !== "number" || !isFinite(temp)) continue;
        const rounded = Math.round(temp);
        for (const br of market.brackets) {
          const lo = (br.lowF != null && isFinite(br.lowF)) ? br.lowF : -Infinity;
          const hi = (br.highF != null && isFinite(br.highF)) ? br.highF : Infinity;
          if (rounded >= lo && rounded <= hi) {
            const ticker = (br as any)._kalshiTicker || (br as any).slug;
            counts.set(ticker, (counts.get(ticker) ?? 0) + 1);
            totalValid++;
            break;
          }
        }
      }
      if (totalValid === 0) {
        this.log(`ENSEMBLE skip ${market.city} ${market.date} ${market.type}: members don't match any bracket`, "yellow");
        continue;
      }

      // Rank ALL brackets by probability (highest first). Single-bracket mode
      // takes only [0]; ladder mode takes top-N with relaxed minProb floor.
      const ranked = [...counts.entries()]
        .map(([ticker, count]) => {
          const bracket = market.brackets.find(b => ((b as any)._kalshiTicker || (b as any).slug) === ticker);
          return bracket ? { ticker, count, bracket, probability: count / totalValid } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.probability - a.probability);

      // Apply per-pick filters:
      //   - Top-1 must clear `minProb` (the historical 0.40 default)
      //   - Subsequent picks (in ladder mode) must clear the looser `ladderMinProb`
      //   - All picks must have entry price within [minPrice, maxPrice]
      const candidates: Array<{
        ticker: string;
        bracket: any;
        probability: number;
        orderPrice: number;
        midPrice: number;
      }> = [];
      for (let i = 0; i < ranked.length && candidates.length < ladderTopN; i++) {
        const r = ranked[i];
        const requiredProb = i === 0 ? minProb : ladderMinProb;
        if (r.probability < requiredProb) {
          if (i === 0) {
            this.log(`ENSEMBLE skip ${market.city} ${market.date} ${market.type}: top prob ${(r.probability * 100).toFixed(0)}% < ${(minProb * 100).toFixed(0)}% (pick ${this.bracketLabel(r.bracket)})`, "dim");
          }
          break; // ranks are sorted, so once below threshold we stop
        }
        const midPrice = r.bracket.outcomePrices[0];
        const actualAsk = (r.bracket as any)._yesAsk ?? midPrice;
        const orderPrice = Math.min(0.99, actualAsk + 0.03);
        if (orderPrice > maxPrice) {
          this.log(`ENSEMBLE skip ${market.city} ${market.date} ${market.type} rank-${i + 1}: $${orderPrice.toFixed(2)} > $${maxPrice.toFixed(2)} max`, "dim");
          continue;
        }
        if (orderPrice < minPrice) {
          this.log(`ENSEMBLE skip ${market.city} ${market.date} ${market.type} rank-${i + 1}: $${orderPrice.toFixed(2)} < $${minPrice.toFixed(2)} min`, "dim");
          continue;
        }
        candidates.push({ ticker: r.ticker, bracket: r.bracket, probability: r.probability, orderPrice, midPrice });
      }
      if (candidates.length === 0) continue;

      // Allocate budget across candidates per sizing scheme. Each candidate
      // independently gets the high-conf multiplier if its own edge ≥ threshold.
      const allocations = (() => {
        const n = candidates.length;
        if (n === 1) return [betSize];
        if (ladderSizing === "even") return Array(n).fill(betSize / n);
        if (ladderSizing === "front-loaded") {
          const presets: Record<number, number[]> = {
            2: [0.60, 0.40],
            3: [0.50, 0.30, 0.20],
            4: [0.40, 0.25, 0.20, 0.15],
          };
          const weights = presets[n] ?? Array(n).fill(1 / n);
          return weights.map(w => betSize * w);
        }
        // weighted: split proportional to model probability
        const totalProb = candidates.reduce((s, c) => s + c.probability, 0);
        return candidates.map(c => betSize * (c.probability / Math.max(0.001, totalProb)));
      })();

      if (ladderTopN > 1 && candidates.length > 1) {
        this.log(
          `🪜 ENSEMBLE LADDER ${market.city} ${market.date} ${market.type}: ${candidates.length} picks (${candidates.map((c, i) => `${this.bracketLabel(c.bracket)} ${(c.probability * 100).toFixed(0)}% $${allocations[i].toFixed(2)}`).join(", ")})`,
          "magenta",
        );
      }

      // Place each pick as an independent order.
      let placedAny = false;
      for (let i = 0; i < candidates.length; i++) {
        const pick = candidates[i];
        const baseAlloc = allocations[i];
        const edge = pick.probability - pick.orderPrice;
        const sizeMultiplier = edge >= highConfEdge ? highConfMult : 1.0;
        const targetSize = +(baseAlloc * sizeMultiplier).toFixed(2);

        const remainingCap = Math.max(0, this.config.startingBalance - this.state.deployed);
        const budget = Math.min(targetSize, this.state.balance, remainingCap);
        const shares = Math.floor(budget / pick.orderPrice);
        if (shares < 1) {
          this.log(`ENSEMBLE skip ${market.city} ${market.date} ${market.type} rank-${i + 1}: insufficient budget`, "yellow");
          continue;
        }
        if (sizeMultiplier > 1.0) {
          this.log(`ENSEMBLE high-conf ${market.city} ${market.date} ${market.type} rank-${i + 1}: edge ${(edge * 100).toFixed(0)}% ≥ ${(highConfEdge * 100).toFixed(0)}% — sizing ${sizeMultiplier.toFixed(1)}× = $${targetSize.toFixed(2)}`, "magenta");
        }
        let cost = shares * pick.orderPrice;
        let entryPrice = pick.orderPrice;
        let filledShares = shares;

        if (this.config.mode === "live" && this.executor) {
          const result = await this.executor.placeOrder({
            ticker: pick.ticker,
            side: "yes",
            askPrice: pick.orderPrice,
            maxShares: shares,
            budget,
          });
          if (!result.success) continue;
          filledShares = result.filledShares;
          entryPrice = result.avgPriceDollars;
          cost = result.filledCostUSD;
        }

        const pos: WeatherPosition = {
          id: `WP-${++this.positionCounter}`,
          market,
          bracket: pick.bracket,
          shares: filledShares,
          entryPrice,
          cost,
          forecastTempF: memberMean,
          forecastProb: pick.probability,
          edge: pick.probability - pick.midPrice,
          modelSpreadF: memberSpread,
          modelCount: dayForecast.modelCount,
          hoursToResolution: hoursToClose,
          entryTime: new Date().toISOString(),
          status: "open",
          pnl: 0,
          ladderGroup: `ensemble-${market.city}-${market.date}-${market.type}`,
        };
        this.state.positions.push(pos);
        this.state.deployed += cost;
        this.state.balance -= cost;
        this.logTrade("ENSEMBLE", pos);
        this.onPositionOpened?.(pos);
        placedAny = true;
        fired++;
        this.log(
          `🔬 ENSEMBLE ${market.city} ${market.date} ${market.type} rank-${i + 1}: ${this.bracketLabel(pick.bracket)} @ $${entryPrice.toFixed(2)} ` +
          `(prob ${(pick.probability * 100).toFixed(0)}%, ${filledShares}sh, $${cost.toFixed(2)}, ${hoursToClose.toFixed(1)}h to close, ens=${memberMean.toFixed(0)}°F)`,
          "green",
        );
      }

      if (placedAny) {
        // Mark city+date+type as fired so we don't re-evaluate next scan
        this.ensembleFiredKeys.add(key);
        this.activeLadderKeys.add(`${market.city.toLowerCase()}-${market.date}-${market.type}`);
      }
    }

    if (fired === 0) {
      this.log("Ensemble-forecast scan: no candidates this cycle", "dim");
    } else {
      this.log(`Ensemble-forecast scan: ${fired} bet(s) placed`, "green");
      this.saveState();
      this.onDashboardUpdate?.();
    }
  }

  async scanForIntrinsicWinners() {
    this.log("Intrinsic scan — looking for market favorites in $0.70-$0.95 zone...", "magenta");

    const finder = this.config.marketFinder ?? findWeatherMarkets;
    let markets: WeatherMarket[];
    try {
      markets = await finder({ daysAhead: 1 });
    } catch (err) {
      this.log(`Intrinsic scan market fetch failed: ${err}`, "red");
      return;
    }

    const now = Date.now();
    const targetH = this.config.intrinsicHoursBefore ?? 8;
    const windowH = this.config.intrinsicWindowHours ?? 4;
    const minPrice = this.config.intrinsicMinPrice ?? 0.70;
    const maxPrice = this.config.intrinsicMaxPrice ?? 0.95;
    const minGap = this.config.intrinsicMinGap ?? 0.05;
    const betSize = this.config.intrinsicBetSize ?? 3;

    // Only events with a "high" type that are within the entry window
    const highMarkets = markets.filter(m => m.type === "high");
    let fired = 0;

    for (const market of highMarkets) {
      const key = `intrinsic-${market.city.toLowerCase()}-${market.date}`;
      if (this.intrinsicKeys.has(key)) continue;

      const hoursToClose = (new Date(market.endDate).getTime() - now) / (1000 * 60 * 60);
      if (hoursToClose < targetH - windowH || hoursToClose > targetH + windowH) {
        // outside entry window — not this scan
        continue;
      }

      // Find favorite among all brackets (highest yes_ask)
      const priced = market.brackets
        .map(b => ({ bracket: b, price: b.outcomePrices[0] }))
        .filter(x => x.price > 0 && x.price < 1)
        .sort((a, b) => b.price - a.price);

      if (priced.length < 2) continue;

      const favorite = priced[0];
      const runnerUp = priced[1];

      if (favorite.price < minPrice || favorite.price > maxPrice) {
        this.log(
          `INTRINSIC skip ${market.city} ${market.date}: favorite ${this.bracketLabel(favorite.bracket)} @ $${favorite.price.toFixed(2)} outside [$${minPrice.toFixed(2)}, $${maxPrice.toFixed(2)}]`,
          "dim"
        );
        continue;
      }

      if (favorite.price - runnerUp.price < minGap) {
        this.log(
          `INTRINSIC skip ${market.city} ${market.date}: favorite/runnerup gap $${(favorite.price - runnerUp.price).toFixed(2)} < min $${minGap.toFixed(2)}`,
          "dim"
        );
        continue;
      }

      // Sizing — use max acceptable price (ask + slippage) as the budget ceiling.
      // The executor will fetch live orderbook and order at best ask if available.
      // `state.balance` is already free cash (net of deployed cost); also cap total deployed
      // at the configured startingBalance so the sim respects the same ceiling as the executor.
      const actualAsk = (favorite.bracket as any)._yesAsk ?? favorite.price;
      const orderPrice = Math.min(0.99, actualAsk + 0.03);  // up to 3¢ slippage tolerance
      const remainingCap = Math.max(0, this.config.startingBalance - this.state.deployed);
      const budget = Math.min(betSize, this.state.balance, remainingCap);
      const shares = Math.floor(budget / orderPrice);
      if (shares < 1) {
        this.log(`INTRINSIC skip ${market.city} ${market.date}: insufficient budget (ask $${actualAsk.toFixed(2)}, free cash $${this.state.balance.toFixed(2)}, cap remaining $${remainingCap.toFixed(2)})`, "yellow");
        continue;
      }
      let cost = shares * orderPrice;
      let entryPrice = orderPrice;
      let filledShares = shares;

      // LIVE mode: place real order
      if (this.config.mode === "live" && this.executor) {
        const ticker = (favorite.bracket as any)._kalshiTicker || (favorite.bracket as any).slug;
        if (!ticker) {
          this.log(`INTRINSIC skip ${market.city}: no Kalshi ticker`, "yellow");
          continue;
        }
        const result = await this.executor.placeOrder({
          ticker,
          side: "yes",
          askPrice: orderPrice,
          maxShares: shares,
          budget,
        });
        if (!result.success) continue;
        filledShares = result.filledShares;
        entryPrice = result.avgPriceDollars;
        cost = result.filledCostUSD;
      }

      const hours = Math.max(0, hoursToClose);
      const pos: WeatherPosition = {
        id: `WP-${++this.positionCounter}`,
        market,
        bracket: favorite.bracket,
        shares: filledShares,
        entryPrice,
        cost,
        forecastTempF: 0,              // not used in this strategy
        forecastProb: favorite.price,  // market-implied probability
        edge: 1 - favorite.price,      // "edge" = discount from $1
        modelSpreadF: 0,
        modelCount: 0,
        hoursToResolution: hours,
        entryTime: new Date().toISOString(),
        status: "open",
        pnl: 0,
        ladderGroup: `intrinsic-${market.city}-${market.date}`,
      };

      this.state.positions.push(pos);
      this.state.deployed += cost;
      this.state.balance -= cost;
      this.intrinsicKeys.add(key);
      this.activeLadderKeys.add(`${market.city.toLowerCase()}-${market.date}-${market.type}`);
      this.logTrade("INTRINSIC", pos);
      this.onPositionOpened?.(pos);
      fired++;

      this.log(
        `🎯 INTRINSIC ${market.city} ${market.date}: ${this.bracketLabel(favorite.bracket)} @ $${entryPrice.toFixed(2)} ` +
        `(gap +$${(favorite.price - runnerUp.price).toFixed(2)} vs ${this.bracketLabel(runnerUp.bracket)}, ` +
        `${filledShares}sh, $${cost.toFixed(2)}, ${hours.toFixed(1)}h to close)`,
        "green"
      );
    }

    if (fired === 0) {
      this.log("Intrinsic scan: no candidates this cycle", "dim");
    } else {
      this.log(`Intrinsic scan: ${fired} bet(s) placed`, "green");
      this.saveState();
      this.onDashboardUpdate?.();
    }
  }

  async scanForSnipes() {
    if (!this.config.snipeEnabled) return;

    this.log("Snipe scan — checking observed temps...", "magenta");

    // 1. Find markets closing soon
    const finder = this.config.marketFinder ?? findWeatherMarkets;
    let markets: WeatherMarket[];
    try {
      markets = await finder({ daysAhead: 1 }); // only today + tomorrow
    } catch (err) {
      this.log(`Snipe scan failed to fetch markets: ${err}`, "red");
      return;
    }

    // Filter to high markets closing within 12 hours (daily high is locked
    // by ~5-6pm local, markets close ~1am ET next day = up to ~12h window).
    // We use time-to-close, NOT date comparison — a market's "date" refers
    // to the weather day, but at 10pm ET the UTC date is already next day.
    const now = Date.now();
    const MAX_HOURS_TO_CLOSE = 12;
    const snipeMarkets = markets.filter(m => {
      if (m.type !== "high") return false;
      const hoursToClose = (new Date(m.endDate).getTime() - now) / (1000 * 60 * 60);
      return hoursToClose > 0 && hoursToClose <= MAX_HOURS_TO_CLOSE;
    });

    if (snipeMarkets.length === 0) {
      this.log("Snipe: no markets closing in next 12h", "dim");
      return;
    }

    this.log(`Snipe: ${snipeMarkets.length} markets closing in next 12h`, "dim");

    // 2. Fetch observed highs for each city
    let snipesFound = 0;

    for (const market of snipeMarkets) {
      const snipeKey = `snipe-${market.city.toLowerCase()}-${market.date}`;

      // Already sniped this market
      if (this.snipedKeys.has(snipeKey)) continue;
      // Note: we INTENTIONALLY do NOT skip markets with existing ladder legs.
      // The ladder bets were forecast-based and may pick the wrong bracket;
      // the snipe is based on actual observed temp. If they target different
      // brackets, that's fine — the snipe is a separate, higher-confidence trade.

      // Fetch METAR lock (three-condition: peak age ≥2h AND drop ≥1.5°F AND local hour ≥15)
      const lock = await detectSameDayLock(market.city, market.date);
      if (!lock) {
        this.log(`Snipe ${market.city}: no METAR data`, "dim");
        continue;
      }
      if (!lock.locked) {
        this.log(
          `Snipe ${market.city}: peak=${lock.peakTempF}°F @ ${lock.station} — ${lock.reason}`,
          "dim"
        );
        continue;
      }

      // 3. Find winning bracket using the locked peak (rounded to integer like NWS)
      const peakRounded = Math.round(lock.peakTempF);
      const winIdx = findWinningBracket(peakRounded, market.brackets);
      if (winIdx < 0) {
        this.log(
          `Snipe ${market.city}: locked peak=${lock.peakTempF}°F (rounded ${peakRounded}) doesn't match any bracket`,
          "yellow"
        );
        continue;
      }

      const winBracket = market.brackets[winIdx];
      const winPrice = winBracket.outcomePrices[0]; // yes_ask

      // 4. Check if the price is stale enough to snipe
      if (winPrice > this.config.snipeMaxPrice) {
        this.log(
          `Snipe ${market.city}: winner ${this.bracketLabel(winBracket)} ` +
          `@ $${winPrice.toFixed(2)} — too expensive (max $${this.config.snipeMaxPrice.toFixed(2)})`,
          "dim"
        );
        continue;
      }

      if (winPrice < 0.40) {
        // Market disagrees strongly — observed temp might not be final
        this.log(
          `Snipe ${market.city}: winner ${this.bracketLabel(winBracket)} ` +
          `@ $${winPrice.toFixed(2)} — market disagrees, skipping`,
          "yellow"
        );
        continue;
      }

      // 5. Size the snipe — single bracket, not a ladder
      const budget = Math.min(
        this.config.snipeBudget,
        this.state.balance
      );
      if (budget < 2) continue;

      const shares = Math.floor(budget / winPrice);
      if (shares < 1) continue;
      const cost = shares * winPrice;

      const expectedReturn = (shares * 1.0) - cost;
      const returnPct = ((1.0 / winPrice) - 1) * 100;

      // Ensure enough balance
      if (cost > this.state.balance) continue;

      // 6. Fire the snipe
      const endDate = new Date(market.endDate);
      const hoursToRes = Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60));

      const pos: WeatherPosition = {
        id: `SNIPE-${++this.positionCounter}`,
        market,
        bracket: winBracket,
        shares,
        entryPrice: winPrice,
        cost,
        forecastTempF: lock.peakTempF,  // actual METAR-observed peak, not forecast
        forecastProb: 0.98,             // METAR lock probability (lockedBracketProbability)
        edge: 0.98 - winPrice,          // true probability − market price
        modelSpreadF: 0,
        modelCount: 0,                  // not a model prediction, METAR-locked
        hoursToResolution: hoursToRes,
        entryTime: new Date().toISOString(),
        status: "open",
        pnl: 0,
        ladderGroup: `snipe-${market.city}-${market.date}`,
      };

      // Deploy
      this.state.positions.push(pos);
      this.state.deployed += cost;
      this.state.balance -= cost;  // FIX: was missing; each snipe was inflating balance
      this.snipedKeys.add(snipeKey);
      this.logTrade("SNIPE", pos);
      this.onPositionOpened?.(pos);
      snipesFound++;

      this.log(
        `🎯 SNIPE ${market.city} ${market.date}: METAR-locked peak=${lock.peakTempF}°F @ ${lock.station} ` +
        `(${lock.peakAgeHours}h ago) → ${this.bracketLabel(winBracket)} @ $${winPrice.toFixed(2)} ` +
        `(${shares} shares, $${cost.toFixed(2)} cost, +${returnPct.toFixed(0)}% return, ` +
        `${hoursToRes.toFixed(1)}h to close)`,
        "green"
      );
    }

    if (snipesFound === 0) {
      this.log("Snipe: no opportunities found this scan", "dim");
    } else {
      this.log(`Snipe: ${snipesFound} snipe(s) fired`, "green");
      this.saveState();
      this.onDashboardUpdate?.();
    }
  }

  // ─── Fetch actual recorded temperature ──────────────────────────

  private cToF(c: number): number {
    return Math.round((c * 9 / 5 + 32) * 10) / 10;
  }

  /**
   * Fetch the real recorded high/low.
   *
   * Priority:
   *  1. METAR (aviationweather.gov) — same-day data, locked peak detection.
   *     Only used for daily highs (METAR peak = day's high). Returns as soon
   *     as the peak is locked (three-condition criteria in METARObserver).
   *  2. Open-Meteo archive — canonical source for past days, ~1-2 day lag.
   *  3. Open-Meteo forecast with past_days — covers the gap window.
   *
   * Returns null if all three sources fail.
   */
  private async fetchActualTemp(
    city: string,
    date: string,
    type: "high" | "low",
  ): Promise<{ tempF: number; source: string } | null> {
    // 1. Try METAR for same-day/recent highs (no waiting for archive lag)
    if (type === "high") {
      try {
        const lock = await detectSameDayLock(city, date);
        if (lock && lock.locked) {
          // Round to integer to match NWS Daily Climate Report convention
          return { tempF: Math.round(lock.peakTempF), source: `metar-${lock.station}` };
        }
      } catch {}
    }

    // Find coordinates for the Open-Meteo fallback paths
    const key = Object.keys(CITY_COORDS).find(
      k => k === city.toLowerCase() || city.toLowerCase().includes(k) || k.includes(city.toLowerCase())
    );
    if (!key) return null;
    const [lat, lon] = CITY_COORDS[key];

    // 2. Try Open-Meteo archive API (canonical for past data, 1-2 day lag)
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${date}&end_date=${date}`;
      const res = await fetchWithRetry(url, {}, { timeoutMs: 10_000, maxRetries: 1 });
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
      const res = await fetchWithRetry(url, {}, { timeoutMs: 10_000, maxRetries: 1 });
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

  /**
   * Fetch official Kalshi resolutions for all brackets in an event.
   * Returns map of ticker → "yes" | "no" | null (null = not yet finalized).
   * Kalshi's own `result` field is ground truth — overrides any forecast or
   * METAR-based inference which can be wrong due to sampling (see Apr 16
   * Miami: METAR hourly peak was 81°F but true peak was 82-83°F).
   */
  private async fetchKalshiResults(eventTicker: string): Promise<Map<string, "yes" | "no" | null>> {
    const client = new KalshiClient({ demo: false });
    const out = new Map<string, "yes" | "no" | null>();
    try {
      const res = await client.getMarkets({ event_ticker: eventTicker, limit: 100 });
      for (const m of res.markets ?? []) {
        const r = (m as any).result;
        const status = ((m as any).status || "").toLowerCase();
        if (status === "finalized" && (r === "yes" || r === "no")) {
          out.set(m.ticker, r);
        } else {
          out.set(m.ticker, null);
        }
      }
    } catch (err) {
      this.log(`Kalshi result fetch failed for ${eventTicker}: ${err}`, "yellow");
    }
    return out;
  }

  async checkResolutions() {
    const now = Date.now();
    const toResolve: WeatherPosition[] = [];

    for (const pos of this.state.positions) {
      const endMs = new Date(pos.market.endDate).getTime();
      if (now >= endMs) {
        toResolve.push(pos);
      }
    }

    if (toResolve.length === 0) return;

    // Group by event for batch resolution
    const byMarket = new Map<string, WeatherPosition[]>();
    for (const pos of toResolve) {
      const key = pos.market.eventId;
      if (!byMarket.has(key)) byMarket.set(key, []);
      byMarket.get(key)!.push(pos);
    }

    const resolved: WeatherPosition[] = [];

    for (const [eventTicker, positions] of byMarket) {
      const market = positions[0].market;

      // Tier 1 (preferred): Kalshi official result. This is the source of truth —
      // it's what Kalshi actually pays out on, derived from NWS Daily Climate Report.
      const kalshiResults = await this.fetchKalshiResults(eventTicker);
      const anyFinalized = [...kalshiResults.values()].some(v => v !== null);

      if (anyFinalized) {
        // At least some brackets finalized — resolve every position whose bracket has a result
        const ladderCost = positions.reduce((s, p) => s + p.cost, 0);
        this.log(
          `RESOLVING ${market.city} ${market.date} (${market.type}) — ` +
          `Kalshi official [${positions.length} legs, $${ladderCost.toFixed(2)} deployed]`,
          "magenta"
        );

        let ladderPnl = 0;
        let legsResolvedThisLadder = 0;

        for (const pos of positions) {
          const ticker = (pos.bracket as any).slug || (pos.bracket as any).conditionId;
          const result = kalshiResults.get(ticker);
          if (result == null) {
            // This specific bracket not finalized yet — skip, retry next scan
            continue;
          }

          const b = pos.bracket;
          if (result === "yes") {
            // Kalshi charges 7% on net winnings (payout − stake), losses are fee-free
            const payout = pos.shares * 1.0;
            const fee = kalshiFee(pos.shares, pos.entryPrice, true);
            pos.pnl = payout - pos.cost - fee;
            pos.status = "won";
            this.state.balance += payout - fee;
            this.state.wins++;
            this.log(
              `  WON  ${this.bracketLabel(b)} → ${pos.shares}sh × $1.00 = $${payout.toFixed(2)} (cost $${pos.cost.toFixed(2)}, fee $${fee.toFixed(2)}) → +$${pos.pnl.toFixed(2)}`,
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
          // Find the winning bracket to record as "actual temp" for display
          const winningTicker = [...kalshiResults.entries()].find(([_, r]) => r === "yes")?.[0];
          const winBracket = winningTicker ? market.brackets.find(br => (br as any).slug === winningTicker) : null;
          if (winBracket) {
            const lo = winBracket.lowF, hi = winBracket.highF;
            pos.resolvedTempF = (lo != null && isFinite(lo)) && (hi != null && isFinite(hi))
              ? Math.round((lo + hi) / 2)
              : (lo != null && isFinite(lo)) ? lo : hi;
          }
          this.state.deployed -= pos.cost;
          this.state.totalPnl += pos.pnl;
          ladderPnl += pos.pnl;
          legsResolvedThisLadder++;

          this.logTrade(pos.status === "won" ? "WON" : "LOST", pos);
          this.onPositionClosed?.(pos);

          resolved.push(pos);
        }

        if (legsResolvedThisLadder > 0) {
          const ladderColor = ladderPnl >= 0 ? "green" : "red";
          this.log(
            `  LADDER NET: ${ladderPnl >= 0 ? "+" : ""}$${ladderPnl.toFixed(2)} ` +
            `(${positions.filter(p => p.status === "won").length} hit / ${legsResolvedThisLadder} legs resolved)`,
            ladderColor
          );

          // Mark this market as resolved if ALL legs resolved
          const allDone = positions.every(p => p.status !== "open");
          if (allDone) {
            const resolvedKey = `${market.city.toLowerCase()}-${market.date}-${market.type}`;
            this.resolvedMarketKeys.add(resolvedKey);
            this.activeLadderKeys.add(resolvedKey);
          }
        }
        continue; // skip legacy tempF path
      }

      // Tier 2 (fallback): Open-Meteo archive / METAR. Only used when Kalshi hasn't
      // yet finalized the market (rare — Kalshi usually finalizes within hours of close).
      const actual = await this.fetchActualTemp(market.city, market.date, market.type);

      if (!actual) {
        this.log(
          `PENDING ${market.city} ${market.date} (${market.type}) — ` +
          `Kalshi not finalized AND fallback data unavailable, will retry next scan`,
          "yellow"
        );
        continue;
      }

      const actualTempF = actual.tempF;
      const ladderCost = positions.reduce((s, p) => s + p.cost, 0);
      this.log(
        `RESOLVING ${market.city} ${market.date} (${market.type}) — ` +
        `Actual: ${actualTempF}°F [${actual.source} fallback, Kalshi not yet finalized] ` +
        `(${positions.length} legs, $${ladderCost.toFixed(2)} deployed)`,
        "magenta"
      );

      let ladderPnl = 0;

      for (const pos of positions) {
        const b = pos.bracket;
        const lo = (b.lowF != null && isFinite(b.lowF)) ? b.lowF : -Infinity;
        const hi = (b.highF != null && isFinite(b.highF)) ? b.highF : Infinity;
        const inBracket = actualTempF >= lo && actualTempF <= hi;

        if (inBracket) {
          const payout = pos.shares * 1.0;
          const fee = kalshiFee(pos.shares, pos.entryPrice, true);
          pos.pnl = payout - pos.cost - fee;
          pos.status = "won";
          this.state.balance += payout - fee;
          this.state.wins++;
          this.log(
            `  WON  ${this.bracketLabel(b)} → ${pos.shares}sh × $1.00 = $${payout.toFixed(2)} (cost $${pos.cost.toFixed(2)}, fee $${fee.toFixed(2)}) → +$${pos.pnl.toFixed(2)}`,
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

      // Mark this market as resolved — NEVER re-buy it
      const resolvedKey = `${market.city.toLowerCase()}-${market.date}-${market.type}`;
      this.resolvedMarketKeys.add(resolvedKey);
      this.activeLadderKeys.add(resolvedKey);

      resolved.push(...positions);
    }

    if (resolved.length === 0) return;

    // Move only resolved positions to closed (keep pending ones open)
    // Filter duplicates — Kalshi path already called resolved.push() per-leg
    const resolvedIds = new Set(resolved.map(p => p.id));
    const alreadyClosed = new Set(this.state.closedPositions.map(p => p.id));
    const toAdd = resolved.filter(p => !alreadyClosed.has(p.id));
    this.state.closedPositions.push(...toAdd);
    this.state.positions = this.state.positions.filter(p => p.status === "open");
    this.saveState();
    this.onDashboardUpdate?.();
  }

  /**
   * Re-derive state counters from the positions arrays (source of truth).
   * Used to correct drift from accounting bugs (e.g. missed balance deductions).
   *
   * Invariants enforced:
   *   deployed  = sum of open.cost
   *   totalPnl  = sum of closed.pnl
   *   wins      = count of closed where status='won'
   *   losses    = count of closed where status='lost'
   *   balance   = startingBalance + totalPnl - deployed
   *               (derived from invariant: equity = start + realized_pnl)
   */
  reconcileState(): { changes: Record<string, [number, number]> } {
    const before = {
      balance: this.state.balance,
      deployed: this.state.deployed,
      totalPnl: this.state.totalPnl,
      wins: this.state.wins,
      losses: this.state.losses,
    };

    const derivedDeployed = this.state.positions.reduce((s, p) => s + p.cost, 0);
    const derivedTotalPnl = this.state.closedPositions.reduce((s, p) => s + p.pnl, 0);
    const derivedWins = this.state.closedPositions.filter(p => p.status === "won").length;
    const derivedLosses = this.state.closedPositions.filter(p => p.status === "lost").length;
    const derivedBalance = this.config.startingBalance + derivedTotalPnl - derivedDeployed;

    this.state.deployed = Math.round(derivedDeployed * 100) / 100;
    this.state.totalPnl = Math.round(derivedTotalPnl * 100) / 100;
    this.state.wins = derivedWins;
    this.state.losses = derivedLosses;
    this.state.balance = Math.round(derivedBalance * 100) / 100;

    const changes: Record<string, [number, number]> = {};
    for (const k of Object.keys(before) as Array<keyof typeof before>) {
      const b = (before as any)[k];
      const a = (this.state as any)[k];
      if (Math.abs(b - a) > 0.01) changes[k] = [b, a];
    }
    return { changes };
  }

  /**
   * One-time audit: re-check closed positions against Kalshi's official result.
   * If a position was wrongly resolved (e.g. METAR said WON but Kalshi said NO),
   * correct the status, pnl, balance, and win/loss counters.
   */
  async auditClosedPositions() {
    if (!this.state.closedPositions || this.state.closedPositions.length === 0) return;
    const client = new KalshiClient({ demo: false });
    const byEvent = new Map<string, WeatherPosition[]>();
    for (const pos of this.state.closedPositions) {
      const key = pos.market.eventId;
      if (!byEvent.has(key)) byEvent.set(key, []);
      byEvent.get(key)!.push(pos);
    }

    let corrected = 0;
    for (const [eventTicker, positions] of byEvent) {
      try {
        const res = await client.getMarkets({ event_ticker: eventTicker, limit: 100 });
        const kalshiResults = new Map<string, "yes" | "no" | null>();
        for (const m of res.markets ?? []) {
          const r = (m as any).result;
          const status = ((m as any).status || "").toLowerCase();
          if (status === "finalized" && (r === "yes" || r === "no")) {
            kalshiResults.set(m.ticker, r);
          }
        }

        if (kalshiResults.size === 0) continue;

        for (const pos of positions) {
          const ticker = (pos.bracket as any).slug || (pos.bracket as any).conditionId;
          const kalshiResult = kalshiResults.get(ticker);
          if (kalshiResult == null) continue;

          const currentStatus = pos.status;
          const kalshiStatus = kalshiResult === "yes" ? "won" : "lost";
          if (currentStatus === kalshiStatus) continue;

          // MISMATCH — correct it
          this.log(
            `AUDIT CORRECTION: ${pos.market.city} ${pos.market.date} ${this.bracketLabel(pos.bracket)} — ` +
            `had ${currentStatus}, Kalshi says ${kalshiStatus}`,
            "yellow"
          );

          // Reverse old effect on state
          if (currentStatus === "won") {
            // balance had: +payout - fee added. Reverse it.
            const oldPayout = pos.shares * 1.0;
            const oldFee = kalshiFee(pos.shares, pos.entryPrice, true);
            this.state.balance -= oldPayout - oldFee;
            this.state.wins--;
          } else if (currentStatus === "lost") {
            // balance had: no change (stake was deducted at entry). Nothing to reverse.
            this.state.losses--;
          }
          // Reverse the pnl impact on totalPnl
          this.state.totalPnl -= pos.pnl;

          // Apply new (correct) effect
          if (kalshiStatus === "won") {
            const payout = pos.shares * 1.0;
            const fee = kalshiFee(pos.shares, pos.entryPrice, true);
            pos.pnl = payout - pos.cost - fee;
            pos.status = "won";
            this.state.balance += payout - fee;
            this.state.wins++;
          } else {
            pos.pnl = -pos.cost;
            pos.status = "lost";
            this.state.losses++;
          }
          this.state.totalPnl += pos.pnl;
          corrected++;
        }
      } catch (err) {
        this.log(`Audit failed for ${eventTicker}: ${err}`, "yellow");
      }
    }

    if (corrected > 0) {
      this.log(`AUDIT COMPLETE: ${corrected} position(s) corrected`, "cyan");
      this.saveState();
      this.onDashboardUpdate?.();
    }
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
