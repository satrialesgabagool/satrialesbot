"""SQLite database layer for persistent storage of live market data and trades."""

import sqlite3
import json
import time
import os
from contextlib import contextmanager
from dataclasses import asdict

DB_PATH = os.path.join(os.path.dirname(__file__), "satriales.db")


def get_connection(db_path: str = None) -> sqlite3.Connection:
    path = db_path or DB_PATH
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def get_db(db_path: str = None):
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path: str = None):
    """Create all tables if they don't exist."""
    with get_db(db_path) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS market_windows (
                window_id TEXT PRIMARY KEY,
                epoch_start INTEGER NOT NULL,
                epoch_end INTEGER NOT NULL,
                strike_price REAL,
                outcome INTEGER,  -- NULL if not yet resolved
                btc_open REAL,
                btc_high REAL,
                btc_low REAL,
                btc_close REAL,
                btc_volume REAL,
                btc_ticks TEXT,  -- JSON array
                market_prices TEXT,  -- JSON array
                market_bids TEXT,
                market_asks TEXT,
                market_volumes TEXT,
                btc_prices_preceding_30m TEXT,
                collected_at REAL,
                source TEXT DEFAULT 'live'
            );

            CREATE TABLE IF NOT EXISTS live_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                window_id TEXT NOT NULL,
                timestamp REAL NOT NULL,
                side TEXT NOT NULL,  -- YES / NO / ABSTAIN
                model_name TEXT,
                model_prob REAL,
                market_prob REAL,
                edge REAL,
                entry_price REAL,
                fee_paid REAL,
                shares REAL,
                outcome INTEGER,  -- NULL if pending
                pnl REAL,  -- NULL if pending
                bankroll_after REAL,
                resolved_at REAL,
                FOREIGN KEY (window_id) REFERENCES market_windows(window_id)
            );

            CREATE TABLE IF NOT EXISTS model_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model_name TEXT NOT NULL,
                trained_at REAL NOT NULL,
                train_windows INTEGER,
                params TEXT,  -- JSON
                metrics TEXT,  -- JSON: train brier, cv score, etc.
                model_blob BLOB  -- pickled model
            );

            CREATE TABLE IF NOT EXISTS session_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_start REAL NOT NULL,
                last_update REAL NOT NULL,
                windows_collected INTEGER DEFAULT 0,
                trades_executed INTEGER DEFAULT 0,
                trades_won INTEGER DEFAULT 0,
                total_pnl REAL DEFAULT 0.0,
                total_fees REAL DEFAULT 0.0,
                bankroll REAL DEFAULT 1000.0,
                peak_bankroll REAL DEFAULT 1000.0,
                max_drawdown_pct REAL DEFAULT 0.0,
                config_json TEXT
            );

            CREATE TABLE IF NOT EXISTS collector_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                level TEXT DEFAULT 'INFO',
                message TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_windows_epoch ON market_windows(epoch_start);
            CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON live_trades(timestamp);
            CREATE INDEX IF NOT EXISTS idx_trades_window ON live_trades(window_id);
        """)


def save_market_window(conn, window_id, epoch_start, epoch_end, strike_price,
                       outcome, btc_open, btc_high, btc_low, btc_close,
                       btc_volume, btc_ticks, market_prices, market_bids,
                       market_asks, market_volumes, btc_preceding, source="live"):
    """Insert or update a market window."""
    conn.execute("""
        INSERT OR REPLACE INTO market_windows
        (window_id, epoch_start, epoch_end, strike_price, outcome,
         btc_open, btc_high, btc_low, btc_close, btc_volume,
         btc_ticks, market_prices, market_bids, market_asks,
         market_volumes, btc_prices_preceding_30m, collected_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (window_id, epoch_start, epoch_end, strike_price, outcome,
          btc_open, btc_high, btc_low, btc_close, btc_volume,
          json.dumps(btc_ticks), json.dumps(market_prices),
          json.dumps(market_bids), json.dumps(market_asks),
          json.dumps(market_volumes), json.dumps(btc_preceding),
          time.time(), source))


def save_live_trade(conn, window_id, side, model_name, model_prob, market_prob,
                    edge, entry_price, fee_paid, shares, bankroll_after):
    """Record a simulated live trade (outcome pending)."""
    conn.execute("""
        INSERT INTO live_trades
        (window_id, timestamp, side, model_name, model_prob, market_prob,
         edge, entry_price, fee_paid, shares, bankroll_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (window_id, time.time(), side, model_name, model_prob, market_prob,
          edge, entry_price, fee_paid, shares, bankroll_after))


def resolve_trade(conn, window_id, outcome, pnl, bankroll_after):
    """Resolve a pending trade once the window outcome is known."""
    conn.execute("""
        UPDATE live_trades
        SET outcome = ?, pnl = ?, bankroll_after = ?, resolved_at = ?
        WHERE window_id = ? AND outcome IS NULL
    """, (outcome, pnl, bankroll_after, time.time(), window_id))


def log_event(conn, message, level="INFO"):
    conn.execute("INSERT INTO collector_log (timestamp, level, message) VALUES (?, ?, ?)",
                 (time.time(), level, message))


def get_recent_windows(conn, limit=100):
    """Get most recent collected windows."""
    rows = conn.execute(
        "SELECT * FROM market_windows ORDER BY epoch_start DESC LIMIT ?",
        (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def get_all_trades(conn):
    """Get all live trades."""
    rows = conn.execute(
        "SELECT * FROM live_trades ORDER BY timestamp ASC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_session_stats(conn):
    """Get latest session stats."""
    row = conn.execute(
        "SELECT * FROM session_stats ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return dict(row) if row else None


def get_recent_logs(conn, limit=200):
    rows = conn.execute(
        "SELECT * FROM collector_log ORDER BY id DESC LIMIT ?",
        (limit,)
    ).fetchall()
    return [dict(r) for r in reversed(rows)]


def get_trade_summary(conn):
    """Aggregate trade statistics."""
    row = conn.execute("""
        SELECT
            COUNT(*) as total_trades,
            SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
            SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending,
            COALESCE(SUM(pnl), 0) as total_pnl,
            COALESCE(SUM(fee_paid), 0) as total_fees,
            COALESCE(AVG(CASE WHEN pnl IS NOT NULL THEN pnl END), 0) as avg_pnl,
            COALESCE(AVG(ABS(edge)), 0) as avg_edge,
            MAX(bankroll_after) as peak_bankroll,
            MIN(bankroll_after) as min_bankroll
        FROM live_trades
    """).fetchone()
    return dict(row) if row else {}


def get_hourly_pnl(conn):
    """Get PnL aggregated by hour."""
    rows = conn.execute("""
        SELECT
            CAST(timestamp / 3600 AS INTEGER) * 3600 as hour_epoch,
            SUM(pnl) as pnl,
            COUNT(*) as trades,
            SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
        FROM live_trades
        WHERE pnl IS NOT NULL
        GROUP BY hour_epoch
        ORDER BY hour_epoch ASC
    """).fetchall()
    return [dict(r) for r in rows]
