import type { Task } from "../shared/models";
import type { FocusHistoryRecord, PetPersonality, WeatherSnapshot } from "../shared/pet-types";
import { buildPetPostcard } from "./pet-postcard";

export interface PetPostcardCardProps {
  name: string;
  personality?: PetPersonality;
  tasks: readonly Task[];
  focusHistory: readonly FocusHistoryRecord[];
  weather?: WeatherSnapshot;
  onOpenToday: () => void;
}

export function PetPostcardCard({
  name,
  personality,
  tasks,
  focusHistory,
  weather,
  onOpenToday,
}: PetPostcardCardProps) {
  const postcard = buildPetPostcard({ name, personality, tasks, focusHistory, weather });
  return (
    <section className={`pet-postcard-card is-${postcard.tone}`} aria-label={postcard.ariaLabel}>
      <div className="pet-postcard-icon" aria-hidden="true">{postcard.icon}</div>
      <div className="pet-postcard-copy">
        <span className="pet-postcard-kicker">今日明信片{postcard.weatherLine ? ` · ${postcard.weatherLine}` : ""}</span>
        <h2>{postcard.headline}</h2>
        <p>{postcard.body}</p>
        <button type="button" className="soft-button" onClick={onOpenToday}>查看今天</button>
      </div>
      <div className="pet-postcard-metrics" aria-label="今日陪伴统计">
        {postcard.metrics.map((metric) => (
          <div key={metric.label}>
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
