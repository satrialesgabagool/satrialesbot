"""
24/7 Live Market Data Collector for Polymarket BTC 5-min markets.

Runs unattended, collecting market data every window cycle.
Stores everything in SQLite for later analysis.

Usage:
    python collector.py                    # Collect + paper trade
    python collector.py --collect-only     # Just collect data, no trading
    python collector.py --synthetic        # Simulate with synthetic data (offline testing)
"""

import argparse
import json
import logging
import os
import pickle
import sys
import time
import traceback
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

from config import Config
from data import MarketWindow, generate_synthetic_data
from db import (init_db, get_connection, save_market_window, save_live_trade,
                resolve_trade, log_event, get_db)
from features import compute_features, build_feature_matrix
from models import EnsembleModel, LogisticModel, GradientBoostingModel
from signals import generate_signal

warnings.filterwarnings("ignore", category=RuntimeWarning)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(os.path.dirname(__file__), "collector.log")),
    ],
)
log = logging.getLogger("collector")


class LiveCollector:
    """Fetches real-time Polymarket BTC 5-min market data."""

    GAMMA_URL = "https://gamma-api.polymarket.com"
    CLOB_URL = "https://clob.polymarket.com"
    BINANCE_URL = "https://api.binance.com/api/v3"

    def __init__(self, config: Config):
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "Satriales/1.0"})
        self.btc_price_cache = []  # rolling BTC prices for preceding context
        self.last_btc_prices_30m = []

    def get_btc_price(self) -> float:
        """Get current BTC/USDT price from Binance."""
        try:
            r = self.session.get(f"{self.BINANCE_URL}/ticker/price",
                                params={"symbol": "BTCUSDT"}, timeout=10)
            r.raise_for_status()
            return float(r.json()["price"])
        except Exception as e:
            log.warning(f"Binance price fetch failed: {e}")
            return 0.0

    def get_btc_klines(self, interval="1m", limit=30) -> list:
        """Get recent BTC klines from Binance."""
        try:
            r = self.session.get(f"{self.BINANCE_URL}/klines",
                                params={"symbol": "BTCUSDT", "interval": interval,
                                        "limit": limit},
                                timeout=10)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.warning(f"Binance klines fetch failed: {e}")
            return []

    def find_active_btc_5min_markets(self) -> list:
        """Search Polymarket for active BTC 5-minute markets."""
        try:
            r = self.session.get(f"{self.GAMMA_URL}/markets",
                                params={"tag": "btc-5-minute", "active": "true",
                                        "limit": 10},
                                timeout=15)
            if r.ok:
                return r.json()
        except Exception as e:
            log.warning(f"Gamma API search failed: {e}")

        # Fallback: try event-based search
        try:
            r = self.session.get(f"{self.GAMMA_URL}/events",
                                params={"slug_contains": "btc-updown-5m",
                                        "active": "true", "limit": 5},
                                timeout=15)
            if r.ok:
                events = r.json()
                markets = []
                for evt in events:
                    for mkt in evt.get("markets", []):
                        markets.append(mkt)
                return markets
        except Exception as e:
            log.warning(f"Gamma events search failed: {e}")

        return []

    def get_market_orderbook(self, token_id: str) -> dict:
        """Get orderbook snapshot for a token."""
        try:
            r = self.session.get(f"{self.CLOB_URL}/book",
                                params={"token_id": token_id}, timeout=10)
            if r.ok:
                return r.json()
        except Exception:
            pass
        return {}

    def collect_window_snapshot(self) -> dict:
        """
        Collect one snapshot of the current market state.
        Returns a dict with all data needed for a MarketWindow.
        """
        now = time.time()

        # Get BTC data
        btc_price = self.get_btc_price()
        klines = self.get_btc_klines(interval="1m", limit=35)

        btc_ticks = []
        if klines:
            for k in klines[-6:]:  # last 6 minutes of 1m candles
                btc_ticks.append(float(k[4]))  # close price

        # Get 30m preceding prices
        preceding_30m = []
        if klines and len(klines) >= 30:
            for k in klines[-30:]:
                preceding_30m.append(float(k[4]))

        # Search for active markets
        markets = self.find_active_btc_5min_markets()

        market_data = None
        if markets:
            for mkt in markets:
                tokens = mkt.get("clobTokenIds", [])
                if tokens:
                    book = self.get_market_orderbook(tokens[0])
                    if book:
                        market_data = {
                            "market": mkt,
                            "book": book,
                            "token_id": tokens[0],
                        }
                        break

        # Build snapshot
        snapshot = {
            "timestamp": now,
            "btc_price": btc_price,
            "btc_ticks": btc_ticks or [btc_price],
            "btc_preceding_30m": preceding_30m[-6:] if preceding_30m else [btc_price] * 6,
            "market_data": market_data,
        }

        # Extract market price from orderbook
        if market_data and market_data["book"]:
            book = market_data["book"]
            bids = book.get("bids", [])
            asks = book.get("asks", [])
            best_bid = float(bids[0]["price"]) if bids else 0.5
            best_ask = float(asks[0]["price"]) if asks else 0.5
            snapshot["market_price"] = (best_bid + best_ask) / 2
            snapshot["market_bid"] = best_bid
            snapshot["market_ask"] = best_ask
        else:
            snapshot["market_price"] = 0.5
            snapshot["market_bid"] = 0.49
            snapshot["market_ask"] = 0.51

        return snapshot


