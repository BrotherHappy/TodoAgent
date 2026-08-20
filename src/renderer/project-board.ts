import type { Task } from "../shared/models";

export type ProjectBoardColumnKey = "backlog" | "blocked" | "done";

export interface ProjectBoardColumn {
  key: ProjectBoardColumnKey;
  title: string;
  hint: string;
  tasks: Task[];
}

const priorityRank: Record<Task["priority"], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

export function projectBoardColumn(
  task: Task,
  byId: ReadonlyMap<string, Task>,
): ProjectBoardColumnKey {
  if (task.status === "completed") return "done";
  const blocked = task.dependencyIds.some((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return dependency === undefined || dependency.status !== "completed";
  });
  return blocked ? "blocked" : "backlog";
}

export function buildProjectBoardColumns(
  tasks: readonly Task[],
  projectId?: string,
): ProjectBoardColumn[] {
  const candidates = tasks.filter(
    (task) =>
      !task.deletedAt &&
      task.status !== "cancelled" &&
      task.projectId !== undefined &&
      (projectId === undefined || task.projectId === projectId),
  );
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const groups: Record<ProjectBoardColumnKey, Task[]> = {
    backlog: [],
    blocked: [],
    done: [],
  };
  candidates.forEach((task) => groups[projectBoardColumn(task, byId)].push(task));
  const sortTasks = (left: Task, right: Task): number =>
    priorityRank[right.priority] - priorityRank[left.priority] ||
    (left.privateOrder ?? 0) - (right.privateOrder ?? 0) ||
    (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") ||
    left.title.localeCompare(right.title, "zh-CN");
  (Object.keys(groups) as ProjectBoardColumnKey[]).forEach((key) =>
    groups[key].sort(sortTasks),
  );
  return [
    { key: "backlog", title: "待处理", hint: "没有未完成前置依赖", tasks: groups.backlog },
    { key: "blocked", title: "被阻塞", hint: "先完成依赖任务", tasks: groups.blocked },
    { key: "done", title: "已完成", hint: "本项目的完成记录", tasks: groups.done },
  ];
}

export function projectIdsForBoard(tasks: readonly Task[]): string[] {
  return Array.from(
    new Set(
      tasks
        .filter((task) => !task.deletedAt && task.projectId?.trim())
        .map((task) => task.projectId!.trim()),
    ),
  ).sort((left, right) => left.localeCompare(right, "zh-CN"));
}
