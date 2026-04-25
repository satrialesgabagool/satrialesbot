#!/usr/bin/env bun
/**
 * Satriales Dashboard — live multi-bot viewer.
 *
 * Reads:
 *   - state/weather-intrinsic-sim.json   (intrinsic bot state)
 *   - state/weather-ensemble-sim.json    (ensemble bot state)
 *   - state/locks/kalshi-intrinsic.lock  (liveness PID)
 *   - state/locks/kalshi-ensemble.lock   (liveness PID)
 *   - results/weather-intrinsic-trades.csv
 *   - results/weather-ensemble-trades.csv
 *   - Kalshi API (live balance / positions / orders / markets)
 *   - Open-Meteo (ensemble + point forecasts — cached)
 *
 * Does NOT modify any bot state — pure read-only viewer.
 *
 * Run:  bun run dashboard            (port 3000)
 *       DASHBOARD_PORT=3001 bun run dashboard
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { KalshiClient } from "../kalshi/KalshiClient";
import { loadCredentialsFromEnv } from "../kalshi/KalshiAuth";
import { fetchGFSEnsemble, empiricalBracketProbability } from "../weather/GFSEnsemble";
import { findKalshiWeatherMarkets, KALSHI_WEATHER_CITIES } from "../kalshi/KalshiWeatherFinder";
import { createEquityLogger } from "./KalshiEquityLogger";

// Short-code → full Kalshi city name, derived from the canonical finder table.
// Short code is the segment after "KXHIGH" in the series ticker.
const CITY_CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  KALSHI_WEATHER_CITIES.map(c => [c.seriesTicker.replace(/^KXHIGH/, ""), c.city]),
);
const CITY_CODES: string[] = KALSHI_WEATHER_CITIES.map(c => c.seriesTicker.replace(/^KXHIGH/, ""));

const app = new Hono();
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3000");
const ROOT = join(import.meta.dir, "../..");

// ─── File paths ───────────────────────────────────────────────────────

const BOTS = {
  intrinsic: {
    name: "intrinsic",
    displayName: "Intrinsic Winner",
    lockPath: join(ROOT, "state/locks/kalshi-intrinsic.lock"),
    statePath: join(ROOT, "state/weather-intrinsic-sim.json"),
    tradesPath: join(ROOT, "results/weather-intrinsic-trades.csv"),
    trackerPath: join(ROOT, "state/kalshi-intrinsic-daily-tracker.json"),
    killSwitchPath: join(ROOT, "state/HALT_TRADING"),
    tickerPrefix: "INT-",
  },
  ensemble: {
    name: "ensemble",
    displayName: "Ensemble Forecast",
    lockPath: join(ROOT, "state/locks/kalshi-ensemble.lock"),
    statePath: join(ROOT, "state/weather-ensemble-sim.json"),
    tradesPath: join(ROOT, "results/weather-ensemble-trades.csv"),
    trackerPath: join(ROOT, "state/kalshi-ensemble-daily-tracker.json"),
    killSwitchPath: join(ROOT, "state/HALT_TRADING_ENSEMBLE"),
    tickerPrefix: "ENS-",
  },
} as const;

type BotKey = keyof typeof BOTS;
const BOT_KEYS = Object.keys(BOTS) as BotKey[];

// Ground-truth Kalshi equity snapshots — appended every 10 min while the
// dashboard is running. Survives bot restarts since it reads the actual
// Kalshi account rather than per-bot sim state.
const EQUITY_SNAPSHOTS_CSV = join(ROOT, "results/kalshi-equity-snapshots.csv");
const EQUITY_SNAPSHOT_INTERVAL_MS = 10 * 60_000;

// ─── Kalshi client (lazy singleton) ───────────────────────────────────

let kalshiClient: KalshiClient | null = null;
let kalshiAvailable = false;

function getKalshi(): KalshiClient | null {
  if (kalshiClient) return kalshiClient;
  const creds = loadCredentialsFromEnv();
  if (!creds) {
    kalshiAvailable = false;
    return null;
  }
  kalshiClient = new KalshiClient({ demo: false, credentials: creds });
  kalshiAvailable = true;
  return kalshiClient;
}

// ─── Tiny TTL cache for Kalshi/forecast calls ─────────────────────────

type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<any>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

// ─── Liveness / bot state helpers ─────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLock(path: string): { pid: number; since: string } | null {
  if (!existsSync(path)) return null;
  try {
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (!pid || !isPidAlive(pid)) return null;
    const { birthtime } = statSync(path);
    return { pid, since: birthtime.toISOString() };
  } catch {
    return null;
  }
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function killSwitchActive(path: string): boolean {
  return existsSync(path);
}

function bracketLabel(b: any): string {
  if (!b) return "—";
  const lo = b.lowF, hi = b.highF;
  if ((lo == null || !isFinite(lo)) && hi != null && isFinite(hi)) return `≤${hi}°F`;
  if (lo != null && isFinite(lo) && (hi == null || !isFinite(hi))) return `≥${lo}°F`;
  return `${lo}-${hi}°F`;
}

function hoursToClose(iso: string | undefined): number {
  if (!iso) return 0;
  return Math.max(0, (new Date(iso).getTime() - Date.now()) / 3600000);
}

// ─── Helpers for forecast-aware position enrichment ───────────────────

/** Parse "KXHIGHNY-26APR23" → { citySeries: "NY", dateIso: "2026-04-23" }. */
function parseEventTicker(eventTicker: string | null): { citySeries: string; dateIso: string } | null {
  if (!eventTicker) return null;
  const m = eventTicker.match(/^KXHIGH([A-Z]+)-(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const [, city, yy, monAbbr, dd] = m;
  const MONTHS: Record<string, string> = {
    JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12",
  };
  const mm = MONTHS[monAbbr];
  if (!mm) return null;
  return { citySeries: city, dateIso: `20${yy}-${mm}-${dd}` };
}

/** Extract bracket temperature range from Kalshi market strike info. */
function bracketFromKalshiMarket(m: any): { lowF: number; highF: number } | null {
  if (!m) return null;
  const floor = typeof m.floor_strike === "number" ? m.floor_strike : null;
  const cap = typeof m.cap_strike === "number" ? m.cap_strike : null;
  const type = m.strike_type;
  if (type === "less" || type === "less_or_equal") {
    if (cap == null) return null;
    return { lowF: -Infinity, highF: cap };
  }
  if (type === "greater" || type === "greater_or_equal") {
    if (floor == null) return null;
    return { lowF: floor, highF: Infinity };
  }
  if (type === "between" || type === "structured" || type === "custom") {
    if (floor == null || cap == null) return null;
    return { lowF: floor, highF: cap };
  }
  // Fallback: if we have both strikes, assume interval
  if (floor != null && cap != null) return { lowF: floor, highF: cap };
  if (cap != null) return { lowF: -Infinity, highF: cap };
  if (floor != null) return { lowF: floor, highF: Infinity };
  return null;
}

/**
 * Expected value per share, net of Kalshi's 7% fee on winnings.
 *
 *   If position wins (prob = modelProb), payoff = $1 gross.
 *   Winnings = $1 - entry. Fee = 0.07 × winnings.
 *   Net receipt on win = $1 - 0.07 × (1 - entry) = 0.93 + 0.07 × entry
 *   Gain on win = 0.93 + 0.07 × entry - entry = 0.93 × (1 - entry)
 *
 *   If position loses (prob = 1 - modelProb), gain = -entry.
 *
 *   EV_per_share = modelProb × 0.93 × (1 - entry) - (1 - modelProb) × entry
 */
const KALSHI_WINNINGS_FEE = 0.07;
function expectedValuePerShare(modelProb: number, entryPrice: number): number {
  const p = Math.max(0, Math.min(1, modelProb));
  return p * (1 - KALSHI_WINNINGS_FEE) * (1 - entryPrice) - (1 - p) * entryPrice;
}

// ─── Trade CSV parser ─────────────────────────────────────────────────

interface TradeRow {
  bot: BotKey;
  timestamp: string;
  action: string;
  city: string;
  date: string;
  type: string;
  bracket: string;
  shares: number;
  price: number;
  cost: number;
  forecastTempF: number;
  forecastProb: number;
  edge: number;
  modelSpread: number;
  models: number;
  hoursToRes: number;
  pnl: number;
  balance: number;
}

function parseCsv(path: string, bot: BotKey): TradeRow[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n").slice(1).filter(l => l.trim().length > 0);
  const rows: TradeRow[] = [];
  for (const line of lines) {
    const f = line.split(",");
    if (f.length < 13) continue;
    // Current format: 17 cols (timestamp,action,city,date,type,bracket,shares,price,cost,
    //   forecast_temp_f,forecast_prob,edge,model_spread,models,hours_to_res,pnl,balance)
    const hasExtra = f.length >= 17;
    const modelSpread = hasExtra ? parseFloat(f[12]) || 0 : 0;
    const models = hasExtra ? parseFloat(f[13]) || 0 : 0;
    const hoursToRes = parseFloat(f[hasExtra ? 14 : 12]) || 0;
    const pnl = parseFloat(f[hasExtra ? 15 : 13]) || 0;
    const balance = parseFloat(f[hasExtra ? 16 : 14]) || 0;
    rows.push({
      bot,
      timestamp: f[0],
      action: f[1],
      city: f[2],
      date: f[3],
      type: f[4],
      bracket: f[5],
      shares: parseFloat(f[6]) || 0,
      price: parseFloat(f[7]) || 0,
      cost: parseFloat(f[8]) || 0,
      forecastTempF: parseFloat(f[9]) || 0,
      forecastProb: parseFloat(f[10]) || 0,
      edge: parseFloat(f[11]) || 0,
      modelSpread, models, hoursToRes, pnl, balance,
    });
  }
  return rows;
}

function allTrades(): TradeRow[] {
  return BOT_KEYS.flatMap(k => parseCsv(BOTS[k].tradesPath, k))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ─── Bot info endpoint ───────────────────────────────────────────────

function botInfo(key: BotKey) {
  const cfg = BOTS[key];
  const lock = readLock(cfg.lockPath);
  const state = readJson(cfg.statePath);
  const tracker = readJson(cfg.trackerPath);
  const killSwitch = killSwitchActive(cfg.killSwitchPath);
  const running = lock != null;

  const openPositions: any[] = state?.positions ?? [];
  const closedPositions: any[] = state?.closedPositions ?? [];

  // Compute "today's P&L" from resolved closures since local midnight.
  // The daily tracker file only records orders placed, not P&L from
  // resolutions — so we derive it here from post-audit closedPositions
  // for a trustworthy number that updates the moment a position settles.
  const todayStartIso = new Date(new Date().toDateString()).toISOString();
  const closedToday = closedPositions.filter(p => (p.resolvedAt || "") >= todayStartIso);
  const todayPnl = closedToday.reduce((s, p) => s + (Number(p.pnl) || 0), 0);

  return {
    name: cfg.name,
    displayName: cfg.displayName,
    running,
    pid: lock?.pid ?? null,
    startedAt: lock?.since ?? null,
    uptimeSec: lock ? Math.floor((Date.now() - new Date(lock.since).getTime()) / 1000) : null,
    killSwitch,
    strategy: state?.config?.strategy ?? null,
    caps: state
      ? {
          startingBalance: state.config?.startingBalance ?? null,
          maxTotalPositions: state.config?.maxTotalPositions ?? null,
          scanIntervalMs: state.config?.scanIntervalMs ?? null,
          // Strategy-specific
          intrinsicMinPrice: state.config?.intrinsicMinPrice ?? null,
          intrinsicMaxPrice: state.config?.intrinsicMaxPrice ?? null,
          ensembleMinProb: state.config?.ensembleMinProb ?? null,
          ensembleMaxPrice: state.config?.ensembleMaxPrice ?? null,
          ensembleBetSize: state.config?.ensembleBetSize ?? null,
        }
      : null,
    daily: {
      // dailyPnl is now computed from post-audit closedPositions resolved today,
      // not from the tracker's never-updated realizedPnL field.
      date: tracker?.date ?? new Date().toISOString().slice(0, 10),
      dailyPnl: +todayPnl.toFixed(2),
      closedToday: closedToday.length,
      firstOrderConfirmed: tracker?.firstOrderConfirmed ?? null,
      ordersPlaced: tracker?.ordersPlaced ?? null,
      ordersFilled: tracker?.ordersFilled ?? null,
    },
    totals: state
      ? {
          balance: state.balance ?? 0,
          deployed: state.deployed ?? 0,
          openCount: openPositions.length,
          closedCount: closedPositions.length,
          wins: state.wins ?? 0,
          losses: state.losses ?? 0,
          totalPnl: state.totalPnl ?? 0,
          scansCompleted: state.scansCompleted ?? 0,
          savedAt: state.savedAt ?? null,
        }
      : null,
  };
}

app.get("/api/bots", (c) => c.json({
  kalshiConfigured: kalshiAvailable,
  bots: BOT_KEYS.map(botInfo),
}));

// ─── Kill switches ────────────────────────────────────────────────────

app.get("/api/kill-switches", (c) => c.json(
  BOT_KEYS.reduce((acc, k) => {
    acc[k] = { path: BOTS[k].killSwitchPath.replace(ROOT + "/", ""), active: killSwitchActive(BOTS[k].killSwitchPath) };
    return acc;
  }, {} as Record<string, { path: string; active: boolean }>),
));

// ─── Portfolio snapshot (Kalshi live, 30s cache) ──────────────────────

app.get("/api/portfolio", async (c) => {
  const k = getKalshi();
  if (!k) return c.json({ configured: false }, 200);
  try {
    const data = await cached("portfolio", 30_000, async () => {
      const bal = await k.getBalance();
      const positions = await k.getPositions({ limit: 200 });
      const openPositions = (positions.market_positions ?? []).filter(p => parseFloat(p.position_fp) !== 0);
      const totalExposure = openPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_exposure_dollars) || 0), 0);
      return {
        configured: true,
        cashUSD: (bal.balance ?? 0) / 100,
        portfolioValueUSD: (bal.portfolio_value ?? 0) / 100,
        totalDeployedUSD: totalExposure,
        openPositionCount: openPositions.length,
        updatedTs: bal.updated_ts ?? null,
      };
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ configured: true, error: err?.message ?? String(err) }, 500);
  }
});

