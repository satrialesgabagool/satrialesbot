#!/usr/bin/env bun
/**
 * Gas-bot Dashboard Server
 *
 * A lightweight web server that provides:
 *   1. Static HTML/CSS/JS dashboard at http://localhost:3000
 *   2. REST API endpoints for fetching scanner data
 *   3. Server-Sent Events (SSE) for real-time live feed
 *
 * How it works:
 *   - Hono handles HTTP routing (like Express but faster on Bun)
 *   - The /api/events endpoint reads the JSONL file our scanners write to
 *   - The /api/events/stream endpoint uses SSE to push new events in real-time
 *   - SSE = the server keeps the HTTP connection open and sends data as it appears
 *     (like a one-way WebSocket — simpler, works everywhere)
 *
 * Run: bun run src/dashboard/server.ts
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { readFileSync, existsSync, statSync, watchFile, unwatchFile } from "fs";
import { join } from "path";
import { runBacktest, type BacktestParams } from "./backtest-runner";
import { fetchAccuracyData } from "./accuracy-runner";

const app = new Hono();
const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3000");

// ─── Where our scanner data lives ───────────────────────────────────
// These paths match what HighConvictionLog writes to
const RESULTS_DIR = process.env.RESULTS_DIR ?? "results";
const EVENTS_JSONL = join(RESULTS_DIR, "high-conviction.jsonl");
const EVENTS_CSV = join(RESULTS_DIR, "high-conviction.csv");

// ─── API: Get all events ────────────────────────────────────────────
// Returns every signal our scanners have found, parsed from the JSONL file.
// The dashboard calls this on page load to populate the table.
app.get("/api/events", (c) => {
  const events = readEventsFromDisk();
  return c.json({
    count: events.length,
    events,
  });
});

// ─── API: Get summary stats ─────────────────────────────────────────
// Quick overview numbers for the dashboard header cards.
app.get("/api/stats", (c) => {
  const events = readEventsFromDisk();
  const weather = events.filter((e) => e.strategy === "weather");
  const whale = events.filter((e) => e.strategy === "whale");

  // Average edge across all weather signals
  const avgEdge = weather.length > 0
    ? weather.reduce((s, e) => s + e.edgeBps, 0) / weather.length
    : 0;

  // Average conviction
  const avgConviction = events.length > 0
    ? events.reduce((s, e) => s + e.conviction, 0) / events.length
    : 0;

  // Unique markets seen
  const uniqueMarkets = new Set(events.map((e) => e.marketTicker)).size;

  return c.json({
    totalSignals: events.length,
    weatherSignals: weather.length,
    whaleSignals: whale.length,
    avgEdgeBps: Math.round(avgEdge),
    avgConviction: Math.round(avgConviction * 1000) / 1000,
    uniqueMarkets,
    lastUpdated: events.length > 0 ? events[events.length - 1].timestamp : null,
  });
});

// ─── API: Server-Sent Events stream ─────────────────────────────────
// This is the magic for real-time updates.
//
// How SSE works:
//   1. Browser opens a long-lived HTTP connection to this endpoint
//   2. Server watches the JSONL file for changes
//   3. When new lines appear, server pushes them to the browser
//   4. Browser's EventSource API fires an event handler for each message
//   5. If the connection drops, the browser auto-reconnects (built-in!)
//
// Format: each message is "data: {json}\n\n" (SSE spec)
app.get("/api/events/stream", (c) => {
  // Track how many lines we've already sent so we only push NEW events
  const allEvents = readEventsFromDisk();
  let sentCount = allEvents.length;

  // Create a ReadableStream that stays open and pushes data
  const stream = new ReadableStream({
    start(controller) {
      // Send a heartbeat comment every 30s to keep the connection alive
      // (proxies/browsers may close idle connections)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(": heartbeat\n\n");
        } catch {
          clearInterval(heartbeat);
        }
      }, 30_000);

      // Watch the JSONL file for changes
      // When the scanner appends a new line, this callback fires
      const checkForNew = () => {
        try {
          const current = readEventsFromDisk();
          if (current.length > sentCount) {
            // Send only the NEW events (everything after sentCount)
            const newEvents = current.slice(sentCount);
            for (const event of newEvents) {
              controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
            }
            sentCount = current.length;
          }
        } catch {
          // File might not exist yet — that's fine
        }
      };

      // Poll the file every 2 seconds for changes
      // (watchFile is more reliable than fs.watch on Windows)
      const poll = setInterval(checkForNew, 2000);

      // Cleanup when the client disconnects
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        clearInterval(poll);
        try { controller.close(); } catch {}
      });
    },
  });

  // Return the stream with SSE headers
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// ─── API: Run backtest ──────────────────────────────────────────────
// POST /api/backtest/run with optional JSON body: { cities, daysBack, minEdge, ... }
// Returns full backtest results including trades, equity curve, accuracy.
// This calls Open-Meteo APIs so it takes 5-15 seconds to complete.
let backtestRunning = false;

app.post("/api/backtest/run", async (c) => {
  if (backtestRunning) {
    return c.json({ error: "Backtest already running" }, 409);
  }
  backtestRunning = true;
  try {
    const body = await c.req.json().catch(() => ({})) as BacktestParams;
    const result = await runBacktest(body);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    backtestRunning = false;
  }
});

app.get("/api/backtest/status", (c) => {
  return c.json({ running: backtestRunning });
});

// ─── API: Simulator state ───────────────────────────────────────────
// Reads the WeatherSimulator's persisted state file.
// The simulator (kalshi-weather-live.ts) saves state to state/weather-sim.json
// every scan cycle. This endpoint lets the dashboard display it.
const STATE_PATH = join("state", "weather-sim.json");

app.get("/api/sim/state", (c) => {
  if (!existsSync(STATE_PATH)) {
    return c.json({
      status: "no_state",
      message:
        "No simulator state found. Run: bun run src/dashboard/paper-trader.ts",
    });
  }
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(raw);
    // Return the state flat (no wrapper) so the SSE stream and the initial
    // fetch produce the same shape — simpler client code.
    return c.json(state);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// SSE stream for simulator state updates (polls state file every 5s)
app.get("/api/sim/stream", (c) => {
  let lastSavedAt = "";

  const stream = new ReadableStream({
    start(controller) {
      const heartbeat = setInterval(() => {
        try { controller.enqueue(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
      }, 30_000);

      const checkState = () => {
        try {
          if (!existsSync(STATE_PATH)) return;
          const raw = readFileSync(STATE_PATH, "utf-8");
          const state = JSON.parse(raw);
          if (state.savedAt !== lastSavedAt) {
            lastSavedAt = state.savedAt;
            controller.enqueue(`data: ${JSON.stringify(state)}\n\n`);
          }
        } catch {}
      };

      const poll = setInterval(checkState, 5000);
      checkState(); // send current state immediately

      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        clearInterval(poll);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});

// ─── API: Forecast accuracy ─────────────────────────────────────────
// Fetches forecast vs actual data from Open-Meteo. Takes 5-10 seconds.
app.get("/api/accuracy", async (c) => {
  const daysBack = parseInt(c.req.query("days") ?? "7");
  try {
    const result = await fetchAccuracyData(daysBack);
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ─── Serve static files (HTML, CSS, JS) ─────────────────────────────
// Anything in src/dashboard/public/ is served at the root URL.
// So public/index.html → http://localhost:3000/index.html
app.use("/*", serveStatic({ root: "./src/dashboard/public" }));

// ─── Helper: read JSONL file into array of events ───────────────────
interface DashboardEvent {
  timestamp: string;
  strategy: "weather" | "whale";
  eventTicker: string;
  marketTicker: string;
  side: string;
  yesPrice: number;
  edgeBps: number;
  conviction: number;
  reason: string;
  [key: string]: unknown;
}

function readEventsFromDisk(): DashboardEvent[] {
  if (!existsSync(EVENTS_JSONL)) return [];
  try {
    const raw = readFileSync(EVENTS_JSONL, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line) as DashboardEvent);
  } catch {
    return [];
  }
}

// ─── Start the server ───────────────────────────────────────────────
console.log(`
╔═══════════════════════════════════════════╗
║   GAS-BOT DASHBOARD                      ║
║   http://localhost:${PORT}                    ║
╚═══════════════════════════════════════════╝

  Open your browser to http://localhost:${PORT}
  Scanner data from: ${EVENTS_JSONL}
  Press Ctrl+C to stop
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
