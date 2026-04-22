#!/usr/bin/env bun
/**
 * Kalshi Weather Strategy Backtest
 *
 * Simulates our ladder strategy against historical data for the
 * 6 active Kalshi KXHIGH cities. Uses Open-Meteo archive for actuals
 * and forecast API for what our model would have predicted.
 *
 * Kalshi bracket structure: ~6 brackets per event
 *   - 2 tail brackets (open-ended low/high)
 *   - 4 middle brackets (2°F wide)
 *
 * Market prices are simulated with wider sigma (market overestimates
 * uncertainty), then our tighter ensemble model finds edges.
 */

import { fetchWithRetry } from "./src/net/fetchWithRetry";

// ─── Config ─────────────────────────────────────────────────────────
// CLI overrides: --balance 200 --days-back 60 --budget 10
const cliArgs = process.argv.slice(2);
function argVal(flag: string, fallback: number): number {
  const idx = cliArgs.indexOf(flag);
  return idx >= 0 ? parseFloat(cliArgs[idx + 1]) : fallback;
}
const STARTING_BALANCE = argVal("--balance", 500);
const LADDER_BUDGET = argVal("--budget", 15);
const MAX_LEGS = argVal("--max-legs", 6);
const MIN_EDGE = argVal("--min-edge", 0.10);
const HOURS_OUT = argVal("--hours-out", 24);
const DAYS_BACK = argVal("--days-back", 30);
const DAYS_LAG = argVal("--days-lag", 3); // archive data lag
// New strategy filters (match live bot defaults)
const MIN_BRACKET_PRICE = argVal("--min-bracket-price", 0.03);
const MAX_TAIL_SIGMA = argVal("--max-tail-sigma", 0.8);
const MAX_EDGE = argVal("--max-edge", 0.40);
const MAX_HOURS_TO_ENTRY = argVal("--max-hours", 36);
const KALSHI_FEE_RATE = 0.07;
// Realism tunables for simulating how Kalshi prices are set:
//   MARKET_SIGMA_MULT — market's implied sigma ÷ our forecast sigma
//     > 1.0 = market less confident than us (we have edge) [idealized]
//     = 1.0 = market as smart as us (no informational edge)
//     < 1.0 = market smarter than us (we're the dumb money)
//   SLIPPAGE_CENTS — cents added to the ask we pay (cost of the spread)
const MARKET_SIGMA_MULT = argVal("--market-sigma-mult", 1.75);
const SLIPPAGE_CENTS = argVal("--slippage", 0.0);

// Kalshi US cities
const CITIES: Record<string, [number, number]> = {
  "New York City": [40.7128, -74.0060],
  "Chicago":       [41.8781, -87.6298],
  "Miami":         [25.7617, -80.1918],
  "Los Angeles":   [34.0522, -118.2437],
  "Austin":        [30.2672, -97.7431],
  "Denver":        [39.7392, -104.9903],
};

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

// ─── ANSI ───────────────────────────────────────────────────────────
const a = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m",
  white: "\x1b[37m",
};

// ─── Data fetching ──────────────────────────────────────────────────
const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";

async function fetchActuals(coords: [number, number], startDate: string, endDate: string) {
  const url = `${ARCHIVE_API}?latitude=${coords[0]}&longitude=${coords[1]}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${startDate}&end_date=${endDate}`;
  const res = await fetchWithRetry(url, {}, { timeoutMs: 15_000 });
  const data = await res.json();
  if (!data.daily) return null;

  return (data.daily.time as string[]).map((date: string, i: number) => ({
    date,
    actualHighF: cToF(data.daily.temperature_2m_max[i]),
    actualLowF: cToF(data.daily.temperature_2m_min[i]),
  }));
}

/**
 * Fetch multi-model forecasts.
 *
 * For recent dates (< 14 days old) we can use the live forecast APIs
 * with past_days. For older dates, we simulate realistic ensemble
 * forecasts by taking the actual temperature from archive and adding
 * Gaussian noise per model — calibrated to measured forecast error
 * (σ ≈ 1.5°F per model, slightly different biases).
 */
