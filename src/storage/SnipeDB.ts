/**
 * SQLite persistence for the Kalshi snipe bot.
 *
 * Runs on bun:sqlite (zero-dep, bundled with Bun). Schema matches the
 * Python kalshi_snipe.db so the two code paths can coexist during the
 * migration, and historical paper trades don't need to be rewritten.
 *
 * Key tables:
 *   - live_trades: every snipe fired (paper or live). Resolved trades
 *     get outcome + pnl + bankroll filled in via resolve_trade().
 *   - session_stats: one row per run. Updated every tick.
 *   - event_log: free-form breadcrumb trail.
 *
 * window_id convention: kalshi-snipe-<event>-<market>-<stage>-<ms-ts>
 * so resolve_trade's UPDATE ... WHERE window_id=? never collides with
 * re-snipes on the same market (which was the Python DB bug fixed
 * this week).
 */

import { Database } from "bun:sqlite";

export type TradeOutcome = -1 | 0 | 1;

export interface SaveTradeArgs {
  windowId: string;
  side: "YES" | "NO";
  modelName: string;           // "kalshi_<stage>_<conviction>"
  modelProb: number;           // currently always 1.0 for snipe
  marketProb: number;
  confidence: number;
  entryPrice: number;
  fee: number;
  shares: number;
  bankroll: number;
}

export interface TradeRow {
  id: number;
  window_id: string;
  timestamp: string;
  model_name: string;
  side: "YES" | "NO";
  entry_price: number;
  shares: number;
  fee: number;
  outcome: TradeOutcome | null;
  pnl: number | null;
  bankroll_at_entry: number;
  bankroll_after: number | null;
  resolved_at: string | null;
}

export class SnipeDB {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    // pragmas for durability + concurrency
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_trades (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        window_id          TEXT    NOT NULL UNIQUE,
        timestamp          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        model_name         TEXT,
        side               TEXT,
        model_prob         REAL,
        market_prob        REAL,
        confidence         REAL,
        entry_price        REAL,
        fee                REAL,
        shares             REAL,
        outcome            INTEGER,
        pnl                REAL,
        bankroll_at_entry  REAL,
        bankroll_after     REAL,
        resolved_at        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_live_trades_window ON live_trades(window_id);
      CREATE INDEX IF NOT EXISTS idx_live_trades_resolved ON live_trades(resolved_at);

      CREATE TABLE IF NOT EXISTS session_stats (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        session_start      REAL,
        last_update        REAL,
        trades_executed    INTEGER DEFAULT 0,
        trades_won         INTEGER DEFAULT 0,
        total_pnl          REAL DEFAULT 0,
        total_fees         REAL DEFAULT 0,
        bankroll           REAL,
        peak_bankroll      REAL,
        max_drawdown_pct   REAL DEFAULT 0,
        config_json        TEXT
      );

      CREATE TABLE IF NOT EXISTS event_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        message   TEXT
      );
    `);
  }

  saveTrade(a: SaveTradeArgs): void {
    this.db.run(
      `INSERT OR IGNORE INTO live_trades
        (window_id, model_name, side, model_prob, market_prob, confidence,
         entry_price, fee, shares, bankroll_at_entry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.windowId, a.modelName, a.side,
        a.modelProb, a.marketProb, a.confidence,
        a.entryPrice, a.fee, a.shares, a.bankroll,
      ],
    );
  }

  resolveTrade(windowId: string, outcome: TradeOutcome, pnl: number, bankrollAfter: number): void {
    this.db.run(
      `UPDATE live_trades
       SET outcome = ?, pnl = ?, bankroll_after = ?, resolved_at = CURRENT_TIMESTAMP
       WHERE window_id = ?`,
      [outcome, pnl, bankrollAfter, windowId],
    );
  }

  logEvent(message: string): void {
    this.db.run("INSERT INTO event_log (message) VALUES (?)", [message]);
  }

  beginSession(bankroll: number, configJson: string): number {
    const r = this.db.run(
      `INSERT INTO session_stats
        (session_start, last_update, bankroll, peak_bankroll, config_json)
       VALUES (?, ?, ?, ?, ?)`,
      [Date.now() / 1000, Date.now() / 1000, bankroll, bankroll, configJson],
    );
    return Number(r.lastInsertRowid);
  }

  updateSessionStats(args: {
    tradesExecuted: number;
    tradesWon: number;
    totalPnl: number;
    totalFees: number;
    bankroll: number;
    peakBankroll: number;
    drawdownPct: number;
  }): void {
    this.db.run(
      `UPDATE session_stats
       SET last_update = ?, trades_executed = ?, trades_won = ?,
           total_pnl = ?, total_fees = ?,
           bankroll = ?, peak_bankroll = ?, max_drawdown_pct = ?
       WHERE id = (SELECT MAX(id) FROM session_stats)`,
      [
        Date.now() / 1000,
        args.tradesExecuted, args.tradesWon,
        args.totalPnl, args.totalFees,
        args.bankroll, args.peakBankroll, args.drawdownPct,
      ],
    );
  }

  /**
   * Replay resolved Kalshi trades to rehydrate in-memory stats. Mirrors
   * the Python _load_persisted_state.
   */
  loadPersistedKalshiTrades(): TradeRow[] {
    const q = this.db.query<TradeRow, []>(
      `SELECT id, window_id, timestamp, model_name, side,
              entry_price, shares, fee, outcome, pnl,
              bankroll_at_entry, bankroll_after, resolved_at
       FROM live_trades
       WHERE outcome IS NOT NULL
         AND window_id LIKE 'kalshi-snipe-%'
       ORDER BY COALESCE(resolved_at, timestamp) ASC`,
    );
    return q.all();
  }

  close(): void {
    this.db.close();
  }
}
