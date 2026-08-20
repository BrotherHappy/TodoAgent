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

export interface FocusEstimateVariance {
  taskId: string;
  title: string;
  estimatedMinutes: number;
  actualMinutes: number;
  deltaMinutes: number;
  deltaPercent: number;
}

export interface FocusTimeAccounting {
  estimatedMinutes: number;
  actualMinutes: number;
  deltaMinutes: number;
  deltaPercent: number;
  estimatedTaskCount: number;
  trackedTaskCount: number;
  topVariances: FocusEstimateVariance[];
}

export interface FocusInsights {
  weekStart: string;
  weekEnd: string;
  days: FocusInsightDay[];
  totalMinutes: number;
  totalSessions: number;
  averageSessionMinutes: number;
  topTasks: FocusTaskSummary[];
  timeAccounting: FocusTimeAccounting;
}

const validDatePart = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : localDateKey(parsed);
};

const roundedMinutes = (seconds: number): number =>
  Math.max(0, Math.round(seconds / 60));

const positiveMinutes = (value: number | undefined): number | undefined => {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.max(1, Math.round(value));
};

const dateForTask = (task: Task, dateSet: ReadonlySet<string>): string | undefined => {
  const candidates = [
    task.plannedDate,
    validDatePart(task.timeBlock?.startAt),
    validDatePart(task.startAt),
    validDatePart(task.dueAt),
    validDatePart(task.completedAt),
  ];
  return candidates.find((date) => Boolean(date && dateSet.has(date))) as string | undefined;
};

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
  const estimateRows = new Map<string, { taskId: string; title: string; estimatedMinutes: number; actualMinutes: number }>();

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
    let taskSeconds = 0;
    if (sessions.length > 0) {
      for (const session of sessions) {
        const seconds = Number(session.elapsedSeconds);
        const sessionDate = validDatePart(session.endedAt);
        addFocus(
          task,
          sessionDate,
          seconds,
          1,
        );
        if (dateSet.has(sessionDate ?? "") && Number.isFinite(seconds) && seconds > 0) {
          taskSeconds += seconds;
        }
      }
    } else {
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
      if (legacySeconds > 0) {
        addFocus(task, legacyDate, legacySeconds, 1);
        if (dateSet.has(legacyDate ?? "")) taskSeconds = legacySeconds;
      }
    }

    const estimatedMinutes = positiveMinutes(task.estimatedMinutes);
    const hasWeekFact = taskSeconds > 0 || Boolean(dateForTask(task, dateSet));
    if (estimatedMinutes !== undefined && hasWeekFact) {
      estimateRows.set(task.id, {
        taskId: task.id,
        title: task.title,
        estimatedMinutes,
        actualMinutes: roundedMinutes(taskSeconds),
      });
    }
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

  const estimateRowsList = [...estimateRows.values()];
  const estimatedMinutes = estimateRowsList.reduce(
    (total, row) => total + row.estimatedMinutes,
    0,
  );
  const actualMinutes = estimateRowsList.reduce(
    (total, row) => total + row.actualMinutes,
    0,
  );
  const topVariances = estimateRowsList
    .filter((row) => row.actualMinutes > 0)
    .map((row): FocusEstimateVariance => ({
      ...row,
      deltaMinutes: row.actualMinutes - row.estimatedMinutes,
      deltaPercent: Math.round(((row.actualMinutes - row.estimatedMinutes) / row.estimatedMinutes) * 100),
    }))
    .sort(
      (left, right) =>
        Math.abs(right.deltaMinutes) - Math.abs(left.deltaMinutes) ||
        right.actualMinutes - left.actualMinutes ||
        left.title.localeCompare(right.title, "zh-CN"),
    )
    .slice(0, 4);
  const deltaMinutes = actualMinutes - estimatedMinutes;

  return {
    weekStart: dates[0] ?? anchor,
    weekEnd: dates.at(-1) ?? anchor,
    days,
    totalMinutes: Math.round(totalSeconds / 60),
    totalSessions,
    averageSessionMinutes:
      totalSessions > 0 ? Math.round((totalSeconds / 60 / totalSessions) * 10) / 10 : 0,
    topTasks,
    timeAccounting: {
      estimatedMinutes,
      actualMinutes,
      deltaMinutes,
      deltaPercent: estimatedMinutes > 0 ? Math.round((deltaMinutes / estimatedMinutes) * 100) : 0,
      estimatedTaskCount: estimateRowsList.length,
      trackedTaskCount: estimateRowsList.filter((row) => row.actualMinutes > 0).length,
      topVariances,
    },
  };
}
