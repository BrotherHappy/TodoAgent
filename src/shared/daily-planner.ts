import type { LocalDate, Task, TaskId, TaskPriority } from "./models";

export const DEFAULT_DAILY_TASK_ESTIMATE_MINUTES = 30;
export const MAX_DAILY_SUGGESTED_ITEMS = 7;

export type DailyPlanReasonCode =
  | "overdue"
  | "due-today"
  | "starts-today"
  | "planned-today"
  | "planned-carryover"
  | "priority"
  | "due-soon"
  | "unblocks-tasks"
  | "blocked"
  | "default-estimate"
  | "estimated-duration"
  | "short-block";

export interface DailyPlanConstraints {
  /** Local minutes from midnight, inclusive. */
  availableStartMinutes: number;
  /** Local minutes from midnight, exclusive. */
  availableEndMinutes: number;
  /** Time reserved for transitions, messages and breathing room. */
  bufferMinutes: number;
  /** Tasks below this duration are left for manual selection / fragments. */
  minimumBlockMinutes: number;
}

export const DEFAULT_DAILY_PLAN_CONSTRAINTS: DailyPlanConstraints = {
  availableStartMinutes: 9 * 60,
  availableEndMinutes: 18 * 60,
  bufferMinutes: 30,
  minimumBlockMinutes: 15,
};

export interface DailyPlanReason {
  code: DailyPlanReasonCode;
  label: string;
}

export interface DailyPlanItem {
  task: Task;
  isFixed: boolean;
  isRetained: boolean;
  isSelected: boolean;
  isAutomatic: boolean;
  estimatedMinutes: number;
  isEstimateDefault: boolean;
  belowMinimumBlock: boolean;
  blocked: boolean;
  incompleteDependencyIds: TaskId[];
  recommendationReasons: DailyPlanReason[];
  primaryReason: string;
}

export interface DailyPlannerOptions {
  /** A local YYYY-MM-DD date, or an absolute instant converted using timeZone. */
  date: Date | string;
  capacityMinutes: number;
  timeZone?: string;
  defaultEstimateMinutes?: number;
  /** May lower, but never raise, the product safety limit of seven additions. */
  maxSuggestedItems?: number;
  /** Optional local availability constraints used only for suggestions. */
  constraints?: Partial<DailyPlanConstraints>;
}

export interface DailyPlanSuggestion {
  date: LocalDate;
  capacityMinutes: number;
  defaultEstimateMinutes: number;
  maxSuggestedItems: number;
  constraints: DailyPlanConstraints;
  availableWindowMinutes: number;
  effectiveCapacityMinutes: number;
  items: DailyPlanItem[];
  fixedItems: DailyPlanItem[];
  selectedItems: DailyPlanItem[];
  suggestedItems: DailyPlanItem[];
  totalMinutes: number;
  overloadMinutes: number;
}

interface RankedDailyPlanItem extends DailyPlanItem {
  score: number;
  dueDate?: LocalDate;
  plannedDate?: LocalDate;
}

const PRIORITY_SCORE: Record<TaskPriority, number> = {
  none: 0,
  low: 10,
  medium: 30,
  high: 60,
  urgent: 90,
};

const PRIORITY_LABEL: Record<Exclude<TaskPriority, "none">, string> = {
  low: "低优先级",
  medium: "中优先级",
  high: "高优先级",
  urgent: "紧急优先级",
};

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MIN_TASK_ESTIMATE_MINUTES = 5;
const MAX_TASK_ESTIMATE_MINUTES = 720;

function assertLocalDate(value: string): LocalDate {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) throw new RangeError("Daily planner date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError("Daily planner date is not a valid calendar date.");
  }
  return value;
}

function localDateForInstant(value: Date, timeZone: string): LocalDate {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError("Daily planner date is not a valid instant.");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return assertLocalDate(`${get("year")}-${get("month")}-${get("day")}`);
}

function plannerDate(value: Date | string, timeZone: string): LocalDate {
  if (typeof value === "string" && LOCAL_DATE_PATTERN.test(value)) {
    return assertLocalDate(value);
  }
  const instant = value instanceof Date ? new Date(value) : new Date(value);
  return localDateForInstant(instant, timeZone);
}

