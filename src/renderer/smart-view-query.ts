import type { TaskPriority, TaskSourceType } from "../shared/models";
import type {
  SmartViewDateFilter,
  SmartViewSort,
} from "./smart-views";

export interface SmartViewQueryFilters {
  priority: TaskPriority | "all";
  flagged: boolean;
  projectId: string | "all";
  tag: string | "all";
  sectionId: string | "all";
  context: string | "all";
  dateFilter: SmartViewDateFilter;
  sort: SmartViewSort;
  sourceType?: TaskSourceType;
}

export interface SmartViewQueryOptions {
  projects?: readonly string[];
  tags?: readonly string[];
  sections?: readonly string[];
  contexts?: readonly string[];
}

export interface SmartViewQuerySuggestion {
  query: string;
  filters: SmartViewQueryFilters;
  summary: string[];
}

export interface SmartViewQueryError {
  query: string;
  message: string;
}

export type SmartViewQueryResult =
  | { kind: "suggestion"; value: SmartViewQuerySuggestion }
  | { kind: "error"; value: SmartViewQueryError };

const QUERY_LIMIT = 120;

const normalize = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase()
    .replace(/[：:]/gu, ":")
    .replace(/[，,、；;]/gu, " ")
    .replace(/\s+/gu, " ");

const equalNormalized = (left: string, right: string): boolean =>
  normalize(left) === normalize(right);

const includesNormalized = (query: string, value: string): boolean =>
  normalize(query).includes(normalize(value));

const findNamedValue = (
  query: string,
  values: readonly string[],
  prefix: string,
): { value?: string; unknown?: string } => {
  const normalizedQuery = normalize(query);
  const normalizedPrefix = normalize(prefix);
  const explicitPrefix =
    normalizedPrefix === "分组" ? "分组(?:标题)?" : normalizedPrefix;
  const explicit = normalizedQuery.match(
    new RegExp(`${explicitPrefix}\\s*:\\s*([^ ]+)`, "u"),
  )?.[1];
  if (explicit) {
    const match = values.find((value) => equalNormalized(value, explicit));
    return match ? { value: match } : { unknown: explicit };
  }
  return [...values]
    .sort((left, right) => right.length - left.length)
    .find((value) => includesNormalized(normalizedQuery, value))
    ? {
        value: [...values]
          .sort((left, right) => right.length - left.length)
          .find((value) => includesNormalized(normalizedQuery, value)),
      }
    : {};
};

const filtersWithDefaults = (): SmartViewQueryFilters => ({
  priority: "all",
  flagged: false,
  projectId: "all",
  tag: "all",
  sectionId: "all",
  context: "all",
  dateFilter: "any",
  sort: "manual",
});

const conflict = (messages: string[]): string | undefined =>
  messages.length > 1 ? messages.join("；") : messages[0];

/**
 * Parses a deliberately small, deterministic Filter Assist vocabulary. It
 * only uses values already present in the task snapshot, so applying a
 * suggestion cannot invent a project, tag or context and never touches a
 * task. The returned suggestion is intended for preview before applying.
 */
