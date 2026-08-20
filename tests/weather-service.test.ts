// @vitest-environment node

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WeatherService, weatherCodeLabel } from "../electron/services/weather-service";
import type { WeatherSettings } from "../src/shared/settings";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WeatherService", () => {
  it("resolves a manual city, caches the structured forecast and avoids precise location", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-weather-"));
    let now = Date.parse("2026-08-15T03:00:00.000Z");
    const settings: WeatherSettings = {
      enabled: true,
      city: "上海",
      cacheMinutes: 45,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              name: "上海",
              admin1: "上海市",
              country: "中国",
              latitude: 31.23,
              longitude: 121.47,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          current: {
            temperature_2m: 29.4,
            apparent_temperature: 32.1,
            weather_code: 61,
          },
          daily: {
            time: ["2026-08-15", "2026-08-16", "2026-08-17"],
            temperature_2m_min: [25, 24, 26],
            temperature_2m_max: [33, 32, 34],
            precipitation_probability_max: [70, 40, 15],
            weather_code: [61, 2, 0],
          },
        }),
      );
    const service = new WeatherService({
      userDataPath: root,
      settings: () => settings,
      fetch: fetchMock,
      now: () => now,
    });
    await service.initialize();
    const weather = await service.refresh();
    expect(weather).toMatchObject({
      city: "上海 · 上海市 · 中国",
      conditionLabel: "雨",
      temperatureC: 29.4,
      precipitationProbability: 70,
      stale: false,
    });
    expect(weather?.forecast).toEqual([
      {
        date: "2026-08-15",
        conditionCode: 61,
        conditionLabel: "雨",
        lowC: 25,
        highC: 33,
        precipitationProbability: 70,
        severe: false,
      },
      {
        date: "2026-08-16",
        conditionCode: 2,
        conditionLabel: "少云",
        lowC: 24,
        highC: 32,
        precipitationProbability: 40,
        severe: false,
      },
      {
        date: "2026-08-17",
        conditionCode: 0,
        conditionLabel: "晴",
        lowC: 26,
        highC: 34,
        precipitationProbability: 15,
        severe: false,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const forecastUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(forecastUrl.searchParams.get("forecast_days")).toBe("3");
    await service.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 46 * 60_000;
    expect(service.get()?.stale).toBe(true);
  });

  it("keeps last-known weather visibly stale when a forced refresh fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-weather-stale-"));
    const settings: WeatherSettings = {
      enabled: true,
      city: "杭州",
      latitude: 30.27,
      longitude: 120.15,
      resolvedName: "杭州 · 浙江 · 中国",
      cacheMinutes: 45,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          current: { temperature_2m: 30, weather_code: 0 },
          daily: {},
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "down" }, 503));
    const service = new WeatherService({
      userDataPath: root,
      settings: () => settings,
      fetch: fetchMock,
    });
    await service.initialize();
    expect((await service.refresh(true))?.stale).toBe(false);
    const fallback = await service.refresh(true);
    expect(fallback).toMatchObject({ temperatureC: 30, stale: true });
  });

  it("does nothing when weather is disabled and maps severe codes deterministically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "todo-agent-weather-off-"));
    const fetchMock = vi.fn<typeof fetch>();
    const service = new WeatherService({
      userDataPath: root,
      settings: () => ({ enabled: false, city: "", cacheMinutes: 45 }),
      fetch: fetchMock,
    });
    await service.initialize();
    expect(await service.refresh()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(weatherCodeLabel(95)).toBe("雷暴");
    expect(weatherCodeLabel(999)).toBe("天气未知");
  });
});
