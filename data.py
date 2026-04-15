"""Data generation and fetching for Polymarket BTC 5-min binary markets."""

from dataclasses import dataclass, field
import numpy as np
import pandas as pd
from scipy.stats import norm
from config import Config, DataMode


@dataclass
class MarketWindow:
    """One 5-minute binary prediction market window."""
    window_id: str
    epoch_start: int
    epoch_end: int
    strike_price: float
    outcome: int  # 1 = BTC ended above strike, 0 = below

    # Market snapshots (one per tick, ~30 values)
    market_prices: list  # YES token mid-prices
    market_bids: list
    market_asks: list
    market_volumes: list
    market_timestamps: list

    # BTC spot data within the window
    btc_open: float
    btc_high: float
    btc_low: float
    btc_close: float
    btc_volume: float
    btc_ticks: list  # BTC prices at each tick
    btc_tick_timestamps: list

    # Context: BTC 1-min closes for prior 30 minutes (6 values per prior window)
    btc_prices_preceding_30m: list


def _black_scholes_binary_prob(spot, strike, vol, tau):
    """
    Black-Scholes probability that spot > strike at expiry.

    tau: time remaining in years
    vol: annualized volatility
    """
    if tau <= 0:
        return 1.0 if spot > strike else 0.0
    d2 = (np.log(spot / strike) + (-0.5 * vol ** 2) * tau) / (vol * np.sqrt(tau))
    return norm.cdf(d2)


def generate_synthetic_data(config: Config) -> list:
    """
    Generate synthetic MarketWindow data mimicking real Polymarket BTC 5-min markets.

    Uses Geometric Brownian Motion for BTC price, Black-Scholes for true probabilities,
    and calibrated noise for market price inefficiency.
    """
    rng = np.random.default_rng(config.synthetic_seed)

    num_windows = config.synthetic_num_windows
    ticks_per_window = config.btc_ticks_per_window
    tick_dt_sec = config.btc_tick_interval_sec
    window_duration_sec = ticks_per_window * tick_dt_sec  # 300s

    # Total ticks needed: windows + 6 extra preceding windows for lookback
    lookback_windows = 6
    total_windows = num_windows + lookback_windows
    total_ticks = total_windows * ticks_per_window

    # GBM parameters
    dt_years = tick_dt_sec / (365.25 * 86400)
    mu = config.btc_annual_drift
    sigma = config.btc_annual_vol

    # Generate continuous BTC price path
    log_returns = (mu - 0.5 * sigma ** 2) * dt_years + sigma * np.sqrt(dt_years) * rng.standard_normal(total_ticks)

    # Add Ornstein-Uhlenbeck microstructure noise
    ou_theta = 50.0  # mean reversion speed
    ou_eta = 0.0002   # noise magnitude
    ou_noise = np.zeros(total_ticks)
    for i in range(1, total_ticks):
        ou_noise[i] = ou_noise[i - 1] * np.exp(-ou_theta * dt_years) + ou_eta * rng.standard_normal()

    # Add occasional volatility spikes (Poisson jumps)
    jump_mask = rng.random(total_ticks) < 0.001  # ~3% chance per window
    jumps = np.where(jump_mask, rng.normal(0, 0.003, total_ticks), 0.0)

    # Construct price path with clamping to prevent overflow
    btc_prices = np.zeros(total_ticks)
    btc_prices[0] = config.btc_start_price
    for i in range(1, total_ticks):
        step = log_returns[i] + ou_noise[i] + jumps[i]
        step = np.clip(step, -0.05, 0.05)  # clamp per-tick move
        btc_prices[i] = btc_prices[i - 1] * np.exp(step)
        # Keep prices in a realistic range
        btc_prices[i] = np.clip(btc_prices[i], 10000.0, 500000.0)

    # Generate volume (higher near window close)
    base_volume = rng.poisson(50, total_ticks).astype(float)

    # Build MarketWindow objects
    windows = []
    base_epoch = 1700000000  # arbitrary start timestamp

    for w in range(lookback_windows, total_windows):
        tick_start = w * ticks_per_window
        tick_end = tick_start + ticks_per_window

        window_btc = btc_prices[tick_start:tick_end].copy()

        # Add late-window volatility spikes: BTC can move significantly in last
        # 40 seconds (ticks 27-29), making outcomes uncertain at decision time
        for late_t in range(27, ticks_per_window):
            late_shock = rng.normal(0, 0.0015)  # ~0.15% std per late tick
            # 10% chance of a bigger shock
            if rng.random() < 0.10:
                late_shock += rng.normal(0, 0.004)
            window_btc[late_t] = window_btc[late_t] * np.exp(late_shock)

        strike = window_btc[0]  # strike = BTC price at window open
        btc_close = window_btc[-1]
        outcome = 1 if btc_close > strike else 0

        # Generate market prices using BS + noise (simulating market inefficiency)
        market_prices = []
        market_bids = []
        market_asks = []
        market_vols = []
        timestamps = []

        window_vol = max(np.std(np.diff(np.log(window_btc + 1e-10))) * np.sqrt(365.25 * 86400 / tick_dt_sec), 0.1)

        cumulative_vol = 0.0
        for t in range(ticks_per_window):
            elapsed_sec = (t + 1) * tick_dt_sec
            remaining_sec = window_duration_sec - elapsed_sec
            tau = remaining_sec / (365.25 * 86400)

            true_prob = _black_scholes_binary_prob(window_btc[t], strike, config.btc_annual_vol, tau)

            # Market price = true probability + noise
            # Realistic: markets are mostly efficient, edge is small and inconsistent
            noise_scale = 0.04 * (1.0 - 0.3 * elapsed_sec / window_duration_sec) + 0.02
            market_noise = rng.normal(0, noise_scale)

            # Systematic biases (small, inconsistent - this is what makes it hard)
            # 1. Momentum bias: market slightly underreacts to BTC moves
            momentum_bias = 0.0
            if t >= 3:
                recent_return = (window_btc[t] - window_btc[t - 3]) / (window_btc[t - 3] + 1e-10)
                per_tick_vol = window_vol / np.sqrt(365.25 * 86400 / tick_dt_sec) + 1e-10
                momentum_bias = -0.08 * recent_return / per_tick_vol
                momentum_bias = np.clip(momentum_bias, -0.04, 0.04)

            # 2. Anchoring bias: market price is slightly sticky
            anchoring_bias = 0.0
            if t >= 1 and len(market_prices) >= 1:
                anchoring_bias = 0.10 * (market_prices[-1] - true_prob)
                anchoring_bias = np.clip(anchoring_bias, -0.03, 0.03)

            market_price = np.clip(true_prob + market_noise + momentum_bias + anchoring_bias, 0.02, 0.98)

            # Spread narrows as expiry approaches
            half_spread = max(0.005, 0.015 * (1.0 - elapsed_sec / window_duration_sec))
            bid = np.clip(market_price - half_spread, 0.01, 0.97)
            ask = np.clip(market_price + half_spread, 0.03, 0.99)

            # Volume increases near expiry
            vol_multiplier = 1.0 + 2.0 * (elapsed_sec / window_duration_sec)
            tick_volume = base_volume[tick_start + t] * vol_multiplier
            cumulative_vol += tick_volume

            market_prices.append(float(market_price))
            market_bids.append(float(bid))
            market_asks.append(float(ask))
            market_vols.append(float(cumulative_vol))
            timestamps.append(base_epoch + w * window_duration_sec + elapsed_sec)

        # Preceding 30 minutes of BTC prices (6 prior windows, 1 close per window)
        preceding_prices = []
        for pw in range(max(0, w - 6), w):
            pw_end_tick = (pw + 1) * ticks_per_window - 1
            preceding_prices.append(float(btc_prices[pw_end_tick]))
        # Pad if not enough history
        while len(preceding_prices) < 6:
            preceding_prices.insert(0, preceding_prices[0] if preceding_prices else config.btc_start_price)

        window = MarketWindow(
            window_id=f"btc-5m-{w - lookback_windows}",
            epoch_start=base_epoch + w * window_duration_sec,
            epoch_end=base_epoch + (w + 1) * window_duration_sec,
            strike_price=float(strike),
            outcome=outcome,
            market_prices=market_prices,
            market_bids=market_bids,
            market_asks=market_asks,
            market_volumes=market_vols,
            market_timestamps=timestamps,
            btc_open=float(window_btc[0]),
            btc_high=float(np.max(window_btc)),
            btc_low=float(np.min(window_btc)),
            btc_close=float(btc_close),
            btc_volume=float(np.sum(base_volume[tick_start:tick_end])),
            btc_ticks=[float(p) for p in window_btc],
            btc_tick_timestamps=[base_epoch + w * window_duration_sec + (t + 1) * tick_dt_sec for t in range(ticks_per_window)],
            btc_prices_preceding_30m=preceding_prices,
        )
        windows.append(window)

    return windows


