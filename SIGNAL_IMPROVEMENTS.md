# Signal Improvements — Prioritized Fix List

Companion to `LOSS_DIAGNOSIS.md`. Each item below is scoped to a
specific file/line and estimated for implementation complexity. The
ordering reflects expected impact on real P&L, not ease of
implementation.

---

## Tier 1 — Unblock honest evaluation (no trading decisions should be made until these land)

### 1.1 Real resolution against Kalshi actuals (not `Math.random()`)
**Status:** PARTIALLY SHIPPED 2026-04-17. Real Kalshi *prices* now
poll live in `paper-trader.ts:refreshPricesLive` (LIVE mode only),
so unrealized P&L and the `current` column match the Kalshi app.
Real Kalshi *resolution* is still open — `paper-trader.ts:490` still
pre-draws `outcomeWin = Math.random() < modelProb` and line 599 uses
that instead of looking up `market.result`. So wins/losses are still
circular.
**Impact:** Eliminates circular validation. This is the difference
between "my math is internally consistent" and "my model beats the
market."
**Where:** `src/dashboard/paper-trader.ts:490` (pre-draw) + `:599`
(resolution) — replace the Bernoulli draw with a lookup of the real
Kalshi market result.
**How:** Extend `KalshiClient` to expose `getMarketResult(ticker) →
{resolved: boolean, outcome: 'yes'|'no'|null}` (can likely piggyback
on the existing `getMarket(ticker)` helper added 2026-04-17 — it
already returns `market.result` on settled markets). In
`resolvePositions()` (paper-trader.ts:594), for LIVE mode, call that
instead of using the pre-drawn `outcomeWin`. Keep the Bernoulli path
for BACKTEST mode (it's fine as a sandbox there).
**Complexity:** LOW now. `getMarket()` already exists; ~20 lines of
paper-trader changes remaining. One unit test (mock KalshiClient)
covers it.

### 1.2 Archive-forecast API in backtest-runner
**Status:** SHIPPED 2026-04-17 (commit `51a24bd`). `fetchHistoricalForecasts`
now hits `historical-forecast-api.open-meteo.com/v1/forecast` with
`start_date` and `end_date` — returns the forecast *as it was issued*
for a given date. Lookahead eliminated.
**Impact:** Removes lookahead bias. Backtest P&L becomes
interpretable.
**Where:** `src/dashboard/backtest-runner.ts` → `fetchHistoricalForecasts`.

### 1.3 Independent market price replay in backtest-runner
**Status:** SHIPPED 2026-04-17 (commit `51a24bd`) — took the "correct"
path (Option B). `fetchPreResolutionYesPrice` fetches real Kalshi
trade prints via `listTrades({ticker, max_ts, limit})`, sampled 24h
before `close_time`. Win/loss comes from `market.result` on the
settled Kalshi market, not a weather lookup. The synthetic
`marketBase + noise` path is preserved only as a fallback for when
Kalshi is unreachable, and `BacktestResult.dataSource` flags which
one ran.
**Impact:** Eliminates the "edge = difference of two sigmas" artifact.
First honest backtest (NYC+Chicago, 7d, minEdge=0.10): 18 trades,
16.7% win rate, −7.2% ROI. No mystery left in the Historical tab
numbers.
**Where:** `src/dashboard/backtest-runner.ts` → `fetchPreResolutionYesPrice`
+ `runBacktest` main loop (kalshi-real branch).

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

| # | Tier | Name | Status | Complexity | Expected impact |
|---|---|---|---|---|---|
| 1.1 | 1 | Real Kalshi resolution | 🟡 partial (prices yes, resolution no) | LOW | Enables true evaluation |
| 1.2 | 1 | Archive-forecast API | ✅ shipped 2026-04-17 | LOW | Eliminates lookahead |
| 1.3 | 1 | Independent market price | ✅ shipped 2026-04-17 (real replay) | — | Removes σ-diff artifact |
| 2.1 | 2 | Empirical σ calibration | ⬜ open | MEDIUM | Honest probabilities |
| 2.2 | 2 | Ensemble-agreement filter | ⬜ open | LOW | Fewer false positives |
| 2.3 | 2 | Time-to-resolve gate | ⬜ open | LOW | Avoid efficient markets |
| 2.4 | 2 | Signal staleness check | ⬜ open | LOW | No stale-data trades |
| 3.1 | 3 | Fractional Kelly sizing | ⬜ open | LOW | Geometric growth, no ruin |
| 3.2 | 3 | Daily loss circuit breaker | ⬜ open | LOW | Cap worst-case DD |
| 3.3 | 3 | Raise min-edge to 12% | ⬜ open | TRIVIAL | Stay outside noise band |
| 4.1 | 4 | Brier-score tracking | ⬜ open | LOW | Observability |
| 4.2 | 4 | Skipped-signal logging | ⬜ open | LOW | Populates Signal Monitor |
| 4.3 | 4 | Market-liquidity filter | ⬜ open | MEDIUM | Slippage protection |

## Honest assessment

> If the model has no real edge over the market right now, say so
> explicitly.

**Updated 2026-04-17.** After fixing the backtest (shipped items
1.2 and 1.3), the first honest measurement is in: **18 trades,
16.7% win rate, −7.2% ROI** over 7 days × 2 cities at
`minEdge=0.10`, against real Kalshi entry prices and real
settlements with no-lookahead forecasts. That's not enough data to
call the strategy dead, but it's a clear sign the current Gaussian
σ=2°F model is NOT beating Kalshi — the 29% average "edge" it
claims is mostly tail overconfidence that loses 80%+ of the time.

Capital-preservation move: **do not deploy real money until:**
1. Item 1.1 (real Kalshi settlement in the paper-trader) is
   complete so the paper-trader's P&L becomes a real edge measure.
2. Item 2.1 (empirical σ per city/horizon) is shipped — current
   σ=2°F is tighter than the measured ~3°F MAE and is the likely
   source of the tail overconfidence.
3. Item 4.1 (Brier-score tracking) shows the model beating the
   market on at least 30 days of real resolutions.

If after (1)–(3) the Brier scores are tied or the model is worse,
the strategy has no edge and should be paused.
