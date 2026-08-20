import type {
  CreateTaskInput,
  FeishuCompletionMode,
  LocalAppState,
  Task,
  TaskMemberRole,
  TaskFilter,
  TaskMutationResult,
} from "../../src/shared/models";
import type {
  FeishuFieldConflict,
  FeishuCreateTaskPayload,
  FeishuPatchTaskPayload,
  FeishuSyncedTaskField,
  FeishuTaskSyncSnapshot,
  FeishuTaskV2,
} from "../../src/shared/feishu-types";
import {
  buildFeishuCreatePayload,
  buildFeishuPatchPayload,
  canonicalFeishuMemberIds,
  feishuSnapshotFieldsEqual,
  hasPositiveFeishuTimestamp,
  isFeishuTaskCompleted,
  localTaskToFeishuSnapshot,
  remoteTaskToFeishuSnapshot,
  threeWayMergeFeishuTask,
} from "./sync-engine";
import { cloneFeishuTasklistBinding } from "./tasklist-binding";

/** Minimal structural interface implemented by TaskService. */
export interface FeishuTaskServicePort {
  getTask(id: string, includeDeleted?: boolean): Promise<Task | undefined>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  createTask(input: CreateTaskInput): Promise<TaskMutationResult>;
}

/** Minimal structural interface implemented by LocalStore. */
export interface FeishuLocalStorePort {
  transact<Result>(
    mutator: (draft: LocalAppState) => Result | Promise<Result>,
  ): Promise<Result>;
}

export interface FeishuTaskAdapterOptions {
  taskService: FeishuTaskServicePort;
  localStore: FeishuLocalStorePort;
  accountId: string;
  currentUserOpenId?: string;
  /** Opaque binding derived from the real OAuth user and app identity. */
  syncIdentityId?: string;
  now?: () => number;
}

export interface ApplyRemoteOptions {
  status?: Task["sync"]["status"];
  snapshot?: FeishuTaskSyncSnapshot;
}

export type ApplyRemoteMergeResult =
  | { outcome: "missing" }
  | { outcome: "locally-deleted"; task: Task }
  | {
      outcome: "conflict";
      task: Task;
      local: FeishuTaskSyncSnapshot;
      conflicts: FeishuFieldConflict[];
    }
  | {
      outcome: "applied";
      task: Task;
      local: FeishuTaskSyncSnapshot;
      localChanges: FeishuSyncedTaskField[];
    };

export interface ApplyRemoteMergeOptions {
  /** Keeps a permanently failed local write visible while unrelated pull fields advance. */
  localChangesStatus?: Task["sync"]["status"];
  localChangesError?: string;
}

/**
 * Returned when a push confirmation reaches the client after a newer local
 * edit. The caller can keep the newer edit queued instead of treating the
 * older remote response as the final local state.
 */
export interface ApplyRemoteAfterPushResult {
  task: Task;
  preservedLocalFields: FeishuSyncedTaskField[];
  locallyDeleted: boolean;
}

const clone = <Value>(value: Value): Value => structuredClone(value);

const FEISHU_SNAPSHOT_FIELDS: readonly FeishuSyncedTaskField[] = [
  "title",
  "notes",
  "startAt",
  "dueAt",
  "status",
  "assigneeIds",
  "followerIds",
  "tasklist",
];

