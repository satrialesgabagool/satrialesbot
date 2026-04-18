# Changelog

High-level project history. For per-commit detail see `git log`.

## [Gas-bot] 2026-04-17 — Real Kalshi data end-to-end

### Changed (backtest: real Kalshi settled markets + historical forecasts)
- **`src/dashboard/backtest-runner.ts` rewritten to use real Kalshi data.** Previously the "Would this have worked?" tab was measuring our model against itself (market price = `ourProb + narrow noise`), so positive ROI was guaranteed by construction — the synthetic-price gap called out in `LOSS_DIAGNOSIS.md §2`. Now:
  - **Entry prices** come from `KalshiClient.listTrades({ticker, max_ts, limit})`, sampled **24h before each market's `close_time`** by default. KXHIGH markets close at midnight AFTER the measurement day, so 1–6h pre-close = post-observation (unusable — market has fully resolved). 24h lands in the morning of the measurement day, which is what a scanning bot would realistically have seen. Configurable via new `entryHoursBeforeClose` param.
  - **Win/loss** comes directly from `market.result` as Kalshi finalized — not a weather lookup.
  - **Forecasts** come from open-meteo `historical-forecast-api` (as-issued, no lookahead), replacing the live-forecast endpoint with `past_days` which was leaking hindsight.
  - `BacktestResult` now carries `dataSource: "kalshi-real" | "synthetic-fallback"`, `notes: string[]`, and counts of `kalshiMarketsEvaluated`, `daysWithKalshiData`, `daysMissingKalshiData`. Synthetic path kept ONLY as a fallback for when Kalshi is unreachable; flagged in notes so users don't misread it.
  - Trade rows carry the real Kalshi `ticker` so the dashboard can link out to each market.
- **Dashboard Backtest tab** — new green banner "Real Kalshi data (settled markets)" with markets/days counts when `dataSource=kalshi-real`; red warning banner on synthetic fallback. Trade Log gains a **Ticker** column (clickable `https://kalshi.com/markets/...` link).
- **`src/kalshi/KalshiClient.ts`** — added `getMarket(ticker)` helper wrapping `GET /markets?tickers=...`, used by paper-trader live polling.

### Changed (paper-trader: real Kalshi polling in LIVE mode)
- **`src/dashboard/paper-trader.ts` `refreshPrices()` split into LIVE vs BACKTEST paths.**
  - **LIVE**: batched `KalshiClient.getMarkets({tickers})` call per tick; price = midpoint of `yes_bid`/`yes_ask` when both > 0, else `last_price`. Clamped to [0.01, 0.99]. Mirrors around 1.0 for NO-side positions. Fire-and-forget via `livePollInflight` guard so the sync tick loop isn't blocked. Brownian-bridge fallback per-position if the Kalshi fetch fails or the ticker isn't in the batch response. Warns on every 3rd consecutive failure.
  - **BACKTEST**: unchanged Brownian-bridge path, extracted as `refreshPricesBrownian()`.
- **`livePollingEnabled` module flag** defaults false (tests stay deterministic); `start()` flips it on only when `MODE === "LIVE"` and prints `"[live-poll] Real Kalshi market polling: ENABLED (production API)."`.
- New constants: `LIVE_FETCH_TIMEOUT_MS = 4_000`, `LIVE_FETCH_MAX_FAILURES_BEFORE_WARN = 3`.

### Added
- **`entryHoursBeforeClose` param on `BacktestParams`** — exposes the pre-resolution price sample window so backtest callers can experiment with how early the "bot would have seen" price is taken.
- **Data-source indicator** threaded through `BacktestResult` → API → dashboard banner so users can tell at a glance whether they're looking at real Kalshi data or the synthetic sanity fallback.

### Fixed
- **Test hygiene**: `src/dashboard/__tests__/paper-trader.test.ts` signal factory used a hardcoded `resolvesAtIso: "2026-04-18T04:00:00.000Z"` that aged into the past, causing "no early resolve" to fail after time-advance stepped past 04:00 UTC. Now uses `Date.now() + 24h` dynamically.

### Ground-truth finding
- Running the rewritten backtest against 7 days × (NYC + Chicago), `minEdge=0.10`: **18 trades, 16.7% win rate, −7.2% ROI**. The strategy's 29% average "edge" comes from aggressive long-tail disagreement with Kalshi — and the market is usually right. Matches the `LOSS_DIAGNOSIS.md` thesis that the Gaussian σ=2.0–2.4°F model has no real edge. First honest measurement we've had.