class SyntheticCollector:
    """Simulates live collection using synthetic data for offline testing."""

    def __init__(self, config: Config):
        self.config = config
        log.info("Generating synthetic data for offline simulation...")
        self.windows = generate_synthetic_data(config)
        self.current_idx = 0
        log.info(f"Loaded {len(self.windows)} synthetic windows")

    def get_next_window(self) -> MarketWindow:
        if self.current_idx >= len(self.windows):
            self.current_idx = 0  # loop
        w = self.windows[self.current_idx]
        self.current_idx += 1
        return w


class PaperTrader:
    """Manages paper trading state and model retraining."""

    def __init__(self, config: Config, db_path: str = None):
        self.config = config
        self.db_path = db_path
        self.bankroll = config.initial_bankroll
        self.model = EnsembleModel()
        self.model_trained = False
        self.windows_buffer = []  # rolling buffer for retraining
        self.retrain_interval = 200  # retrain every N windows
        self.windows_since_retrain = 0

    def add_window(self, window: MarketWindow):
        """Add a window to the training buffer."""
        self.windows_buffer.append(window)
        # Keep last 2000 windows
        if len(self.windows_buffer) > 2000:
            self.windows_buffer = self.windows_buffer[-2000:]
        self.windows_since_retrain += 1

    def should_retrain(self) -> bool:
        return (self.windows_since_retrain >= self.retrain_interval and
                len(self.windows_buffer) >= self.config.train_window_size)

    def retrain(self):
        """Retrain the model on recent data."""
        log.info(f"Retraining model on {len(self.windows_buffer)} windows...")
        X, y = build_feature_matrix(self.windows_buffer)
        if len(y.unique()) < 2:
            log.warning("Cannot retrain: only one class in data")
            return

        self.model.fit(X, y)
        self.model_trained = True
        self.windows_since_retrain = 0

        # Save model snapshot to DB
        with get_db(self.db_path) as conn:
            conn.execute("""
                INSERT INTO model_snapshots (model_name, trained_at, train_windows, params, metrics)
                VALUES (?, ?, ?, ?, ?)
            """, ("ensemble", time.time(), len(self.windows_buffer),
                  json.dumps(self.model.get_params()),
                  json.dumps({"train_size": len(self.windows_buffer)})))
            log.info("Model snapshot saved to database")

    def evaluate_window(self, window: MarketWindow) -> dict:
        """Evaluate a window and return trade decision."""
        if not self.model_trained:
            return {"side": "ABSTAIN", "reason": "model_not_trained"}

        lookback = self.windows_buffer[-10:] if self.windows_buffer else []
        feat = compute_features(window, lookback, decision_tick_idx=26)
        X = pd.DataFrame([feat]).replace([np.inf, -np.inf], 0.0).fillna(0.0)

        model_prob = float(self.model.predict_proba(X)[0])
        mkt_idx = min(26, len(window.market_prices) - 1)
        market_prob = window.market_prices[mkt_idx]

        signal = generate_signal(
            window_id=window.window_id,
            model_prob=model_prob,
            market_prob=market_prob,
            bankroll=self.bankroll,
            config=self.config,
        )

        result = {
            "window_id": window.window_id,
            "model_prob": model_prob,
            "market_prob": market_prob,
            "edge": signal.edge,
            "side": signal.side,
            "entry_price": signal.entry_price,
            "fee": signal.fee_per_share,
            "shares": signal.shares,
            "position_size": signal.position_size,
        }

        if signal.side != "ABSTAIN":
            # Record trade
            with get_db(self.db_path) as conn:
                save_live_trade(
                    conn, window.window_id, signal.side, "ensemble",
                    model_prob, market_prob, signal.edge,
                    signal.entry_price, signal.fee_per_share * signal.shares,
                    signal.shares, self.bankroll,
                )

        return result

    def resolve_window(self, window: MarketWindow, trade_result: dict):
        """Resolve a trade once outcome is known."""
        if trade_result["side"] == "ABSTAIN":
            return

        outcome = window.outcome
        won = ((trade_result["side"] == "YES" and outcome == 1) or
               (trade_result["side"] == "NO" and outcome == 0))

        if won:
            pnl = (1.0 - trade_result["entry_price"] - trade_result["fee"]) * trade_result["shares"]
        else:
            cost = trade_result["entry_price"] + trade_result["fee"]
            pnl = -cost * trade_result["shares"]

        self.bankroll += pnl

        with get_db(self.db_path) as conn:
            resolve_trade(conn, window.window_id, outcome, pnl, self.bankroll)

        return pnl