// ─── Live positions (Kalshi + bot attribution, 30s cache) ─────────────

/**
 * Four attribution classes:
 *   - intrinsic / ensemble: actively managed by the named bot (in its state.positions).
 *   - orphan: KXHIGH* market, not in either state (leftover from a prior bot run
 *     that --fresh restart discarded; will resolve naturally).
 *   - external: non-weather market (KXGABBARD, KXGOLDCARDS, etc.) — neither bot
 *     can touch these, so it came from somewhere else (manual trade, other tool).
 *
 * For orphans, we also infer which strategy LIKELY placed them based on entry
 * price — useful when reviewing post-restart state.
 */
type AttributionClass = BotKey | "orphan" | "external";
type OrphanHint = "likely-intrinsic" | "likely-ensemble" | "unclear";

function buildManagedTickerSets(): Record<BotKey, Set<string>> {
  const out = {} as Record<BotKey, Set<string>>;
  for (const key of BOT_KEYS) {
    const state = readJson(BOTS[key].statePath);
    const positions: any[] = state?.positions ?? [];
    // In the current WeatherSimulator schema the ticker lives at
    // position.bracket._kalshiTicker. Fallback to alternate paths in case
    // older state files are around.
    out[key] = new Set(
      positions
        .map(p => p.bracket?._kalshiTicker ?? p.market?.ticker ?? p.ticker)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
    );
  }
  return out;
}

