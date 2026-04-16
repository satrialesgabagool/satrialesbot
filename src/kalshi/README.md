# `src/kalshi/` — Kalshi Exchange Integration

Everything that talks to Kalshi's trade API v2 lives here.

## Files

| File | Purpose |
|------|---------|
| **`KalshiClient.ts`** | REST client. Handles events, markets, orderbook, trades. Returns `FixedPointDollars` strings ("0.72") not cents. Has `listTrades()`, `paginateTrades()` for whale tracker. |
| **`KalshiAuth.ts`** | RSA-PSS SHA-256 signed headers for authenticated endpoints. Requires `KALSHI_ACCESS_KEY` + `KALSHI_PRIVATE_KEY`. |
| **`KalshiWS.ts`** | WebSocket client (via `ReconnectingWebSocket`). Subscribes to `trade` channel for whale tracker. |
| **`KalshiWeatherFinder.ts`** | Finds active `KXHIGH*` markets and parses each into `TempBracket[]`. Handles the exclusive-strike convention. |
| **`types.ts`** | Shared types: `WeatherMarket`, `TempBracket`, `KalshiTrade`, API response shapes. |
| **`cli.ts`** | Commander-based CLI. Entry point for `bun run kalshi:*` scripts. |
| **`smoke.ts`** | Manual smoke test for client wiring (run once after auth setup). |

## Subdirectories

- **`weather/`** — weather ensemble strategy (see `weather/README.md`)
- **`whale/`** — whale flow tracker strategy (see `whale/README.md`)
- **`output/`** — signal log writers (CSV + JSONL)

## Entry Points

- Production: `kalshi-weather-live.ts` at repo root calls into this directory
- CLI: `bun run kalshi:weather`, `bun run kalshi:whale`, `bun run kalshi:both`

## Conventions

1. **Prices are floats 0.0–1.0** on the API boundary (not cents). Convert only at display time.
2. **Strike convention is EXCLUSIVE** — "greater than 70" means `actual > 70.00`, not `>=`. Always check `bracket.exclusive`.
3. **Rate limits** — Kalshi is ~10 req/s. Use `fetchWithRetry` for all API calls; don't roll your own fetch.
