import type { Task } from "../shared/models";
import type { FocusHistoryRecord, PetPersonality, WeatherSnapshot } from "../shared/pet-types";
import { localDateKey } from "./timeline-utils";

export type PetPostcardTone = "proud" | "steady" | "gentle" | "quiet";

export interface PetPostcardMetric {
  label: string;
  value: string;
}

export interface PetPostcard {
  tone: PetPostcardTone;
  icon: "✦" | "☀" | "☁" | "☾";
  headline: string;
  body: string;
  weatherLine?: string;
  metrics: PetPostcardMetric[];
  ariaLabel: string;
}

export interface PetPostcardInput {
  name: string;
  personality?: PetPersonality;
  tasks: readonly Task[];
  focusHistory: readonly FocusHistoryRecord[];
  weather?: WeatherSnapshot;
  now?: Date;
}

const dateKeyFor = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : localDateKey(parsed);
};

const finiteMinutes = (seconds: number): number =>
  Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : 0;

const petVoice = (personality: PetPersonality | undefined, active: boolean): string => {
  if (personality === "energetic" || personality === "playful") {
    return active ? "我们已经跑出一小段啦，继续保持这个节奏！" : "先挑一件最轻的小事，我们一起开个头！";
  }
  if (personality === "calm" || personality === "quiet") {
    return active ? "这一小段已经稳稳留下来了，慢慢来就好。" : "今天不用急，先给自己一个很小的落点。";
  }
  return active ? "你已经往前走了一点，我会在这里陪着。" : "从一个不费力的下一步开始，也完全可以。";
};

/**
 * Projects existing task/focus/weather facts into a short, non-persistent
 * home greeting. The postcard never invents completion or changes any data.
 */
export function buildPetPostcard(input: PetPostcardInput): PetPostcard {
  const now = input.now ?? new Date();
  const today = localDateKey(now);
  const visibleTasks = input.tasks.filter((task) => !task.deletedAt);
  const completedToday = visibleTasks.filter(
    (task) => task.status === "completed" && dateKeyFor(task.completedAt) === today,
  ).length;
  const openToday = visibleTasks.filter((task) => {
    if (task.status !== "open") return false;
    const due = dateKeyFor(task.dueAt);
    return (
      (task.plannedDate !== undefined && task.plannedDate <= today) ||
      dateKeyFor(task.startAt) === today ||
      (due !== undefined && due <= today)
    );
  }).length;
  const focusMinutes = input.focusHistory
    .filter((entry) => entry.outcome === "completed" && dateKeyFor(entry.completedAt) === today)
    .reduce((total, entry) => total + finiteMinutes(entry.actualSeconds), 0);
  const active = completedToday > 0 || focusMinutes > 0;
  const tone: PetPostcardTone = completedToday >= 3
    ? "proud"
    : active
      ? "steady"
      : openToday > 0
        ? "gentle"
        : "quiet";
  const icon: PetPostcard["icon"] = tone === "proud"
    ? "✦"
    : tone === "steady"
      ? "☀"
      : tone === "gentle"
        ? "☁"
        : "☾";
  const headline = tone === "proud"
    ? `${input.name}说：今天有三颗小星星`
    : tone === "steady"
      ? `${input.name}陪你稳稳走着`
      : tone === "gentle"
        ? `${input.name}给你留了一张小卡片`
        : `${input.name}在安静地陪你`;
  const body = petVoice(input.personality, active);
  const weatherLine = input.weather
    ? `${input.weather.conditionLabel || "天气"} · ${Math.round(input.weather.temperatureC)}℃${input.weather.stale ? " · 缓存" : ""}`
    : undefined;
  const metrics: PetPostcardMetric[] = [
    { label: "今日完成", value: String(completedToday) },
    { label: "专注分钟", value: String(focusMinutes) },
    { label: "今日待办", value: String(openToday) },
  ];
  return {
    tone,
    icon,
    headline,
    body,
    weatherLine,
    metrics,
    ariaLabel: `${headline}。${body}${weatherLine ? ` ${weatherLine}。` : ""} 今日完成 ${completedToday} 项，专注 ${focusMinutes} 分钟，今日待办 ${openToday} 项。`,
  };
}