function classifyPosition(
  ticker: string,
  avgEntryPrice: number,
  managed: Record<BotKey, Set<string>>,
): { bot: AttributionClass; orphanHint?: OrphanHint } {
  for (const key of BOT_KEYS) {
    if (managed[key].has(ticker)) return { bot: key };
  }
  if (!ticker.startsWith("KXHIGH")) return { bot: "external" };
  // KXHIGH* orphan — infer which strategy likely placed it from the entry price
  let orphanHint: OrphanHint = "unclear";
  if (avgEntryPrice >= 0.60 && avgEntryPrice <= 0.98) orphanHint = "likely-intrinsic";
  else if (avgEntryPrice >= 0.01 && avgEntryPrice <= 0.55) orphanHint = "likely-ensemble";
  return { bot: "orphan", orphanHint };
}

app.get("/api/positions", async (c) => {
  const k = getKalshi();
  if (!k) return c.json({ configured: false, positions: [] });
  try {
    const data = await cached("positions", 30_000, async () => {
      const posResp = await k.getPositions({ limit: 200 });
      const open = (posResp.market_positions ?? []).filter(p => parseFloat(p.position_fp) !== 0);
      if (open.length === 0) {
        return {
          configured: true,
          positions: [],
          summary: { managed: 0, intrinsic: 0, ensemble: 0, orphan: 0, external: 0, orphanExposureUSD: 0, externalExposureUSD: 0 },
        };
      }

      // Batch-fetch market snapshots for current prices
      const tickers = open.map(p => p.ticker);
      const marketsResp = await k.getMarkets({ tickers: tickers.join(","), limit: 200 } as any);
      const marketByTicker = new Map(marketsResp.markets.map(m => [m.ticker, m]));

      // Build the per-bot managed-ticker sets once (avoids re-reading state files N times)
      const managed = buildManagedTickerSets();

      // Pre-fetch ensemble forecasts for every unique city with a position.
      // One API call per city gives us up to 7 days of members; we match by date.
      const uniqueCities = Array.from(new Set(
        open.map(p => {
          const parsed = parseEventTicker(marketByTicker.get(p.ticker)?.event_ticker ?? null);
          return parsed?.citySeries;
        }).filter((x): x is string => !!x)
      ));
      const ensembleByCity: Record<string, any> = {};
      await Promise.all(uniqueCities.map(async city => {
        try {
          ensembleByCity[city] = await cached(`ensemble:${city}:7d`, 10 * 60_000, () => fetchGFSEnsemble(city, 7));
        } catch {
          ensembleByCity[city] = null;
        }
      }));

      const positions = open.map(p => {
        const posShares = parseFloat(p.position_fp);
        const side: "yes" | "no" = posShares >= 0 ? "yes" : "no";
        const shares = Math.abs(posShares);
        const exposure = Math.abs(parseFloat(p.market_exposure_dollars) || 0);
        const realized = parseFloat(p.realized_pnl_dollars) || 0;
        const fees = parseFloat(p.fees_paid_dollars) || 0;
        const avgEntryPrice = shares > 0 ? exposure / shares : 0;

        const m = marketByTicker.get(p.ticker);
        const markPrice = m
          ? side === "yes"
            ? parseFloat(m.yes_bid_dollars) || 0
            : parseFloat(m.no_bid_dollars) || 0
          : 0;
        const markValue = shares * markPrice;
        const unrealized = markValue - exposure;

        const city = (m?.event_ticker ?? p.ticker).match(/KXHIGH([A-Z]+)/)?.[1] ?? null;
        const bracketText = m?.yes_sub_title ?? "";

        const { bot, orphanHint } = classifyPosition(p.ticker, avgEntryPrice, managed);

        // Forecast enrichment: match this position's date against the ensemble
        // for its city, compute our bracket probability + expected value.
        const parsedTicker = parseEventTicker(m?.event_ticker ?? null);
        const ensemble = parsedTicker ? ensembleByCity[parsedTicker.citySeries] : null;
        const day = ensemble?.days?.find((d: any) => d.date === parsedTicker?.dateIso) ?? null;
        const members: number[] = day?.highF_members ?? [];
        const bracketRange = bracketFromKalshiMarket(m);

        let modelProb: number | null = null;
        let forecastStats: { mean: number; stddev: number; p10: number; median: number; p90: number } | null = null;
        let expectedValueUSD: number | null = null;
        let expectedValuePerShareUSD: number | null = null;

        if (members.length >= 10) {
          const sorted = [...members].sort((a, b) => a - b);
          const mean = members.reduce((a, b) => a + b, 0) / members.length;
          const variance = members.reduce((a, b) => a + (b - mean) ** 2, 0) / members.length;
          forecastStats = {
            mean,
            stddev: Math.sqrt(variance),
            p10: sorted[Math.floor(sorted.length * 0.1)],
            median: sorted[Math.floor(sorted.length * 0.5)],
            p90: sorted[Math.floor(sorted.length * 0.9)],
          };
          if (bracketRange) {
            modelProb = empiricalBracketProbability(members, bracketRange.lowF, bracketRange.highF);
            // Side-adjust: if we're short YES (i.e. holding NO), our payoff probability is 1 - modelProb.
            const winProb = side === "yes" ? modelProb : 1 - modelProb;
            expectedValuePerShareUSD = expectedValuePerShare(winProb, avgEntryPrice);
            expectedValueUSD = +(shares * expectedValuePerShareUSD).toFixed(4);
          }
        }

        return {
          ticker: p.ticker,
          eventTicker: m?.event_ticker ?? null,
          bot,
          orphanHint: orphanHint ?? null,
          city,
          bracketText,
          bracketRange,
          side,
          shares,
          avgEntryPrice,
          markPrice,
          exposureUSD: exposure,
          markValueUSD: markValue,
          realizedPnlUSD: realized,
          unrealizedPnlUSD: unrealized,
          feesPaidUSD: fees,
          closeTime: m?.close_time ?? null,
          hoursToClose: hoursToClose(m?.close_time),
          status: m?.status ?? "unknown",
          restingOrdersCount: p.resting_orders_count ?? 0,
          // Forecast-aware fields (null if we couldn't pull an ensemble for this market)
          modelProb,
          expectedValuePerShareUSD,
          expectedValueUSD,
          forecast: forecastStats,
        };
      });

      const withEV = positions.filter(p => p.expectedValueUSD != null);
      const summary = {
        managed: positions.filter(p => p.bot === "intrinsic" || p.bot === "ensemble").length,
        intrinsic: positions.filter(p => p.bot === "intrinsic").length,
        ensemble: positions.filter(p => p.bot === "ensemble").length,
        orphan: positions.filter(p => p.bot === "orphan").length,
        external: positions.filter(p => p.bot === "external").length,
        orphanExposureUSD: +positions.filter(p => p.bot === "orphan").reduce((s, p) => s + p.exposureUSD, 0).toFixed(2),
        externalExposureUSD: +positions.filter(p => p.bot === "external").reduce((s, p) => s + p.exposureUSD, 0).toFixed(2),
        // Expected P&L across positions with forecast coverage
        totalExpectedValueUSD: +withEV.reduce((s, p) => s + (p.expectedValueUSD ?? 0), 0).toFixed(2),
        positionsWithForecast: withEV.length,
        // Optional: weighted model win-prob (capital-weighted)
        avgModelProb: withEV.length
          ? +(withEV.reduce((s, p) => s + (p.modelProb ?? 0) * p.exposureUSD, 0) /
             Math.max(0.01, withEV.reduce((s, p) => s + p.exposureUSD, 0))).toFixed(4)
          : null,
      };

      return { configured: true, positions, summary };
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ configured: true, error: err?.message ?? String(err), positions: [] }, 500);
  }
});

