"""
Real-Time Paper Trader — Polymarket BTC Up/Down 5-Minute Markets.

Connects to live Polymarket markets:
  https://polymarket.com/event/btc-updown-5m-{epoch}

Each window: "Will BTC go UP or DOWN in the next 5 minutes?"
  - UP = BTC price at close >= price at open
  - DOWN = BTC price at close < price at open

Polls real market prices from Polymarket Gamma API + BTC from Binance US.
Makes paper trade decisions at ~40s before close using trained ML models.
Stores everything in SQLite for dashboard analysis.

Usage:
    python live_trader.py              # Run until stopped (Ctrl+C)
    python live_trader.py --hours 8    # Run for 8 hours
"""

import argparse
import json
import logging
import os
import sys
import time
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests
from scipy.stats import norm

from config import Config
from data import MarketWindow, generate_synthetic_data
from db import (init_db, get_db, save_market_window, save_live_trade,
                resolve_trade, log_event)
from features import compute_features, build_feature_matrix
from models import EnsembleModel, LogisticModel, GradientBoostingModel, MeanReversionModel
from signals import generate_signal

warnings.filterwarnings("ignore", category=RuntimeWarning)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(os.path.dirname(__file__), "live_trader.log")),
    ],
)
log = logging.getLogger("live_trader")

# Base epoch for the 5-min window series (known reference point)
WINDOW_BASE_EPOCH = 1776096000
WINDOW_DURATION = 300  # 5 minutes


# ============================================================
# Market Data Feeds
# ============================================================

