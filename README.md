# Satriales — Kalshi Weather Trading Bot

Automated trading on Kalshi's daily high-temperature markets (KXHIGH*). Two
strategies run as independent, isolated processes:

| Strategy | Entry window | Target price | Tape backtest |
|---|---|---|---|
| **Intrinsic winner** | T-8h ± 4h before close | $0.70–$0.95 | 94% WR, +5.6% ROI (14d) |
| **Ensemble forecast** | T-24h ± 12h before close | $0.03–$0.50 | 33% WR, +68% ROI (17 bets) |

Both bots share the same Kalshi balance but keep isolated state files, trade
CSVs, locks, kill switches, and daily-loss trackers, so they cannot collide.

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

The intrinsic bot calls NWS (api.weather.gov) a handful of times per day to
resolve which bracket won. NWS asks for *a* User-Agent, and recommends (but
doesn't require) an email so they can reach you if your bot misbehaves. Set
`NWS_CONTACT_EMAIL=you@example.com` in `.env` if you want that; leave it blank
otherwise and a no-PII default is used.

**5. Verify auth**

```bash
bun run verify-kalshi
```

Expected: your Kalshi balance, portfolio value, and a "authenticated" line.

---

## Running the bots

Both bots take safety flags: `--demo` uses Kalshi's fake-money demo env,
`--i-understand` is required for real money.

**Intrinsic winner** (default caps: $20 deployed, $3/order, -$10 daily loss):

```bash
# Demo (fake money)
bun run intrinsic -- --demo

# Production (real money) — requires --i-understand
bun run intrinsic -- --i-understand --max-deployed 70 --max-per-order 10 --daily-loss 15
```

**Ensemble forecast** (default caps: $100 deployed, $15/order, -$30 daily):

```bash
# Demo
bun run ensemble -- --demo

# Production
bun run ensemble -- --i-understand
```

Common flags:

| Flag | Purpose |
|---|---|
| `--max-deployed N` | Hard cap on capital deployed at any moment ($) |
| `--max-per-order N` | Hard cap per single order ($) |
| `--daily-loss N` | Daily loss limit ($, signed negative internally) |
| `--scan-interval N` | Minutes between scans |
| `--fresh` | Ignore saved state, start clean |

Because MacBooks clamshell-sleep even with `caffeinate`, the recommended
long-running setup is `caffeinate -i bun run ... --i-understand` with the lid
**open** (or on an external display).

---

## Kill switches

Either bot can be halted instantly without a SIGINT — just touch its kill file:

```bash
touch state/HALT_TRADING             # stops the intrinsic bot
touch state/HALT_TRADING_ENSEMBLE    # stops the ensemble bot
```

The bot exits on its next scan tick and releases its lock.

---

## Process locks

Each bot acquires a PID lock at `state/locks/<name>.lock` on startup. A second
instance of the same bot refuses to start — this prevents the duplicate-order
bug that can happen if you accidentally launch the same bot twice.

Stale locks (owning PID is dead) are cleared automatically.

---

## Layout

```
.
├── kalshi-weather-live-trading.ts      # INTRINSIC bot runner
├── kalshi-weather-ensemble-trading.ts  # ENSEMBLE bot runner
├── kalshi-backtest.ts                  # Tape-based backtest (both strategies)
├── kalshi-ensemble-backtest.ts         # Ensemble-only backtest
├── kalshi-tape-collect.ts              # Pull historical fills from Kalshi
├── kalshi-tape-report.ts               # Summary stats on collected tape
├── kalshi-tape-compare.ts              # Compare strategies against the tape
├── kalshi-tape-replay.ts               # Replay tape for a single market
├── kalshi-winner-analysis.ts           # Winner price-evolution study
├── kalshi-check-orders.ts              # Snapshot of Kalshi positions & orders
├── kalshi-reconcile-state.ts           # Rebuild local state from Kalshi
│
├── src/
│   ├── kalshi/       Kalshi API client, auth, executor, weather finder
│   ├── weather/      Forecasts, observed temps, simulator (strategy brain)
│   ├── net/          fetchWithRetry
│   ├── util/         BotLock (PID file lock)
│   └── dashboard/    Optional HTTP dashboard
│
├── state/            Runtime: sim state, daily trackers, locks (gitignored)
├── results/          Trade CSVs per bot (gitignored)
├── logs/             NDJSON logs (gitignored)
├── data/             Tape snapshots used by backtests (gitignored)
└── Legacy Models/    Earlier Polymarket + paper-ladder code (gitignored)
```

---

## Dashboard (optional)

```bash
bun run dashboard
```

Serves a local view of balances, positions, and recent trades at
`http://localhost:3000`. `DASHBOARD_PORT` overrides the port.

---

## Safety summary

- `--i-understand` required for production
- `KALSHI_CONFIRM_FIRST_ORDER=yes` required for the first order each day
- Per-bot hard caps (deployed, per-order, daily loss)
- Per-bot kill-switch files
- Per-bot PID locks (no duplicate instances)
- IOC orders only; order IDs are ticker-derived and deduped across restarts
- Retries disabled on mutating POSTs so a network blip can't produce duplicate orders
