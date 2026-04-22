/**
 * Kalshi BTC Snipe Hunter — TypeScript port of kalshi_snipe_trader.py.
 *
 * Thesis: Kalshi BTC markets (KXBTCD "greater than $X", KXBTC "between
 * $X and $Y") have ~188 strikes per event. In the final minutes before
 * settlement, strikes that are clearly already-won by BTC spot still
 * quote stale asks. Buy the winner while it's still mispriced.
 *
 * Verified by the 159,554-trade tape study (24h sample):
 *   time <60s × price 0.70-0.95 : 89.24% WR, +$0.046/share, 567 fills
 *   Our paper bot in same zone : 92.3% WR  vs  tape baseline 77.9%
 *
 * Sizing: conviction floor + half-Kelly on top (default). Distance-from-
 * strike picks conviction (weak/medium/strong). Kelly uses per-bucket
 * empirical WR smoothed with a Beta(2,2) prior + parent-stage pooling
 * while the bucket has <5 samples.
 *
 * Persistence: bun:sqlite via SnipeDB. Resolved trades replayed on boot.
 */

import { appendFileSync } from "node:fs";
import { KalshiClient } from "./KalshiClient";
import { KalshiBTCFeed, type StrikeType } from "./KalshiBTCFeed";
import type { KalshiEvent, KalshiMarket } from "./types";
import { parseDollars, parseCount } from "./types";
import { SnipeDB, type TradeOutcome } from "../storage/SnipeDB";

// ════════════════════════════════════════════════════════════════════════
// USER-ADJUSTABLE CONSTANTS
// ════════════════════════════════════════════════════════════════════════
// Change these to tune the strategy. They feed into DEFAULT_CONFIG below.
//
// BET_SIZE:       Flat dollar amount for each weak-conviction snipe.
// PRICE_GATE_MIN: Minimum entry price. Below 0.70, the tape shows 49.75%
//                 WR across 26k fills — a confirmed money pit.
// PRICE_GATE_MAX: Maximum entry price. Above 0.85, wins pay too little
//                 ($0.05-0.15) to overcome losses. Break-even WR at 0.85
//                 is ~77%, well within our tape-verified range.

export const BET_SIZE = 1;              // $1 per snipe (flat sizing for weak conviction)
export const PRICE_GATE_MIN = 0.70;     // 70¢ — tape-verified floor
export const PRICE_GATE_MAX = 0.85;     // 85¢ — tighter cap, break-even WR ~77%

// PROFITABILITY GATE
// Break-even WR at a given price = price / 1.00 (binary contract pays $1).
// We only enter if our WR exceeds that by PROFITABILITY_MARGIN.
// Example: at 0.75 entry, break-even is 75%, so we need ≥80% WR to fire.
// Early in a session (< 5 resolved trades) we fall back to ASSUMED_WIN_RATE.
export const ASSUMED_WIN_RATE = 0.789;       // 78.9% — tape baseline
export const PROFITABILITY_MARGIN = 0.05;    // 5% safety cushion above break-even

export type Stage = "prime" | "late" | "wide";
export type Conviction = "weak" | "medium" | "strong";

export interface KalshiSnipeConfig {
  // Distance gates
  distWeak: number;       // $50
  distMedium: number;     // $150
  distStrong: number;     // $300

  // Time gates (seconds to close)
  minTimeToCloseS: number;    // 10
  maxTimeToCloseS: number;    // 600
  primeTimeToCloseS: number;  // 120
  lateTimeToCloseS: number;   // 300

  // Price gates — tape-verified golden bucket is 0.70-0.95. The 0.55-0.70
  // zone showed 49.75% WR (below break-even) across 26k fills. First 14.5h
  // paper session at gateMin=0.55 confirmed: 77% WR but -$10.61 PnL because
  // low-price bets lost more than high-price bets gained.
  gateMax: number;        // 0.95
  gateMin: number;        // 0.70

  // Sizing
  sizeWeakFlat: number;   // $1
  sizeMediumPct: number;  // 0.05
  sizeStrongPct: number;  // 0.15
  sizeCapPct: number;     // 0.25

  // Bankroll/risk
  initialBankroll: number; // $20
  minBankroll: number;     // $0.50
  minBet: number;          // $1
  feeRate: number;         // 0.072

  // Kelly
  useKelly: boolean;       // true
  kellyFraction: number;   // 0.50
  kellyMinSamples: number; // 5
  kellyPriorAlpha: number; // 2.0
  kellyPriorBeta: number;  // 2.0
  kellyMinP: number;       // 0.55
  kellyMaxP: number;       // 0.98

  // Loop cadence
  pollIntervalMs: number;  // 5000

  // Resolution deadline after close (seconds)
  resolutionDeadlineS: number; // 900
}

export const DEFAULT_CONFIG: KalshiSnipeConfig = {
  distWeak: 50,
  distMedium: 150,
  distStrong: 300,
  minTimeToCloseS: 10,
  // Wide stage (5-10 min) was a net drain: 78% WR × avg-win $0.17 can't
  // overcome 22% × avg-loss $1.10.  Tape confirms: the 0.70-0.95 zone with
  // >5 min left has NEGATIVE expected value.  Restrict to prime+late only.
  maxTimeToCloseS: 300,
  primeTimeToCloseS: 120,
  lateTimeToCloseS: 300,
  // Entry prices ≥0.85 need WR >85% to break even; even the tape's 95% WR
  // at ≥0.95 prices shows negative PnL.  Lowering the cap to 0.85 means
  // wins pay $0.18-0.43 each (not $0.05-0.15) and break-even WR drops to
  // ~77%, well within our tape-verified range.
  gateMax: PRICE_GATE_MAX,
  gateMin: PRICE_GATE_MIN,
  sizeWeakFlat: BET_SIZE,
  sizeMediumPct: 0.05,
  sizeStrongPct: 0.15,
  sizeCapPct: 0.25,
  initialBankroll: 20,
  minBankroll: 0.5,
  minBet: 1,
  feeRate: 0.072,
  useKelly: true,
  kellyFraction: 0.5,
  kellyMinSamples: 5,
  kellyPriorAlpha: 2,
  kellyPriorBeta: 2,
  kellyMinP: 0.55,
  kellyMaxP: 0.98,
  pollIntervalMs: 5000,
  resolutionDeadlineS: 900,
};

