"""
Analyzer for the Kalshi tape archive (kalshi_tape.db).

For every fill in a settled market, compute the taker-side realized PnL
assuming they held to settlement, then bucket by (time-to-close, price,
size, strike_type) to see where winning order flow clusters.

Key columns computed per trade:
  - secs_to_close : (close_time - created_time) in seconds
  - taker_paid    : yes_price if taker_side='yes' else no_price
  - taker_won     : 1 if (taker_side == result) else 0
  - pnl_per_share : (1 - taker_paid) if taker_won else (-taker_paid)
  - pnl_total     : count_fp * pnl_per_share

Honest caveats:
  - This is "if taker held to settlement" PnL. A taker who exited early
    gets a different real outcome. We can't distinguish without auth.
  - At aggregate, systematic patterns should still show through — if
    takers at stage X consistently win big, that's real even if any one
    trader may have flipped the position.
  - 4h of data is still a small window; numbers here may not generalize.

Usage:
  python kalshi_tape_analyzer.py
  python kalshi_tape_analyzer.py --min-volume 500   # only busy markets
  python kalshi_tape_analyzer.py --bot-compare      # also compare to our bot's trades
"""

from __future__ import annotations
import argparse
import sqlite3
import sys
from datetime import datetime
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DB_PATH = "kalshi_tape.db"


def iso_to_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def pnl_expr() -> str:
    """SQL expression for per-share taker PnL."""
    return """
        CASE
          WHEN t.taker_side='yes' AND m.result='yes' THEN 1.0 - t.yes_price
          WHEN t.taker_side='yes' AND m.result='no'  THEN -t.yes_price
          WHEN t.taker_side='no'  AND m.result='no'  THEN 1.0 - t.no_price
          WHEN t.taker_side='no'  AND m.result='yes' THEN -t.no_price
        END
    """


def secs_expr() -> str:
    """SQL expression for secs-to-close. SQLite has no direct ISO8601 diff
    so we use julianday diff * 86400."""
    return """
        (julianday(m.close_time) - julianday(t.created_time)) * 86400.0
    """


def taker_paid_expr() -> str:
    return "CASE WHEN t.taker_side='yes' THEN t.yes_price ELSE t.no_price END"


def pretty_int(n: int | float) -> str:
    return f"{n:,}" if n == int(n) else f"{n:,.2f}"


def print_overall(cur: sqlite3.Cursor) -> None:
    r = cur.execute(f"""
        SELECT
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG({pnl_expr()}) avg_pnl_per_share,
          SUM(t.count_fp * ({pnl_expr()})) total_pnl,
          SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
    """).fetchone()
    print("=" * 70)
    print("OVERALL TAKER STATS (assume held to settlement)")
    print("=" * 70)
    print(f"  fills:           {r['n']:,}")
    print(f"  contracts:       {pretty_int(r['contracts'])}")
    print(f"  taker WR:        {r['wr']*100:.2f}%")
    print(f"  avg PnL/share:   ${r['avg_pnl_per_share']:+.4f}")
    print(f"  total PnL:       ${r['total_pnl']:+,.2f}")
    print()


def print_bucket(title: str, rows: list[sqlite3.Row],
                 bucket_col: str = "bucket") -> None:
    print(f"--- {title} ---")
    header = f"  {'bucket':<22} {'fills':>8} {'contracts':>11} {'wr%':>7} {'pnl/sh':>9} {'pnl/ct':>9} {'total':>12}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for r in rows:
        b = r[bucket_col]
        n = r["n"]
        ct = r["contracts"] or 0
        wr = r["wr"] * 100 if r["wr"] is not None else 0
        pps = r["avg_pnl_per_share"] or 0
        ppc = (r["total_pnl"] / ct) if ct else 0
        tp = r["total_pnl"] or 0
        print(f"  {b:<22} {n:>8,} {ct:>11,.0f} {wr:>6.2f}% "
              f"${pps:>+8.4f} ${ppc:>+8.4f} ${tp:>+11,.2f}")
    print()


