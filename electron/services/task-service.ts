import { randomUUID } from "node:crypto";
import type {
  ApplyTodayPlanRequest,
  BulkTaskEditPatch,
  BulkTaskRequest,
  CreateListInput,
  CreateProjectInput,
  CreateTaskInput,
  DeleteListResult,
  DeleteProjectResult,
  LocalAppState,
  RecurrenceEditScope,
  SaveDraftInput,
  Task,
  TaskComment,
  TaskDraft,
  TaskHistoryEntry,
  TaskFilter,
  TaskId,
  TaskList,
  TaskListColor,
  TaskMutationResult,
  TaskOperation,
  TaskOperationKind,
  TaskProject,
  TaskProjectColor,
  TaskPriority,
  TaskResearchCard,
  TaskSnapshotChange,
  TaskSort,
  TaskView,
  TaskViewSection,
  TaskViewSectionId,
  UndoResult,
  UpdateTaskInput,
  UpdateListInput,
  UpdateProjectInput,
} from "../../src/shared/models";
import { LocalStore } from "./local-store";
import {
  createNextRecurringTask,
  getNextOccurrence,
  getTaskRecurrenceAnchor,
  shiftTemporal,
  validateRecurrenceRule,
} from "./recurrence";

export interface TaskServiceOptions {
  clock?: () => Date;
  idGenerator?: (prefix: "task" | "operation" | "draft") => string;
  timeZone?: string;
  operationLimit?: number;
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

export class UndoConflictError extends Error {
  constructor(operationId: string, taskId: string) {
    super(
      `Operation ${operationId} cannot be undone because task ${taskId} changed afterwards.`,
    );
    this.name = "UndoConflictError";
  }
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

const ARRAY_FIELDS = new Set([
  "tags",
  "contexts",
  "dependencyIds",
  "assigneeIds",
  "followerIds",
  "attachments",
  "links",
  "reminders",
  "focusSessions",
  "comments",
  "researchCards",
]);
const EMPTY_STRING_FIELDS = new Set(["notes", "privateNotes"]);
const TODAY_PLAN_PRIVATE_FIELDS = [
  "plannedDate",
  "privateOrder",
  "estimatedMinutes",
] as const satisfies readonly (keyof Task)[];
const REQUIRED_FIELDS = new Set([
  "source",
  "title",
  "status",
  "priority",
  "focusElapsedSeconds",
  "focusSessions",
  "privateOrder",
  "sync",
]);
// These are the task values which can change Feishu itself.  Keep this list
// alongside `patchHasRemoteImpact`: an undo restores snapshots rather than a
// user-supplied patch, so it needs an equivalent comparison in order to queue
// the inverse remote write.  Without it, undoing an already-synced Feishu
// edit restored a local `{ status: "synced" }` snapshot and left the remote
// task at the newer value forever.
const FEISHU_REMOTE_SNAPSHOT_FIELDS = [
  "source",
  "title",
  "notes",
  "status",
  "startAt",
  "startAtIsAllDay",
  "dueAt",
  "dueAtIsAllDay",
  "completedAt",
  "assigneeIds",
  "followerIds",
  "deletedAt",
] as const;
const MUTABLE_TASK_FIELDS = new Set([
  "source",
  "title",
  "notes",
  "privateNotes",
  "status",
  "flagged",
  "deferUntil",
  "priority",
  "projectId",
  "listId",
  "sectionId",
  "tags",
  "contexts",
  "parentId",
  "dependencyIds",
  "assigneeIds",
  "followerIds",
  "attachments",
  "links",
  "customFields",
  "comments",
  "researchCards",
  "plannedDate",
  "startAt",
  "startAtIsAllDay",
  "dueAt",
  "dueAtIsAllDay",
  "timeBlock",
  "reminders",
  "completedAt",
  "recurrence",
  "recurrenceSeriesId",
  "recurrenceIndex",
  "estimatedMinutes",
  "actualMinutes",
  "focusStartedAt",
  "focusElapsedSeconds",
  "focusSessions",
  "privateOrder",
  "completionMode",
  "currentUserRole",
  "currentUserCompleted",
  "sync",
]);

const deepClone = <Value>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;
const deepEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Fields a user can meaningfully recognize in the task inspector history.
 * Internal `updatedAt`, sync bookkeeping and identity fields are deliberately
 * omitted: a background refresh must not make the timeline look noisy. */
const TASK_HISTORY_FIELDS = [
  "title",
  "notes",
  "privateNotes",
  "status",
  "flagged",
  "deferUntil",
  "completedAt",
  "priority",
  "projectId",
  "listId",
  "sectionId",
  "tags",
  "contexts",
  "parentId",
  "dependencyIds",
  "assigneeIds",
  "followerIds",
  "attachments",
  "links",
  "customFields",
  "plannedDate",
  "startAt",
  "startAtIsAllDay",
  "dueAt",
  "dueAtIsAllDay",
  "timeBlock",
  "reminders",
  "recurrence",
  "recurrenceSeriesId",
  "recurrenceIndex",
  "estimatedMinutes",
  "actualMinutes",
  "focusStartedAt",
  "focusElapsedSeconds",
  "focusSessions",
  "privateOrder",
  "completionMode",
  "currentUserRole",
  "currentUserCompleted",
  "deletedAt",
  "comments",
  "researchCards",
] as const satisfies readonly (keyof Task)[];

const PROJECT_COLORS: readonly TaskProjectColor[] = [
  "violet",
  "blue",
  "green",
  "amber",
  "rose",
  "slate",
];

function assertProjectColor(value: unknown): asserts value is TaskProjectColor {
  if (typeof value !== "string" || !PROJECT_COLORS.includes(value as TaskProjectColor)) {
    throw new TaskValidationError("Project color is invalid.");
  }
}

function assertListColor(value: unknown): asserts value is TaskListColor {
  assertProjectColor(value);
}

const normalizeProjectName = (value: unknown): string => {
  if (typeof value !== "string") throw new TaskValidationError("Project name must be text.");
  const name = value.trim();
  if (name.length === 0) throw new TaskValidationError("Project name cannot be empty.");
  if (name.length > 80) throw new TaskValidationError("Project name cannot exceed 80 characters.");
  return name;
};

const normalizeListName = (value: unknown): string => {
  if (typeof value !== "string") throw new TaskValidationError("List name must be text.");
  const name = value.trim();
  if (name.length === 0) throw new TaskValidationError("List name cannot be empty.");
  if (name.length > 80) throw new TaskValidationError("List name cannot exceed 80 characters.");
  return name;
};

const uniqueStrings = (values: string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

const validateBulkTaskEditPatch = (patch: BulkTaskEditPatch): BulkTaskEditPatch => {
  if (patch === null || typeof patch !== "object") {
    throw new TaskValidationError("批量编辑内容不正确。");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !["priority", "flagged", "projectId", "listId", "tags"].includes(key))) {
    throw new TaskValidationError("批量编辑只支持重点标记、优先级、项目、清单和标签。");
  }
  if (patch.priority !== undefined && !Object.prototype.hasOwnProperty.call(PRIORITY_RANK, patch.priority)) {
    throw new TaskValidationError("批量编辑优先级不正确。");
  }
  if (patch.flagged !== undefined && typeof patch.flagged !== "boolean") {
    throw new TaskValidationError("批量编辑重点标记不正确。");
  }
  for (const [field, value] of [["projectId", patch.projectId], ["listId", patch.listId]] as const) {
    if (value !== undefined && value !== null && (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 200)) {
      throw new TaskValidationError(`批量编辑 ${field} 不正确。`);
    }
  }
  if (patch.tags !== undefined) {
    if (patch.tags === null || typeof patch.tags !== "object" || !["replace", "add", "remove"].includes(patch.tags.mode) || !Array.isArray(patch.tags.values)) {
      throw new TaskValidationError("批量编辑标签操作不正确。");
    }
    if (patch.tags.values.length > 20) {
      throw new TaskValidationError("一次最多处理 20 个标签。");
    }
    const values = patch.tags.values.map((value) => {
      if (typeof value !== "string") throw new TaskValidationError("批量编辑标签必须是文字。");
      const normalized = value.trim();
      if (normalized.length === 0 || normalized.length > 40) {
        throw new TaskValidationError("标签必须是 1–40 个字符。");
      }
      return normalized;
    });
    if (new Set(values).size !== values.length) {
      throw new TaskValidationError("批量编辑标签不能重复。");
    }
    return {
      ...patch,
      projectId: typeof patch.projectId === "string" ? patch.projectId.trim() : patch.projectId,
      listId: typeof patch.listId === "string" ? patch.listId.trim() : patch.listId,
      tags: { mode: patch.tags.mode, values },
    };
  }
  return {
    ...patch,
    projectId: typeof patch.projectId === "string" ? patch.projectId.trim() : patch.projectId,
    listId: typeof patch.listId === "string" ? patch.listId.trim() : patch.listId,
  };
};

const validateContexts = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) {
    throw new TaskValidationError(`${field} must be an array.`);
  }
  if (value.length > 20) {
    throw new TaskValidationError(`${field} cannot contain more than 20 entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new TaskValidationError(`${field}[${index}] must be text.`);
    }
    const context = entry.trim().replace(/\s+/gu, " ");
    if (context.length === 0 || context.length > 40) {
      throw new TaskValidationError(`${field}[${index}] must be 1-40 characters.`);
    }
    const key = context.toLocaleLowerCase();
    if (seen.has(key)) {
      throw new TaskValidationError(`${field} contains duplicate contexts.`);
    }
    seen.add(key);
    return context;
  });
};

const assertLocalDate = (value: string, field: string): void => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new TaskValidationError(`${field} must use YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TaskValidationError(`${field} is not a valid calendar date.`);
  }
};

const assertDateTime = (value: string, field: string): void => {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new TaskValidationError(`${field} is not a valid date-time.`);
  }
};

