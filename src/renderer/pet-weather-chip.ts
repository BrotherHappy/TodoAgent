import type { WeatherSnapshot } from "../shared/pet-types";

export interface PetWeatherChip {
  icon: "☀" | "☂" | "❄" | "⚡";
  label: string;
  detail: string;
  ariaLabel: string;
  severe: boolean;
  stale: boolean;
}

function weatherIcon(conditionLabel: string): PetWeatherChip["icon"] {
  if (/雷|雷雨|thunder|storm/i.test(conditionLabel)) return "⚡";
  if (/雪|冰雹|sleet|snow|hail/i.test(conditionLabel)) return "❄";
  if (/雨|阵雨|drizzle|rain|shower/i.test(conditionLabel)) return "☂";
  return "☀";
}

function temperatureLabel(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)}℃` : "—℃";
}

function precipitationLabel(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "降水 —";
  return `降水 ${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

/**
 * Turns the already-authorized, cached weather snapshot into a compact piece
 * of desktop copy. This is presentation-only: no location lookup or task
 * mutation belongs in this helper.
 */
export function buildPetWeatherChip(
  weather: WeatherSnapshot | undefined,
  privacyMode = false,
): PetWeatherChip | undefined {
  if (!weather) return undefined;
  const condition = weather.conditionLabel.trim() || "天气";
  const icon = weatherIcon(condition);
  const label = `${temperatureLabel(weather.temperatureC)} · ${condition}`;
  const city = weather.city.trim();
  const detailParts = [
    privacyMode ? "天气已隐藏地点" : city || "已配置城市",
    precipitationLabel(weather.precipitationProbability),
  ];
  if (weather.stale) detailParts.push("缓存");
  const detail = detailParts.join(" · ");
  return {
    icon,
    label,
    detail,
    ariaLabel: `${label}，${detail}${weather.severe ? "，请留意天气变化" : ""}`,
    severe: weather.severe,
    stale: weather.stale,
  };
}
