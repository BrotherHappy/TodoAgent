import type { Task, TaskProject } from "../shared/models";

export interface PetProjectChapter {
  projectId: string;
  name: string;
  color: TaskProject["color"];
  totalCount: number;
  completedCount: number;
  openCount: number;
  progress: number;
  nextTaskId?: string;
  nextTaskTitle?: string;
}

const priorityOrder: Record<Task["priority"], number> = {
  none: 4,
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const compareNextTask = (left: Task, right: Task): number => {
  const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
  const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  const priority = priorityOrder[left.priority] - priorityOrder[right.priority];
  if (priority !== 0) return priority;
  if (left.privateOrder !== right.privateOrder) return left.privateOrder - right.privateOrder;
  return left.title.localeCompare(right.title, "zh-Hans") || left.id.localeCompare(right.id);
};

/**
 * Projects existing project/task facts into small Todo Pet adventure
 * chapters. It is intentionally read-only: a chapter never creates a task,
 * changes project state or becomes another progress counter.
 */
export function projectPetChapters(
  tasks: readonly Task[],
  projects: readonly TaskProject[],
  maxChapters = 4,
): PetProjectChapter[] {
  const taskById = new Map<string, Task>();
  for (const task of tasks) {
    if (!task.deletedAt && !taskById.has(task.id)) taskById.set(task.id, task);
  }
  const grouped = new Map<string, Task[]>();
  for (const task of taskById.values()) {
    if (!task.projectId) continue;
    const group = grouped.get(task.projectId) ?? [];
    group.push(task);
    grouped.set(task.projectId, group);
  }
  const chapters = projects
    .filter((project) => !project.archived && grouped.has(project.id))
    .map((project) => {
      const projectTasks = grouped.get(project.id) ?? [];
      const openTasks = projectTasks
        .filter((task) => task.status === "open")
        .sort(compareNextTask);
      const completedCount = projectTasks.filter((task) => task.status === "completed").length;
      return {
        projectId: project.id,
        name: project.name,
        color: project.color,
        totalCount: projectTasks.length,
        completedCount,
        openCount: openTasks.length,
        progress: projectTasks.length ? Math.round((completedCount / projectTasks.length) * 100) : 0,
        nextTaskId: openTasks[0]?.id,
        nextTaskTitle: openTasks[0]?.title,
      } satisfies PetProjectChapter;
    });
  const limit = Number.isFinite(maxChapters)
    ? Math.max(1, Math.min(8, Math.floor(maxChapters)))
    : 4;
  return chapters
    .sort((left, right) =>
      right.openCount - left.openCount ||
      right.progress - left.progress ||
      left.name.localeCompare(right.name, "zh-Hans") ||
      left.projectId.localeCompare(right.projectId),
    )
    .slice(0, limit);
}
