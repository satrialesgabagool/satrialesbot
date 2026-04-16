# `src/dashboard/` — Web Dashboard + Paper Trading

Bun-native HTTP server (Hono) serving a 4-tab dashboard at `http://localhost:3000`
plus a paper-trading simulator that exercises the full signal → trade → P&L pipeline
without touching real Kalshi markets.

## Files

| File | Purpose |
|------|---------|
| **`server.ts`** | Hono HTTP server. Routes: `/api/events`, `/api/stats`, SSE `/api/events/stream`, POST `/api/backtest/run`, `/api/sim/state`, SSE `/api/sim/stream`, `/api/accuracy`. Serves `public/` statically. |
| **`paper-trader.ts`** | Watches `results/high-conviction.jsonl`, places virtual trades at market price, resolves after configurable delay using model probability as win rate, writes `state/weather-sim.json`. CLI: `--balance --size --speed`. |
| **`backtest-runner.ts`** | Programmatic backtest for the API. Uses Open-Meteo archive + forecast APIs, simulates ensemble signals, tracks equity curve. ~10s per run. |
| **`accuracy-runner.ts`** | Fetches forecast vs actual for the past N days. Used by the Accuracy tab. |
| **`seed-demo.ts`** | Fake signal generator. Writes a new weather/whale signal every 3s. For dev only. |
| **`public/index.html`** | Single-page 4-tab UI (Live Feed / Backtest / Simulator / Accuracy). Uses Chart.js via CDN + vanilla JS (no build step). |

## Data flow

```
Scanner (live or demo)
    │
    ▼
results/high-conviction.jsonl  ◄─── appended by HighConvictionLog
    │
    ├──► server.ts ──► SSE /api/events/stream ──► dashboard Live Feed
    │
    └──► paper-trader.ts ──► state/weather-sim.json
                                │
                                ▼
                        server.ts ──► SSE /api/sim/stream ──► Simulator tab
```

## Running the full stack (3 terminals)

```bash
# Terminal 1: dashboard server
bun run dashboard

# Terminal 2: signal source (either demo OR real scanner)
bun run demo                                  # fake signals
# OR
bun run kalshi:weather                        # real scanner (needs Kalshi auth)

# Terminal 3: paper trader (consumes the signals above)
bun run paper-trade --balance 500 --size 5 --speed 15
```

Open http://localhost:3000

## Tabs

1. **Live Feed** — SSE stream of every signal, stat cards, edge distribution histogram, timeline chart, filterable table.
2. **Backtest** — configurable params (cities, days back, min edge, position size, start balance), runs `backtest-runner.ts`. Shows summary cards, equity curve, error distribution, per-city accuracy table, full trade log.
3. **Simulator** — SSE stream of `paper-trader.ts` state. Shows balance, P&L, win/loss, open positions (with countdown), closed positions, equity curve.
4. **Accuracy** — runs `accuracy-runner.ts` for N days. Forecast vs actual scatter plot, error histogram, per-city MAE/stddev/within-2°F/within-4°F table.

## API response shapes

All API fields are **nested**. UI code must read them as such:

```javascript
// /api/backtest/run returns:
{
  summary: { totalTrades, wins, losses, winRate, totalPnl, roi, avgPnlPerTrade, ... },
  accuracy: { overall: {...}, byCity: [...] },
  trades: [{ date, city, bracket, entryPrice, actualHighF, won, pnl, ... }],
  equityCurve: [{ balance, tradeIndex }, ...]
}

// /api/accuracy returns:
{
  period: { start, end },
  comparisons: [{ city, date, forecastHighF, actualHighF, errorF, ... }],
  overall: { mae, stddev, within2F, within4F, ... },   // within* are 0-1 fractions
  byCity: [{ city, n, meanError, stddev, mae, within2F, within4F }]
}
```

A previous bug had the UI reading flat fields (`data.totalPnl` instead of `data.summary.totalPnl`) — always check the actual response before touching UI code.
