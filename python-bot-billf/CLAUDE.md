# Satriales — BTC Binary-Market Trading Bot (Polymarket + Kalshi)

## Project Overview
Automated paper-trading bot for short-horizon Bitcoin binary markets.
Starting bankroll: **$20**. Goal: compound to **$100/day**.

### Venue status (2026-04-15 pivot)
- **Polymarket (v3 snipe_trader)** — verified edge, 100% WR on the initial
  16-snipe sample. Retained as the reference implementation, but is
  **not legally accessible to US residents** and therefore cannot be
  traded live from the current operator location. Runs on paper only.
- **Kalshi (kalshi_snipe_trader)** — new primary venue. CFTC-regulated
  US exchange. BTC markets are daily-horizon with strike-based "greater
  than X" (KXBTCD, $734k OI) and range "between X and Y" (KXBTC, $147k
  OI). Port of the snipe thesis to strike-ladder sniping. Paper by
  default; `--live` flag plus `KALSHI_KEY_ID`/`KALSHI_PRIVATE_KEY`
  needed to place real orders.
- **Weather (kalshi-weather-live.ts)** — backtested 2026-04-15,
  **no edge** (23.7% WR, -0.8% ROI on 38 trades). Paper only; real
  execution shim wired but not enabled by default.

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

Conviction-based sizing (fallback floor):
- Weak  (0.05–0.15% move): **$1 flat**
- Medium (0.15–0.30% move): **5% of bankroll**
- Strong (≥0.30% move)    : **15% of bankroll** (25% max cap)

**Kelly risk sizing (primary, since 2026-04-15):** On top of the conviction
floor, the bot now sizes bets using fractional Kelly against the empirical
win rate of each `(stage, conviction)` bucket, smoothed with a Beta(2,2)
prior. For price `q` and smoothed win probability `p`:

```
kelly_f = (p - q) / (1 - q)       # 0 if p <= q
size    = max(conviction_floor, kelly_fraction * kelly_f * bankroll)
size    = min(size, 0.25 * bankroll)    # hard cap stays at 25%
```

Default `kelly_fraction = 0.50` (half-Kelly). Buckets with fewer than
`kelly_min_samples` (5) pool half-weight with their stage siblings for
the probability estimate. Backtest on the 41 audited historical trades:
- Conviction sizing (baseline): $20 → $61 (+207%)
- **Half-Kelly (default):      $20 → $1,836 (+9,079%)**
- Full-Kelly (aggressive):     $20 → $3,208 (+15,943%)

> ⚠️  **Honesty caveat on the Kelly backtest.** The p used in Kelly was
> the empirical bucket WR of the same 41 trades that the backtest was
> evaluated on — so it is *in-sample* and trivially benefits from
> perfect bucket knowledge the live bot won't have on day one. Treat
> the $1,836 number as an upper bound, not an expected live outcome.
> The Bayesian prior + min-sample gate + hard 25% cap exist to keep the
> live path sane while real per-bucket WRs accumulate.

All Kelly config is on `SnipeConfig` (`use_kelly`, `kelly_fraction`,
`kelly_min_samples`, `kelly_prior_alpha/beta`, `kelly_min_p`).

## Kalshi BTC Snipe Trader (2026-04-15 addition)

`kalshi_snipe_trader.py` ports the same thesis to Kalshi's KXBTCD /
KXBTC BTC markets. Differences from the Polymarket v3:

| Aspect             | Polymarket v3                       | Kalshi BTC                              |
|--------------------|-------------------------------------|-----------------------------------------|
| Window cadence     | Every 5 min / 15 min                | Daily-ish (1am EDT + 5pm EDT settles)   |
| Payoff granularity | Single YES/NO per window            | 80-188 strikes per event                |
| Fire trigger       | Spot move % since window open       | Spot distance from strike at time-of-fire |
| Stage model        | pre_close / at_close / post_close   | prime (≤2m) / late (≤5m) / wide (≤10m)  |
| Conviction signal  | |spot move %|                       | |spot − strike| ($)                     |
| Execution          | Paper only (US legal blocker)       | Paper default; `--live` wires real orders via RSA-PSS-signed REST |

Kalshi snipe runner config (see `KalshiSnipeConfig`):
- Distance gates: `weak ≥ $50`, `medium ≥ $150`, `strong ≥ $300`
- Time gates: prime ≤ 120s, late ≤ 300s, wide ≤ 600s, min 10s, max 600s
- Price gates: `0.55 ≤ winner ≤ 0.95`
- Same Kelly sizing math — bucket stats mirror the Polymarket hunter

`kalshi_feed.py` supplies `KalshiFeed` (read-only market data) and
`KalshiOrderClient` (auth-gated `place_limit_buy`, `cancel`, balance,
positions). Credentials load via env (`KALSHI_KEY_ID` + either
`KALSHI_PRIVATE_KEY` or `KALSHI_PRIVATE_KEY_PATH`). `cryptography`
package is only imported when signing is needed.

Smoke-test results (2026-04-15, paper, live production market data):
7 snipes fired in ~2 minutes on KXBTCD-26APR1601 / KXBTC-26APR1601
against actual stale asks. Resolution pending at event close.

## Key Files (current)

### Polymarket path (paper only, legal blocker for US ops)
- `snipe_gui.py` — **Desktop dashboard.** Runs the Polymarket hunter in a
  background thread with dark-themed tkinter + matplotlib charts.
  `START_TRADER.bat` launches this.
