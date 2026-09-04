import type { Task } from "../shared/models";
import { buildPetReviewSummary, type PetReviewBucketKey } from "./pet-review";

export type PetReviewAction = "complete" | "today" | "focus";

export interface PetReviewSessionItem {
  task: Task;
  reasons: string[];
}

const reasonLabels: Record<PetReviewBucketKey, string> = {
  overdue: "逾期",
  blocked: "被阻塞",
  unplanned: "待排时间",
};

/**
 * Snapshot the read-only review queue into a stable, guided-session order.
 * Reasons are derived from the same summary buckets shown in the home card;
 * no task state is duplicated or written here.
 */
export const buildPetReviewSessionItems = (
  tasks: readonly Task[],
  today?: string,
): PetReviewSessionItem[] => {
  const summary = buildPetReviewSummary(tasks, today);
  const reasons = new Map<string, string[]>();
  const buckets: Array<[PetReviewBucketKey, Task[]]> = [
    ["overdue", summary.overdue.tasks],
    ["blocked", summary.blocked.tasks],
    ["unplanned", summary.unplanned.tasks],
  ];
  for (const [key, bucketTasks] of buckets) {
    for (const task of bucketTasks) {
      const current = reasons.get(task.id) ?? [];
      current.push(reasonLabels[key]);
      reasons.set(task.id, current);
    }
  }
  return summary.tasks.map((task) => ({
    task,
    reasons: reasons.get(task.id) ?? [],
  }));
};