async function fetchModelForecasts(
  coords: [number, number],
  days: number,
  actuals?: { date: string; actualHighF: number; actualLowF: number }[],
) {
  const [lat, lon] = coords;
  const results = new Map<string, Map<string, { highF: number; lowF: number }>>();

  // Try live forecast APIs first (works for recent ~14 days)
  const models = [
    { name: "open-meteo", url: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&past_days=14&forecast_days=${days}` },
    { name: "ecmwf", url: `https://api.open-meteo.com/v1/ecmwf?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&past_days=14&forecast_days=${days}` },
    { name: "gfs", url: `https://api.open-meteo.com/v1/gfs?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&past_days=14&forecast_days=${days}` },
  ];

  for (const model of models) {
    try {
      const res = await fetchWithRetry(model.url, {}, { timeoutMs: 10_000, maxRetries: 1 });
      const data = await res.json();
      if (!data.daily) continue;
      const dateMap = new Map<string, { highF: number; lowF: number }>();
      for (let i = 0; i < data.daily.time.length; i++) {
        dateMap.set(data.daily.time[i], {
          highF: cToF(data.daily.temperature_2m_max[i]),
          lowF: cToF(data.daily.temperature_2m_min[i]),
        });
      }
      results.set(model.name, dateMap);
    } catch {}
  }

  // If live APIs didn't cover the dates, synthesize from actuals
  if (actuals && actuals.length > 0) {
    const coveredDates = new Set<string>();
    for (const [, dateMap] of results) {
      for (const d of dateMap.keys()) coveredDates.add(d);
    }

    const uncovered = actuals.filter(a => !coveredDates.has(a.date));
    if (uncovered.length > 0) {
      // Synthesize 3 model forecasts with realistic per-model noise
      // Each model has slightly different bias + noise (calibrated to σ≈1.5°F)
      const syntheticModels = [
        { name: "syn-openmeteo", bias: 0.2, sigma: 1.4 },
        { name: "syn-ecmwf",    bias: -0.3, sigma: 1.3 },
        { name: "syn-gfs",      bias: 0.5, sigma: 1.6 },
      ];

      for (const sm of syntheticModels) {
        const dateMap = new Map<string, { highF: number; lowF: number }>();
        for (const act of uncovered) {
          // Box-Muller for Gaussian noise
          const u1 = Math.random();
          const u2 = Math.random();
          const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          const noiseHigh = sm.bias + sm.sigma * z;

          const u3 = Math.random();
          const u4 = Math.random();
          const z2 = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u4);
          const noiseLow = sm.bias + sm.sigma * z2;

          dateMap.set(act.date, {
            highF: Math.round((act.actualHighF - noiseHigh) * 10) / 10,
            lowF: Math.round((act.actualLowF - noiseLow) * 10) / 10,
          });
        }
        results.set(sm.name, dateMap);
      }
    }
  }

  return results;
}

// ─── Kalshi bracket generation ──────────────────────────────────────
interface KalshiBracket {
  lowF: number;
  highF: number;
  label: string;
}

/**
 * Generate Kalshi-style brackets: 6 total
 *   - 1 low tail: ≤(center-3)°F
 *   - 4 middle: 2°F wide each
 *   - 1 high tail: ≥(center+5)°F
 */
function generateKalshiBrackets(centerF: number): KalshiBracket[] {
  const base = Math.round(centerF) - 3;
  return [
    { lowF: -Infinity, highF: base - 1,  label: `≤${base - 1}°F` },
    { lowF: base,      highF: base + 1,  label: `${base}-${base + 1}°F` },
    { lowF: base + 2,  highF: base + 3,  label: `${base + 2}-${base + 3}°F` },
    { lowF: base + 4,  highF: base + 5,  label: `${base + 4}-${base + 5}°F` },
    { lowF: base + 6,  highF: base + 7,  label: `${base + 6}-${base + 7}°F` },
    { lowF: base + 8,  highF: Infinity,  label: `≥${base + 8}°F` },
  ];
}

// ─── Gaussian CDF ───────────────────────────────────────────────────
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) * (
    0.3193815 * t - 0.3565638 * t * t + 1.781478 * t * t * t
    - 1.8212560 * t * t * t * t + 1.3302744 * t * t * t * t * t
  );
  return x >= 0 ? 1 - p : p;
}

function bracketProb(forecastF: number, spreadF: number, lowF: number, highF: number, hoursOut: number): number {
  const baseSigma = hoursOut <= 12 ? 1.5 : hoursOut <= 24 ? 2.0 : hoursOut <= 48 ? 3.0 : 4.0;
  const sigma = Math.sqrt(baseSigma ** 2 + spreadF ** 2);

  const zLow = isFinite(lowF) ? (lowF - 0.5 - forecastF) / sigma : -Infinity;
  const zHigh = isFinite(highF) ? (highF + 0.5 - forecastF) / sigma : Infinity;
  const pLow = isFinite(zLow) ? normCdf(zLow) : 0;
  const pHigh = isFinite(zHigh) ? normCdf(zHigh) : 1;
  return Math.max(0, Math.min(1, pHigh - pLow));
}

