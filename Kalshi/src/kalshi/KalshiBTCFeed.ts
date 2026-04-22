/**
 * Kalshi BTC Feed — the read-side helpers the snipe bot needs.
 *
 * Wraps the team's KalshiClient with:
 *   - Binance US spot price polling (needed to judge distance-from-strike)
 *   - Live BTC event discovery across KXBTCD + KXBTC
 *   - Strike parsing (KXBTCD-26APR1601-T75000 → 75000, "greater")
 *   - Cache TTLs so the hunter loop can poll aggressively without hammering
 *
 * Faithful port of the Python KalshiFeed class but uses KalshiClient
 * instead of its own HTTP layer. No duplicate auth/signing logic.
 */

import { KalshiClient } from "./KalshiClient";
import type { KalshiEvent, KalshiMarket } from "./types";
import { parseDollars } from "./types";

// Per-series metadata. `asset` drives which Binance spot we compare against;
// `movingStrike` flags products whose strike is set at market open (15M
// series) rather than fixed at event creation — those have inherently tiny
// distance-from-strike and the distance gate must be bypassed on them.
//
// Tape-verified snipe edge (scripts/analyze-any-15m.ts, 24h / 565k trades):
//   KXBTCD/KXBTC  — baseline 89.24% WR / +$0.046/share (prior 159k study)
//   KXBTC15M      — 92.25% WR / +$0.055/share / 1,857 golden-bucket fills
//   KXXRP15M      — 93.35% WR / +$0.039/share /   331 fills
//   KXDOGE15M     — 96.51% WR / +$0.059/share /   229 fills
//   KXETH15M      — 75.30% WR / -$0.130/share  ← trap, excluded from trading
//   KXSOL15M      — 91.24% WR / +$0.009/share  ← marginal, excluded for $20 bank
export interface SeriesMeta {
  asset: string;           // lowercase coin key for getPrice cache, or "weather"
  binanceSymbol: string;   // e.g. "BTCUSDT" (empty string for weather markets)
  movingStrike: boolean;   // true for 15M spot-at-open products
  weather: boolean;        // true for weather temp-bracket markets (no spot feed)
}

