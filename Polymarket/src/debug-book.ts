/**
 * Quick diagnostic: connect to the next BTC 5m market order book,
 * print the best ask/bid for UP and DOWN, then exit.
 */
import { MarketFinder } from "./market/MarketFinder";
import { OrderBook } from "./market/OrderBook";
import { TickerTracker } from "./market/TickerTracker";

async function main() {
  console.log("Finding next BTC 5m market...");

  const finder = new MarketFinder("5m");
  const market = await finder.findMarket(1);

  if (!market) {
    // Try current slot
    const current = await finder.findMarket(0);
    if (!current) {
      console.log("No market found. Trying offset -1, 0, 1, 2...");
      for (const offset of [-1, 0, 1, 2]) {
        const m = await finder.findMarket(offset);
        if (m) {
          console.log(`  offset=${offset}: ${m.slug} (UP: ${m.tokenIdUp.slice(0, 12)}...)`);
        } else {
          console.log(`  offset=${offset}: not found`);
        }
      }
      process.exit(1);
    }
  }

  console.log(`Market: ${market!.slug}`);
  console.log(`  UP token:   ${market!.tokenIdUp}`);
  console.log(`  DOWN token: ${market!.tokenIdDown}`);
  console.log(`  Slot start: ${new Date(market!.slotStartSec * 1000).toISOString()}`);
  console.log(`  Slot end:   ${new Date(market!.slotEndSec * 1000).toISOString()}`);

  console.log("\nConnecting to order book WebSocket...");
  const book = new OrderBook(market!.tokenIdUp, market!.tokenIdDown);
  await book.connect();

  console.log("Order book connected. Waiting 3 seconds for data...\n");
  await new Promise((r) => setTimeout(r, 3000));

  // Start ticker too
  const ticker = new TickerTracker(["binance"]);
  ticker.start();
  await new Promise((r) => setTimeout(r, 2000));

  // Print book state
  for (const side of ["UP", "DOWN"] as const) {
    const askInfo = book.bestAskInfo(side);
    const bidInfo = book.bestBidInfo(side);
    const sp = book.spread(side);

    console.log(`--- ${side} ---`);
    console.log(`  Best Ask: ${askInfo ? `$${askInfo.price.toFixed(2)} (${askInfo.size.toFixed(1)} shares)` : "N/A"}`);
    console.log(`  Best Bid: ${bidInfo ? `$${bidInfo.price.toFixed(2)} (${bidInfo.size.toFixed(1)} shares)` : "N/A"}`);
    console.log(`  Spread:   ${sp !== null ? `$${sp.toFixed(2)}` : "N/A"}`);

    const topAsks = book.topAsks(side, 5);
    const topBids = book.topBids(side, 5);
    console.log(`  Top 5 Asks: ${topAsks.map((l) => `${l.price.toFixed(2)}×${l.size.toFixed(0)}`).join(" | ")}`);
    console.log(`  Top 5 Bids: ${topBids.map((l) => `${l.price.toFixed(2)}×${l.size.toFixed(0)}`).join(" | ")}`);
  }

  console.log(`\nBTC Price: $${ticker.price?.toFixed(2) ?? "N/A"}`);

  // Cleanup
  book.disconnect();
  ticker.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