def print_buckets_by_time(cur: sqlite3.Cursor) -> None:
    rows = cur.execute(f"""
        SELECT
          CASE
            WHEN {secs_expr()} < 30   THEN '0   <= t < 30s'
            WHEN {secs_expr()} < 60   THEN '30  <= t < 60s'
            WHEN {secs_expr()} < 120  THEN '60  <= t < 120s'
            WHEN {secs_expr()} < 300  THEN '120 <= t < 5m'
            WHEN {secs_expr()} < 600  THEN '5m  <= t < 10m'
            WHEN {secs_expr()} < 1800 THEN '10m <= t < 30m'
            ELSE '30m+'
          END AS bucket,
          MIN({secs_expr()}) mins,
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG({pnl_expr()}) avg_pnl_per_share,
          SUM(t.count_fp * ({pnl_expr()})) total_pnl,
          SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
        GROUP BY bucket
        ORDER BY mins
    """).fetchall()
    print_bucket("BY TIME-TO-CLOSE (where in the life of the market did they buy?)",
                 rows)


def print_buckets_by_price(cur: sqlite3.Cursor) -> None:
    rows = cur.execute(f"""
        SELECT
          CASE
            WHEN {taker_paid_expr()} < 0.05 THEN '[0.00, 0.05)'
            WHEN {taker_paid_expr()} < 0.15 THEN '[0.05, 0.15)'
            WHEN {taker_paid_expr()} < 0.30 THEN '[0.15, 0.30)'
            WHEN {taker_paid_expr()} < 0.50 THEN '[0.30, 0.50)'
            WHEN {taker_paid_expr()} < 0.70 THEN '[0.50, 0.70)'
            WHEN {taker_paid_expr()} < 0.85 THEN '[0.70, 0.85)'
            WHEN {taker_paid_expr()} < 0.95 THEN '[0.85, 0.95)'
            ELSE                                 '[0.95, 1.00]'
          END AS bucket,
          MIN({taker_paid_expr()}) p,
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG({pnl_expr()}) avg_pnl_per_share,
          SUM(t.count_fp * ({pnl_expr()})) total_pnl,
          SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
        GROUP BY bucket
        ORDER BY p
    """).fetchall()
    print_bucket("BY TAKER-PAID PRICE (did they pay cheap or expensive?)",
                 rows)


def print_buckets_by_size(cur: sqlite3.Cursor) -> None:
    rows = cur.execute(f"""
        SELECT
          CASE
            WHEN t.count_fp <  10   THEN '[1, 10)'
            WHEN t.count_fp <  50   THEN '[10, 50)'
            WHEN t.count_fp <  200  THEN '[50, 200)'
            WHEN t.count_fp <  1000 THEN '[200, 1000)'
            ELSE                         '[1000+]'
          END AS bucket,
          MIN(t.count_fp) s,
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG({pnl_expr()}) avg_pnl_per_share,
          SUM(t.count_fp * ({pnl_expr()})) total_pnl,
          SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
        GROUP BY bucket
        ORDER BY s
    """).fetchall()
    print_bucket("BY FILL SIZE (do big takers win more than small?)", rows)