def run_synthetic_simulation(config: Config, speed_factor: float = 0.0):
    """
    Run the full simulation loop with synthetic data.

    speed_factor: seconds between windows (0 = as fast as possible)
    """
    init_db()
    collector = SyntheticCollector(config)
    trader = PaperTrader(config)

    # Record session
    with get_db() as conn:
        conn.execute("""
            INSERT INTO session_stats (session_start, last_update, bankroll, peak_bankroll, config_json)
            VALUES (?, ?, ?, ?, ?)
        """, (time.time(), time.time(), config.initial_bankroll,
              config.initial_bankroll, json.dumps({"mode": "synthetic"})))
        log_event(conn, "Synthetic simulation started")

    log.info("=" * 60)
    log.info("  SATRIALES LIVE SIMULATOR (Synthetic Mode)")
    log.info("=" * 60)
    log.info(f"  Initial bankroll: ${config.initial_bankroll:,.2f}")
    log.info(f"  Windows available: {len(collector.windows)}")
    log.info(f"  Retrain every: {trader.retrain_interval} windows")
    log.info("=" * 60)

    total_trades = 0
    total_wins = 0
    total_pnl = 0.0
    peak_bankroll = config.initial_bankroll

    try:
        for i in range(len(collector.windows)):
            window = collector.get_next_window()

            # Store in DB
            with get_db() as conn:
                save_market_window(
                    conn, window.window_id, window.epoch_start, window.epoch_end,
                    window.strike_price, window.outcome, window.btc_open,
                    window.btc_high, window.btc_low, window.btc_close,
                    window.btc_volume, window.btc_ticks, window.market_prices,
                    window.market_bids, window.market_asks, window.market_volumes,
                    window.btc_prices_preceding_30m, source="synthetic",
                )

            trader.add_window(window)

            # Retrain if needed
            if trader.should_retrain():
                trader.retrain()

            # Evaluate and trade
            trade = trader.evaluate_window(window)

            # Resolve immediately (synthetic - we know the outcome)
            pnl = trader.resolve_window(window, trade)

            if trade["side"] != "ABSTAIN":
                total_trades += 1
                if pnl and pnl > 0:
                    total_wins += 1
                total_pnl += pnl or 0

                peak_bankroll = max(peak_bankroll, trader.bankroll)
                drawdown = (peak_bankroll - trader.bankroll) / peak_bankroll * 100

                if total_trades % 50 == 0:
                    win_rate = total_wins / total_trades * 100 if total_trades > 0 else 0
                    log.info(
                        f"[{i+1}/{len(collector.windows)}] "
                        f"Trades: {total_trades} | "
                        f"Win: {win_rate:.1f}% | "
                        f"PnL: ${total_pnl:,.2f} | "
                        f"Bankroll: ${trader.bankroll:,.2f} | "
                        f"DD: {drawdown:.1f}%"
                    )

            # Update session stats
            if (i + 1) % 100 == 0:
                with get_db() as conn:
                    dd_pct = (peak_bankroll - trader.bankroll) / peak_bankroll if peak_bankroll > 0 else 0
                    conn.execute("""
                        UPDATE session_stats SET
                            last_update = ?,
                            windows_collected = ?,
                            trades_executed = ?,
                            trades_won = ?,
                            total_pnl = ?,
                            bankroll = ?,
                            peak_bankroll = ?,
                            max_drawdown_pct = ?
                        WHERE id = (SELECT MAX(id) FROM session_stats)
                    """, (time.time(), i + 1, total_trades, total_wins,
                          total_pnl, trader.bankroll, peak_bankroll, dd_pct))

            if speed_factor > 0:
                time.sleep(speed_factor)

    except KeyboardInterrupt:
        log.info("\nSimulation interrupted by user")

    # Final summary
    win_rate = total_wins / total_trades * 100 if total_trades > 0 else 0
    log.info("\n" + "=" * 60)
    log.info("  SIMULATION COMPLETE")
    log.info("=" * 60)
    log.info(f"  Total Windows:  {len(collector.windows)}")
    log.info(f"  Total Trades:   {total_trades}")
    log.info(f"  Win Rate:       {win_rate:.1f}%")
    log.info(f"  Total PnL:      ${total_pnl:,.2f}")
    log.info(f"  Final Bankroll: ${trader.bankroll:,.2f}")
    log.info(f"  Peak Bankroll:  ${peak_bankroll:,.2f}")
    log.info("=" * 60)

    with get_db() as conn:
        log_event(conn, f"Simulation complete: {total_trades} trades, PnL ${total_pnl:,.2f}")


