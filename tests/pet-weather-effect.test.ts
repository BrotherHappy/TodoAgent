import { describe, expect, it } from "vitest";
import type { WeatherSnapshot } from "../src/shared/pet-types";
import { petWeatherEffectFor } from "../src/renderer/pet-weather-effect";

const weather = (conditionCode: number, severe = false): WeatherSnapshot => ({
  city: "杭州",
  latitude: 30.27,
  longitude: 120.15,
  conditionCode,
  conditionLabel: "天气",
  temperatureC: 20,
  severe,
  fetchedAt: "2026-08-21T08:00:00.000Z",
  expiresAt: "2026-08-21T10:00:00.000Z",
  stale: false,
});

describe("pet weather effect", () => {
  it("maps structured rain, snow and severe facts without using labels", () => {
    expect(petWeatherEffectFor(weather(61))).toBe("rain");
    expect(petWeatherEffectFor(weather(71))).toBe("snow");
    expect(petWeatherEffectFor(weather(95))).toBe("storm");
    expect(petWeatherEffectFor(weather(0))).toBeUndefined();
  });

  it("preserves an explicit severe flag for provider codes not in the list", () => {
    expect(petWeatherEffectFor(weather(999, true))).toBe("storm");
    expect(petWeatherEffectFor(undefined)).toBeUndefined();
  });
});