// ─── Live resting orders (Kalshi, 20s cache) ──────────────────────────

app.get("/api/orders", async (c) => {
  const k = getKalshi();
  if (!k) return c.json({ configured: false, orders: [] });
  try {
    const data = await cached("orders-resting", 20_000, async () => {
      const resting = await k.getOrders({ status: "resting", limit: 100 });
      const orders = (resting.orders ?? []).map(o => ({
        orderId: o.order_id,
        clientOrderId: o.client_order_id,
        ticker: o.ticker,
        side: o.side,
        action: o.action,
        pricePaidUSD: parseFloat(o.yes_price_dollars) || parseFloat(o.no_price_dollars) || 0,
        remaining: parseFloat(o.remaining_count_fp) || 0,
        initial: parseFloat(o.initial_count_fp) || 0,
        createdTime: o.created_time ?? null,
        ageSec: o.created_time ? Math.floor((Date.now() - new Date(o.created_time).getTime()) / 1000) : null,
        bot: inferBotFromClientOrderId(o.client_order_id ?? ""),
      }));
      return { configured: true, orders };
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ configured: true, error: err?.message ?? String(err), orders: [] }, 500);
  }
});

function inferBotFromClientOrderId(coid: string): BotKey | "unknown" {
  const lower = coid.toLowerCase();
  if (lower.includes("intrinsic") || lower.includes("int-")) return "intrinsic";
  if (lower.includes("ensemble") || lower.includes("ens-")) return "ensemble";
  return "unknown";
}

