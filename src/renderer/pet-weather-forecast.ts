import type { WeatherForecastDay } from "../shared/pet-types";
import { localDateKey } from "./timeline-utils";

export interface PetWeatherForecastItem {
  date: string;
  dayLabel: string;
  icon: "☀" | "☂" | "❄" | "⚡";
  conditionLabel: string;
  temperatureLabel: string;
  precipitationLabel: string;
  severe: boolean;
  ariaLabel: string;
}

function weatherIcon(conditionLabel: string): PetWeatherForecastItem["icon"] {
  if (/雷|雷雨|thunder|storm/i.test(conditionLabel)) return "⚡";
  if (/雪|冰雹|sleet|snow|hail/i.test(conditionLabel)) return "❄";
  if (/雨|阵雨|drizzle|rain|shower/i.test(conditionLabel)) return "☂";
  return "☀";
}

function temperature(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? `${Math.round(value)}℃` : "—";
}

function temperatureRange(day: WeatherForecastDay): string {
  const low = temperature(day.lowC);
  const high = temperature(day.highC);
  if (low === "—" && high === "—") return "温度 —";
  if (low === "—") return `高 ${high}`;
  if (high === "—") return `低 ${low}`;
  return `${low} / ${high}`;
}

function precipitation(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "降水 —";
  return `降水 ${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function dayDistance(date: string, today: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^\d{4}-\d{2}-\d{2}$/u.test(today)) {
    return undefined;
  }
  const [year, month, day] = date.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  return Math.round(
    (Date.UTC(year, month - 1, day) - Date.UTC(todayYear, todayMonth - 1, todayDay)) /
      86_400_000,
  );
}

function dayLabel(date: string, today: string): string {
  const distance = dayDistance(date, today);
  if (distance === 0) return "今天";
  if (distance === 1) return "明天";
  if (distance === 2) return "后天";
  const [year, month, day] = date.split("-").map(Number);
  const weekday = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(
        new Date(Date.UTC(year, month - 1, day)),
      )
    : "预报";
  return `${weekday} ${date.slice(5).replace("-", "/")}`;
}

/**
 * Turns provider forecast facts into a compact, deterministic pet surface.
 * It intentionally does not infer rain, temperature or dates beyond the
 * structured values returned by the weather service.
 */
export function buildPetWeatherForecast(
  forecast: readonly WeatherForecastDay[] | undefined,
  options: { today?: string; maxDays?: number } = {},
): PetWeatherForecastItem[] {
  if (!forecast?.length) return [];
  const today = options.today ?? localDateKey();
  const maxDays = Number.isFinite(options.maxDays)
    ? Math.max(1, Math.min(5, Math.floor(options.maxDays ?? 3)))
    : 3;
  const seen = new Set<string>();
  return forecast
    .filter((day) => {
      if (seen.has(day.date)) return false;
      seen.add(day.date);
      return /^\d{4}-\d{2}-\d{2}$/u.test(day.date);
    })
    .slice(0, maxDays)
    .map((day) => {
      const condition = day.conditionLabel.trim() || "天气未知";
      const item: PetWeatherForecastItem = {
        date: day.date,
        dayLabel: dayLabel(day.date, today),
        icon: weatherIcon(condition),
        conditionLabel: condition,
        temperatureLabel: temperatureRange(day),
        precipitationLabel: precipitation(day.precipitationProbability),
        severe: day.severe,
        ariaLabel: `${dayLabel(day.date, today)}，${condition}，${temperatureRange(day)}，${precipitation(day.precipitationProbability)}${day.severe ? "，请留意天气变化" : ""}`,
      };
      return item;
    });
}
