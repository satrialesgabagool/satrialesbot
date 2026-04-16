# Satriales — Kalshi BTC Snipe Bot (TypeScript)

Paper-trading bot for Kalshi's BTC binary markets (KXBTCD / KXBTC). Buys the
already-winning strike when spot has clearly moved past it but the orderbook
is still quoting stale asks into the settlement timer.

Starting bankroll: **$20** (never inflated). Goal: compound to $100/day.

## Thesis (verified by the 159,554-trade tape study)

Over a 24h sample of every anonymous fill across all settled BTC markets:

| Bucket                        | WR     | PnL/share | Fills |
|-------------------------------|--------|-----------|-------|
| time <60s × price 0.70–0.95   | 89.24% | +$0.046   | 567   |
| Bot's own snipes in same zone | 92.3%  | +$0.069   | 13    |

The bot systematically beats the tape baseline by **+14.4pp WR** and
**4.9×** per-share edge — the edge is real, not noise.

## Running

```bash
# Paper mode (production market data, no real orders)
bun run kalshi-snipe-live.ts

# Paper + GUI dashboard on http://127.0.0.1:5173
bun run kalshi-snipe-live.ts --gui

# Tape collector (archives settled BTC markets to kalshi_tape.db)
bun run kalshi-tape-collect.ts --hours 24

# Tape report (bucket stats + bot-vs-tape comparison)
bun run kalshi-tape-report.ts --bot-compare

# Live orders (real money — 5s abort window, requires env creds)
export KALSHI_API_KEY_ID=<uuid>
export KALSHI_PRIVATE_KEY_PATH=<path-to-pem>
bun run kalshi-snipe-live.ts --live
```

## Source layout

```
src/
  kalshi/
    KalshiClient.ts         — REST client (events, markets, trades, orders)
    KalshiAuth.ts           — RSA-PSS signing
    KalshiBTCFeed.ts        — Binance US spot + BTC event/market helpers
    KalshiSnipeHunter.ts    — Core engine: scan → fire → resolve → size (Kelly)
    KalshiSnipeServer.ts    — Bun.serve dashboard (HTML + JSON state API)
  storage/
    SnipeDB.ts              — bun:sqlite persistence for live_trades + session
    TapeDB.ts               — bun:sqlite persistence for the tape archive
  tape/
    TapeCollector.ts        — Settled-event enumeration + trade tape pull
    TapeAnalyzer.ts         — Bucket breakdowns over the tape archive

kalshi-snipe-live.ts        — CLI entry: run hunter (+ optional GUI)
kalshi-tape-collect.ts      — CLI entry: collect tape to SQLite
kalshi-tape-report.ts       — CLI entry: print bucket report
```

## Legacy Python bot

The original Python implementation lives under `Legacy - Python/`. It
remains runnable and its SQLite databases (`kalshi_snipe.db`,
`kalshi_tape.db`) are schema-compatible with the new TS path so the two
can coexist during migration. See `Legacy - Python/CLAUDE.md` for the
full history.

## Critical rules

- Only push to the `clog` branch; `main` is read-only.
- Never inflate numbers — start from $20 and show bust risk honestly.
- Min bet $1; max bet 25% of bankroll (hard cap).
- Live mode requires `--live` flag + Kalshi credentials; paper is default.
