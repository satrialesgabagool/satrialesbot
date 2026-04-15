import type { Strategy } from "../types";
import { simulationStrategy } from "./MeanReversion";
import { signalMomentumStrategy } from "./SignalMomentum";
import { latencyArbStrategy } from "./LatencyArb";

export const strategies: Record<string, Strategy> = {
  simulation: simulationStrategy,
  "signal-momentum": signalMomentumStrategy,
  "latency-arb": latencyArbStrategy,
};

export const DEFAULT_STRATEGY = "simulation";
