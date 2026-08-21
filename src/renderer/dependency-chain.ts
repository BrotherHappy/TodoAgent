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

export type DependencyGraphNodeKind =
  | "ancestor"
  | "current"
  | "downstream"
  | "missing";

export interface DependencyGraphNode {
  id: string;
  title: string;
  status: Task["status"] | "missing";
  kind: DependencyGraphNodeKind;
  depth: number;
}

export interface DependencyGraphEdge {
  from: string;
  to: string;
}

export interface DependencyGraph {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
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

/**
 * Projects the same local dependency facts into a compact graph model for an
 * opt-in advanced view. It deliberately includes missing IDs as placeholder
 * nodes and never repairs, removes, or otherwise mutates relationships.
 */
export function buildDependencyGraph(
  selected: DependencyTask,
  tasks: readonly DependencyTask[],
): DependencyGraph {
  const chain = buildDependencyChain(selected, tasks);
  const ancestors = new Map(chain.ancestors.map((item) => [item.task.id, item]));
  const downstream = new Map(chain.downstream.map((item) => [item.task.id, item]));
  const missingIds = new Set(chain.missingDependencyIds);
  const includedIds = new Set<string>([
    selected.id,
    ...ancestors.keys(),
    ...downstream.keys(),
    ...missingIds,
  ]);
  const byId = new Map<string, DependencyTask>();
  for (const task of tasks) byId.set(task.id, task);
  byId.set(selected.id, selected);

  const nodes: DependencyGraphNode[] = [];
  for (const id of includedIds) {
    if (id === selected.id) {
      nodes.push({
        id,
        title: selected.title,
        status: selected.status,
        kind: "current",
        depth: 0,
      });
      continue;
    }
    if (missingIds.has(id) && !byId.has(id)) {
      nodes.push({
        id,
        title: "依赖暂时不可见",
        status: "missing",
        kind: "missing",
        depth: 1,
      });
      continue;
    }
    const task = byId.get(id);
    if (!task) continue;
    const ancestor = ancestors.get(id);
    const dependent = downstream.get(id);
    if (ancestor) {
      nodes.push({
        id,
        title: task.title,
        status: task.status,
        kind: "ancestor",
        depth: ancestor.depth,
      });
    } else if (dependent) {
      nodes.push({
        id,
        title: task.title,
        status: task.status,
        kind: "downstream",
        depth: dependent.depth,
      });
    }
  }
  const knownNodes = new Set(nodes.map((node) => node.id));
  const edges = new Map<string, DependencyGraphEdge>();
  for (const task of [selected, ...tasks]) {
    if (!knownNodes.has(task.id)) continue;
    for (const dependencyId of task.dependencyIds) {
      if (!knownNodes.has(dependencyId)) continue;
      const edge = { from: dependencyId, to: task.id };
      edges.set(`${edge.from}->${edge.to}`, edge);
    }
  }
  const kindOrder: Record<DependencyGraphNodeKind, number> = {
    ancestor: 0,
    missing: 1,
    current: 2,
    downstream: 3,
  };
  nodes.sort(
    (left, right) =>
      kindOrder[left.kind] - kindOrder[right.kind] ||
      (left.kind === "ancestor" ? right.depth - left.depth : left.depth - right.depth) ||
      left.title.localeCompare(right.title, "zh-CN"),
  );
  return {
    nodes,
    edges: [...edges.values()].sort(
      (left, right) =>
        left.from.localeCompare(right.from, "zh-CN") ||
        left.to.localeCompare(right.to, "zh-CN"),
    ),
  };
}
