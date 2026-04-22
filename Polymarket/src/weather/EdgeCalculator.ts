/**
 * Edge Calculator for Weather Temperature Markets.
 *
 * Compares ensemble forecast probabilities against Polymarket bracket prices.
 * When our probability differs from market price by 8%+, that's a trade.
 *
 * Position sizing uses quarter-Kelly criterion:
 *   f = 0.25 * edge / (1 - marketPrice)
 *
 * With a 25% max position cap to prevent over-concentration.
 *
 * Fee structure: Weather markets have 0% maker fee, 5% taker fee.
 * We always place limit orders → 0% fees → pure edge capture.
 */

import { blendedBracketProb } from "./EnsembleForecast";
import type { WeatherMarket, TempBracket, EnsembleResult, BracketEdge, WeatherOpportunity } from "./types";

// ─── Kelly criterion ────────────────────────────────────────────────

/**
 * Quarter-Kelly position sizing.
 *
 * Full Kelly: f = (bp - q) / b
 * where b = payout odds, p = our probability, q = 1-p
 *
 * For binary markets at price X:
 *   b = (1/X - 1), p = our probability, q = 1-p
 *
 * Quarter Kelly divides by 4 for safety.
 */
function kellyFraction(
  forecastProb: number,
  marketPrice: number,
  kellyDivisor: number = 4,
): number {
  if (marketPrice <= 0 || marketPrice >= 1) return 0;
  if (forecastProb <= marketPrice) return 0; // No edge

  const b = (1 / marketPrice) - 1; // Payout odds
  const p = forecastProb;
  const q = 1 - p;

  const fullKelly = (b * p - q) / b;
  return Math.max(0, fullKelly / kellyDivisor);
}

// ─── Edge computation ───────────────────────────────────────────────

/**
 * Compute edges for all brackets in a weather market.
 *
 * For each bracket, we compare:
 *   edge = forecastProb - marketPrice (for BUY YES)
 *   edge = (1-forecastProb) - noPrice (for BUY NO)
 *
 * Returns only brackets with edge >= minEdge.
 */
export function computeEdges(
  market: WeatherMarket,
  ensemble: EnsembleResult,
  config: {
    minEdge: number;
    kellyFraction: number;
    maxPositionPct: number;
    bankroll: number;
  },
): BracketEdge[] {
  const edges: BracketEdge[] = [];

  for (const bracket of market.brackets) {
    const forecastProb = blendedBracketProb(
      ensemble,
      bracket.lowTemp,
      bracket.highTemp,
    );

    const yesPrice = bracket.outcomePrices[0];
    const noPrice = bracket.outcomePrices[1];

    // Check BUY YES edge (market underpricing this bracket)
    const yesEdge = forecastProb - yesPrice;
    if (yesEdge >= config.minEdge && yesPrice > 0.01 && yesPrice < 0.99) {
      const kelly = kellyFraction(forecastProb, yesPrice, 1 / config.kellyFraction);
      const maxSize = config.bankroll * config.maxPositionPct;
      const suggestedSize = Math.min(config.bankroll * kelly, maxSize);

      // Minimum order is 5 USDC on Polymarket
      if (suggestedSize >= 5) {
        edges.push({
          bracket,
          forecastProb,
          marketPrice: yesPrice,
          edge: yesEdge,
          action: "BUY_YES",
          kellyFraction: kelly,
          suggestedSize: Math.round(suggestedSize * 100) / 100,
        });
      }
    }

    // Check BUY NO edge (market overpricing this bracket)
    const noForecastProb = 1 - forecastProb;
    const noEdge = noForecastProb - noPrice;
    if (noEdge >= config.minEdge && noPrice > 0.01 && noPrice < 0.99) {
      const kelly = kellyFraction(noForecastProb, noPrice, 1 / config.kellyFraction);
      const maxSize = config.bankroll * config.maxPositionPct;
      const suggestedSize = Math.min(config.bankroll * kelly, maxSize);

      if (suggestedSize >= 5) {
        edges.push({
          bracket,
          forecastProb: noForecastProb,
          marketPrice: noPrice,
          edge: noEdge,
          action: "BUY_NO",
          kellyFraction: kelly,
          suggestedSize: Math.round(suggestedSize * 100) / 100,
        });
      }
    }
  }

  // Sort by edge descending
  edges.sort((a, b) => b.edge - a.edge);

  return edges;
}