// Simulate market price — realism tunable via MARKET_SIGMA_MULT + SLIPPAGE_CENTS
function simulateMarketPrice(forecastF: number, bracket: KalshiBracket, hoursOut: number): number {
  // Our model's sigma at this horizon
  const ourSigma = hoursOut <= 12 ? 1.5 : hoursOut <= 24 ? 2.0 : hoursOut <= 48 ? 3.0 : hoursOut <= 72 ? 4.0 : 5.0;
  const marketSigma = ourSigma * MARKET_SIGMA_MULT;
  const zLow = isFinite(bracket.lowF) ? (bracket.lowF - 0.5 - forecastF) / marketSigma : -Infinity;
  const zHigh = isFinite(bracket.highF) ? (bracket.highF + 0.5 - forecastF) / marketSigma : Infinity;
  const pLow = isFinite(zLow) ? normCdf(zLow) : 0;
  const pHigh = isFinite(zHigh) ? normCdf(zHigh) : 1;
  let marketPrice = Math.max(0, Math.min(1, pHigh - pLow));

  // Add noise ±3% to simulate real market imperfection
  const noise = (Math.random() - 0.5) * 0.06;
  marketPrice = Math.max(0.01, Math.min(0.99, marketPrice + noise));

  // Slippage — we pay the ask, not the mid. Add cents on top.
  marketPrice = Math.min(0.99, marketPrice + SLIPPAGE_CENTS / 100);

  // Round to cents (Kalshi pricing)
  return Math.round(marketPrice * 100) / 100;
}

// ─── Ladder builder ─────────────────────────────────────────────────
interface LadderLeg {
  bracket: KalshiBracket;
  entryPrice: number;
  shares: number;
  cost: number;
  ourProb: number;
  edge: number;
}

function buildLadder(
  brackets: KalshiBracket[],
  forecastF: number,
  spreadF: number,
  hoursOut: number,
  budget: number,
): LadderLeg[] {
  // Score each bracket
  const candidates: { bracket: KalshiBracket; ourProb: number; marketPrice: number; edge: number }[] = [];

  // Effective sigma used by tail filter (matches live bot math)
  const baseSigma = hoursOut <= 12 ? 1.5 : hoursOut <= 24 ? 2.0 : hoursOut <= 48 ? 3.0 : hoursOut <= 72 ? 4.0 : 5.0;
  const effSigma = Math.max(1.5, Math.sqrt(baseSigma ** 2 + spreadF ** 2));

  for (const bracket of brackets) {
    const ourProb = bracketProb(forecastF, spreadF, bracket.lowF, bracket.highF, hoursOut);
    const marketPrice = simulateMarketPrice(forecastF, bracket, hoursOut);

    // Filter 1: skip dead + penny brackets (no real liquidity)
    if (marketPrice < MIN_BRACKET_PRICE || marketPrice > 0.95) continue;

    // Filter 2: tail-bracket filter — skip if forecast is far outside bracket
    const bLow = isFinite(bracket.lowF) ? bracket.lowF : -Infinity;
    const bHigh = isFinite(bracket.highF) ? bracket.highF : Infinity;
    let distAway = 0;
    if (forecastF < bLow) distAway = bLow - forecastF;
    else if (forecastF > bHigh) distAway = forecastF - bHigh;
    const distSigmas = distAway / effSigma;
    if (distSigmas > MAX_TAIL_SIGMA) continue;

    const edge = ourProb - marketPrice;
    // Filter 3: max-edge sanity check (only on tail bets — interior high-edge is legit)
    const isTailBet = distAway > 0;
    if (isTailBet && edge > MAX_EDGE) continue;

    if (edge >= MIN_EDGE) {
      candidates.push({ bracket, ourProb, marketPrice, edge });
    }
  }

  // Sort by edge (best first)
  candidates.sort((a, b) => b.edge - a.edge);

  // Build ladder with budget
  const legs: LadderLeg[] = [];
  let remaining = budget;

  for (const cand of candidates.slice(0, MAX_LEGS)) {
    if (remaining <= 0.50) break;

    // Edge-weighted sizing: bigger edge → bigger allocation
    // (cheap bracket bonus removed — was amplifying overpriced tail bets)
    const weight = cand.edge / candidates.reduce((s, c) => s + c.edge, 0);
    let legBudget = Math.min(remaining, budget * weight * 1.5);
    legBudget = Math.max(1, Math.min(legBudget, remaining));

    const shares = Math.floor(legBudget / cand.marketPrice);
    if (shares < 1) continue;
    const cost = shares * cand.marketPrice;

    legs.push({
      bracket: cand.bracket,
      entryPrice: cand.marketPrice,
      shares,
      cost,
      ourProb: cand.ourProb,
      edge: cand.edge,
    });
    remaining -= cost;
  }

  return legs;
}

