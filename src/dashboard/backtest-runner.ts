/**
 * Programmatic backtest runner for the dashboard.
 *
 * Reimplements the logic from src/weather/backtest.ts but returns
 * structured data instead of printing to terminal.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { bracketProbability } from "../weather/WeatherForecast";
import { KALSHI_FEE_RATE, kalshiFee } from "./trading-math";

// ─── Public interfaces ──────────────────────────────────────────────

export interface BacktestParams {
  cities?: string[];      // defaults to all
  daysBack?: number;      // how far back (default 10)
  minEdge?: number;       // minimum edge to trade (default 0.10)
  positionSize?: number;  // dollars per trade (default 5)
  startBalance?: number;  // starting balance (default 500)
}

export interface BacktestTrade {
  city: string;
  date: string;
  bracket: string;         // "80-81°F"
  entryPrice: number;      // 0-1
  modelProb: number;       // 0-1
  edge: number;            // model - market
  actualHighF: number;
  won: boolean;
  /** Gross P&L before fees: stake returned + winnings, or −stake if loss. */
  grossPnl: number;
  /** Kalshi 7% fee on net winnings (0 on losses). */
  feePaid: number;
  /** Net P&L after fee — this is what hits `balance`. */
  pnl: number;
  balanceAfter: number;
}

export interface BacktestAccuracy {
  city: string;
  n: number;
  meanError: number;
  stddev: number;
  maxError: number;
  within2F: number;        // fraction within +/-2 degrees F
  within4F: number;        // fraction within +/-4 degrees F
}

export interface BacktestResult {
  params: BacktestParams;
  period: { start: string; end: string };
  accuracy: {
    overall: BacktestAccuracy;
    byCity: BacktestAccuracy[];
  };
  trades: BacktestTrade[];
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    startBalance: number;
    endBalance: number;
    totalPnl: number;
    /** Gross P&L before fees — useful for isolating fee drag. */
    totalGrossPnl: number;
    /** Total Kalshi fees paid across all winning trades. */
    totalFeesPaid: number;
    roi: number;
    avgPnlPerTrade: number;
    avgEdgeAtEntry: number;
    avgEntryPrice: number;
    /**
     * Fraction of trades whose edge was below the fee-adjusted breakeven
     * edge `fee_rate * (1 - entry_price)`. High values here mean the
     * min-edge gate is too permissive given the entry prices being
     * selected.
     */
    tradesBelowBreakeven: number;
  };
  /** Equity curve: balance after each trade */
  equityCurve: { tradeIndex: number; balance: number }[];
}

// ─── Constants ──────────────────────────────────────────────────────

const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";

const ALL_CITIES: Record<string, [number, number]> = {
  "New York City": [40.7128, -74.0060],
  "Chicago": [41.8781, -87.6298],
  "Miami": [25.7617, -80.1918],
  "Los Angeles": [34.0522, -118.2437],
  "Dallas": [32.7767, -96.7970],
  "Seattle": [47.6062, -122.3321],
  "Atlanta": [33.7490, -84.3880],
  "Denver": [39.7392, -104.9903],
  "Boston": [42.3601, -71.0589],
};

// ─── Helpers ────────────────────────────────────────────────────────

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

function bracketProbCustomSigma(
  forecastF: number,
  lowF: number,
  highF: number,
  sigma: number,
): number {
  function normCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327;
    const p =
      d *
      Math.exp((-x * x) / 2) *
      (0.3193815 * t -
        0.3565638 * t ** 2 +
        1.781478 * t ** 3 -
        1.821256 * t ** 4 +
        1.3302744 * t ** 5);
    return x >= 0 ? 1 - p : p;
  }

  const zLow = isFinite(lowF) ? (lowF - 0.5 - forecastF) / sigma : -Infinity;
  const zHigh = isFinite(highF) ? (highF + 0.5 - forecastF) / sigma : Infinity;
  return Math.max(
    0,
    Math.min(
      1,
      (isFinite(zHigh) ? normCdf(zHigh) : 1) -
        (isFinite(zLow) ? normCdf(zLow) : 0),
    ),
  );
}

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

// ─── Data fetchers ──────────────────────────────────────────────────

interface DayActual {
  date: string;
  actualHighC: number;
  actualLowC: number;
  actualHighF: number;
  actualLowF: number;
}