def print_buckets_by_time_x_price(cur: sqlite3.Cursor) -> None:
    # Cross-tab: time bucket × price bucket
    rows = cur.execute(f"""
        SELECT
          CASE
            WHEN {secs_expr()} < 60   THEN '01_<60s'
            WHEN {secs_expr()} < 300  THEN '02_<5m'
            WHEN {secs_expr()} < 1800 THEN '03_<30m'
            ELSE                             '04_30m+'
          END AS t_bucket,
          CASE
            WHEN {taker_paid_expr()} < 0.30 THEN 'A_<0.30'
            WHEN {taker_paid_expr()} < 0.70 THEN 'B_0.30-0.70'
            WHEN {taker_paid_expr()} < 0.95 THEN 'C_0.70-0.95'
            ELSE                                 'D_>=0.95'
          END AS p_bucket,
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG({pnl_expr()}) avg_pnl_per_share,
          SUM(t.count_fp * ({pnl_expr()})) total_pnl,
          SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
        GROUP BY t_bucket, p_bucket
        ORDER BY t_bucket, p_bucket
    """).fetchall()
    print("--- TIME x PRICE CROSS-TAB (where does edge live?) ---")
    print(f"  {'t_bucket':<10} {'p_bucket':<14} {'fills':>7} {'contracts':>10} {'wr%':>7} {'pnl/sh':>9} {'total':>12}")
    print("  " + "-" * 76)
    for r in rows:
        wr = r["wr"] * 100 if r["wr"] is not None else 0
        print(f"  {r['t_bucket']:<10} {r['p_bucket']:<14} {r['n']:>7,} "
              f"{r['contracts']:>10,.0f} {wr:>6.2f}% "
              f"${r['avg_pnl_per_share']:>+8.4f} "
              f"${r['total_pnl']:>+11,.2f}")
    print()


def print_strike_type_breakdown(cur: sqlite3.Cursor) -> None:
    rows = cur.execute(f"""
        SELECT
          m.strike_type AS bucket,
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG({pnl_expr()}) avg_pnl_per_share,
          SUM(t.count_fp * ({pnl_expr()})) total_pnl,
          SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
        GROUP BY bucket ORDER BY bucket
    """).fetchall()
    print_bucket("BY STRIKE TYPE (greater vs between)", rows)


def print_taker_side_by_result(cur: sqlite3.Cursor) -> None:
    """Cross-check: taker_side × market result. If market settled YES,
    does YES-taker win in aggregate, and does NO-taker lose?"""
    rows = cur.execute(f"""
        SELECT
          t.taker_side || ' -> ' || m.result AS bucket,
          COUNT(*) n,
          SUM(t.count_fp) contracts,
          AVG({pnl_expr()}) avg_pnl_per_share,
          SUM(t.count_fp * ({pnl_expr()})) total_pnl,
          SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
        GROUP BY bucket ORDER BY bucket
    """).fetchall()
    print_bucket("TAKER SIDE x MARKET RESULT (sanity check + directional split)", rows)


