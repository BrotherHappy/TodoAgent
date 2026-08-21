import type {
  JsonValue,
  Task,
  TaskList,
  TaskProject,
} from "./models";
import type { CalendarEvent } from "./calendar-events";

export type GlobalSearchResultKind = "task" | "project" | "list" | "calendar" | "conversation";

/** The small, renderer-safe shape used for locally persisted Agent sessions. */
export interface GlobalSearchConversation {
  id: string;
  title: string;
  updatedAt: string;
  messages: readonly string[];
}

export interface GlobalSearchResult {
  id: string;
  kind: GlobalSearchResultKind;
  title: string;
  subtitle: string;
  snippet?: string;
  /** Internal ranking score. It is useful for tests and intentionally not
   * rendered so the search surface remains calm and human-readable. */
  score: number;
  task?: Task;
  project?: TaskProject;
  list?: TaskList;
  calendarEvent?: CalendarEvent;
  conversationId?: string;
}

export interface GlobalSearchInput {
  tasks: readonly Task[];
  projects: readonly TaskProject[];
  lists: readonly TaskList[];
  calendarEvents?: readonly CalendarEvent[];
  conversations?: readonly GlobalSearchConversation[];
  query: string;
  limit?: number;
}

interface SearchField {
  value: string;
  weight: number;
  /** Fields such as source IDs are useful for matching but poor snippets. */
  snippet?: boolean;
}

interface SearchCandidate extends Omit<GlobalSearchResult, "score"> {
  fields: SearchField[];
  order: number;
}

const KIND_ORDER: Record<GlobalSearchResultKind, number> = {
  task: 0,
  project: 1,
  list: 2,
  calendar: 3,
  conversation: 4,
};

const STATUS_LABEL: Record<Task["status"], string> = {
  open: "待办",
  completed: "已完成",
  cancelled: "已取消",
};

const PRIORITY_LABEL: Record<Task["priority"], string> = {
  none: "无优先级",
  low: "低优先级",
  medium: "中优先级",
  high: "高优先级",
  urgent: "紧急",
};

const normalize = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/\0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();

const cleanText = (value: string): string =>
  value.replace(/\0/gu, " ").replace(/\s+/gu, " ").trim();

const stringifyJson = (value: JsonValue): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(stringifyJson).join(" ");
  return Object.entries(value)
    .map(([key, entry]) => `${key} ${stringifyJson(entry)}`)
    .join(" ");
};

const field = (value: unknown, weight: number, snippet = true): SearchField | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanText(value);
  return cleaned ? { value: cleaned, weight, snippet } : undefined;
};

const fields = (...values: Array<SearchField | undefined>): SearchField[] =>
  values.filter((value): value is SearchField => value !== undefined);

