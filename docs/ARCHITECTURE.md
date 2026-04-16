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

### Planned additions (not yet implemented)

- **GFS 31-member ensemble via Open-Meteo** — specifically the `ensemble_members` endpoint, which returns all 31 GEFS members rather than just a point forecast
- **NOAA METAR observations for same-day lock** — once the day's observed high is within 1-2°F of sunset, the bracket outcome is effectively locked. Real-time airport obs let us detect this before the market re-prices

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
│  paper-trader.ts ──► reads JSONL ──► places virtual trades       │
│                                      resolves after delay         │
│                                      writes state file           │
│                                                                   │
│  backtest-runner.ts ──► Open-Meteo archive + forecast            │
│                         simulates ensemble signals + P&L         │
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
│   │   ├── backtest-runner.ts       ← Programmatic backtest for the API
│   │   ├── accuracy-runner.ts       ← Forecast vs actual fetcher
│   │   ├── paper-trader.ts          ← Live paper trading simulator
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
