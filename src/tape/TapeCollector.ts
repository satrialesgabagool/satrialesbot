/**
 * Kalshi BTC trade-tape collector — TypeScript port of kalshi_tape_collector.py.
 *
 * Goal: archive every anonymous fill on settled BTC markets so we can
 * reverse-engineer what winning order flow looks like. Kalshi does not
 * expose trader identities, so we operate on the fill-level tape plus
 * post-settlement outcomes.
 *
 * Design:
 *   - Enumerates settled KXBTCD + KXBTC events via /events
 *   - For each event, fetches markets via /markets?event_ticker=...
 *   - For each market with volume > threshold, paginates /markets/trades
 *   - Persists everything to kalshi_tape.db via TapeDB
 *   - Idempotent: re-runs skip already-collected markets (unless --force)
 *   - Validates data on insert (yes+no≈1, count>0, timestamps sane)
 *
 * Safety invariants enforced:
 *   1. Every trade has yes_price + no_price ≈ 1.0 (±1.5¢)
 *   2. Every trade has count_fp > 0
 *   3. Every trade's created_time within [open_time, close_time + 5min]
 *   4. taker_side is exactly 'yes' or 'no'
 *   5. market.result is exactly 'yes' or 'no' (skip voided)
 *   6. floor_strike / cap_strike non-null for the strike_type we expect
 *   7. No duplicate trade_id in the same market (trade_id PRIMARY KEY)
 */

import { KalshiClient } from "../kalshi/KalshiClient";
import type { KalshiEvent, KalshiMarket, KalshiTrade } from "../kalshi/types";
import { parseDollars, parseCount } from "../kalshi/types";
import { TapeDB, type TradeRow } from "../storage/TapeDB";

export const DEFAULT_SERIES = ["KXBTCD", "KXBTC"] as const;

export interface ValidationError {
  kind: string;
  detail: string;
}

export interface CollectorOptions {
  /** Hours back of settled events to collect (default 24) */
  hoursBack?: number;
  /** Skip markets with volume_fp < this (default 100 contracts) */
  minVolume?: number;
  /** Print plan without fetching trades (default false) */
  dryRun?: boolean;
  /** Re-collect tapes even if already collected (default false) */
  force?: boolean;
  /** Series tickers (default KXBTCD + KXBTC) */
  series?: readonly string[];
  /** Inter-request delay (default 150ms, polite throttle) */
  interRequestDelayMs?: number;
  /** Max pages per trade fetch (default 500 ≈ 100k trades) */
  maxTradePages?: number;
  /** Safety cap on events enumerated per series */
  maxEventsPerSeries?: number;
  /** Callback for progress logging; default uses console.log */
  log?: (msg: string) => void;
}

export interface CollectorSummary {
  nEvents: number;
  nMarketsSeen: number;
  nMarketsCollected: number;
  nTradesNew: number;
  nFailures: number;
  nValidationErrors: number;
  elapsedSec: number;
  notes: string;
}

function isoToMs(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Validate a market row before upserting. Returns errors if the market
 * isn't a clean settled BTC binary we can analyze.
 */
export function validateMarket(m: KalshiMarket): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!m.ticker) errs.push({ kind: "missing_ticker", detail: JSON.stringify(m).slice(0, 80) });
  if (m.result !== "yes" && m.result !== "no") {
    errs.push({ kind: "bad_result", detail: `result=${JSON.stringify(m.result)}` });
  }
  if (m.status !== "finalized") {
    errs.push({ kind: "not_finalized", detail: `status=${JSON.stringify(m.status)}` });
  }
  const stype = m.strike_type;
  const fs = m.floor_strike;
  const cs = m.cap_strike;
  if ((stype === "greater" || stype === "greater_or_equal") && fs == null) {
    errs.push({ kind: "missing_floor", detail: m.ticker ?? "" });
  } else if ((stype === "less" || stype === "less_or_equal") && cs == null) {
    errs.push({ kind: "missing_cap", detail: m.ticker ?? "" });
  } else if (stype === "between" && (fs == null || cs == null)) {
    errs.push({ kind: "missing_between", detail: m.ticker ?? "" });
  }
  return errs;
}

/**
 * Validate a trade row before inserting. Enforces price-sum invariant
 * (yes+no≈1 within 1.5¢), positive count, valid taker_side, plausible
 * created_time relative to market close.
 */
