"""Central configuration for the Polymarket BTC 5-min trading bot."""

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class DataMode(Enum):
    SYNTHETIC = "synthetic"
    REAL = "real"


class StrategyType(Enum):
    MOMENTUM = "momentum"
    MEAN_REVERSION = "mean_reversion"
    ML_ENSEMBLE = "ml_ensemble"


@dataclass
class Config:
    # --- Data source ---
    data_mode: DataMode = DataMode.SYNTHETIC
    synthetic_num_windows: int = 5000
    synthetic_seed: int = 42

    # --- Real API endpoints ---
    gamma_api_url: str = "https://gamma-api.polymarket.com"
    clob_api_url: str = "https://clob.polymarket.com"

    # --- BTC synthetic parameters ---
    btc_start_price: float = 84000.0
    btc_annual_vol: float = 0.65
    btc_annual_drift: float = 0.0
    btc_tick_interval_sec: int = 10
    btc_ticks_per_window: int = 30  # 30 ticks * 10s = 300s = 5 min

    # --- Polymarket fee model (crypto taker) ---
    # fee_per_share = fee_rate * price * (1 - price)
    fee_rate: float = 0.072

    # --- Walk-forward backtest ---
    train_window_size: int = 500
    test_window_size: int = 100
    step_size: int = 50
    min_trades_to_evaluate: int = 20

    # --- Signal / position sizing ---
    entry_threshold: float = 0.04
    max_position_fraction: float = 0.20        # max 20% of bankroll per trade
    kelly_fraction: float = 0.15               # conservative 15% Kelly
    initial_bankroll: float = 20.0             # start with $20
    min_bankroll: float = 0.50                 # bust threshold
    min_bet_size: float = 1.0                  # Polymarket min order ~$1
    max_bet_size: float = 50.0                 # hard cap per trade (scales up as bankroll grows)
    daily_target: float = 100.0                # $100/day goal for reporting

    # --- Optuna optimization ---
    optuna_n_trials: int = 100
    optuna_timeout: Optional[int] = 300

    # --- Reporting ---
    report_output_dir: str = "reports"

    # --- Simulation ---
    windows_per_day: int = 288                 # 24h * 60min / 5min = 288 windows per day
