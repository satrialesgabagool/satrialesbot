"""
Real-Time Paper Trader v2 — Polymarket BTC/ETH Up/Down 5-Min & 15-Min Markets.

Connects to live Polymarket markets:
  https://polymarket.com/event/btc-updown-5m-{epoch}
  https://polymarket.com/event/btc-updown-15m-{epoch}
  https://polymarket.com/event/eth-updown-5m-{epoch}
  https://polymarket.com/event/eth-updown-15m-{epoch}

Features (v2):
  1. Multi-asset: BTC + ETH in parallel
  2. Multi-timeframe: 5-min + 15-min markets simultaneously
  3. Post-close sniping: buy the winner after close but before resolution
     when liquidity is stale (bonereaper-style edge)
  4. Non-blocking resolution queue: continue trading while pending trades
     wait for Polymarket to officially resolve (fixes the 360s freeze bug)

Usage:
    python live_trader.py                                # Run unlimited, all features on
    python live_trader.py --hours 8                      # Run for 8 hours
    python live_trader.py --assets btc                   # BTC only
    python live_trader.py --assets btc,eth --no-15m      # 5-min only
    python live_trader.py --no-snipes                    # Disable post-close sniping
"""

import argparse
import json
import logging
import os
import sys
import time
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

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

# Base epoch for the 5-min window series (known reference point, 900-aligned).
# 1776096000 is divisible by 900, so the same base works for 15-min windows too.
WINDOW_BASE_EPOCH = 1776096000
WINDOW_5M = 300
WINDOW_15M = 900

# Asset registry — Binance US symbols + CoinGecko IDs for fallback
ASSETS = {
    "btc": {
        "symbol": "BTCUSDT",
        "coingecko": "bitcoin",
        "short": "BTC",
        "default_price": 72000.0,
    },
    "eth": {
        "symbol": "ETHUSDT",
        "coingecko": "ethereum",
        "short": "ETH",
        "default_price": 3200.0,
    },
}

# Timeframe registry
TIMEFRAMES = {
    "5m":  {"duration": WINDOW_5M,  "slug_template": "{asset}-updown-5m-{epoch}"},
    "15m": {"duration": WINDOW_15M, "slug_template": "{asset}-updown-15m-{epoch}"},
}


# ============================================================
# Pending Trade Record (for deferred resolution queue)
# ============================================================

@dataclass
class PendingTrade:
    """A trade that has been placed but whose outcome hasn't been confirmed by Polymarket yet."""
    window_id: str
    epoch: int
    asset: str
    timeframe: str       # "5m" or "15m"
    window: Optional[MarketWindow]  # None for snipes (no collected window data)
    side: str            # "YES" or "NO"
    direction: str       # "UP" or "DOWN" (human-readable)
    model_name: str
    model_prob: float
    market_prob: float
    edge: float
    entry_price: float
    fee: float           # total fee in dollars
    shares: float
    total_cost: float    # entry_price + per-share fee
    trade_type: str      # "main" or "snipe"
    queued_at: float = field(default_factory=time.time)
    # Shadow models' predictions at decision time, so we can settle their scores later
    # {model_name: (side, cost_per_share, shares)}
    shadow_predictions: Dict[str, Tuple[str, float, float]] = field(default_factory=dict)

    def resolution_deadline(self) -> float:
        """Max time to keep polling before giving up and skipping this trade."""
        # Polymarket usually resolves within 2-5 min of close; give 15 min hard ceiling.
        return self.epoch + TIMEFRAMES[self.timeframe]["duration"] + 900


# ============================================================
# Market Data Feed (multi-asset)
# ============================================================

