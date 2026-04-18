# `src/kalshi/whale/` — Whale Flow Tracker

Watches Kalshi's trade WebSocket and flags markets where a large directional flow
appears in a short time window. The hypothesis: informed money moves before price.

## Files

| File | Purpose |
|------|---------|
| **`WhaleScanner.ts`** | Main scan loop. Consumes `TradeFeed`, feeds into `VolumeTracker`, emits signal when `WhaleDetector` fires. |
| **`TradeFeed.ts`** | WebSocket consumer. Subscribes to the `trade` channel, passes each trade to `VolumeTracker`. |
| **`VolumeTracker.ts`** | Rolling 5-minute windows, per-market. Tracks notional USD, yes/no split, trade count. |
| **`WhaleDetector.ts`** | Statistical trigger: if the current window's notional z-score exceeds `minZScore` AND directionality > 60%, flag it. |
| **`types.ts`** | `WhaleSignal`, `TradeWindow`, detector config. |

## How signals are generated

```
On each trade event:
  1. Append to rolling 5-min window for that market
  2. Compute window notional z-score vs trailing 30-min mean/std
  3. If z >= 3.0 AND |yes_frac − 0.5| >= 0.2 (directional):
     4. Emit signal: "$12.4k yes flow in 5min, z=3.8, 85% directional"
```

## Config knobs

| Key | Default | Purpose |
|-----|---------|---------|
| `windowSec` | `300` | Rolling window length (5 min) |
| `baselineSec` | `1800` | Baseline window for z-score (30 min) |
| `minZScore` | `3.0` | Trigger threshold |
| `minDirectional` | `0.6` | Yes/no imbalance required (0.6 = 60% one-sided) |
| `minNotionalUsd` | `2000` | Ignore windows below this total volume |

## Notes

- The whale signal does NOT carry an edge (`edgeBps = 0`). It's a directional hint, not a mispricing.
- Dashboard categorizes whale signals with 🐋, weather with 🌤️.
- When weather + whale agree on the same market, conviction should be compounded. Not yet implemented.