export interface PendingKalshiTrade {
  windowId: string;
  eventTicker: string;
  marketTicker: string;
  side: "YES" | "NO";
  entryPrice: number;
  fee: number;
  shares: number;
  totalCost: number;           // per-share cost incl. fee
  stage: Stage;
  conviction: Conviction;
  strike: number;
  spotAtEntry: number;
  strikeType: StrikeType;
  closeTs: number;             // seconds since epoch
  kalshiOrderId: string | null;
  orderStatus: string;         // "paper" | "submitted" | "filled" | "rejected"
}

export interface HunterEvent {
  ts: number;                  // ms
  kind: "FIRE" | "WIN" | "LOSS" | "DROPPED" | "INFO" | "SCAN";
  stage?: Stage;
  market?: string;
  ticker?: string;
  side?: "YES" | "NO";
  price?: number;
  size?: number;
  conviction?: Conviction;
  strike?: number;
  spot?: number;
  distance?: number;
  secsToClose?: number;
  sizingMode?: "kelly" | "conviction";
  sizingInfo?: Record<string, number | string | null>;
  orderId?: string | null;
  orderStatus?: string;
  pnl?: number;
  bankroll?: number;
  message?: string;
}

/** Per-scan accumulator — fed by scanEvent/tryFireMarket, summarized into a SCAN event. */
interface ScanAccum {
  eventsSeen: number;
  marketsSeen: number;
  inStage: { prime: number; late: number; wide: number };
  fires: number;
  rejections: {
    time: number;      // secsToClose out of [min,max]
    status: number;    // market status not active/open
    intrinsic: number; // can't classify winner
    dist: number;      // distance < distWeak
    quote: number;     // bid/ask missing
    price: number;     // winnerPrice outside [gateMin, gateMax]
    size: number;      // bid/ask size < 1
    dedup: number;     // already fired
    bankroll: number;      // insufficient funds
    momentum: number;      // price trend falling
    profitability: number; // WR too low for this entry price
  };
  nearMiss: NearMiss | null;
  nextCloseInS: number;   // min secsToClose across all events (so we can say "next close in 4m")
}

interface NearMiss {
  ticker: string;
  side: "YES" | "NO";
  stage: Stage;
  distance: number;
  winnerPrice: number;
  secsToClose: number;
  reason: string;    // e.g. "price>0.95", "size=0"
}