- `snipe_trader.py` — **Polymarket v3 engine.** The bonereaper snipe bot.
  Can be run headless; the GUI imports its `SnipeHunter` class.
- `live_trader.py` — `PolymarketFeed`, `ASSETS`, `TIMEFRAMES`,
  `PendingTrade`. Shared infra + the retired ML hybrid.

### Kalshi path (live-capable)
- `kalshi_feed.py` — **Kalshi client.** `KalshiFeed` (read-only market
  data) + `KalshiOrderClient` (auth-gated orders) + `KalshiCredentials`
  (loader). Mirrors the TS `KalshiClient` on the main branch.
- `kalshi_snipe_trader.py` — **Kalshi BTC snipe engine.** Strike-ladder
  port of snipe_trader. Paper default; `--live` enables real orders on
  demo/prod environment. Config class: `KalshiSnipeConfig`.
- `kalshi_probe.py` — One-shot CLI that prints live BTC events, strikes
  near spot, and any currently-exploitable stale asks. Useful for
  eyeballing whether the snipe book has juice right now.

### Shared
- `config.py` — Central config ($20 bankroll, $1 min bet)
- `db.py` — SQLite persistence layer (shared across Polymarket v3 and
  Kalshi snipe — discriminated by `window_id` prefix)
- `signals.py` — Fee calc
- `data.py`, `features.py`, `models.py`, `backtest.py`, `report.py` — Legacy
  ML/backtest utilities.

## Running (primary)

### Polymarket (paper, reference)
```bash
# Desktop GUI (what START_TRADER.bat launches)
python snipe_gui.py                             # Opens dashboard window
python snipe_gui.py --assets btc --bankroll 50  # Flags forward to hunter

# Headless CLI
python snipe_trader.py                          # Unlimited, BTC+ETH, 5m+15m
python snipe_trader.py --hours 8                # Run for 8 hours
python snipe_trader.py --assets btc --no-15m    # BTC 5m only
python snipe_trader.py --bankroll 50            # Start with $50
```

### Kalshi BTC (paper default; live only with explicit flag+creds)
```bash
# Paper (production market data, no orders placed)
python kalshi_snipe_trader.py                   # Unlimited, $20 bankroll
python kalshi_snipe_trader.py --hours 8 --bankroll 50

# Quick visual probe of current opportunities
python kalshi_probe.py

# Demo env (authenticated, sandbox balance)
export KALSHI_KEY_ID=<uuid>
export KALSHI_PRIVATE_KEY_PATH=<path-to-pem>
python kalshi_snipe_trader.py --demo --live

# Production LIVE orders (real money — 5s abort window on startup)
python kalshi_snipe_trader.py --live
```

## GUI layout
The desktop dashboard (`snipe_gui.py`) shows:
- **Header**: bankroll, total P&L, ROI, win rate, peak, drawdown, snipes
  count, uptime + pause/resume button
- **Active markets**: live spot price, Polymarket YES/NO prices, spot move
  since window open, current stage, time to close — for BTC/ETH x 5m/15m
- **Bankroll curve**: matplotlib line chart of bankroll over time
- **Pending snipes**: active bets with entry, current Poly price, and
  mark-to-market unrealized P&L
- **Stage/conviction P&L bar chart**: breakdown of where profit comes from
- **Statistics table**: W/L/PnL grouped by stage, conviction, and market
- **Recent trades log**: scrolling color-coded event feed

Refreshes every 2 seconds. Hunter runs as a daemon thread so closing the
window cleanly exits the process.

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
- **Polymarket v3** snipe_trader: $20 → $32.88 (+64%), 16W/0L (100%),
  50 min, +$0.80/snipe avg. Paper only (US legal blocker).
- **Kalshi** kalshi_snipe_trader: smoke test passed, 7 snipes fired in
  2 min against live KXBTCD/KXBTC strikes, resolution pending at first
  22:00-local event close. Per-bucket WR TBD.

## Pending Work
- **Kalshi BTC: accumulate ≥100 snipes in paper mode** before flipping
  `--live`. Kelly's bucket stats need real samples; demo-env fills
  don't count toward p for the production bot.
- Compare Kalshi WR against Polymarket WR per stage/conviction — the
  distance-based conviction model is new and unproven.
- Observe the 22:00-local settle cycle vs the 5pm EDT cycle to see if
  one consistently gives more edge (likely the 22:00-local close has
  thinner liquidity and staler asks).
- Wire a GUI for the Kalshi bot (reuse snipe_gui.py patterns — the
  hunter exposes the same `events` ring, `bankroll`, `pending`, stats
  dicts as the Polymarket hunter).
- Watch Kelly sizing on live runs: confirm it hits the 25% cap on
  thick-edge buckets and falls back to conviction on sparse/low-edge.
- Consider dropping `kelly_fraction` toward 0.25 if live drawdowns
  exceed ~30% in any 50-trade window; bumping to 0.75 if growth is
  steady and drawdown stays under 15%.
- Weather strategy retired from the recommended path — backtest on
  2026-04-15 showed 23.7% WR / -0.8% ROI on 38 simulated trades. The
  WeatherSimulator `OrderExecutor` hook exists but is not recommended
  to enable until an edge is demonstrated against *real* Kalshi book
  prices (not a simulated wider-sigma market).
- Dispatch/scheduled tasks not yet connected (auth issue)
- Check TASKS.md for any instructions left by user while away
