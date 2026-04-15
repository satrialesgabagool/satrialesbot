import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";

const LOCK_DIR = join(import.meta.dir, "../../state");

let activeLockFile: string | null = null;

export function acquireLock(name: string = "default"): boolean {
  const lockFile = join(LOCK_DIR, `satriales-${name}.lock`);

  if (existsSync(lockFile)) {
    const pid = readFileSync(lockFile, "utf-8").trim();
    try {
      process.kill(parseInt(pid, 10), 0);
      return false; // Process is alive, lock held
    } catch {
      unlinkSync(lockFile);
    }
  }

  writeFileSync(lockFile, process.pid.toString(), "utf-8");
  activeLockFile = lockFile;
  return true;
}

export function releaseLock(): void {
  try {
    if (activeLockFile && existsSync(activeLockFile)) {
      unlinkSync(activeLockFile);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

process.on("exit", releaseLock);