def fetch_real_markets(config: Config, num_windows: int) -> list:
    """
    Fetch historical 5-min BTC market data from Polymarket.

    Requires network access to Polymarket's Gamma and CLOB APIs.
    """
    import requests

    # Discover BTC 5-min markets from Gamma API
    resp = requests.get(
        f"{config.gamma_api_url}/markets",
        params={"tag": "btc-5-minute", "closed": "true", "limit": num_windows},
        timeout=30,
    )
    resp.raise_for_status()
    markets_data = resp.json()

    windows = []
    for mkt in markets_data:
        try:
            condition_id = mkt.get("conditionId", "")
            tokens = mkt.get("clobTokenIds", [])
            if not tokens:
                continue

            yes_token = tokens[0]

            # Fetch trade history for this token
            trades_resp = requests.get(
                f"{config.clob_api_url}/trades",
                params={"token_id": yes_token, "limit": 100},
                timeout=15,
            )
            trades_data = trades_resp.json() if trades_resp.ok else []

            # Extract prices from trades
            trade_prices = [float(t.get("price", 0.5)) for t in trades_data]
            trade_timestamps = [int(t.get("timestamp", 0)) for t in trades_data]

            if not trade_prices:
                continue

            outcome_prices = mkt.get("outcomePrices", [])
            outcome = 1 if outcome_prices and float(outcome_prices[0]) > 0.5 else 0

            window = MarketWindow(
                window_id=condition_id,
                epoch_start=int(mkt.get("startDate", 0)),
                epoch_end=int(mkt.get("endDate", 0)),
                strike_price=0.0,  # would need Vatic API for real strike
                outcome=outcome,
                market_prices=trade_prices,
                market_bids=trade_prices,
                market_asks=trade_prices,
                market_volumes=[float(i) for i in range(len(trade_prices))],
                market_timestamps=trade_timestamps,
                btc_open=0.0,
                btc_high=0.0,
                btc_low=0.0,
                btc_close=0.0,
                btc_volume=0.0,
                btc_ticks=trade_prices,
                btc_tick_timestamps=trade_timestamps,
                btc_prices_preceding_30m=[0.0] * 6,
            )
            windows.append(window)
        except Exception:
            continue

    return windows
