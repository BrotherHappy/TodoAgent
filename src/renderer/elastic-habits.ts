export const ELASTIC_HABITS_STORAGE_KEY = "todoAgentElasticHabits";
export const ELASTIC_HABITS_MIGRATED_KEY = "todoAgentElasticHabitsMigratedV1";

export interface ElasticHabit {
  id: string;
  label: string;
  hint: string;
  cadenceMinutes: number;
  enabled?: boolean;
  lastCompletedAt?: string;
  snoozedUntil?: string;
}

export const defaultElasticHabits: ElasticHabit[] = [
  { id: "water", label: "喝口水", hint: "让身体跟上你的节奏", cadenceMinutes: 90, enabled: true },
  { id: "stretch", label: "起身伸展", hint: "肩颈和眼睛一起松一松", cadenceMinutes: 120, enabled: true },
  { id: "close-loop", label: "收尾一分钟", hint: "把刚才的上下文留给未来的你", cadenceMinutes: 180, enabled: true },
];

const validHabit = (value: unknown): value is ElasticHabit => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.hint === "string" &&
    typeof record.cadenceMinutes === "number" &&
    Number.isFinite(record.cadenceMinutes) &&
    record.cadenceMinutes > 0 &&
    (record.enabled === undefined || typeof record.enabled === "boolean")
  );
};

export const readStoredElasticHabits = (): ElasticHabit[] | undefined => {
  try {
    const raw = localStorage.getItem(ELASTIC_HABITS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const habits = parsed.filter(validHabit).map((habit) => ({ ...habit, enabled: habit.enabled !== false }));
    return habits.length ? habits : undefined;
  } catch {
    return undefined;
  }
};

export const readElasticHabits = (): ElasticHabit[] =>
  readStoredElasticHabits() ?? defaultElasticHabits.map((habit) => ({ ...habit }));

export const writeElasticHabits = (habits: readonly ElasticHabit[]): void => {
  try {
    localStorage.setItem(ELASTIC_HABITS_STORAGE_KEY, JSON.stringify(habits.slice(0, 12)));
  } catch {
    // The UI remains useful when storage is disabled or full.
  }
};

export const habitAvailableAt = (habit: ElasticHabit): number | undefined => {
  const completedAt = habit.lastCompletedAt ? Date.parse(habit.lastCompletedAt) : NaN;
  const snoozedUntil = habit.snoozedUntil ? Date.parse(habit.snoozedUntil) : NaN;
  const cadenceAt = Number.isFinite(completedAt)
    ? completedAt + habit.cadenceMinutes * 60_000
    : undefined;
  return Math.max(cadenceAt ?? 0, Number.isFinite(snoozedUntil) ? snoozedUntil : 0) || undefined;
};

export const habitState = (
  habit: ElasticHabit,
  now = Date.now(),
): "ready" | "resting" => {
  const availableAt = habitAvailableAt(habit);
  return availableAt !== undefined && availableAt > now ? "resting" : "ready";
};

export const formatHabitWait = (habit: ElasticHabit, now = Date.now()): string => {
  const availableAt = habitAvailableAt(habit);
  if (!availableAt || availableAt <= now) return "现在是一个合适的空档";
  const minutes = Math.max(1, Math.ceil((availableAt - now) / 60_000));
  return minutes < 60 ? `${minutes} 分钟后再问你` : `${Math.ceil(minutes / 60)} 小时后再问你`;
};
