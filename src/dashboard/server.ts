#!/usr/bin/env bun
/**
 * Satriales Weather Bot Dashboard
 *
 * Single-page web UI at http://localhost:3000 that reads:
 *   - state/weather-sim.json  (live bot state)
 *   - results/weather-trades.csv  (trade history for equity curve)
 *
 * Does NOT modify any bot state — pure read-only viewer.
 *
 * Run:
 *   bun run src/dashboard/server.ts
 *   DASHBOARD_PORT=3001 bun run src/dashboard/server.ts
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readFileSync, existsSync, statSync, watchFile } from "fs";
import { join } from "path";

const app = new Hono();
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3000");

const ROOT = join(import.meta.dir, "../..");
const STATE_PATH = join(ROOT, "state/weather-sim.json");
const TRADES_CSV = join(ROOT, "results/weather-trades.csv");

// ─── CSV parser (handles mixed 15/17-col format from our CSV) ─────────

interface TradeRow {
  timestamp: string;
  action: string;
  city: string;
  date: string;
  type: string;
  bracket: string;
  shares: number;
  price: number;
  cost: number;
  forecastTempF: number;
  forecastProb: number;
  edge: number;
  modelSpread: number;
  models: number;
  hoursToRes: number;
  pnl: number;
  balance: number;
}

function readTradesCsv(): TradeRow[] {
  if (!existsSync(TRADES_CSV)) return [];
  const text = readFileSync(TRADES_CSV, "utf-8");
  const lines = text.split("\n").slice(1).filter(l => l.trim().length > 0);
  const rows: TradeRow[] = [];
  for (const line of lines) {
    const f = line.split(",");
    // Old format (15 cols) vs new format (17 cols with model_spread + models)
    const hasExtra = f.length === 17;
    const idx = hasExtra
      ? { modelSpread: 12, models: 13, hoursToRes: 14, pnl: 15, balance: 16 }
      : { modelSpread: -1, models: -1, hoursToRes: 12, pnl: 13, balance: 14 };
    rows.push({
      timestamp: f[0],
      action: f[1],
      city: f[2],
      date: f[3],
      type: f[4],
      bracket: f[5],
      shares: parseFloat(f[6]) || 0,
      price: parseFloat(f[7]) || 0,
      cost: parseFloat(f[8]) || 0,
      forecastTempF: parseFloat(f[9]) || 0,
      forecastProb: parseFloat(f[10]) || 0,
      edge: parseFloat(f[11]) || 0,
      modelSpread: idx.modelSpread >= 0 ? parseFloat(f[idx.modelSpread]) || 0 : 0,
      models: idx.models >= 0 ? parseFloat(f[idx.models]) || 0 : 0,
      hoursToRes: parseFloat(f[idx.hoursToRes]) || 0,
      pnl: parseFloat(f[idx.pnl]) || 0,
      balance: parseFloat(f[idx.balance]) || 0,
    });
  }
  return rows;
}

function readState(): any {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function bracketLabel(b: any): string {
  const lo = b.lowF, hi = b.highF;
  if ((lo == null || !isFinite(lo)) && hi != null && isFinite(hi)) return `≤${hi}°F`;
  if (lo != null && isFinite(lo) && (hi == null || !isFinite(hi))) return `≥${lo}°F`;
  return `${lo}-${hi}°F`;
}

function groupLadders(positions: any[]): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const p of positions) {
    const key = p.ladderGroup ?? `${p.market?.city}-${p.market?.date}-${p.market?.type}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(p);
  }
  return m;
}

// ─── API ────────────────────────────────────────────────────────────

app.get("/api/state", (c) => {
  const s = readState();
  if (!s) return c.json({ error: "no state file" }, 404);

  const openLadders = [...groupLadders(s.positions ?? [])].map(([key, legs]) => ({
    key,
    city: legs[0].market.city,
    date: legs[0].market.date,
    type: legs[0].market.type,
    endDate: legs[0].market.endDate,
    forecastTempF: legs[0].forecastTempF,
    modelSpreadF: legs[0].modelSpreadF ?? 0,
    cost: legs.reduce((s: number, l: any) => s + l.cost, 0),
    hoursToRes: Math.max(0, (new Date(legs[0].market.endDate).getTime() - Date.now()) / 3600000),
    legs: legs.map((l: any) => ({
      id: l.id,
      bracket: bracketLabel(l.bracket),
      shares: l.shares,
      entryPrice: l.entryPrice,
      cost: l.cost,
      prob: l.forecastProb,
      edge: l.edge,
    })),
  }));

  const closedLadders = [...groupLadders(s.closedPositions ?? [])]
    .map(([key, legs]) => {
      const cost = legs.reduce((s: number, l: any) => s + l.cost, 0);
      const pnl = legs.reduce((s: number, l: any) => s + (l.pnl ?? 0), 0);
      const hits = legs.filter((l: any) => l.status === "won").length;
      return {
        key,
        city: legs[0].market.city,
        date: legs[0].market.date,
        type: legs[0].market.type,
        resolvedTempF: legs[0].resolvedTempF,
        resolvedAt: legs[0].resolvedAt,
        cost,
        pnl,
        hits,
        total: legs.length,
        legs: legs.map((l: any) => ({
          bracket: bracketLabel(l.bracket),
          shares: l.shares,
          entryPrice: l.entryPrice,
          cost: l.cost,
          pnl: l.pnl,
          status: l.status,
        })),
      };
    })
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""));

  return c.json({
    balance: s.balance,
    deployed: s.deployed,
    totalPnl: s.totalPnl ?? 0,
    wins: s.wins ?? 0,
    losses: s.losses ?? 0,
    scansCompleted: s.scansCompleted ?? 0,
    startingBalance: s.config?.startingBalance ?? 500,
    savedAt: s.savedAt,
    openLadders,
    closedLadders,
  });
});

app.get("/api/equity", (c) => {
  const rows = readTradesCsv();
  // Build balance-over-time series from the CSV "balance" column
  const points: Array<{ t: string; balance: number }> = [];
  for (const r of rows) {
    if (r.balance > 0) points.push({ t: r.timestamp, balance: r.balance });
  }
  return c.json({ points });
});

// ─── SSE stream: state updates when the state file changes ──────────

app.get("/api/stream", (c) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      let alive = true;
      const send = (data: any) => {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          alive = false;
        }
      };

      // Send initial state immediately
      const s = readState();
      if (s) send({ type: "state", savedAt: s.savedAt });

      // Poll state file mtime every 2s; push when it changes
      let lastMtime = existsSync(STATE_PATH) ? statSync(STATE_PATH).mtimeMs : 0;
      const ticker = setInterval(() => {
        if (!alive) {
          clearInterval(ticker);
          return;
        }
        try {
          if (existsSync(STATE_PATH)) {
            const m = statSync(STATE_PATH).mtimeMs;
            if (m !== lastMtime) {
              lastMtime = m;
              const s = readState();
              if (s) send({ type: "state", savedAt: s.savedAt });
            }
          }
          // Keepalive ping every 30s
          send({ type: "ping", t: Date.now() });
        } catch {}
      }, 2000);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// ─── Static files ────────────────────────────────────────────────────

app.use("/*", serveStatic({ root: "./src/dashboard/public" }));

console.log(`
  ╔══════════════════════════════════════╗
  ║  Satriales Weather Dashboard         ║
  ║  → http://localhost:${PORT.toString().padEnd(4)}             ║
  ╚══════════════════════════════════════╝
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