function temporalLocalDate(
  value: string | undefined,
  timeZone: string,
): LocalDate | undefined {
  if (!value) return undefined;
  if (LOCAL_DATE_PATTERN.test(value)) {
    try {
      return assertLocalDate(value);
    } catch {
      return undefined;
    }
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return undefined;
  return localDateForInstant(instant, timeZone);
}

function localDateOrdinal(value: LocalDate): number {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return Number.NaN;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
      86_400_000,
  );
}

function daysFromToday(today: LocalDate, target: LocalDate): number {
  return localDateOrdinal(target) - localDateOrdinal(today);
}

function validDailyEstimate(value: number, field: string): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_TASK_ESTIMATE_MINUTES ||
    value > MAX_TASK_ESTIMATE_MINUTES
  ) {
    throw new RangeError(
      `${field} must be whole minutes between ${MIN_TASK_ESTIMATE_MINUTES} and ${MAX_TASK_ESTIMATE_MINUTES}.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} cannot be negative.`);
  }
  return Math.max(0, Math.floor(value));
}

function clockMinutes(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 1_439) {
    throw new RangeError(`${field} must be whole local minutes between 0 and 1439.`);
  }
  return value;
}

function normalizeConstraints(
  input: Partial<DailyPlanConstraints> | undefined,
): DailyPlanConstraints {
  const merged = { ...DEFAULT_DAILY_PLAN_CONSTRAINTS, ...input };
  const availableStartMinutes = clockMinutes(
    merged.availableStartMinutes,
    "availableStartMinutes",
  );
  const availableEndMinutes = clockMinutes(
    merged.availableEndMinutes,
    "availableEndMinutes",
  );
  if (availableEndMinutes <= availableStartMinutes) {
    throw new RangeError("availableEndMinutes must be after availableStartMinutes.");
  }
  const windowMinutes = availableEndMinutes - availableStartMinutes;
  const bufferMinutes = Math.min(
    windowMinutes,
    nonNegativeInteger(merged.bufferMinutes, "bufferMinutes"),
  );
  const minimumBlockMinutes = validDailyEstimate(
    merged.minimumBlockMinutes,
    "minimumBlockMinutes",
  );
  return {
    availableStartMinutes,
    availableEndMinutes,
    bufferMinutes,
    minimumBlockMinutes,
  };
}

