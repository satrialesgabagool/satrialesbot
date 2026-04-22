import type {
  SignalKind,
  SignalEvent,
  FearGreedPayload,
  FundingRatePayload,
  OpenInterestPayload,
  LiquidationPayload,
  NewsSentimentPayload,
  WhaleTransferPayload,
} from "./types";

/** Read-only signal state for strategies. */
export interface ISignalSnapshot {
  readonly fearGreed: FearGreedPayload | null;
  readonly fundingRate: FundingRatePayload | null;
  readonly openInterest: OpenInterestPayload | null;
  readonly recentLiquidations: ReadonlyArray<LiquidationPayload>;
  readonly recentNews: ReadonlyArray<NewsSentimentPayload>;
  readonly recentWhaleTransfers: ReadonlyArray<WhaleTransferPayload>;

  /** Aggregate bias from all signals: -1.0 (bearish) to +1.0 (bullish). */
  readonly bias: number;

  /** How many signal sources are connected and fresh. */
  readonly healthySourceCount: number;
  readonly totalSourceCount: number;

  isStale(kind: SignalKind, maxAgeMs: number): boolean;
  lastUpdated(kind: SignalKind): number | null;
}

const ROLLING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

interface BiasWeights {
  fearGreed: number;
  fundingRate: number;
  liquidation: number;
}

const DEFAULT_WEIGHTS: BiasWeights = {
  fearGreed: 0.4,
  fundingRate: 0.3,
  liquidation: 0.3,
};

export class SignalSnapshot implements ISignalSnapshot {
  private lastValues = new Map<SignalKind, { payload: unknown; receivedAt: number }>();
  private liquidations: LiquidationPayload[] = [];
  private news: NewsSentimentPayload[] = [];
  private whaleTransfers: WhaleTransferPayload[] = [];
  private weights: BiasWeights;

  totalSourceCount = 0;
  healthySourceCount = 0;

  constructor(weights?: Partial<BiasWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /** Called by SignalBus when a new event arrives. */
  update(event: SignalEvent): void {
    this.lastValues.set(event.kind, {
      payload: event.payload,
      receivedAt: event.receivedAt,
    });

    // Maintain rolling windows
    const now = Date.now();
    if (event.kind === "liquidation") {
      this.liquidations.push(event.payload as LiquidationPayload);
      this.liquidations = this.liquidations.filter(
        (l) => now - l.timestamp < ROLLING_WINDOW_MS,
      );
    } else if (event.kind === "news_sentiment") {
      this.news.push(event.payload as NewsSentimentPayload);
      if (this.news.length > 50) this.news = this.news.slice(-50);
    } else if (event.kind === "whale_transfer") {
      this.whaleTransfers.push(event.payload as WhaleTransferPayload);
      if (this.whaleTransfers.length > 20) this.whaleTransfers = this.whaleTransfers.slice(-20);
    }
  }

  get fearGreed(): FearGreedPayload | null {
    return this.getLatest<FearGreedPayload>("fear_greed");
  }

  get fundingRate(): FundingRatePayload | null {
    return this.getLatest<FundingRatePayload>("funding_rate");
  }

  get openInterest(): OpenInterestPayload | null {
    return this.getLatest<OpenInterestPayload>("open_interest");
  }

  get recentLiquidations(): ReadonlyArray<LiquidationPayload> {
    return this.liquidations;
  }

  get recentNews(): ReadonlyArray<NewsSentimentPayload> {
    return this.news;
  }

  get recentWhaleTransfers(): ReadonlyArray<WhaleTransferPayload> {
    return this.whaleTransfers;
  }

  get bias(): number {
    let totalWeight = 0;
    let weightedSum = 0;

    // Fear & Greed: 0-100, map to -1..+1 (0 = extreme fear = bearish, 100 = extreme greed = bullish)
    const fg = this.fearGreed;
    if (fg) {
      const normalized = (fg.value - 50) / 50; // -1 to +1
      weightedSum += normalized * this.weights.fearGreed;
      totalWeight += this.weights.fearGreed;
    }

    // Funding rate: positive = longs pay shorts = bullish sentiment, but contrarian signal
    // High positive funding = market overheated = slightly bearish signal
    const fr = this.fundingRate;
    if (fr) {
      const clamped = Math.max(-0.001, Math.min(0.001, fr.rate));
      const normalized = -(clamped / 0.001); // contrarian: high funding = bearish
      weightedSum += normalized * this.weights.fundingRate;
      totalWeight += this.weights.fundingRate;
    }

    // Liquidations: net long liquidations = bearish, net short liquidations = bullish
    if (this.liquidations.length > 0) {
      let longLiq = 0;
      let shortLiq = 0;
      for (const l of this.liquidations) {
        if (l.side === "long") longLiq += l.amountUsd;
        else shortLiq += l.amountUsd;
      }
      const total = longLiq + shortLiq;
      if (total > 0) {
        const normalized = (shortLiq - longLiq) / total; // -1 (all longs) to +1 (all shorts)
        weightedSum += normalized * this.weights.liquidation;
        totalWeight += this.weights.liquidation;
      }
    }

    if (totalWeight === 0) return 0;
    return Math.max(-1, Math.min(1, weightedSum / totalWeight));
  }

  isStale(kind: SignalKind, maxAgeMs: number): boolean {
    const entry = this.lastValues.get(kind);
    if (!entry) return true;
    return Date.now() - entry.receivedAt > maxAgeMs;
  }

  lastUpdated(kind: SignalKind): number | null {
    return this.lastValues.get(kind)?.receivedAt ?? null;
  }

  private getLatest<T>(kind: SignalKind): T | null {
    const entry = this.lastValues.get(kind);
    if (!entry) return null;
    return entry.payload as T;
  }
}
