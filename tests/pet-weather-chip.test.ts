import { describe, expect, it } from "vitest";
import type { WeatherSnapshot } from "../src/shared/pet-types";
import { buildPetWeatherChip } from "../src/renderer/pet-weather-chip";

const weather = (patch: Partial<WeatherSnapshot> = {}): WeatherSnapshot => ({
  city: "杭州",
  latitude: 30.27,
  longitude: 120.15,
  conditionCode: 1,
  conditionLabel: "多云",
  temperatureC: 26.4,
  precipitationProbability: 35,
  severe: false,
  fetchedAt: "2026-08-21T08:00:00.000Z",
  expiresAt: "2026-08-21T10:00:00.000Z",
  stale: false,
  ...patch,
});

describe("pet weather chip", () => {
  it("formats a compact weather summary without inventing task data", () => {
    expect(buildPetWeatherChip(weather())).toEqual({
      icon: "☀",
      label: "26℃ · 多云",
      detail: "杭州 · 降水 35%",
      ariaLabel: "26℃ · 多云，杭州 · 降水 35%",
      severe: false,
      stale: false,
    });
  });

  it("hides the city in privacy mode and marks stale cache", () => {
    const chip = buildPetWeatherChip(
      weather({ conditionLabel: "小雨", temperatureC: 8.8, stale: true }),
      true,
    );
    expect(chip).toMatchObject({
      icon: "☂",
      label: "9℃ · 小雨",
      detail: "天气已隐藏地点 · 降水 35% · 缓存",
      stale: true,
    });
    expect(chip?.detail).not.toContain("杭州");
  });

  it("uses an alert icon and bounded precipitation for severe weather", () => {
    const chip = buildPetWeatherChip(
      weather({ conditionLabel: "雷阵雨", severe: true, precipitationProbability: 140 }),
    );
    expect(chip).toMatchObject({
      icon: "⚡",
      detail: "杭州 · 降水 100%",
      severe: true,
    });
    expect(chip?.ariaLabel).toContain("请留意天气变化");
  });

  it("returns no surface when weather is not available", () => {
    expect(buildPetWeatherChip(undefined)).toBeUndefined();
  });
});
