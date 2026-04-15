"""
Snipe Trader v3 — Bonereaper-inspired, ML-free, pure sniping.

Core thesis: Polymarket liquidity lags spot. When BTC/ETH moves decisively,
the winning side is often still priced cheaply enough to buy for near-
guaranteed profit. No predictor needed — just watch spot and the book.

Three snipe stages per window:
  1. PRE-CLOSE  (T-60s to T-15s): spot has moved clearly, winner < $0.80
  2. AT-CLOSE   (T-10s to T+10s): outcome basically decided, winner < $0.90
  3. POST-CLOSE (T+10s to T+90s): extremely stale, winner < $0.95

Sizing scales with conviction (spot move magnitude):
  - Weak   (0.05-0.15% move): $1 (min bet)
  - Medium (0.15-0.30% move): 5% of bankroll
  - Strong (>0.30% move)    : 15% of bankroll

Markets: BTC/ETH × 5m/15m (4 parallel).

Usage:
    python snipe_trader.py                         # Run unlimited
    python snipe_trader.py --hours 4               # Run 4 hours
    python snipe_trader.py --bankroll 50           # Start with $50
    python snipe_trader.py --assets btc --no-15m   # BTC 5m only
"""

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import requests

from db import (init_db, get_db, save_live_trade, resolve_trade, log_event)
from live_trader import (
    PolymarketFeed, PendingTrade, ASSETS, TIMEFRAMES, WINDOW_BASE_EPOCH,
    WINDOW_5M, WINDOW_15M,
)
from signals import compute_fee

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(os.path.dirname(__file__), "snipe_trader.log")),
    ],
)
log = logging.getLogger("snipe_trader")


# ============================================================
# Config
# ============================================================

@dataclass
class SnipeConfig:
    # --- Spot move thresholds (absolute %) ---
    move_weak: float = 0.0005      # 0.05% — minimum signal to fire
    move_medium: float = 0.0015    # 0.15% — size up
    move_strong: float = 0.0030    # 0.30% — max conviction

    # --- Sizing (fraction of bankroll, except weak which is flat $) ---
    size_weak_flat: float = 1.0
    size_medium_pct: float = 0.05
    size_strong_pct: float = 0.15
    size_cap_pct: float = 0.25     # never risk >25% on a single snipe

    # --- Winner price gates per stage ---
    gate_pre_close: float = 0.80
    gate_at_close: float = 0.90
    gate_post_close: float = 0.95
    gate_min: float = 0.50          # below this, market already resolved it

    # --- Stage timing (seconds relative to window close) ---
    pre_close_from: int = -60        # 60s before close
    pre_close_to: int = -15          # until 15s before close
    at_close_from: int = -10         # 10s before close
    at_close_to: int = 10            # to 10s after close
    post_close_from: int = 10        # 10s after close
    post_close_to: int = 90          # to 90s after close

    # --- Polling ---
    poll_interval: int = 5           # seconds between window scans

    # --- Bankroll / risk ---
    initial_bankroll: float = 20.0
    min_bankroll: float = 0.50
    min_bet: float = 1.0
    fee_rate: float = 0.072

    # --- Resolution deadline (s after window close) ---
    resolution_deadline_s: int = 900  # 15 min


# ============================================================
# Snipe Hunter
# ============================================================

