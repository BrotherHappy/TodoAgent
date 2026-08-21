import type {
  LocalDate,
  Task,
  TaskId,
  TaskSourceType,
  UpdateTaskInput,
} from "./models";

/**
 * A small, deterministic automation language for Todo Pet.
 *
 * Rules deliberately operate on local/private task fields only. They never
 * contain scripts, URLs, arbitrary JSON, or provider-owned fields, so a rule
 * can safely be evaluated after a local edit or a Feishu pull without creating
 * an implicit remote write.
 */
export const TASK_AUTOMATION_MAX_RULES = 50;
export const TASK_AUTOMATION_MAX_NAME_LENGTH = 80;
export const TASK_AUTOMATION_MAX_VALUE_LENGTH = 80;

export type TaskAutomationTrigger =
  | "task-created"
  | "task-completed"
  | "manual";

export interface TaskAutomationCondition {
  source?: TaskSourceType;
  projectId?: string;
  listId?: string;
  sectionId?: string;
  tag?: string;
  context?: string;
}

export type TaskAutomationAction =
  | { kind: "set-flagged"; value: boolean }
  | { kind: "set-project"; value: string | null }
  | { kind: "set-list"; value: string | null }
  | { kind: "set-section"; value: string | null }
  | { kind: "set-defer-until"; value: LocalDate | null }
  | { kind: "add-tag"; value: string }
  | { kind: "remove-tag"; value: string }
  | { kind: "add-context"; value: string }
  | { kind: "remove-context"; value: string };

export interface TaskAutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TaskAutomationTrigger;
  condition: TaskAutomationCondition;
  action: TaskAutomationAction;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskAutomationRuleInput {
  id?: string;
  name: string;
  enabled?: boolean;
  trigger: TaskAutomationTrigger;
  condition?: TaskAutomationCondition;
  action: TaskAutomationAction;
  createdAt?: string;
  updatedAt?: string;
}

const triggers = new Set<TaskAutomationTrigger>([
  "task-created",
  "task-completed",
  "manual",
]);
const sourceTypes = new Set<TaskSourceType>(["local", "feishu"]);
const actionKinds = new Set<TaskAutomationAction["kind"]>([
  "set-flagged",
  "set-project",
  "set-list",
  "set-section",
  "set-defer-until",
  "add-tag",
  "remove-tag",
  "add-context",
  "remove-context",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const cleanText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum) return undefined;
  return normalized;
};

const cleanId = (value: unknown, maximum = 160): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) return undefined;
  return normalized;
};

const isLocalDate = (value: unknown): value is LocalDate => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const isDateTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(new Date(value).getTime());

function normalizeCondition(value: unknown): TaskAutomationCondition | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const condition: TaskAutomationCondition = {};
  if (value.source !== undefined) {
    if (typeof value.source !== "string" || !sourceTypes.has(value.source as TaskSourceType)) {
      return undefined;
    }
    condition.source = value.source as TaskSourceType;
  }
  for (const key of ["projectId", "listId", "sectionId"] as const) {
    if (value[key] === undefined) continue;
    const item = cleanId(value[key], TASK_AUTOMATION_MAX_VALUE_LENGTH);
    if (item === undefined) return undefined;
    condition[key] = item;
  }
  for (const key of ["tag", "context"] as const) {
    if (value[key] === undefined) continue;
    const item = cleanText(value[key], 40);
    if (item === undefined) return undefined;
    condition[key] = item;
  }
  return condition;
}

function normalizeAction(value: unknown): TaskAutomationAction | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || !actionKinds.has(value.kind as TaskAutomationAction["kind"])) {
    return undefined;
  }
  switch (value.kind as TaskAutomationAction["kind"]) {
    case "set-flagged":
      return typeof value.value === "boolean"
        ? { kind: "set-flagged", value: value.value }
        : undefined;
    case "set-project":
    case "set-list":
    case "set-section": {
      if (value.value === null) return { kind: value.kind, value: null } as TaskAutomationAction;
      const item = cleanId(value.value, TASK_AUTOMATION_MAX_VALUE_LENGTH);
      return item === undefined
        ? undefined
        : ({ kind: value.kind, value: item } as TaskAutomationAction);
    }
    case "set-defer-until":
      if (value.value === null) return { kind: "set-defer-until", value: null };
      return isLocalDate(value.value)
        ? { kind: "set-defer-until", value: value.value }
        : undefined;
    case "add-tag":
    case "remove-tag": {
      const item = cleanText(value.value, 40);
      return item === undefined
        ? undefined
        : { kind: value.kind as "add-tag" | "remove-tag", value: item };
    }
    case "add-context":
    case "remove-context": {
      const item = cleanText(value.value, 40);
      return item === undefined
        ? undefined
        : { kind: value.kind as "add-context" | "remove-context", value: item };
    }
  }
}

/** Normalize one rule. Invalid rules are rejected rather than repaired into a
 * surprising action; settings import can therefore fail closed per rule. */
export function normalizeTaskAutomationRule(
  value: unknown,
  now = new Date().toISOString(),
): TaskAutomationRule | undefined {
  if (!isRecord(value)) return undefined;
  const id = cleanId(value.id);
  const name = cleanText(value.name, TASK_AUTOMATION_MAX_NAME_LENGTH);
  if (id === undefined || name === undefined) return undefined;
  if (typeof value.enabled !== "boolean") return undefined;
  if (typeof value.trigger !== "string" || !triggers.has(value.trigger as TaskAutomationTrigger)) {
    return undefined;
  }
  const condition = normalizeCondition(value.condition);
  const action = normalizeAction(value.action);
  if (condition === undefined || action === undefined) return undefined;
  const createdAt = value.createdAt === undefined ? now : value.createdAt;
  const updatedAt = value.updatedAt === undefined ? createdAt : value.updatedAt;
  if (!isDateTime(createdAt) || !isDateTime(updatedAt)) return undefined;
  return {
    id,
    name,
    enabled: value.enabled,
    trigger: value.trigger as TaskAutomationTrigger,
    condition,
    action,
    createdAt,
    updatedAt,
  };
}