const validateComments = (value: unknown, field: string): TaskComment[] => {
  if (!Array.isArray(value)) {
    throw new TaskValidationError(`${field} must be an array.`);
  }
  if (value.length > 100) {
    throw new TaskValidationError(`${field} cannot contain more than 100 entries.`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `${field}[${index}]`;
    if (entry === null || typeof entry !== "object") {
      throw new TaskValidationError(`${path} must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
      throw new TaskValidationError(`${path}.id must be a non-empty string.`);
    }
    const id = candidate.id.trim();
    if (ids.has(id)) throw new TaskValidationError(`${field} contains duplicate ids.`);
    ids.add(id);
    if (typeof candidate.body !== "string") {
      throw new TaskValidationError(`${path}.body must be text.`);
    }
    const body = candidate.body.trim();
    if (body.length === 0) throw new TaskValidationError(`${path}.body cannot be empty.`);
    if (body.length > 10_000) throw new TaskValidationError(`${path}.body cannot exceed 10000 characters.`);
    const author = candidate.author ?? "user";
    if (author !== "user" && author !== "agent") {
      throw new TaskValidationError(`${path}.author is invalid.`);
    }
    if (typeof candidate.createdAt !== "string") {
      throw new TaskValidationError(`${path}.createdAt must be a date-time.`);
    }
    if (typeof candidate.updatedAt !== "string") {
      throw new TaskValidationError(`${path}.updatedAt must be a date-time.`);
    }
    assertDateTime(candidate.createdAt, `${path}.createdAt`);
    assertDateTime(candidate.updatedAt, `${path}.updatedAt`);
    if (new Date(candidate.updatedAt).getTime() < new Date(candidate.createdAt).getTime()) {
      throw new TaskValidationError(`${path}.updatedAt cannot be before createdAt.`);
    }
    return {
      id,
      body,
      author,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    };
  });
};

const validateResearchCards = (
  value: unknown,
  field: string,
): TaskResearchCard[] => {
  if (!Array.isArray(value)) {
    throw new TaskValidationError(`${field} must be an array.`);
  }
  if (value.length > 20) {
    throw new TaskValidationError(`${field} cannot contain more than 20 cards.`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `${field}[${index}]`;
    if (entry === null || typeof entry !== "object") {
      throw new TaskValidationError(`${path} must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
      throw new TaskValidationError(`${path}.id must be a non-empty string.`);
    }
    const id = candidate.id.trim();
    if (ids.has(id)) throw new TaskValidationError(`${field} contains duplicate ids.`);
    ids.add(id);
    if (typeof candidate.title !== "string") {
      throw new TaskValidationError(`${path}.title must be text.`);
    }
    const title = candidate.title.trim();
    if (title.length === 0 || title.length > 200) {
      throw new TaskValidationError(`${path}.title must be 1-200 characters.`);
    }
    let url: string | undefined;
    if (candidate.url !== undefined) {
      if (typeof candidate.url !== "string") {
        throw new TaskValidationError(`${path}.url must be text.`);
      }
      const rawUrl = candidate.url.trim();
      if (rawUrl.length > 2_000) {
        throw new TaskValidationError(`${path}.url cannot exceed 2000 characters.`);
      }
      if (rawUrl) {
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          throw new TaskValidationError(`${path}.url must be a valid URL.`);
        }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new TaskValidationError(`${path}.url must be an HTTP(S) URL without credentials.`);
        }
        url = rawUrl;
      }
    }
    if (typeof candidate.summary !== "string") {
      throw new TaskValidationError(`${path}.summary must be text.`);
    }
    const summary = candidate.summary.trim();
    if (summary.length > 5_000) {
      throw new TaskValidationError(`${path}.summary cannot exceed 5000 characters.`);
    }
    if (!Array.isArray(candidate.actionItems)) {
      throw new TaskValidationError(`${path}.actionItems must be an array.`);
    }
    if (candidate.actionItems.length > 20) {
      throw new TaskValidationError(`${path}.actionItems cannot contain more than 20 entries.`);
    }
    const actionItems = candidate.actionItems.map((item, actionIndex) => {
      if (typeof item !== "string") {
        throw new TaskValidationError(`${path}.actionItems[${actionIndex}] must be text.`);
      }
      const text = item.trim();
      if (text.length === 0 || text.length > 500) {
        throw new TaskValidationError(`${path}.actionItems[${actionIndex}] must be 1-500 characters.`);
      }
      return text;
    });
    if (typeof candidate.capturedAt !== "string") {
      throw new TaskValidationError(`${path}.capturedAt must be a date-time.`);
    }
    assertDateTime(candidate.capturedAt, `${path}.capturedAt`);
    return {
      id,
      title,
      ...(url === undefined ? {} : { url }),
      summary,
      actionItems,
      capturedAt: candidate.capturedAt,
    };
  });
};

const validateTask = (task: Task): Task => {
  task.title = task.title.trim();
  if (task.title.length === 0) {
    throw new TaskValidationError("Task title cannot be empty.");
  }
  if (task.flagged !== undefined && typeof task.flagged !== "boolean") {
    throw new TaskValidationError("Task flagged value must be boolean.");
  }
  if (task.sectionId !== undefined) {
    task.sectionId = task.sectionId.trim();
    if (task.sectionId.length === 0) delete task.sectionId;
    else if (task.sectionId.length > 80) {
      throw new TaskValidationError("Task section heading cannot exceed 80 characters.");
    }
  }
  task.tags = uniqueStrings(task.tags);
  task.contexts = validateContexts(task.contexts ?? [], "contexts");
  task.dependencyIds = uniqueStrings(task.dependencyIds).filter(
    (id) => id !== task.id,
  );
  task.assigneeIds = uniqueStrings(task.assigneeIds);
  task.followerIds = uniqueStrings(task.followerIds);
  task.comments = validateComments(task.comments ?? [], "comments");
  task.researchCards = validateResearchCards(
    task.researchCards ?? [],
    "researchCards",
  );

  if (task.plannedDate !== undefined)
    assertLocalDate(task.plannedDate, "plannedDate");
  if (task.deferUntil !== undefined)
    assertLocalDate(task.deferUntil, "deferUntil");
  if (task.startAt !== undefined) assertDateTime(task.startAt, "startAt");
  if (task.dueAt !== undefined) assertDateTime(task.dueAt, "dueAt");
  // A false/missing flag has the same meaning as a timed task. Normalize it
  // away and never allow a dangling all-day flag after its time was cleared.
  if (task.startAt === undefined || task.startAtIsAllDay !== true) {
    delete task.startAtIsAllDay;
  }
  if (task.dueAt === undefined || task.dueAtIsAllDay !== true) {
    delete task.dueAtIsAllDay;
  }
  if (
    task.startAt !== undefined &&
    task.dueAt !== undefined &&
    new Date(task.dueAt).getTime() < new Date(task.startAt).getTime()
  ) {
    throw new TaskValidationError("A task due time cannot be before its start time.");
  }
  if (task.completedAt !== undefined)
    assertDateTime(task.completedAt, "completedAt");
  if (task.focusStartedAt !== undefined)
    assertDateTime(task.focusStartedAt, "focusStartedAt");

  if (task.timeBlock !== undefined) {
    assertDateTime(task.timeBlock.startAt, "timeBlock.startAt");
    assertDateTime(task.timeBlock.endAt, "timeBlock.endAt");
    if (
      new Date(task.timeBlock.endAt).getTime() <=
      new Date(task.timeBlock.startAt).getTime()
    ) {
      throw new TaskValidationError("A time block must end after it starts.");
    }
  }
  task.reminders.forEach((reminder) =>
    assertDateTime(reminder.at, "reminder.at"),
  );
  task.focusSessions ??= [];
  task.focusSessions.forEach((session) => {
    assertDateTime(session.startedAt, "focusSessions.startedAt");
    assertDateTime(session.endedAt, "focusSessions.endedAt");
    if (
      !Number.isInteger(session.elapsedSeconds) ||
      session.elapsedSeconds < 0 ||
      new Date(session.endedAt).getTime() <
        new Date(session.startedAt).getTime()
    ) {
      throw new TaskValidationError(
        "A focus session must have a valid non-negative duration.",
      );
    }
  });

  for (const [field, value] of [
    ["estimatedMinutes", task.estimatedMinutes],
    ["actualMinutes", task.actualMinutes],
    ["focusElapsedSeconds", task.focusElapsedSeconds],
    ["privateOrder", task.privateOrder],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new TaskValidationError(`${field} cannot be negative.`);
    }
  }
  if (task.recurrence !== undefined) {
    task.recurrence = validateRecurrenceRule(task.recurrence);
    if (
      task.recurrence.frequency === "monthly" &&
      task.recurrence.dayOfMonth === undefined
    ) {
      const anchor =
        task.dueAt ??
        task.plannedDate ??
        task.startAt ??
        task.timeBlock?.startAt;
      if (anchor !== undefined) {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(anchor)
          ? new Date(`${anchor}T00:00:00.000Z`)
          : new Date(anchor);
        task.recurrence.dayOfMonth = date.getUTCDate();
      }
    }
  }
  return task;
};

const dateToLocalKey = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const temporalToLocalKey = (
  value: string | undefined,
  timeZone: string,
): string | undefined => {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : dateToLocalKey(parsed, timeZone);
};

const earliestDateKey = (task: Task, timeZone: string): string | undefined => {
  const values = [task.plannedDate, task.startAt, task.dueAt]
    .map((value) => temporalToLocalKey(value, timeZone))
    .filter((value): value is string => value !== undefined)
    .sort();
  return values[0];
};

