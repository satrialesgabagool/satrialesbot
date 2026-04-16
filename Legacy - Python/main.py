"""
Polymarket BTC 5-Minute Binary Market Trading Bot

Usage:
    python main.py                          # Run all strategies with synthetic data
    python main.py --optimize               # Optimize parameters with Optuna
    python main.py --optimize --trials 50   # Optimize with 50 trials
    python main.py --strategy ml_ensemble   # Run only the ensemble strategy
    python main.py --windows 10000          # Use 10k synthetic windows
    python main.py --mode real              # Use real Polymarket data (requires API access)
"""

import argparse
import sys
import time
import warnings
import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning)
from config import Config, DataMode
from data import generate_synthetic_data, fetch_real_markets
from features import build_feature_matrix
from models import (
    BlackScholesBaseline, LogisticModel, GradientBoostingModel,
    EnsembleModel, MomentumModel, MeanReversionModel,
)
from backtest import run_walk_forward_backtest
from optimize import run_optimization
from report import compute_report, print_report, print_comparison_table, plot_results


def validate_synthetic_data(windows: list) -> None:
    """Print data quality checks for synthetic data."""
    outcomes = [w.outcome for w in windows]
    yes_rate = sum(outcomes) / len(outcomes)
    prices = [w.btc_close for w in windows]
    returns = np.diff(np.log(prices))

    print(f"      YES outcome rate: {yes_rate:.1%} (expect ~50%)")
    print(f"      BTC price range: ${min(prices):,.0f} - ${max(prices):,.0f}")
    print(f"      Return std (per window): {np.std(returns):.6f}")

    # Check market price calibration
    market_final_prices = [w.market_prices[-1] for w in windows]
    brier = np.mean([(p - o) ** 2 for p, o in zip(market_final_prices, outcomes)])
    print(f"      Market Brier score: {brier:.4f} (lower = more calibrated)")


def run_single_strategy(name, model, windows, config, decision_tick=26,
                        X_pre=None, y_pre=None):
    """Run walk-forward backtest for a single strategy and return report."""
    folds, trades = run_walk_forward_backtest(
        windows, config, model, decision_tick,
        X_precomputed=X_pre, y_precomputed=y_pre,
    )
    report = compute_report(folds, trades, config)
    report.strategy_name = name
    report.model_params = model.get_params()
    return report