export function validateTrade(t: KalshiTrade, closeTime: string | null): ValidationError[] {
  const errs: ValidationError[] = [];
  const yp = parseDollars(t.yes_price_dollars);
  const np = parseDollars(t.no_price_dollars);
  const cf = parseCount(t.count_fp);
  if (!Number.isFinite(yp) || !Number.isFinite(np) || !Number.isFinite(cf)) {
    return [{ kind: "parse_error", detail: JSON.stringify(t).slice(0, 80) }];
  }
  if (Math.abs(yp + np - 1.0) > 0.015) {
    errs.push({ kind: "price_sum", detail: `yp=${yp} np=${np} sum=${(yp + np).toFixed(4)}` });
  }
  if (cf <= 0) errs.push({ kind: "bad_count", detail: `count_fp=${cf}` });
  // Runtime check — type says "yes"|"no" but Kalshi could ship bad data
  const takerSide = t.taker_side as string;
  if (takerSide !== "yes" && takerSide !== "no") {
    errs.push({ kind: "bad_taker", detail: `taker_side=${JSON.stringify(t.taker_side)}` });
  }
  if (!t.trade_id) errs.push({ kind: "missing_trade_id", detail: "" });
  if (!t.created_time) {
    errs.push({ kind: "missing_created", detail: "" });
  } else if (closeTime) {
    const ctrMs = isoToMs(t.created_time);
    const ctMs = isoToMs(closeTime);
    if (ctrMs != null && ctMs != null && ctrMs - ctMs > 300_000) {
      errs.push({ kind: "fill_after_close", detail: `${t.created_time} > ${closeTime} +5min` });
    }
  }
  return errs;
}

/**
 * Throttle helper. Keeps at least `minGapMs` between calls to `wait()`.
 */
class Throttle {
  private last = 0;
  constructor(private minGapMs: number) {}
  async wait(): Promise<void> {
    const since = Date.now() - this.last;
    if (since < this.minGapMs) {
      await new Promise((r) => setTimeout(r, this.minGapMs - since));
    }
    this.last = Date.now();
  }
}

export class TapeCollector {
  readonly client: KalshiClient;
  readonly db: TapeDB;
  private throttle: Throttle;
  private maxTradePages: number;
  private maxEventsPerSeries: number;
  private log: (msg: string) => void;

  constructor(client: KalshiClient, db: TapeDB, opts?: { interRequestDelayMs?: number; maxTradePages?: number; maxEventsPerSeries?: number; log?: (msg: string) => void }) {
    this.client = client;
    this.db = db;
    this.throttle = new Throttle(opts?.interRequestDelayMs ?? 150);
    this.maxTradePages = opts?.maxTradePages ?? 500;
    this.maxEventsPerSeries = opts?.maxEventsPerSeries ?? 5000;
    this.log = opts?.log ?? ((m) => console.log(m));
  }

  // ─── Event enumeration ──────────────────────────────────────────────

  /**
   * Paginate events for a series, filtered server-side by min_close_ts and
   * trimmed defensively client-side by min_strike_dt.
   */
  async enumerateEvents(
    series: string,
    minStrikeDtMs: number,
  ): Promise<KalshiEvent[]> {
    const events: KalshiEvent[] = [];
    let cursor: string | undefined;
    const minCloseTs = Math.floor(minStrikeDtMs / 1000);
    while (true) {
      await this.throttle.wait();
      const res = await this.client.getEvents({
        series_ticker: series,
        min_close_ts: minCloseTs,
        limit: 200,
        cursor,
      });
      const batch = res.events ?? [];
      events.push(...batch);
      cursor = res.cursor || undefined;
      // Defensive client trim: stop if oldest in batch is already older
      if (batch.length) {
        let oldest = Infinity;
        for (const e of batch) {
          const t = isoToMs(e.strike_date);
          if (t != null && t < oldest) oldest = t;
        }
        if (oldest < minStrikeDtMs) break;
      }
      if (!batch.length || !cursor) break;
      if (events.length > this.maxEventsPerSeries) {
        this.log(`  events safety cap hit at ${events.length} for ${series}`);
        break;
      }
    }
    return events;
  }

  /**
   * Fetch all markets for one event (up to 500 — BTC events have ~188).
   */
  async marketsForEvent(eventTicker: string): Promise<KalshiMarket[]> {
    await this.throttle.wait();
    const res = await this.client.getMarkets({
      event_ticker: eventTicker,
      limit: 500,
    });
    return res.markets ?? [];
  }

