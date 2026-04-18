/**
 * Paid / key-required weather source registry.
 *
 * The existing `src/weather/WeatherEnsemble.ts` already fetches
 * Open-Meteo (best_match + ECMWF + GFS) and NOAA NWS for free. We
 * treat those as the "free tier" and layer these additional sources
 * on top when their keys are configured.
 */

import { OpenWeatherSource } from "./OpenWeather";
import { TomorrowSource } from "./Tomorrow";
import { VisualCrossingSource } from "./VisualCrossing";
import { WeatherAPISource } from "./WeatherAPI";
import { PirateWeatherSource } from "./PirateWeather";
import type { ForecastSource } from "./types";

export function loadPaidSources(env: Record<string, string | undefined> = process.env): ForecastSource[] {
  return [
    new OpenWeatherSource(env.OPENWEATHER_API_KEY),
    new TomorrowSource(env.TOMORROW_API_KEY),
    new VisualCrossingSource(env.VISUALCROSSING_API_KEY),
    new WeatherAPISource(env.WEATHERAPI_API_KEY),
    new PirateWeatherSource(env.PIRATEWEATHER_API_KEY),
  ];
}

export * from "./types";
