/**
 * Types for the Weather Temperature Markets bot.
 *
 * Polymarket runs daily "highest temperature" markets for 40+ cities.
 * Each event has 10-12 bracket sub-markets (e.g. "78-79 F", "80-81 F").
 * We use GFS + ECMWF ensemble forecasts (82 members) to compute
 * bracket probabilities, then trade brackets where our probability
 * diverges from market price by 8%+.
 */

// ─── Market discovery types ─────────────────────────────────────────

export interface TempBracket {
  question: string;
  slug: string;
  conditionId: string;
  marketId: string;
  clobTokenIds: [string, string]; // [YES token, NO token]
  outcomePrices: [number, number]; // [YES price, NO price]
  lowTemp: number; // Lower bound (-Infinity for "or below")
  highTemp: number; // Upper bound (Infinity for "or higher")
  unit: "F" | "C";
  endDate: string;
  volume: number;
  liquidity: number;
  groupItemTitle: string;
}

export interface WeatherMarket {
  eventId: string;
  title: string;
  slug: string;
  city: string;
  date: string; // YYYY-MM-DD
  endDate: string;
  brackets: TempBracket[];
  unit: "F" | "C";
  type: "high" | "low";
  negRiskMarketId: string;
}

// ─── Forecast types ─────────────────────────────────────────────────

export interface EnsembleResult {
  city: string;
  date: string;
  members: number[]; // 82 temperature values (31 GFS + 51 ECMWF) in the market's unit
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  modelBreakdown: {
    gfs: { mean: number; count: number };
    ecmwf: { mean: number; count: number };
  };
  fetchedAt: number;
}

// ─── Edge calculation types ─────────────────────────────────────────

export interface BracketEdge {
  bracket: TempBracket;
  forecastProb: number; // Our ensemble probability
  marketPrice: number; // Market's YES price
  edge: number; // forecastProb - marketPrice (positive = underpriced)
  action: "BUY_YES" | "BUY_NO";
  kellyFraction: number;
  suggestedSize: number; // USDC
}

export interface WeatherOpportunity {
  market: WeatherMarket;
  ensemble: EnsembleResult;
  edges: BracketEdge[];
  bestEdge: BracketEdge | null;
  scannedAt: number;
}

// ─── Trade tracking types ───────────────────────────────────────────

export interface WeatherTrade {
  id: string;
  city: string;
  date: string;
  bracket: string; // "78-79 F"
  action: "BUY_YES" | "BUY_NO";
  entryPrice: number;
  shares: number;
  cost: number;
  forecastProb: number;
  marketPrice: number;
  edge: number;
  ensembleMean: number;
  ensembleStdDev: number;
  placedAt: number;
  resolvedAt?: number;
  outcome?: "WIN" | "LOSS";
  pnl?: number;
  slug: string;
  conditionId: string;
}

export interface WeatherState {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  pending: WeatherTrade[];
  completed: WeatherTrade[];
  bankroll: number;
}

// ─── Engine config ──────────────────────────────────────────────────

export interface WeatherEngineConfig {
  mode: "sim" | "prod";
  bankroll: number;
  minEdge: number; // Minimum edge to enter (default 0.08 = 8%)
  maxPositionPct: number; // Max fraction of bankroll per trade (default 0.25)
  scanIntervalMs: number; // How often to rescan markets (default 15 min)
  daysAhead: number; // How many days ahead to scan (default 3)
  cities: string[]; // Cities to focus on (empty = all)
  kellyFraction: number; // Kelly divisor (default 0.25 = quarter-Kelly)
}

export const DEFAULT_WEATHER_CONFIG: WeatherEngineConfig = {
  mode: "sim",
  bankroll: 20,
  minEdge: 0.08,
  maxPositionPct: 0.25,
  scanIntervalMs: 15 * 60 * 1000,
  daysAhead: 3,
  cities: [],
  kellyFraction: 0.25,
};