// ─── Resolve ────────────────────────────────────────────────────────
function resolveLeg(leg: LadderLeg, actualHighF: number): { won: boolean; pnl: number } {
  const inBracket =
    actualHighF >= (isFinite(leg.bracket.lowF) ? leg.bracket.lowF : -Infinity) &&
    actualHighF <= (isFinite(leg.bracket.highF) ? leg.bracket.highF : Infinity);
  if (!inBracket) return { won: false, pnl: -leg.cost };
  // Kalshi charges 7% on net winnings for wins (not gross payout, not losses)
  const payout = leg.shares * 1.0;
  const grossWin = payout - leg.cost;
  const fee = grossWin * KALSHI_FEE_RATE;
  return { won: true, pnl: grossWin - fee };
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`
${a.blue}${a.bold}  ╔═══════════════════════════════════════════╗
  ║   KALSHI WEATHER STRATEGY BACKTEST        ║
  ║   Ladder + Ensemble on 6 US Cities        ║
  ╚═══════════════════════════════════════════╝${a.reset}
`);

  // Go back 3-30 days (archive has ~2 day lag)
  const now = new Date();
  const endDate = new Date(now.getTime() - DAYS_LAG * 86400000);
  const startDate = new Date(now.getTime() - (DAYS_BACK + DAYS_LAG) * 86400000);
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  console.log(`  ${a.dim}Period:${a.reset}          ${startStr} to ${endStr}`);
  console.log(`  ${a.dim}Cities:${a.reset}          ${Object.keys(CITIES).join(", ")}`);
  console.log(`  ${a.dim}Balance:${a.reset}         $${STARTING_BALANCE}`);
  console.log(`  ${a.dim}Ladder budget:${a.reset}   $${LADDER_BUDGET}/market (up to ${MAX_LEGS} legs)`);
  console.log(`  ${a.dim}Min edge:${a.reset}        ${(MIN_EDGE * 100).toFixed(0)}%`);
  console.log(`  ${a.dim}Horizon:${a.reset}         ${HOURS_OUT}h simulated`);
  console.log(`  ${a.dim}Bracket style:${a.reset}   Kalshi (6 brackets: 2 tails + 4×2°F)`);
  console.log();

  // ─── Part 1: Forecast Accuracy ──────────────────────────────────
  console.log(`${a.bold}  PART 1: FORECAST ACCURACY (ensemble)${a.reset}\n`);

  const allErrors: number[] = [];
  const cityData = new Map<string, { actuals: { date: string; actualHighF: number }[]; models: Map<string, Map<string, { highF: number }>> }>();

  for (const [city, coords] of Object.entries(CITIES)) {
    const actuals = await fetchActuals(coords, startStr, endStr);
    const models = await fetchModelForecasts(coords, 3, actuals ?? undefined);
    if (!actuals || models.size === 0) {
      console.log(`  ${a.dim}Skipping ${city} — no data${a.reset}`);
      continue;
    }

    cityData.set(city, { actuals, models });

    const cityErrors: number[] = [];
    for (const actual of actuals) {
      // Compute ensemble mean for this date
      const highs: number[] = [];
      for (const [, dateMap] of models) {
        const d = dateMap.get(actual.date);
        if (d) highs.push(d.highF);
      }
      if (highs.length === 0) continue;
      const ensembleF = highs.reduce((s, h) => s + h, 0) / highs.length;
      const error = actual.actualHighF - ensembleF;
      cityErrors.push(error);
      allErrors.push(error);
    }

    if (cityErrors.length > 0) {
      const mean = cityErrors.reduce((s, e) => s + e, 0) / cityErrors.length;
      const std = Math.sqrt(cityErrors.reduce((s, e) => s + (e - mean) ** 2, 0) / cityErrors.length);
      const maxErr = Math.max(...cityErrors.map(Math.abs));
      const within2 = cityErrors.filter(e => Math.abs(e) <= 2).length;
      console.log(
        `  ${city.padEnd(16)} ${a.dim}n=${String(cityErrors.length).padEnd(3)}${a.reset} ` +
        `bias=${mean >= 0 ? "+" : ""}${mean.toFixed(1)}°F  σ=${a.bold}${std.toFixed(1)}°F${a.reset}  ` +
        `max=${maxErr.toFixed(1)}°F  ±2°F=${((within2 / cityErrors.length) * 100).toFixed(0)}%`
      );
    }
  }

  if (allErrors.length > 0) {
    const mean = allErrors.reduce((s, e) => s + e, 0) / allErrors.length;
    const std = Math.sqrt(allErrors.reduce((s, e) => s + (e - mean) ** 2, 0) / allErrors.length);
    const within2 = allErrors.filter(e => Math.abs(e) <= 2).length;
    const within4 = allErrors.filter(e => Math.abs(e) <= 4).length;

    console.log(`\n  ${a.bold}OVERALL${a.reset} (n=${allErrors.length})`);
    console.log(`  Mean error:    ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}°F`);
    console.log(`  Std deviation: ${a.bold}${std.toFixed(2)}°F${a.reset}`);
    console.log(`  Within ±2°F:   ${((within2 / allErrors.length) * 100).toFixed(0)}%`);
    console.log(`  Within ±4°F:   ${((within4 / allErrors.length) * 100).toFixed(0)}%`);

    if (std > 3.5) {
      console.log(`  ${a.red}⚠ Forecast error is high — edges may be overstated${a.reset}`);
    } else if (std < 2.5) {
      console.log(`  ${a.green}✓ Forecast accuracy is strong for this strategy${a.reset}`);
    }
  }

  // ─── Part 2: Simulated ladder trading ───────────────────────────
  console.log(`\n${a.bold}  PART 2: LADDER TRADING SIMULATION${a.reset}\n`);

  let balance = STARTING_BALANCE;
  let totalPnl = 0;
  let totalLadders = 0;
  let ladderWins = 0;
  let ladderLosses = 0;
  let totalLegs = 0;
  let legWins = 0;
  let legLosses = 0;
  const ladderResults: { city: string; date: string; legs: number; cost: number; pnl: number; hits: number; actualF: number; forecastF: number }[] = [];

  for (const [city, data] of cityData) {
    for (const actual of data.actuals) {
      // Compute ensemble forecast + spread
      const highs: number[] = [];
      for (const [, dateMap] of data.models) {
        const d = dateMap.get(actual.date);
        if (d) highs.push(d.highF);
      }
      if (highs.length < 2) continue;

      const ensembleF = highs.reduce((s, h) => s + h, 0) / highs.length;
      const spreadF = Math.sqrt(highs.reduce((s, h) => s + (h - ensembleF) ** 2, 0) / highs.length);

      // Skip if models disagree too much
      if (spreadF > 4.0) continue;

      // Generate Kalshi-style brackets
      const brackets = generateKalshiBrackets(ensembleF);

      // Budget check
      if (balance < LADDER_BUDGET * 0.5) continue;
      const effectiveBudget = Math.min(LADDER_BUDGET, balance);

      // Build ladder
      const legs = buildLadder(brackets, ensembleF, spreadF, HOURS_OUT, effectiveBudget);
      if (legs.length === 0) continue;

      // Resolve each leg
      let ladderPnl = 0;
      let ladderCost = 0;
      let hits = 0;

      for (const leg of legs) {
        const result = resolveLeg(leg, actual.actualHighF);
        ladderPnl += result.pnl;
        ladderCost += leg.cost;
        totalLegs++;
        if (result.won) { legWins++; hits++; }
        else legLosses++;
      }

      balance += ladderPnl;
      totalPnl += ladderPnl;
      totalLadders++;
      if (ladderPnl > 0) ladderWins++;
      else ladderLosses++;

      ladderResults.push({
        city,
        date: actual.date,
        legs: legs.length,
        cost: ladderCost,
        pnl: ladderPnl,
        hits,
        actualF: actual.actualHighF,
        forecastF: Math.round(ensembleF * 10) / 10,
      });
    }
  }

  // Print ladder results (last 40)
  const showResults = ladderResults.slice(-40);
  if (ladderResults.length > 40) {
    console.log(`  ${a.dim}(Showing last 40 of ${ladderResults.length} ladders)${a.reset}\n`);
  }

  for (const r of showResults) {
    const pnlColor = r.pnl >= 0 ? a.green : a.red;
    const pnlSign = r.pnl >= 0 ? "+" : "";
    console.log(
      `  ${r.city.padEnd(16)} ${r.date}  ` +
      `fc=${String(r.forecastF).padEnd(5)}°F  actual=${String(r.actualF).padEnd(5)}°F  ` +
      `${r.hits}/${r.legs} hit  $${r.cost.toFixed(2).padStart(6)}  ` +
      `${pnlColor}${pnlSign}$${r.pnl.toFixed(2).padStart(6)}${a.reset}`
    );
  }

  // ─── Summary ────────────────────────────────────────────────────
  const wr = totalLegs > 0 ? ((legWins / totalLegs) * 100).toFixed(1) : "—";
  const ladderWr = totalLadders > 0 ? ((ladderWins / totalLadders) * 100).toFixed(1) : "—";
  const roi = ((balance - STARTING_BALANCE) / STARTING_BALANCE * 100).toFixed(1);
  const avgPnlPerLadder = totalLadders > 0 ? totalPnl / totalLadders : 0;
  const avgLegsPerLadder = totalLadders > 0 ? (totalLegs / totalLadders).toFixed(1) : "—";

  console.log(`\n  ${a.dim}${"─".repeat(60)}${a.reset}`);
  console.log(`  ${a.blue}${a.bold}KALSHI BACKTEST RESULTS${a.reset}`);
  console.log(`  ${a.dim}${"─".repeat(60)}${a.reset}`);
  console.log(`  Period:             ${startStr} to ${endStr}`);
  console.log(`  Cities:             ${Object.keys(CITIES).length}`);
  console.log(`  Days × cities:      ${ladderResults.length} ladders`);
  console.log(`  Total legs:         ${totalLegs} (avg ${avgLegsPerLadder}/ladder)`);
  console.log(`  Leg W/L:            ${legWins}W-${legLosses}L (${wr}%)`);
  console.log(`  Ladder W/L:         ${ladderWins}W-${ladderLosses}L (${ladderWr}%)`);
  console.log(`  ${a.dim}${"─".repeat(40)}${a.reset}`);
  console.log(`  Starting balance:   $${STARTING_BALANCE.toFixed(2)}`);
  console.log(`  Final balance:      ${balance >= STARTING_BALANCE ? a.green : a.red}$${balance.toFixed(2)}${a.reset}`);
  console.log(`  Total P&L:          ${totalPnl >= 0 ? a.green + "+" : a.red}$${totalPnl.toFixed(2)}${a.reset}`);
  console.log(`  ROI:                ${parseFloat(roi) >= 0 ? a.green + "+" : a.red}${roi}%${a.reset}`);
  console.log(`  Avg P&L/ladder:     ${avgPnlPerLadder >= 0 ? a.green + "+" : a.red}$${avgPnlPerLadder.toFixed(2)}${a.reset}`);
  console.log(`  ${a.dim}${"─".repeat(60)}${a.reset}`);

  // Per-city breakdown
  console.log(`\n  ${a.bold}PER-CITY BREAKDOWN${a.reset}\n`);
  for (const city of Object.keys(CITIES)) {
    const cityLadders = ladderResults.filter(r => r.city === city);
    if (cityLadders.length === 0) continue;
    const cityPnl = cityLadders.reduce((s, r) => s + r.pnl, 0);
    const cityWins = cityLadders.filter(r => r.pnl > 0).length;
    const cityCost = cityLadders.reduce((s, r) => s + r.cost, 0);
    const pnlColor = cityPnl >= 0 ? a.green : a.red;
    console.log(
      `  ${city.padEnd(16)} ${String(cityLadders.length).padStart(3)} ladders  ` +
      `${cityWins}W-${cityLadders.length - cityWins}L  ` +
      `cost=$${cityCost.toFixed(2).padStart(7)}  ` +
      `${pnlColor}${cityPnl >= 0 ? "+" : ""}$${cityPnl.toFixed(2).padStart(7)}${a.reset}`
    );
  }
  console.log();
}

main().catch(err => {
  console.error(`FATAL: ${err}`);
  process.exit(1);
});
