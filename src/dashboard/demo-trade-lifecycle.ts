#!/usr/bin/env bun
/**
 * Self-contained demo of the full trade lifecycle:
 *   1. Entry — print a detailed block for each of 7 realistic trades
 *   2. Live view — after a few minutes of simulated price drift, show the
 *      open-positions table + portfolio summary
 *   3. Resolution — settle each trade one at a time, print the result box
 *   4. Final session summary — P&L, fees, win rate, best/worst
 *
 * Uses the real production math from ./trading-math.ts so fees and
 * settlement are identical to what the paper trader produces.
 *
 *   bun run src/dashboard/demo-trade-lifecycle.ts
 */

import {
  KALSHI_FEE_RATE,
  settlePosition,
  unrealizedPnl,
  isInTheMoney,
} from "./trading-math";

// ─── Demo trades (hand-picked for variety + realism) ───────────────────

interface DemoTrade {
  marketName: string;
  shortLabel: string;         // tidy label for the final summary table
  ticker: string;
  city: string;
  direction: "YES" | "NO";
  entryPrice: number;         // fill price $0.xx
  modelProb: number;          // our edge model
  marketProb: number;         // market-implied prob
  resolvesAt: string;         // ISO
  signalReason: string;
  /** Pre-drawn outcome: whether the underlying event happens (true=YES occurred) */
  underlyingYes: boolean;
  /** Final market price at resolution (how far the market drifted toward the truth) */
  finalMarketProb: number;
}

const STARTING_BALANCE = 1000;
const POSITION_SIZE = 50;     // dollars per trade
const NOW_ISO = "2026-04-17T12:30:00-04:00";  // demo "now"

