import { existsSync, writeFileSync, unlinkSync, readFileSync, statSync } from "fs";
import { join } from "path";

const LOCK_DIR = join(import.meta.dir, "../../state");

/** Stale lock threshold — if lock file is older than this, assume the process crashed. */
const STALE_THRESHOLD_MS = 60_000; // 1 minute

let activeLockFile: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function acquireLock(name: string = "default"): boolean {
  const lockFile = join(LOCK_DIR, `satriales-${name}.lock`);

  if (existsSync(lockFile)) {
    const pid = readFileSync(lockFile, "utf-8").trim();

    // Check if the process is actually alive
    let alive = false;
    try {
      process.kill(parseInt(pid, 10), 0);
      alive = true;
    } catch {
      alive = false;
    }

    if (alive) {
      // On Windows, PIDs get recycled. Check lock file age — if it hasn't
      // been touched in over a minute, the original process is gone and a
      // different process now occupies that PID.
      try {
        const age = Date.now() - statSync(lockFile).mtimeMs;
        if (age > STALE_THRESHOLD_MS) {
          alive = false; // Stale lock — heartbeat stopped
        }
      } catch {
        alive = false;
      }
    }

    if (alive) return false; // Lock genuinely held

    // Stale lock — clean up
    try { unlinkSync(lockFile); } catch {}
  }

  writeFileSync(lockFile, process.pid.toString(), "utf-8");
  activeLockFile = lockFile;

  // Heartbeat: touch the lock file every 15s so stale detection works
  heartbeatTimer = setInterval(() => {
    try {
      if (activeLockFile) writeFileSync(activeLockFile, process.pid.toString(), "utf-8");
    } catch {}
  }, 15_000);

  return true;
}

export function releaseLock(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    if (activeLockFile && existsSync(activeLockFile)) {
      unlinkSync(activeLockFile);
      activeLockFile = null;
    }
  } catch {
    // Ignore errors during cleanup
  }
}

process.on("exit", releaseLock);