// ─── Forecast vs market panel (10min cache per city+days) ─────────────

app.get("/api/forecast", async (c) => {
  const city = c.req.query("city") ?? "NYC";
  const daysAhead = parseInt(c.req.query("daysAhead") ?? "1");
  try {
    const data = await cached(`forecast:${city}:${daysAhead}`, 10 * 60_000, async () => {
      // Map short code (e.g. "NYC") → full Kalshi city name ("New York City")
      // so the finder's substring match works. GFSEnsemble accepts either form.
      const fullCityName = CITY_CODE_TO_NAME[city.toUpperCase()] ?? city;
      const [ensemble, markets] = await Promise.all([
        fetchGFSEnsemble(city, daysAhead),
        findKalshiWeatherMarkets({ city: fullCityName, daysAhead: Math.max(daysAhead + 1, 3), demo: false }).catch(() => []),
      ]);

      // Match market for the requested city/day — match on full Kalshi city name
      // Strict: exact daysAhead. Fallback: nearest future market (still active).
      const matchCity = (m: any) => m.city?.toLowerCase() === fullCityName.toLowerCase();
      const market = (markets ?? []).find((m: any) => matchCity(m) && daysFromToday(m.date) === daysAhead)
        ?? (markets ?? []).filter(matchCity).sort((a: any, b: any) => a.date.localeCompare(b.date))[0]
        ?? null;

      // Align the ensemble day to the MARKET's date if one was found, so bracket
      // probabilities are computed against the right forecast day.
      const effectiveDate = market?.date;
      let day = null;
      if (effectiveDate && ensemble?.days) {
        day = ensemble.days.find(d => d.date === effectiveDate) ?? ensemble.days[daysAhead] ?? ensemble.days[0];
      } else {
        day = ensemble?.days?.[daysAhead] ?? ensemble?.days?.[0] ?? null;
      }
      const members = day?.highF_members ?? [];
      const ensembleStats = members.length ? summarizeMembers(members) : null;

      const brackets = (market?.brackets ?? []).map((b: any) => {
        const lowF = b.lowF;
        const highF = b.highF;
        const yesAsk = b._yesAsk ?? b.price ?? 0;
        const yesBid = b._yesBid ?? 0;
        const impliedProb = yesAsk > 0 ? yesAsk : 0; // market price ≈ prob for binary
        const modelProb = members.length ? empiricalBracketProbability(members, lowF ?? -Infinity, highF ?? Infinity) : 0;
        const edge = modelProb - impliedProb;
        return {
          label: bracketLabel({ lowF, highF }),
          lowF: lowF ?? null,
          highF: highF ?? null,
          yesBid, yesAsk,
          impliedProb,
          modelProb,
          edge,
          ticker: b.ticker ?? null,
        };
      }).sort((a, b) => (a.lowF ?? -999) - (b.lowF ?? -999));

      // Pick market leader = highest yesAsk (market's call)
      const marketLeader = [...brackets].sort((a, b) => b.impliedProb - a.impliedProb)[0] ?? null;
      // Pick model leader = highest modelProb
      const modelLeader = [...brackets].sort((a, b) => b.modelProb - a.modelProb)[0] ?? null;
      const agree = marketLeader && modelLeader && marketLeader.label === modelLeader.label;
      // Best buying edge = highest (modelProb - impliedProb) where price is affordable
      const bestEdge = [...brackets]
        .filter(b => b.yesAsk > 0 && b.yesAsk < 0.95)
        .sort((a, b) => b.edge - a.edge)[0] ?? null;

      return {
        city,
        daysAhead,
        date: market?.date ?? day?.date ?? null,
        closeTime: market?.endDate ?? null,
        ensemble: ensembleStats,
        memberCount: members.length,
        modelsUsed: ensemble ? "GFS + ECMWF" : null,
        marketEventTicker: market?.eventId ?? null,
        brackets,
        marketLeader,
        modelLeader,
        agreement: agree,
        bestEdge,
        fetchedAt: new Date().toISOString(),
      };
    });
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err?.message ?? String(err) }, 500);
  }
});