export const parseSmartViewQuery = (
  rawQuery: string,
  options: SmartViewQueryOptions = {},
): SmartViewQueryResult => {
  const query = rawQuery.trim();
  if (!query) {
    return {
      kind: "error",
      value: { query, message: "请输入筛选条件，例如“本周高优先级的飞书任务”。" },
    };
  }
  if (query.length > QUERY_LIMIT) {
    return {
      kind: "error",
      value: { query, message: `筛选语句最多 ${QUERY_LIMIT} 个字。` },
    };
  }

  const normalized = normalize(query);
  // A heading name may itself contain words that look like another filter
  // (for example “本周发布” contains both a date cue and a tag). Remove an
  // explicit heading token before the looser signal scans so Filter Assist
  // does not invent extra conditions from the heading's display text.
  const sectionToken = /分组(?:标题)?\s*:\s*[^ ]+/u;
  const signalQuery = normalized.replace(sectionToken, " ");
  const namedQuery = normalized.replace(sectionToken, " ");
  const filters = filtersWithDefaults();
  const summary: string[] = [];
  const conflicts: string[] = [];

  const priorityRules: Array<[TaskPriority, RegExp, string]> = [
    ["urgent", /紧急|最高优先级|p0\b/iu, "紧急"],
    ["high", /高优先级|高优|p1\b/iu, "高优先级"],
    ["medium", /中优先级|中优/iu, "中优先级"],
    ["low", /低优先级|低优/iu, "低优先级"],
    ["none", /无优先级|没有优先级/iu, "无优先级"],
  ];
  const priorityMatches = priorityRules.filter(([, pattern]) =>
    pattern.test(signalQuery),
  );
  if (priorityMatches.length > 1) conflicts.push("优先级条件有多个");
  if (priorityMatches[0]) {
    filters.priority = priorityMatches[0][0];
    summary.push(priorityMatches[0][2]);
  }

  const flaggedMatches =
    /已标记|重点任务|旗标|星标|flagged|starred/iu.test(signalQuery) &&
    !/未标记|取消标记|不标记/iu.test(signalQuery);
  if (flaggedMatches) {
    filters.flagged = true;
    summary.push("重点标记");
  }

  const dateRules: Array<[SmartViewDateFilter, RegExp, string]> = [
    ["overdue", /逾期|过期|已到期/iu, "已逾期"],
    ["today", /今天|今日/iu, "今天"],
    ["next-7-days", /未来\s*7\s*天|接下来\s*7\s*天|本周/iu, "未来 7 天"],
    ["no-date", /无日期|没有日期|未安排日期/iu, "无日期"],
  ];
  const dateMatches = dateRules.filter(([, pattern]) =>
    pattern.test(signalQuery),
  );
  if (dateMatches.length > 1) conflicts.push("日期条件有多个");
  if (dateMatches[0]) {
    filters.dateFilter = dateMatches[0][0];
    summary.push(dateMatches[0][2]);
  }

  const sourceRules: Array<[TaskSourceType, RegExp, string]> = [
    ["feishu", /飞书|lark/iu, "飞书"],
    ["local", /本地|私有/iu, "本地"],
  ];
  const sourceMatches = sourceRules.filter(([, pattern]) =>
    pattern.test(signalQuery),
  );
  if (sourceMatches.length > 1) conflicts.push("来源条件有多个");
  if (sourceMatches[0]) {
    filters.sourceType = sourceMatches[0][0];
    summary.push(sourceMatches[0][2]);
  }

  const sortRules: Array<[SmartViewSort, RegExp, string]> = [
    ["priority", /按优先级|优先级排序|优先级在前/iu, "按优先级"],
    ["due", /按截止|最近截止|截止时间排序/iu, "按截止时间"],
    ["title", /按标题|标题排序/iu, "按标题"],
    ["created", /按创建|最新创建|创建时间排序/iu, "按创建时间"],
  ];
  const sortMatches = sortRules.filter(([, pattern]) =>
    pattern.test(signalQuery),
  );
  if (sortMatches.length > 1) conflicts.push("排序条件有多个");
  if (sortMatches[0]) {
    filters.sort = sortMatches[0][0];
    summary.push(sortMatches[0][2]);
  }

  const project = findNamedValue(namedQuery, options.projects ?? [], "项目");
  const tag = findNamedValue(namedQuery, options.tags ?? [], "标签");
  const section = findNamedValue(query, options.sections ?? [], "分组");
  const context = findNamedValue(namedQuery, options.contexts ?? [], "情境");
  if (project.unknown) {
    return {
      kind: "error",
      value: { query, message: `没有找到项目“${project.unknown}”，请先创建或选择已有项目。` },
    };
  }
  if (tag.unknown) {
    return {
      kind: "error",
      value: { query, message: `没有找到标签“${tag.unknown}”，请先在任务中使用已有标签。` },
    };
  }
  if (context.unknown) {
    return {
      kind: "error",
      value: { query, message: `没有找到情境“${context.unknown}”，请先在任务中使用已有情境。` },
    };
  }
  if (section.unknown) {
    return {
      kind: "error",
      value: { query, message: `没有找到分组标题“${section.unknown}”，请先在任务中使用已有分组标题。` },
    };
  }
  if (project.value) {
    filters.projectId = project.value;
    summary.push(`项目：${project.value}`);
  }
  if (tag.value) {
    filters.tag = tag.value;
    summary.push(`标签：${tag.value}`);
  }
  if (context.value) {
    filters.context = context.value;
    summary.push(`情境：${context.value}`);
  }
  if (section.value) {
    filters.sectionId = section.value;
    summary.push(`分组：${section.value}`);
  }

  const hasAnySignal = summary.length > 0;
  const message = conflict(conflicts);
  if (message) {
    return {
      kind: "error",
      value: { query, message: `筛选语句有歧义：${message}。请保留每类一个条件。` },
    };
  }
  if (!hasAnySignal) {
    return {
      kind: "error",
      value: {
        query,
        message: "没有识别到筛选条件。可试试“本周高优先级的飞书任务”或“项目：研究 标签：论文”。",
      },
    };
  }

  return { kind: "suggestion", value: { query, filters, summary } };
};