export const SERIES_META: Record<string, SeriesMeta> = {
  // ── Crypto series (BTC, XRP, DOGE — tape-verified snipe edge) ───────
  KXBTCD:    { asset: "btc",  binanceSymbol: "BTCUSDT",  movingStrike: false, weather: false },
  KXBTC:     { asset: "btc",  binanceSymbol: "BTCUSDT",  movingStrike: false, weather: false },
  KXBTC15M:  { asset: "btc",  binanceSymbol: "BTCUSDT",  movingStrike: true,  weather: false },
  KXXRP15M:  { asset: "xrp",  binanceSymbol: "XRPUSDT",  movingStrike: true,  weather: false },
  KXDOGE15M: { asset: "doge", binanceSymbol: "DOGEUSDT", movingStrike: true,  weather: false },

  // ── Weather temperature markets (daily high, 18 US cities) ──────────
  // Same time+price gate logic as crypto. Winner side is determined by
  // market consensus (expensive side) rather than spot-vs-strike since
  // there's no live temperature feed.
  // NOTE: Weather snipe edge is UNVERIFIED. Crypto edge was tape-confirmed
  // (89-96% WR); weather markets may or may not have similar inefficiency.
  // Add/remove cities here to control coverage.
  KXHIGHNY:  { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHCHI: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHMIA: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHLAX: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHAUS: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHDEN: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHATL: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHDAL: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHSEA: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHHOU: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHPHX: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHBOS: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHLAS: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHMIN: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHPHI: { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHSF:  { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHSA:  { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
  KXHIGHDC:  { asset: "weather", binanceSymbol: "", movingStrike: false, weather: true },
};

export const BTC_SERIES = Object.keys(SERIES_META) as readonly string[];

export type StrikeType = "greater" | "less" | "between" | "other";

const BINANCE_US = "https://api.binance.us/api/v3";

export class KalshiBTCFeed {
  private client: KalshiClient;
  private timeoutMs: number;

  // Caches
  private lastPrice: Map<string, number> = new Map();
  private eventCache: Map<string, { at: number; ev: KalshiEvent | null }> = new Map();
  private eventCacheTtlMs: number = 3_000;
  private seriesCache: Map<string, { at: number; events: KalshiEvent[] }> = new Map();
  private seriesCacheTtlMs: number = 30_000;

  constructor(client: KalshiClient, timeoutMs: number = 8_000) {
    this.client = client;
    this.timeoutMs = timeoutMs;
  }

  get isDemo(): boolean {
    return this.client.isDemo;
  }

  // ─── Spot feed (Binance US) ───────────────────────────────────────

  /**
   * Fetch live spot for any asset we have a Binance symbol for. Falls back
   * to the last cached price on network error.
   */
  async getPrice(asset: string = "btc"): Promise<number> {
    const symbol = this.assetToBinanceSymbol(asset);
    if (!symbol) return this.lastPrice.get(asset) ?? 0;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const r = await fetch(`${BINANCE_US}/ticker/price?symbol=${symbol}`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (r.ok) {
        const j = (await r.json()) as { price: string };
        const p = parseFloat(j.price);
        if (Number.isFinite(p) && p > 0) {
          this.lastPrice.set(asset, p);
          return p;
        }
      }
    } catch {
      // swallow — fall through to cached value
    }
    return this.lastPrice.get(asset) ?? 0;
  }

  private assetToBinanceSymbol(asset: string): string | null {
    // ETH is supported for backward compat even though we don't currently
    // trade it (negative PnL in golden bucket — see SERIES_META comment).
    if (asset === "eth") return "ETHUSDT";
    for (const meta of Object.values(SERIES_META)) {
      if (meta.asset === asset) return meta.binanceSymbol;
    }
    return null;
  }

  /** Which asset does this series track? null if the series is unknown. */
  getAssetForSeries(seriesTicker: string): string | null {
    return SERIES_META[seriesTicker]?.asset ?? null;
  }

  /** True for 15M spot-at-open products where the distance gate must be skipped. */
  isMovingStrike(seriesTicker: string): boolean {
    return SERIES_META[seriesTicker]?.movingStrike ?? false;
  }

  /** True for weather temperature markets (no spot feed — use market consensus). */
  isWeatherSeries(seriesTicker: string): boolean {
    return SERIES_META[seriesTicker]?.weather ?? false;
  }

  // ─── BTC event discovery ──────────────────────────────────────────

  async getLiveBtcEvents(force: boolean = false): Promise<KalshiEvent[]> {
    const out: KalshiEvent[] = [];
    const now = Date.now();
    // Use `status: "open"` — the /events default sort puts *furthest-out*
    // events first, so without a status filter the first 50-event page of
    // KXBTC15M covers +8h..+20h and misses the currently-trading market
    // entirely. (Verified via scripts/diag-events-filter.ts + pagination
    // probe.) `max_close_ts` is accepted by the API but ignored in the
    // response, so it can't save us. `status=open` returns exactly the
    // events whose markets are live and tradeable — all we need for snipe.
    for (const series of BTC_SERIES) {
      const cached = this.seriesCache.get(series);
      if (!force && cached && now - cached.at < this.seriesCacheTtlMs) {
        out.push(...cached.events);
        continue;
      }
      try {
        const res = await this.client.getEvents({
          series_ticker: series,
          status: "open",
          with_nested_markets: true,
          limit: 50,
        });
        this.seriesCache.set(series, { at: now, events: res.events ?? [] });
        out.push(...(res.events ?? []));
      } catch (err) {
        // leave cached value (possibly stale) — snipe loop will retry
        if (cached) out.push(...cached.events);
      }
    }
    return out;
  }

  async getEvent(eventTicker: string): Promise<KalshiEvent | null> {
    const now = Date.now();
    const cached = this.eventCache.get(eventTicker);
    if (cached && now - cached.at < this.eventCacheTtlMs) {
      return cached.ev;
    }
    try {
      const ev = await this.client.getEvent(eventTicker, true);
      this.eventCache.set(eventTicker, { at: now, ev });
      return ev;
    } catch {
      return cached?.ev ?? null;
    }
  }

  // ─── Strike extraction ─────────────────────────────────────────────

  /**
   * Prefer structured strike fields — ticker-based parsing is unsafe on
   * products like KXBTC15M where the last hyphen-segment is a minute suffix
   * (-15, -30, -45) rather than a strike code. The bot previously saw
   * KXBTC15M-26APR160515-15 and reported strike=$5, which happened to pass
   * the directional check only because spot was wildly different from both
   * the fake ($5) and real ($74,764) strikes. We now only accept ticker
   * parsing when the suffix carries a recognized strike-type prefix.
   *
   *   KXBTCD-26APR1601-T75000     → 75000 (T → greater)
   *   KXBTC-26APR1601-B74750      → 74750 (B → between, single bucket midpoint)
   *   KXBTC15M-26APR160515-15     → floor_strike (74764.65), not 5
   */
  getStrikePrice(market: KalshiMarket): number | null {
    if (market.floor_strike != null && market.cap_strike != null) {
      return (Number(market.floor_strike) + Number(market.cap_strike)) / 2;
    }
    if (market.floor_strike != null) return Number(market.floor_strike);
    if (market.cap_strike != null) return Number(market.cap_strike);

    // Fallback: parse ticker suffix only when it starts with a known
    // strike-type letter (T/B/L). Rejects "15", "30", "45" style suffixes.
    const ticker = market.ticker || "";
    const idx = ticker.lastIndexOf("-");
    if (idx >= 0) {
      const last = ticker.slice(idx + 1);
      const prefix = last[0];
      if (prefix === "T" || prefix === "B" || prefix === "L") {
        const parsed = parseFloat(last.slice(1));
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  getStrikeType(market: KalshiMarket): StrikeType {
    const st = market.strike_type;
    if (st === "greater" || st === "greater_or_equal") return "greater";
    if (st === "less" || st === "less_or_equal") return "less";
    if (st === "between") return "between";

    const ticker = market.ticker || "";
    const idx = ticker.lastIndexOf("-");
    const last = idx >= 0 ? ticker.slice(idx + 1) : "";
    const p = last[0];
    if (p === "T") return "greater";
    if (p === "B") return "between";
    if (p === "L") return "less";
    return "other";
  }

  /**
   * Score + return the "primary" live BTC event — closest strike_date still
   * in the future, with KXBTCD preferred on ties (deeper liquidity).
   */
  pickPrimaryEvent(events: KalshiEvent[]): KalshiEvent | null {
    const now = Date.now() / 1000;
    const scored: Array<{ dt: number; priority: number; ev: KalshiEvent }> = [];
    for (const ev of events) {
      const iso = ev.strike_date;
      if (!iso) continue;
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) continue;
      const dt = t / 1000 - now;
      if (dt < 0) continue;
      const priority = ev.series_ticker === "KXBTCD" ? 0 : 1;
      scored.push({ dt, priority, ev });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => a.dt - b.dt || a.priority - b.priority);
    return scored[0].ev;
  }

  // ─── Resolution ────────────────────────────────────────────────────

  /**
   * 1 → YES won, 0 → NO won, -1 → not yet resolved.
   */
  async checkResult(ticker: string): Promise<-1 | 0 | 1> {
    let m: KalshiMarket | null = null;
    try {
      m = await this.client.getMarket(ticker);
    } catch {
      return -1;
    }
    if (!m) return -1;
    const status = (m.status || "").toLowerCase();
    if (status !== "settled" && status !== "finalized" && status !== "determined") {
      return -1;
    }
    const result = (m.result || "").toLowerCase();
    if (result === "yes") return 1;
    if (result === "no") return 0;
    return -1;
  }
}

export { parseDollars };