function summarizeMembers(members: number[]) {
  const sorted = [...members].sort((a, b) => a - b);
  const mean = members.reduce((a, b) => a + b, 0) / members.length;
  const variance = members.reduce((a, b) => a + (b - mean) ** 2, 0) / members.length;
  const stddev = Math.sqrt(variance);
  return {
    mean,
    stddev,
    min: sorted[0],
    p10: sorted[Math.floor(sorted.length * 0.1)],
    median: sorted[Math.floor(sorted.length * 0.5)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    max: sorted[sorted.length - 1],
  };
}

function daysFromToday(isoDate: string | undefined): number {
  if (!isoDate) return -1;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const d = new Date(isoDate); d.setUTCHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400_000);
}

// ─── Cities list (for the forecast filter) ────────────────────────────

app.get("/api/cities", (c) => c.json({
  cities: CITY_CODES,
  names: CITY_CODE_TO_NAME,
}));

// ─── Trades (with filters) ────────────────────────────────────────────

app.get("/api/trades", (c) => {
  const bot = c.req.query("bot") ?? "all";
  const city = c.req.query("city") ?? "";
  const outcome = c.req.query("outcome") ?? ""; // win|loss|open
  const limit = Math.min(parseInt(c.req.query("limit") ?? "200"), 2000);

  let trades = allTrades();
  if (bot !== "all") trades = trades.filter(t => t.bot === bot);
  if (city) trades = trades.filter(t => t.city.toLowerCase().includes(city.toLowerCase()));
  if (outcome) {
    trades = trades.filter(t => {
      if (outcome === "open") return t.pnl === 0;
      if (outcome === "win") return t.pnl > 0;
      if (outcome === "loss") return t.pnl < 0;
      return true;
    });
  }
  trades = trades.slice(-limit).reverse();
  return c.json({ trades, total: trades.length });
});

