import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { LogEntry, LogEntryType, LogColor } from "./types";

const COLORS: Record<LogColor, string> = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

export class Logger {
  private logDir: string;
  private sessionLogPath: string;
  private marketLogPath: string | null = null;
  private buffer: LogEntry[] = [];

  constructor(logDir: string) {
    this.logDir = logDir;
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.sessionLogPath = join(logDir, `session-${ts}.log`);
  }

  /** Start a new market-round log file. */
  startRound(slug: string): void {
    this.marketLogPath = join(this.logDir, `${slug}.ndjson`);
    this.buffer = [];
  }

  /** Write a structured entry to the market log buffer. */
  record(type: LogEntryType, data: Record<string, unknown>): void {
    const entry: LogEntry = { type, timestamp: Date.now(), data };
    this.buffer.push(entry);
  }

  /** Flush the market log buffer to disk. */
  flushMarketLog(): void {
    if (!this.marketLogPath || this.buffer.length === 0) return;

    const lines = this.buffer.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(this.marketLogPath, lines, "utf-8");
    this.buffer = [];
  }

  /** End the current market-round log. */
  endRound(): void {
    this.flushMarketLog();
    this.marketLogPath = null;
  }

  /** Log a message to console and session file. */
  log(msg: string, color: LogColor = "reset"): void {
    const ts = new Date().toISOString().slice(11, 19);
    const prefix = `[${ts}]`;

    const colorCode = COLORS[color];
    const reset = COLORS.reset;
    console.log(`${COLORS.dim}${prefix}${reset} ${colorCode}${msg}${reset}`);

    appendFileSync(this.sessionLogPath, `${prefix} ${msg}\n`, "utf-8");
  }

  /** Log an error. */
  error(msg: string): void {
    this.log(`ERROR: ${msg}`, "red");
    this.record("error", { message: msg });
  }

  /** Log info. */
  info(msg: string): void {
    this.log(msg, "cyan");
  }
}
