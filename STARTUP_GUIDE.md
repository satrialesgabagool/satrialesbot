# Gas-bot Kalshi Dashboard — Startup Guide

Copy-paste reference for bringing up the simulation dashboard from a clean
clone. The stack is **Bun + TypeScript** (not Python); all commands assume a
POSIX shell or Git-Bash / WSL on Windows.

---

## 1. Environment Setup

### 1.1 Required runtime

| Tool | Version | Why |
|------|---------|-----|
| **Bun** | `>= 1.1.0` | Runs every script in this repo — server, scanner, paper-trader, tests. No Node step is required. |
| **Git** | any recent | Cloning + branch work. |
| **OS** | macOS, Linux, or Windows | Windows path quirks are handled (atomic state writes fall back to direct write on Win). |

Install Bun:

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Verify
bun --version     # -> 1.1.x or newer
```

### 1.2 Install dependencies

From the repo root:

```bash
bun install
```

That installs the packages declared in `package.json`:

- `hono` — the HTTP server framework used by `src/dashboard/server.ts`
- `commander` — CLI arg parsing for scanner entry points
- `@polymarket/clob-client`, `ethers`, `viem` — legacy Polymarket deps (not used by the dashboard; left in place for the archived engine)
- `@js-sdsl/ordered-map` — order-book helper used by the whale scanner
- dev: `typescript`, `@types/bun`, `prettier`

A successful install ends with `bun install vN.N.N` and a `bun.lockb` in the
repo root. No `node_modules` compilation step is needed.

### 1.3 Environment variables

Copy the example file and fill in only what you need:

```bash
cp .env.example .env
```

| Variable | Required? | What it does | Where to get it |
|----------|-----------|--------------|-----------------|
| `KALSHI_ENV` | optional | `demo` (default) or `prod` | Kalshi API docs |
| `KALSHI_ACCESS_KEY` | **only for placing real orders** | Kalshi API key ID | Kalshi dashboard → API Keys |
| `KALSHI_PRIVATE_KEY_PEM` | **only for placing real orders** | RSA-PSS private key matching the access key (multi-line PEM) | Kalshi dashboard when you create the API key |
| `RESULTS_DIR` | optional | Where `high-conviction.jsonl` is written | defaults to `./results` |
| `OPENWEATHER_API_KEY` | optional | Weather ensemble — OpenWeather adapter | openweathermap.org/api (free, 1k calls/day) |
| `TOMORROW_API_KEY` | optional | Weather ensemble — Tomorrow.io adapter | docs.tomorrow.io (free, 500/day) |
| `VISUALCROSSING_API_KEY` | optional | Weather ensemble — Visual Crossing adapter | visualcrossing.com (free, 1k records/day) |
| `WEATHERAPI_API_KEY` | optional | Weather ensemble — weatherapi.com adapter | weatherapi.com (free, 1M/month) |
| `PIRATEWEATHER_API_KEY` | optional | Weather ensemble — Pirate Weather adapter | pirateweather.net (free, 10k/month) |
| `PRIVATE_KEY`, `POLY_FUNDER_ADDRESS`, `BTC_TICKER`, `MARKET_WINDOW`, `WALLET_BALANCE`, `MAX_SESSION_LOSS`, `FORCE_PROD` | **not used by dashboard** | Legacy Polymarket engine only | — |

**For the dashboard + paper trader specifically, zero env vars are required.**
Open-Meteo and NOAA are free and keyless, and the paper trader doesn't need
Kalshi credentials (it simulates fills against internal prices).

### 1.4 External services

**None.** No Redis, no database, no message queue. The paper trader is
file-driven:

- Input: `results/high-conviction.jsonl` (JSONL, one signal per line)
- Output: `state/weather-sim.json` (atomically rewritten ~every 500ms)

Both directories are auto-created on first run.

---

## 2. Starting the Dashboard

The full stack runs in **3 terminals**. The paper trader is the only
non-obvious one — it's a separate process from the HTTP server.

### 2.1 Terminal 1 — Dashboard HTTP server

```bash
bun run dashboard
```

Success output:

```
Dashboard server listening on http://localhost:3000
  GET  /api/events
  GET  /api/events/stream  (SSE)
  GET  /api/stats
  POST /api/backtest/run
  GET  /api/sim/state
  GET  /api/sim/stream     (SSE)
  GET  /api/accuracy