const upcomingDateKey = (
  task: Task,
  today: string,
  timeZone: string,
): string | undefined => {
  if (task.deferUntil !== undefined && task.deferUntil > today) {
    return task.deferUntil;
  }
  return earliestDateKey(task, timeZone);
};

const taskMatchesToday = (
  task: Task,
  today: string,
  timeZone: string,
): boolean => {
  const due = temporalToLocalKey(task.dueAt, timeZone);
  const planned = temporalToLocalKey(task.plannedDate, timeZone);
  const start = temporalToLocalKey(task.startAt, timeZone);
  if (
    task.status === "open" &&
    task.deferUntil !== undefined &&
    task.deferUntil > today
  ) {
    return false;
  }
  if (task.status === "completed") {
    return (
      temporalToLocalKey(task.completedAt, timeZone) === today ||
      due === today ||
      planned === today
    );
  }
  return (
    task.status === "open" &&
    ((due !== undefined && due <= today) ||
      (planned !== undefined && planned <= today) ||
      start === today)
  );
};

const matchesView = (
  task: Task,
  view: TaskView,
  today: string,
  timeZone: string,
): boolean => {
  if (view === "trash") return task.deletedAt !== undefined;
  if (task.deletedAt !== undefined) return false;
  if (view === "completed") return task.status === "completed";
  if (view === "today") return taskMatchesToday(task, today, timeZone);
  if (view === "upcoming") {
    const date = upcomingDateKey(task, today, timeZone);
    return task.status === "open" && date !== undefined && date > today;
  }
  if (view === "deferred") {
    return (
      task.status === "open" &&
      task.deferUntil !== undefined &&
      task.deferUntil > today
    );
  }
  if (view === "inbox") {
    return (
      task.status === "open" &&
      task.projectId === undefined &&
      task.listId === undefined &&
      task.plannedDate === undefined &&
      task.deferUntil === undefined &&
      task.startAt === undefined &&
      task.dueAt === undefined
    );
  }
  return task.status === "open";
};

const todaySection = (
  task: Task,
  today: string,
  timeZone: string,
): TaskViewSectionId => {
  if (task.deletedAt !== undefined) return "trash";
  if (task.status === "completed") return "completed";
  const due = temporalToLocalKey(task.dueAt, timeZone);
  if (due !== undefined && due < today) return "overdue";
  const planned = temporalToLocalKey(task.plannedDate, timeZone);
  if (planned !== undefined && planned < today) return "overdue";
  if (due === today) return "due-today";
  if (
    planned === today ||
    temporalToLocalKey(task.startAt, timeZone) === today
  ) {
    return "planned-today";
  }
  return "open";
};

const sectionForView = (
  task: Task,
  view: TaskView | undefined,
  today: string,
  timeZone: string,
): TaskViewSectionId => {
  if (view === "today") return todaySection(task, today, timeZone);
  if (view === "trash") return "trash";
  if (view === "completed" || task.status === "completed") return "completed";
  if (view === "upcoming") return "upcoming";
  if (view === "deferred") return "deferred";
  if (view === "inbox") return "inbox";
  return "open";
};

const defaultSort = (view: TaskView | undefined): TaskSort[] => {
  if (view === "upcoming")
    return [{ field: "plannedDate" }, { field: "dueAt" }];
  if (view === "deferred") return [{ field: "deferUntil" }];
  if (view === "completed") return [{ field: "updatedAt", direction: "desc" }];
  if (view === "trash") return [{ field: "updatedAt", direction: "desc" }];
  return [
    { field: "privateOrder" },
    { field: "priority", direction: "desc" },
    { field: "dueAt" },
    { field: "createdAt" },
  ];
};

const sortFieldValue = (
  task: Task,
  sort: TaskSort,
): string | number | undefined => {
  if (sort.field === "priority") return PRIORITY_RANK[task.priority];
  return task[sort.field];
};

const compareOptional = (
  left: string | number | undefined,
  right: string | number | undefined,
  direction: "asc" | "desc",
): number => {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const comparison =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), "zh-CN");
  return direction === "desc" ? -comparison : comparison;
};

export class TaskService {
  private readonly clock: () => Date;
  private readonly idGenerator: NonNullable<TaskServiceOptions["idGenerator"]>;
  private readonly timeZone: string;
  private readonly operationLimit: number;

  constructor(
    private readonly store: LocalStore,
    options: TaskServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator =
      options.idGenerator ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.timeZone =
      options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.operationLimit = options.operationLimit ?? 200;
  }

  async initialize(): Promise<LocalAppState> {
    return this.store.initialize();
  }

  async listProjects(includeArchived = false): Promise<TaskProject[]> {
    const projects = Object.values((await this.store.load()).projects ?? {});
    return projects
      .filter((project) => includeArchived || !project.archived)
      .sort((left, right) =>
        left.privateOrder - right.privateOrder ||
        left.name.localeCompare(right.name, "zh-CN") ||
        left.id.localeCompare(right.id),
      )
      .map((project) => deepClone(project));
  }

  async createProject(input: CreateProjectInput): Promise<TaskProject> {
    return this.store.transact((state) => {
      const name = normalizeProjectName(input.name);
      const color = input.color ?? "violet";
      assertProjectColor(color);
      this.assertUniqueProjectName(state, name);
      const now = this.now();
      const id = `project_${randomUUID()}`;
      const project: TaskProject = {
        id,
        name,
        color,
        archived: false,
        privateOrder: this.nextProjectOrder(state),
        createdAt: now,
        updatedAt: now,
      };
      state.projects[id] = project;
      return deepClone(project);
    });
  }

