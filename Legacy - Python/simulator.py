"""
Standalone 24/7 Paper Trading Simulator.

This runs unattended on your PC while you're away:
- Generates synthetic markets continuously
- Trains and retrains models on rolling data
- Paper-trades every window
- Saves everything to SQLite for dashboard analysis

Usage:
    python simulator.py                # Run indefinitely with synthetic data
    python simulator.py --hours 8      # Run for 8 hours then stop
    python simulator.py --fast         # Max speed (no delays)
    python simulator.py --windows 50000  # Generate 50k windows
"""

import argparse
import json
import logging
import os
import sys
import time
import warnings
from datetime import datetime

import numpy as np
import pandas as pd

from config import Config
from data import generate_synthetic_data, MarketWindow
from db import (init_db, get_db, save_market_window, save_live_trade,
                resolve_trade, log_event, get_connection)
from features import compute_features, build_feature_matrix
from models import EnsembleModel, LogisticModel, GradientBoostingModel, MeanReversionModel
from signals import generate_signal

warnings.filterwarnings("ignore", category=RuntimeWarning)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(os.path.dirname(__file__), "simulator.log")),
    ],
)
log = logging.getLogger("simulator")


class ContinuousSimulator:
    """
    Runs continuous paper trading simulation.
    Generates fresh synthetic data in batches to avoid memory issues.
    Retrains models periodically on recent data.
    """

    def __init__(self, config: Config, db_path: str = None):
        self.config = config
        self.db_path = db_path
        self.bankroll = config.initial_bankroll
        self.peak_bankroll = config.initial_bankroll

        # Models to compare
        self.models = {
            "ensemble": EnsembleModel(),
            "logistic": LogisticModel(C=1.0),
            "xgboost": GradientBoostingModel(),
            "mean_reversion": MeanReversionModel(),
        }
        self.active_model_name = "ensemble"
        self.active_model = self.models["ensemble"]
        self.model_trained = False

        # Rolling data buffer
        self.windows_buffer = []
        self.max_buffer = 3000
        self.retrain_interval = 300
        self.windows_since_retrain = 0

        # Stats
        self.total_trades = 0
        self.total_wins = 0
        self.total_pnl = 0.0
        self.total_fees = 0.0
        self.windows_processed = 0

        # Model comparison tracking
        self.model_scores = {name: {"trades": 0, "wins": 0, "pnl": 0.0}
                             for name in self.models}

    def generate_batch(self, seed_offset: int = 0) -> list:
        """Generate a fresh batch of synthetic data."""
        batch_config = Config(
            synthetic_num_windows=self.config.synthetic_num_windows,
            synthetic_seed=self.config.synthetic_seed + seed_offset,
            btc_start_price=self.config.btc_start_price,
        )

        # Vary the starting price for different batches
        if self.windows_buffer:
            last_close = self.windows_buffer[-1].btc_close
            batch_config.btc_start_price = last_close

        return generate_synthetic_data(batch_config)

    def retrain_all_models(self):
        """Retrain all models and pick the best one."""
        if len(self.windows_buffer) < self.config.train_window_size:
            return

        log.info(f"Retraining all models on {len(self.windows_buffer)} windows...")
        X, y = build_feature_matrix(self.windows_buffer)

        if len(y.unique()) < 2:
            log.warning("Cannot retrain: only one class in buffer")
            return

        # Train each model
        for name, model in self.models.items():
            try:
                model.fit(X, y)
            except Exception as e:
                log.warning(f"Failed to train {name}: {e}")

        self.model_trained = True
        self.windows_since_retrain = 0

        # Pick best model based on recent performance
        if any(s["trades"] >= 20 for s in self.model_scores.values()):
            best_name = max(
                self.model_scores,
                key=lambda n: (self.model_scores[n]["pnl"] /
                               max(self.model_scores[n]["trades"], 1))
            )
            if best_name != self.active_model_name:
                log.info(f"Switching to model: {best_name} "
                         f"(avg PnL: ${self.model_scores[best_name]['pnl']/max(self.model_scores[best_name]['trades'],1):.4f})")
                self.active_model_name = best_name
                self.active_model = self.models[best_name]

        # Reset model comparison scores periodically
        for name in self.model_scores:
            scores = self.model_scores[name]
            if scores["trades"] > 500:
                # Decay old scores
                for k in scores:
                    scores[k] *= 0.5

        with get_db(self.db_path) as conn:
            log_event(conn, f"Retrained all models. Active: {self.active_model_name}")
            conn.execute("""
                INSERT INTO model_snapshots (model_name, trained_at, train_windows, params, metrics)
                VALUES (?, ?, ?, ?, ?)
            """, (self.active_model_name, time.time(), len(self.windows_buffer),
                  json.dumps(self.active_model.get_params()),
                  json.dumps({n: dict(s) for n, s in self.model_scores.items()})))

    def evaluate_all_models(self, window: MarketWindow) -> dict:
        """Evaluate all models and trade with the active one."""
        if not self.model_trained:
            return {"side": "ABSTAIN"}

        lookback = self.windows_buffer[-10:] if self.windows_buffer else []
        feat = compute_features(window, lookback, decision_tick_idx=26)
        X = pd.DataFrame([feat]).replace([np.inf, -np.inf], 0.0).fillna(0.0)

        mkt_idx = min(26, len(window.market_prices) - 1)
        market_prob = window.market_prices[mkt_idx]
        outcome = window.outcome

        # Evaluate all models for comparison
        for name, model in self.models.items():
            try:
                prob = float(model.predict_proba(X)[0])
                signal = generate_signal(
                    window.window_id, prob, market_prob,
                    self.bankroll, self.config
                )

                if signal.side != "ABSTAIN":
                    won = ((signal.side == "YES" and outcome == 1) or
                           (signal.side == "NO" and outcome == 0))
                    if won:
                        pnl = (1.0 - signal.total_cost) * signal.shares
                    else:
                        pnl = -signal.total_cost * signal.shares

                    self.model_scores[name]["trades"] += 1
                    if pnl > 0:
                        self.model_scores[name]["wins"] += 1
                    self.model_scores[name]["pnl"] += pnl
            except Exception:
                pass

        # Trade with the active model
        try:
            model_prob = float(self.active_model.predict_proba(X)[0])
        except Exception:
            return {"side": "ABSTAIN"}

        signal = generate_signal(
            window.window_id, model_prob, market_prob,
            self.bankroll, self.config
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
        }

        if signal.side != "ABSTAIN":
            won = ((signal.side == "YES" and outcome == 1) or
                   (signal.side == "NO" and outcome == 0))
            if won:
                pnl = (1.0 - signal.total_cost) * signal.shares
            else:
                pnl = -signal.total_cost * signal.shares

            self.bankroll += pnl
            self.peak_bankroll = max(self.peak_bankroll, self.bankroll)
            self.total_trades += 1
            self.total_pnl += pnl
            self.total_fees += signal.fee_per_share * signal.shares
            if pnl > 0:
                self.total_wins += 1

            # Record to DB
            with get_db(self.db_path) as conn:
                save_live_trade(
                    conn, window.window_id, signal.side, self.active_model_name,
                    model_prob, market_prob, signal.edge,
                    signal.entry_price, signal.fee_per_share * signal.shares,
                    signal.shares, self.bankroll
                )
                resolve_trade(conn, window.window_id, outcome, pnl, self.bankroll)

            result["pnl"] = pnl

        return result

    def run(self, max_hours: float = None, fast: bool = True):
        """Main simulation loop."""
        init_db(self.db_path)

        with get_db(self.db_path) as conn:
            conn.execute("""
                INSERT INTO session_stats
                (session_start, last_update, bankroll, peak_bankroll, config_json)
                VALUES (?, ?, ?, ?, ?)
            """, (time.time(), time.time(), self.bankroll, self.bankroll,
                  json.dumps({"mode": "simulator", "windows_per_batch": self.config.synthetic_num_windows})))
            log_event(conn, "Continuous simulator started")

        start_time = time.time()
        batch_num = 0

        self.bust_count = 0

        log.info("=" * 60)
        log.info("  SATRIALES CONTINUOUS SIMULATOR")
        log.info("  $20 Bankroll Mode - Realistic Risk")
        log.info("=" * 60)
        log.info(f"  Bankroll:        ${self.bankroll:,.2f}")
        log.info(f"  Min bet:         ${self.config.min_bet_size:,.2f}")
        log.info(f"  Max bet:         ${self.config.max_bet_size:,.2f}")
        log.info(f"  Kelly fraction:  {self.config.kelly_fraction:.0%}")
        log.info(f"  Windows/batch:   {self.config.synthetic_num_windows}")
        log.info(f"  Retrain every:   {self.retrain_interval} windows")
        log.info(f"  Max hours:       {max_hours or 'unlimited'}")
        log.info(f"  Active model:    {self.active_model_name}")
        log.info("=" * 60)

        try:
            while True:
                # Check time limit
                if max_hours and (time.time() - start_time) / 3600 > max_hours:
                    log.info(f"Time limit reached ({max_hours}h)")
                    break

                # Check bankroll - track bust events, don't silently reset
                if self.bankroll < self.config.min_bankroll:
                    self.bust_count = getattr(self, 'bust_count', 0) + 1
                    log.warning(f"BUST #{self.bust_count}! Bankroll hit ${self.bankroll:.2f}")
                    with get_db(self.db_path) as conn:
                        log_event(conn, f"BUST #{self.bust_count} at ${self.bankroll:.2f} after {self.total_trades} trades")
                    self.bankroll = self.config.initial_bankroll
                    self.peak_bankroll = self.config.initial_bankroll
                    log.info(f"Bankroll reset to ${self.bankroll:,.2f} (simulating re-deposit)")

                # Generate new batch
                batch_num += 1
                log.info(f"\n--- Batch {batch_num} ---")
                windows = self.generate_batch(seed_offset=batch_num * 1000)
                log.info(f"Generated {len(windows)} windows")

                for i, window in enumerate(windows):
                    # Store window
                    with get_db(self.db_path) as conn:
                        save_market_window(
                            conn, window.window_id, window.epoch_start,
                            window.epoch_end, window.strike_price, window.outcome,
                            window.btc_open, window.btc_high, window.btc_low,
                            window.btc_close, window.btc_volume, window.btc_ticks,
                            window.market_prices, window.market_bids,
                            window.market_asks, window.market_volumes,
                            window.btc_prices_preceding_30m, source="simulator"
                        )

                    self.windows_buffer.append(window)
                    if len(self.windows_buffer) > self.max_buffer:
                        self.windows_buffer = self.windows_buffer[-self.max_buffer:]

                    self.windows_since_retrain += 1
                    self.windows_processed += 1

                    # Retrain if needed
                    if self.windows_since_retrain >= self.retrain_interval:
                        self.retrain_all_models()

                    # Evaluate and trade
                    result = self.evaluate_all_models(window)

                    # Progress logging
                    if self.total_trades > 0 and self.total_trades % 100 == 0:
                        wr = self.total_wins / self.total_trades * 100
                        dd = (self.peak_bankroll - self.bankroll) / self.peak_bankroll * 100
                        elapsed_h = (time.time() - start_time) / 3600

                        log.info(
                            f"[{elapsed_h:.1f}h] "
                            f"W#{self.windows_processed} T#{self.total_trades} | "
                            f"WR: {wr:.1f}% | "
                            f"PnL: ${self.total_pnl:,.2f} | "
                            f"Bank: ${self.bankroll:,.2f} | "
                            f"DD: {dd:.1f}% | "
                            f"Model: {self.active_model_name}"
                        )

                    # Update session stats
                    if self.windows_processed % 500 == 0:
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
                            """, (time.time(), self.windows_processed,
                                  self.total_trades, self.total_wins,
                                  self.total_pnl, self.total_fees,
                                  self.bankroll, self.peak_bankroll, dd_pct))

                    if not fast:
                        time.sleep(0.01)  # tiny delay to be nice to CPU

        except KeyboardInterrupt:
            log.info("\nSimulator stopped by user")

        # Final summary
        elapsed_h = (time.time() - start_time) / 3600
        wr = self.total_wins / self.total_trades * 100 if self.total_trades > 0 else 0
        dd = (self.peak_bankroll - self.bankroll) / self.peak_bankroll * 100

        log.info("\n" + "=" * 60)
        log.info("  SIMULATION SUMMARY")
        log.info("=" * 60)
        log.info(f"  Runtime:        {elapsed_h:.2f} hours")
        log.info(f"  Batches:        {batch_num}")
        log.info(f"  Windows:        {self.windows_processed}")
        log.info(f"  Trades:         {self.total_trades}")
        log.info(f"  Win Rate:       {wr:.1f}%")
        log.info(f"  Total PnL:      ${self.total_pnl:,.2f}")
        log.info(f"  Total Fees:     ${self.total_fees:,.2f}")
        log.info(f"  Final Bankroll: ${self.bankroll:,.2f}")
        log.info(f"  Peak Bankroll:  ${self.peak_bankroll:,.2f}")
        log.info(f"  Max Drawdown:   {dd:.1f}%")
        log.info(f"  Active Model:   {self.active_model_name}")
        log.info(f"  Bust Count:     {getattr(self, 'bust_count', 0)}")
        log.info("=" * 60)

        # Model comparison
        log.info("\n  MODEL COMPARISON:")
        for name, scores in self.model_scores.items():
            t = int(scores["trades"])
            w = int(scores["wins"])
            p = float(scores["pnl"])
            wr = w / t * 100 if t > 0 else 0
            marker = " <-- ACTIVE" if name == self.active_model_name else ""
            log.info(f"    {name:20s}: {t:5d} trades, {wr:5.1f}% WR, ${p:>12,.2f} PnL{marker}")

        with get_db(self.db_path) as conn:
            log_event(conn, f"Simulator stopped: {self.total_trades} trades, ${self.total_pnl:,.2f} PnL")


def main():
    parser = argparse.ArgumentParser(description="Satriales Continuous Simulator")
    parser.add_argument("--hours", type=float, default=None,
                        help="Max hours to run (default: unlimited)")
    parser.add_argument("--fast", action="store_true", default=True,
                        help="Max speed, no delays (default)")
    parser.add_argument("--windows", type=int, default=5000,
                        help="Windows per batch (default: 5000)")
    parser.add_argument("--seed", type=int, default=42, help="Base random seed")
    args = parser.parse_args()

    config = Config(
        synthetic_num_windows=args.windows,
        synthetic_seed=args.seed,
    )

    sim = ContinuousSimulator(config)
    sim.run(max_hours=args.hours, fast=args.fast)


if __name__ == "__main__":
    main()