class PolymarketFeed:
    """Fetches real-time data from Polymarket and Binance US."""

    GAMMA_URL = "https://gamma-api.polymarket.com"
    CLOB_URL = "https://clob.polymarket.com"
    BINANCE_US = "https://api.binance.us/api/v3"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "Satriales/1.0"
        self.last_btc_price = None

    def get_window_epoch(self) -> int:
        """Get the epoch for the currently active 5-minute window."""
        now = int(time.time())
        offset = ((now - WINDOW_BASE_EPOCH) // WINDOW_DURATION) * WINDOW_DURATION
        return WINDOW_BASE_EPOCH + offset

    def get_next_window_epoch(self) -> int:
        """Get the epoch for the next upcoming window."""
        return self.get_window_epoch() + WINDOW_DURATION

    def seconds_into_window(self) -> int:
        """How many seconds into the current window are we?"""
        return int(time.time()) - self.get_window_epoch()

    def seconds_until_next_window(self) -> int:
        """Seconds until the next window starts."""
        return WINDOW_DURATION - self.seconds_into_window()

    def get_market_data(self, epoch: int) -> dict:
        """Fetch market data for a specific window epoch from Gamma API."""
        slug = f"btc-updown-5m-{epoch}"
        try:
            r = self.session.get(
                f"{self.GAMMA_URL}/events",
                params={"slug": slug}, timeout=12
            )
            if r.ok:
                events = r.json()
                if events:
                    mkt = events[0].get("markets", [{}])[0]
                    prices = mkt.get("outcomePrices", ["0.5", "0.5"])
                    if isinstance(prices, str):
                        prices = json.loads(prices)
                    up_price = float(prices[0])
                    down_price = float(prices[1])
                    closed = mkt.get("closed", False)

                    # Parse token IDs
                    tokens = mkt.get("clobTokenIds", [])
                    if isinstance(tokens, str):
                        tokens = json.loads(tokens)

                    return {
                        "slug": slug,
                        "up_price": up_price,
                        "down_price": down_price,
                        "closed": closed,
                        "question": mkt.get("question", ""),
                        "tokens": tokens,
                        "active": mkt.get("active", False),
                    }
        except Exception as e:
            log.warning(f"Gamma API error: {e}")
        return None

    def get_orderbook(self, token_id: str) -> dict:
        """Get orderbook snapshot for a token."""
        try:
            r = self.session.get(
                f"{self.CLOB_URL}/book",
                params={"token_id": token_id}, timeout=10
            )
            if r.ok:
                book = r.json()
                bids = book.get("bids", [])
                asks = book.get("asks", [])
                best_bid = float(bids[0]["price"]) if bids else 0.0
                best_ask = float(asks[0]["price"]) if asks else 1.0
                bid_size = float(bids[0]["size"]) if bids else 0.0
                ask_size = float(asks[0]["size"]) if asks else 0.0
                return {
                    "best_bid": best_bid,
                    "best_ask": best_ask,
                    "mid": (best_bid + best_ask) / 2 if best_bid > 0 else best_ask / 2,
                    "spread": best_ask - best_bid,
                    "bid_size": bid_size,
                    "ask_size": ask_size,
                }
        except Exception:
            pass
        return None

    def get_btc_price(self) -> float:
        """Get current BTC/USDT from Binance US."""
        try:
            r = self.session.get(
                f"{self.BINANCE_US}/ticker/price",
                params={"symbol": "BTCUSDT"}, timeout=8
            )
            if r.ok:
                price = float(r.json()["price"])
                self.last_btc_price = price
                return price
        except Exception:
            pass

        # Fallback: CoinGecko
        try:
            r = self.session.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": "bitcoin", "vs_currencies": "usd"}, timeout=8
            )
            if r.ok:
                price = float(r.json()["bitcoin"]["usd"])
                self.last_btc_price = price
                return price
        except Exception:
            pass

        if self.last_btc_price:
            return self.last_btc_price
        return 0.0

    def get_btc_klines(self, limit=30) -> list:
        """Get 1-minute BTC candle closes from Binance US."""
        try:
            r = self.session.get(
                f"{self.BINANCE_US}/klines",
                params={"symbol": "BTCUSDT", "interval": "1m", "limit": limit},
                timeout=10
            )
            if r.ok:
                return [float(k[4]) for k in r.json()]
        except Exception:
            pass
        return []

    def check_result(self, epoch: int) -> int:
        """Check if a window resolved UP (1) or DOWN (0). Returns -1 if not yet resolved."""
        data = self.get_market_data(epoch)
        if data and data["closed"]:
            if data["up_price"] >= 0.90:
                return 1  # UP won
            elif data["down_price"] >= 0.90:
                return 0  # DOWN won
        return -1

    def wait_for_result(self, epoch: int, max_wait: int = 360) -> int:
        """
        Poll Polymarket until the window resolves. Never falls back to BTC price.
        Polymarket typically resolves ~5 min after window close.
        Returns 1 (UP), 0 (DOWN), or -1 (timeout — rare).
        """
        start = time.time()
        attempt = 0
        while time.time() - start < max_wait:
            attempt += 1
            result = self.check_result(epoch)
            if result != -1:
                log.info(f"  Polymarket resolved: {'UP' if result == 1 else 'DOWN'} "
                         f"(attempt {attempt}, {time.time()-start:.0f}s)")
                return result
            # Poll every 10 seconds — resolution takes ~5 min
            if attempt <= 3:
                time.sleep(5)
            elif attempt <= 12:
                time.sleep(10)
            else:
                time.sleep(15)
            # Log progress every 60s so it doesn't look frozen
            elapsed = time.time() - start
            if attempt % 6 == 0:
                log.info(f"  Waiting for resolution... ({elapsed:.0f}s, attempt {attempt})")

        log.warning(f"  Polymarket did NOT resolve after {max_wait}s! Skipping outcome.")
        return -1


# ============================================================
# Live Paper Trader
# ============================================================