Static: public/
```

Hit `http://localhost:3000` — the 4-tab UI (Live Feed / Backtest / Simulator /
Accuracy) should load. The Simulator tab will say "waiting for state" until
Terminal 3 starts.

### 2.2 Terminal 2 — Signal source (pick ONE)

**Option A — demo seeder** (recommended for first run, no API keys required):

```bash
bun run demo
# or with a custom cadence:
bun run src/dashboard/seed-demo.ts --rate-sec 5
```

Success output:

```
[demo] appending to results/high-conviction.jsonl @ 1 signal / 5s
[demo] weather  KXHIGHNY-26APR17-B82  NYC  model=0.71 market=0.54 edge=+17%
[demo] weather  KXHIGHLAX-26APR17-B74 LAX  model=0.63 market=0.48 edge=+15%
...
```

**Option B — real Kalshi weather scanner** (requires internet access, no
credentials for read-only endpoints):

```bash
bun run kalshi:weather
```

This hits Kalshi public endpoints + Open-Meteo + NOAA METAR and emits real
signals to the same JSONL file.

### 2.3 Terminal 3 — Paper trader

LIVE mode (real wall clock):

```bash
bun run paper-trade --mode live --balance 1000
```

Success output:

```
[paper-trader] mode=LIVE balance=$1000 size=$50 min-edge=8% cap=5/day cooldown=30m
[paper-trader] watching results/high-conviction.jsonl
[paper-trader] writing state to state/weather-sim.json every 500ms
```

Each time a signal passes the gates, you'll see:

```
[OPEN]  KXHIGHNY-26APR17-B82  YES  contracts=89  entry=$0.56  stake=$49.84  edge=+17%
        resolves=2026-04-18T04:00:00.000Z   reason="Model 71% vs Market 54%, edge 17%"
```

At resolution:

```
[RESOLVE] KXHIGHNY-26APR17-B82  YES  WIN  gross=$89.00  fee=$2.74  finalPayout=$86.26  netPnl=+$36.42
```

### 2.4 Switching between LIVE and BACKTEST mode

**LIVE** uses the real clock. A signal emitted Monday afternoon for a
Tuesday-high market resolves at real local-midnight Tuesday→Wednesday:

```bash
bun run paper-trade --mode live --balance 1000
```

**BACKTEST** compresses the clock. `--time-scale 60` means 1 real second =
60 sim minutes (a 24h resolve takes 24 real minutes). `--time-scale 1440`
means 1 real second = 1 sim day (fast-forward regression):

```bash
bun run paper-trade --mode backtest --time-scale 60 --balance 1000
bun run paper-trade --mode backtest --time-scale 360 --balance 1000    # 1s = 6 sim hours
bun run paper-trade --mode backtest --time-scale 1440 --balance 1000   # 1s = 1 sim day
```

The mode banner on the Simulator tab flips from green **LIVE** to purple
**BACKTEST** with the time-scale printed under it.

### 2.5 Full flag reference

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
--min-entry-price 0.05       floor on fill price (penny-bracket guard). Default: 0.05
```

### 2.6 What a successful end-to-end startup looks like

1. Terminal 1 prints `Dashboard server listening on http://localhost:3000`.
2. Terminal 2 starts appending lines to `results/high-conviction.jsonl`.
3. Terminal 3 prints `mode=LIVE balance=$1000 ...` and begins emitting
   `[OPEN]` / `[RESOLVE]` lines as signals arrive.
