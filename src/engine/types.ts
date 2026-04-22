import type { MarketWindow } from "../util/config";

export interface EngineConfig {
  mode: "sim" | "prod";
  strategyName: string;
  maxRounds: number; // -1 for unlimited
  slotOffset: number; // which future slot to enter (1 = next)
  marketWindow: MarketWindow;
  tickIntervalMs: number;
  stateFlushIntervalMs: number;
  alwaysLog: boolean;
}

export const DEFAULT_ENGINE_CONFIG: Partial<EngineConfig> = {
  mode: "sim",
  maxRounds: -1,
  slotOffset: 1,
  marketWindow: "5m",
  tickIntervalMs: 100,
  stateFlushIntervalMs: 5000,
  alwaysLog: false,
};

export enum RoundPhase {
  INIT = "INIT",
  RUNNING = "RUNNING",
  STOPPING = "STOPPING",
  DONE = "DONE",
}

export interface TrackedOrder {
  orderId: string;
  tokenId: string;
  action: "buy" | "sell";
  orderType: "GTC" | "FOK";
  price: number;
  shares: number;
  filledShares: number;
  expireAtMs: number;
  status: "pending" | "open" | "filled" | "canceled" | "expired" | "failed";
  placedAtMs: number;
  filledAtMs?: number;
}

export interface OrderHistoryEntry {
  action: "buy" | "sell";
  price: number;
  shares: number;
  filledAtMs: number;
}

export interface RoundResult {
  slug: string;
  pnl: number;
  orderCount: number;
  fees?: number;
  fillsRejected?: number;
  resolution?: "UP" | "DOWN";
  openPrice?: number;
  closePrice?: number;
}

export interface PersistentState {
  sessionPnl: number;
  sessionLoss: number;
  roundsCompleted: number;
  activeRounds: ActiveRoundState[];
  completedRounds: RoundResult[];
}

export interface ActiveRoundState {
  slug: string;
  phase: RoundPhase;
  tokenIdUp: string;
  tokenIdDown: string;
  slotStartMs: number;
  slotEndMs: number;
  pendingOrders: TrackedOrder[];
  orderHistory: OrderHistoryEntry[];
}
