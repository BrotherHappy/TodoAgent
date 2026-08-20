import { randomUUID } from "node:crypto";

import { z } from "zod";
import type {
  AgentJsonValue,
  JsonSchema,
  ToolResult,
} from "../../src/shared/agent-types";
import type {
  CreateTaskInput,
  Task,
  TaskFilter,
  TaskSnapshotChange,
  TaskResearchCard,
  TaskSyncStatus,
  UpdateTaskInput,
} from "../../src/shared/models";
import type { ModelDataScope } from "../../src/shared/settings";
import type { TaskService } from "../services/task-service";
import type {
  ToolExecutionContext,
  TrustedToolDefinition,
} from "./tool-registry";
import {
  assertFeishuTaskCreationAvailable,
  assertFeishuTaskMutationAccount,
  assertTaskCreationSource,
  type AgentTaskSourcePolicy,
} from "./task-source-policy";

const taskViewSchema = z.enum([
  "inbox",
  "today",
  "upcoming",
  "all",
  "completed",
  "trash",
]);
const prioritySchema = z.enum(["none", "low", "medium", "high", "urgent"]);
const sourceSchema = z.enum(["local", "feishu"]);
const isValidLocalDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};
const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(isValidLocalDate, "Invalid calendar date.");
const isoDateSchema = z.string().datetime({ offset: true });
const idSchema = z.string().trim().min(1).max(512);
const operationIdSchema = z.string().trim().min(1).max(512);
const MAX_BULK_CREATE = 25;
const MAX_BULK_MUTATE = 50;
const MAX_SPLIT_STEPS = 7;
// Feishu currently exposes title, notes, start time and due time as mutable
// remote fields. Project/list placement remains a private local organization
// choice, just like plannedDate, tags and manual contexts.
const REMOTE_UPDATE_FIELDS = new Set(["title", "notes", "startAt", "dueAt"]);
// Keep this in sync with TaskService's snapshot comparison for undo. Unlike a
// normal update, an undo restores a whole snapshot, so status, all-day flags,
// membership, and recoverable deletion state can all require an inverse
// Feishu write.
const FEISHU_UNDO_REMOTE_FIELDS = [
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
] as const satisfies readonly (keyof Task)[];

type FeishuSyncReceiptAction =
  | "created"
  | "updated"
  | "completed"
  | "reopened"
  | "deleted"
  | "restored";

type FeishuSyncReceipt = Record<string, AgentJsonValue> & {
  taskId: string;
  action: FeishuSyncReceiptAction;
  status: TaskSyncStatus;
};

const listArgumentsSchema = z.strictObject({
  view: taskViewSchema.nullable(),
  text: z.string().max(1_000).nullable(),
  source: sourceSchema.nullable(),
  limit: z.number().int().min(1).max(500),
});

const getArgumentsSchema = z.strictObject({ id: idSchema });

const createArgumentsSchema = z.strictObject({
  title: z.string().trim().min(1).max(2_000),
  notes: z.string().max(50_000),
  source: sourceSchema,
  projectId: idSchema.nullable(),
  listId: idSchema.nullable(),
  plannedDate: localDateSchema.nullable(),
  startAt: isoDateSchema.nullable(),
  dueAt: isoDateSchema.nullable(),
  priority: prioritySchema,
  tags: z.array(z.string().trim().min(1).max(120)).max(100),
  contexts: z.array(z.string().trim().min(1).max(40)).max(20).nullable().optional(),
});

const updateArgumentsSchema = z
  .strictObject({
    id: idSchema,
    title: z.string().trim().min(1).max(2_000).nullable(),
    notes: z.string().max(50_000).nullable(),
    privateNotes: z.string().max(50_000).nullable(),
    projectId: idSchema.nullable(),
    listId: idSchema.nullable(),
    plannedDate: localDateSchema.nullable(),
    startAt: isoDateSchema.nullable(),
    dueAt: isoDateSchema.nullable(),
    priority: prioritySchema.nullable(),
    tags: z.array(z.string().trim().min(1).max(120)).max(100).nullable(),
    contexts: z.array(z.string().trim().min(1).max(40)).max(20).nullable().optional(),
    clearFields: z
      .array(
        z.enum([
          "notes",
          "privateNotes",
          "projectId",
          "listId",
          "plannedDate",
          "startAt",
          "dueAt",
          "tags",
          "contexts",
        ]),
      )
      .max(8),
  })
  .superRefine((args, context) => {
    const supplied = new Set(
      (
        [
          "title",
          "notes",
          "privateNotes",
          "projectId",
          "listId",
          "plannedDate",
          "startAt",
          "dueAt",
          "priority",
          "tags",
          "contexts",
        ] as const
      ).filter((field) => args[field] !== null && args[field] !== undefined),
    );
    if (supplied.size === 0 && args.clearFields.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one task field must change.",
      });
    }
    if (new Set(args.clearFields).size !== args.clearFields.length) {
      context.addIssue({
        code: "custom",
        path: ["clearFields"],
        message: "Fields to clear must be unique.",
      });
    }
    for (const field of args.clearFields) {
      if (supplied.has(field)) {
        context.addIssue({
          code: "custom",
          path: ["clearFields"],
          message: `${field} cannot be supplied and cleared in the same update.`,
        });
      }
    }
  });

const researchCardArgumentsSchema = z.strictObject({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  url: z
    .string()
    .trim()
    .max(2_000)
    .refine((value) => {
      if (!value) return true;
      try {
        const parsed = new URL(value);
        return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }, "Research card URL must be an HTTP(S) URL without credentials."),
  summary: z.string().max(5_000),
  actionItems: z.array(z.string().trim().min(1).max(500)).max(20),
});

const completeArgumentsSchema = z.strictObject({
  id: idSchema,
  completed: z.boolean(),
});

const trashArgumentsSchema = z.strictObject({ id: idSchema });
const restoreArgumentsSchema = z.strictObject({ id: idSchema });

const bulkPlanArgumentsSchema = z
  .strictObject({
    taskIds: z.array(idSchema).min(1).max(MAX_BULK_MUTATE),
    plannedDate: localDateSchema,
  })
  .superRefine((args, context) => {
    if (new Set(args.taskIds).size !== args.taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskIds"],
        message: "Task IDs must be unique.",
      });
    }
  });

const bulkCreateItemSchema = z.strictObject({
  title: z.string().trim().min(1).max(2_000),
  notes: z.string().max(50_000),
  projectId: idSchema.nullable(),
  listId: idSchema.nullable(),
  plannedDate: localDateSchema.nullable(),
  startAt: isoDateSchema.nullable(),
  dueAt: isoDateSchema.nullable(),
  priority: prioritySchema,
  tags: z.array(z.string().trim().min(1).max(120)).max(100),
  contexts: z.array(z.string().trim().min(1).max(40)).max(20).nullable().optional(),
});

const bulkCreateArgumentsSchema = z.strictObject({
  tasks: z.array(bulkCreateItemSchema).min(1).max(MAX_BULK_CREATE),
});

const splitTaskItemSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(5_000),
  priority: prioritySchema,
  estimatedMinutes: z.number().int().min(5).max(720).nullable(),
});

const splitTaskArgumentsSchema = z
  .strictObject({
    id: idSchema,
    subtasks: z.array(splitTaskItemSchema).min(2).max(MAX_SPLIT_STEPS),
  })
  .superRefine((args, context) => {
    const titles = args.subtasks.map((item) => item.title.toLocaleLowerCase());
    if (new Set(titles).size !== titles.length) {
      context.addIssue({
        code: "custom",
        path: ["subtasks"],
        message: "Subtask titles must be unique.",
      });
    }
  });

const bulkUpdateArgumentsSchema = z
  .strictObject({
    updates: z.array(updateArgumentsSchema).min(1).max(MAX_BULK_MUTATE),
  })
  .superRefine((args, context) => {
    const ids = args.updates.map((update) => update.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["updates"],
        message: "Task IDs must be unique.",
      });
    }
  });

const bulkCompletedArgumentsSchema = z
  .strictObject({
    taskIds: z.array(idSchema).min(1).max(MAX_BULK_MUTATE),
    completed: z.boolean(),
  })
  .superRefine((args, context) => {
    if (new Set(args.taskIds).size !== args.taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskIds"],
        message: "Task IDs must be unique.",
      });
    }
  });

