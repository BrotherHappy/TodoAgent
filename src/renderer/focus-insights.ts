import type { Task } from "../shared/models";
import { localDateKey, weekDateKeys } from "./timeline-utils";

export interface FocusInsightDay {
  date: string;
  minutes: number;
  sessions: number;
}

export interface FocusTaskSummary {
  taskId: string;
  title: string;
  minutes: number;
  sessions: number;
}

export interface FocusInsights {
  weekStart: string;
  weekEnd: string;
  days: FocusInsightDay[];
  totalMinutes: number;
  totalSessions: number;
  averageSessionMinutes: number;
  topTasks: FocusTaskSummary[];
}

const validDatePart = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : localDateKey(parsed);
};

const roundedMinutes = (seconds: number): number =>
  Math.max(0, Math.round(seconds / 60));

/**
 * Projects the task-level focus history into a small, explainable weekly
 * report. It intentionally reads only local task facts and never writes to a
 * task or to the Feishu payload.
 */
export function buildFocusInsights(
  tasks: readonly Task[],
  anchor: string,
): FocusInsights {
  const dates = weekDateKeys(anchor);
  const dateSet = new Set(dates);
  const byDay = new Map<string, { seconds: number; sessions: number }>(
    dates.map((date) => [date, { seconds: 0, sessions: 0 }]),
  );
  const byTask = new Map<string, { taskId: string; title: string; seconds: number; sessions: number }>();

  const addFocus = (
    task: Task,
    date: string | undefined,
    seconds: number,
    sessions: number,
  ): void => {
    if (!dateSet.has(date ?? "") || !Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    const day = byDay.get(date!);
    if (day) {
      day.seconds += seconds;
      day.sessions += sessions;
    }
    const existing = byTask.get(task.id) ?? {
      taskId: task.id,
      title: task.title,
      seconds: 0,
      sessions: 0,
    };
    existing.seconds += seconds;
    existing.sessions += sessions;
    byTask.set(task.id, existing);
  };

  for (const task of tasks) {
    if (task.deletedAt) continue;
    const sessions = task.focusSessions ?? [];
    if (sessions.length > 0) {
      for (const session of sessions) {
        addFocus(
          task,
          validDatePart(session.endedAt),
          Number(session.elapsedSeconds),
          1,
        );
      }
      continue;
    }

    // Tasks written before focusSessions existed still carry an aggregate
    // value. Attribute that legacy value to completion, or to the task's
    // planned/start date when it remains open, without double-counting a task
    // that already has granular sessions.
    const legacySeconds =
      Number(task.actualMinutes ?? 0) * 60 || Number(task.focusElapsedSeconds ?? 0);
    const legacyDate =
      validDatePart(task.completedAt) ??
      validDatePart(task.timeBlock?.startAt) ??
      validDatePart(task.startAt) ??
      (task.plannedDate && dateSet.has(task.plannedDate)
        ? task.plannedDate
        : undefined);
    if (legacySeconds > 0) addFocus(task, legacyDate, legacySeconds, 1);
  }

  const days = dates.map((date) => {
    const value = byDay.get(date) ?? { seconds: 0, sessions: 0 };
    return {
      date,
      minutes: roundedMinutes(value.seconds),
      sessions: value.sessions,
    };
  });
  const totalSeconds = dates.reduce(
    (total, date) => total + (byDay.get(date)?.seconds ?? 0),
    0,
  );
  const totalSessions = days.reduce((total, day) => total + day.sessions, 0);
  const topTasks = [...byTask.values()]
    .map((item): FocusTaskSummary => ({
      taskId: item.taskId,
      title: item.title,
      minutes: roundedMinutes(item.seconds),
      sessions: item.sessions,
    }))
    .filter((item) => item.minutes > 0)
    .sort(
      (left, right) =>
        right.minutes - left.minutes ||
        right.sessions - left.sessions ||
        left.title.localeCompare(right.title, "zh-CN"),
    )
    .slice(0, 3);

  return {
    weekStart: dates[0] ?? anchor,
    weekEnd: dates.at(-1) ?? anchor,
    days,
    totalMinutes: Math.round(totalSeconds / 60),
    totalSessions,
    averageSessionMinutes:
      totalSessions > 0 ? Math.round((totalSeconds / 60 / totalSessions) * 10) / 10 : 0,
    topTasks,
  };
}
