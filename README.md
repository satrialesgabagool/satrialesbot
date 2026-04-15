# satrialesbot

## `main` — Polymarket BTC + weather engine

See friend's commits on `main`. Two tracks: BTC 5-minute binary markets and
Polymarket daily weather bracket markets.

## `Kalshi-ww-bot` — Kalshi weather + whale scanner (paper)

Standalone detectors that write high-conviction trade rows to
`results/high-conviction.csv`. No auto-execution; you review the CSV and
decide.

### Weather ensemble scanner

Pulls forecasts from every configured source (Open-Meteo best_match / ECMWF
/ GFS + NOAA NWS free; OpenWeather / Tomorrow.io / Visual Crossing /
WeatherAPI / Pirate Weather paid), computes an ensemble mean + spread,
converts via Gaussian CDF to per-bracket probability, and flags Kalshi
weather markets where `model_prob − yes_ask/100` exceeds the configured
edge threshold. Tight cross-source agreement boosts conviction.

```
bun run kalshi:weather --min-edge-bps 1000 --max-spread 4 --max-horizon 48
```

### Whale flow scanner

Streams trades from Kalshi (REST poll by default, WS available) into
per-market rolling windows. Flags events where the short window has
outsized notional, strong taker-side directionality, and a high z-score
versus the trailing baseline.

```
bun run kalshi:whale --min-notional 5000 --min-directionality 0.7 --min-z 3
```

### Run both concurrently

```
bun run kalshi:both
```

### Setup

```
bun install
cp .env.example .env
# fill in weather API keys as you acquire them; Kalshi keys not needed for
# read-only scanners
bun run check
bun run kalshi:weather
```
