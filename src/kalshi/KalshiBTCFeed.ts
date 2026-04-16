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

export const BTC_SERIES = ["KXBTCD", "KXBTC"] as const;

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

  // ─── BTC spot (Binance US) ────────────────────────────────────────

  async getPrice(asset: "btc" | "eth" = "btc"): Promise<number> {
    const symbol = asset === "btc" ? "BTCUSDT" : "ETHUSDT";
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

  // ─── BTC event discovery ──────────────────────────────────────────

  async getLiveBtcEvents(force: boolean = false): Promise<KalshiEvent[]> {
    const out: KalshiEvent[] = [];
    const now = Date.now();
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
   * KXBTCD-26APR1601-T75000    → 75000 (greater than)
   * KXBTCD-26APR1601-T74999.99 → 74999.99
   * KXBTC-26APR1601-B74750     → 74750 (between bucket)
   */
  getStrikePrice(market: KalshiMarket): number | null {
    const ticker = market.ticker || "";
    const idx = ticker.lastIndexOf("-");
    if (idx >= 0) {
      const last = ticker.slice(idx + 1);
      const num = last.slice(1); // skip prefix letter
      const parsed = parseFloat(num);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (market.floor_strike != null && market.cap_strike != null) {
      return (Number(market.floor_strike) + Number(market.cap_strike)) / 2;
    }
    if (market.floor_strike != null) return Number(market.floor_strike);
    if (market.cap_strike != null) return Number(market.cap_strike);
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
