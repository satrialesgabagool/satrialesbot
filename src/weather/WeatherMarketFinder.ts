import { fetchWithRetry } from "../net/fetchWithRetry";

/**
 * Discovers active weather temperature markets on Polymarket.
 *
 * Markets are structured as events with multiple bracket sub-markets:
 * - "Highest temperature in NYC on April 15?" → 11 brackets (79°F or below, 80-81°F, etc.)
 * - Each bracket is a binary Yes/No market with its own token IDs
 * - Resolves via Weather Underground station data
 */

const GAMMA_API = "https://gamma-api.polymarket.com";

export interface TempBracket {
  question: string;
  slug: string;
  conditionId: string;
  clobTokenIds: [string, string]; // [YES token, NO token]
  outcomePrices: [number, number]; // [YES price, NO price]
  lowF: number; // Lower bound in Fahrenheit
  highF: number; // Upper bound in Fahrenheit (-1 for "or below", Infinity for "or higher")
  lowC: number; // Lower bound in Celsius
  highC: number; // Upper bound in Celsius
  endDate: string;
  volume: number;
  liquidity: number;
}

export interface WeatherMarket {
  eventId: string;
  title: string;
  slug: string;
  city: string;
  date: string; // YYYY-MM-DD
  endDate: string;
  brackets: TempBracket[];
  unit: "F" | "C";
  type: "high" | "low";
}

// Parse temperature range from question text
function parseBracket(question: string, slug: string): { low: number; high: number; unit: "F" | "C" } | null {
  // "79°F or below" / "79forbelow"
  const belowMatch = question.match(/(\d+)°([FC])\s+or\s+below/i);
  if (belowMatch) {
    return { low: -Infinity, high: parseInt(belowMatch[1]), unit: belowMatch[2] as "F" | "C" };
  }

  // "98°F or higher" / "98forhigher"
  const aboveMatch = question.match(/(\d+)°([FC])\s+or\s+higher/i);
  if (aboveMatch) {
    return { low: parseInt(aboveMatch[1]), high: Infinity, unit: aboveMatch[2] as "F" | "C" };
  }

  // "80-81°F" or "between 80-81°F"
  const rangeMatch = question.match(/(\d+)-(\d+)°([FC])/i);
  if (rangeMatch) {
    return { low: parseInt(rangeMatch[1]), high: parseInt(rangeMatch[2]), unit: rangeMatch[3] as "F" | "C" };
  }

  // Celsius: "20°C or below", "32°C or higher", "20-21°C"
  const celsiusBelowMatch = question.match(/(\d+)°C\s+or\s+below/i);
  if (celsiusBelowMatch) {
    return { low: -Infinity, high: parseInt(celsiusBelowMatch[1]), unit: "C" };
  }

  const celsiusAboveMatch = question.match(/(\d+)°C\s+or\s+higher/i);
  if (celsiusAboveMatch) {
    return { low: parseInt(celsiusAboveMatch[1]), high: Infinity, unit: "C" };
  }

  return null;
}

function fToC(f: number): number {
  if (!isFinite(f)) return f;
  return Math.round(((f - 32) * 5) / 9 * 10) / 10;
}

function cToF(c: number): number {
  if (!isFinite(c)) return c;
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

// Parse city and date from event slug
function parseCityDate(slug: string): { city: string; date: string; type: "high" | "low" } | null {
  // "highest-temperature-in-nyc-on-april-15-2026"
  // "lowest-temperature-in-seoul-on-april-15-2026"
  const match = slug.match(/(highest|lowest)-temperature-in-(.+?)-on-(.+)/);
  if (!match) return null;

  const type = match[1] === "highest" ? "high" : "low";
  const citySlug = match[2];
  const dateStr = match[3]; // "april-15-2026"

  // Convert date
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };

  const dateParts = dateStr.match(/(\w+)-(\d+)-(\d{4})/);
  if (!dateParts) return null;

  const month = months[dateParts[1].toLowerCase()];
  const day = dateParts[2].padStart(2, "0");
  const year = dateParts[3];

  // Convert city slug to display name
  const cityMap: Record<string, string> = {
    nyc: "New York City",
    atlanta: "Atlanta",
    dallas: "Dallas",
    seattle: "Seattle",
    london: "London",
    paris: "Paris",
    tokyo: "Tokyo",
    seoul: "Seoul",
    beijing: "Beijing",
    shanghai: "Shanghai",
    "hong-kong": "Hong Kong",
    taipei: "Taipei",
    toronto: "Toronto",
    "mexico-city": "Mexico City",
    madrid: "Madrid",
    ankara: "Ankara",
    wellington: "Wellington",
  };

  return {
    city: cityMap[citySlug] ?? citySlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
    date: `${year}-${month}-${day}`,
    type,
  };
}

