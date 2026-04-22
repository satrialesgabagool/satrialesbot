export type SignalKind =
  | "fear_greed"
  | "funding_rate"
  | "open_interest"
  | "liquidation"
  | "news_sentiment"
  | "whale_transfer";

export interface SignalEvent<T = unknown> {
  kind: SignalKind;
  payload: T;
  timestamp: number;
  receivedAt: number;
  source: string;
}

// --- Per-source payload types ---

export interface FearGreedPayload {
  value: number; // 0-100
  classification: "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed";
  previousValue: number;
  previousClassification: string;
}

export interface FundingRatePayload {
  symbol: string;
  rate: number;
  exchange: string;
}

export interface OpenInterestPayload {
  symbol: string;
  openInterest: number;
  changePercent1h: number;
}

export interface LiquidationPayload {
  symbol: string;
  side: "long" | "short";
  amountUsd: number;
  exchange: string;
  timestamp: number;
}

export interface NewsSentimentPayload {
  title: string;
  source: string;
  sentiment: "positive" | "negative" | "neutral";
  importance: "low" | "medium" | "high";
  url: string;
}

export interface WhaleTransferPayload {
  symbol: string;
  amountUsd: number;
  fromOwner: string;
  toOwner: string;
  transactionType: string;
}

/**
 * A SignalSource connects to an external data provider,
 * emits typed events, and can be started/stopped.
 */
export interface SignalSource {
  readonly name: string;
  readonly kinds: SignalKind[];

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Set by SignalBus during registration. */
  emit?: (event: SignalEvent) => void;
}
