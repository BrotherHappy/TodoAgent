import type { Task } from "../shared/models";
import { localDateKey, weekDateKeys } from "./timeline-utils";

export type ProjectHealthStatus = "steady" | "attention" | "blocked" | "quiet";

export interface ProjectHealthSummary {
  projectId: string;
  weekStart: string;
  weekEnd: string;
  openCount: number;
  completedCount: number;
  dueThisWeekCount: number;
  overdueCount: number;
  blockedCount: number;
  unplannedCount: number;
  plannedOpenMinutes: number;
  scheduledOpenMinutes: number;
  estimatedOpenMinutes: number;
  capacityMinutes: number;
  capacityRatio: number;
  status: ProjectHealthStatus;
  statusLabel: string;
  signal: string;
  nextTask?: Task;
}

export interface ProjectHealthOptions {
  anchor?: string;
  today?: string;
  capacityMinutes?: number;
}

const priorityRank = (priority: Task["priority"]): number =>
  ({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 })[priority];

const datePart = (value?: string): string | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : localDateKey(date);
};

const taskPlanDate = (task: Task): string | undefined =>
  task.plannedDate ??
  datePart(task.timeBlock?.startAt) ??
  datePart(task.startAt) ??
  datePart(task.dueAt);

const isInRange = (date: string | undefined, start: string, end: string): boolean =>
  Boolean(date && date >= start && date <= end);

const estimateMinutes = (task: Task): number => {
  if (task.timeBlock) {
    const start = new Date(task.timeBlock.startAt).getTime();
    const end = new Date(task.timeBlock.endAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.max(5, Math.round((end - start) / 60_000));
    }
  }
  return task.estimatedMinutes && task.estimatedMinutes > 0
    ? Math.round(task.estimatedMinutes)
    : 30;
};

const taskIsScheduledInWeek = (task: Task, start: string, end: string): boolean =>
  isInRange(datePart(task.timeBlock?.startAt ?? task.startAt), start, end);

const taskSort = (left: Task, right: Task): number => {
  const leftDue = datePart(left.dueAt) ?? "9999-12-31";
  const rightDue = datePart(right.dueAt) ?? "9999-12-31";
  return priorityRank(left.priority) - priorityRank(right.priority) ||
    leftDue.localeCompare(rightDue) ||
    left.privateOrder - right.privateOrder ||
    left.title.localeCompare(right.title, "zh-CN");
};

const statusLabel = (status: ProjectHealthStatus): string => ({
  steady: "节奏稳定",
  attention: "需要看一眼",
  blocked: "有阻塞",
  quiet: "还没开始",
}[status]);

/**
 * Turns existing task facts into a project-level health signal. It is a
 * projection only: no task is moved, completed, or re-prioritized here.
 */
export function buildProjectHealthSummaries(
  tasks: readonly Task[],
  options: ProjectHealthOptions = {},
): ProjectHealthSummary[] {
  const anchor = options.anchor ?? localDateKey();
  const dates = weekDateKeys(anchor);
  const weekStart = dates[0] ?? anchor;
  const weekEnd = dates[dates.length - 1] ?? anchor;
  const today = options.today ?? localDateKey();
  const capacityMinutes = Number.isFinite(options.capacityMinutes) &&
    (options.capacityMinutes ?? 0) > 0
    ? Math.max(60, Math.round(options.capacityMinutes!))
    : 2_400;
  const dependencies = new Map(tasks.map((task) => [task.id, task]));
  const groups = new Map<string, Task[]>();
  tasks.filter((task) => !task.deletedAt && task.projectId?.trim()).forEach((task) => {
    const projectId = task.projectId!.trim();
    const current = groups.get(projectId) ?? [];
    current.push(task);
    groups.set(projectId, current);
  });

  return [...groups.entries()]
    .map(([projectId, projectTasks]) => {
      const open = projectTasks.filter((task) => task.status === "open");
      const completedCount = projectTasks.filter((task) =>
        task.status === "completed" && isInRange(datePart(task.completedAt), weekStart, weekEnd),
      ).length;
      const dueThisWeekCount = open.filter((task) =>
        isInRange(datePart(task.dueAt), weekStart, weekEnd),
      ).length;
      const overdueCount = open.filter((task) => {
        const due = datePart(task.dueAt);
        return Boolean(due && due < today);
      }).length;
      const blockedCount = open.filter((task) => task.dependencyIds.some((dependencyId) =>
        dependencies.get(dependencyId)?.status !== "completed",
      )).length;
      const unplannedCount = open.filter((task) => taskPlanDate(task) === undefined).length;
      const plannedOpenMinutes = open
        .filter((task) => isInRange(taskPlanDate(task), weekStart, weekEnd))
        .reduce((total, task) => total + estimateMinutes(task), 0);
      const scheduledOpenMinutes = open
        .filter((task) => taskIsScheduledInWeek(task, weekStart, weekEnd))
        .reduce((total, task) => total + estimateMinutes(task), 0);
      const estimatedOpenMinutes = open.reduce((total, task) => total + estimateMinutes(task), 0);
      const capacityRatio = plannedOpenMinutes / capacityMinutes;
      const status: ProjectHealthStatus = blockedCount > 0
        ? "blocked"
        : overdueCount > 0 || capacityRatio > 1
          ? "attention"
          : completedCount > 0 || scheduledOpenMinutes > 0
            ? "steady"
            : "quiet";
      const signal = status === "blocked"
        ? `${blockedCount} 项任务被依赖卡住`
        : status === "attention" && overdueCount > 0
          ? `${overdueCount} 项逾期 · 本周负载 ${Math.round(capacityRatio * 100)}%`
          : status === "attention"
            ? `本周负载 ${Math.round(capacityRatio * 100)}%，建议拆开安排`
            : status === "steady"
              ? `${completedCount} 项完成 · 还有 ${open.length} 项进行中`
              : `${open.length} 项待开始 · 其中 ${unplannedCount} 项尚未排时间`;
      return {
        projectId,
        weekStart,
        weekEnd,
        openCount: open.length,
        completedCount,
        dueThisWeekCount,
        overdueCount,
        blockedCount,
        unplannedCount,
        plannedOpenMinutes,
        scheduledOpenMinutes,
        estimatedOpenMinutes,
        capacityMinutes,
        capacityRatio,
        status,
        statusLabel: statusLabel(status),
        signal,
        nextTask: [...open].sort(taskSort)[0],
      } satisfies ProjectHealthSummary;
    })
    .sort((left, right) => {
      const statusRank: Record<ProjectHealthStatus, number> = {
        blocked: 0,
        attention: 1,
        quiet: 2,
        steady: 3,
      };
      return statusRank[left.status] - statusRank[right.status] ||
        left.projectId.localeCompare(right.projectId, "zh-CN");
    });
}
