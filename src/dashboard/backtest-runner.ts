/**
 * Programmatic backtest runner for the dashboard.
 *
 * Runs a one-shot evaluation of the strategy against REAL Kalshi
 * settled markets and REAL open-meteo historical forecasts:
 *
 *   - Entry price  = Kalshi market's midpoint of (yes_bid, yes_ask),
 *                    falling back to last_price_dollars.
 *   - Resolution   = Kalshi market.result ("yes" | "no"), i.e. how the
 *                    market actually settled. Not a weather lookup.
 *   - Forecast     = open-meteo HISTORICAL-FORECAST archive, which
 *                    returns the forecast as it was issued in the past
 *                    (no lookahead).
 *
 * If Kalshi has no settled markets for a given city+date (e.g. the
 * series hadn't launched yet), that date is skipped — we do NOT fall
 * back to synthetic prices. See the `dataSource` and `daysSkipped`
 * fields on BacktestResult so the caller can show users how much of
 * the requested window actually produced evaluable trades.
 *
 * The forecast-accuracy stats (byCity meanError / stddev / withinNF)
 * still come from the open-meteo `archive-api` for daily highs, which
 * matches how Kalshi settles (NWS Daily Climate Report).
 *
 * Related:
 *   - SIGNAL_IMPROVEMENTS.md item 1.2: archive-forecast API (shipped)
 *   - SIGNAL_IMPROVEMENTS.md item 1.3: real market prices (shipped)
 *   - LOSS_DIAGNOSIS.md §Synthetic market price: eliminated here.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { bracketProbability } from "../weather/WeatherForecast";
import { KALSHI_FEE_RATE, kalshiFee } from "./trading-math";
import { KalshiClient } from "../kalshi/KalshiClient";
import { parseDollars, type KalshiEvent, type KalshiMarket } from "../kalshi/types";
import { KALSHI_WEATHER_CITIES } from "../kalshi/KalshiWeatherFinder";

// ─── Public interfaces ──────────────────────────────────────────────

export interface BacktestParams {
  cities?: string[];      // defaults to all
  daysBack?: number;      // how far back (default 10)
  minEdge?: number;       // minimum edge to trade (default 0.10)
  positionSize?: number;  // dollars per trade (default 5)
  startBalance?: number;  // starting balance (default 500)
  /**
   * How many hours before close_time to sample the "pre-resolution"
   * price. Kalshi KXHIGH markets close at midnight local time AFTER
   * the measurement day, so 1h before close = ~11pm on measurement day
   * (the high is already observed — market has fully converged).
   *
   * Use 18-24h to sample the morning of the measurement day before the
   * high is reached — i.e. the window when a scanning bot would
   * realistically enter. Default 24h.
   */
  entryHoursBeforeClose?: number;
}

export interface BacktestTrade {
  city: string;
  date: string;
  /** Kalshi market ticker — makes trades cross-referenceable to the real market. */
  ticker?: string;
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
  /**
   * "kalshi-real" when settlement results + entry prices came from
   * Kalshi's settled-markets feed. "synthetic-fallback" when Kalshi
   * was unreachable and the runner fell back to the old
   * probability-plus-noise pricing (kept only so the dashboard isn't
   * bricked by a Kalshi outage — results under this path are NOT a
   * measurement of real edge).
   */
  dataSource: "kalshi-real" | "synthetic-fallback";
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
    totalGrossPnl: number;
    totalFeesPaid: number;
    roi: number;
    avgPnlPerTrade: number;
    avgEdgeAtEntry: number;
    avgEntryPrice: number;
    tradesBelowBreakeven: number;
    /** Number of Kalshi markets evaluated (passed bracket/gate filters skipped or not). */
    kalshiMarketsEvaluated: number;
    /** Distinct (city, date) pairs for which Kalshi had settled data. */
    daysWithKalshiData: number;
    /** Distinct (city, date) pairs that had no Kalshi settled event. */
    daysMissingKalshiData: number;
  };
  /** Equity curve: balance after each trade */
  equityCurve: { tradeIndex: number; balance: number }[];
  /**
   * Notes for the UI — e.g. "Kalshi only had settled markets for the
   * last 12 of your requested 30 days; earlier days skipped."
   */
  notes: string[];
}

// ─── Constants ──────────────────────────────────────────────────────

