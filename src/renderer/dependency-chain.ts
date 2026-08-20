import type { Task } from "../shared/models";

export interface DependencyChainItem {
  task: Pick<Task, "id" | "title" | "status">;
  depth: number;
}

export interface DependencyChain {
  /** Tasks that must be completed before the selected task. */
  ancestors: DependencyChainItem[];
  /** Tasks that directly or indirectly wait on the selected task. */
  downstream: DependencyChainItem[];
  /** IDs retained in the task but absent from the current readable snapshot. */
  missingDependencyIds: string[];
  /** Defensive signal for imported or externally edited cyclic graphs. */
  cycleDetected: boolean;
}

type DependencyTask = Pick<Task, "id" | "title" | "status" | "dependencyIds">;

const byDepthThenTitle = (
  left: DependencyChainItem,
  right: DependencyChainItem,
): number =>
  right.depth - left.depth || left.task.title.localeCompare(right.task.title, "zh-CN");

/**
 * Projects the dependency graph around one task without mutating the task
 * model. The result deliberately keeps missing IDs visible: a missing remote
 * task is a blocked fact, not permission to silently remove a relationship.
 */
export function buildDependencyChain(
  selected: DependencyTask,
  tasks: readonly DependencyTask[],
): DependencyChain {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  byId.set(selected.id, selected);
  const ancestors = new Map<string, DependencyChainItem>();
  const missingDependencyIds = new Set<string>();
  let cycleDetected = false;

  const visitAncestors = (
    taskId: string,
    depth: number,
    path: ReadonlySet<string>,
  ): void => {
    const task = byId.get(taskId);
    if (!task) {
      missingDependencyIds.add(taskId);
      return;
    }
    if (path.has(taskId)) {
      cycleDetected = true;
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(taskId);
    for (const dependencyId of task.dependencyIds) {
      if (nextPath.has(dependencyId)) {
        cycleDetected = true;
        continue;
      }
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        missingDependencyIds.add(dependencyId);
        continue;
      }
      const previous = ancestors.get(dependencyId);
      if (!previous || depth < previous.depth) {
        ancestors.set(dependencyId, { task: dependency, depth });
      }
      visitAncestors(dependencyId, depth + 1, nextPath);
    }
  };
  visitAncestors(selected.id, 1, new Set());

  const reverse = new Map<string, DependencyTask[]>();
  for (const task of tasks) {
    for (const dependencyId of task.dependencyIds) {
      const dependents = reverse.get(dependencyId) ?? [];
      dependents.push(task);
      reverse.set(dependencyId, dependents);
    }
  }
  const downstream = new Map<string, DependencyChainItem>();
  const visitDownstream = (
    taskId: string,
    depth: number,
    path: ReadonlySet<string>,
  ): void => {
    if (path.has(taskId)) {
      cycleDetected = true;
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(taskId);
    for (const dependent of reverse.get(taskId) ?? []) {
      if (dependent.id === selected.id) {
        cycleDetected = true;
        continue;
      }
      const previous = downstream.get(dependent.id);
      if (!previous || depth < previous.depth) {
        downstream.set(dependent.id, { task: dependent, depth });
      }
      visitDownstream(dependent.id, depth + 1, nextPath);
    }
  };
  visitDownstream(selected.id, 1, new Set());

  return {
    ancestors: [...ancestors.values()].sort(byDepthThenTitle),
    downstream: [...downstream.values()].sort(
      (left, right) => left.depth - right.depth || left.task.title.localeCompare(right.task.title, "zh-CN"),
    ),
    missingDependencyIds: [...missingDependencyIds].sort(),
    cycleDetected,
  };
}
