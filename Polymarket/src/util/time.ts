import type { MarketWindow } from "./config";

const WINDOW_MS: Record<MarketWindow, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
};

const WINDOW_S: Record<MarketWindow, number> = {
  "5m": 300,
  "15m": 900,
};

/**
 * Polymarket BTC markets use a fixed base timestamp.
 * All slot boundaries are aligned to this epoch.
 */
const BASE_TIMESTAMP = 1772568900;

/** Returns the duration of a market window in milliseconds. */
export function windowMs(window: MarketWindow): number {
  return WINDOW_MS[window];
}

/** Returns the duration of a market window in seconds. */
export function windowSec(window: MarketWindow): number {
  return WINDOW_S[window];
}

/**
 * Given a Unix timestamp (seconds), returns the slot end timestamp
 * for the current market window.
 */
export function currentSlotEnd(nowSec: number, window: MarketWindow): number {
  const interval = windowSec(window);
  const offset = (nowSec - BASE_TIMESTAMP) % interval;
  return nowSec + (interval - offset);
}

/**
 * Returns the slot end timestamp for a given offset from current.
 * offset=0: current slot, offset=1: next slot, offset=-1: previous.
 */
export function slotEndAt(nowSec: number, window: MarketWindow, offset: number): number {
  const current = currentSlotEnd(nowSec, window);
  return current + offset * windowSec(window);
}

/** Returns the slot start timestamp given its end timestamp. */
export function slotStartFromEnd(slotEndSec: number, window: MarketWindow): number {
  return slotEndSec - windowSec(window);
}

/** Builds the market slug from the window and slot end timestamp. */
export function buildSlug(window: MarketWindow, slotEndSec: number): string {
  return `btc-updown-${window}-${slotEndSec}`;
}

/** Parses a market slug to extract window and slot end timestamp. */
export function parseSlug(slug: string): { window: MarketWindow; slotEndSec: number } | null {
  const match = slug.match(/^btc-updown-(5m|15m)-(\d+)$/);
  if (!match) return null;
  return {
    window: match[1] as MarketWindow,
    slotEndSec: parseInt(match[2], 10),
  };
}

/** Returns seconds remaining until the slot ends. */
export function secondsRemaining(slotEndMs: number): number {
  return Math.max(0, Math.floor((slotEndMs - Date.now()) / 1000));
}

/** Format a timestamp as HH:MM:SS. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

/** Format seconds as M:SS. */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
