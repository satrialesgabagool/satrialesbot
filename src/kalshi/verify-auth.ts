#!/usr/bin/env bun
/**
 * Kalshi Auth Verifier (Stage 1: read-only live auth check)
 *
 * Proves the API key + RSA private key are wired correctly by:
 *   1. Reading credentials from environment variables
 *   2. Calling GET /portfolio/balance (authenticated)
 *   3. Calling GET /portfolio/positions (authenticated)
 *   4. Printing a summary — no orders are placed
 *
 * Required env vars:
 *   KALSHI_API_KEY_ID            — your API key UUID
 *   KALSHI_PRIVATE_KEY_PATH      — path to RSA private key PEM
 *     OR
 *   KALSHI_PRIVATE_KEY_PEM       — PEM contents inline
 *
 * Usage:
 *   bun run src/kalshi/verify-auth.ts
 *   bun run src/kalshi/verify-auth.ts --demo    (use demo environment)
 *
 * This tool NEVER logs the API key or the private key. It prints only
 * what the server returns (balance, positions, portfolio health).
 */

import { loadCredentialsFromEnv } from "./KalshiAuth";
import { KalshiClient } from "./KalshiClient";

const args = process.argv.slice(2);
const USE_DEMO = args.includes("--demo");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

function line(s: string = "") { console.log(s); }
function err(s: string): never { console.error(`${c.red}${s}${c.reset}`); process.exit(1); }

async function main() {
  line(`${c.blue}${c.bold}`);
  line("  ╔═════════════════════════════════════════╗");
  line("  ║   KALSHI AUTH VERIFIER (read-only)      ║");
  line("  ╚═════════════════════════════════════════╝");
  line(`${c.reset}`);

  line(`  ${c.dim}Environment:${c.reset}   ${USE_DEMO ? c.yellow + "DEMO" : c.green + "PRODUCTION"}${c.reset}`);

  // 1. Load credentials (checks env vars — does not print them)
  const creds = loadCredentialsFromEnv();
  if (!creds) {
    line();
    line(`${c.red}  ✗ Missing credentials.${c.reset}`);
    line();
    line(`  ${c.dim}Set these env vars:${c.reset}`);
    line(`    ${c.cyan}KALSHI_API_KEY_ID${c.reset}           (your API key UUID)`);
    line(`    ${c.cyan}KALSHI_PRIVATE_KEY_PATH${c.reset}     (path to RSA PEM)`);
    line(`    ${c.dim}or${c.reset}`);
    line(`    ${c.cyan}KALSHI_PRIVATE_KEY_PEM${c.reset}      (PEM contents inline)`);
    process.exit(1);
  }

  // Confirm presence without printing the secrets themselves
  const keyIdLen = creds.apiKeyId.length;
  const pemLen = creds.privateKeyPem.length;
  const isValidPem = creds.privateKeyPem.includes("BEGIN") && creds.privateKeyPem.includes("END");

  line(`  ${c.dim}API Key ID:${c.reset}    ${c.green}✓ loaded${c.reset} ${c.dim}(${keyIdLen} chars)${c.reset}`);
  line(`  ${c.dim}Private Key:${c.reset}   ${isValidPem ? c.green + "✓ PEM format OK" : c.red + "✗ not PEM-formatted"}${c.reset} ${c.dim}(${pemLen} bytes)${c.reset}`);

  if (!isValidPem) {
    err("\n  Private key does not look like a PEM file. Check that it has BEGIN/END markers.");
  }

  line();

  // 2. Create client
  const client = new KalshiClient({ demo: USE_DEMO, credentials: creds });

  // 3. Check balance (authenticated endpoint)
  line(`${c.cyan}  → Fetching portfolio balance...${c.reset}`);
  try {
    const balance = await client.getBalance();
    const balanceUSD = (balance.balance ?? 0) / 100;       // Kalshi cents → dollars
    const portfolioUSD = (balance.portfolio_value ?? 0) / 100;

    line(`  ${c.dim}Cash balance:${c.reset}       ${c.bold}$${balanceUSD.toFixed(2)}${c.reset}`);
    line(`  ${c.dim}Portfolio value:${c.reset}    ${c.bold}$${portfolioUSD.toFixed(2)}${c.reset}`);
    line(`  ${c.dim}Total equity:${c.reset}       ${c.bold}${c.green}$${(balanceUSD + portfolioUSD).toFixed(2)}${c.reset}`);
  } catch (e: any) {
    line(`  ${c.red}✗ Balance fetch failed:${c.reset} ${e.message}`);
    if (e.message?.includes("401") || e.message?.includes("403")) {
      line(`  ${c.yellow}→ auth rejected. Check the API Key ID and PEM file match.${c.reset}`);
    }
    process.exit(1);
  }

  line();

  // 4. Check positions (authenticated endpoint)
  line(`${c.cyan}  → Fetching open positions...${c.reset}`);
  try {
    const { market_positions = [], event_positions = [] } = await client.getPositions({ limit: 200 });

    if (market_positions.length === 0) {
      line(`  ${c.dim}No open positions.${c.reset}`);
    } else {
      line(`  ${c.bold}${market_positions.length} open position(s):${c.reset}`);
      for (const p of market_positions.slice(0, 10)) {
        const shares = (p as any).position ?? 0;
        const avgPx = (p as any).average_price_dollars ?? "?";
        const ticker = (p as any).ticker ?? "?";
        line(`    ${c.dim}•${c.reset} ${ticker.padEnd(36)} ${shares} shares @ ${avgPx}`);
      }
      if (market_positions.length > 10) {
        line(`    ${c.dim}(+ ${market_positions.length - 10} more)${c.reset}`);
      }
    }

    if (event_positions.length > 0) {
      line();
      line(`  ${c.dim}${event_positions.length} event-level position summaries${c.reset}`);
    }
  } catch (e: any) {
    line(`  ${c.red}✗ Positions fetch failed:${c.reset} ${e.message}`);
    process.exit(1);
  }

  line();
  line(`${c.green}${c.bold}  ✓ AUTH VERIFIED${c.reset}`);
  line(`  ${c.dim}Ready for Stage 2 (demo env order placement test) when you are.${c.reset}`);
  line();
}

main().catch((e) => {
  console.error(`${c.red}Unexpected error:${c.reset}`, e?.message ?? e);
  process.exit(1);
});
