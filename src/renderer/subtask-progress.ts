import type { Task, TaskId } from "../shared/models";

export interface SubtaskProgress {
  total: number;
  completed: number;
}

/**
 * Projects the existing parentId/status facts into a small read-only map for
 * list rows. Deleted subtasks are omitted; no task is modified and a parent
 * is never completed implicitly when its last child is checked.
 */
export const buildSubtaskProgress = (
  tasks: readonly Pick<Task, "id" | "parentId" | "status" | "deletedAt">[],
): Map<TaskId, SubtaskProgress> => {
  const progress = new Map<TaskId, SubtaskProgress>();
  tasks.forEach((task) => {
    if (!task.parentId || task.deletedAt !== undefined) return;
    const current = progress.get(task.parentId) ?? { total: 0, completed: 0 };
    current.total += 1;
    if (task.status === "completed") current.completed += 1;
    progress.set(task.parentId, current);
  });
  return progress;
};

export const subtaskProgressLabel = (progress?: SubtaskProgress): string | undefined => {
  if (!progress || progress.total === 0) return undefined;
  return `子任务 ${progress.completed}/${progress.total}`;
};