const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";
// HISTORICAL-FORECAST-API returns the forecast AS IT WAS ISSUED in the
// past (no lookahead). The live forecast endpoint with `past_days` would
// return CURRENT forecasts for past dates, i.e. forecasts issued after
// the target day — which gives the model hindsight. See
// SIGNAL_IMPROVEMENTS.md item 1.2.
const HISTORICAL_FORECAST_API = "https://historical-forecast-api.open-meteo.com/v1/forecast";

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

/**
 * Map our friendly city names to Kalshi series tickers. Defined inline
 * (rather than re-export'd from KalshiWeatherFinder) because KalshiWeatherFinder
 * uses slightly richer metadata (lat/lon, WFO code) that we don't need here.
 */
const CITY_TO_SERIES: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const c of KALSHI_WEATHER_CITIES) m[c.city] = c.seriesTicker;
  return m;
})();

// Singleton — no auth needed for public market data.
let _kalshiClient: KalshiClient | null = null;
function getKalshi(): KalshiClient {
  if (!_kalshiClient) {
    _kalshiClient = new KalshiClient({ demo: false, timeout: 15_000 });
  }
  return _kalshiClient;
}

// ─── Helpers ────────────────────────────────────────────────────────

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

/** Wider-sigma "market" estimate — only used in synthetic-fallback mode. */
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

