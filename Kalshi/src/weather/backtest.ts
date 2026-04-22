#!/usr/bin/env bun
/**
 * Quick historical backtest — compares Open-Meteo forecasts
 * against actual recorded temperatures to measure real forecast
 * accuracy and simulate weather bracket trading P&L.
 *
 * Uses Open-Meteo Archive API for actuals.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { bracketProbability } from "./WeatherForecast";

const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";

const CITIES: Record<string, [number, number]> = {
  "New York City": [40.7128, -74.0060],
  "Dallas": [32.7767, -96.7970],
  "Seattle": [47.6062, -122.3321],
  "Atlanta": [33.7490, -84.3880],
  "London": [51.5074, -0.1278],
  "Tokyo": [35.6762, 139.6503],
  "Seoul": [37.5665, 126.9780],
  "Toronto": [43.6532, -79.3832],
};

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

// ─── Fetch actual recorded temps ─────────────────────────────────────
async function fetchActuals(city: string, coords: [number, number], startDate: string, endDate: string) {
  const url = `${ARCHIVE_API}?latitude=${coords[0]}&longitude=${coords[1]}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${startDate}&end_date=${endDate}`;
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
}

// ─── Fetch forecast (includes recent past days) ──────────────────────
async function fetchForecasts(coords: [number, number], days: number) {
  const url = `${FORECAST_API}?latitude=${coords[0]}&longitude=${coords[1]}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&past_days=7&forecast_days=${days}`;
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
}

// ─── Simulate bracket trading ────────────────────────────────────────
interface BracketSim {
  lowF: number;
  highF: number;
  label: string;
}

function generateBrackets(centerF: number): BracketSim[] {
  // Simulate typical Polymarket brackets: 2°F wide, centered around forecast
  const brackets: BracketSim[] = [];
  const startF = Math.round(centerF / 2) * 2 - 12;

  brackets.push({ lowF: -Infinity, highF: startF - 1, label: `≤${startF - 1}°F` });
  for (let f = startF; f <= startF + 22; f += 2) {
    brackets.push({ lowF: f, highF: f + 1, label: `${f}-${f + 1}°F` });
  }
  brackets.push({ lowF: startF + 24, highF: Infinity, label: `≥${startF + 24}°F` });

  return brackets;
}

function simulateMarketPrices(brackets: BracketSim[], forecastHighF: number, hoursOut: number): Map<string, number> {
  // Simulate what market prices WOULD be — assume market is semi-efficient
  // but with some noise/inefficiency (market uses wider sigma than optimal)
  const marketSigma = hoursOut <= 24 ? 3.0 : hoursOut <= 48 ? 4.5 : 6.0; // market overestimates uncertainty
  const prices = new Map<string, number>();

  for (const b of brackets) {
    const prob = bracketProbabilityCustomSigma(forecastHighF, b.lowF, b.highF, marketSigma);
    // Add some noise to simulate real market inefficiency
    const noise = (Math.random() - 0.5) * 0.06;
    const price = Math.max(0.01, Math.min(0.99, prob + noise));
    prices.set(b.label, price);
  }

  return prices;
}

function bracketProbabilityCustomSigma(forecastF: number, lowF: number, highF: number, sigma: number): number {
  function normCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327;
    const p = d * Math.exp(-x * x / 2) * (0.3193815 * t - 0.3565638 * t * t + 1.781478 * t * t * t - 1.8212560 * t * t * t * t + 1.3302744 * t * t * t * t * t);
    return x >= 0 ? 1 - p : p;
  }

  const zLow = isFinite(lowF) ? (lowF - 0.5 - forecastF) / sigma : -Infinity;
  const zHigh = isFinite(highF) ? (highF + 0.5 - forecastF) / sigma : Infinity;
  const pLow = isFinite(zLow) ? normCdf(zLow) : 0;
  const pHigh = isFinite(zHigh) ? normCdf(zHigh) : 1;
  return Math.max(0, Math.min(1, pHigh - pLow));
}

// ─── ANSI ────────────────────────────────────────────────────────────
const a = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", magenta: "\x1b[35m",
};

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${a.cyan}${a.bold}  WEATHER BACKTEST — Forecast vs Actual${a.reset}\n`);

  // Date range: last 10 days (archive has ~2 day lag, so go 3-12 days back)
  const now = new Date();
  const endDate = new Date(now.getTime() - 3 * 86400000);
  const startDate = new Date(now.getTime() - 12 * 86400000);
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  console.log(`  ${a.dim}Period:${a.reset} ${startStr} to ${endStr}`);
  console.log(`  ${a.dim}Cities:${a.reset} ${Object.keys(CITIES).join(", ")}\n`);

  // ─── Part 1: Measure forecast accuracy ─────────────────────────
  console.log(`${a.bold}  PART 1: FORECAST ACCURACY${a.reset}\n`);

  const errors: number[] = [];
  const errorsByCity: Map<string, number[]> = new Map();

  for (const [city, coords] of Object.entries(CITIES)) {
    const actuals = await fetchActuals(city, coords, startStr, endStr);
    const forecasts = await fetchForecasts(coords, 3);
    if (!actuals || !forecasts) {
      console.log(`  ${a.dim}Skipping ${city} — no data${a.reset}`);
      continue;
    }

    const cityErrors: number[] = [];
    for (const actual of actuals) {
      const forecast = forecasts.find(f => f.date === actual.date);
      if (!forecast) continue;

      const errorF = actual.actualHighF - forecast.forecastHighF;
      errors.push(errorF);
      cityErrors.push(errorF);
    }

    errorsByCity.set(city, cityErrors);

    if (cityErrors.length > 0) {
      const mean = cityErrors.reduce((s, e) => s + e, 0) / cityErrors.length;
      const variance = cityErrors.reduce((s, e) => s + (e - mean) ** 2, 0) / cityErrors.length;
      const std = Math.sqrt(variance);
      const maxErr = Math.max(...cityErrors.map(Math.abs));

      console.log(
        `  ${city.padEnd(18)} ${a.dim}n=${cityErrors.length}${a.reset}  ` +
        `mean=${mean >= 0 ? "+" : ""}${mean.toFixed(1)}°F  ` +
        `σ=${a.bold}${std.toFixed(1)}°F${a.reset}  ` +
        `max=${maxErr.toFixed(1)}°F`
      );
    }
  }

  if (errors.length > 0) {
    const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
    const variance = errors.reduce((s, e) => s + (e - mean) ** 2, 0) / errors.length;
    const std = Math.sqrt(variance);
    const maxErr = Math.max(...errors.map(Math.abs));
    const within2 = errors.filter(e => Math.abs(e) <= 2).length;
    const within4 = errors.filter(e => Math.abs(e) <= 4).length;

    console.log(`\n  ${a.bold}OVERALL${a.reset} (n=${errors.length})`);
    console.log(`  Mean error:      ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}°F`);
    console.log(`  Std deviation:   ${a.bold}${std.toFixed(2)}°F${a.reset}`);
    console.log(`  Max |error|:     ${maxErr.toFixed(1)}°F`);
    console.log(`  Within ±2°F:     ${((within2 / errors.length) * 100).toFixed(0)}%`);
    console.log(`  Within ±4°F:     ${((within4 / errors.length) * 100).toFixed(0)}%`);
    console.log(`\n  ${a.dim}Our model assumes σ=2°F at 24h. Actual σ=${std.toFixed(2)}°F.${a.reset}`);
    if (std > 3) {
      console.log(`  ${a.red}WARNING: Real error is much larger than assumed — edge may be overstated${a.reset}`);
    } else if (std < 2.5) {
      console.log(`  ${a.green}Forecast accuracy is strong — model assumptions are reasonable${a.reset}`);
    }
  }

  // ─── Part 2: Simulated trading backtest ────────────────────────
  console.log(`\n${a.bold}  PART 2: SIMULATED TRADING BACKTEST${a.reset}\n`);

  const MIN_EDGE = 0.10;
  const POSITION_SIZE = 5;
  let balance = 500;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  const tradeLog: string[] = [];

  for (const [city, coords] of Object.entries(CITIES)) {
    const actuals = await fetchActuals(city, coords, startStr, endStr);
    const forecasts = await fetchForecasts(coords, 3);
    if (!actuals || !forecasts) continue;

    for (const actual of actuals) {
      const forecast = forecasts.find(f => f.date === actual.date);
      if (!forecast) continue;

      const forecastHighF = forecast.forecastHighF;
      const actualHighF = actual.actualHighF;

      // Generate brackets centered on the forecast
      const brackets = generateBrackets(forecastHighF);

      // Simulate market prices (market uses wider sigma = less confident)
      const hoursOut = 24; // simulate 24h-ahead trading
      const marketPrices = simulateMarketPrices(brackets, forecastHighF, hoursOut);

      // Our model's probabilities (tighter sigma = more confident)
      for (const bracket of brackets) {
        const ourProb = bracketProbability(forecastHighF, bracket.lowF, bracket.highF, hoursOut);
        const marketPrice = marketPrices.get(bracket.label) ?? 0;

        const edge = ourProb - marketPrice;
        if (edge < MIN_EDGE || marketPrice < 0.02 || marketPrice > 0.90) continue;

        // Trade it
        const shares = Math.floor(POSITION_SIZE / marketPrice);
        if (shares < 1) continue;
        const cost = shares * marketPrice;
        if (cost > balance) continue;

        // Resolve against actual temperature
        const inBracket = actualHighF >= (isFinite(bracket.lowF) ? bracket.lowF : -Infinity)
          && actualHighF <= (isFinite(bracket.highF) ? bracket.highF : Infinity);

        const pnl = inBracket ? (shares * 1.0 - cost) : -cost;
        balance += pnl;
        totalPnl += pnl;
        totalTrades++;
        if (inBracket) wins++;
        else losses++;

        const result = inBracket ? `${a.green}WON${a.reset}` : `${a.red}LOST${a.reset}`;
        tradeLog.push(
          `  ${city.padEnd(16)} ${actual.date}  ${bracket.label.padEnd(12)} ` +
          `entry=$${marketPrice.toFixed(2)} prob=${(ourProb * 100).toFixed(0)}% edge=+${(edge * 100).toFixed(0)}% ` +
          `${result}  actual=${actualHighF}°F  pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`
        );
      }
    }
  }

  // Print trade log (last 30)
  if (tradeLog.length > 30) {
    console.log(`  ${a.dim}(Showing last 30 of ${tradeLog.length} trades)${a.reset}\n`);
    for (const line of tradeLog.slice(-30)) console.log(line);
  } else {
    for (const line of tradeLog) console.log(line);
  }

  // Summary
  const wr = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0";
  const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const roi = ((balance - 500) / 500 * 100).toFixed(1);

  console.log(`\n  ${a.dim}${"─".repeat(60)}${a.reset}`);
  console.log(`  ${a.bold}BACKTEST RESULTS${a.reset}`);
  console.log(`  Period:           ${startStr} to ${endStr}`);
  console.log(`  Total trades:     ${totalTrades}`);
  console.log(`  Win/Loss:         ${wins}W-${losses}L (${wr}% win rate)`);
  console.log(`  Starting balance: $500.00`);
  console.log(`  Final balance:    ${balance >= 500 ? a.green : a.red}$${balance.toFixed(2)}${a.reset} (${roi}% ROI)`);
  console.log(`  Total P&L:        ${totalPnl >= 0 ? a.green + "+" : a.red}$${totalPnl.toFixed(2)}${a.reset}`);
  console.log(`  Avg P&L/trade:    ${avgPnlPerTrade >= 0 ? a.green + "+" : a.red}$${avgPnlPerTrade.toFixed(2)}${a.reset}`);
  console.log(`  ${a.dim}${"─".repeat(60)}${a.reset}\n`);
}

main().catch(err => {
  console.error(`FATAL: ${err}`);
  process.exit(1);
});