class PolymarketFeed:
    """Fetches real-time data from Polymarket + Binance US for multiple assets."""

    GAMMA_URL = "https://gamma-api.polymarket.com"
    CLOB_URL = "https://clob.polymarket.com"
    BINANCE_US = "https://api.binance.us/api/v3"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "Satriales/2.0"
        # Price cache per asset
        self._last_price: Dict[str, float] = {}
        # Market data cache: (asset, tf, epoch) -> (fetched_at, data)
        self._market_cache: Dict[Tuple[str, str, int], Tuple[float, dict]] = {}
        self._cache_ttl = 3.0  # 3-second cache to avoid hammering the API

    # --- Window epoch math ---

    @staticmethod
    def get_window_epoch(tf: str = "5m", now: Optional[int] = None) -> int:
        """Epoch of the currently active window for the given timeframe."""
        now = now if now is not None else int(time.time())
        dur = TIMEFRAMES[tf]["duration"]
        offset = ((now - WINDOW_BASE_EPOCH) // dur) * dur
        return WINDOW_BASE_EPOCH + offset

    @staticmethod
    def seconds_into_window(tf: str = "5m") -> int:
        return int(time.time()) - PolymarketFeed.get_window_epoch(tf)

    @staticmethod
    def seconds_until_next_window(tf: str = "5m") -> int:
        return TIMEFRAMES[tf]["duration"] - PolymarketFeed.seconds_into_window(tf)

    @staticmethod
    def is_15m_boundary(epoch_5m: int) -> bool:
        """
        True if a 5-min window CLOSING at (epoch_5m + 300) is also a 15-min window close.
        A 15-min window ends when (end_epoch - BASE) % 900 == 0.
        """
        end = epoch_5m + WINDOW_5M
        return ((end - WINDOW_BASE_EPOCH) % WINDOW_15M) == 0

    # --- Polymarket market data ---

    def get_market_data(self, epoch: int, asset: str = "btc",
                        timeframe: str = "5m") -> Optional[dict]:
        """Fetch market data for a specific window from Gamma API. Cached for 3s."""
        key = (asset, timeframe, epoch)
        now = time.time()
        cached = self._market_cache.get(key)
        if cached and (now - cached[0]) < self._cache_ttl:
            return cached[1]

        slug = TIMEFRAMES[timeframe]["slug_template"].format(asset=asset, epoch=epoch)
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

                    tokens = mkt.get("clobTokenIds", [])
                    if isinstance(tokens, str):
                        tokens = json.loads(tokens)

                    data = {
                        "slug": slug,
                        "asset": asset,
                        "timeframe": timeframe,
                        "up_price": up_price,
                        "down_price": down_price,
                        "closed": closed,
                        "question": mkt.get("question", ""),
                        "tokens": tokens,
                        "active": mkt.get("active", False),
                    }
                    self._market_cache[key] = (now, data)
                    return data
        except Exception as e:
            log.warning(f"Gamma API error ({slug}): {e}")
        # Cache miss → don't thrash
        self._market_cache[key] = (now, None)
        return None

    def get_orderbook(self, token_id: str) -> Optional[dict]:
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

    # --- Spot price / klines (multi-asset) ---

    def get_price(self, asset: str = "btc") -> float:
        """Get current spot price for asset from Binance US, fallback to CoinGecko."""
        meta = ASSETS[asset]
        try:
            r = self.session.get(
                f"{self.BINANCE_US}/ticker/price",
                params={"symbol": meta["symbol"]}, timeout=8
            )
            if r.ok:
                price = float(r.json()["price"])
                self._last_price[asset] = price
                return price
        except Exception:
            pass

        try:
            r = self.session.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": meta["coingecko"], "vs_currencies": "usd"}, timeout=8
            )
            if r.ok:
                price = float(r.json()[meta["coingecko"]]["usd"])
                self._last_price[asset] = price
                return price
        except Exception:
            pass

        return self._last_price.get(asset, meta["default_price"])

    def get_klines(self, asset: str = "btc", limit: int = 30) -> list:
        """Get 1-min candle closes from Binance US."""
        meta = ASSETS[asset]
        try:
            r = self.session.get(
                f"{self.BINANCE_US}/klines",
                params={"symbol": meta["symbol"], "interval": "1m", "limit": limit},
                timeout=10
            )
            if r.ok:
                return [float(k[4]) for k in r.json()]
        except Exception:
            pass
        return []

    # --- Resolution check (non-blocking) ---

    def check_result(self, epoch: int, asset: str = "btc",
                     timeframe: str = "5m") -> int:
        """Return 1 (UP), 0 (DOWN), or -1 (not yet resolved)."""
        data = self.get_market_data(epoch, asset, timeframe)
        if data and data.get("closed"):
            if data["up_price"] >= 0.90:
                return 1
            elif data["down_price"] >= 0.90:
                return 0
        return -1


# ============================================================
# Live Paper Trader v2
# ============================================================

