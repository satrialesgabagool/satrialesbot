/**
 * Archetapp-inspired 7-Indicator Composite Signal.
 *
 * Source: Polymarket Discord analysis by Archetapp (top 5-min trader).
 * These indicators are computed from real-time BTC price feeds
 * and combined into a single directional score [-1.0, +1.0].
 *
 * Indicators and weights:
 *   1. Window Delta      (5-7) — BTC price vs window open. DOMINANT signal.
 *   2. Micro Momentum    (2.0) — 10-second EMA slope
 *   3. Acceleration      (1.5) — Rate of change of momentum
 *   4. EMA 9/21 Crossover(1.0) — Classic trend following
 *   5. RSI 14            (1.5) — Oversold/overbought
 *   6. Volume Surge      (1.0) — Tick count spike detection
 *   7. Tick Trend         (2.0) — Real-time up/down tick ratio
 *
 * Key insight from Archetapp: "Window Delta is everything. If BTC is up
 * 0.10%+ from window open with 10 seconds left, it almost never reverses."
 */

export interface TickData {
  price: number;
  timestamp: number;
}

export interface CompositeResult {
  score: number; // -1.0 (bearish) to +1.0 (bullish)
  direction: "UP" | "DOWN" | "NEUTRAL";
  confidence: number; // 0-1, how many indicators agree
  components: {
    windowDelta: number;
    microMomentum: number;
    acceleration: number;
    emaCrossover: number;
    rsi: number;
    volumeSurge: number;
    tickTrend: number;
  };
  raw: {
    deltaPercent: number;
    momentumSlope: number;
    ema9: number;
    ema21: number;
    rsiValue: number;
    ticksPerSec: number;
    upTickRatio: number;
  };
}

// ─── Indicator weights ──────────────────────────────────────────────

const WEIGHTS = {
  windowDelta: 6.0,     // 5-7 range, use 6
  microMomentum: 2.0,
  acceleration: 1.5,
  emaCrossover: 1.0,
  rsi: 1.5,
  volumeSurge: 1.0,
  tickTrend: 2.0,
};

const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

// ─── Ring buffer for price ticks ────────────────────────────────────

const MAX_TICKS = 2000; // ~5min of data at 6+ ticks/sec

export class CompositeIndicator {
  private ticks: TickData[] = [];
  private windowOpenPrice: number = 0;
  private windowStartMs: number = 0;

  /**
   * Set the window's opening price and start time.
   * Call this when a new 5-min window begins.
   */
  setWindowOpen(price: number, startMs: number): void {
    this.windowOpenPrice = price;
    this.windowStartMs = startMs;
    this.ticks = [];
  }

  /**
   * Feed a new price tick.
   */
  addTick(price: number, timestamp: number = Date.now()): void {
    this.ticks.push({ price, timestamp });
    if (this.ticks.length > MAX_TICKS) {
      this.ticks = this.ticks.slice(-MAX_TICKS);
    }
  }