async function fetchActuals(
  coords: [number, number],
  startDate: string,
  endDate: string,
): Promise<DayActual[] | null> {
  const url =
    `${ARCHIVE_API}?latitude=${coords[0]}&longitude=${coords[1]}` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto` +
    `&start_date=${startDate}&end_date=${endDate}`;

  try {
    const res = await fetchWithRetry(url, {}, { timeoutMs: 15_000 });
    const data = await res.json();
    if (!data.daily) return null;

    return (data.daily.time as string[]).map((date: string, i: number) => ({
      date,
      actualHighC: data.daily.temperature_2m_max[i],
      actualLowC: data.daily.temperature_2m_min[i],
      actualHighF: cToF(data.daily.temperature_2m_max[i]),
      actualLowF: cToF(data.daily.temperature_2m_min[i]),
    }));
  } catch {
    return null;
  }
}

interface DayForecast {
  date: string;
  forecastHighC: number;
  forecastLowC: number;
  forecastHighF: number;
  forecastLowF: number;
}

async function fetchForecasts(
  coords: [number, number],
): Promise<DayForecast[] | null> {
  const url =
    `${FORECAST_API}?latitude=${coords[0]}&longitude=${coords[1]}` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto` +
    `&past_days=7&forecast_days=3`;

  try {
    const res = await fetchWithRetry(url, {}, { timeoutMs: 15_000 });
    const data = await res.json();
    if (!data.daily) return null;

    return (data.daily.time as string[]).map((date: string, i: number) => ({
      date,
      forecastHighC: data.daily.temperature_2m_max[i],
      forecastLowC: data.daily.temperature_2m_min[i],
      forecastHighF: cToF(data.daily.temperature_2m_max[i]),
      forecastLowF: cToF(data.daily.temperature_2m_min[i]),
    }));
  } catch {
    return null;
  }
}

// ─── Bracket generation ─────────────────────────────────────────────

interface BracketSim {
  lowF: number;
  highF: number;
  label: string;
}

function generateBrackets(centerF: number): BracketSim[] {
  const brackets: BracketSim[] = [];
  const startF = Math.round(centerF / 2) * 2 - 12;

  brackets.push({
    lowF: -Infinity,
    highF: startF - 1,
    label: `<=${startF - 1}°F`,
  });

  for (let f = startF; f <= startF + 22; f += 2) {
    brackets.push({ lowF: f, highF: f + 1, label: `${f}-${f + 1}°F` });
  }

  brackets.push({
    lowF: startF + 24,
    highF: Infinity,
    label: `>=${startF + 24}°F`,
  });

  return brackets;
}

// ─── Accuracy helpers ───────────────────────────────────────────────

