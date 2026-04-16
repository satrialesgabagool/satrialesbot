# `src/kalshi/weather/` — Weather Ensemble Strategy

Scans Kalshi `KXHIGH` markets and flags brackets where our ensemble forecast
disagrees with market-implied probability.

## Files

| File | Purpose |
|------|---------|
| **`WeatherScanner.ts`** | Main scan loop. Every N minutes: fetch active markets → run ensemble → compare to market prices → emit signals where `edge >= minEdge`. |
| **`KalshiEnsemble.ts`** | Thin wrapper over `src/weather/WeatherEnsemble.ts`. Adds Kalshi city-code aliases (NY, LAX, CHI, etc.) and re-exports `bracketProbability`. |
| **`sources/`** | Optional paid forecast APIs (OpenWeather, PirateWeather, Tomorrow.io, VisualCrossing, WeatherAPI). Each is a simple fetcher returning `{date, highF, lowF}`. Disabled if no API key. |
| **`sources/types.ts`** | Common `ForecastSource` interface all paid sources implement. |
| **`sources/index.ts`** | Exports enabled sources based on env vars present. |

## How signals are generated

```
For each city:
  1. Fetch multi-source forecast (Open-Meteo GFS + NOAA weather.gov + paid sources)
  2. Build ensemble: mean + sigma across all members
  3. For each bracket in the KXHIGH market:
     - prob = gaussianCDF(upper, mean, sigma) − gaussianCDF(lower, mean, sigma)
     - edge = prob − marketPrice
  4. Filter: price >= $0.03 (liquidity), edge >= 0.10 (min edge), hoursLeft < 48
  5. Emit signal with reason string: "NYC high 2026-04-16 [72-74°F]: model=24% vs market=11%, edge=1300bp"
```

## Expansion targets

- **✅ GFS 31-member ensemble** — shipped. `fetchKalshiEnsemble()` now pulls the full GEFS distribution via `src/weather/GFSEnsemble.ts`. Each `KalshiEnsembleDay` optionally carries `highFMembers: number[]` (31 members when available). When present, the scanner routes through empirical bracket probability (`count(members in bracket) / n` with Laplace smoothing) instead of the Gaussian approximation — captures fat tails and skew.
- **NOAA METAR same-day lock** (planned) — once observed airport temp is within 1-2°F of sunset forecast, bracket outcome is near-certain. Real-time obs from `aviationweather.gov` (no key needed).

## Config knobs (`SimulatorConfig`)

| Key | Default | Purpose |
|-----|---------|---------|
| `minEdge` | `0.10` | Minimum model−market edge to emit signal |
| `minBracketPrice` | `0.03` | Skip penny brackets (phantom liquidity on Kalshi) |
| `minYesBid` | `0` | Require visible bid-side if > 0 |
| `maxModelSpreadF` | `4.0` | Skip when ensemble members disagree by more than this (°F) |
| `cheapBracketBonus` | `true` | Mild bonus (1.3x/1.15x) on cheap brackets — was 2.0x, caused live sim wipeout |
