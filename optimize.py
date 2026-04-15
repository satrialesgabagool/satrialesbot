"""Optuna-based strategy parameter optimization."""

import numpy as np
import optuna
from config import Config
from models import (
    LogisticModel, GradientBoostingModel, EnsembleModel,
    MomentumModel, MeanReversionModel,
)
from backtest import run_walk_forward_backtest

# Suppress Optuna info logs
optuna.logging.set_verbosity(optuna.logging.WARNING)


def _compute_sharpe(trades: list) -> float:
    """Compute Sharpe ratio from trade results."""
    if len(trades) < 5:
        return -10.0
    returns = [t.pnl / (t.total_cost_per_share * t.shares) if t.shares > 0 else 0.0
               for t in trades]
    mean_ret = np.mean(returns)
    std_ret = np.std(returns)
    if std_ret < 1e-10:
        return 0.0
    # Annualize assuming ~288 5-min windows per day, 365 days
    return float(mean_ret / std_ret * np.sqrt(min(len(returns), 288 * 365)))


def objective(trial: optuna.Trial, windows: list, base_config: Config) -> float:
    """Single Optuna trial: suggest params, run walk-forward, return Sharpe."""

    # Strategy selection
    strategy = trial.suggest_categorical("strategy",
                                         ["logistic", "xgboost", "ensemble",
                                          "momentum", "mean_reversion"])

    # Signal parameters
    entry_threshold = trial.suggest_float("entry_threshold", 0.02, 0.15)
    kelly_fraction = trial.suggest_float("kelly_fraction", 0.05, 0.50)
    max_pos_frac = trial.suggest_float("max_position_fraction", 0.05, 0.40)
    decision_tick = trial.suggest_int("decision_tick", 20, 28)

    # Walk-forward parameters
    train_window = trial.suggest_int("train_window", 200, 800, step=50)
    test_window = trial.suggest_int("test_window", 50, 200, step=25)

    # Override config
    config = Config(
        data_mode=base_config.data_mode,
        synthetic_num_windows=base_config.synthetic_num_windows,
        synthetic_seed=base_config.synthetic_seed,
        entry_threshold=entry_threshold,
        kelly_fraction=kelly_fraction,
        max_position_fraction=max_pos_frac,
        train_window_size=train_window,
        test_window_size=test_window,
        step_size=base_config.step_size,
        initial_bankroll=base_config.initial_bankroll,
    )

    # Build model based on strategy
    if strategy == "logistic":
        lr_C = trial.suggest_float("lr_C", 0.01, 100.0, log=True)
        model = LogisticModel(C=lr_C)

    elif strategy == "xgboost":
        model = GradientBoostingModel(
            n_estimators=trial.suggest_int("xgb_n_estimators", 30, 300),
            max_depth=trial.suggest_int("xgb_max_depth", 2, 6),
            learning_rate=trial.suggest_float("xgb_lr", 0.01, 0.3, log=True),
            subsample=trial.suggest_float("xgb_subsample", 0.5, 1.0),
            colsample_bytree=trial.suggest_float("xgb_colsample", 0.4, 1.0),
            min_child_weight=trial.suggest_int("xgb_min_child", 1, 20),
        )

    elif strategy == "ensemble":
        gbm_weight = trial.suggest_float("gbm_weight", 0.2, 0.8)
        model = EnsembleModel(
            gbm_weight=gbm_weight,
            lr_C=trial.suggest_float("ens_lr_C", 0.01, 100.0, log=True),
            gbm_n_estimators=trial.suggest_int("ens_xgb_n_est", 30, 300),
            gbm_max_depth=trial.suggest_int("ens_xgb_depth", 2, 6),
            gbm_learning_rate=trial.suggest_float("ens_xgb_lr", 0.01, 0.3, log=True),
            gbm_subsample=trial.suggest_float("ens_xgb_sub", 0.5, 1.0),
            gbm_colsample=trial.suggest_float("ens_xgb_col", 0.4, 1.0),
            gbm_min_child_weight=trial.suggest_int("ens_xgb_mcw", 1, 20),
        )

    elif strategy == "momentum":
        model = MomentumModel(
            momentum_weight=trial.suggest_float("momentum_weight", 0.1, 3.0),
            vol_adjustment=trial.suggest_float("vol_adjustment", 0.0, 1.0),
        )

    elif strategy == "mean_reversion":
        model = MeanReversionModel(
            alpha=trial.suggest_float("mr_alpha", 0.1, 0.9),
        )
    else:
        return -10.0

    # Pre-compute features for this decision tick
    from features import build_feature_matrix
    try:
        X, y = build_feature_matrix(windows, decision_tick)
        folds, trades = run_walk_forward_backtest(
            windows, config, model, feature_decision_tick=decision_tick,
            X_precomputed=X, y_precomputed=y,
        )
    except Exception:
        return -10.0

    if len(trades) < base_config.min_trades_to_evaluate:
        return -10.0

    return _compute_sharpe(trades)


def run_optimization(windows: list, config: Config) -> optuna.Study:
    """Create and run Optuna study."""
    study = optuna.create_study(
        direction="maximize",
        sampler=optuna.samplers.TPESampler(seed=config.synthetic_seed),
        pruner=optuna.pruners.MedianPruner(n_startup_trials=10, n_warmup_steps=3),
    )

    study.optimize(
        lambda trial: objective(trial, windows, config),
        n_trials=config.optuna_n_trials,
        timeout=config.optuna_timeout,
        show_progress_bar=True,
    )

    return study
