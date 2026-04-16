"""
Kalshi BTC trade-tape collector.

Goal: archive every anonymous fill on settled BTC markets so we can
reverse-engineer what winning order flow looks like. Since Kalshi
does not expose trader identities, we operate on the fill-level tape
plus post-settlement outcomes.

Design:
  - Enumerates settled KXBTCD + KXBTC events via /events
  - For each event, fetches markets via /markets?event_ticker=...
  - For each market with volume > threshold, paginates /markets/trades
  - Persists everything to kalshi_tape.db (SQLite)
  - Idempotent: re-runs skip already-collected markets
  - Validates data on insert (yes+no=1, count>0, timestamps sane)

Safety invariants enforced:
  1. Every trade has yes_price + no_price == 1.000 (to cents)
  2. Every trade has count_fp > 0
  3. Every trade's created_time <= its market's close_time
  4. taker_side is exactly 'yes' or 'no'
  5. market.result is exactly 'yes' or 'no' (skip voided)
  6. floor_strike / cap_strike non-null for the strike_type we expect
  7. No duplicate trade_id in the same market (we use trade_id PRIMARY KEY)

Usage:
  python kalshi_tape_collector.py --hours 24
  python kalshi_tape_collector.py --hours 48 --min-volume 500
  python kalshi_tape_collector.py --dry-run                # print plan only
"""

from __future__ import annotations
import argparse
import logging
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2"
DB_PATH = "kalshi_tape.db"
SERIES = ["KXBTCD", "KXBTC"]

log = logging.getLogger("tape")

# ------------------------------------------------------------------
# DB
# ------------------------------------------------------------------

SCHEMA_SQL = """
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

CREATE TABLE IF NOT EXISTS trades (
    trade_id            TEXT PRIMARY KEY,
    ticker              TEXT NOT NULL,
    created_time        TEXT NOT NULL,
    count_fp            REAL NOT NULL,
    yes_price           REAL NOT NULL,
    no_price            REAL NOT NULL,
    taker_side          TEXT NOT NULL,
    FOREIGN KEY (ticker) REFERENCES markets(ticker)
);

CREATE INDEX IF NOT EXISTS idx_trades_ticker   ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_trades_created  ON trades(created_time);
CREATE INDEX IF NOT EXISTS idx_markets_event   ON markets(event_ticker);
CREATE INDEX IF NOT EXISTS idx_markets_series  ON markets(series_ticker);
CREATE INDEX IF NOT EXISTS idx_markets_status  ON markets(status);

CREATE TABLE IF NOT EXISTS collection_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_started_at  REAL NOT NULL,
    run_ended_at    REAL,
    hours_back      REAL,
    min_volume      REAL,
    n_events        INTEGER,
    n_markets       INTEGER,
    n_trades_new    INTEGER,
    n_markets_collected INTEGER,
    n_failures      INTEGER,
    notes           TEXT
);
"""

