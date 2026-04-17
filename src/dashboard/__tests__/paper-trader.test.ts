/**
 * Paper-trader integration tests — the 8-check validation the audit
 * specification calls for.
 *
 *   1. Opening a trade reduces cash by stake; position appears in openPositions
 *   2. No early resolve: a position doesn't close until simNowMs ≥ resolvesAtMs
 *   3. Win P&L uses Kalshi 7% fee correctly
 *   4. Loss P&L = −stake with no fee
 *   5. Portfolio value invariant: cash + sum(contracts × currentPrice) == totalPortfolioValue
 *   6. Duplicate signals on the same market+direction don't double-open
 *   7. No NaN / undefined on any numeric Position field (ready for the dashboard)
 *   8. Gates: low-edge rejected; daily cap + cooldown enforced over 10+ signals
 *
 * Run with: bun test src/dashboard/__tests__/paper-trader.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  __state,
  __placeTrade,
  __resolvePositions,
  __refreshPrices,
  __recomputePortfolio,
  __reset,
  __advanceSimClock,
  type Signal,
} from "../paper-trader";

// ─── Signal factory ────────────────────────────────────────────────────

/**
 * Build a fully-populated weather signal. Defaults to a high-conviction
 * trade the gates will accept: marketProb=0.45, trueProb=0.70 → edge 25%.
 * Override any field via `overrides`.
 */
function signal(overrides: Partial<Signal> & { marketTicker?: string } = {}): Signal {
  const base: Signal = {
    timestamp: new Date().toISOString(),
    strategy: "weather",
    eventTicker: "KXHIGHNY-26APR17",
    marketTicker: "KXHIGHNY-26APR17-T72",
    side: "yes",
    yesPrice: 45,
    conviction: 0.2,
    edgeBps: 2500,
    reason: "test signal",
    metadata: {
      city: "New York City",
      type: "high",
      resolveDate: "2026-04-17",
      resolvesAtIso: "2026-04-18T04:00:00.000Z", // 24h+ from our default sim start
      bracketLowF: 72,
      bracketHighF: 73,
      trueProb: 0.70,
      marketProb: 0.45,
      probMethod: "gaussian",
    },
  };
  // Merge nested metadata rather than replace
  return {
    ...base,
    ...overrides,
    metadata: { ...base.metadata, ...(overrides.metadata ?? {}) },
  };
}

/** Fast-forward sim clock by N ms and run refreshPrices + resolve. */
function advance(ms: number) {
  __advanceSimClock(ms);
  __refreshPrices();
  __resolvePositions();
  __recomputePortfolio();
}

beforeEach(() => {
  __reset();
});

// ─── Test 1: Open reduces cash, creates position ───────────────────────

describe("Test 1 — open reduces cash + creates position", () => {
  test("placeTrade on a valid signal opens a position and deducts stake", () => {
    const cashBefore = __state.availableCash;
    const expectedContracts = Math.floor(__state.config.positionSize / 0.45);
    const expectedStake = Math.round(expectedContracts * 0.45 * 100) / 100;

    __placeTrade(signal());

    expect(__state.openPositions.length).toBe(1);
    const p = __state.openPositions[0];
    expect(p.direction).toBe("YES");
    expect(p.contracts).toBe(expectedContracts);
    expect(p.entryPrice).toBeCloseTo(0.45, 6);
    expect(p.stake).toBe(expectedStake);
    expect(p.maxPayout).toBe(expectedContracts); // contracts × $1
    expect(__state.availableCash).toBeCloseTo(cashBefore - expectedStake, 2);
  });
});

// ─── Test 2: No early resolve ──────────────────────────────────────────

describe("Test 2 — no early resolve", () => {
  test("position stays open until simNowMs ≥ resolvesAtMs", () => {
    __placeTrade(signal());
    expect(__state.openPositions.length).toBe(1);

    // Advance 1 hour — way short of the 24h resolve window.
    advance(60 * 60 * 1000);
    expect(__state.openPositions.length).toBe(1);
    expect(__state.closedPositions.length).toBe(0);

    // Advance another 10 hours — still short.
    advance(10 * 60 * 60 * 1000);
    expect(__state.openPositions.length).toBe(1);
    expect(__state.closedPositions.length).toBe(0);
  });
});

