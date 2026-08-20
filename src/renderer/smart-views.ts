import type { Task, TaskPriority, TaskSourceType, TaskView } from "../shared/models";

export const SMART_VIEWS_STORAGE_KEY = "todoAgentSmartViews";
export const SMART_VIEW_LIMIT = 24;

export type SmartViewDateFilter =
  | "any"
  | "overdue"
  | "today"
  | "next-7-days"
  | "no-date";

/** Stable, explainable sort modes for saved perspectives.  `manual` keeps the
 * collection's existing order (including Today drag order); every other mode
 * is a deterministic projection over the current task snapshot. */
export type SmartViewSort =
  | "manual"
  | "priority"
  | "due"
  | "title"
  | "created";

export const smartViewSortLabels: Record<SmartViewSort, string> = {
  manual: "默认顺序",
  priority: "优先级（高到低）",
  due: "截止时间（近到远）",
  title: "标题（A–Z）",
  created: "创建时间（新到旧）",
};

export interface SmartViewDefinition {
  id: string;
  name: string;
  route: TaskView;
  priority: TaskPriority | "all";
  projectId: string | "all";
  tag: string | "all";
  /** A manual, local-only context such as office or home. */
  context: string | "all";
  dateFilter: SmartViewDateFilter;
  sort: SmartViewSort;
  sourceType?: TaskSourceType;
  createdAt: string;
  updatedAt: string;
}

export interface SmartViewDraft {
  name: string;
  route: TaskView;
  priority: TaskPriority | "all";
  projectId: string | "all";
  tag?: string | "all";
  context?: string | "all";
  dateFilter?: SmartViewDateFilter;
  sort?: SmartViewSort;
  sourceType?: TaskSourceType;
}

const isTaskView = (value: unknown): value is TaskView =>
  value === "inbox" ||
  value === "today" ||
  value === "upcoming" ||
  value === "all" ||
  value === "completed" ||
  value === "trash";

const isPriority = (value: unknown): value is TaskPriority | "all" =>
  value === "all" ||
  value === "none" ||
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "urgent";

const isSource = (value: unknown): value is TaskSourceType =>
  value === "local" || value === "feishu";

const isDateFilter = (value: unknown): value is SmartViewDateFilter =>
  value === "any" ||
  value === "overdue" ||
  value === "today" ||
  value === "next-7-days" ||
  value === "no-date";

const isSort = (value: unknown): value is SmartViewSort =>
  value === "manual" ||
  value === "priority" ||
  value === "due" ||
  value === "title" ||
  value === "created";

const valid = (value: unknown): value is SmartViewDefinition => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.name === "string" &&
    item.name.trim().length > 0 &&
    item.name.length <= 60 &&
    isTaskView(item.route) &&
    isPriority(item.priority) &&
    (item.projectId === "all" || typeof item.projectId === "string") &&
    (item.tag === undefined || item.tag === "all" || typeof item.tag === "string") &&
    (item.context === undefined || item.context === "all" || typeof item.context === "string") &&
    (item.dateFilter === undefined || isDateFilter(item.dateFilter)) &&
    (item.sort === undefined || isSort(item.sort)) &&
    (item.sourceType === undefined || isSource(item.sourceType)) &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
};

export const readSmartViews = (): SmartViewDefinition[] => {
  try {
    const raw = window.localStorage.getItem(SMART_VIEWS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(valid)
      .slice(0, SMART_VIEW_LIMIT)
      .map((item) => ({
        ...item,
        // Views written before v1.33 did not have tag/date fields. Keep them
        // usable rather than discarding a user's saved filters on upgrade.
        tag: item.tag ?? "all",
        context: item.context ?? "all",
        dateFilter: item.dateFilter ?? "any",
        sort: item.sort ?? "manual",
      }));
  } catch {
    return [];
  }
};

export const writeSmartViews = (views: readonly SmartViewDefinition[]): void => {
  try {
    window.localStorage.setItem(
      SMART_VIEWS_STORAGE_KEY,
      JSON.stringify(views.slice(0, SMART_VIEW_LIMIT)),
    );
  } catch {
    // Private browsing or a locked-down storage area should not break the
    // task list. The view remains usable for the current component lifetime.
  }
};

const newId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `smart-view-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
};

export const createSmartView = (
  draft: SmartViewDraft,
  now = new Date().toISOString(),
): SmartViewDefinition | undefined => {
  const name = draft.name.trim().replace(/\s+/gu, " ");
  if (!name || name.length > 60) return undefined;
  return {
    id: newId(),
    name,
    route: draft.route,
    priority: draft.priority,
    projectId: draft.projectId,
    tag: draft.tag ?? "all",
    context: draft.context ?? "all",
    dateFilter: draft.dateFilter ?? "any",
    sort: draft.sort ?? "manual",
    sourceType: draft.sourceType,
    createdAt: now,
    updatedAt: now,
  };
};

const priorityRank: Record<TaskPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

const sortableDate = (task: Pick<Task, "dueAt">): number => {
  if (!task.dueAt) return Number.POSITIVE_INFINITY;
  const value = new Date(task.dueAt).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
};

/**
 * Sort one visible section without mutating the controller snapshot. Ties
 * retain their incoming order, which keeps manual Today order predictable and
 * makes applying/removing a saved view reversible.
 */
type SmartViewSortableTask = Pick<
  Task,
  "priority" | "dueAt" | "title" | "createdAt"
>;

export const sortSmartViewTasks = <TaskLike extends SmartViewSortableTask>(
  tasks: readonly TaskLike[],
  sort: SmartViewSort,
): TaskLike[] => {
  if (sort === "manual") return [...tasks];
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      let comparison = 0;
      if (sort === "priority") {
        comparison =
          priorityRank[right.task.priority] - priorityRank[left.task.priority];
      } else if (sort === "due") {
        comparison = sortableDate(left.task) - sortableDate(right.task);
      } else if (sort === "title") {
        comparison = left.task.title.localeCompare(right.task.title, "zh-CN");
      } else if (sort === "created") {
        comparison = right.task.createdAt.localeCompare(left.task.createdAt);
      }
      return comparison || left.index - right.index;
    })
    .map(({ task }) => task);
};

export const priorityReason = (task: {
  priority: TaskPriority;
  dueAt?: string;
  plannedDate?: string;
  dependencyIds: string[];
  sync: { status: string };
}, today = new Date()): string | undefined => {
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const dueDate = task.dueAt ? new Date(task.dueAt) : undefined;
  if (dueDate && !Number.isNaN(dueDate.getTime())) {
    const delta = dueDate.getTime() - today.getTime();
    if (delta < 0) return "已逾期";
    if (delta <= 24 * 60 * 60_000) return "24 小时内截止";
  }
  if (task.priority === "urgent") return "紧急优先级";
  if (task.priority === "high") return "高优先级";
  if (task.plannedDate && task.plannedDate <= localToday) return "今天计划";
  if (task.dependencyIds.length > 0) return "有前置关系";
  if (["pending", "syncing", "conflict", "failed", "permission-denied", "read-only", "remote-deleted"].includes(task.sync.status)) {
    return "需要同步留意";
  }
  return undefined;
};
