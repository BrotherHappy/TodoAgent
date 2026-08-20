import type { LocalDate, Task } from "../shared/models";
import { addLocalDays, localDateKey, weekDateKeys } from "./timeline-utils";

/** A deliberately small, local-only planning cycle. It is a projection over
 * existing task fields and never becomes a Feishu field or sync payload. */
export type WorkCycleWeeks = 1 | 2;

export interface WorkCycleDefinition {
  startDate: LocalDate;
  endDate: LocalDate;
  weeks: WorkCycleWeeks;
  capacityMinutes: number;
}

export interface WorkCycleMetrics {
  cycle: WorkCycleDefinition;
  openTasks: Task[];
  completedTasks: Task[];
  scheduledTasks: Task[];
  unscheduledTasks: Task[];
  candidateTasks: Task[];
  plannedMinutes: number;
  capacityMinutes: number;
  remainingMinutes: number;
  loadRatio: number;
  overloadMinutes: number;
}

const priorityRank = (priority: Task["priority"]): number =>
  ({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 }[priority] ?? 4);

const datePart = (value?: string): LocalDate | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : localDateKey(date);
};

const taskDate = (task: Task): LocalDate | undefined => {
  if (task.status === "completed") return datePart(task.completedAt);
  return (
    datePart(task.timeBlock?.startAt) ??
    datePart(task.startAt) ??
    task.plannedDate ??
    datePart(task.dueAt)
  );
};

const assignedDate = (task: Task): LocalDate | undefined =>
  datePart(task.timeBlock?.startAt) ?? datePart(task.startAt) ?? task.plannedDate;

const dueDate = (task: Task): LocalDate | undefined => datePart(task.dueAt);

const hasTimedPlacement = (task: Task): boolean =>
  Boolean(
    (task.timeBlock?.startAt && !task.startAtIsAllDay) ||
      (task.startAt && !task.startAtIsAllDay),
  );

const durationMinutes = (task: Task): number => {
  if (task.timeBlock) {
    const start = new Date(task.timeBlock.startAt).getTime();
    const end = new Date(task.timeBlock.endAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.max(5, Math.round((end - start) / 60_000));
    }
  }
  return task.estimatedMinutes && task.estimatedMinutes > 0
    ? Math.max(5, Math.round(task.estimatedMinutes))
    : 30;
};

const taskSort = (left: Task, right: Task): number => {
  const leftDue = dueDate(left) ?? "9999-12-31";
  const rightDue = dueDate(right) ?? "9999-12-31";
  return (
    priorityRank(left.priority) - priorityRank(right.priority) ||
    leftDue.localeCompare(rightDue) ||
    left.privateOrder - right.privateOrder ||
    left.title.localeCompare(right.title, "zh-CN")
  );
};

const validWeeks = (weeks: number): WorkCycleWeeks => (weeks === 2 ? 2 : 1);

const safeCapacity = (capacityMinutes: number): number =>
  Number.isFinite(capacityMinutes) && capacityMinutes > 0
    ? Math.max(60, Math.round(capacityMinutes))
    : 2_400;

export const workCycleFor = (
  anchor: LocalDate,
  weeks: WorkCycleWeeks = 1,
  weeklyCapacityMinutes = 2_400,
): WorkCycleDefinition => {
  const normalizedWeeks = validWeeks(weeks);
  const startDate = weekDateKeys(anchor)[0] ?? anchor;
  return {
    startDate,
    endDate: addLocalDays(startDate, normalizedWeeks * 7 - 1),
    weeks: normalizedWeeks,
    capacityMinutes: safeCapacity(weeklyCapacityMinutes) * normalizedWeeks,
  };
};

const inCycle = (value: LocalDate | undefined, cycle: WorkCycleDefinition): boolean =>
  Boolean(value && value >= cycle.startDate && value <= cycle.endDate);

const relevantToCycle = (task: Task, cycle: WorkCycleDefinition): boolean => {
  const date = taskDate(task);
  const due = dueDate(task);
  return inCycle(date, cycle) || Boolean(due && due <= cycle.endDate);
};

/**
 * Builds a read-only cycle projection. `plannedMinutes` only counts open work
 * explicitly assigned to the cycle (planned date, start time or time block),
 * while `candidateTasks` surfaces work that still needs a decision.
 */
export const buildWorkCycleMetrics = (
  tasks: readonly Task[],
  cycle: WorkCycleDefinition,
): WorkCycleMetrics => {
  const active = tasks.filter((task) => !task.deletedAt);
  const completedTasks = active
    .filter((task) => task.status === "completed" && inCycle(datePart(task.completedAt), cycle))
    .sort(taskSort);
  const open = active.filter((task) => task.status === "open");
  const openTasks = open.filter((task) => relevantToCycle(task, cycle)).sort(taskSort);
  const scheduledTasks = open
    .filter((task) => hasTimedPlacement(task) && inCycle(taskDate(task), cycle))
    .sort(taskSort);
  const assignedOpen = open.filter((task) => inCycle(assignedDate(task), cycle));
  const unscheduledTasks = assignedOpen
    .filter((task) => !hasTimedPlacement(task))
    .sort(taskSort);
  const candidateTasks = open
    .filter((task) => {
      if (hasTimedPlacement(task) && inCycle(taskDate(task), cycle)) return false;
      const assigned = assignedDate(task);
      const due = dueDate(task);
      return (
        !assigned ||
        inCycle(assigned, cycle) ||
        Boolean(due && due <= cycle.endDate)
      );
    })
    .sort(taskSort)
    .slice(0, 5);
  const plannedMinutes = assignedOpen.reduce((total, task) => total + durationMinutes(task), 0);
  const capacityMinutes = safeCapacity(cycle.capacityMinutes);
  return {
    cycle,
    openTasks,
    completedTasks,
    scheduledTasks,
    unscheduledTasks,
    candidateTasks,
    plannedMinutes,
    capacityMinutes,
    remainingMinutes: Math.max(0, capacityMinutes - plannedMinutes),
    loadRatio: plannedMinutes / capacityMinutes,
    overloadMinutes: Math.max(0, plannedMinutes - capacityMinutes),
  };
};

export const formatCycleMinutes = (minutes: number): string => {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} 分钟`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
};
