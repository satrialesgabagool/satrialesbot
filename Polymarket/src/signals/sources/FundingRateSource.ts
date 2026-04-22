import type { SignalEvent, SignalSource, SignalKind, FundingRatePayload } from "../types";
import { fetchWithRetry } from "../../net/fetchWithRetry";

/**
 * Binance Futures funding rate — free public endpoint, no auth needed.
 *
 * Funding rates settle every 8 hours (00:00, 08:00, 16:00 UTC).
 * Positive rate = longs pay shorts = bullish sentiment (contrarian bearish).
 * Negative rate = shorts pay longs = bearish sentiment (contrarian bullish).
 *
 * The SignalSnapshot.bias uses this as a contrarian signal:
 *   high positive funding → market overheated → bearish bias
 *   high negative funding → oversold → bullish bias
 *
 * Polls every 60 seconds — rate changes infrequently but matters for bias.
 */

const FUNDING_API = "https://fapi.binance.com/fapi/v1/fundingRate";
const MARK_PRICE_API = "https://fapi.binance.com/fapi/v1/premiumIndex";
const POLL_INTERVAL_MS = 60_000; // 1 minute

interface FundingRateResponse {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
}

interface PremiumIndexResponse {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  markPrice: string;
}

export class FundingRateSource implements SignalSource {
  readonly name = "binance-funding-rate";
  readonly kinds: SignalKind[] = ["funding_rate"];

  emit?: (event: SignalEvent) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private geoBlocked = false;

  async start(): Promise<void> {
    this.abortController = new AbortController();
    await this.poll();
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
      // premiumIndex gives current + next funding time in one call
      const response = await fetchWithRetry(
        `${MARK_PRICE_API}?symbol=BTCUSDT`,
        { signal: this.abortController?.signal },
        { maxRetries: 2, timeoutMs: 5000 },
      );

      const data: PremiumIndexResponse = await response.json();

      const rate = parseFloat(data.lastFundingRate);
      if (!Number.isFinite(rate)) return;

      const payload: FundingRatePayload = {
        symbol: "BTCUSDT",
        rate,
        exchange: "binance",
      };

      this.emit?.({
        kind: "funding_rate",
        payload,
        timestamp: data.nextFundingTime,
        receivedAt: Date.now(),
        source: this.name,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Request aborted") return;
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("451")) {
        if (!this.geoBlocked) {
          console.log(`[${this.name}] Binance Futures API geo-blocked (HTTP 451) — skipping`);
          this.geoBlocked = true;
          this.stop();
        }
      } else {
        console.error(`[${this.name}] Poll error: ${msg}`);
      }
    }
  }
}
