/**
 * SQLite persistence for the Kalshi anonymous-tape archive.
 *
 * Mirrors the Python kalshi_tape.db schema exactly — the two code paths
 * can share the file on disk while migration is in flight.
 *
 * Invariants enforced downstream in the collector:
 *   - trade yes_price + no_price ≈ 1 (tolerance 1.5¢)
 *   - count_fp > 0
 *   - taker_side ∈ {yes, no}
 *   - created_time within [open_time, close_time + 5min grace]
 *   - SUM(count_fp) per market ≈ market.volume_fp
 */

import { Database } from "bun:sqlite";

export interface MarketRow {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  strike_type: string | null;
  floor_strike: number | null;
  cap_strike: number | null;
  status: string | null;
  result: string | null;
  settlement_value: number | null;
  expiration_value: number | null;
  open_time: string | null;
  close_time: string | null;
  open_interest_fp: number | null;
  volume_fp: number | null;
  volume_24h_fp: number | null;
  collected_at: number | null;
  tape_collected_at: number | null;
  tape_n_trades: number | null;
}

export interface TradeRow {
  trade_id: string;
  ticker: string;
  created_time: string;
  count_fp: number;
  yes_price: number;
  no_price: number;
  taker_side: "yes" | "no";
}

export class TapeDB {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markets (
        ticker              TEXT PRIMARY KEY,
        event_ticker        TEXT NOT NULL,
        series_ticker       TEXT NOT NULL,
        strike_type         TEXT,
        floor_strike        REAL,
        cap_strike          REAL,
        status              TEXT,
        result              TEXT,
        settlement_value    REAL,
        expiration_value    REAL,
        open_time           TEXT,
        close_time          TEXT,
        open_interest_fp    REAL,
        volume_fp           REAL,
        volume_24h_fp       REAL,
        collected_at        REAL,
        tape_collected_at   REAL,
        tape_n_trades       INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_ticker);
      CREATE INDEX IF NOT EXISTS idx_markets_series ON markets(series_ticker);
      CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
      CREATE INDEX IF NOT EXISTS idx_markets_close ON markets(close_time);

      CREATE TABLE IF NOT EXISTS trades (
        trade_id       TEXT PRIMARY KEY,
        ticker         TEXT NOT NULL,
        created_time   TEXT NOT NULL,
        count_fp       REAL NOT NULL,
        yes_price      REAL NOT NULL,
        no_price       REAL NOT NULL,
        taker_side     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
      CREATE INDEX IF NOT EXISTS idx_trades_ct ON trades(created_time);

      CREATE TABLE IF NOT EXISTS collection_log (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        run_started_at        REAL NOT NULL,
        run_ended_at          REAL,
        hours_back            REAL,
        min_volume            REAL,
        n_events              INTEGER,
        n_markets             INTEGER,
        n_trades_new          INTEGER,
        n_markets_collected   INTEGER,
        n_failures            INTEGER,
        notes                 TEXT
      );
    `);
  }

  // --- markets ---
  upsertMarket(row: Omit<MarketRow, "tape_collected_at" | "tape_n_trades">): void {
    this.db.run(
      `INSERT INTO markets
        (ticker, event_ticker, series_ticker, strike_type, floor_strike, cap_strike,
         status, result, settlement_value, expiration_value,
         open_time, close_time, open_interest_fp, volume_fp, volume_24h_fp,
         collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         event_ticker = excluded.event_ticker,
         series_ticker = excluded.series_ticker,
         strike_type = excluded.strike_type,
         floor_strike = excluded.floor_strike,
         cap_strike = excluded.cap_strike,
         status = excluded.status,
         result = excluded.result,
         settlement_value = excluded.settlement_value,
         expiration_value = excluded.expiration_value,
         open_time = excluded.open_time,
         close_time = excluded.close_time,
         open_interest_fp = excluded.open_interest_fp,
         volume_fp = excluded.volume_fp,
         volume_24h_fp = excluded.volume_24h_fp,
         collected_at = excluded.collected_at`,
      [
        row.ticker, row.event_ticker, row.series_ticker, row.strike_type,
        row.floor_strike, row.cap_strike,
        row.status, row.result, row.settlement_value, row.expiration_value,
        row.open_time, row.close_time,
        row.open_interest_fp, row.volume_fp, row.volume_24h_fp,
        row.collected_at,
      ],
    );
  }

  markTapeCollected(ticker: string, nTrades: number): void {
    this.db.run(
      `UPDATE markets SET tape_collected_at = ?, tape_n_trades = ? WHERE ticker = ?`,
      [Date.now() / 1000, nTrades, ticker],
    );
  }

  alreadyHasTape(ticker: string): boolean {
    const q = this.db.query<{ c: number }, [string]>(
      "SELECT COUNT(*) c FROM markets WHERE ticker=? AND tape_collected_at IS NOT NULL",
    );
    return (q.get(ticker)?.c ?? 0) > 0;
  }

  // --- trades ---
  insertTrade(row: TradeRow): boolean {
    const r = this.db.run(
      `INSERT OR IGNORE INTO trades
        (trade_id, ticker, created_time, count_fp, yes_price, no_price, taker_side)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.trade_id, row.ticker, row.created_time,
        row.count_fp, row.yes_price, row.no_price, row.taker_side,
      ],
    );
    return r.changes > 0;
  }

  insertTradesBatch(rows: TradeRow[]): number {
    if (!rows.length) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO trades
        (trade_id, ticker, created_time, count_fp, yes_price, no_price, taker_side)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let newRows = 0;
    const tx = this.db.transaction((rs: TradeRow[]) => {
      for (const r of rs) {
        const res = stmt.run(
          r.trade_id, r.ticker, r.created_time,
          r.count_fp, r.yes_price, r.no_price, r.taker_side,
        );
        if (res.changes > 0) newRows++;
      }
    });
    tx(rows);
    return newRows;
  }

  // --- collection log ---
  startCollectionRun(hoursBack: number, minVolume: number): number {
    const r = this.db.run(
      `INSERT INTO collection_log (run_started_at, hours_back, min_volume) VALUES (?, ?, ?)`,
      [Date.now() / 1000, hoursBack, minVolume],
    );
    return Number(r.lastInsertRowid);
  }

  finishCollectionRun(
    id: number,
    args: {
      nEvents: number; nMarkets: number; nTradesNew: number;
      nMarketsCollected: number; nFailures: number; notes: string;
    },
  ): void {
    this.db.run(
      `UPDATE collection_log
       SET run_ended_at = ?, n_events = ?, n_markets = ?, n_trades_new = ?,
           n_markets_collected = ?, n_failures = ?, notes = ?
       WHERE id = ?`,
      [
        Date.now() / 1000,
        args.nEvents, args.nMarkets, args.nTradesNew,
        args.nMarketsCollected, args.nFailures, args.notes, id,
      ],
    );
  }

  close(): void {
    this.db.close();
  }
}