  /**
   * Compute the full 7-indicator composite score.
   * Returns a score in [-1.0, +1.0] with component breakdown.
   */
  compute(): CompositeResult {
    if (this.ticks.length < 10 || this.windowOpenPrice === 0) {
      return this.neutralResult();
    }

    const currentPrice = this.ticks[this.ticks.length - 1].price;
    const now = this.ticks[this.ticks.length - 1].timestamp;

    // 1. Window Delta — price vs window open
    const deltaPercent = ((currentPrice - this.windowOpenPrice) / this.windowOpenPrice) * 100;
    const windowDelta = this.scoreWindowDelta(deltaPercent);

    // 2. Micro Momentum — 10-second EMA slope
    const { slope: momentumSlope, microMomentum } = this.scoreMicroMomentum(now);

    // 3. Acceleration — rate of change of momentum
    const acceleration = this.scoreAcceleration(now);

    // 4. EMA 9/21 Crossover
    const { ema9, ema21, emaCrossover } = this.scoreEMACrossover();

    // 5. RSI 14
    const { rsiValue, rsi } = this.scoreRSI();

    // 6. Volume Surge — tick frequency spike
    const { ticksPerSec, volumeSurge } = this.scoreVolumeSurge(now);

    // 7. Tick Trend — up/down tick ratio over last 30s
    const { upTickRatio, tickTrend } = this.scoreTickTrend(now);

    // Weighted combination
    const rawScore = (
      windowDelta * WEIGHTS.windowDelta +
      microMomentum * WEIGHTS.microMomentum +
      acceleration * WEIGHTS.acceleration +
      emaCrossover * WEIGHTS.emaCrossover +
      rsi * WEIGHTS.rsi +
      volumeSurge * WEIGHTS.volumeSurge +
      tickTrend * WEIGHTS.tickTrend
    ) / TOTAL_WEIGHT;

    // Clamp to [-1, 1]
    const score = Math.max(-1, Math.min(1, rawScore));

    // Confidence: how many indicators agree on direction
    const signals = [windowDelta, microMomentum, acceleration, emaCrossover, rsi, volumeSurge, tickTrend];
    const agreeing = signals.filter(s => Math.sign(s) === Math.sign(score)).length;
    const confidence = agreeing / signals.length;

    const direction = score > 0.05 ? "UP" : score < -0.05 ? "DOWN" : "NEUTRAL";

    return {
      score,
      direction,
      confidence,
      components: { windowDelta, microMomentum, acceleration, emaCrossover, rsi, volumeSurge, tickTrend },
      raw: { deltaPercent, momentumSlope, ema9, ema21, rsiValue, ticksPerSec, upTickRatio },
    };
  }

  // ─── Individual indicator scorers ─────────────────────────────────

  /**
   * Window Delta: BTC price vs window open price.
   * +0.10% → strong bullish (+1.0)
   * -0.10% → strong bearish (-1.0)
   * Sigmoid scaling for smooth transitions.
   */
  private scoreWindowDelta(deltaPercent: number): number {
    // Sigmoid: output ~ ±1 when delta ~ ±0.10%
    const k = 15; // Steepness (reaches ~0.78 at ±0.10%)
    return (2 / (1 + Math.exp(-k * deltaPercent))) - 1;
  }

  /**
   * Micro Momentum: 10-second EMA slope.
   * Positive slope = price trending up = bullish.
   */
  private scoreMicroMomentum(now: number): { slope: number; microMomentum: number } {
    const window10s = this.ticks.filter(t => now - t.timestamp < 10_000);
    if (window10s.length < 3) return { slope: 0, microMomentum: 0 };

    // Simple linear regression slope over last 10 seconds
    const n = window10s.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      const x = (window10s[i].timestamp - window10s[0].timestamp) / 1000;
      const y = window10s[i].price;
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 1);

