# Satriales — Kalshi Weather Trading Bot

Automated trading on Kalshi's daily high-temperature markets (KXHIGH*). Two
strategies run as independent, isolated processes that share the same Kalshi
balance but keep separate state files, trade CSVs, locks, kill switches, and
daily-loss trackers — so they cannot collide.

| Strategy | Entry window | Target price | Tape backtest | Status |
|---|---|---|---|---|
| **Intrinsic winner** — buy market favorite | T-8h ± 4h before close | $0.70–$0.85 | 94% WR, +5.6% ROI (14d) | ⏸ paused |
| **Ensemble forecast** — bet cheapest highest-prob bracket | T-24h ± 12h before close | $0.07–$0.30 | 33% WR, +68% ROI (17 bets) | ✓ active |

Both strategies have been calibrated against live data (see [Strategy tuning history](#strategy-tuning-history)). The ensemble strategy validated as designed; intrinsic is paused pending redesign after live data showed it structurally unprofitable at its original price ceiling.

---

## Requirements

- [Bun](https://bun.sh) 1.0+ (TypeScript runtime)
- A funded Kalshi account
- An RSA key pair created in Kalshi → Account → API Keys

---

## Setup

**1. Install dependencies**

```bash
bun install
```

**2. Generate Kalshi API credentials**

In Kalshi's web UI: Account → API Keys → Create key. Download the private key
PEM and store it somewhere *outside* this repo (e.g. `~/.kalshi/private.pem`).
The repo's `.gitignore` blocks `*.pem` as a second line of defence, but keeping
keys out of the project directory entirely is safer.

**3. Configure environment**

```bash
cp .env.example .env
```

Fill in at minimum:

```
KALSHI_API_KEY_ID=<uuid from Kalshi>
KALSHI_PRIVATE_KEY_PATH=/Users/you/.kalshi/private.pem
KALSHI_CONFIRM_FIRST_ORDER=yes
```

`KALSHI_CONFIRM_FIRST_ORDER=yes` is a per-day safety gate — if it's missing the
bot will refuse to place the first order of the day. Unset it (or remove it
entirely) to park a bot in read-only mode without killing the process.

**4. (Optional) NWS contact**

The bots call NWS (api.weather.gov) a handful of times per day to resolve
which bracket won. NWS asks for *a* User-Agent, and recommends (but doesn't
require) an email so they can reach you if your bot misbehaves. Set
`NWS_CONTACT_EMAIL=you@example.com` in `.env` if you want that; leave it blank
otherwise and a no-PII default is used.

**5. PATH (zsh users)**

If your terminal can't find `bun` after install, you don't have a `~/.zshrc`
yet. Add this line:

```bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

Alternatively, prefix one-off commands with `export PATH="$HOME/.bun/bin:$PATH" && ...`.

**6. Verify auth**

```bash
bun run verify-kalshi
```

Expected: your Kalshi balance, portfolio value, and an "authenticated" line.

---

## Running the bots

Both bots take safety flags: `--demo` uses Kalshi's fake-money demo env,
`--i-understand` is required for real money.

### Ensemble forecast (recommended primary)

```bash
# Demo
bun run ensemble -- --demo

# Production with current data-tuned defaults
caffeinate -i bun run ensemble -- --i-understand \
  --max-deployed 240 --max-per-order 35 --daily-loss 60 \
  --bet-size 16 --high-conf-mult 1.8
```

The ensemble bot's most-impactful flags:

| Flag | Default | Purpose |
|---|---|---|
| `--max-deployed N` | 100 | Hard cap on total deployed capital |
| `--max-per-order N` | 15 | Hard cap per single order |
| `--daily-loss N` | 30 | Daily realized-loss limit (treated as negative) |
| `--bet-size N` | 10 | Base bet size (high-conf bets size up from this) |
| `--max-price F` | 0.30 | Skip entries above this price (was 0.50; tuned down) |
| `--min-price F` | 0.07 | Skip lottery-ticket entries below this price (new) |
| `--high-conf-mult F` | 1.5 | Multiplier on bet size when edge ≥ threshold |
| `--high-conf-edge F` | 0.30 | Edge threshold that triggers the multiplier |
| `--min-prob F` | 0.40 | Minimum ensemble probability for any bet |
| `--scan-interval N` | 5 | Minutes between scans |
| `--fresh` | — | Ignore saved state, start clean |

When a candidate has edge ≥ `high-conf-edge`, the bet sizes up to
`bet-size × high-conf-mult`, capped by `max-per-order`. With the recommended
config above, base bets are $16 and high-conviction bets are $28.80.

### Intrinsic winner (currently paused)

```bash
# Demo
bun run intrinsic -- --demo

# Production with reduced max-price ($0.85, was $0.95)
bun run intrinsic -- --i-understand --max-deployed 70 --max-per-order 15 --daily-loss 20
```

Live data (12 closed trades) showed the $0.85–$0.92 entry zone lost −$36
across 6 trades with a W/L ratio of 0.07× — at $0.90 entry the win pays only
$0.07 net while the loss costs $0.90. The strategy needs ~91% WR to break
even there, but achieved ~58%. The default ceiling has been dropped to
$0.85 pending further validation; consider running `--demo` first or pausing
entirely until a redesign.

---

## Operational guidance for long-running setups

Three modes, ranked by reliability:

**1. Foreground in a terminal (simplest, fragile)**

```bash
caffeinate -i bun run ensemble -- --i-understand ...
```

Output streams to your terminal. Closing the terminal or restarting the Mac
kills the bot. Lid close on a MacBook also kills it (clamshell-mode sleep).
`caffeinate -i` only prevents *idle* sleep, not lid-close sleep.

**2. Backgrounded + detached (good for laptops)**

```bash
caffeinate -i nohup bun run ensemble -- --i-understand ... > logs/ensemble.log 2>&1 &
disown
tail -f logs/ensemble.log
```

`nohup` plus `disown` removes the bot from your terminal session, so it
survives terminal close. `tee`/redirect captures output to a file you can tail
from anywhere. **Still dies on Mac sleep though** — if your laptop closes lid,
the bot pauses; resumes on wake.

**3. Always-on host (recommended for production)**

The bot is single-dependency (`bun`) with JSON state files. Migrate by
copying `state/`, `.env`, and the repo to a $5/mo VPS (Hetzner, DigitalOcean)
and launching with `systemd` or `pm2`. State is portable — no DB.

---

## Dashboard

```bash
bun run dashboard
```

Serves a single-page web UI at `http://localhost:3000` (override with
`DASHBOARD_PORT`). Read-only — never modifies bot state.

What it shows:

- **Top metric cards**: cash balance, Kalshi-marked portfolio value, today's
  realized P&L, total P&L (Kalshi-derived to match your real account), pending
  settlement (positions where mark has converged to ≥$0.95 winner or ≤$0.05
  loser but Kalshi hasn't settled yet)
- **Per-bot performance cards**: realized P&L + ROI%, win rate, win/loss
  ratio (avg win ÷ avg loss), capital utilization, model EV on far-from-close
  positions, trade rate per day
- **Forecast vs market panel**: 82-member GFS+ECMWF ensemble plotted against
  Kalshi bracket prices for any city/day, with per-bracket edge and best-edge
  highlight
- **Open positions table**: filterable by bot/city/side, sortable by close
  time / unrealized P&L / expected P&L / exposure. Tags positions as
  managed/orphan/external and surfaces "decided pending settlement" rows
- **Forecast coverage section**: per (city, date) cards showing the current
  ensemble distribution alongside your specific bracket positions, with a
  visual bar showing whether the forecast covers your bet
- **Trade history**: full filterable history with bot/city/outcome filters
- **Equity curve**: three views — Kalshi account value (ground-truth, logged
  every 10 min), cumulative P&L combined, cumulative P&L per bot. Reads from
  the bot's audit-corrected state, so post-audit corrections are reflected
  immediately
- **Resting orders**: any orders waiting on the book

The dashboard maintains a separate `results/kalshi-equity-snapshots.csv` of
Kalshi balance over time (independent of bot state) — useful for true
account-level performance tracking across bot restarts.

---

## Kill switches

Either bot can be halted instantly without a SIGINT — just touch its kill file:

```bash
touch state/HALT_TRADING             # stops the intrinsic bot
touch state/HALT_TRADING_ENSEMBLE    # stops the ensemble bot
```

The bot exits on its next scan tick and releases its lock.

---

## Process locks + duplicate-order safety

Each bot acquires a PID lock at `state/locks/<name>.lock` on startup. A second
instance of the same bot refuses to start — this prevents the duplicate-order
bug that can happen if you accidentally launch the same bot twice. Stale locks
(owning PID is dead) are cleared automatically.

Additional layers against duplicates:

- IOC (immediate-or-cancel) orders only — no resting orders that could repeat
- Retries disabled on mutating POSTs so a network blip can't produce dup fills
- Order IDs are ticker-derived and deduped across restarts (state file persists
  the dedup set)
- The simulator's `audit` step on startup reconciles bot state against Kalshi's
  actual settlement results — corrects any classification drift automatically

---

## Reconciliation tool

Verify that bot state matches actual Kalshi positions:

```bash
bun run reconcile
```

Outputs:
- All open Kalshi positions with shares, avg price, cost
- Diff vs bot state (in both, only Kalshi, only bots)
- Per-ticker share/cost match check

Useful after a crash or when switching configs to confirm nothing drifted.

---

## Strategy tuning history

The strategies have been recalibrated based on live trade data. Notable
adjustments documented in commit history:

| Date (approx) | Change | Rationale |
|---|---|---|
| Initial | Intrinsic max-price $0.95, ensemble max-price $0.50 | From 14d/17-bet tape backtests |
| After ~16 ensemble trades | Ensemble max-price $0.50 → $0.30 | Mid-price entries lost 5/6 (W/L 0.22× in that bucket) |
| Same | Ensemble new minPrice floor $0.07 | Sub-7¢ "lottery tickets" hit 0/4 |
| Same | Confidence-tiered sizing 1.5× at edge ≥ 30% | The 30-40% edge bucket had 50% WR / +390% ROI |
| After ~12 intrinsic trades | Intrinsic max-price $0.95 → $0.85; bot paused | $0.85-$0.92 zone lost −$36 across 6 trades (W/L 0.07×) — needed 91% WR vs 58% achieved |

**Ensemble validation in live data**: 16-trade sample showed 25% WR with W/L
ratio 5.59× — exactly the strategy's design profile (rare big winners offset
frequent small losers). Realized P&L: +$45 / +18.8% ROI on $240 cap.

**Intrinsic anti-validation**: 58% WR but 0.15× W/L ratio. The structural math
needs ~87% WR to overcome fees + average loss size; clearly not achievable.
Strategy retired pending major rework.

---

## Layout

```
.
├── kalshi-weather-live-trading.ts      # INTRINSIC bot runner (paused)
├── kalshi-weather-ensemble-trading.ts  # ENSEMBLE bot runner (active)
├── kalshi-backtest.ts                  # Tape-based backtest (both strategies)
├── kalshi-ensemble-backtest.ts         # Ensemble-only backtest
├── kalshi-tape-collect.ts              # Pull historical fills from Kalshi
├── kalshi-tape-report.ts               # Summary stats on collected tape
├── kalshi-tape-compare.ts              # Compare strategies against the tape
├── kalshi-tape-replay.ts               # Replay tape for a single market
├── kalshi-winner-analysis.ts           # Winner price-evolution study
├── kalshi-check-orders.ts              # Snapshot of Kalshi positions & orders
├── kalshi-reconcile-state.ts           # Bot state ↔ Kalshi diff
│
├── src/
│   ├── kalshi/       Kalshi API client, auth, executor, weather finder
│   ├── weather/      Forecasts, observed temps, simulator (strategy brain)
│   ├── net/          fetchWithRetry
│   ├── util/         BotLock (PID file lock)
│   └── dashboard/    Optional HTTP dashboard + Kalshi equity snapshot logger
│
├── state/            Runtime: sim state, daily trackers, locks (gitignored)
├── results/          Trade CSVs per bot + Kalshi snapshots (gitignored)
├── logs/             NDJSON logs (gitignored)
├── data/             Tape snapshots used by backtests (gitignored)
└── Legacy Models/    Earlier Polymarket + paper-ladder code (gitignored)
```

---

## Safety summary

- `--i-understand` required for production
- `KALSHI_CONFIRM_FIRST_ORDER=yes` required for the first order each day
- Per-bot hard caps (deployed, per-order, daily loss)
- Per-bot kill-switch files
- Per-bot PID locks (no duplicate instances)
- IOC orders only; order IDs are ticker-derived and deduped across restarts
- Retries disabled on mutating POSTs so a network blip can't produce duplicate orders
- Startup audit reconciles bot state against Kalshi's actual settlement results
