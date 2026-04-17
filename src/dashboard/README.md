# `src/dashboard/` — Web Dashboard + Paper Trading

Bun-native HTTP server (Hono) serving a 4-tab dashboard at `http://localhost:3000`
plus a paper-trading simulator that exercises the full signal → trade → P&L
pipeline without touching real Kalshi markets.

## Files

| File | Purpose |
|------|---------|
| **`server.ts`** | Hono HTTP server. Routes: `/api/events`, `/api/stats`, SSE `/api/events/stream`, POST `/api/backtest/run`, `/api/sim/state`, SSE `/api/sim/stream`, `/api/accuracy`. Serves `public/` statically. |
| **`paper-trader.ts`** | Watches `results/high-conviction.jsonl`, gates signals through edge/cooldown/daily-cap filters, opens virtual positions at market price, resolves at the real `close_time` with Kalshi's 7%-of-net-winnings fee. Writes `state/weather-sim.json`. Dual mode: LIVE or BACKTEST. |
| **`trading-math.ts`** | Pure math — fee calculator, settlement, Brownian-bridge price path, edge gate, timezone helpers. No I/O. Fully unit-tested. |
| **`backtest-runner.ts`** | Programmatic backtest for the API. Uses Open-Meteo archive + forecast APIs, simulates ensemble signals, tracks equity curve. ~10s per run. |
| **`accuracy-runner.ts`** | Fetches forecast vs actual for the past N days. Used by the Accuracy tab. |
| **`seed-demo.ts`** | Realistic signal generator with full metadata (resolvesAtIso, bracketLowF/highF, trueProb, marketProb). Configurable cadence via `--rate-sec`. |
| **`public/index.html`** | Single-page 4-tab UI (Live Feed / Backtest / Simulator / Accuracy). Uses Chart.js via CDN + vanilla JS (no build step). |
| **`__tests__/`** | Bun test suite: `trading-math.test.ts` (pure math, 32 cases) and `paper-trader.test.ts` (integration, the 8-check validation spec). |

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
bun run demo                                  # fake signals, ~1 per 15s
# OR
bun run kalshi:weather                        # real scanner (needs Kalshi auth)

# Terminal 3: paper trader (consumes the signals above)
bun run paper-trade --mode live --balance 1000
```

Open http://localhost:3000 and click the **Simulator** tab.

## Paper-trader CLI flags

```
--mode live|backtest         LIVE (real clock) or BACKTEST (compressed clock). Default: live
--time-scale 60              BACKTEST only: 1 real sec = N sim min. Default: 60
--balance 1000               starting cash. Default: 1000
--size 50                    dollars per trade. Default: 50
--min-edge 0.08              minimum model-over-market edge to open. Default: 0.08 (8%)
--max-per-day 5              daily trade cap, rolls at local midnight. Default: 5
--cooldown-min 30            minutes between trades. Default: 30
--price-poll-min 5           minutes between price refreshes. Default: 5
--tz America/New_York        timezone for daily cap + KXHIGH close_time fallback. Default: America/New_York
```

### LIVE mode (real clock)

```bash
bun run paper-trade --mode live --balance 1000 --size 50 --min-edge 0.08
```

Resolution timestamps are absolute — a signal emitted Monday afternoon for a
Tuesday-high market will resolve at actual local-midnight Tuesday→Wednesday.
The open-positions countdown ticks in real seconds.

### BACKTEST mode (accelerated)

```bash
bun run paper-trade --mode backtest --time-scale 60 --balance 1000
```

The simulated clock advances by `time-scale` minutes per real second.
`--time-scale 60` makes a 24-hour resolve window take 24 real minutes — useful
for stress-testing the trade lifecycle end to end. Price path between open and
close is a Brownian bridge anchored to the pre-drawn outcome, so you see a
realistic zig-zag up to WIN or down to LOSS rather than flatline.

Higher `time-scale` values compress further: `--time-scale 1440` means 1 real
second = 1 sim day (fast-forward regression mode).

## Validation tests

```bash
bun test src/dashboard/__tests__/
```

The 8 integration checks:

1. Opening a trade reduces cash and creates an open position
2. No early resolve (position stays open until `simNowMs ≥ resolvesAtMs`)
3. Win P&L applies Kalshi's 7% fee on net winnings (not gross)
4. Loss P&L = −stake with no fee
5. Portfolio-value invariant: `totalPortfolioValue == availableCash + Σ(contracts × currentPrice)`
6. Dedup: same market+direction doesn't double-open
7. No NaN / undefined on any numeric position field
8. Gates enforced over 10+ signals: low-edge rejected, daily cap + cooldown applied

Plus a bonus win-rate sanity check: 100 trades at `modelProb=0.70` → win rate
in [0.58, 0.82], verifying that the pre-drawn outcome reaches resolution.

Current: **46 pass / 0 fail / 314 expect() calls.**

## Simulator tab columns

**Open positions:**
Market · Direction · Contracts · Entry · Current · Model Prob · Edge at Entry ·
Stake · Max Payout · Unrealized P&L · Status · Resolves At · Countdown

**Closed positions:**
Market · Direction · Contracts · Entry · Outcome · Final P&L (after fees) ·
Return % · Fees Paid · Resolved At

**Summary cards:**
Total Portfolio Value · Available Cash · Realized P&L · Unrealized P&L ·
Wins/Losses · Fees Paid

Countdown ticks once per second between SSE pushes (SSE cadence is 5s).

## API response shapes

`/api/sim/state` and `/api/sim/stream` both return the raw `SimState` JSON —
see `paper-trader.ts` `SimState` interface. Key fields:

```jsonc
{
  "mode": "LIVE" | "BACKTEST",
  "timeScale": 60,
  "simNowMs": 1766889600000,
  "availableCash": 875.25,
  "totalPortfolioValue": 1023.50,
  "realizedPnl": 23.50,
  "unrealizedPnlTotal": 0,
  "totalFeesPaid": 1.75,
  "wins": 1, "losses": 0,
  "openPositions": [ /* Position[] */ ],
  "closedPositions": [ /* Closed[] */ ],
  "config": { "minEdge": 0.08, "maxPerDay": 5, "cooldownMin": 30, "kalshiFeeRate": 0.07, /* ... */ }
}
```

Other endpoints:

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

## Auditing the simulator

See `.claude/skills/simulation-audit/SKILL.md` for the full checklist. Quick
version: run the tests, check `state/weather-sim.json` for finite numbers, run
a BACKTEST cycle, confirm `grossPayout - feesPaid == finalPayout` on closed
wins, confirm `stake + unrealizedPnl == contracts × currentPrice` on opens.
