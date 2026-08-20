import type { FocusHistoryRecord, PetGoal, PetGoalMetric, PetHabit } from "../shared/pet-types";
import type { Task } from "../shared/models";

export interface PetGoalFacts {
  tasks: readonly Task[];
  focusHistory: readonly FocusHistoryRecord[];
  habits: readonly PetHabit[];
}

export interface PetGoalProgress {
  goal: PetGoal;
  value: number;
  ratio: number;
  remaining: number;
  unit: string;
  metricLabel: string;
  isComplete: boolean;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export const localDateKey = (value: Date): string =>
  `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;

export const weekRangeFor = (value = new Date()): Pick<PetGoal, "periodStart" | "periodEnd"> => {
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { periodStart: localDateKey(start), periodEnd: localDateKey(end) };
};

const dateKeyFromUnknown = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : localDateKey(parsed);
};

const inRange = (value: string | undefined, goal: PetGoal): boolean => {
  const key = dateKeyFromUnknown(value);
  return key !== undefined && key >= goal.periodStart && key <= goal.periodEnd;
};

export const metricLabel = (metric: PetGoalMetric): string => {
  if (metric === "tasks-completed") return "完成任务";
  if (metric === "focus-minutes") return "专注投入";
  return "习惯照顾";
};

export const metricUnit = (metric: PetGoalMetric): string =>
  metric === "focus-minutes" ? "分钟" : "次";

export const defaultGoalTitle = (metric: PetGoalMetric): string => {
  if (metric === "tasks-completed") return "一起完成几件重要的小事";
  if (metric === "focus-minutes") return "给重要的事留出专注时间";
  return "照顾好自己的节奏";
};

export const projectPetGoal = (goal: PetGoal, facts: PetGoalFacts): PetGoalProgress => {
  let value = 0;
  if (goal.metric === "tasks-completed") {
    value = facts.tasks.filter(
      (task) => task.status === "completed" && inRange(task.completedAt, goal),
    ).length;
  } else if (goal.metric === "focus-minutes") {
    value = Math.round(
      facts.focusHistory
        .filter((entry) => entry.outcome === "completed" && inRange(entry.completedAt, goal))
        .reduce((total, entry) => total + entry.actualSeconds, 0) / 60,
    );
  } else {
    value = facts.habits.filter((habit) => inRange(habit.lastCompletedAt, goal)).length;
  }
  const target = Math.max(1, goal.target);
  return {
    goal,
    value,
    ratio: Math.min(1, value / target),
    remaining: Math.max(0, target - value),
    unit: metricUnit(goal.metric),
    metricLabel: metricLabel(goal.metric),
    isComplete: value >= target,
  };
};

