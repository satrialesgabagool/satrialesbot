# Satriales — Polymarket BTC/ETH Binary Trading Bot

## Project Overview
Automated paper-trading bot for Polymarket's 5-min and 15-min Up/Down binary
markets on BTC and ETH. Starting bankroll: **$20**. Goal: compound to
**$100/day**.

## Current Strategy: **v3 Snipe Trader** (bonereaper-inspired)

As of 2026-04-15, the bot runs a pure **post-close / late-window sniping**
strategy — no ML models, no predictors. It watches Binance US spot price and
buys the already-winning side on Polymarket while liquidity is still stale.

**Verified performance:** 16 snipes, **16W/0L (100% WR)**, $20 → $32.88
(+64%) over ~50 min of live paper trading on 2026-04-15.
Ground-truth audited against independent Binance US klines — 0 mismatches.

Three stages per window, sized by spot-move conviction:
| Stage      | Window         | Price gate | Entry condition               |
|------------|----------------|------------|-------------------------------|
| pre_close  | T-60s to T-15s | winner ≤$0.80 | Spot moved ≥0.05%           |
| at_close   | T-10s to T+10s | winner ≤$0.90 | Spot moved ≥0.05%           |
| post_close | T+10s to T+90s | winner ≤$0.95 | Spot moved ≥0.05%, still open |

Conviction-based sizing:
- Weak  (0.05–0.15% move): **$1 flat**
- Medium (0.15–0.30% move): **5% of bankroll**
- Strong (≥0.30% move)    : **15% of bankroll** (25% max cap)

## Key Files (current)
- `snipe_trader.py` — **PRIMARY entry point.** v3 bonereaper snipe bot
- `live_trader.py` — Shared infrastructure (PolymarketFeed, ASSETS, TIMEFRAMES,
  PendingTrade). Still contains the legacy ML hybrid trader, retained because
  snipe_trader imports its feed classes. DO NOT run `live_trader.py` directly
  as the primary strategy — use `snipe_trader.py`.
- `config.py` — Central config ($20 bankroll, $1 min bet)
- `db.py` — SQLite persistence layer
- `signals.py` — Fee calc, Kelly sizing (used by legacy ML paths)
- `data.py`, `features.py`, `models.py`, `backtest.py`, `report.py` — Legacy
  ML/backtest utilities, kept for reference and the `main.py` backtest CLI.

## Running (primary)
```bash
python snipe_trader.py                          # Unlimited, BTC+ETH, 5m+15m
python snipe_trader.py --hours 8                # Run for 8 hours
python snipe_trader.py --assets btc --no-15m    # BTC 5m only
python snipe_trader.py --bankroll 50            # Start with $50
python snipe_trader.py --db snipe.db            # Separate DB (default)
```

The `START_TRADER.bat` launcher points at `snipe_trader.py`.

## Archived: Legacy ML Version
The earlier ML-based hybrid trader (ensemble/logistic/xgboost/mean-reversion
with embedded snipes) lives on the **`legacy-ml` branch** of this repo for
reference. It showed 53.6% WR on its main ML path with -$2.51 PnL — snipes
were carrying it. The pure-snipe v3 variant dominates it cleanly, so the ML
pipeline is retired.

To check out the legacy version:
```bash
git checkout legacy-ml
```

## Critical Rules
- ALWAYS use $20 initial bankroll — never inflate numbers
- Show bust risk honestly — if a strategy dies on $20, say so
- Min bet $1, max bet 25% of bankroll (cap)
- Only make edits on the `clog` branch. `main` is read-only for data/code
  retrieval.
- Delete `snipe.db` before re-running with config changes you want to isolate

## Current Best Result (2026-04-15, verified against Binance)
v3 snipe_trader: $20 → $32.88 (+64%), 16W/0L (100%), 50 min, +$0.80/snipe avg

## Pending Work
- Run v3 for a full 24h to validate sustained edge
- Consider bumping conviction sizing once sample is ≥100 trades
- Dispatch/scheduled tasks not yet connected (auth issue)
- Check TASKS.md for any instructions left by user while away
