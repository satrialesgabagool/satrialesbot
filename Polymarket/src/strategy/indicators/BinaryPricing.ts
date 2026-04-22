/**
 * Black-Scholes binary option pricing + logit-space probability blending.
 *
 * Binary option pricing for 5-minute BTC windows:
 * - Models the probability that BTC finishes above/below the window open price
 * - Uses implied volatility from recent price action
 * - Time decay is crucial: a 0.05% move with 4 minutes left is uncertain,
 *   but with 10 seconds left it's almost certain
 *
 * Logit-space blending (joicodev method):
 * - Instead of averaging probabilities directly (which is biased),
 *   convert to logit space (log-odds), blend, then convert back
 * - logit(p) = ln(p / (1-p))
 * - This is mathematically cleaner for combining probability estimates
 *
 * Feb 2026 changes:
 * - 500ms taker delay removed (faster fills)
 * - Dynamic taker fees via feeRateBps (query before each order)
 * - 5-share minimum order size
 */

// ─── Black-Scholes binary pricing ──────────────────────────────────

/**
 * Standard normal CDF (same as in ensemble forecast, but here for independence).
 */
function normCdf(x: number): number {
  if (!isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) * (
    0.3193815 * t - 0.3565638 * t * t + 1.781478 * t * t * t
    - 1.8212560 * t * t * t * t + 1.3302744 * t * t * t * t * t
  );
  return x >= 0 ? 1 - p : p;
}

/**
 * Black-Scholes probability that BTC finishes ABOVE the window open price.
 *
 * @param currentPrice - Current BTC price
 * @param openPrice - Window open price (strike)
 * @param secondsRemaining - Seconds until window closes
 * @param annualizedVol - Annualized volatility (default: 0.60 for BTC)
 *
 * The key insight: as time → 0, the probability converges to
 * 0 or 1 based on whether current > open. This is exactly
 * what we want for T-10s entry timing.
 */
export function binaryUpProb(
  currentPrice: number,
  openPrice: number,
  secondsRemaining: number,
  annualizedVol: number = 0.60,
): number {
  if (secondsRemaining <= 0) {
    return currentPrice >= openPrice ? 1.0 : 0.0;
  }

  // Convert to years (1 year = 31,536,000 seconds)
  const T = secondsRemaining / 31_536_000;

  // d2 = (ln(S/K) - 0.5 * σ² * T) / (σ * √T)
  // For binary options, we use d2 (not d1)
  const sigmaRootT = annualizedVol * Math.sqrt(T);
  if (sigmaRootT < 1e-10) {
    return currentPrice >= openPrice ? 1.0 : 0.0;
  }

  const d2 = (Math.log(currentPrice / openPrice) - 0.5 * annualizedVol * annualizedVol * T) / sigmaRootT;

  return normCdf(d2);
}

/**
 * Estimate realized volatility from recent price ticks.
 * Uses 1-second log returns over the last N seconds.
 */
export function estimateVolatility(
  prices: { price: number; timestamp: number }[],
  windowSeconds: number = 60,
): number {
  if (prices.length < 10) return 0.60; // Default BTC vol

  const now = prices[prices.length - 1].timestamp;
  const recent = prices.filter(p => now - p.timestamp < windowSeconds * 1000);

  if (recent.length < 5) return 0.60;

  // Sample at ~1-second intervals
  const returns: number[] = [];
  let lastPrice = recent[0].price;
  let lastTime = recent[0].timestamp;

  for (let i = 1; i < recent.length; i++) {
    const dt = recent[i].timestamp - lastTime;
    if (dt >= 500) { // At least 500ms apart
      const logReturn = Math.log(recent[i].price / lastPrice);
      returns.push(logReturn);
      lastPrice = recent[i].price;
      lastTime = recent[i].timestamp;
    }
  }

  if (returns.length < 3) return 0.60;

  // Standard deviation of log returns
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualize: we have ~1-second returns
  // seconds per year = 31,536,000
  const avgInterval = (recent[recent.length - 1].timestamp - recent[0].timestamp) / returns.length / 1000;
  const periodsPerYear = 31_536_000 / Math.max(avgInterval, 0.5);

  return stdDev * Math.sqrt(periodsPerYear);
}

// ─── Logit-space probability blending ──────────────────────────────

/**
 * Convert probability to logit (log-odds).
 * logit(p) = ln(p / (1-p))
 *
 * Clamps input to [0.001, 0.999] to avoid ±Infinity.
 */
export function logit(p: number): number {
  const clamped = Math.max(0.001, Math.min(0.999, p));
  return Math.log(clamped / (1 - clamped));
}

/**
 * Convert logit back to probability.
 * sigmoid(x) = 1 / (1 + e^(-x))
 */
export function sigmoid(x: number): number {
  if (x > 20) return 0.999;
  if (x < -20) return 0.001;
  return 1 / (1 + Math.exp(-x));
}

/**
 * Blend multiple probability estimates in logit space.
 *
 * This is mathematically superior to simple weighted averaging because:
 * - It respects the probability scale (bounded [0,1])
 * - It's equivalent to multiplying likelihood ratios
 * - It handles near-0 and near-1 probabilities gracefully
 *
 * Example:
 *   blend([{p: 0.70, w: 0.6}, {p: 0.80, w: 0.4}])
 *   In raw space: 0.70 * 0.6 + 0.80 * 0.4 = 0.74
 *   In logit space: sigmoid(logit(0.70) * 0.6 + logit(0.80) * 0.4)
 *                 = sigmoid(0.847 * 0.6 + 1.386 * 0.4)
 *                 = sigmoid(1.063)
 *                 = 0.743
 *
 * The difference is larger at extreme probabilities.
 */
export function blendLogit(
  estimates: Array<{ probability: number; weight: number }>,
): number {
  if (estimates.length === 0) return 0.5;
  if (estimates.length === 1) return estimates[0].probability;

  let totalWeight = 0;
  let weightedLogit = 0;

  for (const { probability, weight } of estimates) {
    weightedLogit += logit(probability) * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0.5;

  return sigmoid(weightedLogit / totalWeight);
}

// ─── Fee calculation (Feb 2026 rules) ──────────────────────────────

/**
 * Calculate Polymarket fees.
 *
 * Weather: 5% taker, 0% maker
 * Crypto: 7.2% taker, 0% maker
 * Sports: 3% taker, 0% maker
 * Geopolitics: 0% taker, 0% maker
 *
 * Fee formula: fee = feeRate * price * (1 - price)
 * This means fees are highest at 50% price and zero at 0% or 100%.
 *
 * In Feb 2026, dynamic fees via feeRateBps were introduced.
 * Always query the market's feeRateBps before placing orders.
 */
export function calculateFee(
  price: number,
  shares: number,
  feeRateBps: number = 720, // Default 7.2% for crypto
  isMaker: boolean = true,
): number {
  if (isMaker) return 0; // Makers pay 0% on ALL market types

  const feeRate = feeRateBps / 10000;
  const feePerShare = feeRate * price * (1 - price);
  return feePerShare * shares;
}

/**
 * Net cost of buying shares including fees.
 */
export function netCost(
  price: number,
  shares: number,
  feeRateBps: number = 720,
  isMaker: boolean = true,
): number {
  const baseCost = price * shares;
  const fee = calculateFee(price, shares, feeRateBps, isMaker);
  return baseCost + fee;
}
