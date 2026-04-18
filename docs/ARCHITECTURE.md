# Gas-bot Architecture

> Active development branch: `Gas-bot` on `satrialesgabagool/satrialesbot`
> Runtime: **Bun** + TypeScript (strict mode)
> Target exchange: **Kalshi** (prediction market, CFTC-regulated)

## 1. Goals

**The bot hunts mispricings in Kalshi binary weather contracts — specifically the `KXHIGH` family, which pays $1 if the day's high temperature in a given city falls inside a specific bracket (e.g. "72-74°F in NYC on 2026-04-16").**

### Strategies

| Name | What it does | Files |
|------|--------------|-------|
| **Weather ensemble** | Query multiple weather forecast APIs, build an ensemble probability distribution, compare to Kalshi market prices, flag bracket where model prob − market prob > `minEdge` | `src/kalshi/weather/`, `src/weather/WeatherEnsemble.ts` |
| **Whale tracker** | Watch Kalshi trade feed WebSocket, detect anomalous notional flow (z-score on rolling volume), follow directional whales | `src/kalshi/whale/` |

### Shipped evaluation infrastructure (2026-04-17)

- **Real Kalshi price polling in LIVE paper-trader** (`paper-trader.ts:refreshPricesLive`) — batched `getMarkets({tickers})` per tick, midpoint of `yes_bid`/`yes_ask` or fallback to `last_price`, clamped [0.01, 0.99], mirrored around 1.0 for NO-side. Brownian-bridge fallback per-position if the fetch fails. Tests stay Brownian because `livePollingEnabled` only flips on in `start()` under `MODE === "LIVE"`.
- **Real Kalshi backtest** (`backtest-runner.ts`) — pulls settled KXHIGH events (`status: "settled"`, `with_nested_markets: true`), uses `market.result` as ground truth, entry price = `listTrades({ticker, max_ts, limit})` sampled 24h before `close_time`, forecasts from open-meteo `historical-forecast-api` (no lookahead). Surfaces `dataSource: "kalshi-real" | "synthetic-fallback"` on `BacktestResult` so the dashboard can warn when it falls back.

### Planned / still open

- **GFS 31-member ensemble via Open-Meteo** — shipped 2026-04-16; see `src/weather/GFSEnsemble.ts`.
- **NOAA METAR observations for same-day lock** — shipped 2026-04-16; see `src/weather/METARObserver.ts`.
- **Empirical σ calibration** (`SIGNAL_IMPROVEMENTS.md §2.1`) — not yet built; current hardcoded σ=2.0°F at 24h is tighter than the empirical ~3°F MAE.
- **Fractional Kelly sizing** + **daily loss circuit breaker** (`SIGNAL_IMPROVEMENTS.md §3.1–3.2`) — not yet built.
- **Pre-drawn Bernoulli in paper-trader** (`paper-trader.ts:490`) — still uses `Math.random() < modelProb` for outcomes. Real-Kalshi settlement lookup (`SIGNAL_IMPROVEMENTS.md §1.1`) is the remaining piece to make the paper-trader P&L a real model-accuracy measure.

