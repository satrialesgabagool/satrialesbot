# Strategy Loss Diagnosis Report

Generated 2026-04-17 for the Gas-bot Kalshi weather-ensemble strategy.
Based on a forensic audit of the signal pipeline, sizing logic, backtest
runner, and paper-trader. All line numbers are against the commit that
ships alongside this file (`Gas-bot` branch).

```
════════════════════════════════════════════════════════════
STRATEGY LOSS DIAGNOSIS REPORT
════════════════════════════════════════════════════════════

VERDICT: NEGATIVE EV + LOOKAHEAD BIAS + FEE DRAG
         (compounded by fixed sizing and no circuit breaker)

The strategy is losing in the Historical/backtest tab primarily
because the BACKTEST itself is broken in three independent ways
that all push P&L in the same direction: it uses future-looking
forecasts, it omits Kalshi's 7% fee, and it synthesises market
prices from the same forecast the model is reading. The live
paper-trader's "edge" is also overstated because the model uses
a forecast sigma that's tighter than the empirical forecast
error, so every probability it emits is slightly overconfident.

── SIGNAL QUALITY ──────────────────────────────────────────
Model Accuracy vs Market     : NOT MEASURED (no calibration
                               tracking exists in the codebase)
Avg Edge at Entry            : +12% to +35% (seed-demo + scanner)
Avg Edge Required (post-fee) : +2% (at 70¢) to +6% (at 10¢)
Signal vs Noise Assessment   : WEAK — σ=2°F at 24h horizon is
                               tighter than the empirical MAE
                               (≈3°F) the backtest itself
                               measures. Edge is partly an
                               artifact of overconfident σ.
Lookahead Bias Detected      : YES (critical — see below)
Entry Timing Problem         : YES (no minimum hours-to-resolve
                               gate; trades can open seconds
                               before close)

── SIZING ANALYSIS ─────────────────────────────────────────
Sizing Method                : Fixed $50 per trade
                               (paper-trader.ts:75, same in
                               backtest-runner.ts:260)
Recommended Sizing Method    : Fractional Kelly @ 25%
Avg Bet as % of Bankroll     : 5% of $1000 start (fixed $50)
Kelly-Optimal Bet Size       : varies per trade; for a 12%
                               edge at 50¢ entry, full Kelly
                               = 24% → 25% Kelly = 6%. Fixed
                               $50 is close at $1000 bankroll
                               but drifts badly as balance
                               moves — overbets in drawdown,
                               underbets in profit.
Over/Under Betting           : SLIGHT OVERBET in drawdown,
                               UNDERBET in run-up. No edge-
                               proportional scaling at all.

── FEE DRAG ────────────────────────────────────────────────
Kalshi fee rate              : 7% of net winnings (winners only)
                               — correctly implemented in
                               trading-math.ts:35-44, applied
                               in paper-trader resolution at
                               paper-trader.ts:600.

Backtest fee handling        : **FEES OMITTED ENTIRELY** in
                               backtest-runner.ts:360:
                                 pnl = inBracket
                                   ? shares * 1.0 - cost
                                   : -cost;
                               Every win in the Historical tab
                               is ~5-7% more profitable than
                               it would be live.

Breakeven edge by entry price:
  Formula: breakeven_edge = fee_rate × (1 − entry_price)
  Entry 10¢ → 6.3% edge needed
  Entry 30¢ → 4.9% edge needed
  Entry 50¢ → 3.5% edge needed
  Entry 70¢ → 2.1% edge needed
  Entry 90¢ → 0.7% edge needed

Min-edge gate (--min-edge)   : 0.08 (8%) — comfortably above
                               breakeven at ALL entry prices,
                               so fees alone don't make the
                               strategy unprofitable. The
                               problem is that "edge" is
                               measured against an optimistic
                               σ, so the true edge is smaller
                               than 8% on most trades.

── IDENTIFIED ROOT CAUSES (ranked by impact) ───────────────
1. **Lookahead bias in backtest-runner.ts** [CRITICAL].
   `fetchForecasts()` (line 171-194) calls Open-Meteo's LIVE
   forecast endpoint with `past_days=7`. This returns TODAY'S
   forecast back-filled with the past 7 days of data — which
   in Open-Meteo's "past_days" includes the actual realized
   values. So for a backtest trade on April 10, the model
   reads a "forecast" that already knows April 10's actual
   high. This inflates modelProb vs market in an unrealistic
   way; real-world model predictions don't get the answer
   key. This contaminates 100% of the backtest trades.

   Fix: switch to the archive-forecast API
   (`https://historical-forecast-api.open-meteo.com/v1/forecast`)
   or at minimum request a forecast dated ~24h BEFORE each
   trade date, not "right now" with past_days padding.

