import { describe, expect, it, vi } from "vitest";
import { buildPetWeatherForecast } from "../src/renderer/pet-weather-forecast";

const forecast = [
  {
    date: "2026-08-21",
    conditionCode: 61,
    conditionLabel: "雨",
    lowC: 24.2,
    highC: 31.6,
    precipitationProbability: 74,
    severe: false,
  },
  {
    date: "2026-08-22",
    conditionCode: 95,
    conditionLabel: "雷暴",
    lowC: 23,
    highC: 29,
    precipitationProbability: 110,
    severe: true,
  },
  {
    date: "2026-08-23",
    conditionCode: 0,
    conditionLabel: "晴",
    lowC: 25,
    highC: 34,
    severe: false,
  },
] as const;

describe("pet weather forecast", () => {
  it("keeps provider facts visible with friendly relative day labels", () => {
    expect(buildPetWeatherForecast(forecast, { today: "2026-08-21" })).toEqual([
      {
        date: "2026-08-21",
        dayLabel: "今天",
        icon: "☂",
        conditionLabel: "雨",
        temperatureLabel: "24℃ / 32℃",
        precipitationLabel: "降水 74%",
        severe: false,
        ariaLabel: "今天，雨，24℃ / 32℃，降水 74%",
      },
      {
        date: "2026-08-22",
        dayLabel: "明天",
        icon: "⚡",
        conditionLabel: "雷暴",
        temperatureLabel: "23℃ / 29℃",
        precipitationLabel: "降水 100%",
        severe: true,
        ariaLabel: "明天，雷暴，23℃ / 29℃，降水 100%，请留意天气变化",
      },
      {
        date: "2026-08-23",
        dayLabel: "后天",
        icon: "☀",
        conditionLabel: "晴",
        temperatureLabel: "25℃ / 34℃",
        precipitationLabel: "降水 —",
        severe: false,
        ariaLabel: "后天，晴，25℃ / 34℃，降水 —",
      },
    ]);
  });

  it("deduplicates invalid dates, caps the view, and stays empty without facts", () => {
    expect(
      buildPetWeatherForecast(
        [
          ...forecast,
          { ...forecast[2], date: "2026-08-24" },
          { ...forecast[2], date: "not-a-date" },
          { ...forecast[2], date: "2026-08-23" },
        ],
        { today: "2026-08-21", maxDays: 2 },
      ),
    ).toHaveLength(2);
    expect(buildPetWeatherForecast(undefined)).toEqual([]);
  });

  it("uses the local calendar day when the caller omits today", () => {
    const originalNow = Date;
    vi.useFakeTimers();
    vi.setSystemTime(new originalNow("2026-08-21T00:30:00+08:00"));
    try {
      expect(buildPetWeatherForecast(forecast.slice(0, 1))).toEqual([
        expect.objectContaining({ dayLabel: "今天" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
