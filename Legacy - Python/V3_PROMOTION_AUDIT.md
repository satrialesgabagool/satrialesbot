# v3 Snipe Trader Promotion Audit — 2026-04-15

## Why we promoted snipe_trader over live_trader

Live paper-trading side-by-side for ~1 hour on BTC/ETH Up-Down 5m & 15m markets,
both bots starting from $20.

## Final numbers (verified against Binance US klines)

| Bot                        | Trades | WR      | PnL      | Bankroll      |
|----------------------------|--------|---------|----------|---------------|
| **v3 snipe_trader** (new) | **16** | **100%**| **+$12.88** | **$20 → $32.88** |
| v2 live_trader (ML)        | 28 main + 11 snipe = 39 | 66.7% | +$4.44 | $20 → $21.42 |
| v2 main ML path alone      | 28     | 53.6%   | **-$2.51** | lost money |
| v2 internal snipes         | 11     | 100%    | +$6.95   | saved v2 |
| TS orchestrator simulation | ~10    | —       | -$6.25   | lost money |

## Binance ground-truth audit

Independently refetched each trade's window open/close from Binance US 1-minute
klines and compared to the DB-recorded outcome.

| Bot            | Trades audited | Match | Mismatch |
|----------------|----------------|-------|----------|
| v3 snipes      | 16             | **16 (100%)** | 0 |
| v2 ML main     | 28             | 24 (86%) | 4 |
| v2 snipes      | 11             | 9 (82%)  | 2 |

The v2 "mismatches" were all on windows where Binance 1-min klines
registered a FLAT/near-zero move, but Polymarket's resolution oracle still
picked a direction. v3's ≥0.05% spot-move entry filter automatically avoids
these ambiguous windows, which is why it has zero mismatches.

## v3 stage breakdown (all 16 resolved)

| Stage       | Trades | WR   | PnL    |
|-------------|--------|------|--------|
| pre_close   | 6      | 100% | +$4.44 |
| at_close    | 5      | 100% | +$3.88 |
| post_close  | 5      | 100% | +$4.56 |

By conviction:
- Weak  (≥0.05% move): 5/5, +$3.36
- Medium(≥0.15% move): 3/3, +$1.93
- Strong(≥0.30% move): 8/8, +$7.59

By market:
- btc-5m:  13/13, +$11.34
- eth-15m: 3/3,   +$1.54

## Decision

Retire the ML pipeline (logistic / XGBoost / ensemble / mean-reversion) as the
primary trade decision engine. It was losing money on its own (-$2.51 on the
main ML path) — only the embedded snipe logic inside it was profitable.

The dedicated `snipe_trader.py` strategy:
- Doesn't require model training (no cold-start problem)
- Doesn't care about market regime (pure liquidity-lag arb)
- Has a natural FLAT-window filter via its ≥0.05% move requirement
- Scales cleanly via the conviction-based sizing table

Archived the ML version to the `legacy-ml` branch on GitHub. `snipe_trader.py`
is now the primary entry point and `START_TRADER.bat` launches it.