function timestampToIso(value: string | undefined): string | undefined {
  if (!hasPositiveFeishuTimestamp(value)) return undefined;
  const raw = Number(value);
  const milliseconds = Math.abs(raw) < 100_000_000_000 ? raw * 1_000 : raw;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function remoteCompletedAt(
  remote: FeishuTaskV2,
  snapshot: FeishuTaskSyncSnapshot,
  now: () => number,
): string | undefined {
  if (snapshot.status !== "completed") return undefined;
  return timestampToIso(remote.completed_at) ?? new Date(now()).toISOString();
}

function memberIds(
  remote: FeishuTaskV2,
  role: "assignee" | "follower",
): string[] {
  return canonicalFeishuMemberIds(
    (remote.members ?? [])
      // Task.local assignee/follower arrays model people, not Task v2 app
      // identities. Leaving app members out here preserves them remotely when
      // a user membership is later changed.
      .filter((member) => member.role === role && member.type !== "app")
      .map((member) => member.id),
  );
}

function completionMode(
  remote: FeishuTaskV2,
): FeishuCompletionMode | undefined {
  if (remote.mode === 1) return "all-assignees";
  if (remote.mode === 2) return "any-assignee";
  const assignees = memberIds(remote, "assignee");
  return assignees.length === 1 ? "single" : undefined;
}

function currentUserRole(
  remote: FeishuTaskV2,
  currentUserOpenId?: string,
): TaskMemberRole | undefined {
  if (!currentUserOpenId) return undefined;
  const currentUserMemberships = (remote.members ?? []).filter(
    (candidate) =>
      candidate.id === currentUserOpenId && candidate.type !== "app",
  );
  // Task v2 permits one user to be both an assignee and a follower. Assignee
  // capability must win regardless of the order returned by Feishu.
  if (currentUserMemberships.some((member) => member.role === "assignee")) {
    return "assignee";
  }
  if (currentUserMemberships.some((member) => member.role === "follower")) {
    return "follower";
  }
  return "viewer";
}

function currentUserCompleted(
  remote: FeishuTaskV2,
  currentUserOpenId?: string,
): boolean | undefined {
  if (!currentUserOpenId) return undefined;
  if (isFeishuTaskCompleted(remote)) return true;
  const currentUserState = (remote.assignee_related ?? []).find(
    (candidate) => candidate.id === currentUserOpenId,
  );
  return hasPositiveFeishuTimestamp(currentUserState?.completed_at);
}

/**
 * Maps only Feishu-owned public fields. Remote `extra`, custom data and any
 * unknown properties are ignored, so they cannot populate local private plans.
 */
export function remoteTaskToCreateInput(
  remote: FeishuTaskV2,
  accountId: string,
  now: () => number = Date.now,
  currentUserOpenId?: string,
  syncIdentityId?: string,
): CreateTaskInput {
  const snapshot = remoteTaskToFeishuSnapshot(remote);
  const tasklist = cloneFeishuTasklistBinding(snapshot.tasklist);
  return {
    source: {
      type: "feishu",
      accountId,
      ...(syncIdentityId === undefined ? {} : { syncIdentityId }),
      externalId: remote.guid,
      remoteVersion: remote.updated_at,
      ...(tasklist === undefined ? {} : { tasklist }),
    },
    title: snapshot.title,
    notes: snapshot.notes,
    status: snapshot.status,
    startAt: snapshot.startAt,
    startAtIsAllDay: snapshot.startAtIsAllDay,
    dueAt: snapshot.dueAt,
    dueAtIsAllDay: snapshot.dueAtIsAllDay,
    completedAt: remoteCompletedAt(remote, snapshot, now),
    assigneeIds: memberIds(remote, "assignee"),
    followerIds: memberIds(remote, "follower"),
    completionMode: completionMode(remote),
    currentUserRole: currentUserRole(remote, currentUserOpenId),
    currentUserCompleted: currentUserCompleted(remote, currentUserOpenId),
    // These are intentionally initialized locally rather than inferred from
    // remote extra/custom fields.
    privateNotes: "",
    tags: [],
    customFields: {},
    sync: {
      status: "synced",
      lastSyncedAt: new Date(now()).toISOString(),
    },
  };
}

export class FeishuTaskAdapter {
  private readonly taskService: FeishuTaskServicePort;
  private readonly localStore: FeishuLocalStorePort;
  readonly accountId: string;
  private currentUserOpenId?: string;
  private readonly syncIdentityId?: string;
  private readonly now: () => number;

  constructor(options: FeishuTaskAdapterOptions) {
    this.taskService = options.taskService;
    this.localStore = options.localStore;
    this.accountId = options.accountId;
    this.currentUserOpenId = options.currentUserOpenId;
    this.syncIdentityId = options.syncIdentityId;
    this.now = options.now ?? Date.now;
  }

  setCurrentUserOpenId(openId: string | undefined): void {
    this.currentUserOpenId = openId;
  }

  getTask(localId: string, includeDeleted = true): Promise<Task | undefined> {
    return this.taskService.getTask(localId, includeDeleted);
  }

  async listAccountTasks(): Promise<Task[]> {
    const tasks = await this.taskService.listTasks({
      sourceTypes: ["feishu"],
      accountIds: [this.accountId],
      includeDeleted: true,
    });
    return this.syncIdentityId === undefined
      ? tasks
      : tasks.filter(
          (task) => task.source.syncIdentityId === this.syncIdentityId,
        );
  }

  /**
   * Claims only unbound legacy/new tasks. A task already owned by another
   * OAuth identity is rejected before it can enter this runtime's queue.
   */
  async claimTask(localId: string): Promise<Task | undefined> {
    if (this.syncIdentityId === undefined) {
      return this.taskService.getTask(localId, true);
    }
    return this.localStore.transact((state) => {
      const task = state.tasks[localId];
      if (!task || task.source.type !== "feishu") return undefined;
      if (task.source.accountId !== this.accountId) return undefined;
      const owner = task.source.syncIdentityId;
      if (owner !== undefined && owner !== this.syncIdentityId) {
        throw new Error("Feishu task belongs to another authorized identity.");
      }
      task.source.syncIdentityId = this.syncIdentityId;
      return clone(task);
    });
  }

  /** One-time migration for local ids proven by a legacy mapping/queue. */
  async claimLegacyTasks(
    localIds: readonly string[],
    syncIdentityId: string,
  ): Promise<void> {
    if (this.syncIdentityId !== syncIdentityId) return;
    const unique = new Set(localIds);
    await this.localStore.transact((state) => {
      for (const localId of unique) {
        const task = state.tasks[localId];
        if (
          task?.source.type === "feishu" &&
          task.source.accountId === this.accountId &&
          task.source.syncIdentityId === undefined
        ) {
          task.source.syncIdentityId = syncIdentityId;
        }
      }
    });
  }

  /** Keeps the editable local label in sync without changing real ownership. */
  async relabelOwnedTasks(): Promise<void> {
    if (this.syncIdentityId === undefined) return;
    await this.localStore.transact((state) => {
      for (const task of Object.values(state.tasks)) {
        if (
          task.source.type === "feishu" &&
          task.source.syncIdentityId === this.syncIdentityId
        ) {
          task.source.accountId = this.accountId;
        }
      }
    });
  }

  async createFromRemote(remote: FeishuTaskV2): Promise<Task> {
    const result = await this.taskService.createTask(
      remoteTaskToCreateInput(
        remote,
        this.accountId,
        this.now,
        this.currentUserOpenId,
        this.syncIdentityId,
      ),
    );
    return result.task;
  }

  private applyRemoteInTransaction(
    state: LocalAppState,
    localId: string,
    remote: FeishuTaskV2,
    options: ApplyRemoteOptions,
    preservedLocalFields: readonly FeishuSyncedTaskField[] = [],
    locallyDeleted = false,
  ): Task {
    const snapshot = options.snapshot ?? remoteTaskToFeishuSnapshot(remote);
    const syncStatus = options.status ?? "synced";
    const task = state.tasks[localId];
    if (!task) throw new Error(`Local task ${localId} does not exist.`);

    const preserve = new Set(preservedLocalFields);

    // Deliberately assign an allow-list. plannedDate, privateNotes, tags,
    // privateOrder, focus data and all other local-only fields are untouched.
    // A response to an older outbound push is also not allowed to overwrite a
    // newer local value for a Feishu-owned field.
    if (!preserve.has("title")) task.title = snapshot.title;
    if (!preserve.has("notes")) task.notes = snapshot.notes;
    if (!preserve.has("startAt")) {
      task.startAt = snapshot.startAt;
      if (snapshot.startAt !== undefined && snapshot.startAtIsAllDay === true) {
        task.startAtIsAllDay = true;
      } else {
        delete task.startAtIsAllDay;
      }
    }
    if (!preserve.has("dueAt")) {
      task.dueAt = snapshot.dueAt;
      if (snapshot.dueAt !== undefined && snapshot.dueAtIsAllDay === true) {
        task.dueAtIsAllDay = true;
      } else {
        delete task.dueAtIsAllDay;
      }
    }
    if (!preserve.has("status")) {
      task.status = snapshot.status;
      task.completedAt = remoteCompletedAt(remote, snapshot, this.now);
    }
    if (
      !preserve.has("assigneeIds") &&
      snapshot.assigneeIds !== undefined
    ) {
      task.assigneeIds = canonicalFeishuMemberIds(snapshot.assigneeIds);
    }
    if (
      !preserve.has("followerIds") &&
      snapshot.followerIds !== undefined
    ) {
      task.followerIds = canonicalFeishuMemberIds(snapshot.followerIds);
    }
    if (!preserve.has("tasklist") && snapshot.tasklist !== undefined) {
      const tasklist = cloneFeishuTasklistBinding(snapshot.tasklist)!;
      task.source = { ...task.source, tasklist };
    }
    // A partial Task v2 response can omit `members`. That is not a remote
    // clear; retain existing local member-derived state until a complete
    // member collection arrives.
    if (remote.members !== undefined) {
      task.completionMode = completionMode(remote);
      if (!preserve.has("assigneeIds") && !preserve.has("followerIds")) {
        task.currentUserRole = currentUserRole(remote, this.currentUserOpenId);
      }
      task.currentUserCompleted = currentUserCompleted(
        remote,
        this.currentUserOpenId,
      );
    } else if (remote.mode !== undefined) {
      task.completionMode = completionMode(remote);
    }
    task.source = {
      ...task.source,
      type: "feishu",
      accountId: this.accountId,
      ...(this.syncIdentityId === undefined
        ? {}
        : { syncIdentityId: this.syncIdentityId }),
      externalId: remote.guid,
      remoteVersion: remote.updated_at ?? task.source.remoteVersion,
    };

    if (preservedLocalFields.length > 0 || locallyDeleted) {
      task.sync = {
        ...task.sync,
        status: "pending",
      };
      delete task.sync.error;
      delete task.sync.conflictFields;
    } else {
      task.sync = {
        status: syncStatus,
        lastSyncedAt:
          syncStatus === "synced"
            ? new Date(this.now()).toISOString()
            : task.sync.lastSyncedAt,
      };
    }
    task.updatedAt = new Date(this.now()).toISOString();
    if (!locallyDeleted) delete task.deletedAt;
    return clone(task);
  }

  async applyRemote(
    localId: string,
    remote: FeishuTaskV2,
    options: ApplyRemoteOptions = {},
  ): Promise<Task> {
    return this.localStore.transact((state) =>
      this.applyRemoteInTransaction(state, localId, remote, options),
    );
  }

  /**
   * Reads the latest local task, performs the three-way merge and applies the
   * result under one LocalStore transaction. A local TaskService mutation that
   * commits immediately before this transaction is therefore part of the
   * merge instead of being overwritten by a snapshot read earlier in a pull.
   */
  async mergeAndApplyRemote(
    localId: string,
    remote: FeishuTaskV2,
    base: FeishuTaskSyncSnapshot,
    remoteSnapshot: FeishuTaskSyncSnapshot,
    options: ApplyRemoteMergeOptions = {},
  ): Promise<ApplyRemoteMergeResult> {
    return this.localStore.transact((state) => {
      const current = state.tasks[localId];
      if (!current) return { outcome: "missing" };
      if (current.deletedAt) {
        return { outcome: "locally-deleted", task: clone(current) };
      }

      const local = localTaskToFeishuSnapshot(current);
      const merge = threeWayMergeFeishuTask(base, local, remoteSnapshot);
      if (merge.conflicts.length > 0) {
        current.sync = {
          ...current.sync,
          status: "conflict",
          error: "The task changed locally and in Feishu.",
          conflictFields: merge.conflicts.map((value) => value.field),
        };
        current.updatedAt = new Date(this.now()).toISOString();
        return {
          outcome: "conflict",
          task: clone(current),
          local,
          conflicts: clone(merge.conflicts),
        };
      }

      const hasLocalChanges = merge.localChanges.length > 0;
      const task = this.applyRemoteInTransaction(state, localId, remote, {
        snapshot: merge.merged,
        status: hasLocalChanges
          ? (options.localChangesStatus ?? "pending")
          : "synced",
      });
      if (hasLocalChanges && options.localChangesError) {
        state.tasks[localId]!.sync.error = options.localChangesError;
        task.sync.error = options.localChangesError;
      }
      return {
        outcome: "applied",
        task,
        local,
        localChanges: clone(merge.localChanges),
      };
    });
  }

  /**
   * Applies a remote confirmation from a push without clobbering fields that
   * changed locally after that push started. The comparison is inside the same
   * LocalStore transaction as the write, closing the read/write race.
   */
  async applyRemoteAfterPush(
    localId: string,
    remote: FeishuTaskV2,
    expectedLocalSnapshot: FeishuTaskSyncSnapshot,
    options: ApplyRemoteOptions = {},
  ): Promise<ApplyRemoteAfterPushResult> {
    let preservedLocalFields: FeishuSyncedTaskField[] = [];
    let locallyDeleted = false;
    const task = await this.localStore.transact((state) => {
      const current = state.tasks[localId];
      if (!current) throw new Error(`Local task ${localId} does not exist.`);

      locallyDeleted = current.deletedAt !== undefined;
      if (locallyDeleted) {
        // A local deletion that happened while a create/update was in flight
        // must stay deleted. Keep every public field as-is until the service
        // has queued the corresponding remote delete.
        preservedLocalFields = [...FEISHU_SNAPSHOT_FIELDS];
      } else {
        const currentSnapshot = localTaskToFeishuSnapshot(current);
        preservedLocalFields = FEISHU_SNAPSHOT_FIELDS.filter(
          (field) =>
            !feishuSnapshotFieldsEqual(
              currentSnapshot,
              expectedLocalSnapshot,
              field,
            ),
        );
      }

      return this.applyRemoteInTransaction(
        state,
        localId,
        remote,
        options,
        preservedLocalFields,
        locallyDeleted,
      );
    });
    return { task, preservedLocalFields, locallyDeleted };
  }

  async setSyncStatus(
    localId: string,
    status: Task["sync"]["status"],
    options: { error?: string; conflictFields?: string[] } = {},
  ): Promise<Task | undefined> {
    return this.localStore.transact((state) => {
      const task = state.tasks[localId];
      if (!task) return undefined;
      task.sync = {
        ...task.sync,
        status,
        error: options.error,
        conflictFields: options.conflictFields,
        ...(status === "synced"
          ? { lastSyncedAt: new Date(this.now()).toISOString() }
          : {}),
      };
      return clone(task);
    });
  }

  async markRemoteDeleted(
    localId: string,
    remoteGuid: string,
  ): Promise<Task | undefined> {
    return this.localStore.transact((state) => {
      const task = state.tasks[localId];
      if (!task) return undefined;
      const timestamp = new Date(this.now()).toISOString();
      task.deletedAt ??= timestamp;
      task.updatedAt = timestamp;
      task.source = {
        ...task.source,
        type: "feishu",
        accountId: this.accountId,
        ...(this.syncIdentityId === undefined
          ? {}
          : { syncIdentityId: this.syncIdentityId }),
        externalId: remoteGuid,
      };
      task.sync = {
        status: "remote-deleted",
        tombstone: {
          deletedAt: task.deletedAt,
          confirmedAt: timestamp,
        },
      };
      return clone(task);
    });
  }

  /**
   * A task may be moved to local trash before its initial Feishu create ever
   * receives a GUID. In that case there is no remote resource to delete, but
   * the local tombstone has still converged. Keep this conditional on
   * `deletedAt`: a restore racing with the background queue must remain
   * pending for its eventual first create rather than being overwritten as
   * synced.
   */
  async markUncreatedDeletionSynced(
    localId: string,
  ): Promise<Task | undefined> {
    return this.localStore.transact((state) => {
      const task = state.tasks[localId];
      if (!task || !task.deletedAt) return undefined;
      task.sync = {
        status: "synced",
        lastSyncedAt: new Date(this.now()).toISOString(),
      };
      return clone(task);
    });
  }

  async duplicateAsLocal(localId: string): Promise<Task> {
    const original = await this.getTask(localId, true);
    if (!original) throw new Error(`Local task ${localId} does not exist.`);
    const input: CreateTaskInput = {
      source: { type: "local" },
      title: original.title,
      notes: original.notes,
      privateNotes: original.privateNotes,
      status: original.status,
      priority: original.priority,
      projectId: original.projectId,
      listId: original.listId,
      sectionId: original.sectionId,
      tags: clone(original.tags),
      contexts: clone(original.contexts ?? []),
      parentId: original.parentId,
      dependencyIds: clone(original.dependencyIds),
      assigneeIds: [],
      followerIds: [],
      attachments: clone(original.attachments),
      links: clone(original.links),
      customFields: clone(original.customFields),
      researchCards: clone(original.researchCards ?? []),
      plannedDate: original.plannedDate,
      startAt: original.startAt,
      startAtIsAllDay: original.startAtIsAllDay,
      dueAt: original.dueAt,
      dueAtIsAllDay: original.dueAtIsAllDay,
      timeBlock: original.timeBlock && clone(original.timeBlock),
      reminders: clone(original.reminders),
      completedAt: original.completedAt,
      recurrence: original.recurrence && clone(original.recurrence),
      recurrenceSeriesId: original.recurrenceSeriesId,
      recurrenceIndex: original.recurrenceIndex,
      estimatedMinutes: original.estimatedMinutes,
      actualMinutes: original.actualMinutes,
      focusStartedAt: original.focusStartedAt,
      focusElapsedSeconds: original.focusElapsedSeconds,
      focusSessions: clone(original.focusSessions ?? []),
      privateOrder: original.privateOrder,
      sync: { status: "local" },
    };
    return (await this.taskService.createTask(input)).task;
  }

  toCreatePayload(task: Task): FeishuCreateTaskPayload {
    return buildFeishuCreatePayload(task, {
      currentUserOpenId: this.currentUserOpenId,
    });
  }

  toPatchPayload(
    snapshot: FeishuTaskSyncSnapshot,
    fields: readonly FeishuSyncedTaskField[],
  ): FeishuPatchTaskPayload | undefined {
    return buildFeishuPatchPayload(snapshot, fields);
  }
}