## 2. Runtime Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                         LIVE MODE                                │
│                                                                   │
│  kalshi-weather-live.ts   WeatherScanner ──┐                     │
│        │                                     ├─► HighConvictionLog│
│        ▼                                     │    │              │
│   Open-Meteo / NOAA                 WhaleScanner    ▼             │
│   + paid sources                         │   high-conviction.jsonl│
│                                          ▼         │              │
│                                  KalshiWS (trades)  │              │
│                                                     │              │
│                                                     ▼              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           src/dashboard/server.ts (Hono + Bun)            │   │
│  │   GET /api/events   GET /api/stats   SSE /api/events/stream│   │
│  │   POST /api/backtest/run    GET /api/accuracy              │   │
│  │   GET /api/sim/state        SSE /api/sim/stream            │   │
│  └────────────┬──────────────────────────────┬────────────────┘   │
│               │                              │                    │
│               ▼                              ▼                    │
│  src/dashboard/public/index.html    state/weather-sim.json        │
│  (4 tabs: Live / Backtest /          (written by paper-trader     │
│   Simulator / Accuracy)               or kalshi-weather-live)     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    SIM / BACKTEST MODE                           │
│                                                                   │
│  paper-trader.ts (LIVE)    ──► reads JSONL signals               │
│                             ──► polls real Kalshi prices (tick)  │
│                             ──► pre-drawn Bernoulli resolve*     │
│                                                                   │
│  paper-trader.ts (BACKTEST)──► same, but Brownian-bridge prices  │
│                                and compressed clock              │
│                                                                   │
│  backtest-runner.ts ──► Kalshi settled events (market.result)    │
│                         + listTrades (pre-res entry price)       │
│                         + open-meteo historical-forecast-api     │
│                                                                   │
│  * real-Kalshi settlement lookup is next on the roadmap          │
│    (SIGNAL_IMPROVEMENTS.md §1.1); until it lands the paper       │
│    trader's outcomes are model-internal.                          │
└─────────────────────────────────────────────────────────────────┘
```

## 3. Directory Layout

```
kalshi-bot/
├── kalshi-weather-live.ts      ← Main live runner (from feig)
├── kalshi-backtest.ts          ← Kalshi-specific backtest (from feig)
├── docs/
│   └── ARCHITECTURE.md         ← This file
├── CHANGELOG.md                ← High-level project history
├── src/
│   ├── kalshi/                 ← Kalshi API integration
│   │   ├── KalshiClient.ts     ← REST client (trade API v2, FixedPointDollars)
│   │   ├── KalshiAuth.ts       ← RSA-PSS signed auth for production
│   │   ├── KalshiWS.ts         ← WebSocket for trade feed
│   │   ├── KalshiWeatherFinder.ts  ← Finds KXHIGH* markets
│   │   ├── types.ts            ← Shared Kalshi types
│   │   ├── cli.ts              ← CLI entry point
│   │   ├── smoke.ts            ← Manual smoke test
│   │   ├── weather/            ← Weather strategy (Kalshi-specific)
│   │   │   ├── WeatherScanner.ts    ← Main scan loop
│   │   │   ├── KalshiEnsemble.ts    ← CITY_ALIASES + wraps WeatherEnsemble
│   │   │   └── sources/             ← Paid forecast APIs (optional)
│   │   ├── whale/              ← Whale tracker strategy
│   │   │   ├── WhaleScanner.ts      ← Main scan loop
│   │   │   ├── WhaleDetector.ts     ← Z-score anomaly detection
│   │   │   ├── VolumeTracker.ts     ← Rolling window volume
│   │   │   ├── TradeFeed.ts         ← Consumes KalshiWS trades
│   │   │   └── types.ts
│   │   └── output/
│   │       └── HighConvictionLog.ts ← Dual CSV + JSONL writer
│   │
│   ├── weather/                ← Generic weather strategy (shared w/ Polymarket)
│   │   ├── WeatherEnsemble.ts       ← Open-Meteo + NOAA multi-model ensemble
│   │   ├── WeatherForecast.ts       ← Single-source forecast helpers
│   │   ├── WeatherMarketFinder.ts   ← Market finder interface
│   │   ├── WeatherScanner.ts        ← Generic scanner (legacy Polymarket)
│   │   ├── WeatherSimulator.ts      ← Paper-trading sim w/ liquidity filter
│   │   └── backtest.ts              ← Historical replay
│   │
│   ├── dashboard/              ← Web dashboard (Bun + Hono + SSE)
│   │   ├── server.ts                ← HTTP server
│   │   ├── backtest-runner.ts       ← Real-Kalshi backtest (settled events
│   │   │                              + listTrades pre-res entry +
│   │   │                              historical-forecast-api)
│   │   ├── accuracy-runner.ts       ← Forecast vs actual fetcher
│   │   ├── paper-trader.ts          ← Paper trader: LIVE polls real Kalshi
│   │   │                              prices; BACKTEST uses Brownian bridge
│   │   ├── trading-math.ts          ← Pure math (fees, settlement, etc.)
│   │   ├── seed-demo.ts             ← Fake signal generator for dev
│   │   └── public/index.html        ← 4-tab dashboard UI
│   │
│   ├── net/                    ← Shared networking
│   │   ├── fetchWithRetry.ts
│   │   └── ReconnectingWebSocket.ts
│   │
│   └── [legacy Polymarket]     ← Not used for Kalshi but still in tree:
│       ├── engine/     strategy/     market/     signals/
│       ├── client/     wallet/       log/        util/
```

## 4. Key Data Shapes

### Signal (what scanners write, what dashboard reads)

```typescript
interface Signal {
  timestamp: string;          // ISO
  strategy: "weather" | "whale";
  eventTicker: string;        // e.g. "KXHIGHNY-26APR16"
  marketTicker: string;       // e.g. "KXHIGHNY-26APR16-T72"
  side: "yes" | "no";
  yesPrice: number;           // cents, 0-100
  sizeContracts: number;
  conviction: number;         // 0-1
  edgeBps: number;            // basis points (model_p − market_p) × 10000
  reason: string;             // human-readable explanation
  metadata: {                 // strategy-specific
    city?: string;
    resolveDate?: string;
    hoursLeft?: number;
    notionalUsd?: number;     // whale only
    zScore?: number;          // whale only
  };
}
```

Written to `results/high-conviction.jsonl` (one JSON per line).

### Simulator state (paper-trader → dashboard)

```typescript
interface SimState {
  balance: number;
  deployed: number;
  totalPnl: number;
  wins: number; losses: number;
  positions: OpenPosition[];
  closedPositions: ClosedPosition[];
  scans: number;
  savedAt: string;            // ISO, SSE change detection
  startBalance: number;
  positionSize: number;
}
```

Written to `state/weather-sim.json` atomically on every change.

## 5. Scripts (package.json)

| Script | What it runs |
|--------|-------------|
| `bun run check` | `tsc --noEmit` — type check only |
| `bun run kalshi` | CLI entry for Kalshi scanners |
| `bun run kalshi:weather` | Weather scanner only |
| `bun run kalshi:whale` | Whale scanner only |
| `bun run kalshi:both` | Both scanners in parallel |
| `bun run dashboard` | Starts web dashboard at :3000 |
| `bun run paper-trade` | Paper trading simulator |
| `bun run demo` | Fake signal seeder (for dev) |

## 6. Critical Invariants

1. **Kalshi bracket convention is EXCLUSIVE**: a "greater than 70" bracket pays only if temp > 70.00, not >= 70. The `exclusive` flag in `KalshiWeatherFinder.ts` handles this.
2. **FixedPointDollars vs cents**: feig's KalshiClient returns strings like "0.72" (dollars). Our old code used integer cents (72). Scanners now use `outcomePrices[0]` (0-1 float) via the WeatherMarket adapter.
3. **Liquidity filter**: `minBracketPrice = $0.03` skips penny brackets where Kalshi shows phantom edges (fix from feig's 0/10 live sim wipeout).
4. **High-conviction dedup**: the scanner keys on `marketTicker + timestamp-bucket` to avoid duplicate logs within a single scan window.
5. **Paper trader write throttle**: state file writes are capped at 5s intervals from countdown updates; trade open/close events write immediately.
6. **KXHIGH `close_time` is midnight AFTER the measurement day** (local → UTC). So "1 hour before close" = late evening post-observation (price is already 0.01 or 0.99 — useless for entry-price sampling). The backtest defaults to sampling **24h before `close_time`** for entry prices, which lands in the morning of the measurement day when a scanning bot would realistically enter.
7. **Kalshi trade response uses `yes_price_dollars` (string), not `yes_price` (int cents).** Despite what `src/kalshi/types.ts:187` documents, `listTrades` returns e.g. `{"yes_price_dollars": "0.4500", ...}`. `fetchPreResolutionYesPrice` in `backtest-runner.ts` has defensive string-or-number parsing; don't rely on the int field.
8. **Paper-trader `livePollingEnabled` module flag** defaults false so tests stay deterministic. Only `start()` flips it on under `MODE === "LIVE"`. Never import the module in a test and expect the LIVE branch to fire.

## 7. Environment Variables

| Var | Purpose | Required for |
|-----|---------|--------------|
| `KALSHI_ACCESS_KEY` | Kalshi auth key ID | Live/demo scanning |
| `KALSHI_PRIVATE_KEY` | RSA private key (PEM) | Live/demo scanning |
| `KALSHI_ENV` | `demo` or `prod` | Live/demo scanning |
| `DASHBOARD_PORT` | Default 3000 | Dashboard only |
| `RESULTS_DIR` | Default `results` | Dashboard only |
| Paid API keys | `OPENWEATHER_KEY`, `PIRATE_WEATHER_KEY`, etc. | Optional paid ensemble sources |

Open-Meteo and NOAA endpoints require no keys.

## 8. Branch Strategy

- `main` — stable
- `Gas-bot` (ours) — weather + whale scanners, dashboard, paper trader
- `feig` — other developer's weather strategy work (upstream of ours)
- `clog` — third developer: Kalshi BTC snipe trader + weather exec hook
- `legacy-ml` — archived ML experiments

Merge direction: `Gas-bot → main` via PR #3.
Reconciliation with feig: rebase onto `feig` then resolve; `feig` has priority on shared weather files.
