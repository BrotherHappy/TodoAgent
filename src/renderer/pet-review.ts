import type { Task } from "../shared/models";
import { localDateKey } from "./timeline-utils";

export type PetReviewBucketKey = "overdue" | "blocked" | "unplanned";

export interface PetReviewBucket {
  key: PetReviewBucketKey;
  label: string;
  hint: string;
  tasks: Task[];
}

export interface PetReviewSummary {
  localDate: string;
  overdue: PetReviewBucket;
  blocked: PetReviewBucket;
  unplanned: PetReviewBucket;
  tasks: Task[];
  headline: string;
  clear: boolean;
  nextTask?: Task;
}

const datePart = (value?: string): string | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : localDateKey(parsed);
};

const priorityRank = (priority: Task["priority"]): number =>
  ({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 })[priority];

const dueKey = (task: Task): string =>
  datePart(task.dueAt) ?? datePart(task.plannedDate) ?? "9999-12-31";

const taskSort = (left: Task, right: Task): number =>
  priorityRank(left.priority) - priorityRank(right.priority) ||
  dueKey(left).localeCompare(dueKey(right)) ||
  left.privateOrder - right.privateOrder ||
  left.title.localeCompare(right.title, "zh-CN");

const bucket = (
  key: PetReviewBucketKey,
  label: string,
  hint: string,
  tasks: Task[],
): PetReviewBucket => ({
  key,
  label,
  hint,
  tasks: tasks.sort(taskSort),
});

/**
 * Builds the small, factual queue the pet can use for a weekly review. A task
 * may appear in more than one bucket, while `tasks` is de-duplicated for the
 * summary count. This projection never writes, moves, or completes anything.
 */
export const buildPetReviewSummary = (
  tasks: readonly Task[],
  today = localDateKey(),
): PetReviewSummary => {
  const visible = tasks.filter((task) => !task.deletedAt && task.status === "open");
  const dependencies = new Map(tasks.map((task) => [task.id, task]));
  const overdue = visible.filter((task) => {
    const due = datePart(task.dueAt);
    const planned = datePart(task.plannedDate);
    return Boolean((due && due < today) || (planned && planned < today));
  });
  const blocked = visible.filter((task) => task.dependencyIds.some((dependencyId) =>
    dependencies.get(dependencyId)?.status !== "completed",
  ));
  const unplanned = visible.filter((task) =>
    !task.plannedDate && !task.timeBlock?.startAt && !task.startAt,
  );
  const unique = new Map<string, Task>();
  [...overdue, ...blocked, ...unplanned].forEach((task) => unique.set(task.id, task));
  const reviewed = [...unique.values()].sort(taskSort);
  const counts = [overdue.length, blocked.length, unplanned.length].filter((count) => count > 0);
  const headline = reviewed.length === 0
    ? "眼下没有需要特别整理的任务，按自己的节奏继续。"
    : `有 ${reviewed.length} 项任务值得看一眼${counts.length > 1 ? "，可以分几次慢慢处理" : ""}。`;
  return {
    localDate: today,
    overdue: bucket("overdue", "逾期", "已经过了计划或截止日期", overdue),
    blocked: bucket("blocked", "被阻塞", "依赖的前置任务还没有完成", blocked),
    unplanned: bucket("unplanned", "待排时间", "还没有安排到具体的一天或时间块", unplanned),
    tasks: reviewed,
    headline,
    clear: reviewed.length === 0,
    nextTask: reviewed[0],
  };
};
