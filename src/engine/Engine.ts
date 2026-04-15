import type { EngineConfig, RoundResult } from "./types";
import { loadState, saveState, emptyState } from "./state";
import { RoundLifecycle, type RoundConfig } from "./RoundLifecycle";
import { MarketFinder, type MarketInfo } from "../market/MarketFinder";
import { OrderBook } from "../market/OrderBook";
import { TickerTracker } from "../market/TickerTracker";
import { SimClient } from "../client/SimClient";
import { SimWallet } from "../wallet/SimWallet";
import { SignalBus } from "../signals/SignalBus";
import { FearGreedSource } from "../signals/sources/FearGreedSource";
import { Logger } from "../log/Logger";
import { getConfig } from "../util/config";
import { acquireLock, releaseLock } from "../util/ProcessLock";
import { strategies } from "../strategy/strategies/index";
import { join } from "path";

export class Engine {
  private config: EngineConfig;
  private logger: Logger;
  private ticker: TickerTracker;
  private signalBus: SignalBus;
  private marketFinder: MarketFinder;
  private lifecycle: RoundLifecycle | null = null;
  private currentOrderBook: OrderBook | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private sessionPnl = 0;
  private sessionLoss = 0;
  private roundsCompleted = 0;
  private completedRounds: RoundResult[] = [];
  private shuttingDown = false;
  private currentMarket: MarketInfo | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
    this.logger = new Logger(join(import.meta.dir, "../../logs"));

    const appConfig = getConfig();
    this.ticker = new TickerTracker(appConfig.BTC_TICKER);
    this.signalBus = new SignalBus();
    this.marketFinder = new MarketFinder(config.marketWindow);

