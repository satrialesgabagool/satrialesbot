import { fetchWithRetry } from "../net/fetchWithRetry";
import { buildSlug, slotEndAt } from "../util/time";
import type { MarketWindow } from "../util/config";

const GAMMA_API = "https://gamma-api.polymarket.com";

export interface MarketInfo {
  slug: string;
  conditionId: string;
  tokenIdUp: string;
  tokenIdDown: string;
  slotEndSec: number;
  slotStartSec: number;
  priceToBeat?: number;
}

interface GammaEvent {
  slug: string;
  markets: Array<{
    conditionId: string;
    clobTokenIds: string;
    description: string;
    question: string;
  }>;
}

/**
 * Discovers Polymarket BTC 5m/15m markets by computing the deterministic
 * slug from the current time and fetching metadata from the Gamma API.
 */
export class MarketFinder {
  private window: MarketWindow;

  constructor(window: MarketWindow) {
    this.window = window;
  }

  /**
   * Find the market for a given slot offset.
   * offset=1 means the next upcoming slot.
   */
  async findMarket(slotOffset: number, signal?: AbortSignal): Promise<MarketInfo | null> {
    const nowSec = Math.floor(Date.now() / 1000);
    const slotEndSec = slotEndAt(nowSec, this.window, slotOffset);
    const slug = buildSlug(this.window, slotEndSec);

    return this.fetchMarketBySlug(slug, slotEndSec, signal);
  }

  /** Fetch market info by slug from the Gamma API. */
  async fetchMarketBySlug(
    slug: string,
    slotEndSec: number,
    signal?: AbortSignal,
  ): Promise<MarketInfo | null> {
    const url = `${GAMMA_API}/events?slug=${slug}`;

    try {
      const response = await fetchWithRetry(url, { signal }, { maxRetries: 3 });
      const events: GammaEvent[] = await response.json();

      if (!events || events.length === 0) return null;

      const event = events[0];
      if (!event.markets || event.markets.length === 0) return null;

      // The market should have exactly one entry with two CLOB token IDs
      const market = event.markets[0];
      const tokenIds: string[] = JSON.parse(market.clobTokenIds);

      if (tokenIds.length < 2) return null;

      const windowSec = this.window === "5m" ? 300 : 900;

      return {
        slug,
        conditionId: market.conditionId,
        tokenIdUp: tokenIds[0],
        tokenIdDown: tokenIds[1],
        slotEndSec,
        slotStartSec: slotEndSec - windowSec,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Wait for a market to become available.
   * Polls every pollMs until found or aborted.
   */
  async waitForMarket(
    slotOffset: number,
    pollMs: number = 2000,
    signal?: AbortSignal,
  ): Promise<MarketInfo> {
    while (!signal?.aborted) {
      const market = await this.findMarket(slotOffset, signal);
      if (market) return market;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error("Market discovery aborted");
  }
}