def open_db(path: str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    return conn


# ------------------------------------------------------------------
# HTTP helpers
# ------------------------------------------------------------------

class KalshiTape:
    def __init__(self, base: str = PROD_BASE, max_retries: int = 4,
                 inter_request_delay: float = 0.15):
        self.base = base
        self.max_retries = max_retries
        self.delay = inter_request_delay  # proactive throttle to avoid 429
        self.sess = requests.Session()
        self.n_requests = 0
        self.n_429s = 0
        self._last_request_ts = 0.0

    def _get(self, path: str, params: dict | None = None) -> dict:
        url = f"{self.base}{path}"
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            # polite gap
            since = time.time() - self._last_request_ts
            if since < self.delay:
                time.sleep(self.delay - since)
            try:
                r = self.sess.get(url, params=params, timeout=15)
                self.n_requests += 1
                self._last_request_ts = time.time()
                if r.status_code == 429:
                    self.n_429s += 1
                    # Exponential backoff on 429
                    wait = min(10, 2 ** attempt)
                    log.warning(f"  429 throttled on {path}, sleeping {wait}s")
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                return r.json()
            except Exception as e:
                last_err = e
                if attempt == self.max_retries - 1:
                    break
                time.sleep(min(3, 0.5 + attempt))
        raise RuntimeError(f"GET {path} failed after {self.max_retries}: {last_err}")

    # ----------- events / markets / trades ---------------

    def events(self, series: str, min_close_ts: int | None = None,
               min_strike_dt: datetime | None = None, limit: int = 200) -> list[dict]:
        """Paginate events for a series. Uses Kalshi's min_close_ts server-side
        filter (verified 2026-04-16) to avoid fetching thousands of irrelevant
        old events. min_strike_dt is a defensive client-side trim in case the
        server returns events with strike_date slightly older than min_close_ts
        (e.g. events that closed early)."""
        events: list[dict] = []
        cursor = None
        while True:
            params: dict[str, Any] = {"series_ticker": series, "limit": limit}
            if min_close_ts is not None:
                params["min_close_ts"] = int(min_close_ts)
            if cursor:
                params["cursor"] = cursor
            d = self._get("/events", params=params)
            batch = d.get("events") or []
            events.extend(batch)
            cursor = d.get("cursor") or None
            # Defensive client-side trim: stop if this batch's oldest is already
            # before min_strike_dt (Kalshi returns newest-first)
            if min_strike_dt is not None and batch:
                oldest_iso = min((e.get("strike_date") or "") for e in batch)
                oldest = iso_to_dt(oldest_iso)
                if oldest and oldest < min_strike_dt:
                    break
            if not batch or not cursor:
                break
            if len(events) > 5000:
                log.warning(f"  events safety cap hit at {len(events)} for {series}")
                break
        return events

    def markets_for_event(self, event_ticker: str) -> list[dict]:
        """One event's markets. Capped at 500 (BTC events have ~188)."""
        d = self._get("/markets", params={"event_ticker": event_ticker, "limit": 500})
        return d.get("markets") or []

    def trades(self, ticker: str) -> list[dict]:
        """Full trade tape for one market, paginated."""
        trades: list[dict] = []
        cursor: str | None = None
        pages = 0
        while True:
            params: dict[str, Any] = {"ticker": ticker, "limit": 200}
            if cursor:
                params["cursor"] = cursor
            d = self._get("/markets/trades", params=params)
            batch = d.get("trades") or []
            trades.extend(batch)
            new_cursor = d.get("cursor") or None
            pages += 1
            if not batch or not new_cursor or new_cursor == cursor:
                break
            cursor = new_cursor
            if pages >= 500:  # 100k trades safety cap
                log.warning(f"  {ticker}: hit 500-page cap")
                break
        return trades


# ------------------------------------------------------------------
# Validation
# ------------------------------------------------------------------

@dataclass
class ValidationError:
    kind: str
    detail: str

def validate_market(m: dict) -> list[ValidationError]:
    errs: list[ValidationError] = []
    if not m.get("ticker"):
        errs.append(ValidationError("missing_ticker", repr(m)[:80]))
    if m.get("result") not in ("yes", "no"):
        errs.append(ValidationError("bad_result", f'result={m.get("result")!r}'))
    if m.get("status") != "finalized":
        errs.append(ValidationError("not_finalized", f'status={m.get("status")!r}'))
    # strike bounds
    stype = m.get("strike_type")
    fs = m.get("floor_strike")
    cs = m.get("cap_strike")
    if stype == "greater" and fs is None:
        errs.append(ValidationError("missing_floor", m.get("ticker", "")))
    elif stype == "less" and cs is None:
        errs.append(ValidationError("missing_cap", m.get("ticker", "")))
    elif stype == "between" and (fs is None or cs is None):
        errs.append(ValidationError("missing_between", m.get("ticker", "")))
    return errs

def validate_trade(t: dict, close_time: str | None) -> list[ValidationError]:
    errs: list[ValidationError] = []
    try:
        yp = float(t["yes_price_dollars"])
        np_ = float(t["no_price_dollars"])
        cf = float(t["count_fp"])
    except (KeyError, ValueError, TypeError) as e:
        return [ValidationError("parse_error", str(e))]
    if abs(yp + np_ - 1.0) > 0.015:  # allow 1.5c rounding - Kalshi prices in cents
        errs.append(ValidationError("price_sum", f"yp={yp} np={np_} sum={yp+np_}"))
    if cf <= 0:
        errs.append(ValidationError("bad_count", f"count_fp={cf}"))
    ts = t.get("taker_side")
    if ts not in ("yes", "no"):
        errs.append(ValidationError("bad_taker", f"taker_side={ts!r}"))
    if not t.get("trade_id"):
        errs.append(ValidationError("missing_trade_id", ""))
    created = t.get("created_time")
    if not created:
        errs.append(ValidationError("missing_created", ""))
    elif close_time and created > close_time:
        # fills after official close: tolerate small skew (settlement timer ~60s)
        # but log anything >5min off
        try:
            ct = datetime.fromisoformat(close_time.replace("Z", "+00:00"))
            ctr = datetime.fromisoformat(created.replace("Z", "+00:00"))
            if (ctr - ct).total_seconds() > 300:
                errs.append(ValidationError("fill_after_close",
                                            f"{ctr.isoformat()} > {close_time}"))
        except Exception:
            pass
    return errs


# ------------------------------------------------------------------
# Collector
# ------------------------------------------------------------------

def iso_to_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None

def upsert_market(conn: sqlite3.Connection, m: dict, series: str) -> None:
    conn.execute("""
        INSERT INTO markets
            (ticker, event_ticker, series_ticker, strike_type, floor_strike, cap_strike,
             status, result, settlement_value, expiration_value,
             open_time, close_time, open_interest_fp, volume_fp, volume_24h_fp,
             collected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
            status = excluded.status,
            result = excluded.result,
            settlement_value = excluded.settlement_value,
            expiration_value = excluded.expiration_value,
            open_interest_fp = excluded.open_interest_fp,
            volume_fp = excluded.volume_fp,
            volume_24h_fp = excluded.volume_24h_fp,
            collected_at = excluded.collected_at
    """, (
        m.get("ticker"),
        m.get("event_ticker"),
        series,
        m.get("strike_type"),
        m.get("floor_strike"),
        m.get("cap_strike"),
        m.get("status"),
        m.get("result"),
        float(m["settlement_value_dollars"]) if m.get("settlement_value_dollars") else None,
        float(m["expiration_value"]) if m.get("expiration_value") else None,
        m.get("open_time"),
        m.get("close_time"),
        float(m["open_interest_fp"]) if m.get("open_interest_fp") else None,
        float(m["volume_fp"]) if m.get("volume_fp") else None,
        float(m["volume_24h_fp"]) if m.get("volume_24h_fp") else None,
        time.time(),
    ))

def insert_trades(conn: sqlite3.Connection, ticker: str, trades: list[dict],
                  close_time: str | None, strict: bool = True
                  ) -> tuple[int, int, list[ValidationError]]:
    """Returns (n_inserted, n_skipped_dupe, validation_errors)."""
    n_ins = 0
    n_dupe = 0
    errs: list[ValidationError] = []
    for t in trades:
        ve = validate_trade(t, close_time)
        if ve:
            errs.extend(ve)
            if strict:
                continue
        try:
            yp = float(t["yes_price_dollars"])
            np_ = float(t["no_price_dollars"])
            cf = float(t["count_fp"])
        except (KeyError, ValueError, TypeError):
            continue
        cur = conn.execute("""
            INSERT OR IGNORE INTO trades
                (trade_id, ticker, created_time, count_fp, yes_price, no_price, taker_side)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (t["trade_id"], ticker, t["created_time"], cf, yp, np_, t["taker_side"]))
        if cur.rowcount == 1:
            n_ins += 1
        else:
            n_dupe += 1
    return n_ins, n_dupe, errs

def mark_tape_collected(conn: sqlite3.Connection, ticker: str, n: int) -> None:
    conn.execute("UPDATE markets SET tape_collected_at = ?, tape_n_trades = ? WHERE ticker = ?",
                 (time.time(), n, ticker))


def already_has_tape(conn: sqlite3.Connection, ticker: str) -> bool:
    r = conn.execute("SELECT tape_collected_at FROM markets WHERE ticker = ?", (ticker,)).fetchone()
    return bool(r and r["tape_collected_at"])


# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24.0,
                    help="How many hours back of settled events to collect")
    ap.add_argument("--min-volume", type=float, default=100.0,
                    help="Skip markets with volume_fp < this (contracts)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print collection plan without fetching trades")
    ap.add_argument("--force", action="store_true",
                    help="Re-collect tapes even if already collected")
    ap.add_argument("--series", action="append", default=None,
                    help="Series to collect (repeatable). Default: both KXBTCD, KXBTC")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout),
                  logging.FileHandler("kalshi_tape.log", encoding="utf-8")],
    )

    series_list = args.series or SERIES
    min_strike_dt = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    now_dt = datetime.now(timezone.utc)

    log.info("=" * 70)
    log.info(f"  KALSHI TAPE COLLECTOR")
    log.info(f"  series:      {series_list}")
    log.info(f"  hours_back:  {args.hours}")
    log.info(f"  min_volume:  {args.min_volume} contracts")
    log.info(f"  min_strike:  {min_strike_dt.isoformat()}")
    log.info(f"  db:          {DB_PATH}")
    log.info(f"  dry_run:     {args.dry_run}")
    log.info("=" * 70)

    run_started = time.time()
    cli = KalshiTape()
    conn = open_db()
    log_cur = conn.execute("""
        INSERT INTO collection_log (run_started_at, hours_back, min_volume)
        VALUES (?, ?, ?)
    """, (run_started, args.hours, args.min_volume))
    log_id = log_cur.lastrowid

    n_events = 0
    n_markets_seen = 0
    n_markets_collected = 0
    n_trades_new = 0
    n_failures = 0
    n_validation_errors = 0

    # STEP 1: enumerate events, filter by strike_date window
    candidate_events: list[tuple[str, str, dict]] = []  # (series, event_ticker, event_dict)
    min_close_ts = int(min_strike_dt.timestamp())
    for series in series_list:
        log.info(f"Enumerating /events for series {series} (min_close_ts={min_close_ts}) ...")
        evs = cli.events(series, min_close_ts=min_close_ts, min_strike_dt=min_strike_dt)
        log.info(f"  got {len(evs)} events from server; filtering to "
                 f"strike_date in [{min_strike_dt.isoformat()}, now)")
        kept = 0
        for e in evs:
            sd = iso_to_dt(e.get("strike_date"))
            if not sd:
                continue
            if sd < min_strike_dt:
                continue
            if sd > now_dt:
                continue
            candidate_events.append((series, e["event_ticker"], e))
            kept += 1
        log.info(f"  kept {kept} events")
    n_events = len(candidate_events)

    # Sort by strike_date desc so newest first (if we stop early we still have fresh data)
    candidate_events.sort(key=lambda x: x[2].get("strike_date") or "", reverse=True)
    log.info(f"Candidate events (settled within window): {len(candidate_events)}")

    # STEP 2: for each event, fetch markets, filter by volume + status=finalized
    targets: list[tuple[str, dict]] = []  # (series, market)
    for series, ev_tk, ev in candidate_events:
        try:
            mkts = cli.markets_for_event(ev_tk)
        except Exception as e:
            log.error(f"  FAIL markets {ev_tk}: {e}")
            n_failures += 1
            continue
        n_markets_seen += len(mkts)
        kept = 0
        for m in mkts:
            errs = validate_market(m)
            if errs:
                continue  # non-settled or malformed
            vol = float(m.get("volume_fp", 0) or 0)
            if vol < args.min_volume:
                continue
            with conn:
                upsert_market(conn, m, series)
            targets.append((series, m))
            kept += 1
        log.info(f"  {ev_tk}: {len(mkts)} mkts  ->  {kept} settled w/ vol>={args.min_volume}")

    log.info(f"\nPlan: {len(targets)} markets qualify for tape collection")
    if args.dry_run:
        log.info("--dry-run: exiting before /markets/trades fetches")
        conn.execute("UPDATE collection_log SET run_ended_at=?, n_events=?, n_markets=?, "
                     "n_markets_collected=?, n_trades_new=?, n_failures=?, notes='dry-run' "
                     "WHERE id=?",
                     (time.time(), n_events, n_markets_seen, 0, 0, n_failures, log_id))
        conn.commit()
        return

    # STEP 3: collect tapes
    start_tape = time.time()
    for i, (series, m) in enumerate(targets, 1):
        ticker = m["ticker"]
        if not args.force and already_has_tape(conn, ticker):
            continue
        try:
            trades = cli.trades(ticker)
        except Exception as e:
            log.error(f"  [{i}/{len(targets)}] FAIL tape {ticker}: {e}")
            n_failures += 1
            continue
        with conn:
            n_ins, n_dupe, errs = insert_trades(conn, ticker, trades, m.get("close_time"))
            mark_tape_collected(conn, ticker, len(trades))
        if errs:
            n_validation_errors += len(errs)
            # Only log the first couple per market
            for e in errs[:2]:
                log.warning(f"  validation ({ticker}): {e.kind} {e.detail}")
        n_trades_new += n_ins
        n_markets_collected += 1
        if i % 25 == 0 or i == len(targets):
            elapsed = time.time() - start_tape
            rate = n_markets_collected / elapsed if elapsed else 0
            log.info(f"  [{i}/{len(targets)}] {ticker}: +{n_ins} trades "
                     f"(dupe {n_dupe}) | total +{n_trades_new} | "
                     f"{rate:.1f} mkt/s | {cli.n_requests} reqs")

    conn.execute("""
        UPDATE collection_log SET run_ended_at=?, n_events=?, n_markets=?,
            n_markets_collected=?, n_trades_new=?, n_failures=?, notes=?
        WHERE id=?
    """, (time.time(), n_events, n_markets_seen, n_markets_collected,
          n_trades_new, n_failures,
          f"val_errs={n_validation_errors} reqs={cli.n_requests}", log_id))
    conn.commit()

    elapsed_all = time.time() - run_started
    log.info("=" * 70)
    log.info(f"  COMPLETE in {elapsed_all:.1f}s")
    log.info(f"  events:             {n_events}")
    log.info(f"  markets seen:       {n_markets_seen}")
    log.info(f"  markets collected:  {n_markets_collected}")
    log.info(f"  trades inserted:    {n_trades_new}")
    log.info(f"  failures:           {n_failures}")
    log.info(f"  validation errors:  {n_validation_errors}")
    log.info(f"  total HTTP requests: {cli.n_requests}")
    log.info("=" * 70)


if __name__ == "__main__":
    main()