const DEMO_TRADES: DemoTrade[] = [
  {
    marketName: "Will NYC see rain > 0.10in on April 18?",
    shortLabel: "NYC Rain >0.10in Apr 18",
    ticker: "KXRAIN-NYC-0418",
    city: "NYC",
    direction: "YES",
    entryPrice: 0.38,
    modelProb: 0.61,
    marketProb: 0.38,
    resolvesAt: "2026-04-18T23:59:00-04:00",
    signalReason:
      "NWS forecast 68% PoP, model adjusted to 61%, market underpricing at 38%",
    underlyingYes: true,        // it rained
    finalMarketProb: 0.94,
  },
  {
    marketName: "Will Chicago high be below 45°F on April 18?",
    shortLabel: "CHI Temp <45°F Apr 18",
    ticker: "KXHIGHCHI-26APR18-BU45",
    city: "CHI",
    direction: "NO",
    entryPrice: 0.52,           // NO side = 1 - yes bid
    modelProb: 0.69,            // probability NO resolves (i.e. high >= 45)
    marketProb: 0.52,
    resolvesAt: "2026-04-19T00:00:00-05:00",
    signalReason:
      "GFS ensemble 72% of members show >45°F peak; market prices it as coin flip at 52%",
    underlyingYes: true,        // high was >= 45 → NO position wins
    finalMarketProb: 0.91,
  },
  {
    marketName: "Will LAX high be 72-74°F on April 18?",
    shortLabel: "LAX Temp 72-74°F Apr 18",
    ticker: "KXHIGHLAX-26APR18-B73",
    city: "LAX",
    direction: "YES",
    entryPrice: 0.31,
    modelProb: 0.47,
    marketProb: 0.31,
    resolvesAt: "2026-04-19T00:00:00-07:00",
    signalReason:
      "Ensemble bracket prob 47% (empirical-gfs31), market at 31%. Peak window 1-3pm PDT.",
    underlyingYes: false,       // actual peak was 76°F — LOSS
    finalMarketProb: 0.04,
  },
  {
    marketName: "Will Miami high be above 82°F on April 18?",
    shortLabel: "MIA Temp >82°F Apr 18",
    ticker: "KXHIGHMIA-26APR18-BA82",
    city: "MIA",
    direction: "YES",
    entryPrice: 0.55,
    modelProb: 0.74,
    marketProb: 0.55,
    resolvesAt: "2026-04-19T00:00:00-04:00",
    signalReason:
      "NOAA METAR locked @ 85°F at 15:00 ET with 2.1h age; lockStatus=locked-observed (0.98 floor)",
    underlyingYes: true,        // METAR lock → near-certain WIN
    finalMarketProb: 0.98,
  },
  {
    marketName: "Will NYC high be below 50°F on April 18?",
    shortLabel: "NYC Temp <50°F Apr 18",
    ticker: "KXHIGHNY-26APR18-BU50",
    city: "NYC",
    direction: "NO",
    entryPrice: 0.63,
    modelProb: 0.77,
    marketProb: 0.63,
    resolvesAt: "2026-04-19T00:00:00-04:00",
    signalReason:
      "GFS members: 23/31 show high >= 50°F. Gaussian mean 53.2°F. Market pricing lags.",
    underlyingYes: false,       // actual high was 48°F → NO loses
    finalMarketProb: 0.12,
  },
  {
    marketName: "Will Chicago see rain > 0.10in on April 18?",
    shortLabel: "CHI Rain >0.10in Apr 18",
    ticker: "KXRAIN-CHI-0418",
    city: "CHI",
    direction: "YES",
    entryPrice: 0.42,
    modelProb: 0.58,
    marketProb: 0.42,
    resolvesAt: "2026-04-18T23:59:00-05:00",
    signalReason:
      "Frontal system arriving 16Z; 4 of 5 weather sources show >0.15in. Market slow to price.",
    underlyingYes: true,        // frontal passage delivered
    finalMarketProb: 0.88,
  },
  {
    marketName: "Will LAX high be above 78°F on April 18?",
    shortLabel: "LAX Temp >78°F Apr 18",
    ticker: "KXHIGHLAX-26APR18-BA78",
    city: "LAX",
    direction: "YES",
    entryPrice: 0.44,
    modelProb: 0.63,
    marketProb: 0.44,
    resolvesAt: "2026-04-19T00:00:00-07:00",
    signalReason:
      "Santa Ana signal; ensemble 63% bracket-above. Market 44%. Edge +19%.",
    underlyingYes: true,
    finalMarketProb: 0.83,
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────

function money(x: number): string {
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

function moneySigned(x: number): string {
  const sign = x >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function pctSigned(x: number, digits = 0): string {
  const sign = x >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(x) * 100).toFixed(digits)}%`;
}

function cents(p: number): string {
  return `${(p * 100).toFixed(0)}¢`;
}

function countdown(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (ms <= 0) return "Resolved";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function fmtIsoShort(iso: string): string {
  // "2026-04-18 23:59 ET"
  const d = new Date(iso);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} ET`;
}

function line(ch: string, n: number): string {
  return ch.repeat(n);
}

/**
 * Simulate a "current price" a few minutes after entry: price drifts slightly
 * toward the final outcome but hasn't fully crossed yet. Deterministic — no
 * RNG so the demo output is stable.
 */
function driftedCurrentPrice(t: DemoTrade, driftFraction: number): number {
  const target = t.underlyingYes ? t.finalMarketProb : 1 - t.finalMarketProb;
  // For a YES position: if the event will happen, drift price toward finalMarketProb.
  // For a NO position: direction is reversed — underlying YES occurring pushes NO price DOWN.
  let current: number;
  if (t.direction === "YES") {
    const target = t.underlyingYes ? t.finalMarketProb : (1 - t.finalMarketProb);
    current = t.entryPrice + (target - t.entryPrice) * driftFraction;
  } else {
    // NO position: we hold contracts priced at (1 - yesPrice). If underlying YES
    // occurs, yesPrice rises → our NO contract price falls. We bought at
    // t.entryPrice which is already the NO-side fill.
    const impliedYesEntry = 1 - t.entryPrice;
    const impliedYesFinal = t.underlyingYes ? t.finalMarketProb : (1 - t.finalMarketProb);
    const driftYes = impliedYesEntry + (impliedYesFinal - impliedYesEntry) * driftFraction;
    current = 1 - driftYes;
  }
  return Math.max(0.02, Math.min(0.98, current));
}

/**
 * Whether the demo trade WINS, given its direction + underlyingYes.
 * YES position wins iff underlying=YES. NO position wins iff underlying=NO.
 */
function didWin(t: DemoTrade): boolean {
  return t.direction === "YES" ? t.underlyingYes : !t.underlyingYes;
}

// ─── Phase 1: Entry blocks ─────────────────────────────────────────────

function printHeader(title: string) {
  console.log("");
  console.log(line("═", 72));
  console.log(`  ${title}`);
  console.log(line("═", 72));
}

function printEntryBlock(
  t: DemoTrade,
  contracts: number,
  index: number,
  total: number,
) {
  const stake = contracts * t.entryPrice;
  const edge = t.modelProb - t.entryPrice;
  const impliedOddsDenom = 1 / t.entryPrice;
  const maxPayout = contracts * 1.0;
  const maxProfit = maxPayout - stake;

  console.log("");
  console.log(line("─", 72));
  console.log(`  TRADE ${index + 1} of ${total}   [OPEN]`);
  console.log(line("─", 72));
  console.log(`  Market Name        : "${t.marketName}"`);
  console.log(`  Market Ticker      : ${t.ticker}`);
  console.log(`  Direction          : ${t.direction}`);
  console.log(`  Contracts          : ${contracts}`);
  console.log(`  Entry Price        : ${cents(t.entryPrice)}  ($${t.entryPrice.toFixed(2)} per contract)`);
  console.log(`  Stake Deployed     : ${money(stake)}  (contracts × entry price)`);
  console.log(`  Model Probability  : ${pct(t.modelProb)}`);
  console.log(`  Market Probability : ${pct(t.marketProb)}`);
  console.log(`  Edge               : ${pctSigned(edge)}  (model prob − market price)`);
  console.log(`  Implied Odds       : 1-in-${impliedOddsDenom.toFixed(1)}  (1 / market price)`);
  console.log(`  Max Payout         : ${money(maxPayout)}  (contracts × $1.00)`);
  console.log(`  Max Profit         : ${money(maxProfit)}  (max payout − stake, before fees)`);
  console.log(`  Resolution Time    : ${fmtIsoShort(t.resolvesAt)}`);
  console.log(`  Time Until Resolve : ${countdown(NOW_ISO, t.resolvesAt)}`);
  console.log(`  Signal Reason      : "${t.signalReason}"`);
}

// ─── Phase 2: Live dashboard view ──────────────────────────────────────

function printLiveDashboard(
  positions: { t: DemoTrade; contracts: number; currentPrice: number }[],
  simNowIso: string,
) {
  printHeader("LIVE DASHBOARD VIEW   (sim time: " + simNowIso + ")");
  console.log("");

  // Table header
  const headers = [
    "#",
    "Ticker".padEnd(26),
    "Dir",
    "Ctr".padStart(4),
    "Entry".padStart(6),
    "Curr".padStart(6),
    "Edge".padStart(6),
    "Stake".padStart(8),
    "MaxPay".padStart(8),
    "Unrealized".padStart(11),
    "Status".padEnd(9),
    "Resolves in".padStart(12),
  ];
  console.log("  " + headers.join(" │ "));
  console.log("  " + line("─", 116));

  let totalUnrealized = 0;
  for (let i = 0; i < positions.length; i++) {
    const { t, contracts, currentPrice } = positions[i];
    const stake = contracts * t.entryPrice;
    const maxPayout = contracts * 1.0;
    const u = unrealizedPnl(contracts, t.entryPrice, currentPrice);
    totalUnrealized += u;
    const edge = t.modelProb - t.entryPrice;
    const itm = isInTheMoney(t.entryPrice, currentPrice);
    const status = itm ? "IN MONEY " : "OUT MONEY";
    const row = [
      String(i + 1),
      t.ticker.padEnd(26),
      t.direction,
      String(contracts).padStart(4),
      cents(t.entryPrice).padStart(6),
      cents(currentPrice).padStart(6),
      pctSigned(edge).padStart(6),
      money(stake).padStart(8),
      money(maxPayout).padStart(8),
      moneySigned(u).padStart(11),
      status.padEnd(9),
      countdown(simNowIso, t.resolvesAt).padStart(12),
    ];
    console.log("  " + row.join(" │ "));
  }

  const totalDeployed = positions.reduce(
    (s, p) => s + p.contracts * p.t.entryPrice,
    0,
  );
  const positionMtmValue = positions.reduce(
    (s, p) => s + p.contracts * p.currentPrice,
    0,
  );
  const cash = STARTING_BALANCE - totalDeployed;
  const portfolioValue = cash + positionMtmValue;

  console.log("");
  console.log("  " + line("═", 40));
  console.log("  PORTFOLIO SUMMARY");
  console.log("  " + line("═", 40));
  console.log(`  Starting Balance    : ${money(STARTING_BALANCE)}`);
  console.log(`  Total Deployed      : ${money(totalDeployed)}   (sum of all stakes)`);
  console.log(`  Available Cash      : ${money(cash)}   (starting − deployed)`);
  console.log(`  Unrealized P&L      : ${moneySigned(totalUnrealized)}`);
  console.log(`  Portfolio Value     : ${money(portfolioValue)}   (cash + current position values)`);
  console.log(`  Open Positions      : ${positions.length}`);
  console.log("  " + line("═", 40));
}

// ─── Phase 3: Resolution boxes ─────────────────────────────────────────

function printResolutionBox(
  t: DemoTrade,
  contracts: number,
): { won: boolean; netPnl: number; fee: number; finalPayout: number } {
  const won = didWin(t);
  const settlement = settlePosition(contracts, t.entryPrice, won);
  const { stake, grossPayout, fee, netPnl, finalPayout, returnPct } = settlement;
  const finalProbForDisplay = t.underlyingYes ? t.finalMarketProb : (1 - t.finalMarketProb);
  // For NO positions the "final price" the trader's contract reaches is (1 - finalYes).
  const finalContractPrice = t.direction === "YES" ? finalProbForDisplay : (1 - finalProbForDisplay);
  const edgeCapturedPp = (finalContractPrice - t.entryPrice) * 100;
  const shortMarket =
    t.marketName.length > 46 ? t.marketName.slice(0, 43) + "..." : t.marketName;

  const outcomeSymbol = won ? "WIN ✓" : "LOSS ✗";
  const resolvedOutcome = t.underlyingYes ? "YES" : "NO";

  console.log("");
  console.log("  ╔" + line("═", 62) + "╗");
  console.log("  ║  TRADE RESOLVED: " + t.ticker.padEnd(44) + "║");
  console.log("  ╠" + line("═", 62) + "╣");
  console.log("  ║  Market      : " + shortMarket.padEnd(46) + "║");
  console.log("  ║  Direction   : " + t.direction.padEnd(46) + "║");
  console.log(
    "  ║  Outcome     : " +
      `${outcomeSymbol}  (Market resolved ${resolvedOutcome})`.padEnd(46) +
      "║",
  );
  console.log("  ║" + line(" ", 62) + "║");
  console.log("  ║  Entry Price       : " + cents(t.entryPrice).padEnd(40) + "║");
  console.log(
    "  ║  Final Prob at Res : " +
      `${pct(finalContractPrice)}  (contract priced at ${cents(finalContractPrice)})`.padEnd(40) +
      "║",
  );
  console.log("  ║  Contracts         : " + String(contracts).padEnd(40) + "║");
  console.log("  ║" + line(" ", 62) + "║");
  console.log("  ║  Stake Deployed    : " + money(stake).padEnd(40) + "║");
  console.log("  ║  Gross Payout      : " + money(grossPayout).padEnd(40) + "║");
  console.log(
    "  ║  Kalshi Fee (7%)   : " +
      `- ${money(fee)}  (7% of net winnings)`.padEnd(40) +
      "║",
  );
  console.log("  ║  Final Payout      : " + money(finalPayout).padEnd(40) + "║");
  console.log(
    "  ║  Net Profit        : " +
      moneySigned(netPnl).padEnd(40) +
      "║",
  );
  console.log(
    "  ║  Return on Stake   : " +
      pctSigned(returnPct, 1).padEnd(40) +
      "║",
  );
  console.log(
    "  ║  Edge Captured     : " +
      `${edgeCapturedPp >= 0 ? "+" : ""}${edgeCapturedPp.toFixed(0)}pp  (${cents(finalContractPrice)} final − ${cents(t.entryPrice)} entry)`.padEnd(40) +
      "║",
  );
  console.log("  ╚" + line("═", 62) + "╝");

  return { won, netPnl, fee, finalPayout };
}

// ─── Phase 4: Final session summary ────────────────────────────────────

interface ClosedRow {
  t: DemoTrade;
  contracts: number;
  stake: number;
  won: boolean;
  netPnl: number;
  fee: number;
  finalPayout: number;
}

function printFinalSummary(closed: ClosedRow[]) {
  printHeader("SESSION COMPLETE — FINAL RESULTS");
  const totalDeployed = closed.reduce((s, r) => s + r.stake, 0);
  const totalReturned = closed.reduce((s, r) => s + r.finalPayout, 0);
  // Gross P&L = returned − deployed + returned-of-losses. Actually simpler:
  // netPnl is already (finalPayout − stake) for wins and (−stake) for losses.
  const netPnl = closed.reduce((s, r) => s + r.netPnl, 0);
  const fees = closed.reduce((s, r) => s + r.fee, 0);
  const grossPnl = netPnl + fees;  // gross before fee
  const endingBalance = STARTING_BALANCE + netPnl;
  const netReturnPct = netPnl / STARTING_BALANCE;

  console.log("");
  console.log(`  Starting Balance    : ${money(STARTING_BALANCE)}`);
  console.log(`  Ending Balance      : ${money(endingBalance)}`);
  console.log(`  Total Deployed      : ${money(totalDeployed)}`);
  console.log(`  Total Returned      : ${money(totalReturned)}`);
  console.log("");
  console.log(`  Gross P&L           : ${moneySigned(grossPnl)}`);
  console.log(`  Kalshi Fees Paid    : - ${money(fees)}`);
  console.log(`  Net P&L             : ${moneySigned(netPnl)}`);
  console.log(`  Net Return          : ${pctSigned(netReturnPct, 1)}`);
  console.log("");

  // Trades summary table
  console.log("  Trades Summary:");
  console.log("  ┌" + line("─", 37) + "┬" + line("─", 6) + "┬" + line("─", 7) + "┬" + line("─", 11) + "┬" + line("─", 10) + "┐");
  console.log(
    "  │ " +
      "Market".padEnd(35) + " │ " +
      "Dir".padEnd(4) + " │ " +
      "Edge".padStart(5) + " │ " +
      "Outcome".padEnd(9) + " │ " +
      "Net P&L".padStart(8) + " │",
  );
  console.log("  ├" + line("─", 37) + "┼" + line("─", 6) + "┼" + line("─", 7) + "┼" + line("─", 11) + "┼" + line("─", 10) + "┤");
  for (const r of closed) {
    const edge = r.t.modelProb - r.t.entryPrice;
    const shortClean = r.t.shortLabel.slice(0, 35);
    const outcome = r.won ? "WIN ✓    " : "LOSS ✗   ";
    console.log(
      "  │ " +
        shortClean.padEnd(35) + " │ " +
        r.t.direction.padEnd(4) + " │ " +
        pctSigned(edge).padStart(5) + " │ " +
        outcome.padEnd(9) + " │ " +
        moneySigned(r.netPnl).padStart(8) + " │",
    );
  }
  console.log("  └" + line("─", 37) + "┴" + line("─", 6) + "┴" + line("─", 7) + "┴" + line("─", 11) + "┴" + line("─", 10) + "┘");
  console.log("");

  const wins = closed.filter((r) => r.won).length;
  const losses = closed.length - wins;
  const avgEdgeAtEntry =
    closed.reduce((s, r) => s + (r.t.modelProb - r.t.entryPrice), 0) / closed.length;
  const avgEdgeCaptured =
    closed.reduce((s, r) => {
      const final = r.t.underlyingYes ? r.t.finalMarketProb : 1 - r.t.finalMarketProb;
      const finalContract = r.t.direction === "YES" ? final : 1 - final;
      return s + (finalContract - r.t.entryPrice);
    }, 0) / closed.length;
  const byPnl = [...closed].sort((a, b) => b.netPnl - a.netPnl);
  const best = byPnl[0];
  const worst = byPnl[byPnl.length - 1];

  console.log(`  Win Rate            : ${wins}/${closed.length} (${pct(wins / closed.length)})`);
  console.log(`  Avg Edge at Entry   : ${pctSigned(avgEdgeAtEntry)}`);
  console.log(`  Avg Edge Captured   : ${(avgEdgeCaptured * 100 >= 0 ? "+" : "")}${(avgEdgeCaptured * 100).toFixed(0)}pp`);
  console.log(`  Best Trade          : ${best.t.ticker}  ${moneySigned(best.netPnl)}`);
  console.log(`  Worst Trade         : ${worst.t.ticker}  ${moneySigned(worst.netPnl)}`);
  console.log("  " + line("═", 70));
}

// ─── Main ──────────────────────────────────────────────────────────────

function main() {
  printHeader(`GAS-BOT KALSHI SIMULATION DEMO  —  starting balance ${money(STARTING_BALANCE)}`);
  console.log("");
  console.log("  Opening 7 high-conviction weather trades across NYC, CHI, LAX, MIA.");
  console.log(`  Position size  : ${money(POSITION_SIZE)}  (contracts = floor(size / entry))`);
  console.log(`  Fee schedule   : ${(KALSHI_FEE_RATE * 100).toFixed(0)}% on net winnings, winners only`);
  console.log(`  Sim time       : ${NOW_ISO}`);
  console.log("");

  // Phase 1: compute contract counts and print entry blocks
  const openPositions: { t: DemoTrade; contracts: number; currentPrice: number }[] = [];
  for (let i = 0; i < DEMO_TRADES.length; i++) {
    const t = DEMO_TRADES[i];
    const contracts = Math.floor(POSITION_SIZE / t.entryPrice);
    printEntryBlock(t, contracts, i, DEMO_TRADES.length);
    openPositions.push({ t, contracts, currentPrice: t.entryPrice });
  }

  // Phase 2: fast-forward a few minutes → price drift → print live dashboard
  const simLaterIso = "2026-04-17T13:12:00-04:00";  // 42 minutes of drift
  const driftFraction = 0.18;  // 18% of the way toward resolution outcome
  for (const p of openPositions) {
    p.currentPrice = driftedCurrentPrice(p.t, driftFraction);
  }
  printLiveDashboard(openPositions, simLaterIso);

  // Phase 3: resolve in order of resolution time
  const resolutionOrder = [...openPositions].sort(
    (a, b) => new Date(a.t.resolvesAt).getTime() - new Date(b.t.resolvesAt).getTime(),
  );
  printHeader("RESOLUTION PHASE  —  trades settle in chronological order");
  const closed: ClosedRow[] = [];
  for (const p of resolutionOrder) {
    const r = printResolutionBox(p.t, p.contracts);
    closed.push({
      t: p.t,
      contracts: p.contracts,
      stake: p.contracts * p.t.entryPrice,
      won: r.won,
      netPnl: r.netPnl,
      fee: r.fee,
      finalPayout: r.finalPayout,
    });
  }

  // Phase 4: final summary
  printFinalSummary(closed);
  console.log("");
}

if (import.meta.main) {
  main();
}
