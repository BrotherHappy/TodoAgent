import type { Task } from "./models";

/**
 * A task belongs to Inbox only while it is genuinely unscheduled. Keep this
 * rule shared by the service, offline renderer fallback, and triage ritual so
 * a task cannot move between different Inbox meanings during a refresh.
 */
export function isInboxTask(task: Task): boolean {
  return (
    task.status === "open" &&
    task.deletedAt === undefined &&
    task.projectId === undefined &&
    task.listId === undefined &&
    task.plannedDate === undefined &&
    task.deferUntil === undefined &&
    task.startAt === undefined &&
    task.dueAt === undefined
  );
}
