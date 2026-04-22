import type { SignalEvent, SignalSource, SignalKind, FearGreedPayload } from "../types";
import { fetchWithRetry } from "../../net/fetchWithRetry";

const API_URL = "https://api.alternative.me/fng/?limit=2";
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (matches API cache TTL)

interface FngApiResponse {
  data: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
  }>;
}

const CLASSIFICATIONS: Record<string, FearGreedPayload["classification"]> = {
  "Extreme Fear": "Extreme Fear",
  Fear: "Fear",
  Neutral: "Neutral",
  Greed: "Greed",
  "Extreme Greed": "Extreme Greed",
};

export class FearGreedSource implements SignalSource {
  readonly name = "fear-greed-index";
  readonly kinds: SignalKind[] = ["fear_greed"];

  emit?: (event: SignalEvent) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;

  async start(): Promise<void> {
    this.abortController = new AbortController();

    // Fetch immediately on start
    await this.poll();

    // Then poll at regular intervals
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetchWithRetry(
        API_URL,
        { signal: this.abortController?.signal },
        { maxRetries: 2, timeoutMs: 5000 },
      );

      const data: FngApiResponse = await response.json();

      if (!data.data || data.data.length === 0) return;

      const current = data.data[0];
      const previous = data.data.length > 1 ? data.data[1] : null;

      const value = parseInt(current.value, 10);
      const classification =
        CLASSIFICATIONS[current.value_classification] || "Neutral";

      const payload: FearGreedPayload = {
        value,
        classification,
        previousValue: previous ? parseInt(previous.value, 10) : value,
        previousClassification: previous?.value_classification || current.value_classification,
      };

      this.emit?.({
        kind: "fear_greed",
        payload,
        timestamp: parseInt(current.timestamp, 10) * 1000,
        receivedAt: Date.now(),
        source: this.name,
      });
    } catch (error) {
      // Silently fail — source will retry on next poll interval
      if (!(error instanceof Error && error.message === "Request aborted")) {
        console.error(`[${this.name}] Poll error:`, error);
      }
    }
  }
}
