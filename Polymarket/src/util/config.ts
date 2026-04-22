export type TickerSource = "polymarket" | "binance" | "coinbase";
export type MarketWindow = "5m" | "15m";

export interface Config {
  BTC_TICKER: TickerSource[];
  MARKET_WINDOW: MarketWindow;
  PROD: boolean;
  PRIVATE_KEY: string;
  POLY_FUNDER_ADDRESS: string;
  WALLET_BALANCE: number;
  MAX_SESSION_LOSS: number;
  FORCE_PROD: boolean;
}

const defaults: Config = {
  BTC_TICKER: ["binance", "coinbase"],
  MARKET_WINDOW: "5m",
  PROD: false,
  PRIVATE_KEY: "",
  POLY_FUNDER_ADDRESS: "",
  WALLET_BALANCE: 50,
  MAX_SESSION_LOSS: 50,
  FORCE_PROD: false,
};

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (!val) return fallback;
  return val.toLowerCase() === "true" || val === "1";
}

function parseNumber(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = Number(val);
  return Number.isNaN(n) ? fallback : n;
}

function parseTickers(val: string | undefined, fallback: TickerSource[]): TickerSource[] {
  if (!val) return fallback;
  const valid: TickerSource[] = ["polymarket", "binance", "coinbase"];
  return val
    .split(",")
    .map((s) => s.trim().toLowerCase() as TickerSource)
    .filter((s) => valid.includes(s));
}

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  _config = {
    BTC_TICKER: parseTickers(process.env.BTC_TICKER, defaults.BTC_TICKER),
    MARKET_WINDOW: (process.env.MARKET_WINDOW as MarketWindow) || defaults.MARKET_WINDOW,
    PROD: parseBoolean(process.env.PROD, defaults.PROD),
    PRIVATE_KEY: process.env.PRIVATE_KEY || defaults.PRIVATE_KEY,
    POLY_FUNDER_ADDRESS: process.env.POLY_FUNDER_ADDRESS || defaults.POLY_FUNDER_ADDRESS,
    WALLET_BALANCE: parseNumber(process.env.WALLET_BALANCE, defaults.WALLET_BALANCE),
    MAX_SESSION_LOSS: parseNumber(process.env.MAX_SESSION_LOSS, defaults.MAX_SESSION_LOSS),
    FORCE_PROD: parseBoolean(process.env.FORCE_PROD, defaults.FORCE_PROD),
  };

  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}

export function setProd(value: boolean): void {
  const cfg = getConfig();
  cfg.PROD = value;
}