// ─── Equity curve ─────────────────────────────────────────────────────
// Returns several series so the UI can toggle what it shows:
//   kalshi       — ground-truth Kalshi balance snapshots logged by this
//                  server every ~10 min while running
//   intrinsicPnl — cumulative realized P&L from the intrinsic bot
//   ensemblePnl  — cumulative realized P&L from the ensemble bot
//   combinedPnl  — both bots summed over time (merged by resolvedAt)
//
// Cumulative P&L is derived from the bot state's `closedPositions[]`, which
// is the POST-AUDIT source of truth. (Earlier versions read the CSV
// directly, but when the simulator's startup audit corrects classifications
// against Kalshi's actual settlement results, it only updates the state file
// — the historical CSV rows keep their original (pre-audit) values. Reading
// state.closedPositions guarantees the chart always reflects corrected P&L.)

function cumulativePnlFromState(statePath: string): Array<{ t: string; value: number }> {
  const s = readJson(statePath);
  const closed: any[] = s?.closedPositions ?? [];
  const sorted = closed
    .map(p => ({ t: p.resolvedAt || p.entryTime || null, pnl: Number(p.pnl) || 0 }))
    .filter(p => p.t != null)
    .sort((a, b) => a.t!.localeCompare(b.t!));
  let acc = 0;
  return sorted.map(r => {
    acc += r.pnl;
    return { t: r.t as string, value: +acc.toFixed(4) };
  });
}

