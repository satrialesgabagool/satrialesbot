/**
 * Discovers active weather temperature markets on Polymarket.
 *
 * Uses the Gamma API with tag_slug=temperature to find daily
 * temperature markets across 40+ cities. Each event contains
 * 10-12 bracket sub-markets (e.g. "78-79 F") that we evaluate.
 *
 * Key finding from research: only `tag_slug=temperature` works
 * reliably — the search/category/tag parameters are broken for
 * weather markets.
 */

import { fetchWithRetry } from "../net/fetchWithRetry";
import { lookupCity } from "./cities";
import type { WeatherMarket, TempBracket } from "./types";

const GAMMA_API = "https://gamma-api.polymarket.com";

// ─── Slug parsing ───────────────────────────────────────────────────

const MONTH_NAMES: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

function parseCityDate(slug: string): { city: string; date: string; type: "high" | "low" } | null {
  // "highest-temperature-in-nyc-on-april-17-2026"
  const match = slug.match(/(highest|lowest)-temperature-in-(.+?)-on-(.+)/);
  if (!match) return null;

  const type = match[1] === "highest" ? "high" : "low";
  const citySlug = match[2];
  const dateStr = match[3];

  const dateParts = dateStr.match(/(\w+)-(\d+)-(\d{4})/);
  if (!dateParts) return null;

  const month = MONTH_NAMES[dateParts[1].toLowerCase()];
  if (!month) return null;

  const day = dateParts[2].padStart(2, "0");
  const year = dateParts[3];

  // Look up city display name
  const cityInfo = lookupCity(citySlug);
  const cityName = cityInfo?.name ?? citySlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  return {
    city: cityName,
    date: `${year}-${month}-${day}`,
    type,
  };
}

// ─── Bracket parsing ────────────────────────────────────────────────

function parseBracket(question: string): { low: number; high: number; unit: "F" | "C" } | null {
  // "79°F or below" or "79 F or below"
  const belowF = question.match(/(\d+)\s*°?\s*F\s+or\s+below/i);
  if (belowF) return { low: -Infinity, high: parseInt(belowF[1]), unit: "F" };

  // "98°F or higher" or "98 F or higher"
  const aboveF = question.match(/(\d+)\s*°?\s*F\s+or\s+higher/i);
  if (aboveF) return { low: parseInt(aboveF[1]), high: Infinity, unit: "F" };

  // "80-81°F" or "80-81 F"
  const rangeF = question.match(/(\d+)-(\d+)\s*°?\s*F/i);
  if (rangeF) return { low: parseInt(rangeF[1]), high: parseInt(rangeF[2]), unit: "F" };

  // Celsius variants
  const belowC = question.match(/(\d+)\s*°?\s*C\s+or\s+below/i);
  if (belowC) return { low: -Infinity, high: parseInt(belowC[1]), unit: "C" };

  const aboveC = question.match(/(\d+)\s*°?\s*C\s+or\s+higher/i);
  if (aboveC) return { low: parseInt(aboveC[1]), high: Infinity, unit: "C" };

  const rangeC = question.match(/(\d+)-(\d+)\s*°?\s*C/i);
  if (rangeC) return { low: parseInt(rangeC[1]), high: parseInt(rangeC[2]), unit: "C" };

  // Single degree Celsius: "14°C" or "14 C"
  const singleC = question.match(/^(\d+)\s*°?\s*C$/i);
  if (singleC) {
    const val = parseInt(singleC[1]);
    return { low: val, high: val, unit: "C" };
  }

  return null;
}

// ─── Main discovery function ────────────────────────────────────────

/**
 * Find active weather temperature markets on Polymarket.
 *
 * Uses tag_slug=temperature (the ONLY reliable filter for weather markets).
 * Returns structured market data with parsed brackets, prices, and metadata.
 */
