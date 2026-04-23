/**
 * Simple file-based process lock — prevents multiple instances of the same bot
 * from running at once (which causes duplicate orders).
 *
 * Usage:
 *   import { acquireBotLock, releaseBotLock } from "./BotLock";
 *   const lock = acquireBotLock("kalshi-intrinsic");  // throws if already locked
 *   // ... bot runs ...
 *   releaseBotLock(lock);  // on exit
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const LOCK_DIR = "state/locks";

export interface BotLockHandle {
  name: string;
  pid: number;
  path: string;
}

/** Check if a PID is still running */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);  // signal 0 = test only
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire a lock for the named bot.
 * Throws if another instance is already running.
 * Automatically clears stale locks (whose PID is no longer alive).
 */
export function acquireBotLock(name: string): BotLockHandle {
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });
  const path = join(LOCK_DIR, `${name}.lock`);

  // Check for existing lock
  if (existsSync(path)) {
    try {
      const existingPid = parseInt(readFileSync(path, "utf-8").trim(), 10);
      if (existingPid && isPidAlive(existingPid)) {
        throw new Error(
          `Bot "${name}" is already running (PID ${existingPid}).\n` +
          `If this is stale, remove ${path} manually.`
        );
      }
      // PID dead — stale lock, clear it
      unlinkSync(path);
    } catch (err: any) {
      if (err.message?.startsWith("Bot ")) throw err;
      // Unable to read — treat as stale, clear
      try { unlinkSync(path); } catch {}
    }
  }

  const pid = process.pid;
  writeFileSync(path, String(pid), "utf-8");

  const handle: BotLockHandle = { name, pid, path };

  // Release on exit signals
  const release = () => { try { releaseBotLock(handle); } catch {} };
  process.on("SIGINT", release);
  process.on("SIGTERM", release);
  process.on("exit", release);

  return handle;
}

export function releaseBotLock(lock: BotLockHandle): void {
  try {
    if (!existsSync(lock.path)) return;
    const stored = parseInt(readFileSync(lock.path, "utf-8").trim(), 10);
    if (stored === lock.pid) {
      unlinkSync(lock.path);
    }
  } catch {}
}