function computeAccuracy(city: string, errors: number[]): BacktestAccuracy {
  if (errors.length === 0) {
    return {
      city,
      n: 0,
      meanError: 0,
      stddev: 0,
      maxError: 0,
      within2F: 0,
      within4F: 0,
    };
  }

  const n = errors.length;
  const mean = errors.reduce((s, e) => s + e, 0) / n;
  const variance = errors.reduce((s, e) => s + (e - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const maxError = Math.max(...errors.map(Math.abs));
  const within2F = errors.filter((e) => Math.abs(e) <= 2).length / n;
  const within4F = errors.filter((e) => Math.abs(e) <= 4).length / n;

  return { city, n, meanError: mean, stddev, maxError, within2F, within4F };
}

// ─── Main backtest function ─────────────────────────────────────────

export async function runBacktest(
  params: BacktestParams = {},
): Promise<BacktestResult> {
  const daysBack = params.daysBack ?? 10;
  const minEdge = params.minEdge ?? 0.10;
  const positionSize = params.positionSize ?? 5;
  const startBalance = params.startBalance ?? 500;

  // Resolve which cities to run
  const cityNames = params.cities && params.cities.length > 0
    ? params.cities.filter((c) => c in ALL_CITIES)
    : Object.keys(ALL_CITIES);

  const cities: Record<string, [number, number]> = {};
  for (const name of cityNames) {
    cities[name] = ALL_CITIES[name];
  }

  // Date range: archive has ~2 day lag, so go daysBack+2 to 2 days ago
  const now = new Date();
  const endDate = new Date(now.getTime() - 3 * 86400000);
  const startDate = new Date(now.getTime() - (daysBack + 2) * 86400000);
  const startStr = toDateStr(startDate);
  const endStr = toDateStr(endDate);

  // ─── Part 1: Measure forecast accuracy ──────────────────────────

  const allErrors: number[] = [];
  const cityAccuracies: BacktestAccuracy[] = [];

  // We also need actuals + forecasts for the trading sim, so store them
  const cityData: Map<
    string,
    { actuals: DayActual[]; forecasts: DayForecast[] }
  > = new Map();

  for (const [city, coords] of Object.entries(cities)) {
    const actuals = await fetchActuals(coords, startStr, endStr);
    const forecasts = await fetchForecasts(coords);
    if (!actuals || !forecasts) continue;

    cityData.set(city, { actuals, forecasts });

    const cityErrors: number[] = [];
    for (const actual of actuals) {
      const forecast = forecasts.find((f) => f.date === actual.date);
      if (!forecast) continue;
      const errorF = actual.actualHighF - forecast.forecastHighF;
      cityErrors.push(errorF);
      allErrors.push(errorF);
    }

    cityAccuracies.push(computeAccuracy(city, cityErrors));
  }

  const overallAccuracy = computeAccuracy("overall", allErrors);

  // ─── Part 2: Simulated bracket trading ──────────────────────────

  let balance = startBalance;
  const trades: BacktestTrade[] = [];

  for (const [city, { actuals, forecasts }] of cityData.entries()) {
    for (const actual of actuals) {
      const forecast = forecasts.find((f) => f.date === actual.date);
      if (!forecast) continue;

      const forecastHighF = forecast.forecastHighF;
      const actualHighF = actual.actualHighF;
      const brackets = generateBrackets(forecastHighF);

      for (const bracket of brackets) {
        // Our model probability (tighter sigma)
        const ourProb = bracketProbability(
          forecastHighF,
          bracket.lowF,
          bracket.highF,
          24,
        );

        // Simulated market price (wider sigma + noise)
        const marketBase = bracketProbCustomSigma(
          forecastHighF,
          bracket.lowF,
          bracket.highF,
          3.0,
        );
        const noise = (Math.random() - 0.5) * 0.06;
        const marketPrice = Math.max(0.01, Math.min(0.99, marketBase + noise));

        const edge = ourProb - marketPrice;
        if (edge < minEdge || marketPrice < 0.02 || marketPrice > 0.90) {
          continue;
        }

        const shares = Math.floor(positionSize / marketPrice);
        if (shares < 1) continue;
        const cost = shares * marketPrice;
        if (cost > balance) continue;

        // Resolve against actual temperature
        const inBracket =
          actualHighF >= (isFinite(bracket.lowF) ? bracket.lowF : -Infinity) &&
          actualHighF <= (isFinite(bracket.highF) ? bracket.highF : Infinity);

        // Gross = stake returned + $1/contract if won, else −stake.
        // Fee applies to net winnings only, matching live Kalshi behavior
        // and the paper-trader's settlement logic (trading-math.ts).
        // Pre-audit this fee was silently 0%, which inflated backtest P&L
        // by ~5–7% per winning trade — see LOSS_DIAGNOSIS.md.
        const grossPnl = inBracket ? shares * 1.0 - cost : -cost;
        const feePaid = kalshiFee(shares, marketPrice, inBracket);
        const pnl = grossPnl - feePaid;
        balance += pnl;

        trades.push({
          city,
          date: actual.date,
          bracket: bracket.label,
          entryPrice: marketPrice,
          modelProb: ourProb,
          edge,
          actualHighF,
          won: inBracket,
          grossPnl,
          feePaid,
          pnl,
          balanceAfter: balance,
        });
      }
    }
  }

  // ─── Build equity curve ─────────────────────────────────────────

  const equityCurve = trades.map((t, i) => ({
    tradeIndex: i,
    balance: t.balanceAfter,
  }));

  // ─── Summary stats ──────────────────────────────────────────────

  const wins = trades.filter((t) => t.won).length;
  const losses = trades.length - wins;
  const totalPnl = balance - startBalance;
  const totalGrossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
  const totalFeesPaid = trades.reduce((s, t) => s + t.feePaid, 0);

  const avgEdge =
    trades.length > 0 ? trades.reduce((s, t) => s + t.edge, 0) / trades.length : 0;
  const avgEntry =
    trades.length > 0
      ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length
      : 0;

  // How many trades had edge BELOW the fee-adjusted breakeven? These
  // should have been rejected by a min-edge gate that was aware of fees.
  const tradesBelowBreakeven =
    trades.length > 0
      ? trades.filter(
          (t) => t.edge < KALSHI_FEE_RATE * (1 - t.entryPrice),
        ).length / trades.length
      : 0;

  const summary = {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    startBalance,
    endBalance: balance,
    totalPnl,
    totalGrossPnl: Math.round(totalGrossPnl * 100) / 100,
    totalFeesPaid: Math.round(totalFeesPaid * 100) / 100,
    roi: startBalance > 0 ? totalPnl / startBalance : 0,
    avgPnlPerTrade: trades.length > 0 ? totalPnl / trades.length : 0,
    avgEdgeAtEntry: Math.round(avgEdge * 10000) / 10000,
    avgEntryPrice: Math.round(avgEntry * 10000) / 10000,
    tradesBelowBreakeven: Math.round(tradesBelowBreakeven * 10000) / 10000,
  };

  return {
    params: {
      cities: cityNames,
      daysBack,
      minEdge,
      positionSize,
      startBalance,
    },
    period: { start: startStr, end: endStr },
    accuracy: {
      overall: overallAccuracy,
      byCity: cityAccuracies,
    },
    trades,
    summary,
    equityCurve,
  };
}