class LivePaperTrader:
    """
    Real-time paper trading on Polymarket BTC Up/Down 5-min markets.
    """

    POLL_INTERVAL = 10  # seconds between market polls during a window
    DECISION_SEC = 260  # make trade decision at 260s (40s before close)

    def __init__(self, config: Config, db_path: str = None):
        self.config = config
        self.db_path = db_path
        self.feed = PolymarketFeed()
        self.bankroll = config.initial_bankroll
        self.peak_bankroll = config.initial_bankroll

        # Models
        self.models = {
            "ensemble": EnsembleModel(),
            "logistic": LogisticModel(C=1.0),
            "xgboost": GradientBoostingModel(),
            "mean_reversion": MeanReversionModel(),
        }
        self.active_model_name = "ensemble"
        self.active_model = self.models["ensemble"]
        self.model_trained = False

        # Data
        self.windows_buffer = []
        self.max_buffer = 2000
        self.retrain_interval = 100
        self.windows_since_retrain = 0

        # Stats
        self.total_trades = 0
        self.total_wins = 0
        self.total_pnl = 0.0
        self.total_fees = 0.0
        self.total_windows = 0
        self.bust_count = 0
        self.model_scores = {name: {"trades": 0, "wins": 0, "pnl": 0.0}
                             for name in self.models}

    def pretrain_on_synthetic(self):
        """Pre-train models on synthetic data so we can trade from window 1."""
        btc_price = self.feed.get_btc_price()
        log.info(f"Pre-training models on synthetic data (BTC @ ${btc_price:,.2f})...")

        pretrain_config = Config(
            synthetic_num_windows=2000,
            synthetic_seed=42,
            btc_start_price=btc_price if btc_price > 0 else 72000.0,
        )
        windows = generate_synthetic_data(pretrain_config)
        X, y = build_feature_matrix(windows)

        for name, model in self.models.items():
            try:
                model.fit(X, y)
            except Exception as e:
                log.warning(f"Pre-train {name} failed: {e}")

        self.model_trained = True
        # Keep last 500 synthetic windows as initial buffer
        self.windows_buffer = windows[-500:]
        log.info(f"Pre-trained all models on {len(windows)} synthetic windows")

    def retrain_models(self):
        """Retrain on accumulated live + synthetic data."""
        if len(self.windows_buffer) < self.config.train_window_size:
            return

        log.info(f"  Retraining on {len(self.windows_buffer)} windows...")
        X, y = build_feature_matrix(self.windows_buffer)
        if len(y.unique()) < 2:
            log.warning("  Cannot retrain: only one class")
            return

        for name, model in self.models.items():
            try:
                model.fit(X, y)
            except Exception as e:
                log.warning(f"  Train {name} failed: {e}")

        self.model_trained = True
        self.windows_since_retrain = 0

        # Pick best model
        if any(s["trades"] >= 10 for s in self.model_scores.values()):
            best = max(self.model_scores,
                       key=lambda n: self.model_scores[n]["pnl"] / max(self.model_scores[n]["trades"], 1))
            if best != self.active_model_name:
                old = self.active_model_name
                self.active_model_name = best
                self.active_model = self.models[best]
                log.info(f"  Model switch: {old} -> {best}")

        with get_db(self.db_path) as conn:
            log_event(conn, f"Retrained. Active: {self.active_model_name}")
            conn.execute("""
                INSERT INTO model_snapshots (model_name, trained_at, train_windows, params, metrics)
                VALUES (?, ?, ?, ?, ?)
            """, (self.active_model_name, time.time(), len(self.windows_buffer),
                  json.dumps(self.active_model.get_params()),
                  json.dumps({n: dict(s) for n, s in self.model_scores.items()})))

    def monitor_window(self, window_epoch: int) -> MarketWindow:
        """
        Monitor a 5-minute window, collecting ticks every 10 seconds.
        Can join mid-window — starts collecting from current time.
        Returns a MarketWindow object with all collected data.
        """
        window_id = f"poly-{window_epoch}"
        window_end = window_epoch + WINDOW_DURATION
        btc_start = self.feed.get_btc_price()

        # Collect 30min preceding BTC prices
        preceding = self.feed.get_btc_klines(limit=30)
        if not preceding:
            preceding = [btc_start] * 6

        btc_ticks = []
        btc_timestamps = []
        market_prices = []
        market_bids = []
        market_asks = []
        market_volumes = []
        market_timestamps = []

        # Figure out which tick we're joining at
        secs_elapsed = max(0, int(time.time()) - window_epoch)
        start_tick = secs_elapsed // self.POLL_INTERVAL
        tick = start_tick

        log.info(f"  Joining at tick {start_tick}/30 ({secs_elapsed}s in)")

        while time.time() < window_end + 5:
            now = time.time()
            secs_in = now - window_epoch

            # Get BTC price
            btc_price = self.feed.get_btc_price()
            btc_ticks.append(btc_price)
            btc_timestamps.append(now)

            # Get market data from Polymarket
            mkt = self.feed.get_market_data(window_epoch)
            if mkt:
                up_price = mkt["up_price"]
                market_prices.append(up_price)
                # Try orderbook for bid/ask
                if mkt["tokens"]:
                    book = self.feed.get_orderbook(mkt["tokens"][0])
                    if book:
                        market_bids.append(book["best_bid"])
                        market_asks.append(book["best_ask"])
                    else:
                        spread = 0.02
                        market_bids.append(max(0.01, up_price - spread / 2))
                        market_asks.append(min(0.99, up_price + spread / 2))
                else:
                    market_bids.append(max(0.01, up_price - 0.01))
                    market_asks.append(min(0.99, up_price + 0.01))
            else:
                # Fallback: estimate from BTC movement
                market_prices.append(0.5)
                market_bids.append(0.49)
                market_asks.append(0.51)

            market_volumes.append(0.0)
            market_timestamps.append(now)

            # Log status
            if mkt:
                btc_delta = (btc_price / btc_start - 1) * 100 if btc_start > 0 else 0
                log.info(f"  Tick {tick:2d} | {secs_in:3.0f}s | "
                         f"BTC: ${btc_price:,.2f} ({btc_delta:+.3f}%) | "
                         f"UP: {mkt['up_price']:.3f} | DOWN: {mkt['down_price']:.3f}")

            tick += 1

            # Wait for next tick, but break if window is over
            sleep_until = min(window_epoch + tick * self.POLL_INTERVAL, window_end + 5)
            sleep_time = sleep_until - time.time()
            if sleep_time > 0:
                time.sleep(sleep_time)

            if time.time() >= window_end:
                break

        # Build MarketWindow
        btc_arr = np.array(btc_ticks) if btc_ticks else np.array([btc_start])

        # Wait for Polymarket to resolve — NEVER use BTC price as fallback
        # Polymarket takes ~5 min to resolve after window close
        log.info(f"  Window ended. Polling Polymarket for official result...")
        result = self.feed.wait_for_result(window_epoch, max_wait=360)

        window = MarketWindow(
            window_id=window_id,
            epoch_start=window_epoch,
            epoch_end=window_epoch + WINDOW_DURATION,
            strike_price=btc_start,
            outcome=result,
            market_prices=market_prices if market_prices else [0.5],
            market_bids=market_bids if market_bids else [0.49],
            market_asks=market_asks if market_asks else [0.51],
            market_volumes=market_volumes if market_volumes else [0.0],
            market_timestamps=market_timestamps if market_timestamps else [time.time()],
            btc_open=float(btc_arr[0]),
            btc_high=float(btc_arr.max()),
            btc_low=float(btc_arr.min()),
            btc_close=float(btc_arr[-1]),
            btc_volume=0.0,
            btc_ticks=btc_ticks,
            btc_tick_timestamps=btc_timestamps,
            btc_prices_preceding_30m=preceding[-6:] if preceding else [btc_start] * 6,
        )

        return window

    def evaluate_and_trade(self, window: MarketWindow):
        """Make trade decision and resolve."""
        if not self.model_trained:
            return

        # Skip if Polymarket didn't resolve (outcome == -1 stored as outcome)
        if window.outcome == -1:
            log.warning("  Skipping trade — no confirmed Polymarket outcome")
            return

        lookback = self.windows_buffer[-10:]
        # Use the last collected tick as decision point (we may have joined mid-window)
        decision_tick = max(0, len(window.market_prices) - 5) if len(window.market_prices) > 5 else 0
        feat = compute_features(window, lookback, decision_tick_idx=decision_tick)
        X = pd.DataFrame([feat]).replace([np.inf, -np.inf], 0.0).fillna(0.0)

        market_prob = window.market_prices[decision_tick] if decision_tick < len(window.market_prices) else 0.5
        outcome = window.outcome

        # Score all models
        for name, model in self.models.items():
            try:
                prob = float(model.predict_proba(X)[0])
                signal = generate_signal(window.window_id, prob, market_prob,
                                         self.bankroll, self.config)
                if signal.side != "ABSTAIN":
                    won = ((signal.side == "YES" and outcome == 1) or
                           (signal.side == "NO" and outcome == 0))
                    pnl = ((1.0 - signal.total_cost) if won else -signal.total_cost) * signal.shares
                    self.model_scores[name]["trades"] += 1
                    if pnl > 0:
                        self.model_scores[name]["wins"] += 1
                    self.model_scores[name]["pnl"] += pnl
            except Exception:
                pass

        # Trade with active model
        try:
            model_prob = float(self.active_model.predict_proba(X)[0])
        except Exception:
            log.warning("  Model prediction failed, skipping")
            return

        signal = generate_signal(window.window_id, model_prob, market_prob,
                                 self.bankroll, self.config)

        if signal.side == "ABSTAIN":
            log.info(f"  ABSTAIN | model={model_prob:.3f} mkt={market_prob:.3f} "
                     f"edge={signal.edge:+.3f} (threshold={self.config.entry_threshold})")
            return

        # Map YES/NO to UP/DOWN for clarity
        direction = "UP" if signal.side == "YES" else "DOWN"
        won = ((signal.side == "YES" and outcome == 1) or
               (signal.side == "NO" and outcome == 0))
        pnl = ((1.0 - signal.total_cost) if won else -signal.total_cost) * signal.shares

        self.bankroll += pnl
        self.peak_bankroll = max(self.peak_bankroll, self.bankroll)
        self.total_trades += 1
        self.total_pnl += pnl
        self.total_fees += signal.fee_per_share * signal.shares
        if pnl > 0:
            self.total_wins += 1

        wr = self.total_wins / self.total_trades * 100
        dd = (self.peak_bankroll - self.bankroll) / self.peak_bankroll * 100
        result_str = "WIN " if pnl > 0 else "LOSS"

        log.info(f"  >>> {result_str} | Bet {direction} @ {signal.entry_price:.3f} | "
                 f"${signal.shares * signal.entry_price:.2f} risked | "
                 f"PnL: ${pnl:+.2f} | Bank: ${self.bankroll:.2f} | "
                 f"WR: {wr:.1f}% [{self.total_wins}W/{self.total_trades - self.total_wins}L] | DD: {dd:.1f}%")

        # Save to DB
        with get_db(self.db_path) as conn:
            save_live_trade(conn, window.window_id, signal.side,
                            self.active_model_name, model_prob, market_prob,
                            signal.edge, signal.entry_price,
                            signal.fee_per_share * signal.shares,
                            signal.shares, self.bankroll)
            resolve_trade(conn, window.window_id, outcome, pnl, self.bankroll)

    def run(self, max_hours: float = None):
        """Main trading loop."""
        init_db(self.db_path)

        # Pre-train
        self.pretrain_on_synthetic()

        btc_price = self.feed.get_btc_price()
        with get_db(self.db_path) as conn:
            conn.execute("""
                INSERT INTO session_stats
                (session_start, last_update, bankroll, peak_bankroll, config_json)
                VALUES (?, ?, ?, ?, ?)
            """, (time.time(), time.time(), self.bankroll, self.bankroll,
                  json.dumps({"mode": "live_polymarket", "btc_start": btc_price})))
            log_event(conn, "Live Polymarket paper trader started")

        start_time = time.time()

        log.info("")
        log.info("=" * 65)
        log.info("  SATRIALES LIVE PAPER TRADER")
        log.info("  Polymarket BTC Up/Down 5-Minute Markets")
        log.info("=" * 65)
        log.info(f"  BTC Price:     ${btc_price:,.2f}")
        log.info(f"  Bankroll:      ${self.bankroll:.2f}")
        log.info(f"  Min/Max Bet:   ${self.config.min_bet_size:.0f} / ${self.config.max_bet_size:.0f}")
        log.info(f"  Kelly:         {self.config.kelly_fraction:.0%}")
        log.info(f"  Threshold:     {self.config.entry_threshold}")
        log.info(f"  Model:         {self.active_model_name} (pre-trained)")
        log.info(f"  Max hours:     {max_hours or 'unlimited'}")
        log.info(f"  Window:        5 min (poll every {self.POLL_INTERVAL}s)")
        log.info("=" * 65)

        try:
            while True:
                # Time limit
                if max_hours and (time.time() - start_time) / 3600 > max_hours:
                    log.info(f"Time limit reached ({max_hours}h)")
                    break

                # Bust check
                if self.bankroll < self.config.min_bankroll:
                    self.bust_count += 1
                    log.warning(f"BUST #{self.bust_count}! Bank: ${self.bankroll:.2f}")
                    with get_db(self.db_path) as conn:
                        log_event(conn, f"BUST #{self.bust_count}")
                    self.bankroll = self.config.initial_bankroll
                    self.peak_bankroll = self.config.initial_bankroll

                # Sync to a window boundary.
                # After monitoring a 5-min window, the next one has already started.
                # Only wait if we're in the last few seconds of a window (too late to collect useful data).
                secs_in = self.feed.seconds_into_window()
                if secs_in > WINDOW_DURATION - 10:
                    # Less than 10s left in current window — wait for next one
                    secs_left = WINDOW_DURATION - secs_in + 2
                    log.info(f"\nWindow almost over, waiting {secs_left}s for next...")
                    time.sleep(secs_left)

                # Get current window (the one that's in progress right now)
                window_epoch = self.feed.get_window_epoch()
                self.total_windows += 1
                elapsed_h = (time.time() - start_time) / 3600

                mkt = self.feed.get_market_data(window_epoch)
                q = mkt["question"] if mkt else f"Window {window_epoch}"
                log.info(f"\n{'='*65}")
                log.info(f"  Window #{self.total_windows} | {elapsed_h:.1f}h | {q}")
                log.info(f"{'='*65}")

                # Monitor and collect the full window
                window = self.monitor_window(window_epoch)

                # Save to DB
                with get_db(self.db_path) as conn:
                    save_market_window(
                        conn, window.window_id, window.epoch_start,
                        window.epoch_end, window.strike_price, window.outcome,
                        window.btc_open, window.btc_high, window.btc_low,
                        window.btc_close, window.btc_volume, window.btc_ticks,
                        window.market_prices, window.market_bids,
                        window.market_asks, window.market_volumes,
                        window.btc_prices_preceding_30m, source="polymarket_live"
                    )

                # Buffer for retraining
                self.windows_buffer.append(window)
                if len(self.windows_buffer) > self.max_buffer:
                    self.windows_buffer = self.windows_buffer[-self.max_buffer:]
                self.windows_since_retrain += 1

                # Retrain periodically
                if self.windows_since_retrain >= self.retrain_interval:
                    self.retrain_models()

                # Evaluate and trade
                self.evaluate_and_trade(window)

                # Update session stats
                with get_db(self.db_path) as conn:
                    dd_pct = (self.peak_bankroll - self.bankroll) / self.peak_bankroll if self.peak_bankroll > 0 else 0
                    conn.execute("""
                        UPDATE session_stats SET
                            last_update = ?, windows_collected = ?,
                            trades_executed = ?, trades_won = ?,
                            total_pnl = ?, total_fees = ?,
                            bankroll = ?, peak_bankroll = ?,
                            max_drawdown_pct = ?
                        WHERE id = (SELECT MAX(id) FROM session_stats)
                    """, (time.time(), self.total_windows,
                          self.total_trades, self.total_wins,
                          self.total_pnl, self.total_fees,
                          self.bankroll, self.peak_bankroll, dd_pct))

                # Summary every 12 windows (1 hour)
                if self.total_windows % 12 == 0:
                    self._print_summary(start_time)

        except KeyboardInterrupt:
            log.info("\nStopped by user")

        self._print_summary(start_time, final=True)

        with get_db(self.db_path) as conn:
            log_event(conn, f"Stopped: {self.total_trades} trades, ${self.total_pnl:+.2f}")

    def _print_summary(self, start_time, final=False):
        elapsed_h = (time.time() - start_time) / 3600
        wr = self.total_wins / self.total_trades * 100 if self.total_trades > 0 else 0
        dd = (self.peak_bankroll - self.bankroll) / self.peak_bankroll * 100

        header = "FINAL SUMMARY" if final else "HOURLY SUMMARY"
        log.info(f"\n  --- {header} ({elapsed_h:.1f}h) ---")
        log.info(f"  Windows: {self.total_windows} | Trades: {self.total_trades} | "
                 f"WR: {wr:.1f}% | PnL: ${self.total_pnl:+.2f}")
        log.info(f"  Bankroll: ${self.bankroll:.2f} | Peak: ${self.peak_bankroll:.2f} | "
                 f"DD: {dd:.1f}% | Busts: {self.bust_count}")

        if self.total_trades > 0:
            for name, scores in self.model_scores.items():
                t = int(scores["trades"])
                if t > 0:
                    w = int(scores["wins"])
                    p = float(scores["pnl"])
                    marker = " <-" if name == self.active_model_name else ""
                    log.info(f"    {name:16s}: {t:3d} trades, "
                             f"{w / t * 100:5.1f}% WR, ${p:+.2f}{marker}")


def main():
    parser = argparse.ArgumentParser(description="Satriales Live Paper Trader (Polymarket)")
    parser.add_argument("--hours", type=float, default=None,
                        help="Max hours to run (default: unlimited)")
    args = parser.parse_args()

    config = Config()
    trader = LivePaperTrader(config)
    trader.run(max_hours=args.hours)


if __name__ == "__main__":
    main()