async function fetchHistoricalForecasts(
  coords: [number, number],
  startDate: string,
  endDate: string,
): Promise<DayForecast[] | null> {
  const url =
    `${HISTORICAL_FORECAST_API}?latitude=${coords[0]}&longitude=${coords[1]}` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto` +
    `&start_date=${startDate}&end_date=${endDate}`;

  try {
    const res = await fetchWithRetry(url, {}, { timeoutMs: 20_000 });
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

/** Pull all settled KXHIGH events for a series + date window, keyed by event date. */
async function fetchKalshiSettledEvents(
  seriesTicker: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, KalshiEvent>> {
  const byDate = new Map<string, KalshiEvent>();
  try {
    const events = await getKalshi().getAllEvents({
      series_ticker: seriesTicker,
      status: "settled",
      with_nested_markets: true,
    });

    // Event ticker encodes the resolution date: KXHIGHNY-26APR15 → 2026-04-15
    for (const ev of events) {
      const d = parseEventDateFromTicker(ev.event_ticker);
      if (!d) continue;
      if (d < startDate || d > endDate) continue;
      byDate.set(d, ev);
    }
  } catch (err) {
    console.warn(
      `[backtest] Kalshi fetch failed for ${seriesTicker}: ${(err as Error).message}`,
    );
  }
  return byDate;
}

/** Parse event date from `KXHIGHNY-26APR15` → `2026-04-15`. */
function parseEventDateFromTicker(eventTicker: string): string | null {
  const match = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const year = 2000 + parseInt(match[1]);
  const monthMap: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04",
    MAY: "05", JUN: "06", JUL: "07", AUG: "08",
    SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const month = monthMap[match[2]];
  if (!month) return null;
  return `${year}-${month}-${parseInt(match[3]).toString().padStart(2, "0")}`;
}

// ─── Bracket parsing (mirrors KalshiWeatherFinder's logic) ──────────

interface BracketBounds {
  lowF: number;
  highF: number;
  label: string;
}

function parseBracketFromKalshiMarket(market: KalshiMarket): BracketBounds | null {
  // Prefer yes_sub_title (human-readable) — most accurate
  const fromTitle = parseBracketFromTitle(market.yes_sub_title);
  if (fromTitle) {
    return { ...fromTitle, label: labelFor(fromTitle.lowF, fromTitle.highF) };
  }

  // Fall back to strike_type + floor/cap
  const strike = market.strike_type;
  const floor = market.floor_strike;
  const cap = market.cap_strike;

  let lowF: number;
  let highF: number;
  if (strike === "less" || strike === "less_or_equal") {
    lowF = -Infinity;
    highF = (cap ?? NaN) - 1;
  } else if (strike === "greater" || strike === "greater_or_equal") {
    lowF = (floor ?? NaN) + 1;
    highF = Infinity;
  } else if (strike === "between" && floor !== undefined && cap !== undefined) {
    lowF = floor;
    highF = cap;
  } else {
    return null;
  }
  if (isNaN(lowF) && isNaN(highF)) return null;
  return { lowF, highF, label: labelFor(lowF, highF) };
}

function parseBracketFromTitle(title: string): { lowF: number; highF: number } | null {
  const belowMatch = title.match(/(\d+)\s*°?F?\s+or\s+(below|less)/i);
  if (belowMatch) return { lowF: -Infinity, highF: parseInt(belowMatch[1]) };
  const aboveMatch = title.match(/(\d+)\s*°?F?\s+or\s+(higher|more|above)/i);
  if (aboveMatch) return { lowF: parseInt(aboveMatch[1]), highF: Infinity };
  const rangeMatch = title.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (rangeMatch) return { lowF: parseInt(rangeMatch[1]), highF: parseInt(rangeMatch[2]) };
  return null;
}

function labelFor(lowF: number, highF: number): string {
  if (!isFinite(lowF)) return `≤${highF}°F`;
  if (!isFinite(highF)) return `≥${lowF}°F`;
  if (lowF === highF) return `${lowF}°F`;
  return `${lowF}-${highF}°F`;
}

/**
 * Pull the last trade price BEFORE the market resolved.
 *
 * Why we can't just use `market.last_price_dollars`: on a settled
 * market, Kalshi's last_price is the FINAL tick (0.99 for winners,
 * 0.01 for losers) and the orderbook is empty (bid=0, ask=1). Using
 * that as our "entry price" is perfect hindsight — the market's
 * "price" already encodes the outcome. We'd never have any edge.
 *
 * Instead we fetch the most recent trade print at least
 * `hoursBeforeClose` before the market's close_time. That's the price
 * a real bot would have seen when scanning 1+ hour before resolution.
 *
 * Returns null when no trades exist in the window (market never got
 * active trading activity — not tradeable for this strategy).
 */
async function fetchPreResolutionYesPrice(
  ticker: string,
  closeTimeIso: string,
  hoursBeforeClose: number = 1,
): Promise<number | null> {
  const closeMs = new Date(closeTimeIso).getTime();
  if (!isFinite(closeMs)) return null;
  const cutoffTs = Math.floor((closeMs - hoursBeforeClose * 3600_000) / 1000);
  try {
    // Kalshi returns trades in descending time order, so the first
    // trade with created_time ≤ cutoff is the most recent pre-res print.
    // Note: Kalshi's actual trade schema uses `yes_price_dollars` (string,
    // e.g. "0.4500"), not the `yes_price` integer-cents field documented
    // in types.ts — we index into the raw object and parse.
    const res = await getKalshi().listTrades({ ticker, max_ts: cutoffTs, limit: 10 });
    const trades = res.trades ?? [];
    if (trades.length === 0) return null;
    const latest = trades[0] as unknown as Record<string, unknown>;
    const raw =
      typeof latest.yes_price_dollars === "string"
        ? parseDollars(latest.yes_price_dollars)
        : typeof latest.yes_price === "number"
        ? latest.yes_price / 100
        : NaN;
    if (!isFinite(raw) || raw <= 0 || raw >= 1) return null;
    return Math.max(0.01, Math.min(0.99, raw));
  } catch {
    return null;
  }
}

// ─── Bracket generation (synthetic-fallback only) ───────────────────

interface BracketSim {
  lowF: number;
  highF: number;
  label: string;
}

function generateBrackets(centerF: number): BracketSim[] {
  const brackets: BracketSim[] = [];
  const startF = Math.round(centerF / 2) * 2 - 12;
  brackets.push({ lowF: -Infinity, highF: startF - 1, label: `<=${startF - 1}°F` });
  for (let f = startF; f <= startF + 22; f += 2) {
    brackets.push({ lowF: f, highF: f + 1, label: `${f}-${f + 1}°F` });
  }
  brackets.push({ lowF: startF + 24, highF: Infinity, label: `>=${startF + 24}°F` });
  return brackets;
}

// ─── Accuracy helpers ───────────────────────────────────────────────

function computeAccuracy(city: string, errors: number[]): BacktestAccuracy {
  if (errors.length === 0) {
    return { city, n: 0, meanError: 0, stddev: 0, maxError: 0, within2F: 0, within4F: 0 };
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
  const entryHoursBeforeClose = params.entryHoursBeforeClose ?? 24;

  const cityNames = params.cities && params.cities.length > 0
    ? params.cities.filter((c) => c in ALL_CITIES)
    : Object.keys(ALL_CITIES);

  const cities: Record<string, [number, number]> = {};
  for (const name of cityNames) cities[name] = ALL_CITIES[name];

  // Date range: archive has ~2 day lag, so go daysBack+2 to 2 days ago
  const now = new Date();
  const endDate = new Date(now.getTime() - 3 * 86400000);
  const startDate = new Date(now.getTime() - (daysBack + 2) * 86400000);
  const startStr = toDateStr(startDate);
  const endStr = toDateStr(endDate);

  // ─── Fetch per-city data in parallel ──────────────────────────

  const notes: string[] = [];
  const cityData = new Map<
    string,
    {
      actuals: DayActual[];
      forecasts: DayForecast[];
      kalshiByDate: Map<string, KalshiEvent>;
    }
  >();

  // Parallelize per-city data fetching — the 3 upstream APIs are independent.
  await Promise.all(
    Object.entries(cities).map(async ([city, coords]) => {
      const [actuals, forecasts, kalshiByDate] = await Promise.all([
        fetchActuals(coords, startStr, endStr),
        fetchHistoricalForecasts(coords, startStr, endStr),
        (async () => {
          const series = CITY_TO_SERIES[city];
          if (!series) return new Map<string, KalshiEvent>();
          return fetchKalshiSettledEvents(series, startStr, endStr);
        })(),
      ]);
      if (!actuals || !forecasts) return;
      cityData.set(city, { actuals, forecasts, kalshiByDate });
    }),
  );

  // ─── Part 1: Forecast accuracy (uses open-meteo archive) ───────

  const allErrors: number[] = [];
  const cityAccuracies: BacktestAccuracy[] = [];
  for (const [city, { actuals, forecasts }] of cityData.entries()) {
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

  // ─── Part 2: Decide data source ────────────────────────────────

  let totalKalshiEvents = 0;
  for (const { kalshiByDate } of cityData.values()) totalKalshiEvents += kalshiByDate.size;
  const dataSource: "kalshi-real" | "synthetic-fallback" =
    totalKalshiEvents > 0 ? "kalshi-real" : "synthetic-fallback";

  if (dataSource === "synthetic-fallback") {
    notes.push(
      "Kalshi returned zero settled events for this window — backtest fell back to " +
        "synthetic probability-plus-noise market prices. This is a sanity path for when " +
        "Kalshi is unreachable; results under this mode do NOT measure real edge.",
    );
  }

  // ─── Part 3: Simulated trading ─────────────────────────────────

  let balance = startBalance;
  const trades: BacktestTrade[] = [];
  let kalshiMarketsEvaluated = 0;
  let daysWithKalshiData = 0;
  let daysMissingKalshiData = 0;
  let marketsSkippedNoTrades = 0;

  for (const [city, { actuals, forecasts, kalshiByDate }] of cityData.entries()) {
    for (const actual of actuals) {
      const forecast = forecasts.find((f) => f.date === actual.date);
      if (!forecast) continue;

      const forecastHighF = forecast.forecastHighF;
      const actualHighF = actual.actualHighF;

      if (dataSource === "kalshi-real") {
        const kalshiEvent = kalshiByDate.get(actual.date);
        if (!kalshiEvent || !kalshiEvent.markets) {
          daysMissingKalshiData += 1;
          continue;
        }
        daysWithKalshiData += 1;

        // Step 1: pre-fetch pre-resolution prices for all eligible markets
        // in this event. Done in parallel — Kalshi handles it.
        const eligible = (kalshiEvent.markets ?? []).filter((m) => {
          const okStatus =
            m.status === "settled" || m.status === "finalized" || m.status === "determined";
          return okStatus && (m.result === "yes" || m.result === "no");
        });

        const priceLookups = await Promise.all(
          eligible.map((m) =>
            fetchPreResolutionYesPrice(m.ticker, m.close_time, entryHoursBeforeClose).then((p) => ({ ticker: m.ticker, price: p })),
          ),
        );
        const priceByTicker = new Map(priceLookups.map((r) => [r.ticker, r.price]));

        // Step 2: evaluate each market with its real pre-resolution price.
        for (const market of eligible) {
          const bracket = parseBracketFromKalshiMarket(market);
          if (!bracket) continue;

          const marketPrice = priceByTicker.get(market.ticker) ?? null;
          if (marketPrice === null) {
            // No trades in the pre-resolution window — market wasn't
            // active enough for this strategy. Don't count it.
            marketsSkippedNoTrades += 1;
            continue;
          }

          const ourProb = bracketProbability(
            forecastHighF,
            bracket.lowF,
            bracket.highF,
            24,
          );

          kalshiMarketsEvaluated += 1;

          const edge = ourProb - marketPrice;
          if (edge < minEdge || marketPrice < 0.02 || marketPrice > 0.90) continue;

          const shares = Math.floor(positionSize / marketPrice);
          if (shares < 1) continue;
          const cost = shares * marketPrice;
          if (cost > balance) continue;

          // GROUND TRUTH from Kalshi — not a weather lookup.
          const inBracket = market.result === "yes";
          const grossPnl = inBracket ? shares * 1.0 - cost : -cost;
          const feePaid = kalshiFee(shares, marketPrice, inBracket);
          const pnl = grossPnl - feePaid;
          balance += pnl;

          trades.push({
            city,
            date: actual.date,
            ticker: market.ticker,
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
      } else {
        // ── Synthetic fallback (only when Kalshi returned nothing) ──
        const brackets = generateBrackets(forecastHighF);
        for (const bracket of brackets) {
          const ourProb = bracketProbability(
            forecastHighF,
            bracket.lowF,
            bracket.highF,
            24,
          );
          const marketBase = bracketProbCustomSigma(
            forecastHighF,
            bracket.lowF,
            bracket.highF,
            3.0,
          );
          const noise = (Math.random() - 0.5) * 0.06;
          const marketPrice = Math.max(0.01, Math.min(0.99, marketBase + noise));

          const edge = ourProb - marketPrice;
          if (edge < minEdge || marketPrice < 0.02 || marketPrice > 0.90) continue;

          const shares = Math.floor(positionSize / marketPrice);
          if (shares < 1) continue;
          const cost = shares * marketPrice;
          if (cost > balance) continue;

          const inBracket =
            actualHighF >= (isFinite(bracket.lowF) ? bracket.lowF : -Infinity) &&
            actualHighF <= (isFinite(bracket.highF) ? bracket.highF : Infinity);
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
  }

  if (dataSource === "kalshi-real") {
    notes.push(
      `Real Kalshi settled markets: ${kalshiMarketsEvaluated} brackets evaluated across ` +
        `${daysWithKalshiData} city-days. ${daysMissingKalshiData} city-days skipped (no ` +
        `settled event on Kalshi — likely pre-launch or still unresolved). ` +
        `${marketsSkippedNoTrades} markets skipped for lack of pre-resolution trade prints.`,
    );
    notes.push(
      `Entry prices come from the most recent trade print at least ${entryHoursBeforeClose}h before each ` +
        "market's close_time — i.e. what a live bot would have seen when scanning in the morning " +
        "of the measurement day, not the final settlement tick (Kalshi KXHIGH markets close at " +
        "midnight local time AFTER the measurement day, so 1-6h pre-close = post-observation). " +
        "Win/loss comes directly from market.result as Kalshi finalized. " +
        "Forecasts come from open-meteo historical-forecast-api (as-issued; no lookahead).",
    );
  }

  // ─── Equity curve ──────────────────────────────────────────────

  const equityCurve = trades.map((t, i) => ({
    tradeIndex: i,
    balance: t.balanceAfter,
  }));

  // ─── Summary ──────────────────────────────────────────────────

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

  const tradesBelowBreakeven =
    trades.length > 0
      ? trades.filter((t) => t.edge < KALSHI_FEE_RATE * (1 - t.entryPrice)).length / trades.length
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
    kalshiMarketsEvaluated,
    daysWithKalshiData,
    daysMissingKalshiData,
  };

  return {
    params: { cities: cityNames, daysBack, minEdge, positionSize, startBalance },
    period: { start: startStr, end: endStr },
    dataSource,
    accuracy: { overall: overallAccuracy, byCity: cityAccuracies },
    trades,
    summary,
    equityCurve,
    notes,
  };
}