  async updateProject(id: string, patch: UpdateProjectInput): Promise<TaskProject> {
    return this.store.transact((state) => {
      const current = this.requireProject(state, id);
      const next = deepClone(current);
      if (patch.name !== undefined) {
        const name = normalizeProjectName(patch.name);
        if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
          this.assertUniqueProjectName(state, name, id);
        }
        next.name = name;
      }
      if (patch.color !== undefined) {
        assertProjectColor(patch.color);
        next.color = patch.color;
      }
      if (patch.archived !== undefined) next.archived = patch.archived;
      if (patch.privateOrder !== undefined) {
        if (!Number.isFinite(patch.privateOrder) || patch.privateOrder < 0) {
          throw new TaskValidationError("Project order must be non-negative.");
        }
        next.privateOrder = patch.privateOrder;
      }
      next.updatedAt = this.now();
      state.projects[id] = next;
      return deepClone(next);
    });
  }

  async deleteProject(id: string): Promise<DeleteProjectResult> {
    return this.store.transact((state) => {
      this.requireProject(state, id);
      delete state.projects[id];
      const clearedTaskIds: string[] = [];
      const now = this.now();
      Object.values(state.tasks).forEach((task) => {
        if (task.projectId !== id) return;
        const updated = this.applyPatch(task, { projectId: null }, now, false);
        state.tasks[task.id] = updated;
        clearedTaskIds.push(task.id);
      });
      return { projectId: id, clearedTaskIds };
    });
  }

  async listLists(includeArchived = false): Promise<TaskList[]> {
    const lists = Object.values((await this.store.load()).lists ?? {});
    return lists
      .filter((list) => includeArchived || !list.archived)
      .sort((left, right) =>
        left.privateOrder - right.privateOrder ||
        left.name.localeCompare(right.name, "zh-CN") ||
        left.id.localeCompare(right.id),
      )
      .map((list) => deepClone(list));
  }

  async createList(input: CreateListInput): Promise<TaskList> {
    return this.store.transact((state) => {
      const name = normalizeListName(input.name);
      const color = input.color ?? "violet";
      assertListColor(color);
      this.assertUniqueListName(state, name);
      const now = this.now();
      const id = `list_${randomUUID()}`;
      const list: TaskList = {
        id,
        name,
        color,
        archived: false,
        privateOrder: this.nextListOrder(state),
        createdAt: now,
        updatedAt: now,
      };
      state.lists[id] = list;
      return deepClone(list);
    });
  }

  async updateList(id: string, patch: UpdateListInput): Promise<TaskList> {
    return this.store.transact((state) => {
      const current = this.requireList(state, id);
      const next = deepClone(current);
      if (patch.name !== undefined) {
        const name = normalizeListName(patch.name);
        if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
          this.assertUniqueListName(state, name, id);
        }
        next.name = name;
      }
      if (patch.color !== undefined) {
        assertListColor(patch.color);
        next.color = patch.color;
      }
      if (patch.archived !== undefined) next.archived = patch.archived;
      if (patch.privateOrder !== undefined) {
        if (!Number.isFinite(patch.privateOrder) || patch.privateOrder < 0) {
          throw new TaskValidationError("List order must be non-negative.");
        }
        next.privateOrder = patch.privateOrder;
      }
      next.updatedAt = this.now();
      state.lists[id] = next;
      return deepClone(next);
    });
  }

  async deleteList(id: string): Promise<DeleteListResult> {
    return this.store.transact((state) => {
      this.requireList(state, id);
      delete state.lists[id];
      const clearedTaskIds: string[] = [];
      const now = this.now();
      Object.values(state.tasks).forEach((task) => {
        if (task.listId !== id) return;
        const updated = this.applyPatch(task, { listId: null }, now, false);
        state.tasks[task.id] = updated;
        clearedTaskIds.push(task.id);
      });
      return { listId: id, clearedTaskIds };
    });
  }

  async getTask(id: TaskId, includeDeleted = false): Promise<Task | undefined> {
    const task = (await this.store.load()).tasks[id];
    if (task === undefined || (!includeDeleted && task.deletedAt !== undefined))
      return undefined;
    return deepClone(task);
  }

  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    const state = await this.store.load();
    const today = dateToLocalKey(
      filter.now === undefined ? this.clock() : new Date(filter.now),
      this.timeZone,
    );
    const text = filter.text?.trim().toLocaleLowerCase();

    const tasks = Object.values(state.tasks).filter((task) => {
      if (filter.view !== undefined) {
        if (!matchesView(task, filter.view, today, this.timeZone)) return false;
      } else if (!filter.includeDeleted && task.deletedAt !== undefined) {
        return false;
      }
      if (
        filter.sourceTypes !== undefined &&
        !filter.sourceTypes.includes(task.source.type)
      )
        return false;
      if (
        filter.accountIds !== undefined &&
        (task.source.accountId === undefined ||
          !filter.accountIds.includes(task.source.accountId))
      )
        return false;
      if (
        filter.projectIds !== undefined &&
        (task.projectId === undefined ||
          !filter.projectIds.includes(task.projectId))
      )
        return false;
      if (
        filter.listIds !== undefined &&
        (task.listId === undefined || !filter.listIds.includes(task.listId))
      )
        return false;
      if (
        filter.priorities !== undefined &&
        !filter.priorities.includes(task.priority)
      )
        return false;
      if (filter.flagged === true && task.flagged !== true) return false;
      if (
        filter.statuses !== undefined &&
        !filter.statuses.includes(task.status)
      )
        return false;
      if (filter.tags !== undefined) {
        const requestedTags = uniqueStrings(filter.tags);
        const matches = requestedTags.map((tag) => task.tags.includes(tag));
        if (
          (filter.tagMode ?? "any") === "all"
            ? matches.some((match) => !match)
            : !matches.some(Boolean)
        )
          return false;
      }
      if (filter.contexts !== undefined) {
        const requestedContexts = uniqueStrings(filter.contexts);
        const taskContexts = new Set(
          (task.contexts ?? []).map((context) => context.toLocaleLowerCase()),
        );
        const matches = requestedContexts.map((context) =>
          taskContexts.has(context.toLocaleLowerCase()),
        );
        if (
          (filter.contextMode ?? "any") === "all"
            ? matches.some((match) => !match)
            : !matches.some(Boolean)
        )
          return false;
      }
      if (
        filter.plannedFrom !== undefined &&
        (task.plannedDate === undefined ||
          task.plannedDate < filter.plannedFrom)
      )
        return false;
      if (
        filter.plannedTo !== undefined &&
        (task.plannedDate === undefined || task.plannedDate > filter.plannedTo)
      )
        return false;
      if (
        filter.dueFrom !== undefined &&
        (task.dueAt === undefined || task.dueAt < filter.dueFrom)
      )
        return false;
      if (
        filter.dueTo !== undefined &&
        (task.dueAt === undefined || task.dueAt > filter.dueTo)
      )
        return false;
      if (text !== undefined && text.length > 0) {
        const haystack = [
          task.title,
          task.notes,
          task.privateNotes,
          task.projectId,
          task.listId,
          task.sectionId,
          task.source.type,
          task.source.accountId,
          task.source.tenantId,
          task.source.externalId,
          ...task.tags,
          ...(task.contexts ?? []),
          ...task.attachments.flatMap((attachment) =>
            [attachment.name, attachment.mimeType, attachment.url].filter(
              (value): value is string => value !== undefined,
            ),
          ),
          ...task.links.flatMap((link) =>
            [link.label, link.url].filter(
              (value): value is string => value !== undefined,
            ),
          ),
          ...Object.entries(task.customFields).flatMap(([key, value]) => [
            key,
            typeof value === "string" ? value : JSON.stringify(value),
          ]),
          ...(task.comments ?? []).map((comment) => comment.body),
          ...(task.researchCards ?? []).flatMap((card) => [
            card.title,
            card.summary,
            card.url,
            ...card.actionItems,
          ]),
        ]
          .filter((value): value is string => value !== undefined)
          .join("\n")
          .toLocaleLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });

    const sorts = filter.sort ?? defaultSort(filter.view);
    tasks.sort((left, right) => {
      if (filter.view === "today") {
        const sectionOrder: TaskViewSectionId[] = [
          "overdue",
          "due-today",
          "planned-today",
          "open",
          "completed",
        ];
        const groupComparison =
          sectionOrder.indexOf(todaySection(left, today, this.timeZone)) -
          sectionOrder.indexOf(todaySection(right, today, this.timeZone));
        if (groupComparison !== 0) return groupComparison;
      }
      if (filter.view === "upcoming") {
        const dateComparison = compareOptional(
          upcomingDateKey(left, today, this.timeZone),
          upcomingDateKey(right, today, this.timeZone),
          "asc",
        );
        if (dateComparison !== 0) return dateComparison;
      }
      if (filter.view === "deferred") {
        const dateComparison = compareOptional(
          left.deferUntil,
          right.deferUntil,
          "asc",
        );
        if (dateComparison !== 0) return dateComparison;
      }
      for (const sort of sorts) {
        const comparison = compareOptional(
          sortFieldValue(left, sort),
          sortFieldValue(right, sort),
          sort.direction ?? "asc",
        );
        if (comparison !== 0) return comparison;
      }
      return left.id.localeCompare(right.id);
    });
    return deepClone(tasks);
  }

  async getViewSections(filter: TaskFilter = {}): Promise<TaskViewSection[]> {
    const tasks = await this.listTasks(filter);
    const today = dateToLocalKey(
      filter.now === undefined ? this.clock() : new Date(filter.now),
      this.timeZone,
    );
    const sectionMap = new Map<TaskViewSectionId, Task[]>();
    tasks.forEach((task) => {
      const section = sectionForView(task, filter.view, today, this.timeZone);
      const existing = sectionMap.get(section) ?? [];
      existing.push(task);
      sectionMap.set(section, existing);
    });

    const order: TaskViewSectionId[] =
      filter.view === "today"
        ? ["overdue", "due-today", "planned-today", "open", "completed"]
        : ["inbox", "open", "upcoming", "deferred", "completed", "trash"];
    return order
      .filter((id) => sectionMap.has(id))
      .map((id) => ({ id, tasks: deepClone(sectionMap.get(id) ?? []) }));
  }

  async createTask(input: CreateTaskInput): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const now = this.now();
      const id = this.idGenerator("task");
      if (state.tasks[id] !== undefined) {
        throw new TaskStateError(`Generated duplicate task id: ${id}`);
      }
      const task = this.buildTask(id, input, now, this.nextPrivateOrder(state));
      this.assertNoDependencyCycle(state, task.id, task.dependencyIds);
      state.tasks[id] = task;
      const operation = this.recordOperation(
        state,
        "create",
        [this.change(null, task)],
        now,
      );
      return { task: deepClone(task), operationId: operation.id };
    });
  }

  async updateTask(
    id: TaskId,
    patch: UpdateTaskInput,
    recurrenceScope: RecurrenceEditScope = "this",
  ): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const selected = this.requireTask(state, id);
      this.requireNotDeleted(selected);
      const now = this.now();
      const targets = this.recurrenceTargets(state, selected, recurrenceScope);
      const changes: TaskSnapshotChange[] = [];
      let resultTask: Task | undefined;

      targets.forEach((task) => {
        const before = deepClone(task);
        const updated = this.applyPatch(
          task,
          patch,
          now,
          this.patchHasRemoteImpact(task, patch),
        );
        this.assertNoDependencyCycle(state, updated.id, updated.dependencyIds);
        state.tasks[task.id] = updated;
        changes.push(this.change(before, updated));
        if (task.id === id) resultTask = updated;
      });
      const operation = this.recordOperation(state, "update", changes, now);
      return {
        task: deepClone(resultTask ?? state.tasks[id]),
        operationId: operation.id,
      };
    });
  }

  async completeTask(
    id: TaskId,
    completedAt?: string,
  ): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      this.requireNotDeleted(task);
      if (task.status === "completed")
        throw new TaskStateError(`Task is already completed: ${id}`);
      if (
        task.source.type === "feishu" &&
        task.currentUserRole !== undefined &&
        task.currentUserRole !== "assignee"
      ) {
        throw new TaskStateError(
          `The current member cannot complete task: ${id}`,
        );
      }
      if (
        task.source.type === "feishu" &&
        task.completionMode === "all-assignees"
      ) {
        throw new TaskStateError(
          "飞书开放接口不支持完成会签任务中的“我的部分”；请在飞书中操作。",
        );
      }
      const now = this.now();
      const completion = completedAt ?? now;
      assertDateTime(completion, "completedAt");
      const before = deepClone(task);
      const completionPatch: UpdateTaskInput = {
        ...this.finishFocusPatch(task, now),
        status: "completed",
        completedAt: completion,
        focusStartedAt: null,
      };
      const updated = this.applyPatch(task, completionPatch, now, true);
      state.tasks[id] = updated;
      const changes = [this.change(before, updated)];

      const generatedTask = createNextRecurringTask(
        updated,
        this.idGenerator("task"),
        now,
        this.nextPrivateOrder(state),
      );
      if (generatedTask !== undefined) {
        if (state.tasks[generatedTask.id] !== undefined) {
          throw new TaskStateError(
            `Generated duplicate task id: ${generatedTask.id}`,
          );
        }
        state.tasks[generatedTask.id] = generatedTask;
        changes.push(this.change(null, generatedTask));
      }
      const operation = this.recordOperation(state, "complete", changes, now);
      return {
        task: deepClone(updated),
        operationId: operation.id,
        generatedTask:
          generatedTask === undefined ? undefined : deepClone(generatedTask),
      };
    });
  }

  /**
   * Move an open local recurring task to its next occurrence without creating
   * a second task. This mirrors the “skip this occurrence” affordance found in
   * mature recurring-task products while keeping the task identity, notes and
   * history intact. Provider-owned Feishu recurrences remain read-only.
   */
  async skipRecurringTask(id: TaskId): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      this.requireNotDeleted(task);
      if (task.source.type !== "local") {
        throw new TaskStateError(
          "飞书循环由飞书负责生成，请在飞书中跳过本次。",
        );
      }
      if (task.recurrence === undefined) {
        throw new TaskStateError(`Task is not recurring: ${id}`);
      }
      if (task.status !== "open") {
        throw new TaskStateError("只有未完成的循环任务可以跳过本次。");
      }
      if (task.focusStartedAt !== undefined) {
        throw new TaskStateError("请先暂停专注，再跳过本次循环。");
      }
      const anchor = getTaskRecurrenceAnchor(task);
      if (anchor === undefined) {
        throw new TaskStateError("这项循环任务没有可用日期，无法跳过本次。");
      }
      const currentIndex = task.recurrenceIndex ?? 0;
      const nextAnchor = getNextOccurrence(
        anchor,
        task.recurrence,
        currentIndex,
      );
      if (nextAnchor === undefined) {
        throw new TaskStateError("这已经是循环的最后一次，无法再跳过。");
      }

      const now = this.now();
      const before = deepClone(task);
      const patch: UpdateTaskInput = {
        recurrenceIndex: currentIndex + 1,
      };
      if (task.plannedDate !== undefined) {
        patch.plannedDate = shiftTemporal(task.plannedDate, anchor, nextAnchor);
      }
      if (task.startAt !== undefined) {
        patch.startAt = shiftTemporal(task.startAt, anchor, nextAnchor);
      }
      if (task.dueAt !== undefined) {
        patch.dueAt = shiftTemporal(task.dueAt, anchor, nextAnchor);
      }
      if (task.timeBlock !== undefined) {
        patch.timeBlock = {
          startAt: shiftTemporal(task.timeBlock.startAt, anchor, nextAnchor),
          endAt: shiftTemporal(task.timeBlock.endAt, anchor, nextAnchor),
        };
      }
      if (task.reminders.length > 0) {
        patch.reminders = task.reminders.map((reminder) => ({
          ...reminder,
          at: shiftTemporal(reminder.at, anchor, nextAnchor),
        }));
      }
      const updated = this.applyPatch(task, patch, now, false);
      state.tasks[id] = updated;
      const operation = this.recordOperation(
        state,
        "skip-recurring",
        [this.change(before, updated)],
        now,
      );
      return { task: deepClone(updated), operationId: operation.id };
    });
  }

  /**
   * Applies a user-reviewed batch as one transaction and one undoable
   * operation.  Every target is validated before the first write, and the
   * optional updatedAt baselines make a stale preview fail closed instead of
   * overwriting a newer edit or Feishu pull.
   */
  async applyBulkTaskAction(request: BulkTaskRequest): Promise<TaskOperation> {
    if (!Array.isArray(request.ids) || request.ids.length === 0) {
      throw new TaskValidationError("At least one task is required.");
    }
    if (request.ids.length > 500) {
      throw new TaskValidationError(
        "A batch cannot change more than 500 tasks at once.",
      );
    }
    if (new Set(request.ids).size !== request.ids.length) {
      throw new TaskValidationError("Batch task ids must be unique.");
    }
    const baselines = request.baselines ?? [];
    if (new Set(baselines.map((baseline) => baseline.id)).size !== baselines.length) {
      throw new TaskValidationError("Batch baselines must be unique.");
    }
    if (baselines.length > 0 &&
      (baselines.length !== request.ids.length ||
        request.ids.some((id) => !baselines.some((baseline) => baseline.id === id)))) {
      throw new TaskValidationError(
        "Batch baselines must include every selected task.",
      );
    }
    if (request.action.kind === "move-to-today" && request.action.date !== undefined) {
      assertLocalDate(request.action.date, "date");
    }
    if (request.action.kind === "complete" && request.action.completedAt !== undefined) {
      assertDateTime(request.action.completedAt, "completedAt");
    }
    const editPatch = request.action.kind === "edit"
      ? validateBulkTaskEditPatch(request.action.patch)
      : undefined;

    return this.store.transact((state) => {
      const now = this.now();
      const baselineById = new Map(baselines.map((baseline) => [baseline.id, baseline]));
      const targets = request.ids.map((id) => this.requireTask(state, id));

      // Validate the entire batch before mutating any task.  This is
      // particularly important for Feishu tasks where a single read-only or
      //会签 target must not leave the remainder locally completed.
      targets.forEach((task) => {
        const baseline = baselineById.get(task.id);
        if (baseline !== undefined && task.updatedAt !== baseline.updatedAt) {
          throw new TaskStateError(
            `任务“${task.title}”已发生变化，请重新选择后再批量操作。`,
          );
        }
        if (request.action.kind === "complete") {
          this.requireNotDeleted(task);
          if (task.status === "completed") {
            throw new TaskStateError(`Task is already completed: ${task.id}`);
          }
          if (
            task.source.type === "feishu" &&
            task.currentUserRole !== undefined &&
            task.currentUserRole !== "assignee"
          ) {
            throw new TaskStateError(
              `The current member cannot complete task: ${task.id}`,
            );
          }
          if (
            task.source.type === "feishu" &&
            task.completionMode === "all-assignees"
          ) {
            throw new TaskStateError(
              "飞书开放接口不支持完成会签任务中的“我的部分”；请在飞书中操作。",
            );
          }
        } else if (request.action.kind === "reopen") {
          this.requireNotDeleted(task);
          if (task.status !== "completed") {
            throw new TaskStateError(`Task is not completed: ${task.id}`);
          }
        } else if (request.action.kind === "move-to-today") {
          this.requireNotDeleted(task);
          if (task.status !== "open") {
            throw new TaskStateError(`Task is not open: ${task.id}`);
          }
        } else if (request.action.kind === "trash") {
          this.requireNotDeleted(task);
        } else if (request.action.kind === "restore") {
          if (task.deletedAt === undefined) {
            throw new TaskStateError(`Task is not in trash: ${task.id}`);
          }
        } else if (request.action.kind === "edit") {
          this.requireNotDeleted(task);
        }
      });

      const changes: TaskSnapshotChange[] = [];
      const today = dateToLocalKey(this.clock(), this.timeZone);
      const plannedDate = request.action.kind === "move-to-today"
        ? request.action.date ?? today
        : undefined;
      if (
        request.action.kind === "move-to-today" &&
        plannedDate !== today
      ) {
        throw new TaskStateError("今天已经变化，请重新选择后再批量操作。");
      }
      const completion = request.action.kind === "complete"
        ? request.action.completedAt ?? now
        : undefined;

      targets.forEach((task) => {
        const before = deepClone(task);
        let updated: Task;
        if (request.action.kind === "complete") {
          const completionPatch: UpdateTaskInput = {
            ...this.finishFocusPatch(task, now),
            status: "completed",
            completedAt: completion,
            focusStartedAt: null,
          };
          updated = this.applyPatch(task, completionPatch, now, true);
        } else if (request.action.kind === "reopen") {
          updated = this.applyPatch(
            task,
            { status: "open", completedAt: null, currentUserCompleted: false },
            now,
            true,
          );
        } else if (request.action.kind === "move-to-today") {
          updated = this.applyPatch(task, { plannedDate }, now, false);
        } else if (request.action.kind === "trash") {
          updated = deepClone(task);
          updated.deletedAt = now;
          updated.updatedAt = now;
          this.markSync(updated, true);
        } else if (request.action.kind === "restore") {
          updated = deepClone(task);
          delete updated.deletedAt;
          updated.updatedAt = now;
          this.markSync(updated, true);
        } else {
          const patch: UpdateTaskInput = {};
          if (editPatch?.priority !== undefined) patch.priority = editPatch.priority;
          if (editPatch?.flagged !== undefined) patch.flagged = editPatch.flagged;
          if (editPatch?.projectId !== undefined) patch.projectId = editPatch.projectId;
          if (editPatch?.listId !== undefined) patch.listId = editPatch.listId;
          if (editPatch?.tags !== undefined) {
            const current = task.tags;
            const values = editPatch.tags.values;
            patch.tags = editPatch.tags.mode === "replace"
              ? values
              : editPatch.tags.mode === "add"
                ? uniqueStrings([...current, ...values])
                : current.filter((tag) => !values.includes(tag));
          }
          updated = this.applyPatch(task, patch, now, false);
        }
        state.tasks[task.id] = updated;
        if (!deepEqual(before, updated)) changes.push(this.change(before, updated));

        if (request.action.kind === "complete") {
          const generatedTask = createNextRecurringTask(
            updated,
            this.idGenerator("task"),
            now,
            this.nextPrivateOrder(state),
          );
          if (generatedTask !== undefined) {
            if (state.tasks[generatedTask.id] !== undefined) {
              throw new TaskStateError(
                `Generated duplicate task id: ${generatedTask.id}`,
              );
            }
            state.tasks[generatedTask.id] = generatedTask;
            changes.push(this.change(null, generatedTask));
          }
        }
      });

      return deepClone(this.recordOperation(state, "bulk", changes, now));
    });
  }

  async reopenTask(id: TaskId): Promise<TaskMutationResult> {
    return this.mutateOne(
      id,
      "reopen",
      { status: "open", completedAt: null, currentUserCompleted: false },
      true,
    );
  }

  async moveToToday(id: TaskId, date?: string): Promise<TaskMutationResult> {
    const plannedDate = date ?? dateToLocalKey(this.clock(), this.timeZone);
    assertLocalDate(plannedDate, "plannedDate");
    return this.mutateOne(id, "move-to-today", { plannedDate }, false);
  }

  async reorderToday(taskIds: TaskId[], date?: string): Promise<TaskOperation> {
    const plannedDate = date ?? dateToLocalKey(this.clock(), this.timeZone);
    assertLocalDate(plannedDate, "plannedDate");
    if (new Set(taskIds).size !== taskIds.length) {
      throw new TaskValidationError("Today order contains duplicate task ids.");
    }

    return this.store.transact((state) => {
      const now = this.now();
      const changes = taskIds.map((id, index) => {
        const task = this.requireTask(state, id);
        this.requireNotDeleted(task);
        if (
          !taskMatchesToday(task, plannedDate, this.timeZone) ||
          task.status !== "open"
        ) {
          throw new TaskStateError(`Task is not an open Today task: ${id}`);
        }
        const before = deepClone(task);
        const updated = this.applyPatch(
          task,
          { privateOrder: index },
          now,
          false,
        );
        state.tasks[id] = updated;
        return this.change(before, updated);
      });
      return deepClone(
        this.recordOperation(state, "reorder-today", changes, now),
      );
    });
  }

  /**
   * Applies one user-reviewed daily plan as a single local transaction. The
   * operation only changes private planning fields, so Feishu deadlines and
   * other shared task data are never queued for remote sync. One operation id
   * also means the entire planning session can be undone in one click.
  */
  async applyTodayPlan(request: ApplyTodayPlanRequest): Promise<TaskOperation> {
    if (request.date !== undefined) assertLocalDate(request.date, "date");
    const selectedIds = request.items.map((item) => item.id);
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new TaskValidationError("Today plan contains duplicate task ids.");
    }
    if (new Set(request.clearTaskIds).size !== request.clearTaskIds.length) {
      throw new TaskValidationError("Today plan contains duplicate cleared task ids.");
    }
    const selected = new Set(selectedIds);
    if (request.clearTaskIds.some((id) => selected.has(id))) {
      throw new TaskValidationError("A task cannot be selected and cleared in the same Today plan.");
    }
    const baselineById = new Map(
      request.baselines.map((baseline) => [baseline.id, baseline]),
    );
    if (baselineById.size !== request.baselines.length) {
      throw new TaskValidationError("Today plan contains duplicate baselines.");
    }
    const touchedIds = [...selectedIds, ...request.clearTaskIds];
    if (touchedIds.length > 500) {
      throw new TaskValidationError(
        "Today plan cannot change more than 500 tasks at once.",
      );
    }
    if (
      baselineById.size !== touchedIds.length ||
      touchedIds.some((id) => !baselineById.has(id))
    ) {
      throw new TaskValidationError(
        "Today plan must include one baseline for every changed task.",
      );
    }
    request.items.forEach((item) => {
      if (
        item.estimatedMinutes !== undefined &&
        (!Number.isInteger(item.estimatedMinutes) ||
          item.estimatedMinutes < 5 ||
          item.estimatedMinutes > 720)
      ) {
        throw new TaskValidationError(
          "Today plan estimates must be whole minutes between 5 and 720.",
        );
      }
    });

    return this.store.transact((state) => {
      const clock = this.clock();
      const today = dateToLocalKey(clock, this.timeZone);
      const plannedDate = request.date ?? today;
      // The same atomic private-plan transaction is also used by the
      // evening-review "安排明天" entry.  A plan may target today or a
      // future local date, but never a date that has already rolled past;
      // this prevents an open sheet surviving midnight and writing a stale
      // plan onto yesterday.
      if (plannedDate < today) {
        throw new TaskStateError(
          "计划日期已经过去，请关闭后重新打开规划。",
        );
      }
      const now = clock.toISOString();
      const changes: TaskSnapshotChange[] = [];

      touchedIds.forEach((id) => {
        const task = this.requireTask(state, id);
        const baseline = baselineById.get(id)!;
        if (
          task.plannedDate !== baseline.plannedDate ||
          task.privateOrder !== baseline.privateOrder ||
          task.estimatedMinutes !== baseline.estimatedMinutes
        ) {
          throw new TaskStateError(
            `任务“${task.title}”的计划已在别处发生变化，请重新打开今日规划。`,
          );
        }
      });

      request.items.forEach((item, index) => {
        const task = this.requireTask(state, item.id);
        this.requireNotDeleted(task);
        if (task.status !== "open") {
          throw new TaskStateError(`Task is not open: ${item.id}`);
        }
        const before = deepClone(task);
        const patch: UpdateTaskInput = {
          privateOrder: index,
          // `plannedDate` is private. Persisting every confirmed selection is
          // what lets start-only and deadline-driven tasks carry over tomorrow
          // without changing any provider-owned Feishu time.
          plannedDate,
        };
        if (item.estimatedMinutes !== undefined) {
          patch.estimatedMinutes = item.estimatedMinutes;
        }
        const fieldsChanged =
          task.privateOrder !== index ||
          task.plannedDate !== plannedDate ||
          (item.estimatedMinutes !== undefined &&
            task.estimatedMinutes !== item.estimatedMinutes);
        if (!fieldsChanged) return;
        const updated = this.applyPatch(task, patch, now, false);
        state.tasks[item.id] = updated;
        changes.push(this.change(before, updated));
      });

      request.clearTaskIds.forEach((id) => {
        const task = this.requireTask(state, id);
        this.requireNotDeleted(task);
        if (task.status !== "open") {
          throw new TaskStateError(`Task is not open: ${id}`);
        }
        if (task.plannedDate === undefined || task.plannedDate > plannedDate) return;
        const before = deepClone(task);
        const updated = this.applyPatch(task, { plannedDate: null }, now, false);
        state.tasks[id] = updated;
        changes.push(this.change(before, updated));
      });

      return deepClone(this.recordOperation(state, "plan-today", changes, now));
    });
  }

  async startFocus(id: TaskId): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      this.requireNotDeleted(task);
      if (task.focusStartedAt !== undefined) {
        throw new TaskStateError(`Task focus timer is already running: ${id}`);
      }
      const now = this.now();
      const before = deepClone(task);
      const updated = this.applyPatch(
        task,
        { focusStartedAt: now },
        now,
        false,
      );
      state.tasks[id] = updated;
      const operation = this.recordOperation(
        state,
        "focus",
        [this.change(before, updated)],
        now,
      );
      return { task: deepClone(updated), operationId: operation.id };
    });
  }

  async pauseFocus(id: TaskId): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      this.requireNotDeleted(task);
      if (task.focusStartedAt === undefined) {
        throw new TaskStateError(`Task focus timer is not running: ${id}`);
      }
      const now = this.now();
      const elapsed = Math.max(
        0,
        Math.floor(
          (new Date(now).getTime() - new Date(task.focusStartedAt).getTime()) /
            1000,
        ),
      );
      const before = deepClone(task);
      const updated = this.applyPatch(
        task,
        {
          focusStartedAt: null,
          focusElapsedSeconds: task.focusElapsedSeconds + elapsed,
          focusSessions: [
            ...(task.focusSessions ?? []),
            {
              id: `${task.id}:focus:${now}`,
              startedAt: task.focusStartedAt,
              endedAt: now,
              elapsedSeconds: elapsed,
            },
          ],
        },
        now,
        false,
      );
      state.tasks[id] = updated;
      const operation = this.recordOperation(
        state,
        "focus",
        [this.change(before, updated)],
        now,
      );
      return { task: deepClone(updated), operationId: operation.id };
    });
  }

  async resetFocus(id: TaskId): Promise<TaskMutationResult> {
    return this.mutateOne(
      id,
      "focus",
      { focusStartedAt: null, focusElapsedSeconds: 0 },
      false,
    );
  }

  async moveToTrash(id: TaskId): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      this.requireNotDeleted(task);
      const now = this.now();
      const before = deepClone(task);
      const updated = deepClone(task);
      updated.deletedAt = now;
      updated.updatedAt = now;
      this.markSync(updated, true);
      state.tasks[id] = updated;
      const operation = this.recordOperation(
        state,
        "trash",
        [this.change(before, updated)],
        now,
      );
      return { task: deepClone(updated), operationId: operation.id };
    });
  }

  async restoreTask(id: TaskId): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      if (task.deletedAt === undefined)
        throw new TaskStateError(`Task is not in trash: ${id}`);
      const now = this.now();
      const before = deepClone(task);
      const updated = deepClone(task);
      delete updated.deletedAt;
      updated.updatedAt = now;
      this.markSync(updated, true);
      state.tasks[id] = updated;
      const operation = this.recordOperation(
        state,
        "restore",
        [this.change(before, updated)],
        now,
      );
      return { task: deepClone(updated), operationId: operation.id };
    });
  }

  async purgeTask(id: TaskId): Promise<TaskOperation> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      if (task.deletedAt === undefined)
        throw new TaskStateError("Only trashed tasks can be purged.");
      delete state.tasks[id];
      return deepClone(
        this.recordOperation(
          state,
          "purge",
          [this.change(task, null)],
          this.now(),
        ),
      );
    });
  }

  async purgeExpiredTrash(
    retentionDays = 30,
  ): Promise<TaskOperation | undefined> {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new TaskValidationError("retentionDays cannot be negative.");
    }
    return this.store.transact((state) => {
      const now = this.now();
      const cutoff = new Date(now).getTime() - retentionDays * 86_400_000;
      const expired = Object.values(state.tasks).filter(
        (task) =>
          task.deletedAt !== undefined &&
          new Date(task.deletedAt).getTime() <= cutoff,
      );
      if (expired.length === 0) return undefined;
      expired.forEach((task) => delete state.tasks[task.id]);
      return deepClone(
        this.recordOperation(
          state,
          "purge",
          expired.map((task) => this.change(task, null)),
          now,
        ),
      );
    });
  }

  async undo(operationId?: string): Promise<UndoResult> {
    return this.store.transact((state) => {
      const operation =
        operationId === undefined
          ? [...state.operations]
              .reverse()
              .find((candidate) => candidate.undoneAt === undefined)
          : state.operations.find((candidate) => candidate.id === operationId);
      if (operation === undefined)
        throw new TaskStateError("There is no operation to undo.");
      if (operation.undoneAt !== undefined)
        throw new TaskStateError(
          `Operation is already undone: ${operation.id}`,
        );
      if (
        new Set(operation.changes.map((change) => change.taskId)).size !==
        operation.changes.length
      ) {
        throw new TaskStateError(
          `Operation contains duplicate task changes: ${operation.id}`,
        );
      }

      if (operation.kind === "plan-today") {
        operation.changes.forEach((change) => {
          const current = state.tasks[change.taskId];
          if (!current || !change.before || !change.after) {
            throw new UndoConflictError(operation.id, change.taskId);
          }
          const currentRecord = current as unknown as Record<string, unknown>;
          const beforeRecord = change.before as unknown as Record<string, unknown>;
          const afterRecord = change.after as unknown as Record<string, unknown>;
          const changedFields = TODAY_PLAN_PRIVATE_FIELDS.filter(
            (field) => !deepEqual(beforeRecord[field], afterRecord[field]),
          );
          if (
            changedFields.some(
              (field) => !deepEqual(currentRecord[field], afterRecord[field]),
            )
          ) {
            throw new UndoConflictError(operation.id, change.taskId);
          }
        });

        const now = this.now();
        const restoredTasks = operation.changes.map((change) => {
          const current = state.tasks[change.taskId]!;
          const restored = deepClone(current);
          const restoredRecord = restored as unknown as Record<string, unknown>;
          const beforeRecord = change.before as unknown as Record<string, unknown>;
          const afterRecord = change.after as unknown as Record<string, unknown>;
          TODAY_PLAN_PRIVATE_FIELDS.forEach((field) => {
            if (deepEqual(beforeRecord[field], afterRecord[field])) return;
            if (beforeRecord[field] === undefined) {
              delete restoredRecord[field];
            } else {
              restoredRecord[field] = beforeRecord[field];
            }
          });
          restored.updatedAt = now;
          state.tasks[change.taskId] = restored;
          return deepClone(restored);
        });
        operation.undoneAt = now;
        return {
          operationId: operation.id,
          restoredTasks,
          removedTaskIds: [],
        };
      }

      operation.changes.forEach((change) => {
        const current = state.tasks[change.taskId];
        if (!deepEqual(current ?? null, change.after)) {
          throw new UndoConflictError(operation.id, change.taskId);
        }
      });

      const now = this.now();
      const restoredTasks: Task[] = [];
      const removedTaskIds: TaskId[] = [];
      operation.changes.forEach((change) => {
        if (change.before === null) {
          if (
            change.after !== null &&
            this.undoRequiresFeishuSync(change.before, change.after)
          ) {
            // Do not drop a Feishu-backed create from local storage outright.
            // A small recoverable tombstone gives the automatic sync queue an
            // exact remote ID to delete when the create had already reached
            // Feishu, while safely settling as a no-op when it had not.
            const tombstone = deepClone(change.after);
            tombstone.deletedAt = now;
            tombstone.updatedAt = now;
            this.markSync(tombstone, true);
            state.tasks[change.taskId] = tombstone;
          } else {
            delete state.tasks[change.taskId];
          }
          removedTaskIds.push(change.taskId);
        } else {
          const restored = deepClone(change.before);
          if (this.undoRequiresFeishuSync(change.before, change.after)) {
            // Reversing a remote field (including complete/reopen/trash) is a
            // new local intent, not merely a presentation rollback.  Mark it
            // pending so the mutation-driven coordinator pushes the inverse
            // state without asking the user to click "立即同步".
            restored.updatedAt = now;
            this.markSync(restored, true);
          }
          state.tasks[change.taskId] = restored;
          restoredTasks.push(deepClone(restored));
        }
      });
      operation.undoneAt = now;
      return { operationId: operation.id, restoredTasks, removedTaskIds };
    });
  }

  async getOperations(limit = this.operationLimit): Promise<TaskOperation[]> {
    const operations = (await this.store.load()).operations;
    return deepClone(
      operations.slice(Math.max(0, operations.length - limit)).reverse(),
    );
  }

  /**
   * Return a compact, task-scoped timeline derived from the existing local
   * operation log.  The operation log is already bounded and transactionally
   * persisted, so history does not introduce a second source of truth or a
   * new retention policy.  Only changed field names cross the service
   * boundary; snapshots remain in the main-process store for undo.
   */
  async getTaskHistory(
    taskId: TaskId,
    limit = Math.min(50, this.operationLimit),
  ): Promise<TaskHistoryEntry[]> {
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      throw new TaskValidationError("Task id cannot be empty.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TaskValidationError("Task history limit must be between 1 and 100.");
    }
    const operations = (await this.store.load()).operations;
    const entries: TaskHistoryEntry[] = [];
    for (let index = operations.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const operation = operations[index];
      if (!operation) continue;
      const changes = operation.changes.filter((change) => change.taskId === taskId);
      if (changes.length === 0) continue;
      const changedFields = new Set<string>();
      for (const change of changes) {
        if (change.before === null || change.after === null) {
          changedFields.add("task");
          continue;
        }
        for (const field of TASK_HISTORY_FIELDS) {
          if (
            !deepEqual(
              (change.before as unknown as Record<string, unknown>)[field],
              (change.after as unknown as Record<string, unknown>)[field],
            )
          ) {
            changedFields.add(field);
          }
        }
      }
      entries.push({
        taskId,
        operationId: operation.id,
        kind: operation.kind,
        createdAt: operation.createdAt,
        ...(operation.undoneAt ? { undoneAt: operation.undoneAt } : {}),
        changedFields: [...changedFields],
      });
    }
    return entries;
  }

  async saveDraft(input: SaveDraftInput): Promise<TaskDraft> {
    return this.store.transact((state) => {
      const now = this.now();
      const id = input.id ?? this.idGenerator("draft");
      const existing = state.drafts[id];
      if (input.id === undefined && existing !== undefined) {
        throw new TaskStateError(`Generated duplicate draft id: ${id}`);
      }
      const draft: TaskDraft = {
        id,
        kind: input.kind,
        text: input.text,
        taskId: input.taskId,
        data: input.data === undefined ? undefined : deepClone(input.data),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.drafts[id] = draft;
      return deepClone(draft);
    });
  }

  async getDraft(id: string): Promise<TaskDraft | undefined> {
    const draft = (await this.store.load()).drafts[id];
    return draft === undefined ? undefined : deepClone(draft);
  }

  async listDrafts(): Promise<TaskDraft[]> {
    return Object.values((await this.store.load()).drafts)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((draft) => deepClone(draft));
  }

  async deleteDraft(id: string): Promise<boolean> {
    return this.store.transact((state) => {
      if (state.drafts[id] === undefined) return false;
      delete state.drafts[id];
      return true;
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private buildTask(
    id: TaskId,
    input: CreateTaskInput,
    now: string,
    fallbackOrder: number,
  ): Task {
    const source = deepClone(input.source ?? { type: "local" as const });
    const status = input.status ?? "open";
    const task: Task = {
      id,
      source,
      title: input.title,
      notes: input.notes ?? "",
      privateNotes: input.privateNotes ?? "",
      status,
      priority: input.priority ?? "none",
      ...(input.flagged === true ? { flagged: true } : {}),
      deferUntil: input.deferUntil,
      projectId: input.projectId,
      listId: input.listId,
      sectionId: input.sectionId,
      tags: deepClone(input.tags ?? []),
      contexts: deepClone(input.contexts ?? []),
      parentId: input.parentId,
      dependencyIds: deepClone(input.dependencyIds ?? []),
      assigneeIds: deepClone(input.assigneeIds ?? []),
      followerIds: deepClone(input.followerIds ?? []),
      attachments: deepClone(input.attachments ?? []),
      links: deepClone(input.links ?? []),
      customFields: deepClone(input.customFields ?? {}),
      comments: deepClone(input.comments ?? []),
      researchCards: deepClone(input.researchCards ?? []),
      plannedDate: input.plannedDate,
      startAt: input.startAt,
      startAtIsAllDay: input.startAtIsAllDay,
      dueAt: input.dueAt,
      dueAtIsAllDay: input.dueAtIsAllDay,
      timeBlock:
        input.timeBlock === undefined ? undefined : deepClone(input.timeBlock),
      reminders: deepClone(input.reminders ?? []),
      completedAt:
        status === "completed" ? (input.completedAt ?? now) : undefined,
      recurrence:
        input.recurrence === undefined
          ? undefined
          : deepClone(input.recurrence),
      recurrenceSeriesId: input.recurrenceSeriesId,
      recurrenceIndex: input.recurrenceIndex,
      estimatedMinutes: input.estimatedMinutes,
      actualMinutes: input.actualMinutes,
      focusStartedAt: input.focusStartedAt,
      focusElapsedSeconds: input.focusElapsedSeconds ?? 0,
      focusSessions: deepClone(input.focusSessions ?? []),
      privateOrder: input.privateOrder ?? fallbackOrder,
      completionMode: input.completionMode,
      currentUserRole: input.currentUserRole,
      currentUserCompleted: input.currentUserCompleted,
      sync: deepClone(
        input.sync ?? { status: source.type === "local" ? "local" : "pending" },
      ),
      createdAt: now,
      updatedAt: now,
    };
    if (task.recurrence !== undefined) {
      task.recurrenceSeriesId ??= id;
      task.recurrenceIndex ??= 0;
    }
    return validateTask(task);
  }

  private applyPatch(
    inputTask: Task,
    patch: UpdateTaskInput,
    now: string,
    remoteImpact: boolean,
  ): Task {
    const task = deepClone(inputTask);
    const target = task as unknown as Record<string, unknown>;
    Object.entries(patch).forEach(([field, value]) => {
      if (!MUTABLE_TASK_FIELDS.has(field)) {
        throw new TaskValidationError(
          `Unknown or immutable task field: ${field}.`,
        );
      }
      if (value === undefined) return;
      if (value !== null) {
        target[field] = deepClone(value);
        return;
      }
      if (REQUIRED_FIELDS.has(field)) {
        throw new TaskValidationError(`${field} cannot be cleared.`);
      }
      if (ARRAY_FIELDS.has(field)) target[field] = [];
      else if (field === "customFields") target[field] = {};
      else if (EMPTY_STRING_FIELDS.has(field)) target[field] = "";
      else delete target[field];
    });

    // Unless the caller deliberately supplies the companion flag (the
    // desktop's visible 全天 switch and the Feishu adapter both do), editing or
    // clearing a timestamp converts that slot to a timed task. This prevents a
    // stale remote `is_all_day` bit from silently changing a later UI edit.
    if (patch.startAt !== undefined && patch.startAtIsAllDay === undefined) {
      delete task.startAtIsAllDay;
    }
    if (patch.dueAt !== undefined && patch.dueAtIsAllDay === undefined) {
      delete task.dueAtIsAllDay;
    }

    if (task.status === "completed" && task.completedAt === undefined)
      task.completedAt = now;
    if (task.status !== "completed") delete task.completedAt;
    if (task.recurrence === undefined) {
      delete task.recurrenceSeriesId;
      delete task.recurrenceIndex;
    } else {
      task.recurrenceSeriesId ??= task.id;
      task.recurrenceIndex ??= 0;
    }
    task.updatedAt = now;
    this.markSync(task, remoteImpact);
    return validateTask(task);
  }

  private markSync(task: Task, remoteImpact: boolean): void {
    if (!remoteImpact) return;
    if (task.source.type === "local") {
      task.sync = { status: "local" };
      return;
    }
    task.sync = { ...task.sync, status: "pending" };
    delete task.sync.error;
    delete task.sync.conflictFields;
  }

  private patchHasRemoteImpact(task: Task, patch: UpdateTaskInput): boolean {
    if (task.source.type !== "feishu") return true;
    const remoteFields = new Set([
      "source",
      "title",
      "notes",
      "status",
      "startAt",
      "startAtIsAllDay",
      "dueAt",
      "dueAtIsAllDay",
      "completedAt",
      "assigneeIds",
      "followerIds",
    ]);
    return Object.keys(patch).some((field) => remoteFields.has(field));
  }

  /**
   * An undo is snapshot-based, so `sync.status` cannot tell us whether the
   * snapshot reversal should leave the device.  Compare the supported shared
   * fields directly instead.  A create/delete also has a remote effect even
   * though one of its snapshots is absent.
   */
  private undoRequiresFeishuSync(
    before: Task | null,
    after: Task | null,
  ): boolean {
    const source = after?.source.type === "feishu" ? after : before;
    if (source?.source.type !== "feishu") return false;
    if (before === null || after === null) return true;
    return FEISHU_REMOTE_SNAPSHOT_FIELDS.some(
      (field) =>
        !deepEqual(
          (before as unknown as Record<string, unknown>)[field],
          (after as unknown as Record<string, unknown>)[field],
        ),
    );
  }

  private finishFocusPatch(task: Task, endedAt: string): UpdateTaskInput {
    if (task.focusStartedAt === undefined) return { focusStartedAt: null };
    const elapsed = Math.max(
      0,
      Math.floor(
        (new Date(endedAt).getTime() -
          new Date(task.focusStartedAt).getTime()) /
          1000,
      ),
    );
    return {
      focusStartedAt: null,
      focusElapsedSeconds: task.focusElapsedSeconds + elapsed,
      focusSessions: [
        ...(task.focusSessions ?? []),
        {
          id: `${task.id}:focus:${endedAt}`,
          startedAt: task.focusStartedAt,
          endedAt,
          elapsedSeconds: elapsed,
        },
      ],
    };
  }

  private async mutateOne(
    id: TaskId,
    kind: TaskOperationKind,
    patch: UpdateTaskInput,
    remoteImpact: boolean,
  ): Promise<TaskMutationResult> {
    return this.store.transact((state) => {
      const task = this.requireTask(state, id);
      this.requireNotDeleted(task);
      const now = this.now();
      const before = deepClone(task);
      const updated = this.applyPatch(task, patch, now, remoteImpact);
      state.tasks[id] = updated;
      const operation = this.recordOperation(
        state,
        kind,
        [this.change(before, updated)],
        now,
      );
      return { task: deepClone(updated), operationId: operation.id };
    });
  }

  private requireTask(state: LocalAppState, id: TaskId): Task {
    const task = state.tasks[id];
    if (task === undefined) throw new TaskNotFoundError(id);
    return task;
  }

  private requireNotDeleted(task: Task): void {
    if (task.deletedAt !== undefined)
      throw new TaskStateError(`Task is in trash: ${task.id}`);
  }

  /** Dependencies point from a task to the work that must come first. Keep
   * the graph acyclic so a blocked task can always have a meaningful next
   * action and project-health signals cannot deadlock forever. Missing IDs are
   * intentionally allowed for imported data and remain visibly blocked. */
  private assertNoDependencyCycle(
    state: LocalAppState,
    taskId: TaskId,
    dependencyIds: readonly TaskId[],
  ): void {
    const visiting = new Set<TaskId>();
    const visited = new Set<TaskId>();
    const walk = (id: TaskId, path: TaskId[]): void => {
      if (visiting.has(id)) {
        const cycleStart = path.indexOf(id);
        const cycle = [...path.slice(cycleStart), id].join(" → ");
        throw new TaskValidationError(`Dependency cycle is not allowed: ${cycle}`);
      }
      if (visited.has(id)) return;
      visiting.add(id);
      const dependencies = id === taskId
        ? dependencyIds
        : state.tasks[id]?.dependencyIds ?? [];
      dependencies.forEach((dependencyId) => {
        if (state.tasks[dependencyId] !== undefined) {
          walk(dependencyId, [...path, id]);
        }
      });
      visiting.delete(id);
      visited.add(id);
    };
    walk(taskId, []);
  }

  private recurrenceTargets(
    state: LocalAppState,
    selected: Task,
    scope: RecurrenceEditScope,
  ): Task[] {
    if (scope === "this" || selected.recurrenceSeriesId === undefined)
      return [selected];
    const selectedIndex = selected.recurrenceIndex ?? 0;
    return Object.values(state.tasks).filter((task) => {
      if (task.recurrenceSeriesId !== selected.recurrenceSeriesId) return false;
      if (task.deletedAt !== undefined) return false;
      if (scope === "series") return true;
      return (task.recurrenceIndex ?? 0) >= selectedIndex;
    });
  }

  private nextPrivateOrder(state: LocalAppState): number {
    return (
      Object.values(state.tasks).reduce(
        (maximum, task) => Math.max(maximum, task.privateOrder),
        -1,
      ) + 1
    );
  }

  private nextProjectOrder(state: LocalAppState): number {
    return (
      Object.values(state.projects ?? {}).reduce(
        (maximum, project) => Math.max(maximum, project.privateOrder),
        -1,
      ) + 1
    );
  }

  private nextListOrder(state: LocalAppState): number {
    return (
      Object.values(state.lists ?? {}).reduce(
        (maximum, list) => Math.max(maximum, list.privateOrder),
        -1,
      ) + 1
    );
  }

  private requireProject(state: LocalAppState, id: string): TaskProject {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new TaskValidationError("Project id is required.");
    }
    const project = state.projects[id];
    if (project === undefined) throw new TaskNotFoundError(`project:${id}`);
    return project;
  }

  private requireList(state: LocalAppState, id: string): TaskList {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new TaskValidationError("List id is required.");
    }
    const list = state.lists[id];
    if (list === undefined) throw new TaskNotFoundError(`list:${id}`);
    return list;
  }

  private assertUniqueProjectName(
    state: LocalAppState,
    name: string,
    exceptId?: string,
  ): void {
    const normalized = name.toLocaleLowerCase();
    const duplicate = Object.values(state.projects ?? {}).find(
      (project) => project.id !== exceptId && project.name.trim().toLocaleLowerCase() === normalized,
    );
    if (duplicate !== undefined) {
      throw new TaskValidationError(`Project name already exists: ${duplicate.name}`);
    }
  }

  private assertUniqueListName(
    state: LocalAppState,
    name: string,
    exceptId?: string,
  ): void {
    const normalized = name.toLocaleLowerCase();
    const duplicate = Object.values(state.lists ?? {}).find(
      (list) => list.id !== exceptId && list.name.trim().toLocaleLowerCase() === normalized,
    );
    if (duplicate !== undefined) {
      throw new TaskValidationError(`List name already exists: ${duplicate.name}`);
    }
  }

  private change(before: Task | null, after: Task | null): TaskSnapshotChange {
    const taskId = before?.id ?? after?.id;
    if (taskId === undefined)
      throw new TaskStateError("An operation change requires a task id.");
    return {
      taskId,
      before: before === null ? null : deepClone(before),
      after: after === null ? null : deepClone(after),
    };
  }

  private recordOperation(
    state: LocalAppState,
    kind: TaskOperationKind,
    changes: TaskSnapshotChange[],
    createdAt: string,
  ): TaskOperation {
    const id = this.idGenerator("operation");
    if (state.operations.some((operation) => operation.id === id)) {
      throw new TaskStateError(`Generated duplicate operation id: ${id}`);
    }
    const operation: TaskOperation = {
      id,
      kind,
      createdAt,
      changes: deepClone(changes),
    };
    state.operations.push(operation);
    if (state.operations.length > this.operationLimit) {
      state.operations.splice(0, state.operations.length - this.operationLimit);
    }
    return operation;
  }
}