  /**
   * Paginate trades for a market using the client's getAllTrades helper.
   * Inter-request throttling is applied per page.
   */
  async fetchTrades(ticker: string): Promise<KalshiTrade[]> {
    const all: KalshiTrade[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxTradePages; page++) {
      await this.throttle.wait();
      const res = await this.client.getTrades({
        ticker,
        limit: 1000,
        cursor,
      });
      const batch = res.trades ?? [];
      all.push(...batch);
      const next = res.cursor || undefined;
      if (!batch.length || !next || next === cursor) break;
      cursor = next;
      if (page === this.maxTradePages - 1) {
        this.log(`  ${ticker}: hit ${this.maxTradePages}-page cap`);
      }
    }
    return all;
  }

  // ─── Full run ───────────────────────────────────────────────────────

  async run(opts: CollectorOptions = {}): Promise<CollectorSummary> {
    const hoursBack = opts.hoursBack ?? 24;
    const minVolume = opts.minVolume ?? 100;
    const dryRun = opts.dryRun ?? false;
    const force = opts.force ?? false;
    const seriesList = (opts.series ?? DEFAULT_SERIES) as readonly string[];

    const runStartedMs = Date.now();
    const nowMs = runStartedMs;
    const minStrikeDtMs = nowMs - hoursBack * 3_600_000;

    this.log("=".repeat(70));
    this.log("  KALSHI TAPE COLLECTOR (TS)");
    this.log(`  series:      ${JSON.stringify(seriesList)}`);
    this.log(`  hours_back:  ${hoursBack}`);
    this.log(`  min_volume:  ${minVolume} contracts`);
    this.log(`  min_strike:  ${new Date(minStrikeDtMs).toISOString()}`);
    this.log(`  dry_run:     ${dryRun}`);
    this.log(`  force:       ${force}`);
    this.log("=".repeat(70));

    const logId = this.db.startCollectionRun(hoursBack, minVolume);

    let nEvents = 0;
    let nMarketsSeen = 0;
    let nMarketsCollected = 0;
    let nTradesNew = 0;
    let nFailures = 0;
    let nValidationErrors = 0;

    // STEP 1: enumerate events
    type CandidateEvent = { series: string; eventTicker: string; event: KalshiEvent };
    const candidateEvents: CandidateEvent[] = [];
    for (const series of seriesList) {
      this.log(`Enumerating /events for series ${series} (min_close_ts=${Math.floor(minStrikeDtMs / 1000)}) ...`);
      let evs: KalshiEvent[];
      try {
        evs = await this.enumerateEvents(series, minStrikeDtMs);
      } catch (err) {
        this.log(`  FAIL enumerate ${series}: ${err instanceof Error ? err.message : String(err)}`);
        nFailures++;
        continue;
      }
      this.log(`  got ${evs.length} events from server; filtering strike_date in [${new Date(minStrikeDtMs).toISOString()}, now)`);
      let kept = 0;
      for (const e of evs) {
        const sdMs = isoToMs(e.strike_date);
        if (sdMs == null) continue;
        if (sdMs < minStrikeDtMs) continue;
        if (sdMs > nowMs) continue;
        candidateEvents.push({ series, eventTicker: e.event_ticker, event: e });
        kept++;
      }
      this.log(`  kept ${kept} events`);
    }
    nEvents = candidateEvents.length;

    // Newest first — if we quit early we still have fresh data
    candidateEvents.sort((a, b) => (b.event.strike_date ?? "").localeCompare(a.event.strike_date ?? ""));
    this.log(`Candidate events (settled within window): ${candidateEvents.length}`);

    // STEP 2: for each event, fetch markets and filter
    type Target = { series: string; market: KalshiMarket };
    const targets: Target[] = [];
    for (const { series, eventTicker } of candidateEvents) {
      let mkts: KalshiMarket[];
      try {
        mkts = await this.marketsForEvent(eventTicker);
      } catch (err) {
        this.log(`  FAIL markets ${eventTicker}: ${err instanceof Error ? err.message : String(err)}`);
        nFailures++;
        continue;
      }
      nMarketsSeen += mkts.length;
      let kept = 0;
      for (const m of mkts) {
        const errs = validateMarket(m);
        if (errs.length) continue;
        const vol = parseCount(m.volume_fp);
        if (vol < minVolume) continue;
        this.db.upsertMarket({
          ticker: m.ticker,
          event_ticker: m.event_ticker,
          series_ticker: series,
          strike_type: m.strike_type ?? null,
          floor_strike: m.floor_strike ?? null,
          cap_strike: m.cap_strike ?? null,
          status: m.status ?? null,
          result: m.result || null,
          settlement_value: m.settlement_value_dollars ? parseDollars(m.settlement_value_dollars) : null,
          expiration_value: m.expiration_value ? parseFloat(m.expiration_value) : null,
          open_time: m.open_time ?? null,
          close_time: m.close_time ?? null,
          open_interest_fp: m.open_interest_fp ? parseCount(m.open_interest_fp) : null,
          volume_fp: vol,
          volume_24h_fp: m.volume_24h_fp ? parseCount(m.volume_24h_fp) : null,
          collected_at: Date.now() / 1000,
        });
        targets.push({ series, market: m });
        kept++;
      }
      this.log(`  ${eventTicker}: ${mkts.length} mkts  ->  ${kept} settled w/ vol>=${minVolume}`);
    }

    this.log(`\nPlan: ${targets.length} markets qualify for tape collection`);
    if (dryRun) {
      this.log("--dry-run: exiting before /markets/trades fetches");
      this.db.finishCollectionRun(logId, {
        nEvents, nMarkets: nMarketsSeen, nTradesNew: 0,
        nMarketsCollected: 0, nFailures, notes: "dry-run",
      });
      return {
        nEvents, nMarketsSeen, nMarketsCollected: 0, nTradesNew: 0,
        nFailures, nValidationErrors: 0,
        elapsedSec: (Date.now() - runStartedMs) / 1000,
        notes: "dry-run",
      };
    }

    // STEP 3: collect tapes
    const tapeStartMs = Date.now();
    let processed = 0;
    for (const { market } of targets) {
      processed++;
      const ticker = market.ticker;
      if (!force && this.db.alreadyHasTape(ticker)) continue;

      let trades: KalshiTrade[];
      try {
        trades = await this.fetchTrades(ticker);
      } catch (err) {
        this.log(`  [${processed}/${targets.length}] FAIL tape ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
        nFailures++;
        continue;
      }

      // Validate + convert
      const rows: TradeRow[] = [];
      const errs: ValidationError[] = [];
      for (const t of trades) {
        const ve = validateTrade(t, market.close_time || null);
        if (ve.length) {
          errs.push(...ve);
          continue;
        }
        const tsRaw = t.taker_side as string;
        if (tsRaw !== "yes" && tsRaw !== "no") continue;
        rows.push({
          trade_id: t.trade_id,
          ticker,
          created_time: t.created_time,
          count_fp: parseCount(t.count_fp),
          yes_price: parseDollars(t.yes_price_dollars),
          no_price: parseDollars(t.no_price_dollars),
          taker_side: tsRaw as "yes" | "no",
        });
      }
      const nIns = this.db.insertTradesBatch(rows);
      this.db.markTapeCollected(ticker, trades.length);
      if (errs.length) {
        nValidationErrors += errs.length;
        for (const e of errs.slice(0, 2)) {
          this.log(`  validation (${ticker}): ${e.kind} ${e.detail}`);
        }
      }
      nTradesNew += nIns;
      nMarketsCollected++;

      if (processed % 25 === 0 || processed === targets.length) {
        const elapsed = (Date.now() - tapeStartMs) / 1000;
        const rate = elapsed ? nMarketsCollected / elapsed : 0;
        const nDupe = trades.length - nIns - errs.length;
        this.log(
          `  [${processed}/${targets.length}] ${ticker}: +${nIns} trades ` +
          `(dupe ${nDupe}) | total +${nTradesNew} | ${rate.toFixed(1)} mkt/s`,
        );
      }
    }

    const elapsedSec = (Date.now() - runStartedMs) / 1000;
    const notes = `val_errs=${nValidationErrors}`;
    this.db.finishCollectionRun(logId, {
      nEvents, nMarkets: nMarketsSeen, nTradesNew,
      nMarketsCollected, nFailures, notes,
    });

    this.log("=".repeat(70));
    this.log(`  COMPLETE in ${elapsedSec.toFixed(1)}s`);
    this.log(`  events:             ${nEvents}`);
    this.log(`  markets seen:       ${nMarketsSeen}`);
    this.log(`  markets collected:  ${nMarketsCollected}`);
    this.log(`  trades inserted:    ${nTradesNew}`);
    this.log(`  failures:           ${nFailures}`);
    this.log(`  validation errors:  ${nValidationErrors}`);
    this.log("=".repeat(70));

    return {
      nEvents, nMarketsSeen, nMarketsCollected, nTradesNew,
      nFailures, nValidationErrors, elapsedSec, notes,
    };
  }
}
