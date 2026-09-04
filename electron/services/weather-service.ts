import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { WeatherForecastDay, WeatherSnapshot } from "../../src/shared/pet-types";
import type { WeatherSettings } from "../../src/shared/settings";

interface GeocodingResponse {
  results?: Array<{
    name?: string;
    admin1?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  }>;
}

interface ForecastResponse {
  latitude?: number;
  longitude?: number;
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    weather_code?: number[];
  };
}

interface StoredWeather {
  schemaVersion: 1;
  snapshot?: WeatherSnapshot;
}

export interface WeatherServiceOptions {
  userDataPath: string;
  settings: () => WeatherSettings;
  fetch?: typeof fetch;
  now?: () => number;
}

export class WeatherService {
  readonly #filePath: string;
  readonly #settings: () => WeatherSettings;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #snapshot?: WeatherSnapshot;
  #refreshing?: Promise<WeatherSnapshot | undefined>;

  constructor(options: WeatherServiceOptions) {
    this.#filePath = path.join(
      options.userDataPath,
      "weather",
      "weather-cache.v1.json",
    );
    this.#settings = options.settings;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<WeatherSnapshot | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as StoredWeather;
      if (value.schemaVersion === 1 && value.snapshot) {
        this.#snapshot = { ...value.snapshot, stale: this.#isExpired(value.snapshot) };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.get();
  }

  get(): WeatherSnapshot | undefined {
    if (!this.#snapshot) return undefined;
    return { ...this.#snapshot, stale: this.#isExpired(this.#snapshot) };
  }

  async refresh(force = false): Promise<WeatherSnapshot | undefined> {
    const settings = this.#settings();
    if (!settings.enabled || !settings.city.trim()) return undefined;
    if (!force && this.#snapshot && !this.#isExpired(this.#snapshot)) {
      return this.get();
    }
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#refresh(settings)
      .catch((error: unknown) => {
        // A transient provider or network failure must not blank a desktop
        // companion card that already has a useful last-known observation.
        // Mark it stale so the UI never mistakes cached data for a fresh fact.
        if (this.#snapshot) return { ...this.#snapshot, stale: true };
        throw error;
      })
      .finally(() => {
        this.#refreshing = undefined;
      });
    return this.#refreshing;
  }

  async #refresh(settings: WeatherSettings): Promise<WeatherSnapshot> {
    let latitude = settings.latitude;
    let longitude = settings.longitude;
    let resolvedName = settings.resolvedName;
    if (latitude === undefined || longitude === undefined) {
      const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
      url.searchParams.set("name", settings.city.trim());
      url.searchParams.set("count", "1");
      url.searchParams.set("language", "zh");
      url.searchParams.set("format", "json");
      const response = await this.#fetchJson<GeocodingResponse>(url);
      const place = response.results?.[0];
      if (
        !place ||
        !Number.isFinite(place.latitude) ||
        !Number.isFinite(place.longitude)
      ) {
        throw new Error("WEATHER_CITY_NOT_FOUND");
      }
      latitude = place.latitude;
      longitude = place.longitude;
      resolvedName = [place.name, place.admin1, place.country]
        .filter(Boolean)
        .join(" · ");
    }

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,weather_code",
    );
    url.searchParams.set(
      "daily",
      "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    );
    url.searchParams.set("forecast_days", "3");
    url.searchParams.set("timezone", "auto");
    const forecast = await this.#fetchJson<ForecastResponse>(url);
    const temperature = forecast.current?.temperature_2m;
    const weatherCode = forecast.current?.weather_code;
    if (!Number.isFinite(temperature) || !Number.isFinite(weatherCode)) {
      throw new Error("WEATHER_RESPONSE_INVALID");
    }

    const now = this.#now();
    const forecastDays = buildForecastDays(forecast.daily);
    const snapshot: WeatherSnapshot = {
      city: resolvedName || settings.city.trim(),
      latitude: Number(latitude),
      longitude: Number(longitude),
      conditionCode: Number(weatherCode),
      conditionLabel: weatherCodeLabel(Number(weatherCode)),
      temperatureC: Number(temperature),
      apparentTemperatureC: finiteOrUndefined(
        forecast.current?.apparent_temperature,
      ),
      lowC: finiteOrUndefined(forecast.daily?.temperature_2m_min?.[0]),
      highC: finiteOrUndefined(forecast.daily?.temperature_2m_max?.[0]),
      precipitationProbability: finiteOrUndefined(
        forecast.daily?.precipitation_probability_max?.[0],
      ),
      forecast: forecastDays.length > 0 ? forecastDays : undefined,
      severe: [95, 96, 99].includes(Number(weatherCode)),
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(
        now + Math.max(30, Math.min(120, settings.cacheMinutes)) * 60_000,
      ).toISOString(),
      stale: false,
    };
    this.#snapshot = snapshot;
    await atomicWrite(this.#filePath, { schemaVersion: 1, snapshot });
    return { ...snapshot };
  }

  async #fetchJson<Result>(url: URL): Promise<Result> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.#fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`WEATHER_HTTP_${response.status}`);
      return (await response.json()) as Result;
    } finally {
      clearTimeout(timer);
    }
  }

  #isExpired(snapshot: WeatherSnapshot): boolean {
    return new Date(snapshot.expiresAt).getTime() <= this.#now();
  }
}

function buildForecastDays(
  daily: ForecastResponse["daily"],
): WeatherForecastDay[] {
  const dates = daily?.time ?? [];
  return dates
    .map((date, index): WeatherForecastDay | undefined => {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined;
      const conditionCode = finiteOrUndefined(daily?.weather_code?.[index]);
      if (conditionCode === undefined) return undefined;
      return {
        date,
        conditionCode,
        conditionLabel: weatherCodeLabel(conditionCode),
        lowC: finiteOrUndefined(daily?.temperature_2m_min?.[index]),
        highC: finiteOrUndefined(daily?.temperature_2m_max?.[index]),
        precipitationProbability: finiteOrUndefined(
          daily?.precipitation_probability_max?.[index],
        ),
        severe: [95, 96, 99].includes(conditionCode),
      };
    })
    .filter((day): day is WeatherForecastDay => day !== undefined);
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function weatherCodeLabel(code: number): string {
  if (code === 0) return "晴";
  if ([1, 2].includes(code)) return "少云";
  if (code === 3) return "阴";
  if ([45, 48].includes(code)) return "雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "雪";
  if ([95, 96, 99].includes(code)) return "雷暴";
  return "天气未知";
}

async function atomicWrite(
  filePath: string,
  value: StoredWeather,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, filePath);
}