// Known cities on Polymarket weather markets
const KNOWN_CITIES = [
  "nyc", "atlanta", "dallas", "seattle", "london", "paris", "tokyo",
  "seoul", "beijing", "shanghai", "hong-kong", "taipei", "toronto",
  "mexico-city", "madrid", "ankara", "wellington",
];

const MONTH_NAMES = [
  "", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function buildSlugs(daysAhead: number, types: ("highest" | "lowest")[]): string[] {
  const slugs: string[] = [];
  const now = new Date();

  for (let d = 0; d <= daysAhead; d++) {
    const date = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const month = MONTH_NAMES[date.getMonth() + 1];
    const day = date.getDate();
    const year = date.getFullYear();
    const dateStr = `${month}-${day}-${year}`;

    for (const type of types) {
      for (const city of KNOWN_CITIES) {
        slugs.push(`${type}-temperature-in-${city}-on-${dateStr}`);
      }
    }
  }

  return slugs;
}

export async function findWeatherMarkets(options?: {
  city?: string;
  daysAhead?: number;
  limit?: number;
}): Promise<WeatherMarket[]> {
  const daysAhead = options?.daysAhead ?? 2;
  const slugs = buildSlugs(daysAhead, ["highest", "lowest"]);

  const results: WeatherMarket[] = [];

  // Fetch in parallel batches of 10
  for (let i = 0; i < slugs.length; i += 10) {
    const batch = slugs.slice(i, i + 10);
    const promises = batch.map(async (slug) => {
      try {
        const url = `${GAMMA_API}/events?closed=false&limit=1&slug=${slug}`;
        const res = await fetchWithRetry(url, {}, { timeoutMs: 10_000 });
        const events = await res.json();
        if (!Array.isArray(events) || events.length === 0) return null;
        const event = events[0];
        if (!event.slug?.includes("temperature")) return null;
        return event;
      } catch { return null; }
    });

    const eventResults = await Promise.all(promises);

    for (const event of eventResults) {
      if (!event) continue;
        const parsed = parseCityDate(event.slug);
        if (!parsed) continue;

      // Filter by city if specified
      if (options?.city && !parsed.city.toLowerCase().includes(options.city.toLowerCase())) continue;

      const brackets: TempBracket[] = [];
      const markets = event.markets ?? [];

      for (const m of markets) {
        const bracket = parseBracket(m.question ?? "", m.slug ?? "");
        if (!bracket) continue;

        const prices = (m.outcomePrices ?? "[]");
        const parsedPrices = typeof prices === "string" ? JSON.parse(prices) : prices;

        const yesPrice = parseFloat(parsedPrices[0]) || 0;
        const noPrice = parseFloat(parsedPrices[1]) || 0;

        const lowF = bracket.unit === "F" ? bracket.low : cToF(bracket.low);
        const highF = bracket.unit === "F" ? bracket.high : cToF(bracket.high);
        const lowC = bracket.unit === "C" ? bracket.low : fToC(bracket.low);
        const highC = bracket.unit === "C" ? bracket.high : fToC(bracket.high);

        brackets.push({
          question: m.question,
          slug: m.slug,
          conditionId: m.conditionId,
          clobTokenIds: m.clobTokenIds ?? ["", ""],
          outcomePrices: [yesPrice, noPrice],
          lowF,
          highF,
          lowC,
          highC,
          endDate: m.endDate ?? event.endDate,
          volume: parseFloat(m.volume ?? "0"),
          liquidity: parseFloat(m.liquidity ?? "0"),
        });
      }

      // Sort brackets by lower bound
      brackets.sort((a, b) => {
        const aLow = isFinite(a.lowF) ? a.lowF : -999;
        const bLow = isFinite(b.lowF) ? b.lowF : -999;
        return aLow - bLow;
      });

      results.push({
        eventId: String(event.id),
        title: event.title,
        slug: event.slug,
        city: parsed.city,
        date: parsed.date,
        endDate: event.endDate,
        brackets,
        unit: brackets.length > 0 && brackets[0].highC < 60 ? "C" : "F",
        type: parsed.type,
      });
    }
  }

  return results;
}
