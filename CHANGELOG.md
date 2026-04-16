# Changelog

High-level project history. For per-commit detail see `git log`.

## [Gas-bot] Unreleased — 2026-04-16

### Added
- **GFS 31-member ensemble** (`src/weather/GFSEnsemble.ts`) — pulls the full GEFS distribution (1 control + 30 perturbed) from Open-Meteo's ensemble-api. `KalshiEnsembleDay` now carries an optional `highFMembers: number[]`, and `ensembleBracketProbability()` uses an empirical count-based probability (with Laplace smoothing) when members are present instead of forcing a Gaussian. Live NYC smoke test confirms ~10 pp probability differences from Gaussian on tail brackets — real fat-tail and skew info the previous math was missing. Scanner signals now tag `metadata.probMethod = "empirical-gfs31" | "gaussian"` so we can measure which path is firing.
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