class SnipeHunter:
    """
    Scans active (asset, timeframe) windows. When a stage fires with
    enough spot-move conviction AND the winner is still cheap enough,
    buys the winner. Non-blocking async resolution for pending trades.
    """

    def __init__(
        self,
        config: SnipeConfig,
        db_path: str,
        assets: List[str],
        timeframes: List[str],
    ):
        self.config = config
        self.db_path = db_path
        self.assets = assets
        self.timeframes = timeframes
        self.feed = PolymarketFeed()

        self.bankroll = config.initial_bankroll
        self.peak_bankroll = config.initial_bankroll

        # Dedup: (asset, tf, epoch, stage) — each combo can fire at most once
        self.fired: Set[Tuple[str, str, int, str]] = set()

        self.pending: List[PendingTrade] = []

        # External stop signal (set by GUI or embedding code to request a
        # graceful shutdown). If True, the main loop breaks on its next iter.
        self.should_stop: bool = False
        # Pause flag — when True, scan_all is skipped (no new snipes) but
        # pending resolution continues. Resets to False to resume.
        self.paused: bool = False
        # Max seconds to spend draining pending trades on stop (overridable).
        self.drain_timeout_s: int = 900

        # In-memory ring buffer of recent trade events, consumed by GUIs.
        # Each entry: dict with keys ts, kind ("FIRE"/"WIN"/"LOSS"/"DROP"),
        # stage, market, side, price, pnl, bankroll, conviction, move_pct.
        self.events: List[dict] = []
        self._events_cap = 200

        # Stats
        self.total_snipes = 0
        self.total_wins = 0
        self.total_pnl = 0.0
        self.total_fees = 0.0
        self.bust_count = 0

        # Per-stage + per-market + per-conviction stats
        self.stage_stats: Dict[str, Dict[str, float]] = {
            s: {"trades": 0, "wins": 0, "pnl": 0.0}
            for s in ("pre_close", "at_close", "post_close")
        }
        self.market_stats: Dict[str, Dict[str, float]] = {}
        self.conviction_stats: Dict[str, Dict[str, float]] = {
            c: {"trades": 0, "wins": 0, "pnl": 0.0}
            for c in ("weak", "medium", "strong")
        }

    # --------------------------------------------------------
    # Spot price at a specific epoch (for move calculation)
    # --------------------------------------------------------

    def get_spot_at_epoch(self, asset: str, epoch_ts: int) -> float:
        """
        Approximate spot price at a given UTC epoch using Binance 1-min klines.
        Returns the OPEN of the 1-min candle starting at epoch_ts.
        """
        meta = ASSETS[asset]
        try:
            r = self.feed.session.get(
                f"{self.feed.BINANCE_US}/klines",
                params={
                    "symbol": meta["symbol"],
                    "interval": "1m",
                    "startTime": epoch_ts * 1000,
                    "limit": 1,
                },
                timeout=8,
            )
            if r.ok:
                data = r.json()
                if data:
                    return float(data[0][1])  # open
        except Exception:
            pass
        return 0.0

    def get_window_move(
        self, asset: str, tf: str, epoch: int, now_price: float
    ) -> Optional[float]:
        """Compute spot move % from window open to now. None if unavailable."""
        open_price = self.get_spot_at_epoch(asset, epoch)
        if open_price <= 0 or now_price <= 0:
            return None
        return (now_price - open_price) / open_price

    # --------------------------------------------------------
    # Stage detection
    # --------------------------------------------------------

    def detect_stage(self, secs_to_close: int) -> Optional[str]:
        """Return the snipe stage for this moment, or None."""
        cfg = self.config
        # secs_to_close: positive = before close, negative = after close
        # We stored close_from/to as negative=pre-close, positive=post-close
        secs_from_close = -secs_to_close  # flip sign: negative = before, positive = after

        if cfg.pre_close_from <= secs_from_close <= cfg.pre_close_to:
            return "pre_close"
        if cfg.at_close_from <= secs_from_close <= cfg.at_close_to:
            return "at_close"
        if cfg.post_close_from <= secs_from_close <= cfg.post_close_to:
            return "post_close"
        return None

    # --------------------------------------------------------
    # Scan all windows, fire any eligible snipes
    # --------------------------------------------------------

    def scan_all(self):
        for asset in self.assets:
            for tf in self.timeframes:
                try:
                    self.scan_one(asset, tf)
                except Exception as e:
                    log.warning(f"scan_one({asset}, {tf}) error: {e}")

    def scan_one(self, asset: str, tf: str):
        now = int(time.time())
        duration = TIMEFRAMES[tf]["duration"]

        # The window we want to evaluate is EITHER the currently in-progress
        # one (for pre_close stage) or the just-closed one (for at/post).
        active_epoch = self.feed.get_window_epoch(tf, now)
        active_end = active_epoch + duration
        secs_to_close_active = active_end - now

        # Candidate list: always the active window; plus the previous one
        # if we're within the post_close window of it.
        candidates: List[Tuple[int, int]] = [(active_epoch, secs_to_close_active)]
        prev_epoch = active_epoch - duration
        prev_end = prev_epoch + duration
        secs_to_close_prev = prev_end - now
        if -secs_to_close_prev <= self.config.post_close_to:
            candidates.append((prev_epoch, secs_to_close_prev))

        for epoch, secs_to_close in candidates:
            stage = self.detect_stage(secs_to_close)
            if stage is None:
                continue
            key = (asset, tf, epoch, stage)
            if key in self.fired:
                continue
            self.try_fire(asset, tf, epoch, stage)

    def try_fire(self, asset: str, tf: str, epoch: int, stage: str):
        """Evaluate one (asset, tf, epoch, stage) and fire if criteria met."""
        cfg = self.config

        if self.bankroll < cfg.min_bet:
            return

        # 1. Get current spot + spot move since window open
        now_price = self.feed.get_price(asset)
        if now_price <= 0:
            return
        move_pct = self.get_window_move(asset, tf, epoch, now_price)
        if move_pct is None:
            return
        abs_move = abs(move_pct)
        if abs_move < cfg.move_weak:
            return

        # 2. Direction = whichever way spot moved
        direction = "UP" if move_pct > 0 else "DOWN"
        side = "YES" if direction == "UP" else "NO"

        # 3. Get Polymarket data
        mkt = self.feed.get_market_data(epoch, asset, tf)
        if not mkt:
            return
        if mkt.get("closed"):
            return  # already resolved

        winner_price = mkt["up_price"] if direction == "UP" else mkt["down_price"]

        # 4. Price gate per stage
        gate = {
            "pre_close": cfg.gate_pre_close,
            "at_close": cfg.gate_at_close,
            "post_close": cfg.gate_post_close,
        }[stage]
        if winner_price > gate or winner_price < cfg.gate_min:
            return

        # 5. Conviction + sizing
        if abs_move >= cfg.move_strong:
            conviction = "strong"
            size = self.bankroll * cfg.size_strong_pct
        elif abs_move >= cfg.move_medium:
            conviction = "medium"
            size = self.bankroll * cfg.size_medium_pct
        else:
            conviction = "weak"
            size = cfg.size_weak_flat

        # Enforce min and cap
        size = max(size, cfg.min_bet)
        size = min(size, self.bankroll * cfg.size_cap_pct, self.bankroll - 0.01)
        if size < cfg.min_bet:
            return

        # 6. Compute cost + shares
        fee_per = compute_fee(winner_price, cfg.fee_rate)
        cost_per = winner_price + fee_per
        shares = size / cost_per
        cost_dollars = shares * cost_per
        if cost_dollars > self.bankroll:
            return

        # 7. Commit & queue
        self.bankroll -= cost_dollars
        self.total_fees += fee_per * shares
        self.total_snipes += 1

        window_id = f"snipe-v3-{stage}-{asset}-{tf}-{epoch}"
        pending = PendingTrade(
            window_id=window_id,
            epoch=epoch,
            asset=asset,
            timeframe=tf,
            window=None,
            side=side,
            direction=direction,
            model_name=f"snipe_{stage}_{conviction}",
            model_prob=1.0,
            market_prob=winner_price,
            edge=1.0 - winner_price,
            entry_price=winner_price,
            fee=fee_per * shares,
            shares=shares,
            total_cost=cost_per,
            trade_type="snipe",
        )
        self.pending.append(pending)
        self.fired.add((asset, tf, epoch, stage))

        market_key = f"{asset}-{tf}"
        self.market_stats.setdefault(market_key, {"trades": 0, "wins": 0, "pnl": 0.0})

        log.info(
            f"  [{stage.upper()} {market_key}] BOUGHT {direction} @ {winner_price:.3f} | "
            f"${cost_dollars:.2f} ({conviction}, spot {move_pct*100:+.2f}%) | "
            f"bank(committed)=${self.bankroll:.2f}"
        )
        self._push_event({
            "ts": time.time(), "kind": "FIRE", "stage": stage, "market": market_key,
            "side": side, "direction": direction, "price": winner_price,
            "size": cost_dollars, "conviction": conviction, "move_pct": move_pct,
            "pnl": 0.0, "bankroll": self.bankroll,
        })

        with get_db(self.db_path) as conn:
            save_live_trade(
                conn, window_id, side, f"snipe_{stage}_{conviction}",
                1.0, winner_price, 1.0 - winner_price, winner_price,
                fee_per * shares, shares, self.bankroll,
            )

    # --------------------------------------------------------
    # Non-blocking resolution
    # --------------------------------------------------------

    def resolve_pending(self):
        """Try to resolve every pending trade. Non-blocking."""
        if not self.pending:
            return

        now = time.time()
        remaining: List[PendingTrade] = []
        for p in self.pending:
            duration = TIMEFRAMES[p.timeframe]["duration"]
            # Don't poll until window has closed
            if now < p.epoch + duration - 2:
                remaining.append(p)
                continue

            outcome = self.feed.check_result(p.epoch, p.asset, p.timeframe)
            if outcome == -1:
                # Drop after deadline
                if now > p.epoch + duration + self.config.resolution_deadline_s:
                    loss = -p.shares * p.total_cost
                    self.total_pnl += loss
                    log.warning(
                        f"  DROPPED {p.asset}-{p.timeframe} {p.direction} — "
                        f"Polymarket failed to resolve within "
                        f"{self.config.resolution_deadline_s}s"
                    )
                    with get_db(self.db_path) as conn:
                        resolve_trade(conn, p.window_id, -1, loss, self.bankroll)
                        log_event(conn, f"DROPPED: {p.window_id}")
                    continue
                remaining.append(p)
                continue

            self.settle_trade(p, outcome)

        self.pending = remaining

    def settle_trade(self, p: PendingTrade, outcome: int):
        won = ((p.side == "YES" and outcome == 1) or
               (p.side == "NO" and outcome == 0))
        payout = p.shares * 1.0 if won else 0.0
        committed_cost = p.shares * p.total_cost
        pnl = payout - committed_cost
        self.bankroll += payout
        self.peak_bankroll = max(self.peak_bankroll, self.bankroll)

        self.total_pnl += pnl
        if won:
            self.total_wins += 1

        # Parse stage and conviction from model_name: "snipe_{stage}_{conviction}"
        parts = p.model_name.split("_", 2)
        stage = parts[1] if len(parts) > 1 else "unknown"
        # conviction may contain underscore if we add more, but currently one word
        # model_name is "snipe_pre_close_weak" — split differently
        # Let's just infer conviction by searching
        conviction = "weak"
        for c in ("strong", "medium", "weak"):
            if c in p.model_name:
                conviction = c
                break
        # Re-infer stage from window_id: "snipe-v3-{stage}-{asset}-{tf}-{epoch}"
        if p.window_id.startswith("snipe-v3-"):
            rest = p.window_id[len("snipe-v3-"):]
            for s in ("pre_close", "at_close", "post_close"):
                if rest.startswith(s + "-"):
                    stage = s
                    break

        stats = self.stage_stats.get(stage)
        if stats:
            stats["trades"] += 1
            if won:
                stats["wins"] += 1
            stats["pnl"] += pnl

        cstat = self.conviction_stats.get(conviction)
        if cstat:
            cstat["trades"] += 1
            if won:
                cstat["wins"] += 1
            cstat["pnl"] += pnl

        market_key = f"{p.asset}-{p.timeframe}"
        mstat = self.market_stats.setdefault(
            market_key, {"trades": 0, "wins": 0, "pnl": 0.0}
        )
        mstat["trades"] += 1
        if won:
            mstat["wins"] += 1
        mstat["pnl"] += pnl

        wr = (self.total_wins / self.total_snipes * 100) if self.total_snipes else 0
        tag = "WIN " if won else "LOSS"
        log.info(
            f"  [{stage.upper()} {market_key}] {tag} {p.direction} @ "
            f"{p.entry_price:.3f} | PnL ${pnl:+.2f} | Bank ${self.bankroll:.2f} | "
            f"WR {wr:.1f}% [{self.total_wins}W/{self.total_snipes - self.total_wins}L]"
        )
        self._push_event({
            "ts": time.time(), "kind": "WIN" if won else "LOSS",
            "stage": stage, "market": market_key, "side": p.side,
            "direction": p.direction, "price": p.entry_price,
            "size": p.shares * p.total_cost, "conviction": conviction,
            "move_pct": None, "pnl": pnl, "bankroll": self.bankroll,
        })

        with get_db(self.db_path) as conn:
            resolve_trade(conn, p.window_id, outcome, pnl, self.bankroll)

    def _push_event(self, ev: dict):
        """Append a trade event to the bounded in-memory ring buffer."""
        self.events.append(ev)
        if len(self.events) > self._events_cap:
            self.events = self.events[-self._events_cap:]

    # --------------------------------------------------------
    # Main loop
    # --------------------------------------------------------

    def run(self, max_hours: Optional[float] = None):
        init_db(self.db_path)

        btc = self.feed.get_price("btc") if "btc" in self.assets else 0.0
        eth = self.feed.get_price("eth") if "eth" in self.assets else 0.0

        with get_db(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO session_stats
                (session_start, last_update, bankroll, peak_bankroll, config_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    time.time(), time.time(), self.bankroll, self.bankroll,
                    json.dumps({
                        "mode": "snipe_v3",
                        "assets": self.assets,
                        "timeframes": self.timeframes,
                        "btc_start": btc,
                        "eth_start": eth,
                    }),
                ),
            )
            log_event(conn, f"Snipe trader v3 started: {self.assets} x {self.timeframes}")

        start_time = time.time()
        last_stage_check = 0.0

        log.info("")
        log.info("=" * 70)
        log.info("  SATRIALES SNIPE TRADER v3")
        log.info("  Bonereaper-inspired: no ML, 3-stage sniping, conviction sizing")
        log.info("=" * 70)
        log.info(f"  Assets:        {', '.join(ASSETS[a]['short'] for a in self.assets)}")
        log.info(f"  Timeframes:    {', '.join(self.timeframes)}")
        log.info(f"  Bankroll:      ${self.bankroll:.2f}")
        log.info(f"  BTC:           ${btc:,.2f}")
        if eth:
            log.info(f"  ETH:           ${eth:,.2f}")
        log.info(f"  Stages:        pre-close ({self.config.pre_close_from}..{self.config.pre_close_to}s), "
                 f"at-close ({self.config.at_close_from}..{self.config.at_close_to}s), "
                 f"post-close ({self.config.post_close_from}..{self.config.post_close_to}s)")
        log.info(f"  Price gates:   pre<{self.config.gate_pre_close:.2f}, "
                 f"at<{self.config.gate_at_close:.2f}, post<{self.config.gate_post_close:.2f}")
        log.info(f"  Move levels:   weak>{self.config.move_weak*100:.2f}%, "
                 f"medium>{self.config.move_medium*100:.2f}%, "
                 f"strong>{self.config.move_strong*100:.2f}%")
        log.info(f"  Size (pct):    weak=${self.config.size_weak_flat:.0f}, "
                 f"medium={self.config.size_medium_pct:.0%}, "
                 f"strong={self.config.size_strong_pct:.0%}, "
                 f"cap={self.config.size_cap_pct:.0%}")
        log.info(f"  Max hours:     {max_hours or 'unlimited'}")
        log.info("=" * 70)

        last_summary_ts = start_time

        try:
            while True:
                if self.should_stop:
                    log.info("Stop signal received; exiting main loop")
                    break
                if max_hours and (time.time() - start_time) / 3600 > max_hours:
                    log.info(f"Time limit reached ({max_hours}h)")
                    break

                # Bust check
                if self.bankroll < self.config.min_bankroll and not self.pending:
                    self.bust_count += 1
                    log.warning(f"BUST #{self.bust_count}! Bank: ${self.bankroll:.2f}")
                    with get_db(self.db_path) as conn:
                        log_event(conn, f"BUST #{self.bust_count}")
                    self.bankroll = self.config.initial_bankroll
                    self.peak_bankroll = self.config.initial_bankroll

                # Scan for opportunities (unless paused)
                if not self.paused:
                    self.scan_all()

                # Resolve pending (non-blocking)
                self.resolve_pending()

                # Garbage-collect the fired set: drop entries whose window is
                # more than 1 hour old, to keep memory bounded.
                cutoff = int(time.time()) - 3600
                self.fired = {k for k in self.fired if k[2] > cutoff}

                # Periodic session stat flush
                with get_db(self.db_path) as conn:
                    dd_pct = (
                        (self.peak_bankroll - self.bankroll) / self.peak_bankroll
                        if self.peak_bankroll > 0 else 0
                    )
                    conn.execute(
                        """
                        UPDATE session_stats SET
                            last_update = ?, trades_executed = ?, trades_won = ?,
                            total_pnl = ?, total_fees = ?,
                            bankroll = ?, peak_bankroll = ?,
                            max_drawdown_pct = ?
                        WHERE id = (SELECT MAX(id) FROM session_stats)
                        """,
                        (
                            time.time(), self.total_snipes, self.total_wins,
                            self.total_pnl, self.total_fees,
                            self.bankroll, self.peak_bankroll, dd_pct,
                        ),
                    )

                # Summary every 5 min
                if time.time() - last_summary_ts > 300:
                    self._print_summary(start_time)
                    last_summary_ts = time.time()

                time.sleep(self.config.poll_interval)

        except KeyboardInterrupt:
            log.info("\nStopped by user")

        # Drain pending before exit (configurable timeout for GUI shutdown)
        drain_timeout = self.drain_timeout_s
        log.info(f"\nDraining {len(self.pending)} pending snipes (up to {drain_timeout}s)...")
        drain_deadline = time.time() + drain_timeout
        while self.pending and time.time() < drain_deadline and not self.should_stop:
            self.resolve_pending()
            if self.pending:
                time.sleep(min(15, drain_timeout // 4 or 1))

        self._print_summary(start_time, final=True)

        with get_db(self.db_path) as conn:
            log_event(conn, f"Stopped: {self.total_snipes} snipes, ${self.total_pnl:+.2f}")

    def _print_summary(self, start_time: float, final: bool = False):
        elapsed_h = (time.time() - start_time) / 3600
        wr = (self.total_wins / self.total_snipes * 100) if self.total_snipes else 0
        dd = (
            (self.peak_bankroll - self.bankroll) / self.peak_bankroll * 100
            if self.peak_bankroll > 0 else 0
        )
        header = "FINAL SUMMARY" if final else "SUMMARY"
        log.info(f"\n  --- {header} ({elapsed_h:.2f}h) ---")
        log.info(
            f"  Snipes: {self.total_snipes} | WR: {wr:.1f}% | PnL: ${self.total_pnl:+.2f} | "
            f"Fees: ${self.total_fees:.2f}"
        )
        log.info(
            f"  Bankroll: ${self.bankroll:.2f} | Peak: ${self.peak_bankroll:.2f} | "
            f"DD: {dd:.1f}% | Pending: {len(self.pending)}"
        )

        if self.total_snipes > 0:
            log.info("  By stage:")
            for s, stats in self.stage_stats.items():
                t = int(stats["trades"])
                if t:
                    w = int(stats["wins"])
                    p = float(stats["pnl"])
                    log.info(f"    {s:12s}: {t:3d} trades, {w/t*100:5.1f}% WR, ${p:+.2f}")

            log.info("  By conviction:")
            for c, stats in self.conviction_stats.items():
                t = int(stats["trades"])
                if t:
                    w = int(stats["wins"])
                    p = float(stats["pnl"])
                    log.info(f"    {c:12s}: {t:3d} trades, {w/t*100:5.1f}% WR, ${p:+.2f}")

            log.info("  By market:")
            for k, stats in sorted(self.market_stats.items()):
                t = int(stats["trades"])
                if t:
                    w = int(stats["wins"])
                    p = float(stats["pnl"])
                    log.info(f"    {k:12s}: {t:3d} trades, {w/t*100:5.1f}% WR, ${p:+.2f}")


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Satriales Snipe Trader v3")
    parser.add_argument("--hours", type=float, default=None,
                        help="Max hours to run (default: unlimited)")
    parser.add_argument("--assets", type=str, default="btc,eth",
                        help="Comma-separated assets: btc,eth (default: btc,eth)")
    parser.add_argument("--timeframes", type=str, default="5m,15m",
                        help="Comma-separated timeframes: 5m,15m (default: 5m,15m)")
    parser.add_argument("--no-15m", action="store_true", help="Disable 15m timeframe")
    parser.add_argument("--bankroll", type=float, default=20.0,
                        help="Starting bankroll (default: 20)")
    parser.add_argument("--db", type=str, default="snipe.db",
                        help="Database file (default: snipe.db)")
    parser.add_argument("--poll", type=int, default=5,
                        help="Poll interval in seconds (default: 5)")
    args = parser.parse_args()

    assets = [a.strip().lower() for a in args.assets.split(",") if a.strip()]
    unknown = [a for a in assets if a not in ASSETS]
    if unknown:
        sys.exit(f"Unknown asset(s): {unknown}. Available: {list(ASSETS.keys())}")

    timeframes = [t.strip().lower() for t in args.timeframes.split(",") if t.strip()]
    if args.no_15m and "15m" in timeframes:
        timeframes.remove("15m")
    unknown_tf = [t for t in timeframes if t not in TIMEFRAMES]
    if unknown_tf:
        sys.exit(f"Unknown timeframe(s): {unknown_tf}. Available: {list(TIMEFRAMES.keys())}")

    config = SnipeConfig(initial_bankroll=args.bankroll, poll_interval=args.poll)
    db_path = os.path.join(os.path.dirname(__file__), args.db)
    hunter = SnipeHunter(config, db_path, assets, timeframes)
    hunter.run(max_hours=args.hours)


if __name__ == "__main__":
    main()