def compare_to_bot(tape_cur: sqlite3.Cursor) -> None:
    """For each stage/conviction bucket our bot used, find the analogous
    tape bucket and compare. The bot keyed by (stage in prime/late/wide)
    which corresponds roughly to secs_to_close (<=120, <=300, <=600) and
    conviction (weak/medium/strong) mapped to distance from strike."""
    import os
    bot_db = "kalshi_snipe.db"
    if not os.path.exists(bot_db):
        print("(kalshi_snipe.db not found — skipping bot comparison)")
        return
    bot_conn = sqlite3.connect(bot_db)
    bot_conn.row_factory = sqlite3.Row
    bc = bot_conn.cursor()

    print("=" * 70)
    print("BOT vs TAPE — does our sniping beat the crowd?")
    print("=" * 70)
    # bot data
    bot_rows = bc.execute("""
        SELECT model_name,
               COUNT(*) n,
               SUM(CASE WHEN (side='YES' AND outcome=1) OR (side='NO' AND outcome=0) THEN 1 ELSE 0 END) wins,
               SUM(pnl) total_pnl,
               AVG(pnl/shares) avg_pnl_per_share
        FROM live_trades WHERE window_id LIKE 'kalshi-snipe-%'
        GROUP BY model_name ORDER BY model_name
    """).fetchall()
    print("  Bot's 13 paper trades (repaired DB):")
    print(f"  {'bucket':<25} {'n':>4} {'wr%':>7} {'pnl/sh':>9} {'total':>8}")
    print("  " + "-" * 55)
    total_n = 0; total_w = 0; total_pnl = 0.0
    for r in bot_rows:
        wr = r["wins"] / r["n"] * 100 if r["n"] else 0
        print(f"  {r['model_name']:<25} {r['n']:>4} {wr:>6.1f}% ${r['avg_pnl_per_share'] or 0:>+8.4f} ${r['total_pnl']:>+7.2f}")
        total_n += r["n"]; total_w += r["wins"]; total_pnl += r["total_pnl"]
    print(f"  TOTAL                     {total_n:>4} {total_w/total_n*100:>6.1f}% "
          f"${total_pnl/total_n:>+8.4f} ${total_pnl:>+7.2f}")

    # Analogous tape buckets
    # prime == secs_to_close <= 120
    # late  == secs_to_close in (120, 300]
    # wide  == secs_to_close in (300, 600]
    stages = [
        ("prime (<=120s)", 0, 120),
        ("late  (120-300s)", 120, 300),
        ("wide  (300-600s)", 300, 600),
    ]
    print("\n  Same time-to-close windows on the FULL tape (all takers):")
    print(f"  {'bucket':<25} {'fills':>7} {'wr%':>7} {'pnl/sh':>9} {'total':>10}")
    print("  " + "-" * 63)
    for name, lo, hi in stages:
        r = tape_cur.execute(f"""
            SELECT
              COUNT(*) n,
              SUM(t.count_fp) contracts,
              AVG({pnl_expr()}) avg_pnl_per_share,
              SUM(t.count_fp * ({pnl_expr()})) total_pnl,
              SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
            FROM trades t JOIN markets m ON t.ticker = m.ticker
            WHERE m.tape_collected_at IS NOT NULL
              AND {secs_expr()} BETWEEN {lo} AND {hi}
        """).fetchone()
        wr = (r["wr"] or 0) * 100
        pps = r["avg_pnl_per_share"] or 0
        tp = r["total_pnl"] or 0
        print(f"  {name:<25} {r['n']:>7,} {wr:>6.2f}% "
              f"${pps:>+8.4f} ${tp:>+9,.2f}")

    # Also bot's typical price range (0.55-0.95 per config)
    r = tape_cur.execute(f"""
        SELECT COUNT(*) n, AVG({pnl_expr()}) avg_pnl_per_share,
               SUM(CASE WHEN ({pnl_expr()}) > 0 THEN 1 ELSE 0 END)*1.0/COUNT(*) wr
        FROM trades t JOIN markets m ON t.ticker = m.ticker
        WHERE m.tape_collected_at IS NOT NULL
          AND {taker_paid_expr()} BETWEEN 0.55 AND 0.95
          AND {secs_expr()} BETWEEN 0 AND 600
    """).fetchone()
    print(f"\n  Tape baseline in bot's entry zone (price 0.55-0.95, time 0-600s):")
    print(f"    fills={r['n']:,}  wr={(r['wr'] or 0)*100:.2f}%  "
          f"avg_pnl/share=${r['avg_pnl_per_share'] or 0:+.4f}")
    print()
    bot_conn.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--bot-compare", action="store_true",
                    help="Also print comparison to kalshi_snipe.db")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    n = cur.execute("SELECT COUNT(*) FROM trades").fetchone()[0]
    m = cur.execute("SELECT COUNT(*) FROM markets WHERE tape_collected_at IS NOT NULL").fetchone()[0]
    if not n or not m:
        print(f"No data in {args.db}. Run kalshi_tape_collector.py first.")
        return

    print(f"Archive: {args.db}  ({n:,} trades across {m} settled markets)\n")

    print_overall(cur)
    print_taker_side_by_result(cur)
    print_buckets_by_time(cur)
    print_buckets_by_price(cur)
    print_buckets_by_size(cur)
    print_strike_type_breakdown(cur)
    print_buckets_by_time_x_price(cur)

    if args.bot_compare:
        compare_to_bot(cur)


if __name__ == "__main__":
    main()
