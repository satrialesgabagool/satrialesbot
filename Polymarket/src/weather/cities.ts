/**
 * City coordinates for weather forecasts.
 *
 * IMPORTANT: We use weather station coordinates that match Polymarket's
 * resolution source (Weather Underground), NOT city center coordinates.
 * e.g. NYC resolves off LaGuardia Airport (KLGA), not Times Square.
 *
 * This eliminates a ~0.5-1.0 F systematic bias that would occur
 * from using city-center coordinates (urban heat island effect).
 */

export interface CityInfo {
  name: string; // Display name
  slugName: string; // Used in Polymarket slugs
  lat: number;
  lon: number;
  timezone: string;
  country: "US" | "INT";
  unit: "F" | "C"; // Temperature unit on Polymarket
  station: string; // Weather Underground station ID
}

// Polymarket resolution sources from market descriptions
export const CITIES: Record<string, CityInfo> = {
  // US cities — Fahrenheit, 2°F brackets
  "nyc": {
    name: "New York City",
    slugName: "nyc",
    lat: 40.7769,
    lon: -73.8740,
    timezone: "America/New_York",
    country: "US",
    unit: "F",
    station: "KLGA", // LaGuardia Airport
  },
  "chicago": {
    name: "Chicago",
    slugName: "chicago",
    lat: 41.9742,
    lon: -87.9073,
    timezone: "America/Chicago",
    country: "US",
    unit: "F",
    station: "KORD", // O'Hare
  },
  "dallas": {
    name: "Dallas",
    slugName: "dallas",
    lat: 32.8998,
    lon: -97.0403,
    timezone: "America/Chicago",
    country: "US",
    unit: "F",
    station: "KDFW", // DFW Airport
  },
  "atlanta": {
    name: "Atlanta",
    slugName: "atlanta",
    lat: 33.6407,
    lon: -84.4277,
    timezone: "America/New_York",
    country: "US",
    unit: "F",
    station: "KATL", // Hartsfield-Jackson
  },
  "miami": {
    name: "Miami",
    slugName: "miami",
    lat: 25.7959,
    lon: -80.2870,
    timezone: "America/New_York",
    country: "US",
    unit: "F",
    station: "KMIA", // Miami International
  },
  "seattle": {
    name: "Seattle",
    slugName: "seattle",
    lat: 47.4502,
    lon: -122.3088,
    timezone: "America/Los_Angeles",
    country: "US",
    unit: "F",
    station: "KSEA", // Sea-Tac
  },
  "los-angeles": {
    name: "Los Angeles",
    slugName: "los-angeles",
    lat: 33.9425,
    lon: -118.4081,
    timezone: "America/Los_Angeles",
    country: "US",
    unit: "F",
    station: "KLAX", // LAX
  },
  "san-francisco": {
    name: "San Francisco",
    slugName: "san-francisco",
    lat: 37.6213,
    lon: -122.3790,
    timezone: "America/Los_Angeles",
    country: "US",
    unit: "F",
    station: "KSFO", // SFO
  },
  "austin": {
    name: "Austin",
    slugName: "austin",
    lat: 30.1975,
    lon: -97.6664,
    timezone: "America/Chicago",
    country: "US",
    unit: "F",
    station: "KAUS", // Austin-Bergstrom
  },
  "denver": {
    name: "Denver",
    slugName: "denver",
    lat: 39.8561,
    lon: -104.6737,
    timezone: "America/Denver",
    country: "US",
    unit: "F",
    station: "KDEN", // Denver International
  },
  "houston": {
    name: "Houston",
    slugName: "houston",
    lat: 29.9902,
    lon: -95.3368,
    timezone: "America/Chicago",
    country: "US",
    unit: "F",
    station: "KIAH", // George Bush Intercontinental
  },
  // International cities — Celsius, 1°C brackets
  "london": {
    name: "London",
    slugName: "london",
    lat: 51.4700,
    lon: -0.4543,
    timezone: "Europe/London",
    country: "INT",
    unit: "C",
    station: "EGLL", // Heathrow
  },
  "paris": {
    name: "Paris",
    slugName: "paris",
    lat: 49.0097,
    lon: 2.5479,
    timezone: "Europe/Paris",
    country: "INT",
    unit: "C",
    station: "LFPG", // Charles de Gaulle
  },
  "tokyo": {
    name: "Tokyo",
    slugName: "tokyo",
    lat: 35.5494,
    lon: 139.7798,
    timezone: "Asia/Tokyo",
    country: "INT",
    unit: "C",
    station: "RJTT", // Haneda
  },
  "seoul": {
    name: "Seoul",
    slugName: "seoul",
    lat: 37.5665,
    lon: 126.9780,
    timezone: "Asia/Seoul",
    country: "INT",
    unit: "C",
    station: "RKSI", // Incheon
  },
  "beijing": {
    name: "Beijing",
    slugName: "beijing",
    lat: 40.0799,
    lon: 116.6031,
    timezone: "Asia/Shanghai",
    country: "INT",
    unit: "C",
    station: "ZBAA", // Beijing Capital
  },
  "shanghai": {
    name: "Shanghai",
    slugName: "shanghai",
    lat: 31.1443,
    lon: 121.8083,
    timezone: "Asia/Shanghai",
    country: "INT",
    unit: "C",
    station: "ZSPD", // Pudong
  },
  "hong-kong": {
    name: "Hong Kong",
    slugName: "hong-kong",
    lat: 22.3080,
    lon: 113.9185,
    timezone: "Asia/Hong_Kong",
    country: "INT",
    unit: "C",
    station: "VHHH", // Hong Kong International
  },
  "taipei": {
    name: "Taipei",
    slugName: "taipei",
    lat: 25.0777,
    lon: 121.2328,
    timezone: "Asia/Taipei",
    country: "INT",
    unit: "C",
    station: "RCTP", // Taoyuan
  },
  "toronto": {
    name: "Toronto",
    slugName: "toronto",
    lat: 43.6777,
    lon: -79.6248,
    timezone: "America/Toronto",
    country: "INT",
    unit: "C",
    station: "CYYZ", // Pearson
  },
  "mexico-city": {
    name: "Mexico City",
    slugName: "mexico-city",
    lat: 19.4363,
    lon: -99.0721,
    timezone: "America/Mexico_City",
    country: "INT",
    unit: "C",
    station: "MMMX", // Benito Juarez
  },
  "madrid": {
    name: "Madrid",
    slugName: "madrid",
    lat: 40.4936,
    lon: -3.5668,
    timezone: "Europe/Madrid",
    country: "INT",
    unit: "C",
    station: "LEMD", // Barajas
  },
  "ankara": {
    name: "Ankara",
    slugName: "ankara",
    lat: 40.1281,
    lon: 32.9951,
    timezone: "Europe/Istanbul",
    country: "INT",
    unit: "C",
    station: "LTAC", // Esenboga
  },
  // Additional international cities on Polymarket
  "amsterdam": {
    name: "Amsterdam", slugName: "amsterdam",
    lat: 52.3080, lon: 4.7642, timezone: "Europe/Amsterdam", country: "INT", unit: "C", station: "EHAM",
  },
  "buenos-aires": {
    name: "Buenos Aires", slugName: "buenos-aires",
    lat: -34.5592, lon: -58.4156, timezone: "America/Argentina/Buenos_Aires", country: "INT", unit: "C", station: "SAEZ",
  },
  "busan": {
    name: "Busan", slugName: "busan",
    lat: 35.1796, lon: 128.9382, timezone: "Asia/Seoul", country: "INT", unit: "C", station: "RKPK",
  },
  "cape-town": {
    name: "Cape Town", slugName: "cape-town",
    lat: -33.9715, lon: 18.6021, timezone: "Africa/Johannesburg", country: "INT", unit: "C", station: "FACT",
  },
  "chengdu": {
    name: "Chengdu", slugName: "chengdu",
    lat: 30.5728, lon: 103.9500, timezone: "Asia/Shanghai", country: "INT", unit: "C", station: "ZUUU",
  },
  "chongqing": {
    name: "Chongqing", slugName: "chongqing",
    lat: 29.7192, lon: 106.6414, timezone: "Asia/Shanghai", country: "INT", unit: "C", station: "ZUCK",
  },
  "guangzhou": {
    name: "Guangzhou", slugName: "guangzhou",
    lat: 23.3924, lon: 113.2988, timezone: "Asia/Shanghai", country: "INT", unit: "C", station: "ZGGG",
  },
  "helsinki": {
    name: "Helsinki", slugName: "helsinki",
    lat: 60.3172, lon: 24.9633, timezone: "Europe/Helsinki", country: "INT", unit: "C", station: "EFHK",
  },
  "istanbul": {
    name: "Istanbul", slugName: "istanbul",
    lat: 41.2753, lon: 28.7519, timezone: "Europe/Istanbul", country: "INT", unit: "C", station: "LTFM",
  },
  "jakarta": {
    name: "Jakarta", slugName: "jakarta",
    lat: -6.1256, lon: 106.6558, timezone: "Asia/Jakarta", country: "INT", unit: "C", station: "WIII",
  },
  "jeddah": {
    name: "Jeddah", slugName: "jeddah",
    lat: 21.6796, lon: 39.1564, timezone: "Asia/Riyadh", country: "INT", unit: "C", station: "OEJN",
  },
  "karachi": {
    name: "Karachi", slugName: "karachi",
    lat: 24.9065, lon: 67.1609, timezone: "Asia/Karachi", country: "INT", unit: "C", station: "OPKC",
  },
  "kuala-lumpur": {
    name: "Kuala Lumpur", slugName: "kuala-lumpur",
    lat: 2.7456, lon: 101.7072, timezone: "Asia/Kuala_Lumpur", country: "INT", unit: "C", station: "WMKK",
  },
  "lagos": {
    name: "Lagos", slugName: "lagos",
    lat: 6.5774, lon: 3.3212, timezone: "Africa/Lagos", country: "INT", unit: "C", station: "DNMM",
  },
  "lucknow": {
    name: "Lucknow", slugName: "lucknow",
    lat: 26.7606, lon: 80.8893, timezone: "Asia/Kolkata", country: "INT", unit: "C", station: "VILK",
  },
  "manila": {
    name: "Manila", slugName: "manila",
    lat: 14.5086, lon: 121.0194, timezone: "Asia/Manila", country: "INT", unit: "C", station: "RPLL",
  },
  "milan": {
    name: "Milan", slugName: "milan",
    lat: 45.6306, lon: 8.7281, timezone: "Europe/Rome", country: "INT", unit: "C", station: "LIMC",
  },
  "moscow": {
    name: "Moscow", slugName: "moscow",
    lat: 55.9726, lon: 37.4146, timezone: "Europe/Moscow", country: "INT", unit: "C", station: "UUEE",
  },
  "munich": {
    name: "Munich", slugName: "munich",
    lat: 48.3538, lon: 11.7861, timezone: "Europe/Berlin", country: "INT", unit: "C", station: "EDDM",
  },
  "panama-city": {
    name: "Panama City", slugName: "panama-city",
    lat: 9.0714, lon: -79.3835, timezone: "America/Panama", country: "INT", unit: "C", station: "MPTO",
  },
  "sao-paulo": {
    name: "Sao Paulo", slugName: "sao-paulo",
    lat: -23.4356, lon: -46.4731, timezone: "America/Sao_Paulo", country: "INT", unit: "C", station: "SBGR",
  },
  "shenzhen": {
    name: "Shenzhen", slugName: "shenzhen",
    lat: 22.6394, lon: 113.8107, timezone: "Asia/Shanghai", country: "INT", unit: "C", station: "ZGSZ",
  },
  "singapore": {
    name: "Singapore", slugName: "singapore",
    lat: 1.3502, lon: 103.9940, timezone: "Asia/Singapore", country: "INT", unit: "C", station: "WSSS",
  },
  "tel-aviv": {
    name: "Tel Aviv", slugName: "tel-aviv",
    lat: 32.0055, lon: 34.8854, timezone: "Asia/Jerusalem", country: "INT", unit: "C", station: "LLBG",
  },
  "warsaw": {
    name: "Warsaw", slugName: "warsaw",
    lat: 52.1657, lon: 20.9671, timezone: "Europe/Warsaw", country: "INT", unit: "C", station: "EPWA",
  },
  "wuhan": {
    name: "Wuhan", slugName: "wuhan",
    lat: 30.7838, lon: 114.2081, timezone: "Asia/Shanghai", country: "INT", unit: "C", station: "ZHHH",
  },
  "wellington": {
    name: "Wellington",
    slugName: "wellington",
    lat: -41.3276,
    lon: 174.8050,
    timezone: "Pacific/Auckland",
    country: "INT",
    unit: "C",
    station: "NZWN", // Wellington Airport
  },
};

/**
 * Look up a city by its Polymarket slug component.
 * Handles aliases: "new-york-city" → "nyc", "los angeles" → "los-angeles", etc.
 */
export function lookupCity(slugOrName: string): CityInfo | null {
  const key = slugOrName.toLowerCase().replace(/\s+/g, "-");

  // Direct match
  if (CITIES[key]) return CITIES[key];

  // Alias map
  const aliases: Record<string, string> = {
    "new-york-city": "nyc",
    "new-york": "nyc",
    "la": "los-angeles",
    "sf": "san-francisco",
    "hk": "hong-kong",
    "hongkong": "hong-kong",
    "cdmx": "mexico-city",
  };

  if (aliases[key] && CITIES[aliases[key]]) return CITIES[aliases[key]];

  // Fuzzy: check if slug contains any city key
  for (const [k, info] of Object.entries(CITIES)) {
    if (key.includes(k) || k.includes(key)) return info;
  }

  return null;
}