def main():
    parser = argparse.ArgumentParser(
        description="Polymarket BTC 5-min Trading Bot - Backtest & Optimize"
    )
    parser.add_argument("--mode", choices=["synthetic", "real"], default="synthetic",
                        help="Data source (default: synthetic)")
    parser.add_argument("--optimize", action="store_true",
                        help="Run Optuna parameter optimization")
    parser.add_argument("--strategy",
                        choices=["all", "ml_ensemble", "logistic", "xgboost",
                                 "momentum", "mean_reversion"],
                        default="all", help="Strategy to run (default: all)")
    parser.add_argument("--windows", type=int, default=5000,
                        help="Number of 5-min windows (default: 5000)")
    parser.add_argument("--trials", type=int, default=100,
                        help="Optuna optimization trials (default: 100)")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed (default: 42)")
    parser.add_argument("--threshold", type=float, default=None,
                        help="Entry threshold override")
    parser.add_argument("--kelly", type=float, default=None,
                        help="Kelly fraction override")
    args = parser.parse_args()

    # Build config
    config = Config(
        data_mode=DataMode(args.mode),
        synthetic_num_windows=args.windows,
        synthetic_seed=args.seed,
        optuna_n_trials=args.trials,
    )
    if args.threshold is not None:
        config.entry_threshold = args.threshold
    if args.kelly is not None:
        config.kelly_fraction = args.kelly

    print("=" * 70)
    print("  POLYMARKET BTC 5-MIN BINARY MARKET TRADING BOT")
    print("=" * 70)
    print()

    # === Step 1: Data ===
    print(f"[1/5] Loading data ({config.data_mode.value} mode)...")
    t0 = time.time()

    if config.data_mode == DataMode.SYNTHETIC:
        windows = generate_synthetic_data(config)
        print(f"      Generated {len(windows)} synthetic 5-min windows in {time.time()-t0:.1f}s")
        validate_synthetic_data(windows)
    else:
        windows = fetch_real_markets(config, config.synthetic_num_windows)
        print(f"      Fetched {len(windows)} real market windows in {time.time()-t0:.1f}s")

    if len(windows) < config.train_window_size + config.test_window_size:
        print(f"\nERROR: Not enough windows ({len(windows)}) for walk-forward "
              f"(need {config.train_window_size + config.test_window_size})")
        sys.exit(1)

    # === Step 2: Feature engineering preview ===
    print(f"\n[2/5] Engineering features...")
    t0 = time.time()
    X, y = build_feature_matrix(windows)
    print(f"      Feature matrix: {X.shape[0]} samples x {X.shape[1]} features ({time.time()-t0:.1f}s)")
    print(f"      Features: {', '.join(X.columns[:8])}... (+{max(0, len(X.columns)-8)} more)")

    # === Step 3: Optimization (optional) ===
    if args.optimize:
        print(f"\n[3/5] Running Optuna optimization ({config.optuna_n_trials} trials)...")
        t0 = time.time()
        study = run_optimization(windows, config)
        elapsed = time.time() - t0

        print(f"\n      Optimization complete in {elapsed:.1f}s")
        print(f"      Best trial: #{study.best_trial.number}")
        print(f"      Best Sharpe: {study.best_value:.3f}")
        print(f"      Best params:")
        for k, v in study.best_params.items():
            print(f"        {k}: {v}")

        # Use best params for final run
        best = study.best_params
        best_strategy = best.get("strategy", "ensemble")
        config.entry_threshold = best.get("entry_threshold", config.entry_threshold)
        config.kelly_fraction = best.get("kelly_fraction", config.kelly_fraction)
        config.max_position_fraction = best.get("max_position_fraction", config.max_position_fraction)
        config.train_window_size = best.get("train_window", config.train_window_size)
        config.test_window_size = best.get("test_window", config.test_window_size)
        decision_tick = best.get("decision_tick", 26)

        # Build optimized model
        model_map = {
            "logistic": lambda: LogisticModel(C=best.get("lr_C", 1.0)),
            "xgboost": lambda: GradientBoostingModel(
                n_estimators=best.get("xgb_n_estimators", 100),
                max_depth=best.get("xgb_max_depth", 3),
                learning_rate=best.get("xgb_lr", 0.1),
                subsample=best.get("xgb_subsample", 0.8),
                colsample_bytree=best.get("xgb_colsample", 0.8),
                min_child_weight=best.get("xgb_min_child", 5),
            ),
            "ensemble": lambda: EnsembleModel(
                gbm_weight=best.get("gbm_weight", 0.6),
                lr_C=best.get("ens_lr_C", 1.0),
                gbm_n_estimators=best.get("ens_xgb_n_est", 100),
                gbm_max_depth=best.get("ens_xgb_depth", 3),
                gbm_learning_rate=best.get("ens_xgb_lr", 0.1),
                gbm_subsample=best.get("ens_xgb_sub", 0.8),
                gbm_colsample=best.get("ens_xgb_col", 0.8),
                gbm_min_child_weight=best.get("ens_xgb_mcw", 5),
            ),
            "momentum": lambda: MomentumModel(
                momentum_weight=best.get("momentum_weight", 1.0),
                vol_adjustment=best.get("vol_adjustment", 0.5),
            ),
            "mean_reversion": lambda: MeanReversionModel(
                alpha=best.get("mr_alpha", 0.5),
            ),
        }

        print(f"\n[4/5] Running optimized {best_strategy} strategy...")
        t0 = time.time()
        model = model_map[best_strategy]()
        report = run_single_strategy(
            f"Optimized {best_strategy}", model, windows, config, decision_tick
        )
        print(f"      Complete in {time.time()-t0:.1f}s")

        # Also run baseline for comparison
        baseline_report = run_single_strategy(
            "Black-Scholes Baseline", BlackScholesBaseline(), windows, config, decision_tick
        )

        print(f"\n[5/5] Results:\n")
        print_report(baseline_report)
        print()
        print_report(report)
        print_comparison_table([baseline_report, report])

        # Save chart
        plot_results(report, save_path="reports/optimized_strategy.png")

    else:
        # === Step 4: Run selected strategies ===
        print(f"\n[3/5] Skipping optimization (use --optimize to enable)")

        strategies = {
            "all": [
                ("Black-Scholes Baseline", BlackScholesBaseline()),
                ("Logistic Regression", LogisticModel(C=1.0)),
                ("XGBoost", GradientBoostingModel()),
                ("Ensemble (LR+XGB)", EnsembleModel()),
                ("Momentum", MomentumModel()),
                ("Mean Reversion", MeanReversionModel()),
            ],
            "ml_ensemble": [("Ensemble (LR+XGB)", EnsembleModel())],
            "logistic": [("Logistic Regression", LogisticModel(C=1.0))],
            "xgboost": [("XGBoost", GradientBoostingModel())],
            "momentum": [("Momentum", MomentumModel())],
            "mean_reversion": [("Mean Reversion", MeanReversionModel())],
        }

        to_run = strategies.get(args.strategy, strategies["all"])
        print(f"\n[4/5] Running walk-forward backtest ({len(to_run)} strategies)...")

        reports = []
        for name, model in to_run:
            t0 = time.time()
            print(f"      Running: {name}...", end=" ", flush=True)
            report = run_single_strategy(name, model, windows, config,
                                         X_pre=X, y_pre=y)
            print(f"({time.time()-t0:.1f}s, {report.total_trades} trades)")
            reports.append(report)

        # === Step 5: Report ===
        print(f"\n[5/5] Results:\n")
        for report in reports:
            print_report(report)
            print()

        if len(reports) > 1:
            print_comparison_table(reports)

        # Find and plot best strategy
        trading_reports = [r for r in reports if r.total_trades > 0]
        if trading_reports:
            best = max(trading_reports, key=lambda r: r.sharpe_ratio)
            plot_results(best, save_path="reports/best_strategy.png")
            print(f"\nBest strategy: {best.strategy_name} "
                  f"(Sharpe: {best.sharpe_ratio:.3f}, PnL: ${best.total_pnl:,.2f})")

    print("\nDone.")


if __name__ == "__main__":
    main()
