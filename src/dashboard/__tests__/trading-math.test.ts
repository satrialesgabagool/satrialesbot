/**
 * Pure-math unit tests for trading-math.ts.
 *
 * These cover the fee calculator, settlement, unrealized P&L, edge gate,
 * price path (Brownian bridge), countdown formatter, and the local-midnight
 * helpers. Everything here is pure — no wall-clock, no filesystem, no
 * random (callers inject seeded RNG), so tests are deterministic.
 *
 * Run with: bun test src/dashboard/__tests__/trading-math.test.ts
 */

import { describe, test, expect } from "bun:test";

import {
  kalshiFee,
  settlePosition,
  unrealizedPnl,
  isInTheMoney,
  accelPrice,
  edgeGate,
  formatCountdown,
  seededUniform,
  localDateKey,
  localMidnightIso,
  KALSHI_FEE_RATE,
} from "../trading-math";

// ─── Kalshi fee math ───────────────────────────────────────────────────

describe("kalshiFee", () => {
  test("winner pays 7% of net winnings (not gross)", () => {
    // 100 contracts @ $0.42 win:
    //   net winnings/contract = 1.00 − 0.42 = 0.58
    //   total = 100 × 0.58 = $58
    //   fee = 58 × 0.07 = $4.06
    expect(kalshiFee(100, 0.42, true)).toBe(4.06);
  });

  test("loser pays zero fee", () => {
    expect(kalshiFee(100, 0.42, false)).toBe(0);
  });

  test("fee at entry=$0.99 tiny — 100 × 0.01 × 0.07 = $0.07", () => {
    expect(kalshiFee(100, 0.99, true)).toBe(0.07);
  });

  test("accepts custom fee rate", () => {
    expect(kalshiFee(100, 0.50, true, 0.10)).toBe(5.0);
  });
});

// ─── settlePosition ────────────────────────────────────────────────────

describe("settlePosition", () => {
  test("win: grossPayout=100, fee=4.06, netPnl=53.94, finalPayout=95.94", () => {
    const s = settlePosition(100, 0.42, true);
    expect(s.stake).toBe(42);
    expect(s.grossPayout).toBe(100);
    expect(s.fee).toBe(4.06);
    expect(s.netPnl).toBe(53.94);
    expect(s.finalPayout).toBe(95.94);
    expect(s.returnPct).toBeCloseTo(53.94 / 42, 3);
  });

  test("loss: netPnl = −stake, fee = 0, finalPayout = 0", () => {
    const s = settlePosition(100, 0.42, false);
    expect(s.stake).toBe(42);
    expect(s.grossPayout).toBe(0);
    expect(s.fee).toBe(0);
    expect(s.netPnl).toBe(-42);
    expect(s.finalPayout).toBe(0);
    expect(s.returnPct).toBe(-1);
  });

  test("returnPct=0 when stake=0 (guard against div-by-zero)", () => {
    const s = settlePosition(0, 0.42, true);
    expect(s.returnPct).toBe(0);
  });
});

// ─── Unrealized P&L ────────────────────────────────────────────────────

describe("unrealizedPnl", () => {
  test("price moves up → positive P&L", () => {
    // 100 contracts @ 0.50, current 0.70 → (0.20) × 100 = +$20
    expect(unrealizedPnl(100, 0.50, 0.70)).toBe(20);
  });

  test("price moves down → negative P&L", () => {
    expect(unrealizedPnl(100, 0.50, 0.30)).toBe(-20);
  });

  test("no movement → 0", () => {
    expect(unrealizedPnl(100, 0.50, 0.50)).toBe(0);
  });
});

// ─── isInTheMoney ──────────────────────────────────────────────────────

describe("isInTheMoney", () => {
  test("current > entry + eps → true", () => {
    expect(isInTheMoney(0.50, 0.51)).toBe(true);
  });
  test("current ≤ entry + eps (rounding noise) → false", () => {
    expect(isInTheMoney(0.50, 0.501)).toBe(false);
  });
  test("current < entry → false", () => {
    expect(isInTheMoney(0.50, 0.40)).toBe(false);
  });
});

// ─── accelPrice (Brownian bridge) ──────────────────────────────────────

