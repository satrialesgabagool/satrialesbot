import type { Strategy } from "../types";
import { simulationStrategy } from "./MeanReversion";
import { signalMomentumStrategy } from "./SignalMomentum";
import { latencyArbStrategy } from "./LatencyArb";
import { snipeV2Strategy } from "./SnipeV2";
import { observerStrategy } from "./Observer";

export const strategies: Record<string, Strategy> = {
  simulation: simulationStrategy,
  "signal-momentum": signalMomentumStrategy,
  "latency-arb": latencyArbStrategy,
  "snipe-v2": snipeV2Strategy,
  observer: observerStrategy,
};

export const DEFAULT_STRATEGY = "simulation";