    // Normalize: slope of $1/sec is very aggressive
    const normalized = Math.max(-1, Math.min(1, slope / 0.5));
    return { slope, microMomentum: normalized };
  }

  /**
   * Acceleration: rate of change of momentum.
   * Compares 5-second momentum to 10-second momentum.
   */
  private scoreAcceleration(now: number): number {
    const w5 = this.ticks.filter(t => now - t.timestamp < 5_000);
    const w10 = this.ticks.filter(t => now - t.timestamp < 10_000 && now - t.timestamp >= 5_000);

    if (w5.length < 2 || w10.length < 2) return 0;

    const recent = (w5[w5.length - 1].price - w5[0].price) / w5[0].price * 100;
    const prior = (w10[w10.length - 1].price - w10[0].price) / w10[0].price * 100;

    const accel = recent - prior;
    return Math.max(-1, Math.min(1, accel * 20)); // Scale: 0.05% diff → 1.0
  }

  /**
   * EMA 9/21 Crossover.
   * EMA9 > EMA21 = bullish, EMA9 < EMA21 = bearish.
   */
  private scoreEMACrossover(): { ema9: number; ema21: number; emaCrossover: number } {
    if (this.ticks.length < 21) return { ema9: 0, ema21: 0, emaCrossover: 0 };

    const prices = this.ticks.map(t => t.price);
    const ema9 = this.computeEMA(prices, 9);
    const ema21 = this.computeEMA(prices, 21);

    if (ema21 === 0) return { ema9, ema21, emaCrossover: 0 };

    const diff = (ema9 - ema21) / ema21 * 100;
    return {
      ema9,
      ema21,
      emaCrossover: Math.max(-1, Math.min(1, diff * 50)), // 0.02% diff → 1.0
    };
  }

  /**
   * RSI 14 — classic relative strength index.
   * < 30 = oversold (contrarian bullish)
   * > 70 = overbought (contrarian bearish)
   */
  private scoreRSI(): { rsiValue: number; rsi: number } {
    if (this.ticks.length < 15) return { rsiValue: 50, rsi: 0 };

    const changes: number[] = [];
    const recent = this.ticks.slice(-15);
    for (let i = 1; i < recent.length; i++) {
      changes.push(recent[i].price - recent[i - 1].price);
    }

    let avgGain = 0, avgLoss = 0;
    for (const c of changes) {
      if (c > 0) avgGain += c;
      else avgLoss += Math.abs(c);
    }
    avgGain /= 14;
    avgLoss /= 14;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsiValue = 100 - (100 / (1 + rs));

    // Score: RSI 50 = neutral, RSI 30 = bullish (+0.5), RSI 70 = bearish (-0.5)
    // We use it as momentum (not contrarian) for 5-min trading
    const rsi = Math.max(-1, Math.min(1, (rsiValue - 50) / 30));
    return { rsiValue, rsi };
  }

  /**
   * Volume Surge: detect unusual tick frequency.
   * High tick rate = institutional activity = follow the trend.
   */
  private scoreVolumeSurge(now: number): { ticksPerSec: number; volumeSurge: number } {
    const recent5s = this.ticks.filter(t => now - t.timestamp < 5_000).length;
    const baseline30s = this.ticks.filter(t => now - t.timestamp < 30_000).length;

    const ticksPerSec = recent5s / 5;
    const baselineRate = baseline30s / 30;

    if (baselineRate === 0) return { ticksPerSec, volumeSurge: 0 };

    const surgeRatio = ticksPerSec / baselineRate;

    // Surge > 2x baseline = significant
    // Direction follows the last few ticks
    const lastFew = this.ticks.slice(-5);
    const direction = lastFew.length >= 2
      ? Math.sign(lastFew[lastFew.length - 1].price - lastFew[0].price)
      : 0;

    const magnitude = Math.max(0, Math.min(1, (surgeRatio - 1) / 2));
    return { ticksPerSec, volumeSurge: magnitude * direction };
  }

  /**
   * Tick Trend: up/down tick ratio over last 30 seconds.
   * > 60% up ticks = bullish, < 40% up ticks = bearish.
   */
  private scoreTickTrend(now: number): { upTickRatio: number; tickTrend: number } {
    const recent = this.ticks.filter(t => now - t.timestamp < 30_000);
    if (recent.length < 5) return { upTickRatio: 0.5, tickTrend: 0 };

    let upTicks = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].price > recent[i - 1].price) upTicks++;
    }

    const upTickRatio = upTicks / (recent.length - 1);

    // 0.5 = neutral, 0.7 = bullish (+0.67), 0.3 = bearish (-0.67)
    const tickTrend = Math.max(-1, Math.min(1, (upTickRatio - 0.5) / 0.3));
    return { upTickRatio, tickTrend };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private computeEMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private neutralResult(): CompositeResult {
    return {
      score: 0,
      direction: "NEUTRAL",
      confidence: 0,
      components: { windowDelta: 0, microMomentum: 0, acceleration: 0, emaCrossover: 0, rsi: 0, volumeSurge: 0, tickTrend: 0 },
      raw: { deltaPercent: 0, momentumSlope: 0, ema9: 0, ema21: 0, rsiValue: 50, ticksPerSec: 0, upTickRatio: 0.5 },
    };
  }

  /** Get current tick count (for debugging). */
  get tickCount(): number {
    return this.ticks.length;
  }
}
