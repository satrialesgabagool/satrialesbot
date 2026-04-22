import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { PersistentState } from "./types";

const STATE_DIR = join(import.meta.dir, "../../state");

function stateFilePath(prod: boolean, strategyName?: string): string {
  const suffix = strategyName ? `-${strategyName}` : "";
  return join(STATE_DIR, prod ? `engine-prod${suffix}.json` : `engine-sim${suffix}.json`);
}

export function loadState(prod: boolean, strategyName?: string): PersistentState {
  const path = stateFilePath(prod, strategyName);

  if (!existsSync(path)) {
    return emptyState();
  }

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as PersistentState;
  } catch {
    return emptyState();
  }
}

export function saveState(state: PersistentState, prod: boolean, strategyName?: string): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  const path = stateFilePath(prod, strategyName);
  const tmpPath = path + ".tmp";

  // Atomic write: write to temp file, then rename
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

export function emptyState(): PersistentState {
  return {
    sessionPnl: 0,
    sessionLoss: 0,
    roundsCompleted: 0,
    activeRounds: [],
    completedRounds: [],
  };
}

export function resetState(prod: boolean, strategyName?: string): void {
  saveState(emptyState(), prod, strategyName);
}
