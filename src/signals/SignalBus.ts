import type { SignalEvent, SignalSource } from "./types";
import { SignalSnapshot, type ISignalSnapshot } from "./SignalSnapshot";

type SignalListener = (event: SignalEvent) => void;

export class SignalBus {
  private sources: SignalSource[] = [];
  private listeners: SignalListener[] = [];
  private snapshot: SignalSnapshot;

  constructor() {
    this.snapshot = new SignalSnapshot();
  }

  /** Register a signal source. Must be called before start(). */
  register(source: SignalSource): void {
    source.emit = (event: SignalEvent) => this.dispatch(event);
    this.sources.push(source);
    this.snapshot.totalSourceCount = this.sources.length;
  }

  /** Start all registered sources. */
  async startAll(): Promise<void> {
    const results = await Promise.allSettled(this.sources.map((s) => s.start()));

    let healthy = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "fulfilled") {
        healthy++;
      } else {
        const reason = (results[i] as PromiseRejectedResult).reason;
        console.error(`[SignalBus] Failed to start ${this.sources[i].name}:`, reason);
      }
    }
    this.snapshot.healthySourceCount = healthy;
  }

  /** Stop all sources. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(this.sources.map((s) => s.stop()));
    this.snapshot.healthySourceCount = 0;
  }

  /** Subscribe to all signal events (used by strategies). */
  onSignal(listener: SignalListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Get the current signal snapshot (read-only view). */
  getSnapshot(): ISignalSnapshot {
    return this.snapshot;
  }

  private dispatch(event: SignalEvent): void {
    this.snapshot.update(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[SignalBus] Listener error:", error);
      }
    }
  }
}
