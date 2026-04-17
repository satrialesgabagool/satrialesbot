# Signal Improvements — Prioritized Fix List

Companion to `LOSS_DIAGNOSIS.md`. Each item below is scoped to a
specific file/line and estimated for implementation complexity. The
ordering reflects expected impact on real P&L, not ease of
implementation.

---

## Tier 1 — Unblock honest evaluation (no trading decisions should be made until these land)

### 1.1 Real resolution against Kalshi actuals (not `Math.random()`)
**Impact:** Eliminates circular validation. This is the difference
between "my math is internally consistent" and "my model beats the
market."
**Where:** `src/dashboard/paper-trader.ts:490` — replace the Bernoulli
draw with a lookup of the real Kalshi market resolution.
**How:** Extend `KalshiClient` to expose `getMarketResult(ticker) →
{resolved: boolean, outcome: 'yes'|'no'|null}`. In
`resolvePositions()` (paper-trader.ts:594), for LIVE mode, call that
instead of using the pre-drawn `outcomeWin`. Keep the Bernoulli path
for BACKTEST mode (it's fine as a sandbox there).
**Complexity:** MEDIUM. Requires a single new Kalshi endpoint binding
and ~20 lines of paper-trader changes. One unit test (mock
KalshiClient) covers it.

### 1.2 Archive-forecast API in backtest-runner
**Impact:** Removes lookahead bias. Backtest P&L becomes
interpretable.
**Where:** `src/dashboard/backtest-runner.ts:171-194` (`fetchForecasts`).
**How:** Swap `FORECAST_API` from
`https://api.open-meteo.com/v1/forecast` (live, returns current
forecast with past-days padding) to
`https://historical-forecast-api.open-meteo.com/v1/forecast` with
`start_date` and `end_date`. That API returns the forecast *as it was
issued* at a given point in time — no hindsight.
**Complexity:** LOW. 10-line change to the URL and query params; all
downstream code keeps working. 1-2 hours.

### 1.3 Independent market price replay in backtest-runner
**Impact:** Eliminates the "edge = difference of two sigmas" artifact.
**Where:** `src/dashboard/backtest-runner.ts:336-344` (synthetic
`marketBase + noise`).
**How:** Option A (cheap): perturb market price with a seeded noise
source that's INDEPENDENT of the model's σ — e.g., sample a spread
from the historical Kalshi orderbook distribution for weather
markets. Option B (correct): ingest historical Kalshi trade prints
and replay them. Option A is fine for a month while Option B is built.
**Complexity:** LOW for Option A (edit one function). HIGH for Option
B (requires Kalshi archive scraper + storage).

---

## Tier 2 — Signal quality improvements (implement after Tier 1)

### 2.1 Empirical σ per (city, horizon)
**Impact:** Model probabilities become honest. Tight brackets stop
getting inflated.
**Where:** `src/weather/WeatherEnsemble.ts:285-329`.
**How:** Add a small rolling store at `state/sigma-calibration.json`
recording {forecast, actual, horizon, city, date}. Once a day, recompute
per-bucket empirical stddev. Replace the hardcoded σ schedule with a
lookup from that store, fall back to the hardcoded value if the bucket
has <30 observations.
**Complexity:** MEDIUM. New file, new cron-ish job, one swap in
`ensembleBracketProbability`.

### 2.2 Ensemble-agreement filter
**Impact:** Reduces false positives when one forecast model is an
outlier. Cuts signal count; raises signal quality.
**Where:** `src/kalshi/weather/KalshiEnsemble.ts:104-181`, or a new
gate in `WeatherScanner.ts:196`.
**How:** After building the ensemble, compute population stddev of the
member highs. If `spread > threshold_F` (start at 3°F), mark the
signal as `lowAgreement` in metadata. In `WeatherScanner`, skip
signals where `lowAgreement` is true. Expose the threshold as a
CLI flag.
**Complexity:** LOW. 15 lines + one new flag.

### 2.3 Time-to-resolution gate
**Impact:** Avoids trading in the last hour when markets are efficient
and liquidity is thin.
**Where:** `src/dashboard/paper-trader.ts:353` (`placeTrade`, right
before the edge gate).
**How:** Add a new CLI flag `--min-hours-to-resolve 2`. In
`placeTrade`, compute `hoursLeft = (resolvesAtMs - placedAtMs) /
3_600_000` and return early if `hoursLeft < minHoursToResolve`.
**Complexity:** LOW. 10 lines.

### 2.4 Signal staleness check
**Impact:** Prevents trading on forecasts that are >N hours old (e.g.,
if the scanner was paused or the upstream API was slow).
**Where:** `src/weather/WeatherScanner.ts` — stamp
`metadata.forecastIssuedAt` on every signal. In `paper-trader.ts`,
reject if `now - forecastIssuedAt > maxAgeMs`.
**Complexity:** LOW. 5 lines in WeatherScanner, 5 lines in
paper-trader.

---

## Tier 3 — Capital preservation (straightforward risk hygiene)

### 3.1 Fractional Kelly sizing
**Impact:** Grows the account geometrically without blowup risk.
**Where:** `src/dashboard/paper-trader.ts:478-480`.
**How:** Replace the fixed-dollar contracts calc with:
```ts
const kellyFraction = 0.25; // 25% Kelly; safer than full
const f_star = entry.edge / (1 - entry.entryPrice); // full Kelly
const f = Math.max(0, Math.min(0.05, f_star * kellyFraction));
const stake = state.availableCash * f;
const contracts = Math.floor(stake / entry.entryPrice);
```
with the `0.05` cap acting as a max-%-bankroll safety belt.
**Complexity:** LOW. Replace 3 lines + add a CLI flag for the Kelly
fraction. The Sizing Calculator tab (now in the dashboard) uses
exactly this formula and makes the behavior visible.

### 3.2 Daily loss circuit breaker
**Impact:** Caps worst-case daily drawdown; preserves the ability to
come back tomorrow.
**Where:** `src/dashboard/paper-trader.ts` — add state tracking of
`realizedPnlToday` and a new gate.
**How:**
```ts
const DAILY_LOSS_LIMIT = 0.05; // -5% of opening balance
// In placeTrade, after cooldown/daily-cap checks:
const openingBalance = state.dayOpeningBalance ?? state.totalPortfolioValue;
const todayPnl = state.totalPortfolioValue - openingBalance;
if (todayPnl < -DAILY_LOSS_LIMIT * openingBalance) {
  return; // halt trading for the rest of the day
}
```
Reset `dayOpeningBalance` at local midnight (the existing
`localDateKey()` function handles this).
**Complexity:** LOW. ~20 lines including state persistence.

### 3.3 Raise default min-edge to 0.12
**Impact:** Weather-bracket forecast noise is wider than 8% after
accounting for fee drag; 12% is the first threshold that's
meaningfully outside the noise band.
**Where:** `src/dashboard/paper-trader.ts:76`. One-line change.
**Complexity:** TRIVIAL. Update the default + the STARTUP_GUIDE.md
flag reference.

---

## Tier 4 — Observability (cheap; do in parallel with anything above)

### 4.1 Brier-score tracking
**Impact:** Makes model calibration visible; catches regressions
instantly.
**Where:** New file `src/dashboard/calibration.ts` + ingest from
`paper-trader.ts` on every CLOSE event.
**How:** On each close, append `{modelProb, won}` to
`state/calibration.jsonl`. Add `/api/calibration` endpoint in
`server.ts` returning the computed Brier score and calibration
buckets. The **Edge Quality** tab (shipping with this commit) already
consumes this endpoint shape — currently reads from
`cachedSimState.closedPositions`; switching to a dedicated endpoint
is a 1-hour swap.
**Complexity:** LOW.

### 4.2 Skipped-signal logging
**Impact:** Makes the Signal Monitor tab useful. Currently gates
reject silently (`paper-trader.ts:450-463` has a comment saying so).
**Where:** `paper-trader.ts:450-475`.
**How:** Instead of `return;` on gate rejection, append a line to
`results/skipped-signals.jsonl` with the gate reason. Add a new SSE
endpoint `/api/skipped/stream` that the Signal Monitor tab subscribes
to.
**Complexity:** LOW. 10-line change + 1 new endpoint.

### 4.3 Market-liquidity filter
**Impact:** Skips wide-spread markets where slippage will eat the
edge. Reduces trade count; raises signal quality.
**Where:** `src/kalshi/weather/WeatherScanner.ts:196`. Requires bid
+ ask (not just last trade) from KalshiClient.
**How:** Fetch the orderbook top-of-book; compute spread = ask - bid;
reject if `spread > 0.03` (3¢) or if `bidSize < minSize` or
`askSize < minSize`.
**Complexity:** MEDIUM. Requires KalshiClient to expose orderbook
snapshots; may need a WebSocket subscription for efficiency.

---

## Summary table

| # | Tier | Name | Complexity | Expected impact |
|---|---|---|---|---|
| 1.1 | 1 | Real Kalshi resolution | MEDIUM | Enables true evaluation |
| 1.2 | 1 | Archive-forecast API | LOW | Eliminates lookahead |
| 1.3 | 1 | Independent market price | LOW/HIGH | Removes σ-diff artifact |
| 2.1 | 2 | Empirical σ calibration | MEDIUM | Honest probabilities |
| 2.2 | 2 | Ensemble-agreement filter | LOW | Fewer false positives |
| 2.3 | 2 | Time-to-resolve gate | LOW | Avoid efficient markets |
| 2.4 | 2 | Signal staleness check | LOW | No stale-data trades |
| 3.1 | 3 | Fractional Kelly sizing | LOW | Geometric growth, no ruin |
| 3.2 | 3 | Daily loss circuit breaker | LOW | Cap worst-case DD |
| 3.3 | 3 | Raise min-edge to 12% | TRIVIAL | Stay outside noise band |
| 4.1 | 4 | Brier-score tracking | LOW | Observability |
| 4.2 | 4 | Skipped-signal logging | LOW | Populates Signal Monitor |
| 4.3 | 4 | Market-liquidity filter | MEDIUM | Slippage protection |

## Honest assessment

> If the model has no real edge over the market right now, say so
> explicitly.

**The model has no proven edge.** Nothing in the codebase measures
model-vs-market accuracy, so the edge is an assumption, not a
finding. The existing backtests confirm and deny nothing because
they're contaminated by lookahead, synthetic pricing, and missing
fees.

Capital-preservation move: **do not deploy real money until Tier 1
items 1.1 and 1.2 are complete AND show the model beating the market
on a Brier score basis over at least 30 days of real resolutions.** If
after that window the Brier scores are tied or the model is worse,
the strategy has no edge and should be paused.