const bulkTrashArgumentsSchema = z
  .strictObject({
    taskIds: z.array(idSchema).min(1).max(MAX_BULK_MUTATE),
  })
  .superRefine((args, context) => {
    if (new Set(args.taskIds).size !== args.taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskIds"],
        message: "Task IDs must be unique.",
      });
    }
  });

const bulkRestoreArgumentsSchema = z
  .strictObject({
    taskIds: z.array(idSchema).min(1).max(MAX_BULK_MUTATE),
  })
  .superRefine((args, context) => {
    if (new Set(args.taskIds).size !== args.taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["taskIds"],
        message: "Task IDs must be unique.",
      });
    }
  });

const moveToTodayArgumentsSchema = z.strictObject({ id: idSchema });

const setReminderArgumentsSchema = z
  .strictObject({
    id: idSchema,
    reminderId: idSchema.nullable(),
    at: isoDateSchema,
    label: z.string().trim().max(500).nullable(),
    enabled: z.boolean(),
  })
  .superRefine((args, context) => {
    if (args.reminderId === null && !args.enabled) {
      context.addIssue({
        code: "custom",
        path: ["enabled"],
        message:
          "A new reminder must be enabled. Supply reminderId to disable an existing reminder.",
      });
    }
  });

const undoTaskOperationArgumentsSchema = z.strictObject({
  operationId: operationIdSchema,
});

const parametersFor = <Arguments extends AgentJsonValue>(
  schema: z.ZodType<Arguments>,
): JsonSchema => {
  const converted = z.toJSONSchema(schema) as Record<string, unknown>;
  delete converted.$schema;
  // The model-facing contract stays strict even for renderer-side backward
  // compatibility fields such as `contexts`: the runtime parser may accept
  // an omitted legacy field, while every property is still declared required
  // in the JSON schema sent to the provider (nullable means “clear/unused”).
  const requireObjectProperties = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(requireObjectProperties);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "object" && record.properties && typeof record.properties === "object") {
      record.required = Object.keys(record.properties as Record<string, unknown>);
    }
    Object.values(record).forEach(requireObjectProperties);
  };
  requireObjectProperties(converted);
  return converted as JsonSchema;
};

const taskTool = <Arguments extends AgentJsonValue>(input: {
  name: string;
  description: string;
  schema: z.ZodType<Arguments>;
  sensitiveArgumentPaths?: string[];
  analyze: TrustedToolDefinition<Arguments>["analyze"];
  execute: TrustedToolDefinition<Arguments>["execute"];
}): TrustedToolDefinition<Arguments> => ({
  name: input.name,
  version: 1,
  description: input.description,
  parameters: parametersFor(input.schema),
  argumentsSchema: input.schema,
  sensitiveArgumentPaths: input.sensitiveArgumentPaths,
  analyze: input.analyze,
  execute: input.execute,
});

const result = (
  context: ToolExecutionContext,
  data: AgentJsonValue,
  status: ToolResult["status"] = "ok",
): ToolResult => ({
  invocationId: context.invocation.invocationId,
  status,
  data,
});

const compactTask = (task: Task, scope: ModelDataScope): AgentJsonValue => {
  if (!scope.taskTitlesAndTimes) {
    // Keep only an opaque local reference so a user can still explicitly target the
    // item later. Status, source, priority, tags, contexts and sync state can all reveal task
    // meaning or origin, so they cross the same privacy boundary as the title.
    return { id: task.id, redacted: true };
  }
  return {
    id: task.id,
    title: task.title,
    notes:
      scope.notes && (task.source.type === "local" || scope.feishuContent)
        ? task.notes
        : null,
    comments:
      scope.notes && (task.source.type === "local" || scope.feishuContent)
        ? (task.comments ?? []).map((comment) => ({
            body: comment.body,
            author: comment.author,
            createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        }))
        : null,
    researchCards:
      scope.notes && (task.source.type === "local" || scope.feishuContent)
        ? (task.researchCards ?? []).map((card) => ({
            id: card.id,
            title: card.title,
            url: card.url ?? null,
            summary: card.summary,
            actionItems: card.actionItems,
            capturedAt: card.capturedAt,
          }))
        : null,
    status: task.status,
    priority: task.priority,
    source: task.source.type,
    parentId: task.parentId ?? null,
    projectId: task.projectId ?? null,
    listId: task.listId ?? null,
    plannedDate: task.plannedDate ?? null,
    startAt: task.startAt ?? null,
    dueAt: task.dueAt ?? null,
    reminders: task.reminders.map((reminder) => ({
      id: reminder.id,
      at: reminder.at,
      enabled: reminder.enabled,
      source: reminder.source,
      label:
        scope.notes && (reminder.source === "local" || scope.feishuContent)
          ? (reminder.label ?? null)
          : null,
    })),
    tags: task.tags,
    contexts: task.contexts ?? [],
    syncStatus: task.sync.status,
  };
};

const changedFields = (args: z.infer<typeof updateArgumentsSchema>): string[] =>
  [
    ...(
      [
        "title",
        "notes",
        "privateNotes",
        "projectId",
        "listId",
        "plannedDate",
        "startAt",
        "dueAt",
        "priority",
        "tags",
        "contexts",
      ] as const
    ).filter((field) => args[field] !== null && args[field] !== undefined),
    ...args.clearFields,
  ].filter((field, index, fields) => fields.indexOf(field) === index);

const clearedFieldValue = (field: string): unknown => {
  if (field === "notes" || field === "privateNotes") return "";
  if (field === "tags" || field === "contexts") return [];
  return undefined;
};

const effectiveChangedFields = (
  task: Task,
  args: z.infer<typeof updateArgumentsSchema>,
): string[] =>
  changedFields(args).filter((field) => {
    const after = args.clearFields.includes(
      field as (typeof args.clearFields)[number],
    )
      ? clearedFieldValue(field)
      : (args as Record<string, unknown>)[field];
    const before = (task as unknown as Record<string, unknown>)[field];
    return JSON.stringify(before) !== JSON.stringify(after);
  });

const previewFieldValue = (field: string, value: unknown): AgentJsonValue => {
  if (field === "notes" || field === "privateNotes") {
    const text = typeof value === "string" ? value : "";
    return { present: text.length > 0, characters: text.length };
  }
  return value === undefined
    ? null
    : (structuredClone(value) as AgentJsonValue);
};

const updatePreview = (
  task: Task,
  args: z.infer<typeof updateArgumentsSchema>,
  fields: string[],
): AgentJsonValue => ({
  action: "update-task",
  taskId: task.id,
  willChange: fields.length > 0,
  changes: fields.map((field) => {
    const clear = args.clearFields.includes(
      field as (typeof args.clearFields)[number],
    );
    const after = clear ? null : (args as Record<string, unknown>)[field];
    return {
      field,
      before: previewFieldValue(
        field,
        (task as unknown as Record<string, unknown>)[field],
      ),
      after: previewFieldValue(field, after),
    };
  }),
});

const remoteChangedFields = (
  task: Task,
  args: z.infer<typeof updateArgumentsSchema>,
): string[] =>
  effectiveChangedFields(task, args).filter((field) =>
    REMOTE_UPDATE_FIELDS.has(field),
  );

const patchForUpdate = (
  args: z.infer<typeof updateArgumentsSchema>,
  fields: string[] = changedFields(args),
): UpdateTaskInput => {
  const patch: UpdateTaskInput = {};
  for (const field of [
    "title",
    "notes",
    "privateNotes",
    "projectId",
    "listId",
    "plannedDate",
    "startAt",
    "dueAt",
    "priority",
    "tags",
    "contexts",
  ] as const) {
    if (
      fields.includes(field) &&
      args[field] !== null &&
      args[field] !== undefined
    )
      (patch as Record<string, unknown>)[field] = args[field];
  }
  args.clearFields.forEach((field) => {
    if (fields.includes(field)) {
      (patch as Record<string, unknown>)[field] = null;
    }
  });
  return patch;
};

const taskErrorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code;
  }
  return error instanceof Error && error.name
    ? error.name
    : "TASK_MUTATION_FAILED";
};

const completionBlockCode = (task: Task, completed: boolean): string | null => {
  if (!completed || task.status === "completed" || task.source.type !== "feishu") {
    return null;
  }
  if (
    task.currentUserRole !== undefined &&
    task.currentUserRole !== "assignee"
  ) {
    return "FEISHU_CURRENT_MEMBER_CANNOT_COMPLETE";
  }
  if (task.completionMode === "all-assignees") {
    return "FEISHU_ALL_ASSIGNEES_PERSONAL_COMPLETION_UNSUPPORTED";
  }
  return null;
};

