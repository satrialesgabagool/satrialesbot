#!/usr/bin/env bun
/**
 * Weather Market Scanner
 *
 * Scans all active Polymarket weather markets, fetches forecasts,
 * and identifies mispriced brackets where our forecast probability
 * differs significantly from market odds.
 *
 * Usage: bun run src/weather/WeatherScanner.ts [--min-edge 0.10] [--watch]
 */

import { findWeatherMarkets, type WeatherMarket, type TempBracket } from "./WeatherMarketFinder";
import { fetchForecast, bracketProbability, type ForecastResult } from "./WeatherForecast";
import { appendFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const RESULTS_DIR = join(import.meta.dir, "../../results");
const CSV_PATH = join(RESULTS_DIR, "weather-opportunities.csv");
const CSV_HEADER = "timestamp,city,date,type,bracket,market_price,forecast_prob,edge,forecast_high_f,hours_to_resolution,slug\n";

// ANSI colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

interface Opportunity {
  market: WeatherMarket;
  bracket: TempBracket;
  forecast: ForecastResult;
  forecastHighF: number;
  forecastProb: number;
  marketPrice: number;
  edge: number; // forecastProb - marketPrice (positive = underpriced)
  hoursToResolution: number;
  action: "BUY_YES" | "BUY_NO";
}

function pad(s: string, len: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, len - visible.length));
}

function colorEdge(edge: number): string {
  const pct = (edge * 100).toFixed(1);
  if (edge >= 0.15) return `${c.green}+${pct}%${c.reset}`;
  if (edge >= 0.05) return `${c.yellow}+${pct}%${c.reset}`;
  return `${c.dim}${pct}%${c.reset}`;
}

async function scan(minEdge: number = 0.10): Promise<Opportunity[]> {
  console.log(`${c.cyan}${c.bold}Scanning weather markets...${c.reset}\n`);

  const markets = await findWeatherMarkets({ daysAhead: 3, limit: 50 });
  console.log(`  Found ${c.bold}${markets.length}${c.reset} active weather markets\n`);

  if (markets.length === 0) {
    console.log(`${c.yellow}  No weather markets found. They may not be available right now.${c.reset}`);
    return [];
  }

  const opportunities: Opportunity[] = [];
  const seenCities = new Set<string>();

  for (const market of markets) {
    // Fetch forecast once per city
    let forecast: ForecastResult | null = null;
    if (!seenCities.has(market.city.toLowerCase())) {
      forecast = await fetchForecast(market.city, 3);
      seenCities.add(market.city.toLowerCase());
    } else {
      forecast = await fetchForecast(market.city, 3);
    }

    if (!forecast) {
      console.log(`  ${c.dim}Skipping ${market.city} — no forecast available${c.reset}`);
      continue;
    }

    // Find the matching day's forecast
    const dayForecast = forecast.forecasts.find(f => f.date === market.date);
    if (!dayForecast) {
      console.log(`  ${c.dim}Skipping ${market.city} ${market.date} — no forecast for that date${c.reset}`);
      continue;
    }

    const forecastHighF = market.type === "high" ? dayForecast.highF : dayForecast.lowF;
    const endDate = new Date(market.endDate);
    const hoursToResolution = Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60));

    console.log(`  ${c.bold}${market.city}${c.reset} ${market.date} (${market.type}) — Forecast: ${c.bold}${forecastHighF}°F${c.reset} (${hoursToResolution.toFixed(0)}h to resolution)`);

    // Evaluate each bracket
    for (const bracket of market.brackets) {
      const prob = bracketProbability(forecastHighF, bracket.lowF, bracket.highF, hoursToResolution);
      const marketPrice = bracket.outcomePrices[0]; // YES price

      // Check for BUY YES opportunity (market underpricing this bracket)
      const yesEdge = prob - marketPrice;
      if (yesEdge >= minEdge) {
        const opp: Opportunity = {
          market, bracket, forecast, forecastHighF, forecastProb: prob,
          marketPrice, edge: yesEdge, hoursToResolution, action: "BUY_YES",
        };
        opportunities.push(opp);

        const bracketStr = isFinite(bracket.lowF) && isFinite(bracket.highF)
          ? `${bracket.lowF}-${bracket.highF}°F`
          : isFinite(bracket.highF) ? `≤${bracket.highF}°F` : `≥${bracket.lowF}°F`;

        console.log(
          `    ${c.green}BUY YES${c.reset} ${pad(bracketStr, 14)} market=${(marketPrice * 100).toFixed(1)}% forecast=${(prob * 100).toFixed(1)}% edge=${colorEdge(yesEdge)}`
        );
      }

      // Check for BUY NO opportunity (market overpricing this bracket)
      const noEdge = (1 - prob) - bracket.outcomePrices[1];
      if (noEdge >= minEdge) {
        const opp: Opportunity = {
          market, bracket, forecast, forecastHighF, forecastProb: 1 - prob,
          marketPrice: bracket.outcomePrices[1], edge: noEdge, hoursToResolution, action: "BUY_NO",
        };
        opportunities.push(opp);

        const bracketStr = isFinite(bracket.lowF) && isFinite(bracket.highF)
          ? `${bracket.lowF}-${bracket.highF}°F`
          : isFinite(bracket.highF) ? `≤${bracket.highF}°F` : `≥${bracket.lowF}°F`;

        console.log(
          `    ${c.red}BUY NO${c.reset}  ${pad(bracketStr, 14)} market=${(bracket.outcomePrices[1] * 100).toFixed(1)}% forecast=${((1 - prob) * 100).toFixed(1)}% edge=${colorEdge(noEdge)}`
        );
      }
    }

    console.log("");
  }

  // Sort by edge
  opportunities.sort((a, b) => b.edge - a.edge);

  return opportunities;
}

