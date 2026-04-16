# `src/weather/` — Generic Weather Strategy (shared)

Exchange-agnostic weather trading logic. Used by both the Polymarket (legacy) and
Kalshi scanners. Kalshi-specific glue lives in `src/kalshi/weather/`.

## Files

| File | Purpose |
|------|---------|
| **`WeatherEnsemble.ts`** | Multi-model forecast ensemble. Queries Open-Meteo (GFS, ICON, ECMWF seamless) + NOAA weather.gov. Returns `{date, highF_mean, highF_sigma, members[]}`. Also exports `ensembleBracketProbability(mean, spread, lo, hi, hours, members?)` — if `members` is passed, computes empirical probability; otherwise Gaussian. |
| **`GFSEnsemble.ts`** | GEFS 31-member distribution fetcher via Open-Meteo `ensemble-api`. Returns full per-member daily highs/lows — used by bracket-probability math to replace the Gaussian assumption with an empirical count when available. Also exports `empiricalBracketProbability(members, lo, hi)`. |
| **`WeatherForecast.ts`** | Single-source forecast helper. Used when you only need one model, not the full ensemble. |
| **`WeatherMarketFinder.ts`** | Interface `MarketFinderFn` + generic `WeatherMarket` type. Different exchanges supply their own implementation. |
| **`WeatherScanner.ts`** | Generic scanner loop — used by Polymarket code. Kalshi has its own scanner in `src/kalshi/weather/`. |
| **`WeatherSimulator.ts`** | Paper-trading simulator with liquidity filter + bracket weighting. Handles state persistence to `state/weather-sim.json`. This is what `kalshi-weather-live.ts` uses. |
| **`backtest.ts`** | Historical replay. Given a date range + ensemble + market data, walks forward and computes P&L. |

## Forecast Sources (no API key needed)

- **Open-Meteo Seamless** — ICON, GFS, ECMWF combined
- **Open-Meteo GFS** — US standard model
- **NOAA weather.gov** — official US forecast (3-hourly, requires User-Agent)

These three give us 3-6 "members" for the ensemble. Paid sources in `src/kalshi/weather/sources/` add more members when API keys are present.

## Critical details

1. **Celsius → Fahrenheit** — Open-Meteo returns C. Conversion: `F = C × 9/5 + 32`.
2. **"Today's high" timezone** — All Kalshi KXHIGH markets resolve on local city time; `timezone=auto` on Open-Meteo handles this.
3. **Archive vs Forecast** — Past dates use `archive-api.open-meteo.com`, future dates use `api.open-meteo.com`. They're different endpoints.
4. **NOAA User-Agent required** — weather.gov returns 403 without a descriptive UA header.

## Bracket probability — two paths

For a bracket `[lowF, highF]`, `outcome = highF_observed`:

**1. Empirical (preferred when GEFS 31-member available):**
```
P = (count(members in [low-0.5, high+0.5]) + 0.5) / (n + 1)
```
Direct count with Laplace smoothing. Captures fat tails, skew, bimodality — the real shape of the ensemble distribution.

**2. Gaussian (fallback when members unavailable):**
```
P(low < X <= high) = Φ((high - μ)/σ) − Φ((low - μ)/σ)
```
Where μ = ensemble mean, σ = RSS of horizon-based forecast error + cross-model spread.

Both implemented in `WeatherEnsemble.ensembleBracketProbability()` — pass the 6th arg `members` to route to empirical. The empirical path activates when ≥10 members are supplied (smaller samples are too noisy to beat the Gaussian).