function fmtSecs(s: number): string {
  if (!Number.isFinite(s)) return "–";
  const n = Math.max(0, Math.round(s));
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m${(n % 60).toString().padStart(2, "0")}s`;
  return `${(n / 3600).toFixed(1)}h`;
}

export interface HunterSnapshot {
  bankroll: number;
  peakBankroll: number;
  totalSnipes: number;
  totalWins: number;
  totalPnl: number;
  totalFees: number;
  bustCount: number;
  pending: PendingKalshiTrade[];
  events: HunterEvent[];
  stageStats: Record<Stage, { trades: number; wins: number; pnl: number }>;
  convictionStats: Record<Conviction, { trades: number; wins: number; pnl: number }>;
  bucketStats: Record<string, { trades: number; wins: number; pnl: number }>; // key = "stage/conviction"
  marketStats: Record<string, { trades: number; wins: number; pnl: number }>;
  config: KalshiSnipeConfig;
  mode: "PAPER" | "LIVE";
  startedAtMs: number;
  lastUpdateMs: number;
  spotBtc: number;
  paused: boolean;
  running: boolean;
}

// ─── Fee compute (mirrors signals.compute_fee) ───────────────────────
export function computeFee(price: number, feeRate: number): number {
  return feeRate * price * (1 - price);
}

function emptyStage() {
  return { trades: 0, wins: 0, pnl: 0 };
}

export class KalshiSnipeHunter {
  config: KalshiSnipeConfig;
  readonly feed: KalshiBTCFeed;
  readonly client: KalshiClient;
  readonly db: SnipeDB;
  readonly live: boolean;

  bankroll: number;
  peakBankroll: number;
  totalSnipes: number = 0;
  totalWins: number = 0;
  totalPnl: number = 0;
  totalFees: number = 0;
  bustCount: number = 0;

  pending: PendingKalshiTrade[] = [];
  events: HunterEvent[] = [];
  private eventsCap: number = 400;
  private scanCount: number = 0;

  stageStats: Record<Stage, { trades: number; wins: number; pnl: number }> = {
    prime: emptyStage(), late: emptyStage(), wide: emptyStage(),
  };
  convictionStats: Record<Conviction, { trades: number; wins: number; pnl: number }> = {
    weak: emptyStage(), medium: emptyStage(), strong: emptyStage(),
  };
  bucketStats: Record<string, { trades: number; wins: number; pnl: number }> = {};
  marketStats: Record<string, { trades: number; wins: number; pnl: number }> = {};

  // Dedup: per (event, market, stage); each combo only fires once per life
  private fired: Set<string> = new Set();

  // ── Momentum tracking ──────────────────────────────────────────────
  // Ring buffer of winner-side prices per market ticker, sampled each
  // scan. If price drops ≥2¢ over the last 2 min, reject (trend falling).
  private priceHistory: Map<string, Array<{ ts: number; price: number }>> = new Map();
  private static readonly MOMENTUM_WINDOW_MS = 120_000; // 2 minutes of history
  private static readonly MOMENTUM_MIN_DECLINE = 0.02;  // reject if fell ≥2¢

  // ── JSON logging ───────────────────────────────────────────────────
  // Every market check writes: timestamp, ticker, price, action, reason.
  // Set via constructor opts. Output format: one JSON object per line.
  logPath: string | null = null;

  shouldStop: boolean = false;
  paused: boolean = false;
  drainTimeoutS: number = 900;

  private spotBtc: number = 0;
  private startedAtMs: number = Date.now();
  private lastUpdateMs: number = Date.now();
  private running: boolean = false;

  constructor(opts: {
    config?: Partial<KalshiSnipeConfig>;
    dbPath: string;
    client: KalshiClient;
    live?: boolean;
    logPath?: string;     // path for JSONL market-check log (e.g. "snipe_log.jsonl")
  }) {
    this.config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
    this.client = opts.client;
    this.logPath = opts.logPath ?? null;
    this.feed = new KalshiBTCFeed(this.client);
    this.db = new SnipeDB(opts.dbPath);
    this.live = !!opts.live && this.client.isAuthenticated;

    for (const s of ["prime", "late", "wide"] as const) {
      for (const c of ["weak", "medium", "strong"] as const) {
        this.bucketStats[`${s}/${c}`] = emptyStage();
      }
    }

    this.bankroll = this.config.initialBankroll;
    this.peakBankroll = this.config.initialBankroll;

    try {
      this.loadPersistedState();
    } catch (e) {
      // fresh DB — ignore
    }
  }

  // ─── Persistence replay ────────────────────────────────────────────

  private loadPersistedState(): void {
    const rows = this.db.loadPersistedKalshiTrades();
    if (!rows.length) return;
    for (const r of rows) {
      const pnl = Number(r.pnl ?? 0);
      this.bankroll += pnl;
      this.totalPnl += pnl;
      this.totalSnipes += 1;
      if (pnl > 0) this.totalWins += 1;

      const stage = this.parseStageFromModel(r.model_name);
      const conv = this.parseConvictionFromModel(r.model_name);
      const won = pnl > 0;
      if (stage) {
        const s = this.stageStats[stage];
        s.trades++; if (won) s.wins++; s.pnl += pnl;
      }
      if (conv) {
        const c = this.convictionStats[conv];
        c.trades++; if (won) c.wins++; c.pnl += pnl;
      }
      if (stage && conv) {
        const b = this.bucketStats[`${stage}/${conv}`];
        b.trades++; if (won) b.wins++; b.pnl += pnl;
      }
      this.peakBankroll = Math.max(this.peakBankroll, this.bankroll);
    }
    console.log(
      `Loaded persisted state: bankroll=$${this.bankroll.toFixed(2)}, ` +
      `peak=$${this.peakBankroll.toFixed(2)}, ` +
      `${this.totalWins}W/${this.totalSnipes - this.totalWins}L, ` +
      `pnl=$${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(2)}`,
    );
  }

  private parseStageFromModel(m: string | null | undefined): Stage | null {
    if (!m?.startsWith("kalshi_")) return null;
    const parts = m.split("_");
    const s = parts[1];
    if (s === "prime" || s === "late" || s === "wide") return s;
    return null;
  }

  private parseConvictionFromModel(m: string | null | undefined): Conviction | null {
    if (!m?.startsWith("kalshi_")) return null;
    const parts = m.split("_");
    const c = parts[2];
    if (c === "weak" || c === "medium" || c === "strong") return c;
    return null;
  }

  // ─── Kelly sizing ──────────────────────────────────────────────────

  private bucketProbability(stage: Stage, conviction: Conviction): { p: number; n: number } {
    const cfg = this.config;
    const { kellyPriorAlpha: a0, kellyPriorBeta: b0 } = cfg;
    const bk = this.bucketStats[`${stage}/${conviction}`] ?? emptyStage();
    const n = bk.trades;
    const w = bk.wins;

    if (n < cfg.kellyMinSamples) {
      const parent = this.stageStats[stage] ?? emptyStage();
      const nEff = n + 0.5 * parent.trades;
      const wEff = w + 0.5 * parent.wins;
      const p = (wEff + a0) / (nEff + a0 + b0);
      return { p: Math.min(Math.max(p, 0), cfg.kellyMaxP), n };
    }
    const p = (w + a0) / (n + a0 + b0);
    return { p: Math.min(Math.max(p, 0), cfg.kellyMaxP), n };
  }

  private kellyFraction(p: number, q: number): number {
    if (q <= 0 || q >= 1) return 0;
    if (p <= q) return 0;
    return (p - q) / (1 - q);
  }

  private computeBetSize(
    stage: Stage,
    conviction: Conviction,
    winnerPrice: number,
  ): { size: number; mode: "kelly" | "conviction"; info: Record<string, number | string | null> } {
    const cfg = this.config;
    const convSize =
      conviction === "strong" ? this.bankroll * cfg.sizeStrongPct
        : conviction === "medium" ? this.bankroll * cfg.sizeMediumPct
          : cfg.sizeWeakFlat;
    const cap = this.bankroll * cfg.sizeCapPct;

    if (!cfg.useKelly) {
      const size = Math.max(Math.min(convSize, cap, this.bankroll - 0.01), cfg.minBet);
      return { size, mode: "conviction", info: { p: null, q: winnerPrice } };
    }

    const { p, n } = this.bucketProbability(stage, conviction);
    const q = winnerPrice;
    const kellyF = this.kellyFraction(p, q);
    const info: Record<string, number | string | null> = {
      p: +p.toFixed(4), q: +q.toFixed(4),
      kelly_f: +kellyF.toFixed(4), n,
      fraction: cfg.kellyFraction,
    };

    if (p < cfg.kellyMinP || kellyF <= 0 || n === 0) {
      const size = Math.max(Math.min(convSize, cap, this.bankroll - 0.01), cfg.minBet);
      return { size, mode: "conviction", info };
    }

    const kellyPct = cfg.kellyFraction * kellyF;
    const kellySize = kellyPct * this.bankroll;
    let size = Math.max(kellySize, convSize);
    size = Math.min(size, cap, this.bankroll - 0.01);
    size = Math.max(size, cfg.minBet);
    info.kelly_pct = +kellyPct.toFixed(4);
    info.final_size = +size.toFixed(2);
    return { size, mode: "kelly", info };
  }

  // ─── Momentum detection ─────────────────────────────────────────────
  // Tracks the winner-side price for each market over a 2-minute sliding
  // window. Only enter if the price is rising or stable — not falling.
  // A dropping price suggests the market is repricing AGAINST our side.

  private recordPrice(ticker: string, price: number): void {
    const now = Date.now();
    let history = this.priceHistory.get(ticker);
    if (!history) {
      history = [];
      this.priceHistory.set(ticker, history);
    }
    history.push({ ts: now, price });
    // Prune entries older than the tracking window + 10s buffer
    const cutoff = now - KalshiSnipeHunter.MOMENTUM_WINDOW_MS - 10_000;
    while (history.length > 0 && history[0].ts < cutoff) {
      history.shift();
    }
  }

  /** Returns { ok, delta }. ok=false means price is falling — don't enter. */
  private checkMomentum(ticker: string, currentPrice: number): { ok: boolean; delta: number } {
    const history = this.priceHistory.get(ticker);
    // Insufficient data — allow entry (don't block first-time markets)
    if (!history || history.length < 3) {
      return { ok: true, delta: 0 };
    }
    const windowStart = Date.now() - KalshiSnipeHunter.MOMENTUM_WINDOW_MS;
    const oldest = history.find(s => s.ts >= windowStart);
    if (!oldest) return { ok: true, delta: 0 };
    const delta = currentPrice - oldest.price;
    // Reject if price dropped more than the minimum decline threshold
    return { ok: delta >= -KalshiSnipeHunter.MOMENTUM_MIN_DECLINE, delta };
  }

  // ─── JSON logging ─────────────────────────────────────────────────
  // Writes one JSON line per market check: timestamp, ticker, price,
  // action (buy/pass), and reason for passing. Output: snipe_log.jsonl.

  private logMarketCheck(entry: {
    market: string;
    series: string;
    price: number;
    side: string;
    secsToClose: number;
    action: "buy" | "pass";
    reason?: string;
    stage?: string;
    conviction?: string;
    spot?: number;
    distance?: number;
    momentum?: number;
    breakEvenWR?: number;    // price / 1.00 — minimum WR to not lose money
    liveWR?: number;         // our current session WR (or assumed fallback)
  }): void {
    if (!this.logPath) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      appendFileSync(this.logPath, line);
    } catch { /* non-fatal — don't let logging failures break trading */ }
  }

  // ─── Runtime config update (for GUI slider) ───────────────────────

  /** Update runtime config from the GUI. Only safe-listed keys accepted. */
  updateConfig(patch: Record<string, unknown>): void {
    const cfg = this.config as unknown as Record<string, unknown>;
    const ALLOWED = new Set([
      "maxTimeToCloseS", "primeTimeToCloseS", "lateTimeToCloseS",
      "gateMin", "gateMax", "sizeWeakFlat",
    ]);
    for (const [k, v] of Object.entries(patch)) {
      if (!ALLOWED.has(k)) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      cfg[k] = v;
    }
  }

  // ─── Stage classifier ──────────────────────────────────────────────

  private stageFor(secsToClose: number): Stage | null {
    const cfg = this.config;
    if (secsToClose < cfg.minTimeToCloseS) return null;
    if (secsToClose > cfg.maxTimeToCloseS) return null;
    if (secsToClose <= cfg.primeTimeToCloseS) return "prime";
    if (secsToClose <= cfg.lateTimeToCloseS) return "late";
    return "wide";
  }

  private intrinsic(
    market: KalshiMarket, spot: number,
  ): { intrinsic: 0 | 1 | null; stype: StrikeType; strike: number | null } {
    const stype = this.feed.getStrikeType(market);
    const strike = this.feed.getStrikePrice(market);
    if (strike == null) return { intrinsic: null, stype, strike: null };
    if (stype === "greater") return { intrinsic: spot > strike ? 1 : 0, stype, strike };
    if (stype === "less") return { intrinsic: spot < strike ? 1 : 0, stype, strike };
    if (stype === "between") {
      const f = market.floor_strike;
      const c = market.cap_strike;
      if (f != null && c != null) {
        return { intrinsic: f <= spot && spot <= c ? 1 : 0, stype, strike };
      }
      return { intrinsic: Math.abs(spot - strike) <= 50 ? 1 : 0, stype, strike };
    }
    return { intrinsic: null, stype, strike };
  }

  // ─── Scan + fire ───────────────────────────────────────────────────

  async scanAll(): Promise<void> {
    let events: KalshiEvent[];
    try {
      events = await this.feed.getLiveBtcEvents();
    } catch (err) {
      this.pushEvent({
        ts: Date.now(), kind: "INFO",
        message: `getLiveBtcEvents error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // Collect the unique set of assets referenced by the returned events and
    // fetch their Binance spots in parallel. A single /ticker/price call per
    // asset per scan is cheap and lets us trade BTC/XRP/DOGE markets side by
    // side without picking one "primary" spot.
    const assetsNeeded = new Set<string>();
    for (const ev of events) {
      const a = this.feed.getAssetForSeries(ev.series_ticker);
      if (a) assetsNeeded.add(a);
    }
    const spotEntries = await Promise.all(
      [...assetsNeeded].map(async (a) => [a, await this.feed.getPrice(a)] as const),
    );
    const spotByAsset = new Map<string, number>();
    for (const [a, p] of spotEntries) {
      if (p > 0) spotByAsset.set(a, p);
    }
    // BTC spot drives the GUI header + scan summary even when we're also
    // scanning XRP/DOGE events. Fall back to zero if the BTC Binance feed
    // errored this tick.
    const btcSpot = spotByAsset.get("btc") ?? 0;
    this.spotBtc = btcSpot;

    // If all crypto spot feeds failed and there are no weather events, bail.
    // Weather events don't need spot prices (winner from market consensus).
    const hasWeatherEvents = events.some(ev => this.feed.isWeatherSeries(ev.series_ticker));
    if (spotByAsset.size === 0 && !hasWeatherEvents) {
      this.pushEvent({
        ts: Date.now(), kind: "INFO",
        message: `all spot feeds returned 0 — skipping scan`,
      });
      return;
    }

    const accum: ScanAccum = {
      eventsSeen: events.length,
      marketsSeen: 0,
      inStage: { prime: 0, late: 0, wide: 0 },
      fires: 0,
      rejections: {
        time: 0, status: 0, intrinsic: 0, dist: 0,
        quote: 0, price: 0, size: 0, dedup: 0, bankroll: 0,
        momentum: 0, profitability: 0,
      },
      nearMiss: null,
      nextCloseInS: Infinity,
    };

    const now = Date.now() / 1000;
    for (const ev of events) {
      const asset = this.feed.getAssetForSeries(ev.series_ticker);
      if (!asset) continue; // unknown series — guard against stale cache
      // Weather markets don't need spot prices (winner from market consensus).
      // Crypto markets require a valid spot — skip if Binance failed this tick.
      const isWeatherEvt = this.feed.isWeatherSeries(ev.series_ticker);
      const spot = isWeatherEvt ? 0 : (spotByAsset.get(asset) ?? 0);
      if (!isWeatherEvt && !spot) continue;
      try {
        this.scanEvent(ev, spot, now, accum);
      } catch (err) {
        this.pushEvent({
          ts: Date.now(), kind: "INFO",
          message: `scanEvent(${ev.event_ticker}) ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    this.emitScanSummary(accum, btcSpot);
  }

  private scanEvent(event: KalshiEvent, spot: number, now: number, accum: ScanAccum): void {
    const strikeIso = event.strike_date;
    if (!strikeIso) return;
    const closeTs = Date.parse(strikeIso) / 1000;
    if (!Number.isFinite(closeTs)) return;

    const secsToClose = closeTs - now;
    if (secsToClose > 0 && secsToClose < accum.nextCloseInS) {
      accum.nextCloseInS = secsToClose;
    }

    const stage = this.stageFor(secsToClose);
    if (!stage) {
      // Count markets as "time-rejected" for the summary
      const n = event.markets?.length ?? 0;
      accum.marketsSeen += n;
      accum.rejections.time += n;
      return;
    }

    for (const m of event.markets ?? []) {
      accum.marketsSeen++;
      accum.inStage[stage]++;
      try {
        this.tryFireMarket(event.event_ticker, m, spot, closeTs, stage, secsToClose, accum);
      } catch (err) {
        this.pushEvent({
          ts: Date.now(), kind: "INFO",
          message: `tryFireMarket ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private updateNearMiss(accum: ScanAccum, cand: NearMiss): void {
    if (!accum.nearMiss) { accum.nearMiss = cand; return; }
    // "Closeness to firing" = smallest price-gate violation
    const cfg = this.config;
    const violation = (p: number) =>
      Math.min(Math.abs(p - cfg.gateMax), Math.abs(p - cfg.gateMin));
    if (violation(cand.winnerPrice) < violation(accum.nearMiss.winnerPrice)) {
      accum.nearMiss = cand;
    }
  }

  private emitScanSummary(accum: ScanAccum, spot: number): void {
    this.scanCount += 1;
    const totalInStage =
      accum.inStage.prime + accum.inStage.late + accum.inStage.wide;
    const r = accum.rejections;
    const rejBits: string[] = [];
    if (r.dist)     rejBits.push(`dist:${r.dist}`);
    if (r.price)    rejBits.push(`price:${r.price}`);
    if (r.size)     rejBits.push(`size:${r.size}`);
    if (r.quote)    rejBits.push(`quote:${r.quote}`);
    if (r.status)   rejBits.push(`status:${r.status}`);
    if (r.dedup)    rejBits.push(`dup:${r.dedup}`);
    if (r.intrinsic) rejBits.push(`intr:${r.intrinsic}`);
    if (r.bankroll) rejBits.push(`bank:${r.bankroll}`);
    if (r.momentum) rejBits.push(`mom:${r.momentum}`);
    if (r.profitability) rejBits.push(`profit:${r.profitability}`);

    let msg =
      `#${this.scanCount} · spot $${Math.round(spot).toLocaleString()} · ` +
      `${accum.eventsSeen} evts · ${accum.marketsSeen} mkts · ` +
      `in-stage ${totalInStage}` +
      (totalInStage
        ? ` (P:${accum.inStage.prime} L:${accum.inStage.late} W:${accum.inStage.wide})`
        : "") +
      ` · fires ${accum.fires}`;
    if (rejBits.length) msg += ` · rej ${rejBits.join(" ")}`;

    if (totalInStage === 0 && Number.isFinite(accum.nextCloseInS)) {
      msg += ` · next close in ${fmtSecs(accum.nextCloseInS)}`;
    }

    if (accum.nearMiss) {
      const nm = accum.nearMiss;
      msg +=
        ` · near ${nm.ticker} ${nm.side} @${nm.winnerPrice.toFixed(3)} ` +
        `d=$${Math.round(nm.distance).toLocaleString()} ` +
        `${fmtSecs(nm.secsToClose)} (${nm.reason})`;
    }

    this.pushEvent({ ts: Date.now(), kind: "SCAN", message: msg });
  }

  private tryFireMarket(
    eventTicker: string,
    market: KalshiMarket,
    spot: number,
    closeTs: number,
    stage: Stage,
    secsToClose: number,
    accum: ScanAccum,
  ): void {
    const cfg = this.config;
    const ticker = market.ticker;
    if (!ticker) { accum.rejections.status++; return; }
    const status = (market.status || "").toLowerCase();
    if (status !== "active" && status !== "open") { accum.rejections.status++; return; }
    if (this.bankroll < cfg.minBet) { accum.rejections.bankroll++; return; }

    const dedupKey = `${eventTicker}|${ticker}|${stage}`;
    if (this.fired.has(dedupKey)) { accum.rejections.dedup++; return; }

    // Parse quotes early — needed for both weather (winner detection) and
    // crypto (price gates). Avoids duplicate parsing in the weather path.
    const yesBid = parseDollars(market.yes_bid_dollars);
    const yesAsk = parseDollars(market.yes_ask_dollars);
    if (yesAsk <= 0 || yesBid <= 0) { accum.rejections.quote++; return; }

    const series = eventTicker.split("-", 1)[0];
    const isWeather = this.feed.isWeatherSeries(series);
    const movingStrike = this.feed.isMovingStrike(series);

    // ── Determine winner side ──
    // Crypto: use spot vs strike (intrinsic value from Binance feed).
    // Weather: no spot feed — use market consensus (expensive side wins).
    let side: "YES" | "NO";
    let stype: StrikeType;
    let strike: number | null;
    let distance: number;

    if (isWeather) {
      // Weather markets: the market price itself is the signal.
      // If YES mid > 0.50, the market thinks YES will win — buy YES.
      const yesMid = (yesBid + yesAsk) / 2;
      side = yesMid >= 0.50 ? "YES" : "NO";
      stype = this.feed.getStrikeType(market);
      strike = this.feed.getStrikePrice(market);
      distance = 0; // no meaningful distance metric for weather
    } else {
      // Crypto: determine winner from spot vs strike
      const result = this.intrinsic(market, spot);
      if (result.intrinsic == null || result.strike == null) {
        accum.rejections.intrinsic++;
        return;
      }
      side = result.intrinsic === 1 ? "YES" : "NO";
      stype = result.stype;
      strike = result.strike;
      distance = Math.abs(spot - result.strike);
      // 15M products: strike = spot-at-open, distance inherently tiny.
      // For KXBTCD/KXBTC (fixed strikes), keep the $50 weak cutoff.
      if (!movingStrike && distance < cfg.distWeak) {
        accum.rejections.dist++;
        return;
      }
    }

    const winnerPrice = side === "YES" ? yesAsk : 1 - yesBid;
    if (winnerPrice <= 0) { accum.rejections.quote++; return; }

    // Compute break-even WR for logging — every check gets this field.
    // breakEvenWR = price / 1.00 (binary pays $1). liveWR falls back to
    // ASSUMED_WIN_RATE until ≥5 trades resolve.
    const breakEvenWR = winnerPrice;
    const _resolvedCt = this.totalSnipes - this.pending.length;
    const liveWR = _resolvedCt >= 5 ? this.totalWins / _resolvedCt : ASSUMED_WIN_RATE;

    // Record price for momentum tracking — even if this market gets
    // rejected by price gates, we want history for the next scan.
    this.recordPrice(ticker, winnerPrice);
    if (winnerPrice > cfg.gateMax) {
      accum.rejections.price++;
      this.updateNearMiss(accum, {
        ticker, side, stage, distance, winnerPrice, secsToClose,
        reason: `price>${cfg.gateMax.toFixed(2)}`,
      });
      this.logMarketCheck({
        market: ticker, series, price: winnerPrice, side, secsToClose,
        action: "pass", reason: `price>${cfg.gateMax.toFixed(2)}`,
        stage, spot, distance, breakEvenWR, liveWR,
      });
      return;
    }
    if (winnerPrice < cfg.gateMin) {
      accum.rejections.price++;
      this.updateNearMiss(accum, {
        ticker, side, stage, distance, winnerPrice, secsToClose,
        reason: `price<${cfg.gateMin.toFixed(2)}`,
      });
      this.logMarketCheck({
        market: ticker, series, price: winnerPrice, side, secsToClose,
        action: "pass", reason: `price<${cfg.gateMin.toFixed(2)}`,
        stage, spot, distance, breakEvenWR, liveWR,
      });
      return;
    }

    const bidSize = parseCount(market.yes_bid_size_fp);
    const askSize = parseCount(market.yes_ask_size_fp);
    if (side === "YES" && askSize < 1) {
      accum.rejections.size++;
      this.updateNearMiss(accum, {
        ticker, side, stage, distance, winnerPrice, secsToClose, reason: "size=0",
      });
      this.logMarketCheck({
        market: ticker, series, price: winnerPrice, side, secsToClose,
        action: "pass", reason: "size=0", stage, spot, distance, breakEvenWR, liveWR,
      });
      return;
    }
    if (side === "NO" && bidSize < 1) {
      accum.rejections.size++;
      this.updateNearMiss(accum, {
        ticker, side, stage, distance, winnerPrice, secsToClose, reason: "size=0",
      });
      this.logMarketCheck({
        market: ticker, series, price: winnerPrice, side, secsToClose,
        action: "pass", reason: "size=0", stage, spot, distance, breakEvenWR, liveWR,
      });
      return;
    }

    // ── Momentum check ──
    // Reject if the winner-side price has been falling over the last 2 min.
    // A dropping price suggests the market is repricing AGAINST our side.
    const momentum = this.checkMomentum(ticker, winnerPrice);
    if (!momentum.ok) {
      accum.rejections.momentum++;
      this.logMarketCheck({
        market: ticker, series, price: winnerPrice, side, secsToClose,
        action: "pass", reason: `momentum_falling (delta=${momentum.delta.toFixed(3)})`,
        stage, spot, distance, momentum: momentum.delta, breakEvenWR, liveWR,
      });
      return;
    }

    // ── Profitability filter ──
    // Break-even WR = price / 1.00 (binary pays $1 on win).
    // Only enter if our historical WR exceeds break-even by the safety margin.
    // Uses live session WR once we have ≥5 resolved trades; otherwise falls
    // back to ASSUMED_WIN_RATE (tape baseline). This self-calibrates: as the
    // session proves a higher WR, more price levels become accessible.
    if (liveWR < breakEvenWR + PROFITABILITY_MARGIN) {
      accum.rejections.profitability++;
      this.logMarketCheck({
        market: ticker, series, price: winnerPrice, side, secsToClose,
        action: "pass",
        reason: `unprofitable (breakeven=${(breakEvenWR * 100).toFixed(1)}% + ${(PROFITABILITY_MARGIN * 100).toFixed(0)}% margin > WR=${(liveWR * 100).toFixed(1)}%)`,
        stage, spot, distance, momentum: momentum.delta,
        breakEvenWR, liveWR,
      });
      return;
    }

    const conviction: Conviction =
      distance >= cfg.distStrong ? "strong"
        : distance >= cfg.distMedium ? "medium"
          : "weak";

    const sizing = this.computeBetSize(stage, conviction, winnerPrice);
    if (sizing.size < cfg.minBet) { accum.rejections.bankroll++; return; }

    const feePer = computeFee(winnerPrice, cfg.feeRate);
    const costPer = winnerPrice + feePer;
    let shares = sizing.size / costPer;
    let costDollars = shares * costPer;
    if (costDollars > this.bankroll) { accum.rejections.bankroll++; return; }

    accum.fires += 1;

    // Live order path
    let orderId: string | null = null;
    let orderStatus = "paper";
    if (this.live) {
      // Fire-and-forget live order placement is too risky from inside the
      // sync scan tick. Bail — live path needs an async fire in a future
      // iteration. Keep paper behavior exactly matching the Python.
      // (Python version runs live synchronously in the scan loop; we'll
      // implement live later, isolated, once tape auth is paper-proven.)
      orderStatus = "paper";
    }

    // Commit
    this.bankroll -= costDollars;
    this.totalFees += feePer * shares;
    this.totalSnipes += 1;

    const marketKey = `kalshi-btc-${eventTicker}`;
    if (!this.marketStats[marketKey]) this.marketStats[marketKey] = emptyStage();

    const windowId =
      `kalshi-snipe-${eventTicker}-${ticker}-${stage}-${Date.now()}`;
    const modelName = `kalshi_${stage}_${conviction}`;

    const pending: PendingKalshiTrade = {
      windowId, eventTicker, marketTicker: ticker, side,
      entryPrice: winnerPrice,
      fee: feePer * shares,
      shares,
      totalCost: costPer,
      stage, conviction,
      strike: strike ?? 0, spotAtEntry: spot, strikeType: stype,
      closeTs,
      kalshiOrderId: orderId,
      orderStatus,
    };
    this.pending.push(pending);
    this.fired.add(dedupKey);

    const sizingTag =
      sizing.mode === "kelly"
        ? `kelly p=${Number(sizing.info.p).toFixed(2)} q=${Number(sizing.info.q).toFixed(2)} f=${Number(sizing.info.kelly_f ?? 0).toFixed(2)} n=${sizing.info.n}`
        : `conviction ${conviction}`;
    const modeTag = orderStatus === "paper" ? "PAPER" : "LIVE";
    console.log(
      `  [${stage.toUpperCase()} ${eventTicker} ${ticker}] ${modeTag} BOUGHT ${side} ` +
      `@ ${winnerPrice.toFixed(3)} | $${costDollars.toFixed(2)} ` +
      `(strike=$${(strike ?? 0).toLocaleString()}, spot=$${spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}, ` +
      `dist=$${distance.toLocaleString(undefined, { maximumFractionDigits: 0 })}) ` +
      `(${sizingTag}, close in ${secsToClose.toFixed(0)}s) | ` +
      `bank(committed)=$${this.bankroll.toFixed(2)}`,
    );

    this.pushEvent({
      ts: Date.now(), kind: "FIRE", stage, market: marketKey, ticker, side,
      price: winnerPrice, size: costDollars, conviction,
      strike: strike ?? undefined, spot, distance, secsToClose,
      sizingMode: sizing.mode, sizingInfo: sizing.info,
      orderId, orderStatus, pnl: 0, bankroll: this.bankroll,
    });

    // Log the entry to JSONL file
    this.logMarketCheck({
      market: ticker, series, price: winnerPrice, side, secsToClose,
      action: "buy", stage, conviction, spot, distance,
      momentum: momentum.delta, breakEvenWR, liveWR,
    });

    this.db.saveTrade({
      windowId, side, modelName,
      modelProb: 1, marketProb: winnerPrice, confidence: winnerPrice,
      entryPrice: winnerPrice, fee: feePer * shares, shares,
      bankroll: this.bankroll,
    });
  }

  // ─── Resolution ────────────────────────────────────────────────────

  async resolvePending(): Promise<void> {
    if (!this.pending.length) return;
    const now = Date.now() / 1000;
    const remaining: PendingKalshiTrade[] = [];
    for (const p of this.pending) {
      if (now < p.closeTs - 2) {
        remaining.push(p);
        continue;
      }
      const outcome = await this.feed.checkResult(p.marketTicker);
      if (outcome === -1) {
        if (now > p.closeTs + this.config.resolutionDeadlineS) {
          const loss = -p.shares * p.totalCost;
          this.totalPnl += loss;
          console.warn(
            `  DROPPED ${p.marketTicker} — no resolution in ${this.config.resolutionDeadlineS}s`,
          );
          this.db.resolveTrade(p.windowId, -1, loss, this.bankroll);
          this.db.logEvent(`DROPPED: ${p.windowId}`);
          this.pushEvent({
            ts: Date.now(), kind: "DROPPED", ticker: p.marketTicker,
            side: p.side, price: p.entryPrice, pnl: loss, bankroll: this.bankroll,
            message: `no-resolution drop after ${this.config.resolutionDeadlineS}s`,
          });
          continue;
        }
        remaining.push(p);
        continue;
      }
      this.settleTrade(p, outcome);
    }
    this.pending = remaining;
  }

  private settleTrade(p: PendingKalshiTrade, outcome: 0 | 1): void {
    const won =
      (p.side === "YES" && outcome === 1) ||
      (p.side === "NO" && outcome === 0);
    const payout = won ? p.shares * 1 : 0;
    const committedCost = p.shares * p.totalCost;
    const pnl = payout - committedCost;

    this.bankroll += payout;
    this.peakBankroll = Math.max(this.peakBankroll, this.bankroll);
    this.totalPnl += pnl;
    if (won) this.totalWins++;

    const s = this.stageStats[p.stage]; s.trades++; if (won) s.wins++; s.pnl += pnl;
    const c = this.convictionStats[p.conviction]; c.trades++; if (won) c.wins++; c.pnl += pnl;
    const b = this.bucketStats[`${p.stage}/${p.conviction}`]; b.trades++; if (won) b.wins++; b.pnl += pnl;
    const mk = `kalshi-btc-${p.eventTicker}`;
    if (!this.marketStats[mk]) this.marketStats[mk] = emptyStage();
    const m = this.marketStats[mk]; m.trades++; if (won) m.wins++; m.pnl += pnl;

    const wr = this.totalSnipes ? (this.totalWins / this.totalSnipes) * 100 : 0;
    const tag = won ? "WIN " : "LOSS";
    console.log(
      `  [${p.stage.toUpperCase()} ${p.marketTicker}] ${tag} ${p.side} @ ` +
      `${p.entryPrice.toFixed(3)} | PnL $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} | ` +
      `Bank $${this.bankroll.toFixed(2)} | ` +
      `WR ${wr.toFixed(1)}% [${this.totalWins}W/${this.totalSnipes - this.totalWins}L]`,
    );

    this.pushEvent({
      ts: Date.now(), kind: won ? "WIN" : "LOSS", stage: p.stage,
      market: mk, ticker: p.marketTicker, side: p.side,
      price: p.entryPrice, size: p.shares * p.totalCost,
      conviction: p.conviction, strike: p.strike, spot: p.spotAtEntry,
      pnl, bankroll: this.bankroll,
    });

    this.db.resolveTrade(p.windowId, outcome, pnl, this.bankroll);
  }

  // ─── Event ring ────────────────────────────────────────────────────

  private pushEvent(ev: HunterEvent): void {
    this.events.push(ev);
    if (this.events.length > this.eventsCap) {
      this.events.splice(0, this.events.length - this.eventsCap);
    }
  }

  // ─── Snapshot (for GUI) ────────────────────────────────────────────

  getSnapshot(): HunterSnapshot {
    return {
      bankroll: this.bankroll,
      peakBankroll: this.peakBankroll,
      totalSnipes: this.totalSnipes,
      totalWins: this.totalWins,
      totalPnl: this.totalPnl,
      totalFees: this.totalFees,
      bustCount: this.bustCount,
      pending: [...this.pending],
      events: [...this.events],
      stageStats: { ...this.stageStats },
      convictionStats: { ...this.convictionStats },
      bucketStats: { ...this.bucketStats },
      marketStats: { ...this.marketStats },
      config: this.config,
      mode: this.live ? "LIVE" : "PAPER",
      startedAtMs: this.startedAtMs,
      lastUpdateMs: this.lastUpdateMs,
      spotBtc: this.spotBtc,
      paused: this.paused,
      running: this.running,
    };
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  stop(): void { this.shouldStop = true; }

  // ─── Main loop ─────────────────────────────────────────────────────

  async run(maxHours?: number): Promise<void> {
    const cfg = this.config;

    const btc = await this.feed.getPrice("btc");
    this.spotBtc = btc;
    this.db.beginSession(
      this.bankroll,
      JSON.stringify({
        mode: "kalshi_snipe_v1_ts",
        live: this.live,
        demo: this.feed.isDemo,
        btc_start: btc,
      }),
    );
    this.db.logEvent(
      `Kalshi snipe trader (TS) started: live=${this.live}, demo=${this.feed.isDemo}, ` +
      `bankroll=$${this.bankroll.toFixed(2)}`,
    );

    this.startedAtMs = Date.now();
    this.running = true;
    const startTimeMs = Date.now();
    let lastSummaryMs = startTimeMs;

    console.log("");
    console.log("=".repeat(70));
    console.log("  SATRIALES KALSHI BTC SNIPE TRADER (TypeScript)");
    console.log(
      `  Mode: ${this.live ? "LIVE" : "PAPER"}` +
      `${this.feed.isDemo ? " (demo)" : " (production market data)"}`,
    );
    console.log("=".repeat(70));
    console.log(`  Bankroll:       $${this.bankroll.toFixed(2)}`);
    console.log(`  BTC spot:       $${btc.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(
      `  Stage windows:  prime<=${cfg.primeTimeToCloseS}s, late<=${cfg.lateTimeToCloseS}s, ` +
      `wide<=${cfg.maxTimeToCloseS}s`,
    );
    console.log(
      `  Distance gates: weak>=$${cfg.distWeak}, medium>=$${cfg.distMedium}, ` +
      `strong>=$${cfg.distStrong}`,
    );
    console.log(
      `  Price gates:    ${cfg.gateMin.toFixed(2)}..${cfg.gateMax.toFixed(2)}`,
    );
    console.log(
      `  Kelly:          ${cfg.useKelly ? "ON" : "OFF"} ` +
      `(fraction=${cfg.kellyFraction}, min_p=${cfg.kellyMinP.toFixed(2)})`,
    );
    console.log(`  Max hours:      ${maxHours ?? "unlimited"}`);
    console.log("=".repeat(70));

    try {
      while (!this.shouldStop) {
        if (maxHours && (Date.now() - startTimeMs) / 3_600_000 > maxHours) {
          console.log(`Time limit reached (${maxHours}h)`);
          break;
        }
        if (this.bankroll < cfg.minBankroll && !this.pending.length) {
          this.bustCount++;
          console.warn(`BUST #${this.bustCount}! Bank: $${this.bankroll.toFixed(2)}`);
          this.db.logEvent(`BUST #${this.bustCount}`);
          this.bankroll = cfg.initialBankroll;
          this.peakBankroll = cfg.initialBankroll;
        }

        if (!this.paused) await this.scanAll();
        await this.resolvePending();

        // GC stale fired keys: drop anything for events we no longer see and
        // have no pending trade on.
        try {
          const liveEvents = new Set(
            (await this.feed.getLiveBtcEvents()).map((e) => e.event_ticker),
          );
          const pendingEvents = new Set(this.pending.map((p) => p.eventTicker));
          const keep = new Set<string>();
          for (const k of this.fired) {
            const evt = k.split("|")[0];
            if (liveEvents.has(evt) || pendingEvents.has(evt)) keep.add(k);
          }
          this.fired = keep;
        } catch { /* non-fatal */ }

        const dd = this.peakBankroll > 0
          ? (this.peakBankroll - this.bankroll) / this.peakBankroll : 0;
        this.db.updateSessionStats({
          tradesExecuted: this.totalSnipes, tradesWon: this.totalWins,
          totalPnl: this.totalPnl, totalFees: this.totalFees,
          bankroll: this.bankroll, peakBankroll: this.peakBankroll,
          drawdownPct: dd,
        });
        this.lastUpdateMs = Date.now();

        if (Date.now() - lastSummaryMs > 300_000) {
          this.printSummary(startTimeMs);
          lastSummaryMs = Date.now();
        }

        await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
      }
    } finally {
      const drainDeadline = Date.now() + this.drainTimeoutS * 1000;
      console.log(
        `\nDraining ${this.pending.length} pending snipes (up to ${this.drainTimeoutS}s)...`,
      );
      while (this.pending.length && Date.now() < drainDeadline && !this.shouldStop) {
        await this.resolvePending();
        await new Promise((r) => setTimeout(r, 3000));
      }
      this.printSummary(startTimeMs);
      this.running = false;
    }
  }

  private printSummary(startTimeMs: number): void {
    const elapsedH = (Date.now() - startTimeMs) / 3_600_000;
    const pendingCt = this.pending.length;
    const resolved = this.totalSnipes - pendingCt;
    const losses = Math.max(0, resolved - this.totalWins);
    const wr = resolved ? (this.totalWins / resolved) * 100 : 0;
    const roi = this.config.initialBankroll
      ? ((this.bankroll - this.config.initialBankroll) / this.config.initialBankroll) * 100
      : 0;

    console.log("");
    console.log("=".repeat(70));
    console.log(`  SUMMARY - ${elapsedH.toFixed(2)}h elapsed`);
    console.log(
      `  Bankroll:      $${this.bankroll.toFixed(2)} ` +
      `(peak $${this.peakBankroll.toFixed(2)}, ROI ${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%)`,
    );
    console.log(
      `  Snipes placed: ${this.totalSnipes}  (resolved ${resolved}, pending ${pendingCt})`,
    );
    const wrNote = !resolved ? "  [N/A - nothing settled yet]" : "";
    console.log(
      `  Resolved W/L:  ${this.totalWins}/${losses}  WR: ${wr.toFixed(1)}%${wrNote}`,
    );
    console.log(
      `  PnL:           $${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(2)}  ` +
      `(fees $${this.totalFees.toFixed(2)})`,
    );
    for (const s of ["prime", "late", "wide"] as const) {
      const st = this.stageStats[s];
      if (st.trades) {
        const wRate = (st.wins / st.trades) * 100;
        console.log(
          `    ${s.padEnd(6)}  ${st.trades.toString().padStart(3)} trades  ` +
          `${wRate.toFixed(1).padStart(5)}% WR  ` +
          `$${st.pnl >= 0 ? "+" : ""}${st.pnl.toFixed(2)} PnL`,
        );
      }
    }
    console.log("=".repeat(70));
  }
}