/**
 * Find all opportunities across multiple markets.
 */
export function findOpportunities(
  markets: WeatherMarket[],
  ensembles: Map<string, EnsembleResult>,
  config: {
    minEdge: number;
    kellyFraction: number;
    maxPositionPct: number;
    bankroll: number;
  },
): WeatherOpportunity[] {
  const opportunities: WeatherOpportunity[] = [];

  for (const market of markets) {
    // Match ensemble to market by city name
    const cityKey = market.city.toLowerCase().replace(/\s+/g, "-");
    const ensemble = ensembles.get(cityKey)
      ?? ensembles.get(market.city.toLowerCase())
      ?? findEnsembleByCity(ensembles, market.city);

    if (!ensemble) continue;

    const edges = computeEdges(market, ensemble, config);

    opportunities.push({
      market,
      ensemble,
      edges,
      bestEdge: edges.length > 0 ? edges[0] : null,
      scannedAt: Date.now(),
    });
  }

  // Sort by best edge
  opportunities.sort((a, b) => {
    const aEdge = a.bestEdge?.edge ?? 0;
    const bEdge = b.bestEdge?.edge ?? 0;
    return bEdge - aEdge;
  });

  return opportunities;
}

/**
 * Find opportunities using city+date keyed ensemble map.
 * Keys are in format "city-slug|YYYY-MM-DD".
 */
export function findOpportunitiesByDate(
  markets: WeatherMarket[],
  ensembles: Map<string, EnsembleResult>,
  config: {
    minEdge: number;
    kellyFraction: number;
    maxPositionPct: number;
    bankroll: number;
  },
): WeatherOpportunity[] {
  const opportunities: WeatherOpportunity[] = [];

  for (const market of markets) {
    const cityKey = market.city.toLowerCase().replace(/\s+/g, "-");
    // Look up by city+date compound key
    const ensemble = ensembles.get(`${cityKey}|${market.date}`)
      ?? findEnsembleByDate(ensembles, market.city, market.date);

    if (!ensemble) continue;

    const edges = computeEdges(market, ensemble, config);

    opportunities.push({
      market,
      ensemble,
      edges,
      bestEdge: edges.length > 0 ? edges[0] : null,
      scannedAt: Date.now(),
    });
  }

  opportunities.sort((a, b) => {
    const aEdge = a.bestEdge?.edge ?? 0;
    const bEdge = b.bestEdge?.edge ?? 0;
    return bEdge - aEdge;
  });

  return opportunities;
}

function findEnsembleByCity(
  ensembles: Map<string, EnsembleResult>,
  cityName: string,
): EnsembleResult | undefined {
  for (const [key, result] of ensembles) {
    if (result.city.toLowerCase() === cityName.toLowerCase()) return result;
  }
  return undefined;
}

function findEnsembleByDate(
  ensembles: Map<string, EnsembleResult>,
  cityName: string,
  date: string,
): EnsembleResult | undefined {
  for (const [key, result] of ensembles) {
    if (result.city.toLowerCase() === cityName.toLowerCase() && result.date === date) return result;
  }
  return undefined;
}

/**
 * Format a bracket label for display/logging.
 */
export function formatBracket(bracket: TempBracket): string {
  const unit = bracket.unit;
  if (!isFinite(bracket.lowTemp)) return `<=${bracket.highTemp}${unit}`;
  if (!isFinite(bracket.highTemp)) return `>=${bracket.lowTemp}${unit}`;
  if (bracket.lowTemp === bracket.highTemp) return `${bracket.lowTemp}${unit}`;
  return `${bracket.lowTemp}-${bracket.highTemp}${unit}`;
}
