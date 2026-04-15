# Satriales — Polymarket BTC 5-Min Trading Bot

## Project Overview
Automated trading bot for Polymarket's 5-minute Bitcoin binary markets.
Starting bankroll: **$20**. Goal: compound to **$100/day**.

## Key Files
- `config.py` — Central config ($20 bankroll, $1 min bet, 15% Kelly)
- `main.py` — CLI backtest runner (all 6 strategies)
- `simulator.py` — 24/7 unattended paper trading (saves to SQLite)
- `dashboard.py` — Dash web GUI on port 8050
- `data.py` — Synthetic GBM data + real Polymarket API
- `features.py` — 25 engineered features with temporal discipline
- `models.py` — 6 probability models (BS, LR, XGB, Ensemble, Momentum, MeanReversion)
- `signals.py` — Position sizing with Kelly criterion + bet limits
- `backtest.py` — Walk-forward engine
- `report.py` — Performance metrics and display
- `db.py` — SQLite persistence layer
- `collector.py` — Live/synthetic data collection

## Running
```bash
python -W ignore main.py              # Full backtest, all strategies
python -W ignore main.py --optimize   # With Optuna hyperparameter search
python simulator.py --hours 8         # Run simulator for 8 hours
python dashboard.py                   # Launch dashboard at localhost:8050
```

## Critical Rules
- ALWAYS use $20 initial bankroll — never inflate numbers
- Show bust risk honestly — if a strategy dies on $20, say so
- Min bet $1, max bet $50 (scales with bankroll)
- Delete `satriales.db` before re-running simulator with config changes

## Current Best Result (2026-04-13)
Ensemble (LR+XGB): $20 → $102 over 31 sim days, $2.65/day, +410% ROI, 43% max drawdown

## Pending Work
- Dispatch/scheduled tasks not yet connected (auth issue)
- Check TASKS.md for any instructions left by user while away