### Tests
- 46 pass / 0 fail / 314 expect() calls (unchanged count — test hygiene fix + new live-polling path covered by existing integration tests which run in BACKTEST mode and therefore don't flip the live-polling flag).

### Commits
- `3b27577` Paper trader: real Kalshi price polling in LIVE mode
- `51a24bd` Backtest: real Kalshi settled markets + historical forecasts

## [Gas-bot] 2026-04-16 — Simulation audit

### Changed (simulation audit — full paper-trader rewrite)
- **`src/dashboard/paper-trader.ts` rewritten end to end.** Prior version had a 15-second fake-resolve, no fees, no gates, accepted whale signals, and flooded the dashboard with thousands of synthetic trades driven by the demo seeder's 3-second cadence. New version:
  - Only opens on `strategy === "weather"` signals
  - Enforces edge gate (`--min-edge 0.08` default), daily cap (`--max-per-day 5`), cooldown (`--cooldown-min 30`), affordability, and dedup (same market+direction)
  - Uses `metadata.resolvesAtIso` from the scanner (real Kalshi `close_time`) for resolution timing; falls back to `localMidnightIso(date+1, tz)` when absent
  - Pre-draws outcome at open (`outcomeWin = Math.random() < modelProb`); price path between open and close is a Brownian bridge anchored to outcome (deterministic per position via seeded RNG)
  - Settles with Kalshi's **7% fee on net winnings, winners only** — matches published fee schedule
  - Dual mode: `--mode live` (real clock) or `--mode backtest --time-scale 60` (compressed clock)
  - Atomic state writes (`tmp + renameSync`, Windows-safe fallback)
  - Exports `__state`, `__placeTrade`, `__resolvePositions`, `__reset`, etc. for integration tests
- **`src/dashboard/trading-math.ts` (new).** Pure functions — `kalshiFee`, `settlePosition`, `unrealizedPnl`, `isInTheMoney`, `accelPrice` (Brownian bridge), `edgeGate`, `formatCountdown`, `seededUniform`, `localDateKey`, `localMidnightIso`. No `fs`, no `Date.now`, no `Math.random` — callers inject time/RNG so tests are deterministic.
- **`src/kalshi/weather/WeatherScanner.ts`** — added `resolvesAtIso: market.endDate` to signal metadata so the paper-trader has an absolute `close_time` instead of an aging `hoursLeft` decimal.
- **`src/dashboard/seed-demo.ts` rewritten.** Emits realistic KXHIGH signals with full metadata (`resolvesAtIso`, `bracketLowF/highF`, `trueProb`, `marketProb`, `probMethod`, `lockStatus`). Edge varies in [5%, 22%] so the paper-trader's gates do real work. Configurable cadence via `--rate-sec`.
- **Dashboard Simulator tab rewired to spec.** Open positions columns: Market · Direction · Contracts · Entry · Current · Model Prob · Edge · Stake · Max Payout · Unrealized P&L · Status · Resolves At · Countdown. Closed columns: Market · Direction · Contracts · Entry · Outcome · Final P&L · Return % · Fees · Resolved At. New summary cards: Total Portfolio Value · Available Cash · Realized P&L · Unrealized P&L · Wins/Losses · Fees Paid. Mode banner shows LIVE/BACKTEST + time-scale. Countdown ticks once per second between SSE pushes.
- **`src/dashboard/server.ts`** — `/api/sim/state` now returns state flat (no `{status, state}` wrapper) for consistency with the SSE stream.

### Added (audit)
- **`src/dashboard/__tests__/trading-math.test.ts`** — 32 pure-math tests: fee rates, settlement, Brownian bridge endpoints, edge gate, countdown formatter, timezone helpers, RNG determinism.
- **`src/dashboard/__tests__/paper-trader.test.ts`** — 14 integration tests: the 8-check validation spec (open reduces cash, no early resolve, win with 7% fee, loss = −stake, portfolio invariant, dedup, no NaN, gate enforcement over 10+ signals) plus a 100-trade win-rate sanity bonus.
- **`.claude/skills/simulation-audit/SKILL.md`** — project-scoped skill that teaches future Claude sessions the audit checklist (bug list, dashboard column spec, LIVE vs BACKTEST, what to run, what NOT to do).
- Test results: **46 pass / 0 fail / 314 expect() calls** (`bun test src/dashboard/__tests__/`).

### Removed
- Stale `state/weather-sim.json` holding 805 ghost trades from the pre-audit demo run.

### Added (earlier today)
- **NOAA METAR same-day lock** (`src/weather/METARObserver.ts` + scanner wiring) — once a market resolves today and the day's observed peak has aged ≥2h with current temp ≥1.5°F below peak and local time past 3pm, the scanner flips to observation-based probability (0.98 in-bracket, 0.02 out). Near-arbitrage when Kalshi markets still price on the wide forecast distribution post-peak. Live NYC check today: forecast said bracket [90-91°F] = 26% probability, but METAR peak locked at 88°F → real probability 2%. 24pp short edge. Signal metadata tags `lockStatus: "locked-observed"` and carries `metarStation`, `metarPeakF`, `metarPeakAgeHours`.
- **GFS 31-member ensemble** (`src/weather/GFSEnsemble.ts`) — pulls the full GEFS distribution (1 control + 30 perturbed) from Open-Meteo's ensemble-api. `KalshiEnsembleDay` now carries an optional `highFMembers: number[]` (shifted to aggregated consensus center so GEFS shape is preserved but the mean stays consistent with all sources), and `ensembleBracketProbability()` uses an empirical count-based probability (with Laplace smoothing) when members are present instead of forcing a Gaussian. Live NYC smoke test confirms ~10 pp probability differences from Gaussian on tail brackets — real fat-tail and skew info the previous math was missing. Scanner signals now tag `metadata.probMethod = "locked-observed" | "empirical-gfs31" | "gaussian"` so we can measure which path is firing.
- **Web dashboard** (`src/dashboard/`) — Hono + Bun server on :3000 with 4 live tabs:
  - Live Feed (SSE stream of scanner signals)
  - Backtest (configurable city/edge/size params, Open-Meteo archive)
  - Simulator (streams paper-trader state via SSE)
  - Accuracy (forecast vs actual scatter + error histograms)
- **Paper trading simulator** (`src/dashboard/paper-trader.ts`) — watches the JSONL signal file, places virtual trades at market prices, resolves after configurable delay, tracks P&L. CLI: `--balance --size --speed`
- **Demo signal seeder** (`src/dashboard/seed-demo.ts`) — generates fake weather/whale signals every 3s for dashboard dev.
- **Dual output format** on `HighConvictionLog` — writes both CSV (Excel/pandas) and JSONL (dashboard).
- **GitHub CLI** installed + authenticated as `bennessy` for PR workflows.

### Changed
- Git remote `origin` now points at `satrialesgabagool/satrialesbot` (main repo, we have write access). Personal fork kept as `fork`.
- Dashboard field mappings fixed: API returns nested `summary`/`overall` objects; UI was reading flat fields, causing $0.00 P&L display on live data.

### Infrastructure
- `.claude/launch.json` — preview server config for the dashboard.

## [Gas-bot] 2026-04-15 — Reconciliation with feig

### Changed
- **-752 lines of duplicated Kalshi client code** — our `src/kalshi/client/*` replaced by feig's shared `src/kalshi/KalshiClient.ts`.
- KalshiClient extended with `wsUrl` getter, `listTrades()`, `paginateTrades()` for whale tracker.
- Scanner types adapted to feig's `WeatherMarket`/`TempBracket` shapes (FixedPointDollars strings instead of integer cents).
- WeatherEnsemble merge: took feig's superset city list (19 US + international).

### Pivoted
- From **Polymarket** → **Kalshi** as primary exchange. The old Polymarket engine/strategy/market/signals modules remain in `src/` but are not used.

## [Gas-bot] 2026-04-14 — PR review fixes

### Fixed
- Bracket off-by-one (exclusive strike convention).
- Duplicate client code path (merged into single canonical client).
- Missing LAX city in mapping.
- Added rate limiting to paid API sources.
- Forecast key caching to reduce API calls.
- Dedup math (prevent double-counting same signal in a scan window).

## [feig] 2026-04-16 — 0/10 live sim wipeout fix (upstream)

### Fixed
- **Liquidity filter**: new `minBracketPrice = $0.03` config. Kalshi penny brackets ($0.01-$0.02) had phantom edges — `yes_bid = $0.00` meant nobody was offering. The old strategy was amplifying losses here.
- **Cheap bracket bonus reduced** from 2.0x/1.5x → 1.3x/1.15x. Aggressive weighting on illiquid markets was the direct cause of the 10-trade wipeout.
- **fetchWithRetry timeout param** was silently ignored (buried in `RequestInit`). Fixed param positioning across all weather modules.

### Added
- `kalshi-backtest.ts` — Kalshi-specific historical backtest with synthetic ensemble for dates before live forecast data exists.

## [clog] 2026-04-15 — Kalshi BTC snipe trader (upstream, not merged)

### Added
- Kalshi BTC snipe trader (live-capable, RSA-PSS signed auth, OrderExecutor injection).
- Weather execution hook.

### Fixed
- DB `window_id` collision that corrupted P&L on same-market re-snipes. Fix: append stage + millisecond timestamp for uniqueness. Lesson: track stage/conviction in transaction IDs.

## [Gas-bot] 2026-04-12 — Initial Kalshi scaffold

### Added
- Weather ensemble scanner (Open-Meteo + NOAA, 5 optional paid sources).
- Whale tracker scanner (volume z-score via Kalshi trade WS).
- High-conviction CSV output.
- CLI entry points.

## [main] 2026-04-10 and earlier — Legacy Polymarket engine

- Original Satriales Polymarket BTC 5m trading engine.
- Weather trading simulator + BTC strategy rewrites.
- Kalshi weather market integration (feig, merged).

---

## How to update this file

On any substantive change, add a new entry under `[branch-name] YYYY-MM-DD — Short Title`. Group bullets under:
- **Added** — new features/files
- **Changed** — behavior changes on existing features
- **Fixed** — bugs squashed
- **Removed** — deleted code
- **Infrastructure** — tooling, CI, docs

Keep each bullet to one line. Link to PRs or commits when relevant. This file is for humans skimming the project history — per-commit detail lives in git.
