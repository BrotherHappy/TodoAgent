import type { Task } from "../shared/models";
import { addLocalDays, localDateKey, weekDateKeys } from "./timeline-utils";

/** The compact Gantt surface starts on Monday and supports a few readable horizons. */
export const GANTT_WINDOW_DAYS = 14;
export const GANTT_WINDOW_OPTIONS = [14, 28, 84] as const;
export type GanttWindowDays = (typeof GANTT_WINDOW_OPTIONS)[number];

export const normalizeGanttWindowDays = (value: number): GanttWindowDays =>
  GANTT_WINDOW_OPTIONS.includes(value as GanttWindowDays)
    ? (value as GanttWindowDays)
    : GANTT_WINDOW_DAYS;

export const ganttWindowLabel = (windowDays: GanttWindowDays): string => {
  const weeks = Math.round(windowDays / 7);
  return `${weeks} 周`;
};

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
  critical: boolean;
  dependencyCount: number;
  bar: GanttBar;
}

export interface GanttGroup {
  projectId: string;
  label: string;
  rows: GanttRow[];
}

export interface GanttCriticalChain {
  projectId: string;
  label: string;
  taskIds: string[];
}

export interface GanttPlan {
  startDate: string;
  endDate: string;
  windowDays: GanttWindowDays;
  days: GanttDay[];
  groups: GanttGroup[];
  unscheduledTasks: Task[];
  datedTaskCount: number;
  blockedCount: number;
  criticalCount: number;
  criticalChains: GanttCriticalChain[];
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

const buildDays = (startDate: string, today: string, windowDays: GanttWindowDays): GanttDay[] =>
  Array.from({ length: windowDays }, (_, index) => {
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
 * Find the longest dependency chain per project without changing task facts.
 * A chain is only marked when it has at least two tasks; isolated tasks are
 * useful work, but calling every task "critical" would make the signal noisy.
 */
const criticalRoutesFor = (
  tasks: readonly Task[],
  spans: ReadonlyMap<string, { startDate: string; endDate: string }>,
): { ids: ReadonlySet<string>; chains: GanttCriticalChain[] } => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const datedIds = new Set(spans.keys());
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const score = (taskId: string): number => {
    const cached = memo.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 0;
    const task = byId.get(taskId);
    const span = spans.get(taskId);
    if (!task || !span || task.deletedAt) return 0;
    visiting.add(taskId);
    const duration = Math.max(1, dateDistance(span.startDate, span.endDate) + 1);
    const predecessorScore = task.dependencyIds.reduce(
      (best, dependencyId) => Math.max(best, datedIds.has(dependencyId) ? score(dependencyId) : 0),
      0,
    );
    visiting.delete(taskId);
    const total = duration + predecessorScore;
    memo.set(taskId, total);
    return total;
  };

  const successors = new Map<string, string[]>();
  for (const task of tasks) {
    if (!datedIds.has(task.id)) continue;
    for (const dependencyId of task.dependencyIds) {
      if (!datedIds.has(dependencyId)) continue;
      const next = successors.get(dependencyId) ?? [];
      next.push(task.id);
      successors.set(dependencyId, next);
    }
  }
  const terminals = tasks.filter((task) => datedIds.has(task.id) && !(successors.get(task.id)?.length));
  const critical = new Set<string>();
  const chains: GanttCriticalChain[] = [];
  const seenChains = new Set<string>();
  for (const terminal of terminals) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: Task | undefined = terminal;
    while (current && !seen.has(current.id) && datedIds.has(current.id)) {
      seen.add(current.id);
      chain.push(current.id);
      const candidates = current.dependencyIds
        .filter((dependencyId) => datedIds.has(dependencyId))
        .sort((left, right) => {
          const scoreDelta = score(right) - score(left);
          if (scoreDelta) return scoreDelta;
          return (spans.get(right)?.endDate ?? "").localeCompare(spans.get(left)?.endDate ?? "") || left.localeCompare(right);
        });
      current = candidates.length ? byId.get(candidates[0]) : undefined;
    }
    if (chain.length >= 2) {
      chain.forEach((taskId) => critical.add(taskId));
      const chainKey = chain.join("\u0000");
      if (!seenChains.has(chainKey)) {
        seenChains.add(chainKey);
        chains.push({
          projectId: taskProjectId(terminal),
          label: taskProjectLabel(terminal),
          taskIds: chain.reverse(),
        });
      }
    }
  }
  chains.sort((left, right) =>
    left.label.localeCompare(right.label, "zh-CN") ||
    right.taskIds.length - left.taskIds.length ||
    left.taskIds.join("\u0000").localeCompare(right.taskIds.join("\u0000")),
  );
  return { ids: critical, chains };
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
  windowDays: GanttWindowDays = GANTT_WINDOW_DAYS,
): GanttPlan => {
  const normalizedWindowDays = normalizeGanttWindowDays(windowDays);
  const startDate = weekDateKeys(anchorDate)[0] ?? anchorDate;
  const endDate = addLocalDays(startDate, normalizedWindowDays - 1);
  const days = buildDays(startDate, today, normalizedWindowDays);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const groupMap = new Map<string, GanttGroup>();
  const unscheduledTasks: Task[] = [];
  let datedTaskCount = 0;
  let blockedCount = 0;
  const spans = new Map<string, { startDate: string; endDate: string }>();

  for (const task of tasks) {
    if (task.deletedAt) continue;
    if (projectId !== "all" && taskProjectId(task) !== projectId) continue;
    const start = taskStartDate(task);
    if (!start) continue;
    const end = taskEndDate(task, start);
    if (end < startDate || start > endDate) continue;
    spans.set(task.id, { startDate: start, endDate: end });
  }
  const criticalRoutes = criticalRoutesFor(
    tasks.filter((task) => !task.deletedAt && (projectId === "all" || taskProjectId(task) === projectId)),
    spans,
  );

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
    const critical = criticalRoutes.ids.has(task.id);
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
      critical,
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
    windowDays: normalizedWindowDays,
    days,
    groups,
    unscheduledTasks,
    datedTaskCount,
    blockedCount,
    criticalCount: criticalRoutes.ids.size,
    criticalChains: criticalRoutes.chains,
  };
};
