"""Walk-forward backtesting engine."""

from dataclasses import dataclass, field
import numpy as np
import pandas as pd
from config import Config
from data import MarketWindow
from models import ProbabilityModel
from signals import generate_signal, Signal


@dataclass
class TradeResult:
    window_id: str
    side: str
    entry_price: float
    fee_paid: float
    total_cost_per_share: float
    shares: float
    outcome: int
    pnl: float
    bankroll_after: float
    model_prob: float
    market_prob: float
    edge: float


@dataclass
class WalkForwardFold:
    fold_index: int
    train_range: tuple  # (start_idx, end_idx)
    test_range: tuple
    trades: list
    abstentions: int
    fold_pnl: float
    fold_win_rate: float


def _generate_folds(n_windows: int, train_size: int, test_size: int,
                    step_size: int) -> list:
    """Generate walk-forward fold indices."""
    folds = []
    start = 0
    fold_idx = 0
    while start + train_size + test_size <= n_windows:
        folds.append({
            "fold_index": fold_idx,
            "train": (start, start + train_size),
            "test": (start + train_size, start + train_size + test_size),
        })
        start += step_size
        fold_idx += 1
    return folds


def run_walk_forward_backtest(
    windows: list,
    config: Config,
    model: ProbabilityModel,
    feature_decision_tick: int = 26,
    X_precomputed: pd.DataFrame = None,
    y_precomputed: pd.Series = None,
) -> tuple:
    """
    Walk-forward backtesting engine using pre-computed features for speed.

    For each fold:
    1. Train model on training window features
    2. For each test window, predict probability and generate signal
    3. Track bankroll sequentially through test period

    Returns (list[WalkForwardFold], list[TradeResult])
    """
    # Pre-compute all features once if not provided
    if X_precomputed is None or y_precomputed is None:
        from features import build_feature_matrix
        X_precomputed, y_precomputed = build_feature_matrix(windows, feature_decision_tick)

    X = X_precomputed
    y = y_precomputed

    # Pre-extract market prices at decision tick for all windows
    market_probs = []
    for w in windows:
        mkt_idx = min(feature_decision_tick, len(w.market_prices) - 1)
        market_probs.append(w.market_prices[mkt_idx])

    n = len(windows)
    fold_specs = _generate_folds(n, config.train_window_size,
                                 config.test_window_size, config.step_size)

    all_folds = []
    all_trades = []
    bankroll = config.initial_bankroll

    for spec in fold_specs:
        train_start, train_end = spec["train"]
        test_start, test_end = spec["test"]

        X_train = X.iloc[train_start:train_end]
        y_train = y.iloc[train_start:train_end]

        # Need both classes in training data
        if len(y_train.unique()) < 2:
            continue

        # Fit model on training data
        model.fit(X_train, y_train)

        # Predict all test windows at once (vectorized)
        X_test = X.iloc[test_start:test_end]
        model_probs = model.predict_proba(X_test)

        fold_trades = []
        fold_abstentions = 0

        for j, i in enumerate(range(test_start, test_end)):
            if bankroll < config.min_bankroll:
                break

            model_prob = float(model_probs[j])
            market_prob = market_probs[i]

            signal = generate_signal(
                window_id=windows[i].window_id,
                model_prob=model_prob,
                market_prob=market_prob,
                bankroll=bankroll,
                config=config,
            )

            if signal.side == "ABSTAIN":
                fold_abstentions += 1
                continue

            # Execute trade and resolve
            outcome = windows[i].outcome
            won = (signal.side == "YES" and outcome == 1) or \
                  (signal.side == "NO" and outcome == 0)

            if won:
                payout_per_share = 1.0 - signal.total_cost
                pnl = payout_per_share * signal.shares
            else:
                pnl = -signal.total_cost * signal.shares

            bankroll += pnl

            trade = TradeResult(
                window_id=windows[i].window_id,
                side=signal.side,
                entry_price=signal.entry_price,
                fee_paid=signal.fee_per_share * signal.shares,
                total_cost_per_share=signal.total_cost,
                shares=signal.shares,
                outcome=outcome,
                pnl=pnl,
                bankroll_after=bankroll,
                model_prob=model_prob,
                market_prob=market_prob,
                edge=signal.edge,
            )
            fold_trades.append(trade)
            all_trades.append(trade)

        wins = sum(1 for t in fold_trades if t.pnl > 0)
        fold_pnl = sum(t.pnl for t in fold_trades)
        fold_win_rate = wins / len(fold_trades) if fold_trades else 0.0

        fold = WalkForwardFold(
            fold_index=spec["fold_index"],
            train_range=spec["train"],
            test_range=spec["test"],
            trades=fold_trades,
            abstentions=fold_abstentions,
            fold_pnl=fold_pnl,
            fold_win_rate=fold_win_rate,
        )
        all_folds.append(fold)

    return all_folds, all_trades