const firstSnippet = (candidate: SearchCandidate, tokens: readonly string[]): string | undefined => {
  const preferred = candidate.fields.find(
    (entry) => entry.snippet !== false && tokens.some((token) => normalize(entry.value).includes(token)),
  );
  const source = preferred ?? candidate.fields.find((entry) => entry.snippet !== false);
  if (!source) return undefined;
  const text = cleanText(source.value);
  if (text.length <= 132) return text;
  const normalized = normalize(text);
  const token = tokens.find((entry) => normalized.includes(entry));
  const at = token ? normalized.indexOf(token) : 0;
  const start = Math.max(0, Math.min(at - 38, text.length - 96));
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 96)}${start + 96 < text.length ? "…" : ""}`;
};

const taskFields = (
  task: Task,
  projectsById: ReadonlyMap<string, TaskProject>,
  listsById: ReadonlyMap<string, TaskList>,
): SearchField[] => {
  const comments = (task.comments ?? []).map((comment) => comment.body).join(" ");
  const research = (task.researchCards ?? [])
    .flatMap((card) => [card.title, card.url ?? "", card.summary, ...card.actionItems])
    .join(" ");
  const customFields = Object.entries(task.customFields ?? {})
    .map(([key, value]) => `${key} ${stringifyJson(value)}`)
    .join(" ");
  const attachments = task.attachments
    .flatMap((attachment) => [attachment.name, attachment.mimeType ?? "", attachment.url ?? ""])
    .join(" ");
  const links = task.links
    .flatMap((link) => [link.label ?? "", link.url])
    .join(" ");
  return fields(
    field(task.title, 110),
    field(task.notes, 48),
    field(task.privateNotes, 42),
    field(task.tags.join(" "), 38),
    field((task.contexts ?? []).join(" "), 36),
    field(comments, 34),
    field(research, 32),
    field(customFields, 26),
    field(attachments, 22),
    field(links, 22),
    field(projectsById.get(task.projectId ?? "")?.name, 62),
    field(listsById.get(task.listId ?? "")?.name, 58),
    field(task.sectionId, 25, false),
    field(task.source.externalId, 12, false),
    field(task.source.accountId, 10, false),
    field(STATUS_LABEL[task.status], 30, false),
    field(PRIORITY_LABEL[task.priority], 30, false),
  );
};

const conversationFields = (conversation: GlobalSearchConversation): SearchField[] =>
  fields(
    field(conversation.title, 92),
    field(conversation.messages.join(" "), 26),
  );

const calendarDateLabel = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const calendarFields = (event: CalendarEvent): SearchField[] =>
  fields(
    field(event.summary, 112),
    field(event.description, 48),
    field(event.sourceName, 58),
    field(calendarDateLabel(event.startAt), 24, false),
    field(calendarDateLabel(event.endAt), 20, false),
    field(event.allDay ? "全天" : "有时间", 18, false),
  );

const calendarSubtitle = (event: CalendarEvent): string => {
  const date = calendarDateLabel(event.startAt) || "未定日期";
  const timeLabel = event.allDay ? "全天" : "有时间";
  return `日历 · ${event.sourceName || "本地日历"} · ${date} · ${timeLabel}`;
};

const scoreCandidate = (candidate: SearchCandidate, tokens: readonly string[]): number | undefined => {
  const normalizedFields = candidate.fields.map((entry) => ({
    entry,
    value: normalize(entry.value),
  }));
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    for (const { entry, value } of normalizedFields) {
      if (!value.includes(token)) continue;
      const exact = value === token;
      const prefix = value.startsWith(token);
      best = Math.max(best, entry.weight + (exact ? 70 : prefix ? 38 : 0));
    }
    if (best === 0) return undefined;
    score += best;
  }
  const title = normalize(candidate.title);
  const wholeQuery = tokens.join(" ");
  if (title === wholeQuery) score += 180;
  else if (title.startsWith(wholeQuery)) score += 105;
  else if (title.includes(wholeQuery)) score += 55;
  return score;
};

const taskSubtitle = (task: Task, project?: TaskProject, list?: TaskList): string => {
  const source = task.source.type === "feishu" ? "飞书" : "本地";
  const context = project?.name ?? list?.name;
  return `${source} · ${STATUS_LABEL[task.status]}${context ? ` · ${context}` : ""}`;
};

/**
 * Search every local workspace surface without changing task state. The
 * matching is token based (all query tokens must be present), title weighted,
 * and deterministic so keyboard navigation does not jump between renders.
 */
export function searchGlobalWorkspace(input: GlobalSearchInput): GlobalSearchResult[] {
  const query = cleanText(input.query);
  const tokens = [...new Set(normalize(query).split(" ").filter(Boolean))];
  if (tokens.length === 0) return [];
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 30)));
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const listsById = new Map(input.lists.map((list) => [list.id, list]));
  const candidates: SearchCandidate[] = [];
  let order = 0;
  for (const task of input.tasks) {
    const project = task.projectId ? projectsById.get(task.projectId) : undefined;
    const list = task.listId ? listsById.get(task.listId) : undefined;
    candidates.push({
      id: task.id,
      kind: "task",
      title: task.title || "无标题任务",
      subtitle: taskSubtitle(task, project, list),
      fields: taskFields(task, projectsById, listsById),
      task,
      order: order++,
    });
  }
  const projectTaskCounts = new Map<string, number>();
  const listTaskCounts = new Map<string, number>();
  for (const task of input.tasks) {
    if (task.projectId) projectTaskCounts.set(task.projectId, (projectTaskCounts.get(task.projectId) ?? 0) + 1);
    if (task.listId) listTaskCounts.set(task.listId, (listTaskCounts.get(task.listId) ?? 0) + 1);
  }
  for (const project of input.projects) {
    candidates.push({
      id: project.id,
      kind: "project",
      title: project.name,
      subtitle: `项目 · ${projectTaskCounts.get(project.id) ?? 0} 项任务`,
      fields: fields(field(project.name, 112)),
      project,
      order: order++,
    });
  }
  for (const list of input.lists) {
    candidates.push({
      id: list.id,
      kind: "list",
      title: list.name,
      subtitle: `清单 · ${listTaskCounts.get(list.id) ?? 0} 项任务`,
      fields: fields(field(list.name, 108)),
      list,
      order: order++,
    });
  }
  for (const event of input.calendarEvents ?? []) {
    candidates.push({
      id: event.id,
      kind: "calendar",
      title: event.summary || "无标题日程",
      subtitle: calendarSubtitle(event),
      fields: calendarFields(event),
      calendarEvent: event,
      order: order++,
    });
  }
  for (const conversation of input.conversations ?? []) {
    candidates.push({
      id: conversation.id,
      kind: "conversation",
      title: conversation.title || "新对话",
      subtitle: `Agent 会话 · ${conversation.updatedAt.slice(0, 10)}`,
      fields: conversationFields(conversation),
      conversationId: conversation.id,
      order: order++,
    });
  }
  const scored = candidates.flatMap(
    (candidate): Array<GlobalSearchResult & { order: number }> => {
      const score = scoreCandidate(candidate, tokens);
      if (score === undefined) return [];
      return [{
        id: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        subtitle: candidate.subtitle,
        snippet: firstSnippet(candidate, tokens),
        score,
        task: candidate.task,
        project: candidate.project,
        list: candidate.list,
        calendarEvent: candidate.calendarEvent,
        conversationId: candidate.conversationId,
        order: candidate.order,
      }];
    },
  );
  return scored
    .sort((left, right) =>
      right.score - left.score ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.order - right.order,
    )
    .slice(0, limit)
    .map(({ order: _order, ...result }) => result);
}