export async function findWeatherMarkets(options?: {
  city?: string;
  daysAhead?: number;
  type?: "high" | "low" | "both";
}): Promise<WeatherMarket[]> {
  const type = options?.type ?? "high"; // Focus on high temp (more volume)
  const results: WeatherMarket[] = [];

  try {
    // Fetch active temperature events from Gamma API
    // Note: tag_slug=daily-temperature returns all markets (50+ cities);
    // tag_slug=temperature only returns a small subset
    const url = `${GAMMA_API}/events?active=true&closed=false&tag_slug=daily-temperature&limit=200`;
    const res = await fetchWithRetry(url, {}, { maxRetries: 2, timeoutMs: 15000 });
    const events = await res.json();

    if (!Array.isArray(events)) return [];

    const now = new Date();
    const maxDate = new Date(now.getTime() + (options?.daysAhead ?? 3) * 24 * 60 * 60 * 1000);

    for (const event of events) {
      if (!event.slug?.includes("temperature")) continue;

      const parsed = parseCityDate(event.slug);
      if (!parsed) continue;

      // Filter by type
      if (type !== "both" && parsed.type !== type) continue;

      // Filter by city
      if (options?.city && !parsed.city.toLowerCase().includes(options.city.toLowerCase())) continue;

      // Filter by date range — include today's markets (still tradeable)
      // and exclude markets more than daysAhead in the future
      const marketDate = new Date(parsed.date + "T23:59:59Z");
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      if (marketDate < todayStart || marketDate > maxDate) continue;

      // Parse brackets from sub-markets
      const brackets: TempBracket[] = [];
      const markets = event.markets ?? [];

      for (const m of markets) {
        const bracketInfo = parseBracket(m.groupItemTitle ?? m.question ?? "");
        if (!bracketInfo) continue;

        const prices = m.outcomePrices ?? "[]";
        const parsedPrices = typeof prices === "string" ? JSON.parse(prices) : prices;
        const yesPrice = parseFloat(parsedPrices[0]) || 0;
        const noPrice = parseFloat(parsedPrices[1]) || 0;

        brackets.push({
          question: m.question ?? "",
          slug: m.slug ?? "",
          conditionId: m.conditionId ?? "",
          marketId: m.id ?? "",
          clobTokenIds: m.clobTokenIds ?? ["", ""],
          outcomePrices: [yesPrice, noPrice],
          lowTemp: bracketInfo.low,
          highTemp: bracketInfo.high,
          unit: bracketInfo.unit,
          endDate: m.endDate ?? event.endDate ?? "",
          volume: parseFloat(m.volume ?? "0"),
          liquidity: parseFloat(m.liquidity ?? "0"),
          groupItemTitle: m.groupItemTitle ?? "",
        });
      }

      // Sort brackets by lower bound
      brackets.sort((a, b) => {
        const aLow = isFinite(a.lowTemp) ? a.lowTemp : -999;
        const bLow = isFinite(b.lowTemp) ? b.lowTemp : -999;
        return aLow - bLow;
      });

      if (brackets.length === 0) continue;

      results.push({
        eventId: String(event.id),
        title: event.title ?? "",
        slug: event.slug,
        city: parsed.city,
        date: parsed.date,
        endDate: event.endDate ?? "",
        brackets,
        unit: brackets[0].unit,
        type: parsed.type,
        negRiskMarketId: event.negRiskMarketID ?? "",
      });
    }
  } catch (error) {
    console.error("[WeatherMarketFinder] Error:", error);
  }

  // Sort by date (soonest first)
  results.sort((a, b) => a.date.localeCompare(b.date));

  return results;
}

/**
 * Fetch a single weather event by slug.
 */
export async function fetchWeatherEvent(slug: string): Promise<WeatherMarket | null> {
  try {
    const url = `${GAMMA_API}/events?slug=${slug}&limit=1`;
    const res = await fetchWithRetry(url, {}, { maxRetries: 2, timeoutMs: 10000 });
    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    const event = events[0];
    const parsed = parseCityDate(event.slug);
    if (!parsed) return null;

    const brackets: TempBracket[] = [];
    for (const m of event.markets ?? []) {
      const bracketInfo = parseBracket(m.groupItemTitle ?? m.question ?? "");
      if (!bracketInfo) continue;

      const prices = m.outcomePrices ?? "[]";
      const parsedPrices = typeof prices === "string" ? JSON.parse(prices) : prices;
      const yesPrice = parseFloat(parsedPrices[0]) || 0;
      const noPrice = parseFloat(parsedPrices[1]) || 0;

      brackets.push({
        question: m.question ?? "",
        slug: m.slug ?? "",
        conditionId: m.conditionId ?? "",
        marketId: m.id ?? "",
        clobTokenIds: m.clobTokenIds ?? ["", ""],
        outcomePrices: [yesPrice, noPrice],
        lowTemp: bracketInfo.low,
        highTemp: bracketInfo.high,
        unit: bracketInfo.unit,
        endDate: m.endDate ?? event.endDate ?? "",
        volume: parseFloat(m.volume ?? "0"),
        liquidity: parseFloat(m.liquidity ?? "0"),
        groupItemTitle: m.groupItemTitle ?? "",
      });
    }

    brackets.sort((a, b) => {
      const aLow = isFinite(a.lowTemp) ? a.lowTemp : -999;
      const bLow = isFinite(b.lowTemp) ? b.lowTemp : -999;
      return aLow - bLow;
    });

    return {
      eventId: String(event.id),
      title: event.title ?? "",
      slug: event.slug,
      city: parsed.city,
      date: parsed.date,
      endDate: event.endDate ?? "",
      brackets,
      unit: brackets[0]?.unit ?? "F",
      type: parsed.type,
      negRiskMarketId: event.negRiskMarketID ?? "",
    };
  } catch {
    return null;
  }
}
