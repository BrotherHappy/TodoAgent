import { localDateKey, weekDateKeys } from "./timeline-utils";

export type WeeklyCheckinEnergy = 1 | 2 | 3 | 4 | 5;
export type WeeklyCheckinPace = "gentle" | "steady" | "full";

export interface WeeklyCheckinRecord {
  weekStart: string;
  energy: WeeklyCheckinEnergy;
  pace: WeeklyCheckinPace;
  note: string;
  completedAt: string;
}

export interface WeeklyCheckinCopyInput {
  energy: WeeklyCheckinEnergy;
  pace: WeeklyCheckinPace;
  completedCount: number;
  openCount: number;
}

export interface WeeklyCheckinCopy {
  headline: string;
  detail: string;
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const paceLabels: Record<WeeklyCheckinPace, string> = {
  gentle: "给自己留一点余地",
  steady: "稳稳推进",
  full: "集中火力",
};

const isEnergy = (value: unknown): value is WeeklyCheckinEnergy =>
  value === 1 || value === 2 || value === 3 || value === 4 || value === 5;

const isPace = (value: unknown): value is WeeklyCheckinPace =>
  value === "gentle" || value === "steady" || value === "full";

const asDateKey = (value: Date | string): string => {
  if (typeof value === "string" && DATE_KEY_PATTERN.test(value)) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? localDateKey() : localDateKey(parsed);
};

/** Monday of the calendar week that contains the supplied local date. */
export const weekStartFor = (value: Date | string = new Date()): string =>
  weekDateKeys(asDateKey(value))[0] ?? asDateKey(value);

/**
 * Reads a persisted check-in defensively. A check-in from a prior week is not
 * carried into the new week, so the ritual stays a fresh, optional pause.
 */
export const normalizeWeeklyCheckin = (
  value: unknown,
  weekStart: string,
): WeeklyCheckinRecord | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WeeklyCheckinRecord>;
  if (candidate.weekStart !== weekStart || !isEnergy(candidate.energy) || !isPace(candidate.pace)) {
    return undefined;
  }
  const note = typeof candidate.note === "string" ? candidate.note.trim().slice(0, 300) : "";
  const completedAt = typeof candidate.completedAt === "string" ? candidate.completedAt : "";
  if (!completedAt || Number.isNaN(new Date(completedAt).getTime())) return undefined;
  return {
    weekStart,
    energy: candidate.energy,
    pace: candidate.pace,
    note,
    completedAt,
  };
};

export const checkinCopy = ({
  energy,
  pace,
  completedCount,
  openCount,
}: WeeklyCheckinCopyInput): WeeklyCheckinCopy => {
  const headline = energy >= 4
    ? "这周有能量，就把它用在真正重要的事上。"
    : energy === 3
      ? "稳住自己的节奏，比把每件事都塞满更重要。"
      : "今天先照顾好自己，轻一点也完全可以。";
  const completed = Math.max(0, Math.round(completedCount));
  const open = Math.max(0, Math.round(openCount));
  return {
    headline,
    detail: `${paceLabels[pace]} · 本周已完成 ${completed} 项，还有 ${open} 项待处理。`,
  };
};

export const weeklyCheckinPaceLabel = (pace: WeeklyCheckinPace): string => paceLabels[pace];
