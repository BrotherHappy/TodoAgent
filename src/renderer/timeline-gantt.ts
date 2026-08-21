import type { Task } from "../shared/models";
import { addLocalDays, localDateKey, weekDateKeys } from "./timeline-utils";

/** The compact Gantt surface shows two Monday-first weeks at a time. */
export const GANTT_WINDOW_DAYS = 14;

export interface GanttDay {
  date: string;
  label: string;
  weekday: string;
  isWeekend: boolean;
  isToday: boolean;
}

export interface GanttBar {
  startDate: string;
  endDate: string;
  startOffset: number;
  spanDays: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  progressPercent?: number;
}

export interface GanttRow {
  task: Task;
  projectLabel: string;
  blocked: boolean;
  dependencyCount: number;
  bar: GanttBar;
}

export interface GanttGroup {
  projectId: string;
  label: string;
  rows: GanttRow[];
}

export interface GanttPlan {
  startDate: string;
  endDate: string;
  days: GanttDay[];
  groups: GanttGroup[];
  unscheduledTasks: Task[];
  datedTaskCount: number;
  blockedCount: number;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;
const DAY_MINUTES = 8 * 60;

const dateForKey = (value: string): Date => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
};

const dateDistance = (start: string, end: string): number => {
  const milliseconds = dateForKey(end).getTime() - dateForKey(start).getTime();
  return Math.round(milliseconds / 86_400_000);
};

const temporalDateKey = (value?: string): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : localDateKey(date);
};

const taskProjectId = (task: Task): string => task.projectId?.trim() || "__ungrouped__";

const taskProjectLabel = (task: Task): string => task.projectId?.trim() || "未分组";

const taskStartDate = (task: Task): string | undefined =>
  temporalDateKey(task.timeBlock?.startAt) ??
  temporalDateKey(task.startAt) ??
  task.plannedDate ??
  temporalDateKey(task.dueAt);

const taskEndDate = (task: Task, startDate: string): string => {
  const explicitEnd =
    temporalDateKey(task.timeBlock?.endAt) ?? temporalDateKey(task.dueAt);
  if (explicitEnd) return explicitEnd < startDate ? startDate : explicitEnd;
  const estimated = task.estimatedMinutes && task.estimatedMinutes > 0
    ? Math.ceil(task.estimatedMinutes / DAY_MINUTES)
    : 1;
  return addLocalDays(startDate, Math.max(0, estimated - 1));
};

const priorityRank = (task: Task): number =>
  ({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 })[task.priority];

const sortTasks = (left: Task, right: Task): number =>
  priorityRank(left) - priorityRank(right) ||
  left.privateOrder - right.privateOrder ||
  left.title.localeCompare(right.title, "zh-CN") ||
  left.id.localeCompare(right.id);

const buildDays = (startDate: string, today: string): GanttDay[] =>
  Array.from({ length: GANTT_WINDOW_DAYS }, (_, index) => {
    const date = addLocalDays(startDate, index);
    const parsed = dateForKey(date);
    return {
      date,
      label: `${parsed.getMonth() + 1}/${parsed.getDate()}`,
      weekday: WEEKDAYS[parsed.getDay()] ?? "",
      isWeekend: parsed.getDay() === 0 || parsed.getDay() === 6,
      isToday: date === today,
    };
  });

const progressFor = (task: Task): number | undefined => {
  if (task.status === "completed") return 100;
  if (
    task.estimatedMinutes &&
    task.estimatedMinutes > 0 &&
    task.actualMinutes &&
    task.actualMinutes > 0
  ) {
    return Math.min(100, Math.max(4, Math.round((task.actualMinutes / task.estimatedMinutes) * 100)));
  }
  return undefined;
};

/**
 * Build a read-only project timeline from the canonical Task snapshot.
 *
 * The Gantt view deliberately projects dates only: it never invents a task,
 * changes a due date, or writes a time block. Tasks without any date remain
 * visible in the unplanned tray so switching views cannot make work disappear.
 */
export const buildGanttPlan = (
  tasks: readonly Task[],
  anchorDate: string,
  projectId = "all",
  today = localDateKey(),
): GanttPlan => {
  const startDate = weekDateKeys(anchorDate)[0] ?? anchorDate;
  const endDate = addLocalDays(startDate, GANTT_WINDOW_DAYS - 1);
  const days = buildDays(startDate, today);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const groupMap = new Map<string, GanttGroup>();
  const unscheduledTasks: Task[] = [];
  let datedTaskCount = 0;
  let blockedCount = 0;

  for (const task of tasks) {
    if (task.deletedAt) continue;
    if (projectId !== "all" && taskProjectId(task) !== projectId) continue;
    const start = taskStartDate(task);
    if (!start) {
      unscheduledTasks.push(task);
      continue;
    }
    const end = taskEndDate(task, start);
    if (end < startDate || start > endDate) continue;
    datedTaskCount += 1;
    const visibleStart = start < startDate ? startDate : start;
    const visibleEnd = end > endDate ? endDate : end;
    const blocked =
      task.status === "open" &&
      task.dependencyIds.some((dependencyId) => {
        const dependency = taskById.get(dependencyId);
        return !dependency || dependency.status !== "completed";
      });
    if (blocked) blockedCount += 1;
    const groupId = taskProjectId(task);
    const group = groupMap.get(groupId) ?? {
      projectId: groupId,
      label: taskProjectLabel(task),
      rows: [],
    };
    group.rows.push({
      task,
      projectLabel: group.label,
      blocked,
      dependencyCount: task.dependencyIds.length,
      bar: {
        startDate: start,
        endDate: end,
        startOffset: Math.max(0, dateDistance(startDate, visibleStart)),
        spanDays: Math.max(1, dateDistance(visibleStart, visibleEnd) + 1),
        clippedStart: start < startDate,
        clippedEnd: end > endDate,
        progressPercent: progressFor(task),
      },
    });
    groupMap.set(groupId, group);
  }

  for (const group of groupMap.values()) {
    group.rows.sort((left, right) =>
      left.bar.startDate.localeCompare(right.bar.startDate) ||
      sortTasks(left.task, right.task),
    );
  }
  const groups = Array.from(groupMap.values()).sort((left, right) => {
    if (left.projectId === "__ungrouped__") return 1;
    if (right.projectId === "__ungrouped__") return -1;
    return left.label.localeCompare(right.label, "zh-CN");
  });
  unscheduledTasks.sort(sortTasks);

  return {
    startDate,
    endDate,
    days,
    groups,
    unscheduledTasks,
    datedTaskCount,
    blockedCount,
  };
};