class LivePaperTrader:
    """
    Real-time paper trading on Polymarket BTC/ETH Up/Down 5-min & 15-min markets.

    Supports:
      - Multi-asset (BTC + ETH)
      - Multi-timeframe (5m + 15m)
      - Post-close sniping
      - Non-blocking deferred resolution
    """

    POLL_INTERVAL = 10  # seconds between market polls during a window

    def __init__(
        self,
        config: Config,
        db_path: str = None,
        assets: Optional[List[str]] = None,
        enable_15m: bool = True,
        enable_snipes: bool = True,
    ):
        self.config = config
        self.db_path = db_path
        self.feed = PolymarketFeed()
        self.bankroll = config.initial_bankroll
        self.peak_bankroll = config.initial_bankroll

        self.assets = assets or ["btc", "eth"]
        self.enable_15m = enable_15m
        self.enable_snipes = enable_snipes

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

        # Training buffer (shared across assets — BTC/ETH look similar enough that joint training is fine)
        self.windows_buffer: List[MarketWindow] = []
        self.max_buffer = 2000
        self.retrain_interval = 100
        self.windows_since_retrain = 0

        # Stats
        self.total_trades = 0
        self.total_wins = 0
        self.total_pnl = 0.0
        self.total_fees = 0.0
        self.total_windows = 0
        self.total_snipes = 0
        self.total_snipes_won = 0
        self.bust_count = 0
        self.model_scores = {name: {"trades": 0, "wins": 0, "pnl": 0.0}
                             for name in self.models}
        self.per_market_stats: Dict[str, dict] = {}  # "btc-5m" → {trades, wins, pnl}

        # Pending trades queue — resolved non-blockingly between windows
        self.pending: List[PendingTrade] = []

    # --------------------------------------------------------
    # Training
    # --------------------------------------------------------

    def pretrain_on_synthetic(self):
        """Pre-train models on synthetic data so we can trade from window 1."""
        btc_price = self.feed.get_price("btc")
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
            best = max(
                self.model_scores,
                key=lambda n: self.model_scores[n]["pnl"] / max(self.model_scores[n]["trades"], 1)
            )
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

    # --------------------------------------------------------
    # Window monitoring (5m base tick — parallel across assets)
    # --------------------------------------------------------

    def monitor_5m_window(self, epoch_5m: int) -> Dict[str, Dict[str, MarketWindow]]:
        """
        Monitor one 5-minute window. Collects ticks in parallel for every active asset.
        Returns {asset: {"5m": MarketWindow, "15m": MarketWindow_or_None}}
        (the 15m window is returned only when this 5m boundary also closes a 15m window).
        """
        window_end = epoch_5m + WINDOW_5M
        closes_15m = self.enable_15m and self.feed.is_15m_boundary(epoch_5m)

        # Per-asset tick buffers (only for the in-progress 5m window)
        buffers = {
            a: {
                "price_open": self.feed.get_price(a),
                "preceding": self.feed.get_klines(a, 30) or [self.feed.get_price(a)] * 6,
                "spot_ticks": [],
                "spot_ts": [],
                "mkt_prices_5m": [],
                "mkt_bids_5m": [],
                "mkt_asks_5m": [],
                "mkt_volumes_5m": [],
                "mkt_ts_5m": [],
                "mkt_prices_15m": [],
                "mkt_bids_15m": [],
                "mkt_asks_15m": [],
                "mkt_volumes_15m": [],
                "mkt_ts_15m": [],
            }
            for a in self.assets
        }

        secs_elapsed = max(0, int(time.time()) - epoch_5m)
        start_tick = secs_elapsed // self.POLL_INTERVAL
        tick = start_tick
        log.info(f"  Joining 5m tick {start_tick}/30 ({secs_elapsed}s in) | assets={self.assets} | 15m_close={closes_15m}")

        # 15m epoch = the 15m window that contains this 5m window
        epoch_15m = self.feed.get_window_epoch("15m", epoch_5m + 1) if self.enable_15m else None

        while time.time() < window_end + 5:
            now = time.time()
            secs_in = int(now - epoch_5m)

            for asset in self.assets:
                buf = buffers[asset]
                price = self.feed.get_price(asset)
                buf["spot_ticks"].append(price)
                buf["spot_ts"].append(now)

                # 5m market snapshot
                mkt5 = self.feed.get_market_data(epoch_5m, asset, "5m")
                up5 = mkt5["up_price"] if mkt5 else 0.5
                buf["mkt_prices_5m"].append(up5)
                bid5, ask5 = self._bid_ask_from_market(mkt5, up5)
                buf["mkt_bids_5m"].append(bid5)
                buf["mkt_asks_5m"].append(ask5)
                buf["mkt_volumes_5m"].append(0.0)
                buf["mkt_ts_5m"].append(now)

                # 15m market snapshot (if enabled)
                if self.enable_15m and epoch_15m:
                    mkt15 = self.feed.get_market_data(epoch_15m, asset, "15m")
                    up15 = mkt15["up_price"] if mkt15 else 0.5
                    buf["mkt_prices_15m"].append(up15)
                    bid15, ask15 = self._bid_ask_from_market(mkt15, up15)
                    buf["mkt_bids_15m"].append(bid15)
                    buf["mkt_asks_15m"].append(ask15)
                    buf["mkt_volumes_15m"].append(0.0)
                    buf["mkt_ts_15m"].append(now)

                # Log once per tick (BTC primary)
                if asset == self.assets[0] and mkt5:
                    delta = (price / buf["price_open"] - 1) * 100 if buf["price_open"] > 0 else 0
                    short = ASSETS[asset]["short"]
                    log.info(
                        f"  Tick {tick:2d} | {secs_in:3d}s | "
                        f"{short}: ${price:,.2f} ({delta:+.3f}%) | "
                        f"UP: {up5:.3f} | DOWN: {mkt5['down_price']:.3f}"
                    )

            tick += 1

            # Try to resolve pending trades between ticks (non-blocking)
            self.resolve_pending()

            sleep_until = min(epoch_5m + tick * self.POLL_INTERVAL, window_end + 5)
            sleep_time = sleep_until - time.time()
            if sleep_time > 0:
                time.sleep(sleep_time)

            if time.time() >= window_end:
                break

        # Build MarketWindow objects per asset/timeframe
        result: Dict[str, Dict[str, MarketWindow]] = {}
        for asset in self.assets:
            buf = buffers[asset]
            result[asset] = {
                "5m": self._build_market_window(
                    asset, "5m", epoch_5m, WINDOW_5M, buf, "5m"
                )
            }
            if closes_15m and epoch_15m:
                result[asset]["15m"] = self._build_market_window(
                    asset, "15m", epoch_15m, WINDOW_15M, buf, "15m"
                )
            else:
                result[asset]["15m"] = None

        return result

    @staticmethod
    def _bid_ask_from_market(mkt: Optional[dict], up_price: float) -> Tuple[float, float]:
        """Derive bid/ask from market data (simple spread estimate)."""
        if not mkt:
            return max(0.01, up_price - 0.01), min(0.99, up_price + 0.01)
        # Use 2c default spread if we don't have a real orderbook probe
        return max(0.01, up_price - 0.01), min(0.99, up_price + 0.01)

    def _build_market_window(self, asset: str, tf: str, epoch: int,
                             duration: int, buf: dict, key_suffix: str) -> MarketWindow:
        """Assemble a MarketWindow from a tick buffer."""
        window_id = f"poly-{asset}-{tf}-{epoch}"
        spot_arr = np.array(buf["spot_ticks"]) if buf["spot_ticks"] else np.array([buf["price_open"]])
        prices_key = f"mkt_prices_{key_suffix}"
        bids_key = f"mkt_bids_{key_suffix}"
        asks_key = f"mkt_asks_{key_suffix}"
        vols_key = f"mkt_volumes_{key_suffix}"
        ts_key = f"mkt_ts_{key_suffix}"

        return MarketWindow(
            window_id=window_id,
            epoch_start=epoch,
            epoch_end=epoch + duration,
            strike_price=float(buf["price_open"]),
            outcome=-1,  # Unknown at build time; resolved asynchronously
            market_prices=buf[prices_key] if buf[prices_key] else [0.5],
            market_bids=buf[bids_key] if buf[bids_key] else [0.49],
            market_asks=buf[asks_key] if buf[asks_key] else [0.51],
            market_volumes=buf[vols_key] if buf[vols_key] else [0.0],
            market_timestamps=buf[ts_key] if buf[ts_key] else [time.time()],
            btc_open=float(spot_arr[0]),
            btc_high=float(spot_arr.max()),
            btc_low=float(spot_arr.min()),
            btc_close=float(spot_arr[-1]),
            btc_volume=0.0,
            btc_ticks=list(spot_arr),
            btc_tick_timestamps=buf["spot_ts"],
            btc_prices_preceding_30m=buf["preceding"][-6:] if buf["preceding"] else [buf["price_open"]] * 6,
        )

    # --------------------------------------------------------
    # Decide & queue trades
    # --------------------------------------------------------

    def decide_trade(self, window: MarketWindow, asset: str, timeframe: str) -> Optional[PendingTrade]:
        """
        Run all models on window, queue a trade with the active model if edge exists.
        Returns a PendingTrade (added to self.pending) or None.
        """
        if not self.model_trained:
            return None

        # Use the last 10 recent training windows as lookback
        lookback = self.windows_buffer[-10:]
        decision_tick = max(0, len(window.market_prices) - 5) if len(window.market_prices) > 5 else 0
        try:
            feat = compute_features(window, lookback, decision_tick_idx=decision_tick)
        except Exception as e:
            log.warning(f"  feature extraction failed for {window.window_id}: {e}")
            return None
        X = pd.DataFrame([feat]).replace([np.inf, -np.inf], 0.0).fillna(0.0)

        market_prob = (window.market_prices[decision_tick]
                       if decision_tick < len(window.market_prices) else 0.5)

        # Capture shadow predictions for all models (for scoring later)
        shadow: Dict[str, Tuple[str, float, float]] = {}
        for name, model in self.models.items():
            try:
                prob = float(model.predict_proba(X)[0])
                sig = generate_signal(window.window_id, prob, market_prob,
                                      self.bankroll, self.config)
                if sig.side != "ABSTAIN":
                    shadow[name] = (sig.side, sig.total_cost, sig.shares)
            except Exception:
                pass

        # Active model decision
        try:
            model_prob = float(self.active_model.predict_proba(X)[0])
        except Exception:
            log.warning("  active model prediction failed")
            return None

        signal = generate_signal(window.window_id, model_prob, market_prob,
                                 self.bankroll, self.config)

        market_key = f"{asset}-{timeframe}"
        if signal.side == "ABSTAIN":
            log.info(f"  [{market_key}] ABSTAIN | model={model_prob:.3f} mkt={market_prob:.3f} "
                     f"edge={signal.edge:+.3f}")
            return None

        direction = "UP" if signal.side == "YES" else "DOWN"

        # Deduct cost up front (paper wallet commits funds now; PnL realized on resolve)
        cost_dollars = signal.shares * signal.total_cost
        if cost_dollars > self.bankroll:
            log.warning(f"  [{market_key}] Not enough bankroll to commit ${cost_dollars:.2f}; skipping")
            return None
        self.bankroll -= cost_dollars
        self.total_fees += signal.fee_per_share * signal.shares

        pending = PendingTrade(
            window_id=window.window_id,
            epoch=window.epoch_start,
            asset=asset,
            timeframe=timeframe,
            window=window,
            side=signal.side,
            direction=direction,
            model_name=self.active_model_name,
            model_prob=model_prob,
            market_prob=market_prob,
            edge=signal.edge,
            entry_price=signal.entry_price,
            fee=signal.fee_per_share * signal.shares,
            shares=signal.shares,
            total_cost=signal.total_cost,
            trade_type="main",
            shadow_predictions=shadow,
        )
        self.pending.append(pending)

        log.info(f"  [{market_key}] QUEUED {direction} @ {signal.entry_price:.3f} | "
                 f"${cost_dollars:.2f} risked | edge={signal.edge:+.3f} | "
                 f"bank(committed)=${self.bankroll:.2f}")

        # Persist trade with pending outcome
        with get_db(self.db_path) as conn:
            save_live_trade(conn, window.window_id, signal.side,
                            self.active_model_name, model_prob, market_prob,
                            signal.edge, signal.entry_price,
                            signal.fee_per_share * signal.shares,
                            signal.shares, self.bankroll)

        return pending

    # --------------------------------------------------------
    # Post-close sniping (bonereaper-style)
    # --------------------------------------------------------

    def attempt_snipe(self, epoch: int, asset: str, timeframe: str,
                      open_price: float, close_price: float) -> Optional[PendingTrade]:
        """
        Right after window close: if spot moved decisively and Polymarket liquidity
        is still stale (winner priced < $0.93), buy the winner for near-guaranteed profit.
        """
        if not self.enable_snipes:
            return None

        move_pct = (close_price - open_price) / open_price if open_price > 0 else 0
        if abs(move_pct) < 0.0003:  # < 0.03% move — too flat to bet on UP/DOWN
            return None

        actual_direction = "UP" if close_price >= open_price else "DOWN"
        side = "YES" if actual_direction == "UP" else "NO"
        market_key = f"{asset}-{timeframe}"

        mkt = self.feed.get_market_data(epoch, asset, timeframe)
        if not mkt:
            log.info(f"  [snipe {market_key}] no market data, skip")
            return None

        winner_price = mkt["up_price"] if actual_direction == "UP" else mkt["down_price"]
        # Sweet spot: winner undervalued but not already-resolved ($0.50-$0.93)
        if winner_price < 0.50 or winner_price > 0.93:
            log.info(f"  [snipe {market_key}] winner priced {winner_price:.3f} — outside sweet spot, skip")
            return None
        if mkt.get("closed"):
            log.info(f"  [snipe {market_key}] already resolved, skip")
            return None

        # Size: $1-$3 or 5% of bankroll, whichever is smaller
        snipe_size = min(3.0, max(1.0, self.bankroll * 0.05))
        if self.bankroll < snipe_size:
            return None

        from signals import compute_fee
        fee_per = compute_fee(winner_price, self.config.fee_rate)
        cost_per = winner_price + fee_per
        shares = snipe_size / cost_per
        cost_dollars = shares * cost_per

        if cost_dollars > self.bankroll:
            return None
        self.bankroll -= cost_dollars
        self.total_fees += fee_per * shares
        self.total_snipes += 1

        snipe_window_id = f"snipe-{asset}-{timeframe}-{epoch}"
        pending = PendingTrade(
            window_id=snipe_window_id,
            epoch=epoch,
            asset=asset,
            timeframe=timeframe,
            window=None,
            side=side,
            direction=actual_direction,
            model_name="snipe",
            model_prob=1.0,  # we KNOW the outcome from spot
            market_prob=winner_price,
            edge=1.0 - winner_price,
            entry_price=winner_price,
            fee=fee_per * shares,
            shares=shares,
            total_cost=cost_per,
            trade_type="snipe",
        )
        self.pending.append(pending)

        log.info(f"  [snipe {market_key}] BOUGHT {actual_direction} @ {winner_price:.3f} | "
                 f"${cost_dollars:.2f} | spot moved {move_pct*100:+.3f}%")

        with get_db(self.db_path) as conn:
            save_live_trade(conn, snipe_window_id, side, "snipe",
                            1.0, winner_price, 1.0 - winner_price, winner_price,
                            fee_per * shares, shares, self.bankroll)

        return pending

    # --------------------------------------------------------
    # Deferred resolution (non-blocking)
    # --------------------------------------------------------

    def resolve_pending(self):
        """
        Try to resolve every pending trade. Non-blocking: just polls and skips
        anything still unresolved. Settles trades that have resolved.
        Drops trades past their resolution deadline.
        """
        if not self.pending:
            return

        now = time.time()
        remaining: List[PendingTrade] = []
        for p in self.pending:
            # Don't bother polling until the window has actually closed
            if now < p.epoch + TIMEFRAMES[p.timeframe]["duration"] - 2:
                remaining.append(p)
                continue

            outcome = self.feed.check_result(p.epoch, p.asset, p.timeframe)
            if outcome == -1:
                # Still pending — check deadline
                if now > p.resolution_deadline():
                    log.warning(
                        f"  [{p.asset}-{p.timeframe} {p.direction}] dropped — "
                        f"Polymarket failed to resolve within 15m"
                    )
                    # Forfeit the committed cost (treat as a loss). This matches reality
                    # because if we couldn't resolve, the paper trade has no recoverable value.
                    self.total_trades += 1
                    loss = -p.shares * p.total_cost
                    self.total_pnl += loss
                    # NOTE: bankroll was already deducted when the trade was queued,
                    # so no further change is needed for a loss.
                    with get_db(self.db_path) as conn:
                        resolve_trade(conn, p.window_id, -1, loss, self.bankroll)
                        log_event(conn, f"DROPPED (no resolution): {p.window_id}")
                    continue
                remaining.append(p)
                continue

            # Resolved! Settle.
            self.settle_trade(p, outcome)

        self.pending = remaining

    def settle_trade(self, p: PendingTrade, outcome: int):
        """Realize PnL for a resolved trade and update stats."""
        won = ((p.side == "YES" and outcome == 1) or
               (p.side == "NO" and outcome == 0))

        # Cost was already deducted when queued. If won, we receive $1/share back.
        payout = p.shares * 1.0 if won else 0.0
        committed_cost = p.shares * p.total_cost
        pnl = payout - committed_cost
        self.bankroll += payout  # return winning payout (or 0 for loss)
        self.peak_bankroll = max(self.peak_bankroll, self.bankroll)

        market_key = f"{p.asset}-{p.timeframe}"
        stats = self.per_market_stats.setdefault(market_key, {"trades": 0, "wins": 0, "pnl": 0.0})
        stats["trades"] += 1
        if won:
            stats["wins"] += 1
        stats["pnl"] += pnl

        if p.trade_type == "snipe":
            if won:
                self.total_snipes_won += 1

        # Track main-model trade stats
        if p.trade_type == "main":
            self.total_trades += 1
            self.total_pnl += pnl
            if won:
                self.total_wins += 1

            # Score the active model
            self.model_scores[p.model_name]["trades"] += 1
            if won:
                self.model_scores[p.model_name]["wins"] += 1
            self.model_scores[p.model_name]["pnl"] += pnl

            # Score shadow models (what would have happened?)
            for name, (s_side, s_cost, s_shares) in p.shadow_predictions.items():
                if name == p.model_name:
                    continue
                s_won = ((s_side == "YES" and outcome == 1) or
                         (s_side == "NO" and outcome == 0))
                s_pnl = (s_shares * (1.0 - s_cost)) if s_won else -(s_shares * s_cost)
                self.model_scores[name]["trades"] += 1
                if s_won:
                    self.model_scores[name]["wins"] += 1
                self.model_scores[name]["pnl"] += s_pnl

        result_str = "WIN " if won else "LOSS"
        wr_total = (self.total_wins / self.total_trades * 100) if self.total_trades else 0
        tag = "snipe" if p.trade_type == "snipe" else "main"
        log.info(
            f"  [{market_key} {tag}] {result_str} {p.direction} @ {p.entry_price:.3f} | "
            f"PnL ${pnl:+.2f} | Bank ${self.bankroll:.2f} | WR {wr_total:.1f}%"
        )

        # Also update the stored window's outcome if we have it
        if p.window is not None:
            p.window.outcome = outcome
            with get_db(self.db_path) as conn:
                save_market_window(
                    conn, p.window.window_id, p.window.epoch_start,
                    p.window.epoch_end, p.window.strike_price, outcome,
                    p.window.btc_open, p.window.btc_high, p.window.btc_low,
                    p.window.btc_close, p.window.btc_volume, p.window.btc_ticks,
                    p.window.market_prices, p.window.market_bids,
                    p.window.market_asks, p.window.market_volumes,
                    p.window.btc_prices_preceding_30m, source="polymarket_live"
                )
            # Add to training buffer only after outcome is known
            self.windows_buffer.append(p.window)
            if len(self.windows_buffer) > self.max_buffer:
                self.windows_buffer = self.windows_buffer[-self.max_buffer:]
            self.windows_since_retrain += 1

        with get_db(self.db_path) as conn:
            resolve_trade(conn, p.window_id, outcome, pnl, self.bankroll)

    # --------------------------------------------------------
    # Main loop
    # --------------------------------------------------------

    def run(self, max_hours: float = None):
        init_db(self.db_path)
        self.pretrain_on_synthetic()

        btc_price = self.feed.get_price("btc")
        eth_price = self.feed.get_price("eth") if "eth" in self.assets else 0.0

        with get_db(self.db_path) as conn:
            conn.execute("""
                INSERT INTO session_stats
                (session_start, last_update, bankroll, peak_bankroll, config_json)
                VALUES (?, ?, ?, ?, ?)
            """, (time.time(), time.time(), self.bankroll, self.bankroll,
                  json.dumps({
                      "mode": "live_polymarket_v2",
                      "assets": self.assets,
                      "enable_15m": self.enable_15m,
                      "enable_snipes": self.enable_snipes,
                      "btc_start": btc_price,
                      "eth_start": eth_price,
                  })))
            log_event(conn, f"Live Polymarket v2 started: {self.assets} / 15m={self.enable_15m} / snipes={self.enable_snipes}")

        start_time = time.time()

        log.info("")
        log.info("=" * 70)
        log.info("  SATRIALES LIVE PAPER TRADER v2")
        log.info("  Polymarket Up/Down — Multi-asset / Multi-timeframe / Sniping")
        log.info("=" * 70)
        log.info(f"  Assets:        {', '.join(ASSETS[a]['short'] for a in self.assets)}")
        log.info(f"  Timeframes:    5m" + (" + 15m" if self.enable_15m else ""))
        log.info(f"  Snipes:        {'ENABLED' if self.enable_snipes else 'disabled'}")
        log.info(f"  BTC:           ${btc_price:,.2f}")
        if eth_price:
            log.info(f"  ETH:           ${eth_price:,.2f}")
        log.info(f"  Bankroll:      ${self.bankroll:.2f}")
        log.info(f"  Min/Max Bet:   ${self.config.min_bet_size:.0f} / ${self.config.max_bet_size:.0f}")
        log.info(f"  Kelly:         {self.config.kelly_fraction:.0%}")
        log.info(f"  Threshold:     {self.config.entry_threshold}")
        log.info(f"  Model:         {self.active_model_name} (pre-trained)")
        log.info(f"  Max hours:     {max_hours or 'unlimited'}")
        log.info("=" * 70)

        try:
            while True:
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

                # Wait for next 5m boundary if we'd miss too much of the current one
                secs_in = self.feed.seconds_into_window("5m")
                if secs_in > WINDOW_5M - 10:
                    secs_left = WINDOW_5M - secs_in + 2
                    log.info(f"\nWindow almost over, waiting {secs_left}s for next...")
                    # While waiting, try to resolve pending trades
                    while secs_left > 0:
                        self.resolve_pending()
                        chunk = min(5, secs_left)
                        time.sleep(chunk)
                        secs_left -= chunk

                epoch_5m = self.feed.get_window_epoch("5m")
                self.total_windows += 1
                elapsed_h = (time.time() - start_time) / 3600
                closes_15m = self.enable_15m and self.feed.is_15m_boundary(epoch_5m)

                log.info(f"\n{'='*70}")
                log.info(f"  Window #{self.total_windows} | {elapsed_h:.1f}h | "
                         f"5m epoch {epoch_5m}" + (" | 15m close" if closes_15m else ""))
                log.info(f"{'='*70}")

                # Collect the in-progress 5m window (and 15m if closing)
                collected = self.monitor_5m_window(epoch_5m)

                # For each asset, decide trades on 5m + optional 15m
                for asset in self.assets:
                    w5 = collected[asset]["5m"]
                    w15 = collected[asset]["15m"]

                    self.decide_trade(w5, asset, "5m")
                    if w15 is not None:
                        self.decide_trade(w15, asset, "15m")

                    # Attempt snipes on the just-closed windows
                    if self.enable_snipes:
                        self.attempt_snipe(
                            w5.epoch_start, asset, "5m",
                            w5.btc_open, w5.btc_close
                        )
                        if w15 is not None:
                            self.attempt_snipe(
                                w15.epoch_start, asset, "15m",
                                w15.btc_open, w15.btc_close
                            )

                # Pending resolution attempt (non-blocking)
                self.resolve_pending()

                # Retrain periodically (based on resolved windows, not total collected)
                if self.windows_since_retrain >= self.retrain_interval:
                    self.retrain_models()

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

                # Summary every 12 windows (~1 hour)
                if self.total_windows % 12 == 0:
                    self._print_summary(start_time)

        except KeyboardInterrupt:
            log.info("\nStopped by user")

        # Drain remaining pending (blocking-ish but bounded) before final summary
        log.info(f"\nDraining {len(self.pending)} pending trades (up to 15m wait each)...")
        drain_deadline = time.time() + 900
        while self.pending and time.time() < drain_deadline:
            self.resolve_pending()
            if self.pending:
                time.sleep(15)

        self._print_summary(start_time, final=True)

        with get_db(self.db_path) as conn:
            log_event(conn, f"Stopped: {self.total_trades} trades, ${self.total_pnl:+.2f}")

    def _print_summary(self, start_time, final=False):
        elapsed_h = (time.time() - start_time) / 3600
        wr = self.total_wins / self.total_trades * 100 if self.total_trades > 0 else 0
        dd = (self.peak_bankroll - self.bankroll) / self.peak_bankroll * 100 if self.peak_bankroll > 0 else 0

        header = "FINAL SUMMARY" if final else "HOURLY SUMMARY"
        log.info(f"\n  --- {header} ({elapsed_h:.1f}h) ---")
        log.info(f"  Windows: {self.total_windows} | Trades: {self.total_trades} | "
                 f"WR: {wr:.1f}% | PnL: ${self.total_pnl:+.2f}")
        log.info(f"  Bankroll: ${self.bankroll:.2f} | Peak: ${self.peak_bankroll:.2f} | "
                 f"DD: {dd:.1f}% | Busts: {self.bust_count} | Pending: {len(self.pending)}")

        if self.total_snipes > 0:
            snipe_wr = self.total_snipes_won / self.total_snipes * 100
            log.info(f"  Snipes:  {self.total_snipes} total, {self.total_snipes_won} won "
                     f"({snipe_wr:.1f}% WR)")

        if self.per_market_stats:
            log.info("  Per market:")
            for key, s in sorted(self.per_market_stats.items()):
                t = s["trades"]
                w = s["wins"]
                p = s["pnl"]
                if t > 0:
                    log.info(f"    {key:12s}: {t:3d} trades, {w/t*100:5.1f}% WR, ${p:+.2f}")

        if self.total_trades > 0:
            log.info("  Per model:")
            for name, scores in self.model_scores.items():
                t = int(scores["trades"])
                if t > 0:
                    w = int(scores["wins"])
                    p = float(scores["pnl"])
                    marker = " <-" if name == self.active_model_name else ""
                    log.info(f"    {name:16s}: {t:3d} trades, "
                             f"{w / t * 100:5.1f}% WR, ${p:+.2f}{marker}")


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Satriales Live Paper Trader v2 (Polymarket)")
    parser.add_argument("--hours", type=float, default=None,
                        help="Max hours to run (default: unlimited)")
    parser.add_argument("--assets", type=str, default="btc,eth",
                        help="Comma-separated assets to trade: btc, eth (default: btc,eth)")
    parser.add_argument("--no-15m", action="store_true",
                        help="Disable 15-minute markets (5m only)")
    parser.add_argument("--no-snipes", action="store_true",
                        help="Disable post-close sniping")
    args = parser.parse_args()

    assets = [a.strip().lower() for a in args.assets.split(",") if a.strip()]
    unknown = [a for a in assets if a not in ASSETS]
    if unknown:
        sys.exit(f"Unknown asset(s): {unknown}. Available: {list(ASSETS.keys())}")

    config = Config()
    trader = LivePaperTrader(
        config,
        assets=assets,
        enable_15m=not args.no_15m,
        enable_snipes=not args.no_snipes,
    )
    trader.run(max_hours=args.hours)


if __name__ == "__main__":
    main()
