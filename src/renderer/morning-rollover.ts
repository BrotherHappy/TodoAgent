import type { Task } from "../shared/models";

export interface MorningRolloverSuggestion {
  task: Task;
  plannedDate: string;
  daysAgo: number;
  reason: string;
}

const PRIORITY_RANK: Record<Task["priority"], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function dateAtNoon(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.getFullYear() === Number(match[1]) &&
      date.getMonth() + 1 === Number(match[2]) &&
      date.getDate() === Number(match[3])
    ? date
    : undefined;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.max(1, Math.round((later.getTime() - earlier.getTime()) / 86_400_000));
}

function dueTimestamp(task: Task): number {
  if (!task.dueAt) return Number.POSITIVE_INFINITY;
  const value = new Date(task.dueAt).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/**
 * Suggest unfinished private Today plans from earlier local dates.
 *
 * This is intentionally a projection only: it does not move, complete, or
 * sync a task. The caller decides whether the user wants to bring a task
 * back into today's plan.
 */
export function suggestMorningRollover(
  tasks: readonly Task[],
  date: Date | string = new Date(),
  maxSuggestions = 3,
): MorningRolloverSuggestion[] {
  const today = typeof date === "string" ? dateAtNoon(date) : dateAtNoon(localDateKey(date));
  if (!today || !Number.isFinite(maxSuggestions) || maxSuggestions <= 0) return [];
  const todayKey = localDateKey(today);

  return tasks
    .flatMap((task) => {
      if (task.status !== "open" || task.deletedAt || !task.plannedDate) return [];
      const planned = dateAtNoon(task.plannedDate);
      if (!planned || task.plannedDate >= todayKey) return [];
      const daysAgo = daysBetween(today, planned);
      return [{
        task,
        plannedDate: task.plannedDate,
        daysAgo,
        reason: daysAgo === 1 ? "昨天的计划还没完成" : `${daysAgo} 天前的计划还没完成`,
      }];
    })
    .sort((left, right) =>
      PRIORITY_RANK[left.task.priority] - PRIORITY_RANK[right.task.priority] ||
      dueTimestamp(left.task) - dueTimestamp(right.task) ||
      right.daysAgo - left.daysAgo ||
      (left.task.privateOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.task.privateOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.task.id.localeCompare(right.task.id),
    )
    .slice(0, Math.min(7, Math.floor(maxSuggestions)));
}