function exportCSV(opportunities: Opportunity[]) {
  if (!existsSync(CSV_PATH) || require("fs").readFileSync(CSV_PATH, "utf-8").trim() === "") {
    writeFileSync(CSV_PATH, CSV_HEADER);
  }

  for (const opp of opportunities) {
    const bracketStr = isFinite(opp.bracket.lowF) && isFinite(opp.bracket.highF)
      ? `${opp.bracket.lowF}-${opp.bracket.highF}F`
      : isFinite(opp.bracket.highF) ? `<=${opp.bracket.highF}F` : `>=${opp.bracket.lowF}F`;

    const row = [
      new Date().toISOString(),
      opp.market.city,
      opp.market.date,
      opp.market.type,
      bracketStr,
      opp.marketPrice.toFixed(4),
      opp.forecastProb.toFixed(4),
      opp.edge.toFixed(4),
      opp.forecastHighF.toFixed(1),
      opp.hoursToResolution.toFixed(1),
      opp.bracket.slug,
    ].join(",") + "\n";

    appendFileSync(CSV_PATH, row);
  }
}

function printSummary(opportunities: Opportunity[]) {
  if (opportunities.length === 0) {
    console.log(`\n${c.yellow}  No opportunities found above edge threshold.${c.reset}\n`);
    return;
  }

  const divider = "─".repeat(78);
  console.log(`\n${c.dim}${divider}${c.reset}`);
  console.log(`${c.bold}  TOP OPPORTUNITIES${c.reset} (${opportunities.length} found)\n`);

  console.log(`  ${c.dim}${pad("City", 18)} ${pad("Date", 12)} ${pad("Bracket", 14)} ${pad("Action", 10)} ${pad("Market", 10)} ${pad("Forecast", 10)} ${pad("Edge", 10)} Hours${c.reset}`);

  for (const opp of opportunities.slice(0, 15)) {
    const bracketStr = isFinite(opp.bracket.lowF) && isFinite(opp.bracket.highF)
      ? `${opp.bracket.lowF}-${opp.bracket.highF}°F`
      : isFinite(opp.bracket.highF) ? `≤${opp.bracket.highF}°F` : `≥${opp.bracket.lowF}°F`;

    const actionColor = opp.action === "BUY_YES" ? c.green : c.red;

    console.log(
      `  ${pad(opp.market.city, 18)} ${pad(opp.market.date, 12)} ${pad(bracketStr, 14)} ${actionColor}${pad(opp.action, 10)}${c.reset} ${pad((opp.marketPrice * 100).toFixed(1) + "%", 10)} ${pad((opp.forecastProb * 100).toFixed(1) + "%", 10)} ${colorEdge(opp.edge)}  ${pad(opp.hoursToResolution.toFixed(0) + "h", 6)}`
    );
  }

  console.log(`${c.dim}${divider}${c.reset}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const edgeIdx = args.indexOf("--min-edge");
  const minEdge = edgeIdx >= 0 ? parseFloat(args[edgeIdx + 1]) : 0.10;
  const watchMode = args.includes("--watch");

  console.log(`
${c.cyan}${c.bold}  ╔═══════════════════════════════════════════╗
  ║    SATRIALES WEATHER MARKET SCANNER       ║
  ╚═════════════════════════════���═════════════╝${c.reset}

  ${c.dim}Min edge:${c.reset}  ${(minEdge * 100).toFixed(0)}%
  ${c.dim}Mode:${c.reset}      ${watchMode ? "Continuous (rescan every 5 min)" : "One-shot"}
  ${c.dim}Results:${c.reset}   results/weather-opportunities.csv
`);

  if (watchMode) {
    while (true) {
      const opps = await scan(minEdge);
      printSummary(opps);
      exportCSV(opps);
      console.log(`  ${c.dim}Next scan in 5 minutes...${c.reset}\n`);
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    }
  } else {
    const opps = await scan(minEdge);
    printSummary(opps);
    exportCSV(opps);
  }
}

main().catch(err => {
  console.error(`FATAL: ${err}`);
  process.exit(1);
});
