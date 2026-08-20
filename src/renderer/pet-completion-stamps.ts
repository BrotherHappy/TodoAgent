import type { Task } from "../shared/models";
import type { PetReward } from "../shared/pet-types";

export interface PetCompletionStamp {
  taskId: string;
  title: string;
  completedAt: string;
  source: "local" | "feishu";
  priority: Task["priority"];
  isToday: boolean;
  /** A reward is eventually reconciled by the main process; the stamp itself
   * still appears immediately from the completed task fact. */
  rewardRecorded: boolean;
  icon: "✦" | "✓";
  label: "今日盖章" | "完成印记";
}

export interface PetCompletionStampProjection {
  stamps: PetCompletionStamp[];
  todayCount: number;
  totalCount: number;
}

const dateKey = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const validTime = (value?: string): number => {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const localDateForIso = (value: string): string => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dateKey(parsed) : "";
};

/**
 * Project a small “completion stamp wall” from task facts. This is deliberately
 * read-only: a stamp never creates a second completion record and never
 * changes a Feishu field. Rewards are only used to show whether the existing
 * PetService reconciliation has caught up with the task.
 */
export function projectPetCompletionStamps(
  tasks: readonly Task[],
  rewards: readonly PetReward[] = [],
  now = new Date(),
  limit = 8,
): PetCompletionStampProjection {
  const safeLimit = Math.max(1, Math.min(12, Math.floor(limit)));
  const today = dateKey(now);
  const rewardedTaskIds = new Set(
    rewards
      .filter((reward) => reward.source === "task" && typeof reward.sourceId === "string")
      .map((reward) => reward.sourceId),
  );
  const seen = new Set<string>();
  const completed = tasks
    .filter((task) => {
      if (task.deletedAt || task.status !== "completed" || !task.completedAt) return false;
      if (seen.has(task.id)) return false;
      if (!Number.isFinite(validTime(task.completedAt))) return false;
      seen.add(task.id);
      return true;
    })
    .sort((left, right) => {
      const completionDelta = validTime(right.completedAt) - validTime(left.completedAt);
      if (completionDelta !== 0) return completionDelta;
      return left.id.localeCompare(right.id);
    });
  const stamps = completed.slice(0, safeLimit).map((task) => {
    const isToday = localDateForIso(task.completedAt!) === today;
    return {
      taskId: task.id,
      title: task.title,
      completedAt: task.completedAt!,
      source: task.source.type,
      priority: task.priority,
      isToday,
      rewardRecorded: rewardedTaskIds.has(task.id),
      icon: isToday ? "✦" : "✓",
      label: isToday ? "今日盖章" : "完成印记",
    } satisfies PetCompletionStamp;
  });
  return {
    stamps,
    todayCount: completed.filter((task) => localDateForIso(task.completedAt!) === today).length,
    totalCount: completed.length,
  };
}
