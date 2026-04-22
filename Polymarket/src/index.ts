import { Command } from "commander";
import { Engine } from "./engine/Engine";
import { loadConfig, setProd } from "./util/config";
import { strategies, DEFAULT_STRATEGY } from "./strategy/strategies/index";
import type { EngineConfig } from "./engine/types";
import { DEFAULT_ENGINE_CONFIG } from "./engine/types";

const program = new Command();

program
  .name("satriales")
  .description("Automated Polymarket BTC trading engine with signal integration")
  .version("0.1.0")
  .option("-s, --strategy <name>", "Strategy to run", DEFAULT_STRATEGY)
  .option("--slot-offset <n>", "Which future market slot to enter (1=next)", "1")
  .option("--prod", "Run in production mode with real funds", false)
  .option("--rounds <n>", "Number of rounds to trade (-1=unlimited)", "-1")
  .option("--always-log", "Write logs even for rounds with no orders", false)
  .action(async (opts) => {
    // Load env config
    loadConfig();

    // Validate strategy
    const strategyName = opts.strategy;
    if (!strategies[strategyName]) {
      console.error(`Unknown strategy: "${strategyName}"`);
      console.error(`Available: ${Object.keys(strategies).join(", ")}`);
      process.exit(1);
    }

    // Production mode
    if (opts.prod) {
      const config = loadConfig();
      if (!config.PRIVATE_KEY) {
        console.error("PRIVATE_KEY is required for production mode. Set it in .env");
        process.exit(1);
      }

      if (!config.FORCE_PROD) {
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question("Run in PRODUCTION mode with real funds? Enter Y to confirm: ", resolve);
        });
        rl.close();

        if (answer.trim().toUpperCase() !== "Y") {
          console.log("Aborted.");
          process.exit(0);
        }
      }

      setProd(true);
    }

    const engineConfig: EngineConfig = {
      mode: opts.prod ? "prod" : "sim",
      strategyName,
      maxRounds: parseInt(opts.rounds, 10),
      slotOffset: parseInt(opts.slotOffset, 10),
      marketWindow: loadConfig().MARKET_WINDOW,
      tickIntervalMs: DEFAULT_ENGINE_CONFIG.tickIntervalMs!,
      stateFlushIntervalMs: DEFAULT_ENGINE_CONFIG.stateFlushIntervalMs!,
      alwaysLog: opts.alwaysLog,
    };

    console.log(`
  ╔═══════════════════════════════╗
  ║       S A T R I A L E S       ║
  ║   Polymarket Trading Engine   ║
  ╚═══════════════════════════════╝
`);

    const engine = new Engine(engineConfig);
    await engine.start();
  });

program.parse();