/** Normalize untrusted settings/backup input, keeping the first duplicate ID. */
export function normalizeTaskAutomationRules(value: unknown): TaskAutomationRule[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: TaskAutomationRule[] = [];
  for (const item of value) {
    const rule = normalizeTaskAutomationRule(item);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    result.push(rule);
    if (result.length >= TASK_AUTOMATION_MAX_RULES) break;
  }
  return result;
}

export function createTaskAutomationRule(
  input: CreateTaskAutomationRuleInput,
  now = new Date().toISOString(),
): TaskAutomationRule {
  const rule = normalizeTaskAutomationRule(
    {
      id: input.id ?? `automation-${Math.random().toString(36).slice(2, 10)}`,
      name: input.name,
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      condition: input.condition ?? {},
      action: input.action,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    },
    now,
  );
  if (!rule) throw new Error("INVALID_TASK_AUTOMATION_RULE");
  return rule;
}

export function matchesTaskAutomation(
  rule: TaskAutomationRule,
  task: Task,
): boolean {
  if (!rule.enabled || task.deletedAt !== undefined) return false;
  const { condition } = rule;
  if (condition.source !== undefined && task.source.type !== condition.source) return false;
  if (condition.projectId !== undefined && task.projectId !== condition.projectId) return false;
  if (condition.listId !== undefined && task.listId !== condition.listId) return false;
  if (condition.sectionId !== undefined && task.sectionId !== condition.sectionId) return false;
  if (condition.tag !== undefined && !task.tags.some((tag) => tag.toLocaleLowerCase() === condition.tag!.toLocaleLowerCase())) return false;
  if (condition.context !== undefined && !(task.contexts ?? []).some((context) => context.toLocaleLowerCase() === condition.context!.toLocaleLowerCase())) return false;
  return true;
}

/** Return the edge represented by a pair of snapshots. */
export function taskAutomationTrigger(
  previous: Task | undefined,
  current: Task | undefined,
): TaskAutomationTrigger | undefined {
  if (!current || current.deletedAt !== undefined) return undefined;
  if (!previous || previous.deletedAt !== undefined) return "task-created";
  if (previous.status !== "completed" && current.status === "completed") {
    return "task-completed";
  }
  return undefined;
}

/** Translate a rule into a private-only task patch. Returns undefined for a
 * no-op so execution does not create noisy history entries. */
export function taskAutomationPatch(
  rule: TaskAutomationRule,
  task: Task,
): UpdateTaskInput | undefined {
  const action = rule.action;
  switch (action.kind) {
    case "set-flagged":
      return task.flagged === action.value ? undefined : { flagged: action.value };
    case "set-project":
      return task.projectId === action.value ? undefined : { projectId: action.value };
    case "set-list":
      return task.listId === action.value ? undefined : { listId: action.value };
    case "set-section":
      return task.sectionId === action.value ? undefined : { sectionId: action.value };
    case "set-defer-until":
      return task.deferUntil === action.value ? undefined : { deferUntil: action.value };
    case "add-tag": {
      if (task.tags.some((tag) => tag.toLocaleLowerCase() === action.value.toLocaleLowerCase())) return undefined;
      return { tags: [...task.tags, action.value] };
    }
    case "remove-tag": {
      const tags = task.tags.filter((tag) => tag.toLocaleLowerCase() !== action.value.toLocaleLowerCase());
      return tags.length === task.tags.length ? undefined : { tags };
    }
    case "add-context": {
      const contexts = task.contexts ?? [];
      if (contexts.some((context) => context.toLocaleLowerCase() === action.value.toLocaleLowerCase())) return undefined;
      return { contexts: [...contexts, action.value] };
    }
    case "remove-context": {
      const contexts = (task.contexts ?? []).filter((context) => context.toLocaleLowerCase() !== action.value.toLocaleLowerCase());
      return contexts.length === (task.contexts ?? []).length ? undefined : { contexts };
    }
  }
}

export function taskAutomationActionLabel(action: TaskAutomationAction): string {
  switch (action.kind) {
    case "set-flagged": return action.value ? "标记为重点" : "取消重点标记";
    case "set-project": return action.value ? `移入项目 ${action.value}` : "清除项目";
    case "set-list": return action.value ? `移入清单 ${action.value}` : "清除清单";
    case "set-section": return action.value ? `设置分组 ${action.value}` : "清除分组";
    case "set-defer-until": return action.value ? `稍后安排到 ${action.value}` : "清除稍后安排";
    case "add-tag": return `添加标签 ${action.value}`;
    case "remove-tag": return `移除标签 ${action.value}`;
    case "add-context": return `添加情境 ${action.value}`;
    case "remove-context": return `移除情境 ${action.value}`;
  }
}

export function taskAutomationTriggerLabel(trigger: TaskAutomationTrigger): string {
  if (trigger === "task-created") return "任务新建时";
  if (trigger === "task-completed") return "任务完成时";
  return "手动应用时";
}

export function taskAutomationTaskIds(
  previous: readonly Task[],
  current: readonly Task[],
): TaskId[] {
  return Array.from(new Set([...previous.map((task) => task.id), ...current.map((task) => task.id)]));
}