// ─── Test 3: Win P&L with Kalshi fee ───────────────────────────────────

describe("Test 3 — win P&L applies 7% fee on net winnings", () => {
  test("entry $0.45, 111 contracts, win → fee=$33.96 / 100 = $3.39; netPnl = $61.05 − $3.39 ≈ $57.66", () => {
    __placeTrade(signal());
    const p = __state.openPositions[0];
    const stake = p.stake;
    const contracts = p.contracts;
    const entry = p.entryPrice;

    // Force win
    p.outcomeWin = 1;

    // Fast-forward past resolvesAtMs
    advance(48 * 60 * 60 * 1000);

    expect(__state.closedPositions.length).toBe(1);
    const c = __state.closedPositions[0];
    expect(c.won).toBe(true);

    // Expected math:
    //   gross = contracts × $1
    //   netWinnings = contracts × (1 − entry) = contracts × 0.55
    //   fee = netWinnings × 0.07
    //   netPnl = gross − stake − fee
    const expectedGross = Math.round(contracts * 100) / 100;
    const expectedFee =
      Math.round(contracts * (1 - entry) * 0.07 * 100) / 100;
    const expectedNetPnl =
      Math.round((expectedGross - stake - expectedFee) * 100) / 100;

    expect(c.grossPayout).toBe(expectedGross);
    expect(c.feesPaid).toBeCloseTo(expectedFee, 2);
    expect(c.netPnl).toBeCloseTo(expectedNetPnl, 2);
    // Cash back = finalPayout = gross − fee
    expect(c.finalPayout).toBeCloseTo(expectedGross - expectedFee, 2);
  });
});

// ─── Test 4: Loss P&L = -stake, no fee ─────────────────────────────────

describe("Test 4 — loss P&L = −stake, no fee", () => {
  test("losing position: feesPaid=0, netPnl=−stake, finalPayout=0", () => {
    __placeTrade(signal());
    const p = __state.openPositions[0];
    const stake = p.stake;
    p.outcomeWin = 0; // force loss

    advance(48 * 60 * 60 * 1000);
    expect(__state.closedPositions.length).toBe(1);
    const c = __state.closedPositions[0];
    expect(c.won).toBe(false);
    expect(c.feesPaid).toBe(0);
    expect(c.netPnl).toBeCloseTo(-stake, 2);
    expect(c.finalPayout).toBe(0);
  });
});

// ─── Test 5: Portfolio value invariant ─────────────────────────────────

describe("Test 5 — portfolio value invariant", () => {
  test("totalPortfolioValue ≈ availableCash + Σ(contracts × currentPrice)", () => {
    __placeTrade(signal());

    // Advance a bit so the price ticks off entry. We force the accelPrice
    // refresh by using an elapsed interval longer than the poll window.
    advance(30 * 60 * 1000);

    const pv = __state.totalPortfolioValue;
    const invariant =
      __state.availableCash +
      __state.openPositions.reduce(
        (s, p) => s + Math.round(p.contracts * p.currentPrice * 100) / 100,
        0,
      );
    expect(pv).toBeCloseTo(invariant, 1);
  });

  test("invariant holds through a full resolve cycle", () => {
    __placeTrade(signal());
    __state.openPositions[0].outcomeWin = 1;
    const startBalance = __state.startBalance;

    advance(48 * 60 * 60 * 1000);

    // After one resolved win, cash should equal startBalance + netPnl.
    const c = __state.closedPositions[0];
    expect(__state.availableCash).toBeCloseTo(startBalance + c.netPnl, 2);
    // Open stake MTM = 0 since no open positions.
    expect(__state.totalPortfolioValue).toBeCloseTo(__state.availableCash, 2);
  });
});

// ─── Test 6: Duplicate signals don't double-open ───────────────────────