2. **Synthetic market price in backtest-runner.ts** [CRITICAL].
   Lines 336-344 generate market prices from the SAME forecast
   the model reads, using a wider σ=3.0°F plus ±3% uniform
   noise. When the "market" and the "model" are both functions
   of the same forecast, the backtest is measuring the
   difference between two sigmas, not a real market
   inefficiency. Every bracket near the forecast center shows
   model > market because σ=2.0 concentrates more probability
   there than σ=3.0 — that's not edge, that's arithmetic. On
   real Kalshi, market prices aren't normal distributions
   around the same forecast — they're aggregated orderbook
   bids from humans with access to multiple forecasts.

   Fix: replay actual historical Kalshi prices (`GET
   /markets/trades` archive) or at minimum perturb the market
   price to be independent of the model's σ — e.g., market σ
   sampled from a history of observed spreads.

3. **Model sigma is tighter than empirical forecast error**
   [HIGH].
   `WeatherEnsemble.ts:285-329` uses σ = 1.5–5.0°F keyed to
   horizon (1.5 at ≤12h, 2.0 at ≤24h, 3.0 at ≤48h, 4.0 at ≤72h,
   5.0 at >72h). The backtest-runner's own accuracy
   computation (line 290-308) consistently measures
   stddev ≈ 2.5–3.5°F at horizons the model treats as σ=2°F.
   Result: tight brackets (e.g., `[82-83°F]`) get inflated
   probabilities, which become fake "high conviction"
   signals. Ensemble spread (RSS'd in at line 309) partly
   rescues this when models disagree, but when they agree
   (spread=0.5°F) the floor σ=1.5–2°F reasserts and the
   overconfidence returns.

   Fix: calibrate σ from recent forecast residuals per
   (horizon, city) instead of a hardcoded schedule.

4. **Pre-drawn Bernoulli resolution in paper-trader**
   [HIGH — but not what's driving the losses you're seeing].
   `paper-trader.ts:490` seals the outcome at OPEN time:
   `const outcomeWin: 0 | 1 = Math.random() < entry.modelProb ? 1 : 0;`
   The paper-trader is validating the model against ITSELF.
   If the model says 65%, 65% of trades win by construction,
   regardless of real weather. This explains why your LIVE
   sim looks profitable while your Historical tab loses —
   they're testing different things. The Historical tab
   (despite its bugs) at least tries to resolve against real
   actuals; the paper-trader doesn't.

5. **No empirical calibration tracking** [MEDIUM].
   Nothing in the codebase records "model said 60%, how often
   did it actually win?" — so signal quality drift is
   invisible. Adding Brier-score tracking is cheap and would
   catch regressions instantly.

6. **Fixed $50 sizing + no max-%-bankroll guard** [MEDIUM].
   `paper-trader.ts:75, 478-480`. Size doesn't scale with
   edge, doesn't shrink in drawdown, doesn't grow with
   bankroll, doesn't cap as a % of cash. At the default
   $1000 bankroll, 5 trades = 25% of capital committed.
   A −3σ day liquidates a quarter of the account.

7. **No daily loss circuit breaker** [MEDIUM].
   No guard anywhere halts trading after a drawdown
   threshold. Combined with #6, a bad day compounds
   unchecked.

8. **No time-to-resolution gate** [LOW].
   `paper-trader.ts:353-475` will open a position if a
   signal arrives 30 seconds before resolution.
   Near-resolution markets have near-zero convexity and
   typically wide spreads. In BACKTEST mode this is how
   positions end up "resolving" in the same sim-tick they
   open.

── RECOMMENDED FIXES (top 3, ordered) ──────────────────────
1. **Stop trusting the Historical tab until it's fixed.**
   Until the lookahead bias and synthetic market price in
   `backtest-runner.ts` are repaired, ignore its P&L
   numbers. The "big losses" you see there are not a signal
   that your live strategy is broken — they're a signal
   that the backtest is broken. The direction sign is also
   unreliable: a backtest this contaminated can show wins
   OR losses depending on which way the random noise lands.

   This file ships with two concrete fixes already applied:
   (a) `backtest-runner.ts` now applies Kalshi's 7% fee at
   settlement (matches live reality); (b) `trading-math.ts`
   now exports `computeBreakevenEdge(entryPrice, feeRate)`
   so the Sizing Calculator tab can show honest minimum-
   edge requirements.

2. **Stop trusting the live Paper Trader's P&L as a model-
   accuracy measure.** The pre-drawn Bernoulli at line 490
   means the paper-trader will always eventually converge
   on your modelProb as the win rate. It's a useful
   sandbox for testing sizing + fee logic + gate behavior,
   but it proves nothing about whether your model beats
   Kalshi's market. The new **Edge Quality** tab shows
   this explicitly: until real Kalshi resolutions are
   wired in, the "Market Brier" column is N/A.

3. **Widen model σ and raise the min-edge gate.** A pragmatic
   stopgap while the calibration fix is being built:
   - Bump σ-at-24h from 2.0°F to 3.0°F in WeatherEnsemble.ts
     to match the empirical MAE.
   - Raise `--min-edge` default from 0.08 to 0.12. Anything
     below 12% is inside the forecast noise band for weather
     brackets.
   - Add a time-to-resolution gate: skip signals where
     `resolvesAtMs - now < 2h` (the market has fully priced
     in the short-term forecast by then).
════════════════════════════════════════════════════════════
```

## Background — what the paper-trader actually measures

Two things worth pinning down before anyone reads the numbers on the
Paper Trader tab again:

**The live Paper Trader is NOT a strategy backtester.** It's a sandbox
for the sizing, fees, gates, and UI — the outcome of every trade is
drawn at open time as `Math.random() < modelProb ? 1 : 0`. Wins and
losses are circular: if your model says 65% and Math.random falls
below 0.65, you win. It measures whether your math is internally
consistent, not whether your edge beats the market.

**The Historical tab *is* trying to backtest, but it's broken in three
ways** — each of which independently inflates (or deflates) edge:

1. It asks Open-Meteo for today's forecast and treats it as if it were
   a forecast made on the trade date. The "forecast" already contains
   the trade-date actual as a past observation. That's lookahead.
2. It simulates market prices from the same forecast using a different
   σ, so the "edge" is literally `normcdf(σ=2) - normcdf(σ=3)` — an
   arithmetic gap, not a real market mispricing.
3. It charges no fees, so every win is ~5-7% more profitable than on
   real Kalshi.

**The only honest strategy test currently available:** run the scanner
against real Kalshi (`bun run kalshi:weather`), pipe signals to the
paper trader in **LIVE mode** (NOT backtest mode), and track real
close-time outcomes against the model's probability. This requires
extending the paper-trader to fetch actual resolutions from Kalshi
instead of pre-drawing them — that's the single highest-value piece
of work to do next. It's listed as improvement #1 in
`SIGNAL_IMPROVEMENTS.md`.

## Where in the code each problem lives

| Problem | File | Lines |
|---|---|---|
| Lookahead: live forecast API | `src/dashboard/backtest-runner.ts` | 171–194 |
| Synthetic market price | `src/dashboard/backtest-runner.ts` | 336–344 |
| Fees omitted from backtest | `src/dashboard/backtest-runner.ts` | 360 (FIXED this commit) |
| Model σ too tight | `src/weather/WeatherEnsemble.ts` | 285–329 |
| Pre-drawn outcome | `src/dashboard/paper-trader.ts` | 490 |
| Fixed sizing | `src/dashboard/paper-trader.ts` | 75, 478–480 |
| No circuit breaker | `src/dashboard/paper-trader.ts` | (absent) |
| No time-to-resolve gate | `src/dashboard/paper-trader.ts` | 353–475 |
| No calibration tracking | (absent) | — |

See `SIGNAL_IMPROVEMENTS.md` for concrete prioritized fixes for each.
