"""Feature engineering for Polymarket BTC 5-min binary markets."""

import numpy as np
import pandas as pd
from scipy.stats import norm, linregress
from data import MarketWindow


def _safe_log(x):
    return np.log(max(x, 1e-10))


def _linear_slope(values):
    """Slope of linear regression over a sequence, normalized by mean."""
    if len(values) < 2:
        return 0.0
    x = np.arange(len(values))
    slope, _, _, _, _ = linregress(x, values)
    mean_val = np.mean(values)
    return slope / mean_val if abs(mean_val) > 1e-10 else 0.0


def _bs_binary_prob(spot, strike, vol, tau):
    """Black-Scholes binary option probability."""
    if tau <= 0:
        return 1.0 if spot > strike else 0.0
    d2 = (np.log(spot / strike) + (-0.5 * vol ** 2) * tau) / (vol * np.sqrt(tau))
    return float(norm.cdf(d2))


def compute_features(window: MarketWindow, lookback_windows: list,
                     decision_tick_idx: int = 26) -> dict:
    """
    Compute all features for a single window using only data available
    at the decision point (default: tick 26 of 30 = 40 seconds before close).

    Returns dict of feature_name -> float.
    """
    features = {}
    ticks = window.btc_ticks[:decision_tick_idx + 1]
    mkt_prices = window.market_prices[:decision_tick_idx + 1]
    mkt_bids = window.market_bids[:decision_tick_idx + 1]
    mkt_asks = window.market_asks[:decision_tick_idx + 1]
    mkt_vols = window.market_volumes[:decision_tick_idx + 1]

    strike = window.strike_price
    current_btc = ticks[-1]
    elapsed_sec = (decision_tick_idx + 1) * 10
    remaining_sec = 300 - elapsed_sec
    tau = remaining_sec / (365.25 * 86400)

    # === Category 1: BTC Price Momentum (6 features) ===
    features["btc_return_in_window"] = (current_btc - strike) / strike

    if len(ticks) >= 7:
        features["btc_momentum_1m"] = (ticks[-1] - ticks[-7]) / ticks[-7]
    else:
        features["btc_momentum_1m"] = 0.0

    preceding = window.btc_prices_preceding_30m
    if len(preceding) >= 1 and preceding[-1] > 0:
        features["btc_momentum_5m"] = (current_btc - preceding[-1]) / preceding[-1]
    else:
        features["btc_momentum_5m"] = 0.0

    if len(preceding) >= 3 and preceding[-3] > 0:
        features["btc_momentum_15m"] = (current_btc - preceding[-3]) / preceding[-3]
    else:
        features["btc_momentum_15m"] = 0.0

    if len(preceding) >= 6 and preceding[0] > 0:
        features["btc_momentum_30m"] = (current_btc - preceding[0]) / preceding[0]
    else:
        features["btc_momentum_30m"] = 0.0

    all_prices_30m = preceding + list(ticks)
    features["btc_trend_slope"] = _linear_slope(all_prices_30m)

    # === Category 2: BTC Volatility (4 features) ===
    if len(ticks) >= 2:
        tick_returns = np.diff(np.log(np.array(ticks) + 1e-10))
        features["btc_realized_vol_5m"] = float(np.std(tick_returns)) if len(tick_returns) > 1 else 0.0
    else:
        features["btc_realized_vol_5m"] = 0.0

    if len(all_prices_30m) >= 2:
        all_returns = np.diff(np.log(np.array(all_prices_30m) + 1e-10))
        features["btc_realized_vol_30m"] = float(np.std(all_returns)) if len(all_returns) > 1 else 0.0
    else:
        features["btc_realized_vol_30m"] = 0.0

    vol_30m = features["btc_realized_vol_30m"]
    vol_5m = features["btc_realized_vol_5m"]
    features["btc_vol_ratio"] = vol_5m / vol_30m if vol_30m > 1e-10 else 1.0

    features["btc_range_pct"] = (max(ticks) - min(ticks)) / strike if strike > 0 else 0.0

    # === Category 3: Market Microstructure (5 features) ===
    features["market_price_latest"] = mkt_prices[-1]
    features["market_price_trend"] = _linear_slope(mkt_prices) if len(mkt_prices) >= 3 else 0.0

    features["market_spread"] = mkt_asks[-1] - mkt_bids[-1]

    if len(mkt_asks) >= 2 and len(mkt_bids) >= 2:
        spread_now = mkt_asks[-1] - mkt_bids[-1]
        spread_start = mkt_asks[0] - mkt_bids[0]
        features["market_spread_change"] = spread_now - spread_start
    else:
        features["market_spread_change"] = 0.0

    if len(mkt_vols) >= 3:
        vol_diffs = np.diff(mkt_vols)
        vol_accel = np.diff(vol_diffs)
        features["market_volume_acceleration"] = float(np.mean(vol_accel[-3:])) if len(vol_accel) >= 3 else 0.0
    else:
        features["market_volume_acceleration"] = 0.0

    # === Category 4: Distance and Time Features (4 features) ===
    rv = features["btc_realized_vol_5m"]
    features["distance_to_strike"] = (current_btc - strike) / (strike * rv + 1e-10)

    features["time_remaining_frac"] = remaining_sec / 300.0
    features["time_remaining_sqrt"] = np.sqrt(remaining_sec / 300.0)

    annual_vol = rv * np.sqrt(365.25 * 86400 / 10) if rv > 0 else 0.5
    features["bs_implied_prob"] = _bs_binary_prob(current_btc, strike, annual_vol, tau)

    # === Category 5: Cross-Window Features (4 features) ===
    if lookback_windows:
        features["prior_outcome"] = float(lookback_windows[-1].outcome)

        recent_3 = lookback_windows[-3:] if len(lookback_windows) >= 3 else lookback_windows
        features["prior_3_win_rate"] = sum(w.outcome for w in recent_3) / len(recent_3)

        # Streak length
        streak = 0
        last_outcome = lookback_windows[-1].outcome
        for w in reversed(lookback_windows):
            if w.outcome == last_outcome:
                streak += 1
            else:
                break
        features["streak_length"] = float(streak if last_outcome == 1 else -streak)

        # Market efficiency: how well did market prices predict outcomes recently?
        recent_10 = lookback_windows[-10:] if len(lookback_windows) >= 10 else lookback_windows
        errors = []
        for w in recent_10:
            if w.market_prices:
                final_mkt = w.market_prices[-1]
                errors.append(abs(final_mkt - w.outcome))
        features["market_efficiency_score"] = float(np.mean(errors)) if errors else 0.3
    else:
        features["prior_outcome"] = 0.5
        features["prior_3_win_rate"] = 0.5
        features["streak_length"] = 0.0
        features["market_efficiency_score"] = 0.3

    # === Category 6: Order Flow Proxy (2 features) ===
    if len(mkt_bids) > 0 and len(mkt_asks) > 0:
        bid_strength = sum(mkt_bids[-5:]) if len(mkt_bids) >= 5 else sum(mkt_bids)
        ask_strength = sum(1.0 - a for a in (mkt_asks[-5:] if len(mkt_asks) >= 5 else mkt_asks))
        total = bid_strength + ask_strength
        features["bid_ask_imbalance"] = (bid_strength - ask_strength) / total if total > 1e-10 else 0.0
    else:
        features["bid_ask_imbalance"] = 0.0

    if lookback_windows:
        recent_vols = [w.market_volumes[-1] if w.market_volumes else 0 for w in lookback_windows[-10:]]
        avg_vol = np.mean(recent_vols) if recent_vols else 1.0
        current_vol = mkt_vols[-1] if mkt_vols else 0.0
        features["volume_surprise"] = (current_vol - avg_vol) / (avg_vol + 1e-10)
    else:
        features["volume_surprise"] = 0.0

    return features


def build_feature_matrix(windows: list, decision_tick_idx: int = 26) -> tuple:
    """
    Convert list of MarketWindows into (X DataFrame, y Series).

    Each row uses only data available at decision_tick_idx (default: 40s before close).
    Prior windows are used for lookback features.
    """
    rows = []
    outcomes = []

    for i, window in enumerate(windows):
        lookback = windows[max(0, i - 10):i]
        feat = compute_features(window, lookback, decision_tick_idx)
        rows.append(feat)
        outcomes.append(window.outcome)

    X = pd.DataFrame(rows)
    y = pd.Series(outcomes, name="outcome")

    # Fill any NaN/inf with 0
    X = X.replace([np.inf, -np.inf], 0.0).fillna(0.0)

    return X, y
