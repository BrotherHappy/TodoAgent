import type { WeatherForecastDay } from "../shared/pet-types";
import { buildPetWeatherForecast } from "./pet-weather-forecast";

export interface PetWeatherForecastProps {
  forecast?: readonly WeatherForecastDay[];
  stale?: boolean;
  today?: string;
}

export function PetWeatherForecast({ forecast, stale = false, today }: PetWeatherForecastProps) {
  const items = buildPetWeatherForecast(forecast, { today });
  if (!items.length) return null;
  return (
    <section className="pet-weather-forecast" aria-label="未来天气预览">
      <div className="pet-weather-forecast-heading">
        <strong>接下来几天</strong>
        <span>{stale ? "缓存中的预报" : "按城市预报"}</span>
      </div>
      <div className="pet-weather-forecast-list">
        {items.map((item) => (
          <div
            key={item.date}
            className={`pet-weather-forecast-item${item.severe ? " is-severe" : ""}`}
            aria-label={item.ariaLabel}
          >
            <span className="pet-weather-forecast-day">{item.dayLabel}</span>
            <span className="pet-weather-forecast-icon" aria-hidden="true">{item.icon}</span>
            <span className="pet-weather-forecast-condition">{item.conditionLabel}</span>
            <strong>{item.temperatureLabel}</strong>
            <small>{item.precipitationLabel}</small>
          </div>
        ))}
      </div>
    </section>
  );
}