4. Browser tab at `localhost:3000/#simulator` shows the mode banner (LIVE
   or BACKTEST), summary cards (Portfolio Value · Cash · Realized P&L ·
   Unrealized P&L · Wins/Losses · Fees), an open-positions table that
   fills as trades open, and a closed-positions table that fills at
   resolution.

### 2.7 Common startup errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| `bun: command not found` | Bun not installed or not on PATH | Re-install per §1.1; open a new shell |
| `error: Cannot find module 'hono'` | `bun install` was skipped | `bun install` from repo root |
| Dashboard loads but Simulator tab says "waiting for state" forever | Paper trader (Terminal 3) isn't running, or `state/weather-sim.json` doesn't exist | Start Terminal 3; check the file exists |
| Simulator tab has no open positions after 5 minutes | No signals passing gates. Seeder marketProb might be outside edge threshold | Drop `--min-edge` (e.g. `--min-edge 0.05`) or raise seed cadence (`--rate-sec 2`) |
| `EADDRINUSE: address already in use :::3000` | Old dashboard server still running | Kill the old process; or set `PORT=3001 bun run dashboard` (not wired by default — edit `server.ts` if needed) |
| Windows: `ENOENT: rename ...weather-sim.json.tmp` | Disk full or antivirus locked the file | Paper trader auto-falls-back to direct write. Clear `state/` and retry |
| `Error: listen EACCES 0.0.0.0:3000` | Port reserved / needs elevation | Use a higher port or run as admin |
| Paper trader crashes with `SyntaxError` reading JSONL | Malformed line appended by a killed seeder | Delete `results/high-conviction.jsonl` and restart Terminals 2 + 3 |

---

## 3. Stopping and Resetting

### 3.1 Graceful stop

Each terminal is a regular foreground process — `Ctrl+C` stops it cleanly.
The paper trader finishes its current `saveState` and exits; in-flight
positions stay in `state/weather-sim.json` and will be picked up on the
next run.

Recommended stop order (reverse of start, so downstream processes don't see
broken inputs mid-shutdown):

```
Ctrl+C  in Terminal 3   (paper trader)
Ctrl+C  in Terminal 2   (seeder / scanner)
Ctrl+C  in Terminal 1   (dashboard server)
```

### 3.2 Reset to a fresh run (clear balance + trade history)

```bash
# From the repo root:
rm -f state/weather-sim.json
rm -f results/high-conviction.jsonl
rm -f results/paper-trades-live.jsonl
rm -f results/paper-trades-backtest.jsonl
```

Then start fresh with:

```bash
bun run paper-trade --mode live --balance 1000
```

The paper trader re-initializes `state/weather-sim.json` on first write:

```json
{
  "mode": "LIVE",
  "availableCash": 1000,
  "totalPortfolioValue": 1000,
  "realizedPnl": 0,
  "unrealizedPnlTotal": 0,
  "totalFeesPaid": 0,
  "wins": 0,
  "losses": 0,
  "openPositions": [],
  "closedPositions": []
}
```

### 3.3 Run the validation tests (always works without other services)

```bash
bun test src/dashboard/__tests__/
```

Expected: **46 pass / 0 fail / 314 expect() calls.** If any test fails,
don't trust the simulator — the math is broken somewhere. See
`.claude/skills/simulation-audit/SKILL.md` for the audit checklist.

---

## 4. Quick reference card

```
Install            bun install
Tests              bun test src/dashboard/__tests__/
Dashboard          bun run dashboard                         # :3000
Demo signals       bun run demo
Real scanner       bun run kalshi:weather
Paper trader LIVE  bun run paper-trade --mode live --balance 1000
Paper trader BT    bun run paper-trade --mode backtest --time-scale 60
Reset state        rm -f state/weather-sim.json results/high-conviction.jsonl
Simulator UI       http://localhost:3000  → Simulator tab
```