describe("accelPrice", () => {
  const T0 = 1_000_000;
  const T1 = 2_000_000;
  const entry = 0.45;

  test("t ≤ T0 → returns entry", () => {
    expect(accelPrice(T0, T0, T1, entry, 1)).toBe(entry);
    expect(accelPrice(T0 - 100, T0, T1, entry, 1)).toBe(entry);
  });

  test("t ≥ T1 → returns outcomeWin (1 or 0)", () => {
    expect(accelPrice(T1, T0, T1, entry, 1)).toBe(1);
    expect(accelPrice(T1, T0, T1, entry, 0)).toBe(0);
    expect(accelPrice(T1 + 100, T0, T1, entry, 1)).toBe(1);
  });

  test("midpoint with no noise (rng omitted) = mean halfway", () => {
    // At u=0.5 and rng=none, noise term is 0 so price = entry + (W−entry)×0.5
    const p = accelPrice((T0 + T1) / 2, T0, T1, entry, 1);
    expect(p).toBeCloseTo(0.45 + (1 - 0.45) * 0.5, 2); // 0.725
  });

  test("clipped to [0.01, 0.99] even with wide noise", () => {
    // Force extreme noise via a deterministic rng
    const p = accelPrice((T0 + T1) / 2, T0, T1, entry, 1, {
      rng: () => 0.999,
      seed: 1,
      volatility: 5.0, // absurd vol to drive clipping
    });
    expect(p).toBeGreaterThanOrEqual(0.01);
    expect(p).toBeLessThanOrEqual(0.99);
  });

  test("same seed → same price (determinism for SSE replay)", () => {
    const opts = { rng: seededUniform, seed: 42 };
    const t = (T0 + T1) / 2;
    const a = accelPrice(t, T0, T1, entry, 1, opts);
    const b = accelPrice(t, T0, T1, entry, 1, opts);
    expect(a).toBe(b);
  });
});

// ─── edgeGate ──────────────────────────────────────────────────────────

describe("edgeGate", () => {
  const base = {
    edge: 0.10,
    tradesToday: 0,
    lastTradeAtMs: null,
    simNowMs: 1000,
    minEdge: 0.08,
    maxPerDay: 5,
    cooldownMs: 30 * 60 * 1000,
  };

  test("passes when all gates satisfied", () => {
    expect(edgeGate(base)).toBeNull();
  });
  test("rejects edge below threshold", () => {
    expect(edgeGate({ ...base, edge: 0.05 })).toMatch(/edge/);
  });
  test("rejects when daily cap reached", () => {
    expect(edgeGate({ ...base, tradesToday: 5 })).toMatch(/daily cap/);
  });
  test("rejects within cooldown window", () => {
    expect(edgeGate({ ...base, lastTradeAtMs: base.simNowMs - 1000 })).toMatch(/cooldown/);
  });
  test("passes once cooldown elapses", () => {
    expect(
      edgeGate({ ...base, lastTradeAtMs: base.simNowMs - base.cooldownMs - 1 }),
    ).toBeNull();
  });
});

// ─── formatCountdown ───────────────────────────────────────────────────

describe("formatCountdown", () => {
  test("already resolved", () => {
    expect(formatCountdown(0)).toBe("Resolved");
    expect(formatCountdown(-100)).toBe("Resolved");
  });
  test("seconds only", () => {
    expect(formatCountdown(58_000)).toBe("Resolves in 58s");
  });
  test("minutes + seconds", () => {
    expect(formatCountdown((2 * 60 + 30) * 1000)).toBe("Resolves in 2m 30s");
  });
  test("hours + minutes, padded", () => {
    expect(formatCountdown((4 * 3600 + 5 * 60) * 1000)).toBe("Resolves in 4h 05m");
  });
});

// ─── Seeded RNG ────────────────────────────────────────────────────────

describe("seededUniform", () => {
  test("deterministic: same seed → same output", () => {
    expect(seededUniform(12345)).toBe(seededUniform(12345));
  });
  test("output in [0, 1)", () => {
    for (let i = 1; i < 100; i++) {
      const u = seededUniform(i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

// ─── Timezone helpers ──────────────────────────────────────────────────

describe("localDateKey", () => {
  test("EDT afternoon → same calendar day", () => {
    // 2026-04-16 17:00 UTC = 13:00 EDT same day
    const ts = Date.parse("2026-04-16T17:00:00Z");
    expect(localDateKey(ts, "America/New_York")).toBe("2026-04-16");
  });

  test("UTC midnight still previous day in NY", () => {
    // 2026-04-17 03:00 UTC = 23:00 EDT 2026-04-16
    const ts = Date.parse("2026-04-17T03:00:00Z");
    expect(localDateKey(ts, "America/New_York")).toBe("2026-04-16");
  });
});

describe("localMidnightIso", () => {
  test("for NY in DST: midnight 2026-04-17 = 04:00Z", () => {
    // April is EDT (UTC-4). Local 2026-04-17T00:00 = 2026-04-17T04:00Z.
    const iso = localMidnightIso("2026-04-17", "America/New_York");
    expect(new Date(iso).toISOString()).toBe("2026-04-17T04:00:00.000Z");
  });
});

// ─── Fee rate default is what the spec asks for ────────────────────────

test("KALSHI_FEE_RATE default is 7%", () => {
  expect(KALSHI_FEE_RATE).toBe(0.07);
});