function compareOptionalString(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankItems(
  left: RankedDailyPlanItem,
  right: RankedDailyPlanItem,
): number {
  const category = (item: RankedDailyPlanItem): number =>
    item.isFixed ? 0 : item.isRetained ? 1 : 2;
  const categoryComparison = category(left) - category(right);
  if (categoryComparison !== 0) return categoryComparison;
  if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
  if (left.score !== right.score) return right.score - left.score;
  if (left.task.privateOrder !== right.task.privateOrder) {
    return left.task.privateOrder - right.task.privateOrder;
  }
  const dueComparison = compareOptionalString(left.dueDate, right.dueDate);
  if (dueComparison !== 0) return dueComparison;
  const plannedComparison = compareOptionalString(
    left.plannedDate,
    right.plannedDate,
  );
  if (plannedComparison !== 0) return plannedComparison;
  const createdComparison =
    left.task.createdAt < right.task.createdAt
      ? -1
      : left.task.createdAt > right.task.createdAt
        ? 1
        : 0;
  if (createdComparison !== 0) return createdComparison;
  return left.task.id < right.task.id
    ? -1
    : left.task.id > right.task.id
      ? 1
      : 0;
}

function durationScore(minutes: number): number {
  if (minutes <= 15) return 24;
  if (minutes <= 30) return 18;
  if (minutes <= 60) return 10;
  if (minutes <= 90) return 4;
  if (minutes > 120) return -10;
  return 0;
}

/**
 * Builds an explainable, deterministic Today suggestion without mutating tasks.
 * Passing a local date string avoids all ambient clock and time-zone state.
 */
export function suggestDailyPlan(
  tasks: readonly Task[],
  options: DailyPlannerOptions,
): DailyPlanSuggestion {
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = plannerDate(options.date, timeZone);
  const capacityMinutes = nonNegativeInteger(
    options.capacityMinutes,
    "capacityMinutes",
  );
  const defaultEstimateMinutes = validDailyEstimate(
    options.defaultEstimateMinutes ?? DEFAULT_DAILY_TASK_ESTIMATE_MINUTES,
    "defaultEstimateMinutes",
  );
  const requestedLimit = nonNegativeInteger(
    options.maxSuggestedItems ?? MAX_DAILY_SUGGESTED_ITEMS,
    "maxSuggestedItems",
  );
  const maxSuggestedItems = Math.min(
    MAX_DAILY_SUGGESTED_ITEMS,
    requestedLimit,
  );
  const constraints = normalizeConstraints(options.constraints);
  const availableWindowMinutes =
    constraints.availableEndMinutes - constraints.availableStartMinutes;
  const effectiveCapacityMinutes = Math.max(
    0,
    Math.min(
      capacityMinutes,
      availableWindowMinutes - constraints.bufferMinutes,
    ),
  );

  const uniqueTasks: Task[] = [];
  const taskById = new Map<TaskId, Task>();
  for (const task of tasks) {
    if (taskById.has(task.id)) continue;
    taskById.set(task.id, task);
    uniqueTasks.push(task);
  }
  const actionable = uniqueTasks.filter(
    (task) => task.status === "open" && task.deletedAt === undefined,
  );
  const dependentCount = new Map<TaskId, number>();
  for (const task of actionable) {
    for (const dependencyId of new Set(task.dependencyIds)) {
      const dependency = taskById.get(dependencyId);
      if (dependency?.status === "completed") continue;
      dependentCount.set(
        dependencyId,
        (dependentCount.get(dependencyId) ?? 0) + 1,
      );
    }
  }

  const rankedItems: RankedDailyPlanItem[] = actionable.map((task) => {
    const dueDate = temporalLocalDate(task.dueAt, timeZone);
    const startDate = temporalLocalDate(task.startAt, timeZone);
    const plannedDate = task.plannedDate
      ? temporalLocalDate(task.plannedDate, timeZone)
      : undefined;
    const dueDays = dueDate ? daysFromToday(date, dueDate) : undefined;
    const isOverdue = dueDays !== undefined && dueDays < 0;
    const isDueToday = dueDays === 0;
    const startsToday = startDate === date;
    const isFixed = isOverdue || isDueToday || startsToday;
    const isRetained = Boolean(plannedDate && plannedDate <= date);
    const hasEstimate =
      typeof task.estimatedMinutes === "number" &&
      Number.isFinite(task.estimatedMinutes) &&
      Number.isInteger(task.estimatedMinutes) &&
      task.estimatedMinutes >= MIN_TASK_ESTIMATE_MINUTES &&
      task.estimatedMinutes <= MAX_TASK_ESTIMATE_MINUTES;
    const estimatedMinutes = hasEstimate
      ? task.estimatedMinutes!
      : defaultEstimateMinutes;
    const belowMinimumBlock = estimatedMinutes < constraints.minimumBlockMinutes;
    const incompleteDependencyIds = [
      ...new Set(
        task.dependencyIds.filter(
          (dependencyId) =>
            taskById.get(dependencyId)?.status !== "completed",
        ),
      ),
    ].sort();
    const blocked = incompleteDependencyIds.length > 0;
    const unlocks = dependentCount.get(task.id) ?? 0;
    const recommendationReasons: DailyPlanReason[] = [];
    let score = PRIORITY_SCORE[task.priority] + durationScore(estimatedMinutes);

    if (isOverdue) {
      const overdueDays = Math.abs(dueDays!);
      score += 360 + Math.min(60, overdueDays * 3);
      recommendationReasons.push({
        code: "overdue",
        label: `已逾期 ${overdueDays} 天`,
      });
    } else if (isDueToday) {
      score += 330;
      recommendationReasons.push({ code: "due-today", label: "今天截止" });
    } else if (dueDays !== undefined && dueDays <= 7) {
      score += dueDays <= 1 ? 100 : dueDays <= 3 ? 70 : 40;
      recommendationReasons.push({
        code: "due-soon",
        label: `${dueDays} 天后截止`,
      });
    }
    if (startsToday) {
      score += 300;
      recommendationReasons.push({
        code: "starts-today",
        label: "今天开始",
      });
    }
    if (plannedDate === date) {
      score += 220;
      recommendationReasons.push({
        code: "planned-today",
        label: "已经安排在今天",
      });
    } else if (plannedDate && plannedDate < date) {
      score += 200;
      recommendationReasons.push({
        code: "planned-carryover",
        label: `从 ${plannedDate} 延续，默认保留`,
      });
    }
    if (task.priority !== "none") {
      recommendationReasons.push({
        code: "priority",
        label: PRIORITY_LABEL[task.priority],
      });
    }
    if (unlocks > 0) {
      score += Math.min(72, unlocks * 18);
      recommendationReasons.push({
        code: "unblocks-tasks",
        label: `完成后可解锁 ${unlocks} 项`,
      });
    }
    if (blocked) {
      score -= 180;
      recommendationReasons.push({
        code: "blocked",
        label: `仍有 ${incompleteDependencyIds.length} 项依赖未完成`,
      });
    }
    if (hasEstimate) {
      recommendationReasons.push({
        code: "estimated-duration",
        label:
          estimatedMinutes <= 30
            ? `预计 ${estimatedMinutes} 分钟，可快速完成`
            : `预计需要 ${estimatedMinutes} 分钟`,
      });
    } else {
      recommendationReasons.push({
        code: "default-estimate",
        label: `未填写时长，暂按 ${defaultEstimateMinutes} 分钟`,
      });
    }
    if (belowMinimumBlock) {
      recommendationReasons.push({
        code: "short-block",
        label: `低于 ${constraints.minimumBlockMinutes} 分钟连续块，建议留给碎片时间`,
      });
    }

    return {
      task,
      isFixed,
      isRetained,
      isSelected: isFixed || isRetained,
      isAutomatic: false,
      estimatedMinutes,
      isEstimateDefault: !hasEstimate,
      belowMinimumBlock,
      blocked,
      incompleteDependencyIds,
      recommendationReasons,
      primaryReason: recommendationReasons[0]?.label ?? "可安排任务",
      score,
      dueDate,
      plannedDate,
    };
  });

  rankedItems.sort(rankItems);
  const selectedTaskIds = new Set(
    rankedItems
      .filter((item) => item.isSelected)
      .map((item) => item.task.id),
  );
  let totalMinutes = rankedItems
    .filter((item) => item.isSelected)
    .reduce((sum, item) => sum + item.estimatedMinutes, 0);
  let automaticCount = 0;
  for (const item of rankedItems) {
    if (item.isSelected || automaticCount >= maxSuggestedItems) continue;
    const dependenciesIncluded = item.incompleteDependencyIds.every(
      (dependencyId) => selectedTaskIds.has(dependencyId),
    );
    if (item.blocked && !dependenciesIncluded) continue;
    if (item.belowMinimumBlock && !item.isFixed && !item.isRetained) continue;
    if (totalMinutes + item.estimatedMinutes > effectiveCapacityMinutes) continue;
    item.isSelected = true;
    item.isAutomatic = true;
    selectedTaskIds.add(item.task.id);
    totalMinutes += item.estimatedMinutes;
    automaticCount += 1;
  }

  const items: DailyPlanItem[] = rankedItems.map(
    ({ score: _score, dueDate: _dueDate, plannedDate: _plannedDate, ...item }) =>
      item,
  );
  const fixedItems = items.filter((item) => item.isFixed);
  const selectedItems = items.filter((item) => item.isSelected);
  const suggestedItems = items.filter((item) => item.isAutomatic);
  return {
    date,
    capacityMinutes,
    defaultEstimateMinutes,
    maxSuggestedItems,
    items,
    fixedItems,
    selectedItems,
    suggestedItems,
    totalMinutes,
    constraints,
    availableWindowMinutes,
    effectiveCapacityMinutes,
    overloadMinutes: Math.max(0, totalMinutes - effectiveCapacityMinutes),
  };
}