    // Register signal sources
    this.signalBus.register(new FearGreedSource());
  }

  async start(): Promise<void> {
    if (!acquireLock(this.config.strategyName)) {
      this.logger.error("Another instance with this strategy is running. Exiting.");
      process.exit(1);
    }

    this.logger.log("=== Satriales Engine ===", "cyan");
    this.logger.log(`Mode: ${this.config.mode} | Strategy: ${this.config.strategyName}`, "cyan");
    this.logger.log(
      `Rounds: ${this.config.maxRounds === -1 ? "unlimited" : this.config.maxRounds} | Window: ${this.config.marketWindow}`,
      "cyan",
    );

    // Load prior state
    const isProd = this.config.mode === "prod";
    const state = loadState(isProd, this.config.strategyName);
    this.sessionPnl = state.sessionPnl;
    this.sessionLoss = state.sessionLoss;
    this.roundsCompleted = state.roundsCompleted;
    this.completedRounds = state.completedRounds;

    // Check session loss limit
    const appConfig = getConfig();
    if (Math.abs(this.sessionLoss) >= appConfig.MAX_SESSION_LOSS) {
      this.logger.error(
        `Session loss limit reached: $${this.sessionLoss.toFixed(2)} >= $${appConfig.MAX_SESSION_LOSS}`,
      );
      this.logger.log("Reset state file to continue.", "yellow");
      process.exit(1);
    }

    // Start subsystems
    this.ticker.start();
    await this.signalBus.startAll();
    this.logger.log("Signals started", "green");

    // Setup shutdown handlers
    const shutdown = () => this.shutdown();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Start tick loop
    this.tickTimer = setInterval(() => this.tick(), this.config.tickIntervalMs);

    // Start state persistence
    this.stateTimer = setInterval(
      () => this.persistState(),
      this.config.stateFlushIntervalMs,
    );

    this.logger.log("Engine started. Waiting for market...", "green");
  }

  private async tick(): Promise<void> {
    if (this.shuttingDown) return;

    // If we have an active lifecycle, tick it
    if (this.lifecycle) {
      await this.lifecycle.tick();

      if (this.lifecycle.isDone) {
        const result = this.lifecycle.roundResult;
        if (result) {
          this.sessionPnl += result.pnl;
          if (result.pnl < 0) {
            this.sessionLoss += result.pnl;
          }
          this.roundsCompleted++;
          this.completedRounds.push(result);

          this.logger.log(
            `Session PnL: $${this.sessionPnl.toFixed(2)} | Loss: $${this.sessionLoss.toFixed(2)} | Rounds: ${this.roundsCompleted}`,
            "cyan",
          );

          // Check limits
          const appConfig = getConfig();
          if (Math.abs(this.sessionLoss) >= appConfig.MAX_SESSION_LOSS) {
            this.logger.log("Session loss limit reached. Shutting down.", "red");
            this.shutdown();
            return;
          }

          if (this.config.maxRounds > 0 && this.roundsCompleted >= this.config.maxRounds) {
            this.logger.log(`Completed ${this.roundsCompleted} rounds. Shutting down.`, "cyan");
            this.shutdown();
            return;
          }
        }

        // Cleanup — disconnect order book to prevent dangling WebSocket
        if (this.currentOrderBook) {
          this.currentOrderBook.disconnect();
          this.currentOrderBook = null;
        }
        this.lifecycle = null;
        this.currentMarket = null;
      }

      return;
    }

    // No active lifecycle — discover next market
    await this.discoverAndStartRound();
  }

  private async discoverAndStartRound(): Promise<void> {
    try {
      const market = await this.marketFinder.findMarket(this.config.slotOffset);
      if (!market) return; // Will retry on next tick

      // Don't re-enter a market we already traded
      if (this.completedRounds.some((r) => r.slug === market.slug)) return;
      if (this.currentMarket?.slug === market.slug) return;

      this.currentMarket = market;
      this.logger.log(`Found market: ${market.slug}`, "cyan");

      // Create order book and connect (store ref for cleanup)
      const orderBook = new OrderBook(market.tokenIdUp, market.tokenIdDown);
      await orderBook.connect();
      this.currentOrderBook = orderBook;

      // Create sim wallet + client
      const appConfig = getConfig();
      const wallet = new SimWallet(appConfig.WALLET_BALANCE);
      const client = new SimClient(orderBook, wallet, market.tokenIdUp, market.tokenIdDown);

      // Look up strategy
      const strategy = strategies[this.config.strategyName];
      if (!strategy) {
        this.logger.error(`Strategy "${this.config.strategyName}" not found`);
        this.shutdown();
        return;
      }

      const roundConfig: RoundConfig = {
        slug: market.slug,
        tokenIdUp: market.tokenIdUp,
        tokenIdDown: market.tokenIdDown,
        slotStartMs: market.slotStartSec * 1000,
        slotEndMs: market.slotEndSec * 1000,
        strategy,
        orderBook,
        ticker: this.ticker,
        signals: this.signalBus.getSnapshot(),
        client,
        logger: this.logger,
      };

      this.lifecycle = new RoundLifecycle(roundConfig);
      this.logger.log(`Round started: ${market.slug}`, "green");
    } catch (error) {
      // Discovery failure — will retry on next tick
    }
  }

  private persistState(): void {
    const isProd = this.config.mode === "prod";
    saveState(
      {
        sessionPnl: this.sessionPnl,
        sessionLoss: this.sessionLoss,
        roundsCompleted: this.roundsCompleted,
        activeRounds: [],
        completedRounds: this.completedRounds,
      },
      isProd,
      this.config.strategyName,
    );
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.log("Shutting down...", "yellow");

    // Stop tick loop
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.stateTimer) {
      clearInterval(this.stateTimer);
      this.stateTimer = null;
    }

    // Shutdown active lifecycle
    if (this.lifecycle && !this.lifecycle.isDone) {
      this.lifecycle.shutdown();
      // Give it time to wind down
      for (let i = 0; i < 50; i++) {
        await this.lifecycle.tick();
        if (this.lifecycle.isDone) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Disconnect order book WebSocket (prevents dangling event loop handles)
    if (this.currentOrderBook) {
      this.currentOrderBook.disconnect();
      this.currentOrderBook = null;
    }

    // Stop subsystems
    this.ticker.stop();
    await this.signalBus.stopAll();

    // Persist final state
    this.persistState();

    // Release lock
    releaseLock();

    this.logger.log(
      `Final PnL: $${this.sessionPnl.toFixed(2)} | Rounds: ${this.roundsCompleted}`,
      this.sessionPnl >= 0 ? "green" : "red",
    );
    this.logger.log("Engine stopped.", "cyan");

    // Force exit — WebSocket cleanup is best-effort, don't let stale handles
    // keep the process alive and block the orchestrator
    setTimeout(() => process.exit(0), 500);
  }
}