app.get("/api/equity", (c) => {
  const intrinsicPnl = cumulativePnlFromState(BOTS.intrinsic.statePath);
  const ensemblePnl = cumulativePnlFromState(BOTS.ensemble.statePath);

  // Combined: merge both bots by timestamp, carry forward each bot's running total
  const allEvents = [
    ...intrinsicPnl.map(p => ({ t: p.t, bot: "intrinsic" as const, value: p.value })),
    ...ensemblePnl.map(p => ({ t: p.t, bot: "ensemble" as const, value: p.value })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  let iLast = 0, eLast = 0;
  const combinedPnl = allEvents.map(ev => {
    if (ev.bot === "intrinsic") iLast = ev.value;
    else eLast = ev.value;
    return { t: ev.t, value: +(iLast + eLast).toFixed(4) };
  });

  const kalshiSnapshots = equityLogger?.readSeries() ?? [];
  const kalshi = kalshiSnapshots.map(s => ({
    t: s.t,
    cashUSD: s.cashUSD,
    portfolioValueUSD: s.portfolioValueUSD,
  }));

  return c.json({
    kalshi,              // ground-truth
    intrinsicPnl,        // per-bot cumulative realized
    ensemblePnl,
    combinedPnl,         // both bots summed
  });
});

// ─── Health / root summary ────────────────────────────────────────────

app.get("/api/health", (c) => c.json({
  ok: true,
  kalshiConfigured: kalshiAvailable,
  time: new Date().toISOString(),
  rootStateFiles: BOT_KEYS.filter(k => existsSync(BOTS[k].statePath)),
}));

// ─── SSE: notify when any state file changes ──────────────────────────

app.get("/api/stream", (c) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      let alive = true;
      const send = (data: any) => {
        if (!alive) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { alive = false; }
      };
      const mtimes: Record<string, number> = {};
      for (const key of BOT_KEYS) {
        mtimes[key] = existsSync(BOTS[key].statePath) ? statSync(BOTS[key].statePath).mtimeMs : 0;
      }
      send({ type: "hello", t: Date.now() });
      const ticker = setInterval(() => {
        if (!alive) { clearInterval(ticker); return; }
        try {
          for (const key of BOT_KEYS) {
            if (existsSync(BOTS[key].statePath)) {
              const m = statSync(BOTS[key].statePath).mtimeMs;
              if (m !== mtimes[key]) {
                mtimes[key] = m;
                send({ type: "state", bot: key, savedAt: m });
              }
            }
          }
          send({ type: "ping", t: Date.now() });
        } catch {}
      }, 3000);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// ─── Static files (LAST — so /api/* routes match first) ───────────────

app.use("/*", serveStatic({ root: "./src/dashboard/public" }));

// ─── Boot ─────────────────────────────────────────────────────────────

getKalshi(); // warm singleton so kalshiAvailable is accurate

// Ground-truth equity logger — writes a CSV of Kalshi balance snapshots.
// No-ops silently if Kalshi isn't configured.
const equityLogger = createEquityLogger({
  client: kalshiClient,
  csvPath: EQUITY_SNAPSHOTS_CSV,
  intervalMs: EQUITY_SNAPSHOT_INTERVAL_MS,
  log: (msg) => console.log(`  [equity-logger] ${msg}`),
});
equityLogger.start();

console.log(`
  ╔══════════════════════════════════════════════╗
  ║  Satriales Dashboard                         ║
  ║  → http://localhost:${PORT.toString().padEnd(5)}                     ║
  ║  Kalshi: ${kalshiAvailable ? "authenticated ✓                      " : "NOT configured (read-only state)     "} ║
  ╚══════════════════════════════════════════════╝
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