describe("Test 6 — dedup by marketTicker + direction", () => {
  test("same market + direction → only one position opens", () => {
    __placeTrade(signal());
    // Bypass cooldown so the gate doesn't reject for a different reason.
    __state.lastTradeAtMs = null;
    __placeTrade(signal()); // same ticker
    expect(__state.openPositions.length).toBe(1);
  });

  test("same market, different direction → allowed (in principle)", () => {
    __placeTrade(signal());
    __state.lastTradeAtMs = null;
    __placeTrade(signal({ side: "no" }));
    // Both directions allowed; we just care dedup didn't false-collapse.
    expect(__state.openPositions.length).toBe(2);
  });
});

// ─── Test 7: No NaN / undefined anywhere ───────────────────────────────

describe("Test 7 — no NaN/undefined in Position fields", () => {
  test("all numeric position fields are finite numbers", () => {
    __placeTrade(signal());
    __placeTrade(signal({ marketTicker: "KXHIGHCHI-26APR17-T65" }));
    advance(60 * 60 * 1000);

    for (const p of __state.openPositions) {
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === "number") {
          expect(Number.isFinite(v)).toBe(true);
          expect(Number.isNaN(v)).toBe(false);
        }
        if (v === undefined) {
          throw new Error(`Position field ${k} is undefined`);
        }
      }
    }
    // State totals too
    expect(Number.isFinite(__state.availableCash)).toBe(true);
    expect(Number.isFinite(__state.totalPortfolioValue)).toBe(true);
    expect(Number.isFinite(__state.unrealizedPnlTotal)).toBe(true);
    expect(Number.isFinite(__state.realizedPnl)).toBe(true);
  });
});

// ─── Test 8: Gates over 10+ signals ────────────────────────────────────

describe("Test 8 — gates keep trade count realistic", () => {
  test("low-edge signals rejected", () => {
    // edge = trueProb − marketProb = 0.50 − 0.45 = 5% — below 8% default
    __placeTrade(signal({ metadata: { trueProb: 0.50, marketProb: 0.45 } }));
    expect(__state.openPositions.length).toBe(0);
  });

  test("daily cap enforced: 10 high-edge signals → ≤ maxPerDay trades", () => {
    for (let i = 0; i < 10; i++) {
      // Unique ticker so dedup doesn't fire
      __placeTrade(signal({ marketTicker: `KXHIGHNY-26APR17-T${70 + i}` }));
      // Skip cooldown between attempts so we isolate the daily-cap gate
      __state.lastTradeAtMs = null;
    }
    const opened = __state.openPositions.length;
    expect(opened).toBeLessThanOrEqual(__state.config.maxPerDay);
    // And: since edge is 25% (well above 8%), the cap IS the limiting factor
    expect(opened).toBe(__state.config.maxPerDay);
  });

  test("cooldown enforced: two rapid high-edge signals → second rejected", () => {
    __placeTrade(signal({ marketTicker: "KXHIGHNY-26APR17-T72" }));
    expect(__state.openPositions.length).toBe(1);
    // Immediately fire a second — same sim clock, no cooldown elapsed
    __placeTrade(signal({ marketTicker: "KXHIGHCHI-26APR17-T65" }));
    expect(__state.openPositions.length).toBe(1); // still one
  });
});

// ─── Bonus: win-rate / avg-edge sanity over many trades ────────────────

describe("Bonus — win rate is within statistical band of model prob", () => {
  test("100 trades at modelProb=0.70 → win rate roughly 0.70 ± 0.10", () => {
    // Seed Math.random for determinism — replace the global with a tiny LCG.
    const origRandom = Math.random;
    let seed = 12345;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    try {
      let wins = 0;
      const n = 100;
      for (let i = 0; i < n; i++) {
        __reset();
        __placeTrade(signal());
        advance(48 * 60 * 60 * 1000);
        if (__state.closedPositions.length === 1 && __state.closedPositions[0].won) {
          wins++;
        }
      }
      const rate = wins / n;
      // With trueProb=0.70 we expect 70 ± ~9 wins (Binomial(100, 0.7) has
      // sd ≈ 4.58; ±10% is >2σ, so this is a stable check.)
      expect(rate).toBeGreaterThan(0.58);
      expect(rate).toBeLessThan(0.82);
    } finally {
      Math.random = origRandom;
    }
  });
});
