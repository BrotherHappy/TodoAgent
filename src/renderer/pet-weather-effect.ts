import type { WeatherSnapshot } from "../shared/pet-types";

export type PetWeatherEffect = "rain" | "snow" | "storm";

/**
 * Maps structured provider weather codes to one small, static companion cue.
 * Unknown or clear conditions deliberately produce no decoration: the pet
 * should never invent an environmental state from a label or model text.
 */
export function petWeatherEffectFor(
  weather: WeatherSnapshot | undefined,
): PetWeatherEffect | undefined {
  if (!weather) return undefined;
  if (weather.severe || [95, 96, 99].includes(weather.conditionCode)) return "storm";
  if ([71, 73, 75, 77, 85, 86].includes(weather.conditionCode)) return "snow";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(weather.conditionCode)) {
    return "rain";
  }
  return undefined;
}