def run_live_collection(config: Config):
    """Run live data collection loop (connects to real Polymarket)."""
    init_db()
    collector = LiveCollector(config)
    trader = PaperTrader(config)

    with get_db() as conn:
        conn.execute("""
            INSERT INTO session_stats (session_start, last_update, bankroll, peak_bankroll, config_json)
            VALUES (?, ?, ?, ?, ?)
        """, (time.time(), time.time(), config.initial_bankroll,
              config.initial_bankroll, json.dumps({"mode": "live"})))
        log_event(conn, "Live collection started")

    log.info("=" * 60)
    log.info("  SATRIALES LIVE COLLECTOR (Real Polymarket Data)")
    log.info("  Collecting BTC 5-min market data every 5 minutes")
    log.info("  Press Ctrl+C to stop")
    log.info("=" * 60)

    cycle = 0
    while True:
        try:
            cycle += 1
            snapshot = collector.collect_window_snapshot()

            btc_price = snapshot["btc_price"]
            market_price = snapshot["market_price"]

            log.info(f"[Cycle {cycle}] BTC: ${btc_price:,.2f} | "
                     f"Market: {market_price:.3f} | "
                     f"Bankroll: ${trader.bankroll:,.2f}")

            with get_db() as conn:
                window_id = f"live-{int(snapshot['timestamp'])}"
                save_market_window(
                    conn, window_id, int(snapshot["timestamp"]),
                    int(snapshot["timestamp"]) + 300, btc_price, None,
                    btc_price, btc_price, btc_price, btc_price, 0.0,
                    snapshot["btc_ticks"],
                    [market_price], [snapshot["market_bid"]],
                    [snapshot["market_ask"]], [0.0],
                    snapshot["btc_preceding_30m"], source="live",
                )
                log_event(conn, f"Collected: BTC=${btc_price:,.2f} mkt={market_price:.3f}")

            # Wait for next 5-minute window
            # Align to 5-minute boundaries
            now = time.time()
            next_boundary = (int(now) // 300 + 1) * 300
            sleep_time = next_boundary - now + 10  # 10s after boundary for data availability
            log.info(f"  Sleeping {sleep_time:.0f}s until next window...")
            time.sleep(max(sleep_time, 30))

        except KeyboardInterrupt:
            log.info("\nCollection stopped by user")
            break
        except Exception as e:
            log.error(f"Collection error: {e}")
            log.debug(traceback.format_exc())
            time.sleep(60)  # retry after 1 minute


def main():
    parser = argparse.ArgumentParser(description="Satriales Live Collector")
    parser.add_argument("--synthetic", action="store_true",
                        help="Use synthetic data for offline simulation")
    parser.add_argument("--collect-only", action="store_true",
                        help="Only collect data, don't paper trade")
    parser.add_argument("--windows", type=int, default=5000,
                        help="Synthetic windows count (default: 5000)")
    parser.add_argument("--speed", type=float, default=0.0,
                        help="Seconds between synthetic windows (0 = max speed)")
    args = parser.parse_args()

    config = Config(synthetic_num_windows=args.windows)

    if args.synthetic:
        run_synthetic_simulation(config, speed_factor=args.speed)
    else:
        run_live_collection(config)


if __name__ == "__main__":
    main()
