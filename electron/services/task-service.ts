import { randomUUID } from "node:crypto";
import type {
  CreateTaskInput,
  LocalAppState,
  RecurrenceEditScope,
  SaveDraftInput,
  Task,
  TaskDraft,
  TaskFilter,
  TaskId,
  TaskMutationResult,
  TaskOperation,
  TaskOperationKind,
  TaskPriority,
  TaskSnapshotChange,
  TaskSort,
  TaskView,
  TaskViewSection,
  TaskViewSectionId,
  UndoResult,
  UpdateTaskInput,
} from "../../src/shared/models";
import { LocalStore } from "./local-store";
import { createNextRecurringTask, validateRecurrenceRule } from "./recurrence";

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
  "dependencyIds",
  "assigneeIds",
  "followerIds",
  "attachments",
  "links",
  "reminders",
  "focusSessions",
]);
const EMPTY_STRING_FIELDS = new Set(["notes", "privateNotes"]);
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
  "priority",
  "projectId",
  "listId",
  "sectionId",
  "tags",
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

const uniqueStrings = (values: string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

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

const validateTask = (task: Task): Task => {
  task.title = task.title.trim();
  if (task.title.length === 0) {
    throw new TaskValidationError("Task title cannot be empty.");
  }
  task.tags = uniqueStrings(task.tags);
  task.dependencyIds = uniqueStrings(task.dependencyIds).filter(
    (id) => id !== task.id,
  );
  task.assigneeIds = uniqueStrings(task.assigneeIds);
  task.followerIds = uniqueStrings(task.followerIds);

  if (task.plannedDate !== undefined)
    assertLocalDate(task.plannedDate, "plannedDate");
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

const taskMatchesToday = (
  task: Task,
  today: string,
  timeZone: string,
): boolean => {
  const due = temporalToLocalKey(task.dueAt, timeZone);
  const planned = temporalToLocalKey(task.plannedDate, timeZone);
  const start = temporalToLocalKey(task.startAt, timeZone);
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
    const date = earliestDateKey(task, timeZone);
    return task.status === "open" && date !== undefined && date > today;
  }
  if (view === "inbox") {
    return (
      task.status === "open" &&
      task.projectId === undefined &&
      task.listId === undefined &&
      task.plannedDate === undefined &&
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
  if (view === "inbox") return "inbox";
  return "open";
};

const defaultSort = (view: TaskView | undefined): TaskSort[] => {
  if (view === "upcoming")
    return [{ field: "plannedDate" }, { field: "dueAt" }];
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
          earliestDateKey(left, this.timeZone),
          earliestDateKey(right, this.timeZone),
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
        : ["inbox", "open", "upcoming", "completed", "trash"];
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
      projectId: input.projectId,
      listId: input.listId,
      sectionId: input.sectionId,
      tags: deepClone(input.tags ?? []),
      parentId: input.parentId,
      dependencyIds: deepClone(input.dependencyIds ?? []),
      assigneeIds: deepClone(input.assigneeIds ?? []),
      followerIds: deepClone(input.followerIds ?? []),
      attachments: deepClone(input.attachments ?? []),
      links: deepClone(input.links ?? []),
      customFields: deepClone(input.customFields ?? {}),
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