const isRemoteDeletedFeishuTask = (task: Task): boolean =>
  task.source.type === "feishu" && task.sync.status === "remote-deleted";

/**
 * This receipt is produced by the trusted task tool, not inferred from the
 * model's final prose. AgentDesktopService uses it to render the only
 * authoritative Feishu synchronization state for a mutation.
 */
const feishuSyncReceiptsFor = (
  task: Task,
  action: FeishuSyncReceiptAction,
): FeishuSyncReceipt[] =>
  task.source.type === "feishu"
    ? [{ taskId: task.id, action, status: task.sync.status }]
    : [];

/**
 * TaskService turns a Feishu-backed undo into a fresh pending local intent.
 * Keep the Agent's permission preview and trusted receipt aligned with that
 * behavior, including undoing a create (a recoverable delete tombstone) and
 * undoing a trash operation (a restore).
 */
const undoQueuesFeishuSync = (change: TaskSnapshotChange): boolean => {
  // `before` is the task state after undo; for undoing a create it is absent,
  // so TaskService retains an after-snapshot tombstone instead.
  const resultingTask = change.before ?? change.after;
  if (resultingTask?.source.type !== "feishu") return false;
  if (change.before === null || change.after === null) return true;
  return FEISHU_UNDO_REMOTE_FIELDS.some(
    (field) =>
      JSON.stringify(change.before![field]) !==
      JSON.stringify(change.after![field]),
  );
};

const undoFeishuActionFor = (
  change: TaskSnapshotChange,
): FeishuSyncReceiptAction => {
  if (change.before === null || change.after === null) return "deleted";
  if (
    change.before.deletedAt === undefined &&
    change.after.deletedAt !== undefined
  ) {
    return "restored";
  }
  if (
    change.before.deletedAt !== undefined &&
    change.after.deletedAt === undefined
  ) {
    return "deleted";
  }
  if (
    change.before.status !== "completed" &&
    change.after.status === "completed"
  ) {
    return "reopened";
  }
  if (
    change.before.status === "completed" &&
    change.after.status !== "completed"
  ) {
    return "completed";
  }
  return "updated";
};

const undoFeishuExternalEffect = (
  taskId: string,
  action: FeishuSyncReceiptAction,
): string => {
  switch (action) {
    case "deleted":
      return `delete Feishu task ${taskId} on next sync`;
    case "restored":
      return `restore Feishu-backed task ${taskId} on next sync`;
    case "completed":
      return `complete Feishu task ${taskId} as a whole`;
    case "reopened":
      return `reopen Feishu task ${taskId} as a whole`;
    case "updated":
      return `update Feishu task ${taskId} on next sync`;
    case "created":
      // An undo never creates a task remotely: undoing a restore reverts to
      // deletion, and undoing a create uses a deletion tombstone.
      return `update Feishu task ${taskId} on next sync`;
  }
};

const versionsFor = (tasks: Task[]): Record<string, string> =>
  Object.fromEntries(tasks.map((task) => [task.id, task.updatedAt]));

const taskTargets = (tasks: Task[]): Array<{ kind: "task"; value: string }> =>
  tasks.map((task) => ({ kind: "task", value: task.id }));

const interruptedBatchResult = (
  context: ToolExecutionContext,
  data: Record<string, AgentJsonValue>,
  processedCount: number,
  totalCount: number,
): ToolResult =>
  result(
    context,
    {
      ...data,
      aborted: true,
      processedCount,
      remainingCount: totalCount - processedCount,
    },
    processedCount > 0 ? "partial" : "cancelled",
  );

export interface TaskToolOptions {
  tasks: TaskService;
  getModelDataScope: () => ModelDataScope;
  /** Trusted per-user-message creation policy, never supplied by the model. */
  sourcePolicy?: AgentTaskSourcePolicy;
  /** Resolves the currently connected account at both review and execution time. */
  getFeishuAccountId?: () => string | undefined;
  onTasksChanged?: () => void;
}

