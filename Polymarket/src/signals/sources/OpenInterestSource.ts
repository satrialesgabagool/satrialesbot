import type { SignalEvent, SignalSource, SignalKind, OpenInterestPayload } from "../types";
import { fetchWithRetry } from "../../net/fetchWithRetry";

/**
 * Binance Futures open interest — free public endpoint, no auth.
 *
 * Rising OI + rising price = new longs entering (trend strength).
 * Rising OI + falling price = new shorts entering (bearish pressure).
 * Falling OI = positions closing (trend weakening).
 *
 * Polls every 60 seconds. Tracks 1h change rate to detect momentum shifts.
 */

const OI_API = "https://fapi.binance.com/fapi/v1/openInterest";
const POLL_INTERVAL_MS = 60_000;

interface OIResponse {
  symbol: string;
  openInterest: string;
  time: number;
}

export class OpenInterestSource implements SignalSource {
  readonly name = "binance-open-interest";
  readonly kinds: SignalKind[] = ["open_interest"];

  emit?: (event: SignalEvent) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private history: Array<{ oi: number; ts: number }> = [];
  private readonly HISTORY_WINDOW_MS = 3_600_000; // 1 hour
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
      const response = await fetchWithRetry(
        `${OI_API}?symbol=BTCUSDT`,
        { signal: this.abortController?.signal },
        { maxRetries: 2, timeoutMs: 5000 },
      );

      const data: OIResponse = await response.json();
      const oi = parseFloat(data.openInterest);
      if (!Number.isFinite(oi)) return;

      const now = Date.now();

      // Track history for 1h change rate
      this.history.push({ oi, ts: now });
      this.history = this.history.filter(h => now - h.ts < this.HISTORY_WINDOW_MS);

      // Compute 1h change
      let changePercent1h = 0;
      if (this.history.length >= 2) {
        const oldest = this.history[0];
        if (oldest.oi > 0) {
          changePercent1h = ((oi - oldest.oi) / oldest.oi) * 100;
        }
      }

      const payload: OpenInterestPayload = {
        symbol: "BTCUSDT",
        openInterest: oi,
        changePercent1h,
      };

      this.emit?.({
        kind: "open_interest",
        payload,
        timestamp: data.time,
        receivedAt: now,
        source: this.name,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Request aborted") return;
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("451")) {
        // Geo-blocked — don't spam logs
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