export const createTaskTools = (
  options: TaskToolOptions,
): TrustedToolDefinition[] => {
  const notifyChanged = (): void => options.onTasksChanged?.();
  const requireTask = async (id: string): Promise<Task> => {
    const task = await options.tasks.getTask(id, true);
    if (!task) throw new Error(`TASK_NOT_FOUND:${id}`);
    return task;
  };
  const requireActiveTask = async (id: string): Promise<Task> => {
    const task = await options.tasks.getTask(id);
    if (!task) throw new Error(`ACTIVE_TASK_NOT_FOUND:${id}`);
    return task;
  };
  const requireDeletedTask = async (id: string): Promise<Task> => {
    const task = await options.tasks.getTask(id, true);
    if (!task) throw new Error(`TASK_NOT_FOUND:${id}`);
    if (task.deletedAt === undefined) {
      throw new Error(`TASK_NOT_IN_TRASH:${id}`);
    }
    return task;
  };
  const feishuAccountId = (): string | undefined => {
    const accountId = options.getFeishuAccountId?.()?.trim();
    return accountId || undefined;
  };
  const assertCreationSource = (source: "local" | "feishu"): void =>
    assertTaskCreationSource(
      source,
      options.sourcePolicy ?? { kind: "default-local", source: "local" },
    );
  const assertFeishuCreationAvailable = (accountId: string | undefined): void =>
    assertFeishuTaskCreationAvailable(accountId);
  /**
   * The main desktop supplies a resolver for the currently connected Feishu
   * account. Keep direct isolated tool consumers compatible, but fail closed
   * in the app whenever a remote mutation would otherwise be filtered out by
   * the account-scoped sync queue.
   */
  const assertFeishuMutationAvailable = (task: Task): void => {
    if (task.source.type !== "feishu" || !options.getFeishuAccountId) return;
    assertFeishuTaskMutationAccount(task.source.accountId, feishuAccountId());
  };
  const requireOperation = async (operationId: string) => {
    const operation = (
      await options.tasks.getOperations(Number.MAX_SAFE_INTEGER)
    ).find((candidate) => candidate.id === operationId);
    if (!operation) throw new Error(`TASK_OPERATION_NOT_FOUND:${operationId}`);
    if (operation.undoneAt !== undefined) {
      throw new Error(`TASK_OPERATION_ALREADY_UNDONE:${operationId}`);
    }
    return operation;
  };
  const assertUndoFeishuMutationsAvailable = (
    changes: TaskSnapshotChange[],
    currentTasks: Array<Task | undefined>,
  ): void => {
    changes.forEach((change, index) => {
      if (!undoQueuesFeishuSync(change)) return;
      const task = currentTasks[index] ?? change.before ?? change.after;
      if (task?.source.type === "feishu") {
        assertFeishuMutationAvailable(task);
      }
    });
  };

  return [
    taskTool({
      name: "task_list",
      description:
        "List and search tasks. Use this before deciding which tasks to edit. Always provide all four arguments: view, text, source, and limit. Use null for an unused nullable filter and 100 for a normal default limit.",
      schema: listArgumentsSchema,
      analyze: (args) => ({
        risk: "R0",
        targets: [{ kind: "task", value: args.view ?? "all" }],
        reads: ["task titles, status, priority and approved time fields"],
        writes: [],
        network: [],
        externalEffects: [],
        reversible: true,
        preview: {
          action: "list-tasks",
          view: args.view,
          source: args.source,
          limit: args.limit,
        },
        baseVersions: {},
      }),
      execute: async (args, context) => {
        const filter: TaskFilter = {
          view: args.view ?? undefined,
          text: args.text ?? undefined,
          sourceTypes: args.source ? [args.source] : undefined,
        };
        const tasks = (await options.tasks.listTasks(filter)).slice(
          0,
          args.limit,
        );
        return result(context, {
          count: tasks.length,
          tasks: tasks.map((task) =>
            compactTask(task, options.getModelDataScope()),
          ),
        });
      },
    }),
    taskTool({
      name: "task_get",
      description:
        "Read one task by its exact ID, including a task currently in recoverable trash.",
      schema: getArgumentsSchema,
      analyze: (args) => ({
        risk: "R0",
        targets: [{ kind: "task", value: args.id }],
        reads: ["one task and its approved fields"],
        writes: [],
        network: [],
        externalEffects: [],
        reversible: true,
        preview: { action: "read-task", taskId: args.id },
        baseVersions: {},
      }),
      execute: async (args, context) =>
        result(
          context,
          compactTask(await requireTask(args.id), options.getModelDataScope()),
        ),
    }),
    taskTool({
      name: "task_create",
      description:
        "Create one task. The trusted current-user source policy determines whether source must be local or feishu. Use source=feishu only when a Feishu account is connected; creation is queued locally and synchronized to that exact account.",
      schema: createArgumentsSchema,
      sensitiveArgumentPaths: ["notes"],
      analyze: (args) => {
        assertCreationSource(args.source);
        const accountId = args.source === "feishu" ? feishuAccountId() : undefined;
        if (args.source === "feishu") {
          assertFeishuCreationAvailable(accountId);
        }
        return {
          risk: args.source === "feishu" ? "R2" : "R1",
          targets: [
            {
              kind: "account",
              value: args.source === "feishu" ? accountId! : "local",
            },
          ],
          reads: args.source === "feishu" ? ["current Feishu account connection"] : [],
          writes: [
            args.source === "feishu"
              ? "create one synchronized Feishu-backed task"
              : "create one local task",
          ],
          network:
            args.source === "feishu"
              ? ["Feishu Task v2 on next sync"]
              : [],
          externalEffects:
            args.source === "feishu"
              ? [`create a task in Feishu account ${accountId} on next sync`]
              : [],
          reversible: true,
          preview: {
            action: "create-task",
            permitted: true,
            title: args.title,
            source: args.source,
            accountId: accountId ?? null,
            projectId: args.projectId,
            listId: args.listId,
            plannedDate: args.plannedDate,
            startAt: args.startAt,
            dueAt: args.dueAt,
          },
          baseVersions: {},
        };
      },
      execute: async (args, context) => {
        assertCreationSource(args.source);
        const accountId = args.source === "feishu" ? feishuAccountId() : undefined;
        if (args.source === "feishu") {
          assertFeishuCreationAvailable(accountId);
        }
        const input: CreateTaskInput = {
          title: args.title,
          notes: args.notes,
          source:
            args.source === "feishu"
              ? { type: "feishu", accountId }
              : { type: "local" },
          projectId: args.projectId ?? undefined,
          listId: args.listId ?? undefined,
          plannedDate: args.plannedDate ?? undefined,
          startAt: args.startAt ?? undefined,
          dueAt: args.dueAt ?? undefined,
          priority: args.priority,
          tags: args.tags,
          contexts: args.contexts ?? [],
          sync: {
            status: args.source === "feishu" ? "pending" : "local",
          },
        };
        const created = await options.tasks.createTask(input);
        notifyChanged();
        return result(context, {
          task: compactTask(created.task, options.getModelDataScope()),
          syncReceipts: feishuSyncReceiptsFor(created.task, "created"),
          undoOperationId: created.operationId,
        });
      },
    }),
    taskTool({
      name: "task_update",
      description:
        "Update explicitly supplied fields on one task. Private plan and private notes never sync to Feishu.",
      schema: updateArgumentsSchema,
      sensitiveArgumentPaths: ["notes", "privateNotes"],
      analyze: async (args) => {
        const task = await requireActiveTask(args.id);
        const fields = effectiveChangedFields(task, args);
        const remoteFields = remoteChangedFields(task, args);
        if (remoteFields.length > 0) assertFeishuMutationAvailable(task);
        const external =
          task.source.type === "feishu" && remoteFields.length > 0;
        return {
          risk: fields.length === 0 ? "R0" : external ? "R2" : "R1",
          targets: [{ kind: "task", value: args.id }],
          reads: ["current task version"],
          writes: fields.map((field) => `task.${field}`),
          network: external ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: external
            ? [`update Feishu fields: ${remoteFields.join(", ")}`]
            : [],
          reversible: true,
          preview: updatePreview(task, args, fields),
          baseVersions: { [args.id]: task.updatedAt },
        };
      },
      execute: async (args, context) => {
        const current = await requireActiveTask(args.id);
        const fields = effectiveChangedFields(current, args);
        const remoteFields = remoteChangedFields(current, args);
        if (remoteFields.length > 0) assertFeishuMutationAvailable(current);
        if (fields.length === 0) {
          return result(context, {
            changed: false,
            task: compactTask(current, options.getModelDataScope()),
            undoOperationId: null,
          });
        }
        const updated = await options.tasks.updateTask(
          args.id,
          patchForUpdate(args, fields),
        );
        notifyChanged();
        return result(context, {
          changed: true,
          task: compactTask(updated.task, options.getModelDataScope()),
          syncReceipts:
            remoteFields.length > 0
              ? feishuSyncReceiptsFor(updated.task, "updated")
              : [],
          undoOperationId: updated.operationId,
        });
      },
    }),
    taskTool({
      name: "task_add_research_card",
      description:
        "Attach a source, concise summary, and optional action items to one task as private local context. This never writes the card back to Feishu.",
      schema: researchCardArgumentsSchema,
      sensitiveArgumentPaths: ["url", "summary", "actionItems"],
      analyze: async (args) => {
        const task = await requireActiveTask(args.id);
        const existing = task.researchCards ?? [];
        if (existing.length >= 20) {
          throw new Error("RESEARCH_CARD_LIMIT_REACHED");
        }
        return {
          risk: "R1",
          targets: [{ kind: "task", value: args.id }],
          reads: ["current task private context"],
          writes: ["one private research card"],
          network: [],
          externalEffects: [],
          reversible: true,
          preview: {
            action: "add-research-card",
            taskId: args.id,
            title: args.title,
            actionItemCount: args.actionItems.length,
            remoteWrite: false,
          },
          baseVersions: { [args.id]: task.updatedAt },
        };
      },
      execute: async (args, context) => {
        const current = await requireActiveTask(args.id);
        const existing = current.researchCards ?? [];
        if (existing.length >= 20) {
          throw new Error("RESEARCH_CARD_LIMIT_REACHED");
        }
        const card: TaskResearchCard = {
          id: randomUUID(),
          title: args.title,
          ...(args.url ? { url: args.url } : {}),
          summary: args.summary.trim(),
          actionItems: args.actionItems,
          capturedAt: new Date().toISOString(),
        };
        const updated = await options.tasks.updateTask(args.id, {
          researchCards: [...existing, card],
        });
        notifyChanged();
        return result(context, {
          task: compactTask(updated.task, options.getModelDataScope()),
          researchCardId: card.id,
          undoOperationId: updated.operationId,
        });
      },
    }),
    taskTool({
      name: "task_split",
      description:
        `Split one task into 2-${MAX_SPLIT_STEPS} local child tasks. The parent stays unchanged and a Feishu parent never receives remote child writes. Use this after presenting the proposed steps for user approval.`,
      schema: splitTaskArgumentsSchema,
      sensitiveArgumentPaths: ["subtasks"],
      analyze: async (args) => {
        const parent = await requireActiveTask(args.id);
        return {
          risk: "R2",
          targets: [{ kind: "task", value: parent.id }],
          reads: ["current parent task"],
          writes: [`create ${args.subtasks.length} local child tasks`],
          network: [],
          externalEffects: [],
          reversible: true,
          preview: {
            action: "split-task",
            parent: { id: parent.id, title: parent.title },
            count: args.subtasks.length,
            remoteWrite: false,
            subtasks: args.subtasks.map((item, index) => ({
              index,
              title: item.title,
              priority: item.priority,
              estimatedMinutes: item.estimatedMinutes,
            })),
          },
          baseVersions: { [parent.id]: parent.updatedAt },
        };
      },
      execute: async (args, context) => {
        const parent = await requireActiveTask(args.id);
        const createdTasks: Task[] = [];
        const operationIds: string[] = [];
        const processedIndexes: number[] = [];
        const failedItems: Array<{ index: number; code: string }> = [];
        for (let index = 0; index < args.subtasks.length; index += 1) {
          if (context.signal.aborted) {
            if (operationIds.length > 0) notifyChanged();
            return interruptedBatchResult(
              context,
              {
                parentTaskId: parent.id,
                createdTasks: createdTasks.map((task) =>
                  compactTask(task, options.getModelDataScope()),
                ),
                operationIds,
                processedIndexes,
                failedItems,
              },
              processedIndexes.length,
              args.subtasks.length,
            );
          }
          const item = args.subtasks[index];
          try {
            const mutation = await options.tasks.createTask({
              title: item.title,
              notes: item.notes,
              source: { type: "local" },
              parentId: parent.id,
              projectId: parent.projectId,
              listId: parent.listId,
              plannedDate: parent.plannedDate,
              priority: item.priority,
              estimatedMinutes: item.estimatedMinutes ?? undefined,
              sync: { status: "local" },
            });
            createdTasks.push(mutation.task);
            operationIds.push(mutation.operationId);
          } catch (error) {
            failedItems.push({ index, code: taskErrorCode(error) });
          }
          processedIndexes.push(index);
        }
        if (operationIds.length > 0) notifyChanged();
        return result(
          context,
          {
            aborted: false,
            parentTaskId: parent.id,
            createdCount: createdTasks.length,
            failedCount: failedItems.length,
            processedIndexes,
            createdTasks: createdTasks.map((task) =>
              compactTask(task, options.getModelDataScope()),
            ),
            failedItems,
            operationIds,
          },
          failedItems.length > 0 ? "partial" : "ok",
        );
      },
    }),
    taskTool({
      name: "task_set_completed",
      description: "Complete or reopen one exact task.",
      schema: completeArgumentsSchema,
      analyze: async (args) => {
        const task = await requireActiveTask(args.id);
        const willChange = args.completed
          ? task.status !== "completed"
          : task.status === "completed";
        const blockedCode = completionBlockCode(task, args.completed);
        const external =
          willChange && task.source.type === "feishu" && !blockedCode;
        if (external) assertFeishuMutationAvailable(task);
        return {
          risk: blockedCode
            ? "R4"
            : !willChange
              ? "R0"
              : external
                ? "R2"
                : "R1",
          targets: [{ kind: "task", value: args.id }],
          reads: ["current task completion state"],
          writes: willChange && !blockedCode ? ["task completion state"] : [],
          network: external ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: blockedCode
            ? [`blocked: ${blockedCode}`]
            : external
              ? [
                  args.completed
                    ? "complete Feishu task as a whole"
                    : "reopen Feishu task as a whole",
                ]
              : [],
          reversible: true,
          preview: {
            action: blockedCode
              ? "reject-unsupported-feishu-completion"
              : args.completed
                ? "complete-task"
                : "reopen-task",
            taskId: args.id,
            title: task.title,
            permitted: !blockedCode,
            willChange,
            blockedCode,
          },
          baseVersions: { [args.id]: task.updatedAt },
        };
      },
      execute: async (args, context) => {
        const current = await requireActiveTask(args.id);
        const blockedCode = completionBlockCode(current, args.completed);
        if (blockedCode) throw new Error(blockedCode);
        const willChange = args.completed
          ? current.status !== "completed"
          : current.status === "completed";
        if (willChange && current.source.type === "feishu") {
          assertFeishuMutationAvailable(current);
        }
        if (!willChange) {
          return result(context, {
            changed: false,
            task: compactTask(current, options.getModelDataScope()),
            undoOperationId: null,
          });
        }
        const mutation = args.completed
          ? await options.tasks.completeTask(args.id)
          : await options.tasks.reopenTask(args.id);
        notifyChanged();
        return result(context, {
          changed: true,
          task: compactTask(mutation.task, options.getModelDataScope()),
          syncReceipts: feishuSyncReceiptsFor(
            mutation.task,
            args.completed ? "completed" : "reopened",
          ),
          undoOperationId: mutation.operationId,
        });
      },
    }),
    taskTool({
      name: "task_move_to_trash",
      description:
        "Move one task to recoverable trash. It does not permanently purge local data.",
      schema: trashArgumentsSchema,
      analyze: async (args) => {
        const task = await requireActiveTask(args.id);
        if (task.source.type === "feishu") assertFeishuMutationAvailable(task);
        return {
          // Deletion always requires a review, even though this is recoverable.
          risk: "R2",
          targets: [{ kind: "task", value: args.id }],
          reads: ["current task version"],
          writes: ["move task to recoverable trash"],
          network:
            task.source.type === "feishu"
              ? ["Feishu Task v2 on next sync"]
              : [],
          externalEffects:
            task.source.type === "feishu"
              ? ["delete Feishu task on next sync"]
              : [],
          reversible: true,
          preview: { action: "trash-task", taskId: args.id, title: task.title },
          baseVersions: { [args.id]: task.updatedAt },
        };
      },
      execute: async (args, context) => {
        const current = await requireActiveTask(args.id);
        if (current.source.type === "feishu") {
          assertFeishuMutationAvailable(current);
        }
        const mutation = await options.tasks.moveToTrash(args.id);
        notifyChanged();
        return result(context, {
          taskId: args.id,
          syncReceipts: feishuSyncReceiptsFor(mutation.task, "deleted"),
          undoOperationId: mutation.operationId,
        });
      },
    }),
    taskTool({
      name: "task_restore",
      description:
        "Restore one exact task from recoverable trash. A Feishu task already confirmed as remotely deleted cannot be restored through this tool.",
      schema: restoreArgumentsSchema,
      analyze: async (args) => {
        const task = await requireDeletedTask(args.id);
        const remoteDeleted = isRemoteDeletedFeishuTask(task);
        const external = task.source.type === "feishu" && !remoteDeleted;
        if (external) assertFeishuMutationAvailable(task);
        return {
          risk: remoteDeleted ? "R4" : external ? "R2" : "R1",
          targets: [{ kind: "task", value: args.id }],
          reads: ["trashed task version and synchronization state"],
          writes: remoteDeleted ? [] : ["restore task from recoverable trash"],
          network: external ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: remoteDeleted
            ? ["blocked: Feishu has already confirmed permanent remote deletion"]
            : external
              ? ["cancel a pending Feishu deletion or restore the Feishu-backed task on next sync"]
              : [],
          reversible: true,
          preview: {
            action: remoteDeleted
              ? "reject-remotely-deleted-feishu-task-restore"
              : "restore-task-from-trash",
            taskId: task.id,
            title: task.title,
            source: task.source.type,
            permitted: !remoteDeleted,
          },
          baseVersions: { [task.id]: task.updatedAt },
        };
      },
      execute: async (args, context) => {
        const current = await requireDeletedTask(args.id);
        if (isRemoteDeletedFeishuTask(current)) {
          throw new Error("FEISHU_REMOTE_DELETION_CANNOT_BE_RESTORED");
        }
        if (current.source.type === "feishu") {
          assertFeishuMutationAvailable(current);
        }
        const mutation = await options.tasks.restoreTask(args.id);
        notifyChanged();
        return result(context, {
          task: compactTask(mutation.task, options.getModelDataScope()),
          syncReceipts: feishuSyncReceiptsFor(mutation.task, "restored"),
          undoOperationId: mutation.operationId,
        });
      },
    }),
    taskTool({
      name: "task_bulk_create",
      description: `Create between 1 and ${MAX_BULK_CREATE} local tasks. This tool never creates Feishu tasks.`,
      schema: bulkCreateArgumentsSchema,
      sensitiveArgumentPaths: ["tasks"],
      analyze: (args) => {
        assertCreationSource("local");
        return {
          risk: "R2",
          targets: [{ kind: "account", value: "local" }],
          reads: [],
          writes: [`create ${args.tasks.length} local tasks`],
          network: [],
          externalEffects: [],
          reversible: true,
          preview: {
            action: "bulk-create-local-tasks",
            count: args.tasks.length,
            tasks: args.tasks.map((task, index) => ({
              index,
              title: task.title,
              projectId: task.projectId,
              listId: task.listId,
              plannedDate: task.plannedDate,
              startAt: task.startAt,
              dueAt: task.dueAt,
              priority: task.priority,
            })),
          },
          baseVersions: {},
        };
      },
      execute: async (args, context) => {
        assertCreationSource("local");
        const createdTasks: Task[] = [];
        const operationIds: string[] = [];
        const processedIndexes: number[] = [];
        const failedItems: Array<{ index: number; code: string }> = [];
        for (let index = 0; index < args.tasks.length; index += 1) {
          if (context.signal.aborted) {
            if (operationIds.length > 0) notifyChanged();
            return interruptedBatchResult(
              context,
              {
                createdTasks: createdTasks.map((task) =>
                  compactTask(task, options.getModelDataScope()),
                ),
                operationIds,
                processedIndexes,
                failedItems,
              },
              processedIndexes.length,
              args.tasks.length,
            );
          }
          const item = args.tasks[index];
          try {
            const mutation = await options.tasks.createTask({
              title: item.title,
              notes: item.notes,
              source: { type: "local" },
              projectId: item.projectId ?? undefined,
              listId: item.listId ?? undefined,
              plannedDate: item.plannedDate ?? undefined,
              startAt: item.startAt ?? undefined,
              dueAt: item.dueAt ?? undefined,
              priority: item.priority,
              tags: item.tags,
              contexts: item.contexts ?? [],
              sync: { status: "local" },
            });
            createdTasks.push(mutation.task);
            operationIds.push(mutation.operationId);
          } catch (error) {
            failedItems.push({ index, code: taskErrorCode(error) });
          }
          processedIndexes.push(index);
        }
        if (operationIds.length > 0) notifyChanged();
        return result(
          context,
          {
            aborted: false,
            createdCount: createdTasks.length,
            failedCount: failedItems.length,
            processedIndexes,
            createdTasks: createdTasks.map((task) =>
              compactTask(task, options.getModelDataScope()),
            ),
            failedItems,
            operationIds,
          },
          failedItems.length > 0 ? "partial" : "ok",
        );
      },
    }),
    taskTool({
      name: "task_bulk_update",
      description: `Update explicitly named fields on between 1 and ${MAX_BULK_MUTATE} exact task IDs. Filter-based updates are not accepted.`,
      schema: bulkUpdateArgumentsSchema,
      sensitiveArgumentPaths: ["updates"],
      analyze: async (args) => {
        const tasks = await Promise.all(
          args.updates.map((update) => requireActiveTask(update.id)),
        );
        const previews = args.updates.map((update, index) => {
          const task = tasks[index];
          const fields = effectiveChangedFields(task, update);
          return updatePreview(task, update, fields);
        });
        const remoteUpdates = args.updates.flatMap((update, index) => {
          const task = tasks[index];
          const fields = remoteChangedFields(task, update);
          return task.source.type === "feishu" && fields.length > 0
            ? [{ task, fields }]
            : [];
        });
        remoteUpdates.forEach(({ task }) => assertFeishuMutationAvailable(task));
        return {
          risk: "R2",
          targets: taskTargets(tasks),
          reads: ["current version of every explicit task"],
          writes: args.updates.flatMap((update, index) =>
            effectiveChangedFields(tasks[index], update).map(
              (field) => `task.${update.id}.${field}`,
            ),
          ),
          network:
            remoteUpdates.length > 0 ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: remoteUpdates.map(
            ({ task, fields }) =>
              `update Feishu task ${task.id} fields: ${fields.join(", ")}`,
          ),
          reversible: true,
          preview: {
            action: "bulk-update-explicit-tasks",
            count: tasks.length,
            updates: previews,
          },
          baseVersions: versionsFor(tasks),
        };
      },
      execute: async (args, context) => {
        const updatedTasks: Task[] = [];
        const syncReceipts: FeishuSyncReceipt[] = [];
        const operationIds: string[] = [];
        const processedTaskIds: string[] = [];
        const skippedTaskIds: string[] = [];
        const failedTasks: Array<{ taskId: string; code: string }> = [];
        for (let index = 0; index < args.updates.length; index += 1) {
          if (context.signal.aborted) {
            if (operationIds.length > 0) notifyChanged();
            return interruptedBatchResult(
              context,
              {
                updatedTaskIds: updatedTasks.map((task) => task.id),
                updatedTasks: updatedTasks.map((task) =>
                  compactTask(task, options.getModelDataScope()),
                ),
                syncReceipts,
                processedTaskIds,
                skippedTaskIds,
                failedTasks,
                operationIds,
              },
              processedTaskIds.length,
              args.updates.length,
            );
          }
          const update = args.updates[index];
          try {
            const current = await requireActiveTask(update.id);
            const fields = effectiveChangedFields(current, update);
            if (fields.length === 0) {
              skippedTaskIds.push(update.id);
            } else {
              if (remoteChangedFields(current, update).length > 0) {
                assertFeishuMutationAvailable(current);
              }
              const mutation = await options.tasks.updateTask(
                update.id,
                patchForUpdate(update, fields),
              );
              updatedTasks.push(mutation.task);
              if (remoteChangedFields(current, update).length > 0) {
                syncReceipts.push(
                  ...feishuSyncReceiptsFor(mutation.task, "updated"),
                );
              }
              operationIds.push(mutation.operationId);
            }
          } catch (error) {
            failedTasks.push({ taskId: update.id, code: taskErrorCode(error) });
          }
          processedTaskIds.push(update.id);
        }
        if (operationIds.length > 0) notifyChanged();
        return result(
          context,
          {
            aborted: false,
            processedTaskIds,
            updatedCount: updatedTasks.length,
            updatedTaskIds: updatedTasks.map((task) => task.id),
            updatedTasks: updatedTasks.map((task) =>
              compactTask(task, options.getModelDataScope()),
            ),
            syncReceipts,
            skippedTaskIds,
            failedTasks,
            operationIds,
          },
          failedTasks.length > 0 ? "partial" : "ok",
        );
      },
    }),
    taskTool({
      name: "task_bulk_set_completed",
      description: `Complete or reopen between 1 and ${MAX_BULK_MUTATE} tasks by exact ID. Tasks already in the requested state are reported as skipped.`,
      schema: bulkCompletedArgumentsSchema,
      analyze: async (args) => {
        const tasks = await Promise.all(args.taskIds.map(requireActiveTask));
        const blocked = tasks.flatMap((task) => {
          const code = completionBlockCode(task, args.completed);
          return code ? [{ task, code }] : [];
        });
        const blockedById = new Map(
          blocked.map(({ task, code }) => [task.id, code]),
        );
        const changing = tasks.filter(
          (task) =>
            !blockedById.has(task.id) &&
            (args.completed
              ? task.status !== "completed"
              : task.status === "completed"),
        );
        const remote = changing.filter((task) => task.source.type === "feishu");
        remote.forEach(assertFeishuMutationAvailable);
        return {
          risk: "R2",
          targets: taskTargets(tasks),
          reads: ["current task versions and completion states"],
          writes: changing.map((task) => `task.${task.id}.status`),
          network: remote.length > 0 ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: remote.map(
            (task) =>
              `${args.completed ? "complete" : "reopen"} Feishu task ${task.id} as a whole`,
          ),
          reversible: true,
          preview: {
            action: args.completed
              ? "bulk-complete-explicit-tasks"
              : "bulk-reopen-explicit-tasks",
            tasks: tasks.map((task) => ({
              id: task.id,
              title: task.title,
              currentStatus: task.status,
              willChange: changing.some(
                (candidate) => candidate.id === task.id,
              ),
              unsupported: blockedById.get(task.id) ?? null,
            })),
          },
          baseVersions: versionsFor(tasks),
        };
      },
      execute: async (args, context) => {
        const processedTaskIds: string[] = [];
        const changedTasks: Task[] = [];
        const syncReceipts: FeishuSyncReceipt[] = [];
        const skippedTaskIds: string[] = [];
        const unsupported: Array<{ taskId: string; code: string }> = [];
        const failedTasks: Array<{ taskId: string; code: string }> = [];
        const operationIds: string[] = [];
        for (const id of args.taskIds) {
          if (context.signal.aborted) {
            if (operationIds.length > 0) notifyChanged();
            return interruptedBatchResult(
              context,
              {
                processedTaskIds,
                changedTasks: changedTasks.map((task) =>
                  compactTask(task, options.getModelDataScope()),
                ),
                syncReceipts,
                skippedTaskIds,
                unsupported,
                failedTasks,
                operationIds,
              },
              processedTaskIds.length,
              args.taskIds.length,
            );
          }
          try {
            const current = await requireActiveTask(id);
            const blockedCode = completionBlockCode(current, args.completed);
            if (blockedCode) {
              unsupported.push({
                taskId: id,
                code: blockedCode,
              });
              processedTaskIds.push(id);
              continue;
            }
            if (
              (args.completed && current.status === "completed") ||
              (!args.completed && current.status !== "completed")
            ) {
              skippedTaskIds.push(id);
              processedTaskIds.push(id);
              continue;
            }
            if (current.source.type === "feishu") {
              assertFeishuMutationAvailable(current);
            }
            const mutation = args.completed
              ? await options.tasks.completeTask(id)
              : await options.tasks.reopenTask(id);
            changedTasks.push(mutation.task);
            syncReceipts.push(
              ...feishuSyncReceiptsFor(
                mutation.task,
                args.completed ? "completed" : "reopened",
              ),
            );
            operationIds.push(mutation.operationId);
          } catch (error) {
            failedTasks.push({ taskId: id, code: taskErrorCode(error) });
          }
          processedTaskIds.push(id);
        }
        if (operationIds.length > 0) notifyChanged();
        return result(
          context,
          {
            aborted: false,
            processedCount: processedTaskIds.length,
            changedCount: changedTasks.length,
            processedTaskIds,
            changedTasks: changedTasks.map((task) =>
              compactTask(task, options.getModelDataScope()),
            ),
            syncReceipts,
            skippedTaskIds,
            unsupported,
            failedTasks,
            operationIds,
          },
          unsupported.length > 0 || failedTasks.length > 0 ? "partial" : "ok",
        );
      },
    }),
    taskTool({
      name: "task_bulk_move_to_trash",
      description: `Move between 1 and ${MAX_BULK_MUTATE} exact tasks to recoverable trash. Permanent deletion is not available to the Agent.`,
      schema: bulkTrashArgumentsSchema,
      analyze: async (args) => {
        const tasks = await Promise.all(args.taskIds.map(requireActiveTask));
        const remote = tasks.filter((task) => task.source.type === "feishu");
        remote.forEach(assertFeishuMutationAvailable);
        return {
          risk: "R2",
          targets: taskTargets(tasks),
          reads: ["current version of every explicit task"],
          writes: tasks.map(
            (task) => `move task ${task.id} to recoverable trash`,
          ),
          network: remote.length > 0 ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: remote.map(
            (task) => `delete Feishu task ${task.id} on next sync`,
          ),
          reversible: true,
          preview: {
            action: "bulk-move-explicit-tasks-to-recoverable-trash",
            permanentDeletion: false,
            tasks: tasks.map((task) => ({
              id: task.id,
              title: task.title,
              source: task.source.type,
            })),
          },
          baseVersions: versionsFor(tasks),
        };
      },
      execute: async (args, context) => {
        const movedTaskIds: string[] = [];
        const processedTaskIds: string[] = [];
        const syncReceipts: FeishuSyncReceipt[] = [];
        const failedTasks: Array<{ taskId: string; code: string }> = [];
        const operationIds: string[] = [];
        for (const id of args.taskIds) {
          if (context.signal.aborted) {
            if (operationIds.length > 0) notifyChanged();
            return interruptedBatchResult(
              context,
              {
                movedTaskIds,
                processedTaskIds,
                syncReceipts,
                failedTasks,
                operationIds,
                permanentDeletion: false,
              },
              processedTaskIds.length,
              args.taskIds.length,
            );
          }
          try {
            const current = await requireActiveTask(id);
            if (current.source.type === "feishu") {
              assertFeishuMutationAvailable(current);
            }
            const mutation = await options.tasks.moveToTrash(id);
            movedTaskIds.push(id);
            syncReceipts.push(
              ...feishuSyncReceiptsFor(mutation.task, "deleted"),
            );
            operationIds.push(mutation.operationId);
          } catch (error) {
            failedTasks.push({ taskId: id, code: taskErrorCode(error) });
          }
          processedTaskIds.push(id);
        }
        if (operationIds.length > 0) notifyChanged();
        return result(
          context,
          {
            aborted: false,
            movedCount: movedTaskIds.length,
            processedTaskIds,
            movedTaskIds,
            syncReceipts,
            failedTasks,
            operationIds,
            permanentDeletion: false,
          },
          failedTasks.length > 0 ? "partial" : "ok",
        );
      },
    }),
    taskTool({
      name: "task_bulk_restore",
      description: `Restore between 1 and ${MAX_BULK_MUTATE} exact task IDs from recoverable trash. Feishu tasks already confirmed as remotely deleted are reported as unsupported and are not changed.`,
      schema: bulkRestoreArgumentsSchema,
      analyze: async (args) => {
        const tasks = await Promise.all(args.taskIds.map(requireDeletedTask));
        const unsupported = tasks.filter(isRemoteDeletedFeishuTask);
        const unsupportedIds = new Set(unsupported.map((task) => task.id));
        const restorable = tasks.filter((task) => !unsupportedIds.has(task.id));
        const remote = restorable.filter(
          (task) => task.source.type === "feishu",
        );
        remote.forEach(assertFeishuMutationAvailable);
        return {
          risk: restorable.length === 0 ? "R4" : "R2",
          targets: taskTargets(tasks),
          reads: ["trashed task versions and synchronization states"],
          writes: restorable.map(
            (task) => `restore task ${task.id} from recoverable trash`,
          ),
          network: remote.length > 0 ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: [
            ...remote.map(
              (task) =>
                `cancel pending deletion or restore Feishu-backed task ${task.id} on next sync`,
            ),
            ...unsupported.map(
              (task) =>
                `blocked: Feishu task ${task.id} was already confirmed remotely deleted`,
            ),
          ],
          reversible: true,
          preview: {
            action: "bulk-restore-explicit-tasks-from-trash",
            tasks: tasks.map((task) => ({
              id: task.id,
              title: task.title,
              source: task.source.type,
              willChange: !unsupportedIds.has(task.id),
              unsupported: unsupportedIds.has(task.id)
                ? "FEISHU_REMOTE_DELETION_CANNOT_BE_RESTORED"
                : null,
            })),
          },
          baseVersions: versionsFor(tasks),
        };
      },
      execute: async (args, context) => {
        const processedTaskIds: string[] = [];
        const restoredTasks: Task[] = [];
        const syncReceipts: FeishuSyncReceipt[] = [];
        const unsupported: Array<{ taskId: string; code: string }> = [];
        const failedTasks: Array<{ taskId: string; code: string }> = [];
        const operationIds: string[] = [];
        for (const id of args.taskIds) {
          if (context.signal.aborted) {
            if (operationIds.length > 0) notifyChanged();
            return interruptedBatchResult(
              context,
              {
                processedTaskIds,
                restoredTasks: restoredTasks.map((task) =>
                  compactTask(task, options.getModelDataScope()),
                ),
                syncReceipts,
                unsupported,
                failedTasks,
                operationIds,
              },
              processedTaskIds.length,
              args.taskIds.length,
            );
          }
          try {
            const current = await requireDeletedTask(id);
            if (isRemoteDeletedFeishuTask(current)) {
              unsupported.push({
                taskId: id,
                code: "FEISHU_REMOTE_DELETION_CANNOT_BE_RESTORED",
              });
            } else {
              if (current.source.type === "feishu") {
                assertFeishuMutationAvailable(current);
              }
              const mutation = await options.tasks.restoreTask(id);
              restoredTasks.push(mutation.task);
              syncReceipts.push(
                ...feishuSyncReceiptsFor(mutation.task, "restored"),
              );
              operationIds.push(mutation.operationId);
            }
          } catch (error) {
            failedTasks.push({ taskId: id, code: taskErrorCode(error) });
          }
          processedTaskIds.push(id);
        }
        if (operationIds.length > 0) notifyChanged();
        return result(
          context,
          {
            aborted: false,
            processedTaskIds,
            restoredCount: restoredTasks.length,
            restoredTaskIds: restoredTasks.map((task) => task.id),
            restoredTasks: restoredTasks.map((task) =>
              compactTask(task, options.getModelDataScope()),
            ),
            syncReceipts,
            unsupported,
            failedTasks,
            operationIds,
          },
          unsupported.length > 0 || failedTasks.length > 0 ? "partial" : "ok",
        );
      },
    }),
    taskTool({
      name: "move_to_today",
      description:
        "Move one exact task into Today using a private local planned date. This never changes a Feishu deadline.",
      schema: moveToTodayArgumentsSchema,
      analyze: async (args) => {
        const task = await requireActiveTask(args.id);
        return {
          risk: "R1",
          targets: [{ kind: "task", value: task.id }],
          reads: ["current task version"],
          writes: [`task.${task.id}.plannedDate (private local field)`],
          network: [],
          externalEffects: [],
          reversible: true,
          preview: {
            action: "move-task-to-today",
            taskId: task.id,
            title: task.title,
            affectsFeishuDeadline: false,
          },
          baseVersions: { [task.id]: task.updatedAt },
        };
      },
      execute: async (args, context) => {
        const mutation = await options.tasks.moveToToday(args.id);
        notifyChanged();
        return result(context, {
          task: compactTask(mutation.task, options.getModelDataScope()),
          undoOperationId: mutation.operationId,
        });
      },
    }),
    taskTool({
      name: "set_reminder",
      description:
        "Create or update one local reminder on an exact task. Feishu-owned reminders cannot be edited by this tool.",
      schema: setReminderArgumentsSchema,
      sensitiveArgumentPaths: ["label"],
      analyze: async (args) => {
        const task = await requireActiveTask(args.id);
        const existing =
          args.reminderId === null
            ? undefined
            : task.reminders.find(
                (reminder) => reminder.id === args.reminderId,
              );
        if (args.reminderId !== null && existing === undefined) {
          throw new Error(`TASK_REMINDER_NOT_FOUND:${args.reminderId}`);
        }
        if (existing?.source === "feishu") {
          throw new Error(`AGENT_CANNOT_EDIT_FEISHU_REMINDER:${existing.id}`);
        }
        return {
          risk: "R1",
          targets: [{ kind: "task", value: task.id }],
          reads: ["current task version and local reminders"],
          writes: [`task.${task.id}.reminders`],
          network: [],
          externalEffects: [],
          reversible: true,
          preview: {
            action:
              existing === undefined
                ? "create-local-reminder"
                : "update-local-reminder",
            taskId: task.id,
            title: task.title,
            reminderId: existing?.id ?? null,
            at: args.at,
            enabled: args.enabled,
            affectsFeishuReminder: false,
          },
          baseVersions: { [task.id]: task.updatedAt },
        };
      },
      execute: async (args, context) => {
        const task = await requireActiveTask(args.id);
        const reminderId = args.reminderId ?? `agent-reminder:${randomUUID()}`;
        const reminderIndex = task.reminders.findIndex(
          (reminder) => reminder.id === reminderId,
        );
        if (args.reminderId !== null && reminderIndex < 0) {
          throw new Error(`TASK_REMINDER_NOT_FOUND:${args.reminderId}`);
        }
        if (
          reminderIndex >= 0 &&
          task.reminders[reminderIndex].source === "feishu"
        ) {
          throw new Error(`AGENT_CANNOT_EDIT_FEISHU_REMINDER:${reminderId}`);
        }
        const reminder = {
          id: reminderId,
          at: args.at,
          enabled: args.enabled,
          source: "local" as const,
          ...(args.label === null || args.label === ""
            ? {}
            : { label: args.label }),
        };
        const reminders = [...task.reminders];
        if (reminderIndex < 0) reminders.push(reminder);
        else reminders[reminderIndex] = reminder;
        const mutation = await options.tasks.updateTask(task.id, { reminders });
        notifyChanged();
        const scope = options.getModelDataScope();
        return result(context, {
          task: compactTask(mutation.task, scope),
          reminder: {
            id: reminder.id,
            at: scope.taskTitlesAndTimes ? reminder.at : null,
            enabled: reminder.enabled,
            label: scope.notes ? (reminder.label ?? null) : null,
          },
          undoOperationId: mutation.operationId,
        });
      },
    }),
    taskTool({
      name: "undo_task_operation",
      description:
        "Undo one exact recent task operation by operation ID. Undoing a create removes only the task created by that exact operation; arbitrary permanent deletion is unavailable, and the undo cannot itself be redone.",
      schema: undoTaskOperationArgumentsSchema,
      analyze: async (args) => {
        const operation = await requireOperation(args.operationId);
        const feishuChanges = operation.changes.filter(undoQueuesFeishuSync);
        const currentTasks = await Promise.all(
          operation.changes.map((change) =>
            options.tasks.getTask(change.taskId, true),
          ),
        );
        assertUndoFeishuMutationsAvailable(operation.changes, currentTasks);
        const snapshots = operation.changes.map(
          (change, index) =>
            currentTasks[index] ?? change.after ?? change.before,
        );
        return {
          risk: "R2",
          targets: operation.changes.map((change) => ({
            kind: "task" as const,
            value: change.taskId,
          })),
          reads: ["task operation snapshots and current task versions"],
          writes: operation.changes.map(
            (change) =>
              `restore task ${change.taskId} to its pre-operation snapshot`,
          ),
          network:
            feishuChanges.length > 0 ? ["Feishu Task v2 on next sync"] : [],
          externalEffects: feishuChanges.map((change) =>
            undoFeishuExternalEffect(
              change.taskId,
              undoFeishuActionFor(change),
            ),
          ),
          reversible: false,
          preview: {
            action: "undo-task-operation",
            operationId: operation.id,
            operationKind: operation.kind,
            removesCreatedTaskIds: operation.changes
              .filter((change) => change.before === null)
              .map((change) => change.taskId),
            restoresTaskIds: operation.changes
              .filter((change) => change.before !== null)
              .map((change) => change.taskId),
            tasks: snapshots.map((task, index) => ({
              id: operation.changes[index].taskId,
              title: task?.title ?? "[missing]",
              source: task?.source.type ?? "unknown",
            })),
            mayRemoveExactlyCreatedTasks: operation.changes.some(
              (change) => change.before === null,
            ),
            arbitraryPermanentDeletionAvailable: false,
            willSyncFeishu: feishuChanges.length > 0,
            feishuSync: feishuChanges.map((change) => ({
              taskId: change.taskId,
              action: undoFeishuActionFor(change),
            })),
          },
          baseVersions: Object.fromEntries(
            operation.changes.map((change, index) => [
              change.taskId,
              currentTasks[index]?.updatedAt ?? "[missing]",
            ]),
          ),
        };
      },
      execute: async (args, context) => {
        const operation = await requireOperation(args.operationId);
        const feishuChanges = operation.changes.filter(undoQueuesFeishuSync);
        const currentTasks = await Promise.all(
          operation.changes.map((change) =>
            options.tasks.getTask(change.taskId, true),
          ),
        );
        assertUndoFeishuMutationsAvailable(operation.changes, currentTasks);
        const undone = await options.tasks.undo(args.operationId);
        notifyChanged();
        // Undoing a Feishu create returns a removed ID, not a restored active
        // task. Read deleted entries too so that its pending tombstone gets a
        // trusted delete receipt just like every other inverse sync.
        const syncReceipts = (
          await Promise.all(
            feishuChanges.map(async (change) => {
              const task = await options.tasks.getTask(change.taskId, true);
              return task
                ? feishuSyncReceiptsFor(task, undoFeishuActionFor(change))
                : [];
            }),
          )
        ).flat();
        return result(context, {
          undoneOperationId: undone.operationId,
          restoredTasks: undone.restoredTasks.map((task) =>
            compactTask(task, options.getModelDataScope()),
          ),
          removedTaskIds: undone.removedTaskIds,
          syncReceipts,
          reversible: false,
        });
      },
    }),
    taskTool({
      name: "task_bulk_plan",
      description:
        "Set the private local planned date for an explicit list of tasks. This never changes Feishu due dates.",
      schema: bulkPlanArgumentsSchema,
      analyze: async (args) => {
        const tasks = await Promise.all(args.taskIds.map(requireActiveTask));
        return {
          risk: "R2",
          targets: taskTargets(tasks),
          reads: ["current task versions"],
          writes: tasks.map((task) => `task.${task.id}.plannedDate`),
          network: [],
          externalEffects: [],
          reversible: true,
          preview: {
            action: "bulk-private-plan",
            plannedDate: args.plannedDate,
            tasks: tasks.map((task) => ({ id: task.id, title: task.title })),
          },
          baseVersions: versionsFor(tasks),
        };
      },
      execute: async (args, context) => {
        const updatedTaskIds: string[] = [];
        const processedTaskIds: string[] = [];
        const skippedTaskIds: string[] = [];
        const failedTasks: Array<{ taskId: string; code: string }> = [];
        const operationIds: string[] = [];
        for (const id of args.taskIds) {
          if (context.signal.aborted) {
            if (operationIds.length > 0) notifyChanged();
            return interruptedBatchResult(
              context,
              {
                updatedTaskIds,
                processedTaskIds,
                skippedTaskIds,
                failedTasks,
                operationIds,
              },
              processedTaskIds.length,
              args.taskIds.length,
            );
          }
          try {
            const current = await requireActiveTask(id);
            if (current.plannedDate === args.plannedDate) {
              skippedTaskIds.push(id);
            } else {
              const mutation = await options.tasks.updateTask(id, {
                plannedDate: args.plannedDate,
              });
              updatedTaskIds.push(id);
              operationIds.push(mutation.operationId);
            }
          } catch (error) {
            failedTasks.push({ taskId: id, code: taskErrorCode(error) });
          }
          processedTaskIds.push(id);
        }
        if (operationIds.length > 0) notifyChanged();
        return result(
          context,
          {
            aborted: false,
            processedTaskIds,
            updatedCount: operationIds.length,
            updatedTaskIds,
            skippedTaskIds,
            failedTasks,
            operationIds,
          },
          failedTasks.length > 0 ? "partial" : "ok",
        );
      },
    }),
  ];
};
