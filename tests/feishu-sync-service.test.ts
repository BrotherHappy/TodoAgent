// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createEmptyLocalAppState } from "../src/shared/models";
import type {
  CreateTaskInput,
  LocalAppState,
  Task,
  TaskFilter,
  TaskMutationResult,
} from "../src/shared/models";
import type {
  FeishuAuthConfig,
  FeishuCreateTaskPayload,
  FeishuListTasksOptions,
  FeishuPatchTaskPayload,
  FeishuTaskMember,
  FeishuTasklistMembership,
  FeishuTokenSet,
  FeishuTokenStore,
  FeishuTaskV2,
} from "../src/shared/feishu-types";
import {
  FeishuApiError,
  FeishuClient,
  FeishuNotFoundError,
  FeishuPermissionError,
  FeishuRateLimitError,
  FeishuTasklistPermissionError,
} from "../electron/feishu/feishu-client";
import {
  FeishuTaskAdapter,
  type FeishuLocalStorePort,
  type FeishuTaskServicePort,
} from "../electron/feishu/feishu-task-adapter";
import {
  FeishuSyncService,
  type FeishuApplicationRemoteApi,
  type FeishuApplicationStateStore,
  type FeishuApplicationSyncState,
  type FeishuPollingScheduler,
  type FeishuTaskChangePage,
} from "../electron/feishu/feishu-sync-service";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

const clone = <Value>(value: Value): Value => structuredClone(value);

class MemoryLocalStore implements FeishuLocalStorePort {
  state: LocalAppState = createEmptyLocalAppState();
  /** Simulates a user transaction committing immediately before the pull lock. */
  beforeNextTransaction?: (state: LocalAppState) => void;

  async transact<Result>(
    mutator: (draft: LocalAppState) => Result | Promise<Result>,
  ): Promise<Result> {
    const before = this.beforeNextTransaction;
    this.beforeNextTransaction = undefined;
    before?.(this.state);
    const draft = clone(this.state);
    const result = await mutator(draft);
    draft.revision += 1;
    this.state = draft;
    return result;
  }
}

class MemoryTaskService implements FeishuTaskServicePort {
  private nextId = 0;

  constructor(
    private readonly store: MemoryLocalStore,
    private readonly now: () => number,
  ) {}

  async getTask(id: string, includeDeleted = false): Promise<Task | undefined> {
    const task = this.store.state.tasks[id];
    if (!task || (!includeDeleted && task.deletedAt)) return undefined;
    return clone(task);
  }

  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    return Object.values(this.store.state.tasks)
      .filter((task) => filter.includeDeleted || !task.deletedAt)
      .filter(
        (task) =>
          !filter.sourceTypes || filter.sourceTypes.includes(task.source.type),
      )
      .filter(
        (task) =>
          !filter.accountIds ||
          (task.source.accountId !== undefined &&
            filter.accountIds.includes(task.source.accountId)),
      )
      .map(clone);
  }

  async createTask(input: CreateTaskInput): Promise<TaskMutationResult> {
    const id = `task-${++this.nextId}`;
    const now = new Date(this.now()).toISOString();
    const status = input.status ?? "open";
    const source = clone(input.source ?? { type: "local" as const });
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
      tags: clone(input.tags ?? []),
      parentId: input.parentId,
      dependencyIds: clone(input.dependencyIds ?? []),
      assigneeIds: clone(input.assigneeIds ?? []),
      followerIds: clone(input.followerIds ?? []),
      attachments: clone(input.attachments ?? []),
      links: clone(input.links ?? []),
      customFields: clone(input.customFields ?? {}),
      plannedDate: input.plannedDate,
      startAt: input.startAt,
      startAtIsAllDay: input.startAtIsAllDay,
      dueAt: input.dueAt,
      dueAtIsAllDay: input.dueAtIsAllDay,
      timeBlock: input.timeBlock && clone(input.timeBlock),
      reminders: clone(input.reminders ?? []),
      completedAt:
        status === "completed" ? (input.completedAt ?? now) : undefined,
      recurrence: input.recurrence && clone(input.recurrence),
      recurrenceSeriesId: input.recurrenceSeriesId,
      recurrenceIndex: input.recurrenceIndex,
      estimatedMinutes: input.estimatedMinutes,
      actualMinutes: input.actualMinutes,
      focusStartedAt: input.focusStartedAt,
      focusElapsedSeconds: input.focusElapsedSeconds ?? 0,
      focusSessions: clone(input.focusSessions ?? []),
      privateOrder: input.privateOrder ?? this.nextId,
      completionMode: input.completionMode,
      currentUserRole: input.currentUserRole,
      currentUserCompleted: input.currentUserCompleted,
      sync: clone(
        input.sync ?? { status: source.type === "local" ? "local" : "pending" },
      ),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.transact((state) => {
      state.tasks[id] = clone(task);
    });
    return { task: clone(task), operationId: `operation-${id}` };
  }
}

class MemorySyncStateStore implements FeishuApplicationStateStore {
  state?: FeishuApplicationSyncState;
  saves = 0;

  async load(): Promise<FeishuApplicationSyncState | undefined> {
    return this.state && clone(this.state);
  }

  async save(state: FeishuApplicationSyncState): Promise<void> {
    this.state = clone(state);
    this.saves += 1;
  }
}

class FakeRemote implements FeishuApplicationRemoteApi {
  readonly tasks = new Map<string, FeishuTaskV2>();
  readonly createPayloads: FeishuCreateTaskPayload[] = [];
  readonly createTokens: string[] = [];
  readonly patches: FeishuPatchTaskPayload[] = [];
  readonly memberAdds: FeishuTaskMember[][] = [];
  readonly memberRemoves: FeishuTaskMember[][] = [];
  readonly tasklistsByGuid = new Map<string, FeishuTasklistMembership[]>();
  readonly tasklistAdds: Array<{
    taskGuid: string;
    tasklist: FeishuTasklistMembership;
  }> = [];
  readonly tasklistRemovals: Array<{
    taskGuid: string;
    tasklistGuid: string;
  }> = [];
  readonly tasklistActions: Array<
    | { kind: "add"; taskGuid: string; tasklistGuid: string }
    | { kind: "remove"; taskGuid: string; tasklistGuid: string }
  > = [];
  readonly deleted: string[] = [];
  readonly completeErrors = new Map<string, Error>();
  readonly completeAttempts: string[] = [];
  completeCalls = 0;
  reopenCalls = 0;
  listAllCalls = 0;
  rateLimitedCreates = 0;
  retryAfterMs = 40;
  currentCursor = "cursor-1";
  changePages = new Map<string, FeishuTaskChangePage | Error>();
  /** Simulates Task v2 `my_tasks` omitting otherwise addressable tasks. */
  visibleTaskGuids?: Set<string>;
  private nextGuid = 0;
  private readonly createByToken = new Map<string, string>();

  async listAllTasks(
    _options?: FeishuListTasksOptions,
  ): Promise<FeishuTaskV2[]> {
    this.listAllCalls += 1;
    return [...this.tasks.values()]
      .filter(
        (task) =>
          this.visibleTaskGuids === undefined ||
          this.visibleTaskGuids.has(task.guid),
      )
      .map(clone);
  }

  async listTaskChanges(options: {
    cursor: string;
    pageSize: number;
  }): Promise<FeishuTaskChangePage> {
    const configured = this.changePages.get(options.cursor);
    if (configured instanceof Error) throw configured;
    return clone(
      configured ?? {
        items: [],
        deletedGuids: [],
        nextCursor: options.cursor,
        hasMore: false,
      },
    );
  }

  async getCurrentSyncCursor(): Promise<string> {
    return this.currentCursor;
  }

  async getTask(taskGuid: string): Promise<FeishuTaskV2> {
    const task = this.tasks.get(taskGuid);
    if (!task) throw new FeishuNotFoundError("not found", { status: 404 });
    return clone(task);
  }

  async createTask(
    task: FeishuCreateTaskPayload,
    clientToken: string,
  ): Promise<FeishuTaskV2> {
    this.createPayloads.push(clone(task));
    this.createTokens.push(clientToken);
    if (this.rateLimitedCreates > 0) {
      this.rateLimitedCreates -= 1;
      throw new FeishuRateLimitError("rate limited", {
        status: 429,
        retryAfterMs: this.retryAfterMs,
      });
    }
    const existingGuid = this.createByToken.get(clientToken);
    if (existingGuid) return clone(this.tasks.get(existingGuid)!);
    const guid = `created-guid-${++this.nextGuid}`;
    const remote: FeishuTaskV2 = {
      guid,
      summary: task.summary,
      description: task.description,
      start: task.start,
      due: task.due,
      members: task.members && clone(task.members),
      status: "open",
      updated_at: `version-${this.nextGuid}`,
    };
    this.tasks.set(guid, remote);
    this.createByToken.set(clientToken, guid);
    return clone(remote);
  }

  async updateTask(
    taskGuid: string,
    patch: FeishuPatchTaskPayload,
  ): Promise<FeishuTaskV2> {
    const task = await this.getTask(taskGuid);
    this.patches.push(clone(patch));
    if (patch.update_fields.includes("summary")) {
      task.summary = patch.task.summary ?? "";
    }
    if (patch.update_fields.includes("description")) {
      task.description = patch.task.description ?? "";
    }
    if (patch.update_fields.includes("start")) task.start = patch.task.start;
    if (patch.update_fields.includes("due")) task.due = patch.task.due;
    task.updated_at = `${task.updated_at ?? "version"}-updated`;
    this.tasks.set(taskGuid, task);
    return clone(task);
  }

  async addTaskMembers(
    taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2> {
    const task = await this.getTask(taskGuid);
    this.memberAdds.push(clone(members));
    const existing = task.members ?? [];
    const seen = new Set(existing.map((member) => `${member.role}\u0000${member.id}`));
    task.members = [
      ...existing,
      ...members.filter((member) => {
        const key = `${member.role}\u0000${member.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ];
    task.updated_at = `${task.updated_at ?? "version"}-members-added`;
    this.tasks.set(taskGuid, task);
    return clone(task);
  }

  async removeTaskMembers(
    taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2> {
    const task = await this.getTask(taskGuid);
    this.memberRemoves.push(clone(members));
    const remove = new Set(members.map((member) => `${member.role}\u0000${member.id}`));
    task.members = (task.members ?? []).filter(
      (member) => !remove.has(`${member.role}\u0000${member.id}`),
    );
    task.updated_at = `${task.updated_at ?? "version"}-members-removed`;
    this.tasks.set(taskGuid, task);
    return clone(task);
  }

  async listTasklists(
    taskGuid: string,
  ): Promise<FeishuTasklistMembership[]> {
    // Keep the fake faithful to Task v2: the dedicated association endpoint
    // is needed even when ordinary task reads omit `tasklists`.
    await this.getTask(taskGuid);
    return clone(this.tasklistsByGuid.get(taskGuid) ?? []);
  }

  async addTaskToTasklist(
    taskGuid: string,
    tasklist: FeishuTasklistMembership,
  ): Promise<FeishuTaskV2> {
    const task = await this.getTask(taskGuid);
    this.tasklistAdds.push({ taskGuid, tasklist: clone(tasklist) });
    this.tasklistActions.push({
      kind: "add",
      taskGuid,
      tasklistGuid: tasklist.tasklist_guid,
    });
    const memberships = this.tasklistsByGuid.get(taskGuid) ?? [];
    this.tasklistsByGuid.set(taskGuid, [
      ...memberships.filter(
        (membership) => membership.tasklist_guid !== tasklist.tasklist_guid,
      ),
      clone(tasklist),
    ]);
    task.updated_at = `${task.updated_at ?? "version"}-tasklist-added`;
    this.tasks.set(taskGuid, task);
    return clone(task);
  }

  async removeTaskFromTasklist(
    taskGuid: string,
    tasklistGuid: string,
  ): Promise<FeishuTaskV2> {
    const task = await this.getTask(taskGuid);
    this.tasklistRemovals.push({ taskGuid, tasklistGuid });
    this.tasklistActions.push({ kind: "remove", taskGuid, tasklistGuid });
    this.tasklistsByGuid.set(
      taskGuid,
      (this.tasklistsByGuid.get(taskGuid) ?? []).filter(
        (membership) => membership.tasklist_guid !== tasklistGuid,
      ),
    );
    task.updated_at = `${task.updated_at ?? "version"}-tasklist-removed`;
    this.tasks.set(taskGuid, task);
    return clone(task);
  }

  async deleteTask(taskGuid: string): Promise<void> {
    if (!this.tasks.delete(taskGuid)) {
      throw new FeishuNotFoundError("not found", { status: 404 });
    }
    this.deleted.push(taskGuid);
  }

  async completeTask(taskGuid: string): Promise<FeishuTaskV2> {
    this.completeAttempts.push(taskGuid);
    const configuredError = this.completeErrors.get(taskGuid);
    if (configuredError) {
      if (configuredError instanceof FeishuNotFoundError) {
        this.tasks.delete(taskGuid);
      }
      throw configuredError;
    }
    const task = await this.getTask(taskGuid);
    this.completeCalls += 1;
    task.status = "completed";
    task.completed_at = String(NOW);
    this.tasks.set(taskGuid, task);
    return clone(task);
  }

  async reopenTask(taskGuid: string): Promise<FeishuTaskV2> {
    const task = await this.getTask(taskGuid);
    this.reopenCalls += 1;
    task.status = "open";
    delete task.completed_at;
    this.tasks.set(taskGuid, task);
    return clone(task);
  }
}

interface RequestGate {
  readonly started: Promise<void>;
  readonly released: Promise<void>;
  markStarted(): void;
  release(): void;
}

function createRequestGate(): RequestGate {
  let markStarted!: () => void;
  let release!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    markStarted: () => markStarted(),
    release: () => release(),
  };
}

/** Lets a test make a user edit while a simulated Feishu write is in flight. */
class DelayedPushRemote extends FakeRemote {
  private createGate?: RequestGate;
  private updateGate?: RequestGate;

  holdNextCreate(): RequestGate {
    const gate = createRequestGate();
    this.createGate = gate;
    return gate;
  }

  holdNextUpdate(): RequestGate {
    const gate = createRequestGate();
    this.updateGate = gate;
    return gate;
  }

  override async createTask(
    task: FeishuCreateTaskPayload,
    clientToken: string,
  ): Promise<FeishuTaskV2> {
    const gate = this.createGate;
    this.createGate = undefined;
    if (gate) {
      gate.markStarted();
      await gate.released;
    }
    return super.createTask(task, clientToken);
  }

  override async updateTask(
    taskGuid: string,
    patch: FeishuPatchTaskPayload,
  ): Promise<FeishuTaskV2> {
    const gate = this.updateGate;
    this.updateGate = undefined;
    if (gate) {
      gate.markStarted();
      await gate.released;
    }
    return super.updateTask(taskGuid, patch);
  }
}

function createHarness(
  options: {
    remote?: FeishuApplicationRemoteApi;
    stateStore?: MemorySyncStateStore;
    online?: { value: boolean };
    sleep?: (milliseconds: number) => Promise<void>;
    scheduler?: FeishuPollingScheduler;
  } = {},
) {
  const localStore = new MemoryLocalStore();
  const taskService = new MemoryTaskService(localStore, () => NOW);
  const adapter = new FeishuTaskAdapter({
    taskService,
    localStore,
    accountId: "account-1",
    currentUserOpenId: "ou_current",
    now: () => NOW,
  });
  const stateStore = options.stateStore ?? new MemorySyncStateStore();
  const remote = options.remote ?? new FakeRemote();
  const online = options.online ?? { value: true };
  let generated = 0;
  const service = new FeishuSyncService({
    remote,
    adapter,
    stateStore,
    connectivity: { isOnline: () => online.value },
    scheduler: options.scheduler,
    sleep: options.sleep,
    now: () => NOW,
    createId: () => `sync-id-${++generated}`,
    fullSyncIntervalMs: 60_000,
  });
  return {
    localStore,
    taskService,
    adapter,
    stateStore,
    remote,
    online,
    service,
  };
}

describe("Feishu application pull adapter", () => {
  it("maps Feishu completion mode, authorized-user role, and co-sign state", async () => {
    const harness = createHarness();
    const local = await harness.adapter.createFromRemote({
      guid: "remote-cosign",
      summary: "Co-sign task",
      status: "open",
      mode: 1,
      members: [
        { id: "ou_current", role: "assignee", type: "user" },
        { id: "ou_other", role: "assignee", type: "user" },
      ],
      assignee_related: [{ id: "ou_current", completed_at: "1800000000000" }],
      updated_at: "v-mode-1",
    });

    expect(local).toMatchObject({
      completionMode: "all-assignees",
      currentUserRole: "assignee",
      currentUserCompleted: true,
    });

    const updated = await harness.adapter.applyRemote(local.id, {
      guid: "remote-cosign",
      summary: "Any assignee task",
      status: "open",
      mode: 2,
      members: [
        { id: "ou_other", role: "assignee", type: "user" },
        { id: "ou_current", role: "follower", type: "user" },
      ],
      updated_at: "v-mode-2",
    });
    expect(updated).toMatchObject({
      completionMode: "any-assignee",
      currentUserRole: "follower",
      currentUserCompleted: false,
    });

    const zeroTimestamp = await harness.adapter.applyRemote(local.id, {
      guid: "remote-cosign",
      summary: "Still waiting for my part",
      status: "todo",
      completed_at: "0",
      mode: 1,
      members: [
        { id: "ou_current", role: "assignee", type: "user" },
        { id: "ou_other", role: "assignee", type: "user" },
      ],
      assignee_related: [{ id: "ou_current", completed_at: "0" }],
      updated_at: "v-mode-1-zero",
    });
    expect(zeroTimestamp).toMatchObject({
      status: "open",
      completionMode: "all-assignees",
      currentUserCompleted: false,
    });
    expect(zeroTimestamp.completedAt).toBeUndefined();

    const doneWithoutTimestamp = await harness.adapter.applyRemote(local.id, {
      guid: "remote-cosign",
      summary: "Finished co-sign task",
      status: "done",
      completed_at: "0",
      mode: 1,
      members: [
        { id: "ou_current", role: "assignee", type: "user" },
        { id: "ou_other", role: "assignee", type: "user" },
      ],
      assignee_related: [{ id: "ou_current", completed_at: "0" }],
      updated_at: "v-mode-1-done",
    });
    expect(doneWithoutTimestamp).toMatchObject({
      status: "completed",
      currentUserCompleted: true,
      completedAt: new Date(NOW).toISOString(),
    });
  });

  it("repairs a previously completed local task when a full pull returns todo with zero timestamps", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("remote-reopened", {
      guid: "remote-reopened",
      summary: "Reopened in Feishu",
      status: "completed",
      completed_at: String(NOW - 1_000),
      mode: 1,
      members: [{ id: "ou_current", role: "assignee", type: "user" }],
      assignee_related: [
        { id: "ou_current", completed_at: String(NOW - 1_000) },
      ],
      updated_at: "v1",
    });

    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "remote-reopened"
    ];
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      status: "completed",
      currentUserCompleted: true,
    });

    remote.tasks.set("remote-reopened", {
      ...remote.tasks.get("remote-reopened")!,
      status: "todo",
      completed_at: "0",
      assignee_related: [{ id: "ou_current", completed_at: "0" }],
      updated_at: "v2",
    });
    const repaired = await harness.service.syncNow({ forceFull: true });

    expect(repaired).toMatchObject({ pulled: 1, usedFullSync: true });
    const local = await harness.adapter.getTask(localId);
    expect(local).toMatchObject({
      status: "open",
      currentUserCompleted: false,
      source: { remoteVersion: "v2" },
    });
    expect(local?.completedAt).toBeUndefined();
  });

  it("full-pulls, incrementally upserts/deletes, maps completion and preserves privacy", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("remote-open", {
      guid: "remote-open",
      summary: "Remote public title",
      description: "Remote public notes",
      status: "open",
      members: [{ id: "ou_a", role: "assignee", type: "user" }],
      updated_at: "v1",
      extra: JSON.stringify({
        plannedDate: "2030-01-01",
        privateNotes: "MUST NOT IMPORT",
        tags: ["MUST-NOT-IMPORT"],
      }),
    });
    remote.tasks.set("remote-complete", {
      guid: "remote-complete",
      summary: "Already done",
      status: "completed",
      completed_at: String(NOW - 1_000),
      updated_at: "v1",
    });

    const first = await harness.service.syncNow({ forceFull: true });
    expect(first).toMatchObject({
      pulled: 2,
      usedFullSync: true,
      cursor: "cursor-1",
    });
    const state = await harness.service.getState();
    const openId = state.localIdByGuid["remote-open"];
    const completeId = state.localIdByGuid["remote-complete"];
    const open = await harness.adapter.getTask(openId);
    const complete = await harness.adapter.getTask(completeId);
    expect(open).toMatchObject({
      title: "Remote public title",
      notes: "Remote public notes",
      privateNotes: "",
      tags: [],
      assigneeIds: ["ou_a"],
    });
    expect(open?.plannedDate).toBeUndefined();
    expect(complete).toMatchObject({
      status: "completed",
      completedAt: new Date(NOW - 1_000).toISOString(),
    });

    await harness.localStore.transact((local) => {
      const task = local.tasks[openId];
      task.privateNotes = "LOCAL SECRET";
      task.plannedDate = "2026-08-20";
      task.tags = ["private-context"];
    });
    const updatedRemote = {
      ...remote.tasks.get("remote-open")!,
      summary: "Changed in Feishu",
      description: "Changed remote notes",
      updated_at: "v2",
    };
    remote.tasks.set("remote-open", updatedRemote);
    remote.changePages.set("cursor-1", {
      items: [updatedRemote],
      deletedGuids: [],
      nextCursor: "cursor-2",
      hasMore: false,
    });

    const incremental = await harness.service.syncNow();
    expect(incremental.usedFullSync).toBe(false);
    expect(incremental.cursor).toBe("cursor-2");
    expect(await harness.adapter.getTask(openId)).toMatchObject({
      title: "Changed in Feishu",
      notes: "Changed remote notes",
      privateNotes: "LOCAL SECRET",
      plannedDate: "2026-08-20",
      tags: ["private-context"],
    });

    remote.tasks.delete("remote-complete");
    remote.changePages.set("cursor-2", {
      items: [],
      deletedGuids: ["remote-complete"],
      nextCursor: "cursor-3",
      hasMore: false,
    });
    await harness.service.syncNow();
    expect(await harness.adapter.getTask(completeId, true)).toMatchObject({
      deletedAt: new Date(NOW).toISOString(),
      sync: { status: "remote-deleted" },
    });

    // An expired/invalid incremental cursor automatically falls back to full.
    remote.tasks.set("remote-open", {
      ...updatedRemote,
      summary: "Full fallback result",
      updated_at: "v3",
    });
    remote.currentCursor = "cursor-4";
    remote.changePages.set("cursor-3", {
      items: [],
      deletedGuids: [],
      hasMore: false,
      cursorInvalid: true,
    });
    const fallback = await harness.service.syncNow();
    expect(fallback.usedFullSync).toBe(true);
    expect(fallback.cursor).toBe("cursor-4");
    expect(remote.listAllCalls).toBe(2);
    expect((await harness.adapter.getTask(openId))?.title).toBe(
      "Full fallback result",
    );
  });

  it("merges a user edit committed at the pull write boundary without losing public fields", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const baseDue = new Date(NOW + 60_000).toISOString();
    const localDue = new Date(NOW + 120_000).toISOString();
    remote.tasks.set("remote-pull-race", {
      guid: "remote-pull-race",
      summary: "Base title",
      description: "Base notes",
      due: { timestamp: String(Date.parse(baseDue)), is_all_day: false },
      status: "open",
      members: [
        { id: "ou_base_assignee", role: "assignee", type: "user" },
        { id: "ou_base_follower", role: "follower", type: "user" },
      ],
      tasklists: [{ tasklist_guid: "tasklist-base" }],
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "remote-pull-race"
    ];

    remote.tasks.set("remote-pull-race", {
      ...remote.tasks.get("remote-pull-race")!,
      description: "Notes changed remotely",
      updated_at: "v2",
    });
    harness.localStore.beforeNextTransaction = (state) => {
      const task = state.tasks[localId];
      task.title = "Title edited at transaction boundary";
      task.dueAt = localDue;
      task.dueAtIsAllDay = true;
      task.status = "completed";
      task.completedAt = new Date(NOW).toISOString();
      task.assigneeIds = ["ou_local_assignee"];
      task.followerIds = ["ou_local_follower"];
      task.source = {
        ...task.source,
        tasklist: {
          tasklistGuid: "tasklist-local",
          sectionGuid: "section-local",
        },
      };
      task.sync = { ...task.sync, status: "pending" };
    };

    const report = await harness.service.syncNow({ forceFull: true });

    expect(report).toMatchObject({ pulled: 1, conflicts: [] });
    expect(await harness.adapter.getTask(localId, true)).toMatchObject({
      title: "Title edited at transaction boundary",
      notes: "Notes changed remotely",
      dueAt: localDue,
      dueAtIsAllDay: true,
      status: "completed",
      assigneeIds: ["ou_local_assignee"],
      followerIds: ["ou_local_follower"],
      source: {
        tasklist: {
          tasklistGuid: "tasklist-local",
          sectionGuid: "section-local",
        },
        remoteVersion: "v2",
      },
      sync: { status: "pending" },
    });
    expect((await harness.service.getState()).queue).toEqual([
      expect.objectContaining({ localId, kind: "update", attempts: 0 }),
    ]);
  });

  it("detects divergent user edits committed at the pull write boundary as conflicts", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const baseDue = new Date(NOW + 60_000).toISOString();
    const localDue = new Date(NOW + 120_000).toISOString();
    const remoteDue = new Date(NOW + 180_000).toISOString();
    remote.tasks.set("remote-pull-conflict-race", {
      guid: "remote-pull-conflict-race",
      summary: "Base title",
      due: { timestamp: String(Date.parse(baseDue)), is_all_day: false },
      status: "open",
      members: [{ id: "ou_base", role: "assignee", type: "user" }],
      tasklists: [{ tasklist_guid: "tasklist-base" }],
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "remote-pull-conflict-race"
    ];

    remote.tasks.set("remote-pull-conflict-race", {
      ...remote.tasks.get("remote-pull-conflict-race")!,
      summary: "Remote title",
      due: { timestamp: String(Date.parse(remoteDue)), is_all_day: false },
      members: [{ id: "ou_remote", role: "assignee", type: "user" }],
      tasklists: [{ tasklist_guid: "tasklist-remote" }],
      updated_at: "v2",
    });
    harness.localStore.beforeNextTransaction = (state) => {
      const task = state.tasks[localId];
      task.title = "Local title";
      task.dueAt = localDue;
      task.dueAtIsAllDay = true;
      task.assigneeIds = ["ou_local"];
      task.source = {
        ...task.source,
        tasklist: { tasklistGuid: "tasklist-local" },
      };
      task.sync = { ...task.sync, status: "pending" };
    };

    const report = await harness.service.syncNow({ forceFull: true });

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.fields.map(({ field }) => field)).toEqual([
      "title",
      "dueAt",
      "assigneeIds",
      "tasklist",
    ]);
    expect(await harness.adapter.getTask(localId, true)).toMatchObject({
      title: "Local title",
      dueAt: localDue,
      dueAtIsAllDay: true,
      assigneeIds: ["ou_local"],
      source: { tasklist: { tasklistGuid: "tasklist-local" } },
      sync: {
        status: "conflict",
        conflictFields: ["title", "dueAt", "assigneeIds", "tasklist"],
      },
    });
  });
});

describe("Feishu application push and recovery", () => {
  it("keeps a freshly created task when Task v2's partial list omits it", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const local = (
      await harness.taskService.createTask({
        source: { type: "feishu", accountId: "account-1" },
        title: "Created but not yet listed",
        sync: { status: "pending" },
      })
    ).task;
    await harness.service.enqueueUpsert(local.id);

    // The POST is accepted, but the immediately-following `my_tasks` list does
    // not contain the new GUID yet. This mirrors Task v2's partial/eventually
    // consistent list without making the task itself unavailable by GUID.
    remote.visibleTaskGuids = new Set();
    const report = await harness.service.syncNow({ forceFull: true });

    expect(report).toMatchObject({ pushed: 1, deleted: 0, usedFullSync: true });
    const saved = await harness.adapter.getTask(local.id, true);
    expect(saved).toMatchObject({
      title: "Created but not yet listed",
      source: {
        type: "feishu",
        accountId: "account-1",
        externalId: "created-guid-1",
      },
      sync: { status: "synced" },
    });
    expect(saved?.deletedAt).toBeUndefined();
    const mapping = (await harness.service.getState()).mappingsByLocalId[
      local.id
    ];
    expect(mapping).toMatchObject({
      guid: "created-guid-1",
    });
    expect(mapping?.deleted).toBeUndefined();
  });

  it("does not treat an existing mapping omitted from Task v2's partial list as deleted", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("addressable-but-hidden", {
      guid: "addressable-but-hidden",
      summary: "Still exists remotely",
      status: "open",
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "addressable-but-hidden"
    ];

    remote.visibleTaskGuids = new Set();
    const report = await harness.service.syncNow({ forceFull: true });

    expect(report.deleted).toBe(0);
    const saved = await harness.adapter.getTask(localId, true);
    expect(saved).toMatchObject({
      title: "Still exists remotely",
      sync: { status: "synced" },
    });
    expect(saved?.deletedAt).toBeUndefined();
    const mapping = (await harness.service.getState()).mappingsByLocalId[
      localId
    ];
    expect(mapping).toMatchObject({
      guid: "addressable-but-hidden",
    });
    expect(mapping?.deleted).toBeUndefined();
  });

  it("restores a falsely remote-deleted task through its original GUID without creating a duplicate", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("restore-original-guid", {
      guid: "restore-original-guid",
      summary: "Original remote task",
      status: "open",
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "restore-original-guid"
    ];

    // Reproduce the old unsafe absent-from-list behaviour: the local record
    // and mapping have already been marked remote-deleted even though the
    // exact remote GUID is still valid.
    remote.tasks.delete("restore-original-guid");
    remote.changePages.set("cursor-1", {
      items: [],
      deletedGuids: ["restore-original-guid"],
      nextCursor: "cursor-2",
      hasMore: false,
    });
    await harness.service.syncNow();
    expect(await harness.adapter.getTask(localId, true)).toMatchObject({
      deletedAt: new Date(NOW).toISOString(),
      sync: { status: "remote-deleted" },
    });

    remote.tasks.set("restore-original-guid", {
      guid: "restore-original-guid",
      summary: "Original remote task",
      status: "open",
      updated_at: "v1",
    });
    remote.visibleTaskGuids = new Set();
    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      delete task.deletedAt;
      task.sync = { status: "pending" };
    });

    const report = await harness.service.syncNow({ forceFull: true });

    expect(report).toMatchObject({ pushed: 1, deleted: 0 });
    expect(remote.createPayloads).toEqual([]);
    expect(remote.tasks.size).toBe(1);
    expect(await harness.adapter.getTask(localId, true)).toMatchObject({
      source: { externalId: "restore-original-guid" },
      sync: { status: "synced" },
    });
    expect((await harness.adapter.getTask(localId, true))?.deletedAt).toBeUndefined();
    expect(
      (await harness.service.getState()).mappingsByLocalId[localId]?.deleted,
    ).toBe(false);
  });

  it("queues an offline restore of a remotely deleted task, then creates one replacement only after the exact GUID confirms 404", async () => {
    const online = { value: true };
    const stateStore = new MemorySyncStateStore();
    const harness = createHarness({ online, stateStore });
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("restore-after-offline-guid", {
      guid: "restore-after-offline-guid",
      summary: "Restore after an actual remote deletion",
      status: "open",
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "restore-after-offline-guid"
    ];

    remote.tasks.delete("restore-after-offline-guid");
    remote.changePages.set("cursor-1", {
      items: [],
      deletedGuids: ["restore-after-offline-guid"],
      nextCursor: "cursor-2",
      hasMore: false,
    });
    await harness.service.syncNow();
    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      delete task.deletedAt;
      task.sync = { status: "pending" };
    });

    // A network outage must not make capturePendingLocalChanges touch the
    // remote GUID before the service has observed its offline boundary.
    online.value = false;
    const exactRead = vi.spyOn(remote, "getTask");
    const offline = await harness.service.syncNow();
    expect(offline).toMatchObject({
      offline: true,
      issue: { code: "NETWORK_UNAVAILABLE", retryable: true },
    });
    expect(exactRead).not.toHaveBeenCalled();
    expect((await harness.service.getState()).queue).toEqual([
      expect.objectContaining({ localId, kind: "update" }),
    ]);
    const queuedTask = await harness.adapter.getTask(localId, true);
    expect(queuedTask?.deletedAt).toBeUndefined();
    expect(queuedTask).toMatchObject({ sync: { status: "offline" } });

    // Restart with the same durable queue. The exact GUID is still absent,
    // so the first online pass may create one replacement and no duplicate.
    online.value = true;
    const restarted = new FeishuSyncService({
      remote,
      adapter: harness.adapter,
      stateStore,
      connectivity: { isOnline: () => online.value },
      now: () => NOW,
      createId: () => "restore-after-offline-token",
      fullSyncIntervalMs: 60_000,
    });
    const recovered = await restarted.resumeAfterReconnect();
    expect(recovered).toMatchObject({ pushed: 1, offline: false });
    expect(remote.createPayloads).toHaveLength(1);
    expect(await harness.adapter.getTask(localId, true)).toMatchObject({
      source: { externalId: "created-guid-1" },
      sync: { status: "synced" },
    });
    expect((await restarted.getState()).queue).toEqual([]);
  });

  it("preserves a newer local edit made during an update push and sends it automatically", async () => {
    const remote = new DelayedPushRemote();
    const harness = createHarness({ remote });
    const initialDue = "2026-08-12T09:00:00.000Z";
    const firstDue = "2026-08-12T10:00:00.000Z";
    const finalDue = "2026-08-12T11:00:00.000Z";
    remote.tasks.set("race-update-guid", {
      guid: "race-update-guid",
      summary: "Original title",
      description: "Original notes",
      due: { timestamp: String(Date.parse(initialDue)), is_all_day: false },
      status: "open",
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "race-update-guid"
    ];

    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      task.title = "First local title";
      task.dueAt = firstDue;
      task.sync.status = "pending";
    });
    await harness.service.enqueueUpsert(localId);

    const firstRequest = remote.holdNextUpdate();
    const pushing = harness.service.syncNow({ forceFull: true });
    await firstRequest.started;

    // This represents a second TaskService mutation after the first request
    // already captured its outbound payload.
    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      task.title = "Final local title";
      task.dueAt = finalDue;
      task.sync.status = "pending";
    });
    const followUpRequest = remote.holdNextUpdate();
    firstRequest.release();

    // The old confirmation has returned, but the newer fields must remain
    // visible and pending until the automatically queued follow-up is sent.
    await followUpRequest.started;
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      title: "Final local title",
      dueAt: finalDue,
      sync: { status: "pending" },
    });
    expect(harness.stateStore.state?.queue).toHaveLength(1);

    followUpRequest.release();
    const report = await pushing;

    expect(report.pushed).toBe(2);
    expect(remote.patches).toHaveLength(2);
    expect(remote.tasks.get("race-update-guid")).toMatchObject({
      summary: "Final local title",
      due: { timestamp: String(Date.parse(finalDue)), is_all_day: false },
    });
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      title: "Final local title",
      dueAt: finalDue,
      sync: { status: "synced" },
    });
    expect((await harness.service.getState()).queue).toEqual([]);
  });

  it("keeps a newly created task's later edit pending and updates the same remote task", async () => {
    const remote = new DelayedPushRemote();
    const harness = createHarness({ remote });
    const originalDue = "2026-08-13T09:00:00.000Z";
    const finalDue = "2026-08-13T12:00:00.000Z";
    const local = (
      await harness.taskService.createTask({
        source: { type: "feishu", accountId: "account-1" },
        title: "First draft",
        notes: "First notes",
        dueAt: originalDue,
        sync: { status: "pending" },
      })
    ).task;
    await harness.service.enqueueUpsert(local.id);

    const createRequest = remote.holdNextCreate();
    const pushing = harness.service.syncNow({ forceFull: true });
    await createRequest.started;

    await harness.localStore.transact((state) => {
      const task = state.tasks[local.id];
      task.title = "Final draft";
      task.notes = "Final notes";
      task.dueAt = finalDue;
      task.sync.status = "pending";
    });
    const followUpRequest = remote.holdNextUpdate();
    createRequest.release();

    await followUpRequest.started;
    expect(await harness.adapter.getTask(local.id)).toMatchObject({
      title: "Final draft",
      notes: "Final notes",
      dueAt: finalDue,
      source: { externalId: "created-guid-1" },
      sync: { status: "pending" },
    });

    followUpRequest.release();
    const report = await pushing;

    expect(report.pushed).toBe(2);
    expect(remote.createPayloads).toHaveLength(1);
    expect(remote.createPayloads[0]).toMatchObject({
      summary: "First draft",
      description: "First notes",
    });
    expect(remote.patches).toHaveLength(1);
    expect(remote.tasks).toHaveLength(1);
    expect(remote.tasks.get("created-guid-1")).toMatchObject({
      summary: "Final draft",
      description: "Final notes",
      due: { timestamp: String(Date.parse(finalDue)), is_all_day: false },
    });
    expect(await harness.adapter.getTask(local.id)).toMatchObject({
      title: "Final draft",
      notes: "Final notes",
      dueAt: finalDue,
      source: { externalId: "created-guid-1" },
      sync: { status: "synced" },
    });
    expect((await harness.service.getState()).queue).toEqual([]);
  });

  it("captures a pending local completion when Sync now runs before the debounced mutation hook", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("remote-immediate-complete", {
      guid: "remote-immediate-complete",
      summary: "Complete then sync immediately",
      status: "open",
      mode: 2,
      members: [{ id: "ou_current", role: "assignee", type: "user" }],
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "remote-immediate-complete"
    ];

    // TaskService commits the local mutation first and main.ts schedules its
    // queue notification on a debounce. A user can press Sync now in that gap.
    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      task.status = "completed";
      task.completedAt = new Date(NOW).toISOString();
      task.sync.status = "pending";
    });

    const report = await harness.service.syncNow();

    expect(report).toMatchObject({ pushed: 1, offline: false });
    expect(remote.completeCalls).toBe(1);
    expect(remote.tasks.get("remote-immediate-complete")?.status).toBe(
      "completed",
    );
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      status: "completed",
      sync: { status: "synced" },
    });
    expect((await harness.service.getState()).queue).toEqual([]);
  });

  it("settles a new Feishu task trashed before its first create without requeueing it", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const local = (
      await harness.taskService.createTask({
        source: { type: "feishu", accountId: "account-1" },
        title: "Discard before first Feishu create",
        sync: { status: "pending" },
      })
    ).task;

    await harness.localStore.transact((state) => {
      const task = state.tasks[local.id];
      task.deletedAt = new Date(NOW).toISOString();
      task.sync = { status: "pending" };
    });
    await harness.service.enqueueDelete(local.id);

    const first = await harness.service.syncNow({ forceFull: true });

    expect(first).toMatchObject({ deleted: 1, pushed: 0 });
    expect(remote.createPayloads).toEqual([]);
    expect(remote.deleted).toEqual([]);
    expect(await harness.adapter.getTask(local.id, true)).toMatchObject({
      deletedAt: new Date(NOW).toISOString(),
      sync: { status: "synced" },
    });
    expect((await harness.service.getState()).queue).toEqual([]);

    const second = await harness.service.syncNow({ forceFull: true });
    expect(second).toMatchObject({ deleted: 0, pushed: 0 });
    expect((await harness.service.getState()).queue).toEqual([]);

    // Restoring this locally discarded draft is a new explicit create intent,
    // not a blocked "remote-deleted" restore.
    await harness.localStore.transact((state) => {
      const task = state.tasks[local.id];
      delete task.deletedAt;
      task.sync = { status: "pending" };
    });
    const restored = await harness.service.syncNow({ forceFull: true });
    expect(restored).toMatchObject({ pushed: 1, deleted: 0 });
    expect(remote.createPayloads).toHaveLength(1);
    const restoredTask = await harness.adapter.getTask(local.id, true);
    expect(restoredTask).toMatchObject({
      source: { externalId: "created-guid-1" },
      sync: { status: "synced" },
    });
    expect(restoredTask?.deletedAt).toBeUndefined();
  });

  it.each([
    {
      label: "404",
      error: () =>
        new FeishuNotFoundError("task disappeared", { status: 404 }),
      expectedStatus: "remote-deleted",
      expectedDeleted: 1,
      retained: false,
      expectedIssue: undefined,
    },
    {
      label: "permission denial",
      error: () =>
        new FeishuPermissionError("task cannot be completed", { status: 403 }),
      expectedStatus: "permission-denied",
      expectedDeleted: 0,
      retained: true,
      expectedIssue: { code: "PERMISSION_DENIED", retryable: false },
    },
    {
      label: "invalid task parameters",
      error: () => new FeishuApiError("invalid completion", { status: 400 }),
      expectedStatus: "failed",
      expectedDeleted: 0,
      retained: true,
      expectedIssue: { code: "SYNC_FAILED", retryable: false },
    },
  ])(
    "terminates one task's $label failure and continues later queue items",
    async ({ error, expectedStatus, expectedDeleted, retained, expectedIssue }) => {
      const harness = createHarness();
      const remote = harness.remote as FakeRemote;
      for (const index of [1, 2, 3]) {
        remote.tasks.set(`remote-queue-${index}`, {
          guid: `remote-queue-${index}`,
          summary: `Queue task ${index}`,
          status: "open",
          mode: 2,
          members: [{ id: "ou_current", role: "assignee", type: "user" }],
          updated_at: `v${index}`,
        });
      }
      await harness.service.syncNow({ forceFull: true });
      const initialState = await harness.service.getState();
      const localIds = [1, 2, 3].map(
        (index) => initialState.localIdByGuid[`remote-queue-${index}`],
      );
      await harness.localStore.transact((state) => {
        for (const localId of localIds) {
          const task = state.tasks[localId];
          task.status = "completed";
          task.completedAt = new Date(NOW).toISOString();
          task.sync.status = "pending";
        }
      });
      remote.completeErrors.set("remote-queue-1", error());

      const report = await harness.service.syncNow({ forceFull: true });

      expect(report).toMatchObject({
        pushed: 2,
        deleted: expectedDeleted,
        offline: false,
      });
      expect(report.issue).toEqual(expectedIssue);
      expect(remote.completeAttempts).toEqual([
        "remote-queue-1",
        "remote-queue-2",
        "remote-queue-3",
      ]);
      const failedState = await harness.service.getState();
      expect(failedState.queue).toHaveLength(retained ? 1 : 0);
      if (retained) {
        expect(failedState.queue[0]).toMatchObject({
          localId: localIds[0],
          attempts: 1,
        });
        // A terminal item is retained and visible, but no longer prevents the
        // account pull from advancing after the other queue items are sent.
        expect(remote.listAllCalls).toBe(2);
      }
      expect(await harness.adapter.getTask(localIds[0], true)).toMatchObject({
        status: "completed",
        sync: { status: expectedStatus },
      });
      for (const index of [1, 2]) {
        expect(remote.tasks.get(`remote-queue-${index + 1}`)?.status).toBe(
          "completed",
        );
        expect(await harness.adapter.getTask(localIds[index])).toMatchObject({
          status: "completed",
          sync: { status: "synced" },
        });
      }

      await harness.service.syncNow({ forceFull: true });
      // Retained 4xx items are quarantined from automatic retry; a fresh local
      // mutation can explicitly reactivate one.
      expect(remote.completeAttempts).toHaveLength(3);
    },
  );

  it("quarantines a permanent bad item while later pulls advance and a new edit can reactivate it", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("remote-terminal-bad", {
      guid: "remote-terminal-bad",
      summary: "Bad completion",
      status: "open",
      updated_at: "v1",
    });
    remote.tasks.set("remote-pull-after-bad", {
      guid: "remote-pull-after-bad",
      summary: "Remote before",
      status: "open",
      updated_at: "v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const initial = await harness.service.getState();
    const badId = initial.localIdByGuid["remote-terminal-bad"];
    const pulledId = initial.localIdByGuid["remote-pull-after-bad"];
    await harness.localStore.transact((state) => {
      const task = state.tasks[badId];
      task.status = "completed";
      task.completedAt = new Date(NOW).toISOString();
      task.sync = { ...task.sync, status: "pending" };
    });
    remote.completeErrors.set(
      "remote-terminal-bad",
      new FeishuPermissionError("completion denied", { status: 403 }),
    );
    remote.tasks.set("remote-pull-after-bad", {
      ...remote.tasks.get("remote-pull-after-bad")!,
      summary: "Remote changed despite bad queue item",
      updated_at: "v2",
    });

    const failed = await harness.service.syncNow({ forceFull: true });

    expect(failed).toMatchObject({
      pushed: 0,
      pulled: 2,
      issue: { code: "PERMISSION_DENIED", retryable: false },
    });
    expect(remote.completeAttempts).toEqual(["remote-terminal-bad"]);
    expect(await harness.adapter.getTask(pulledId)).toMatchObject({
      title: "Remote changed despite bad queue item",
      sync: { status: "synced" },
    });
    expect((await harness.service.getState()).queue).toEqual([
      expect.objectContaining({
        localId: badId,
        kind: "complete",
        attempts: 1,
        lastError: "PERMISSION_DENIED",
      }),
    ]);

    remote.tasks.set("remote-pull-after-bad", {
      ...remote.tasks.get("remote-pull-after-bad")!,
      summary: "Remote advanced again",
      updated_at: "v3",
    });
    // Recreate the service to prove the quarantine is derived from durable
    // queue data rather than process-only memory.
    let restartedIds = 0;
    const restarted = new FeishuSyncService({
      remote,
      adapter: harness.adapter,
      stateStore: harness.stateStore,
      now: () => NOW,
      createId: () => `restarted-sync-id-${++restartedIds}`,
      fullSyncIntervalMs: 60_000,
    });
    await restarted.syncNow({ forceFull: true });
    expect(remote.completeAttempts).toEqual(["remote-terminal-bad"]);
    expect(await harness.adapter.getTask(pulledId)).toMatchObject({
      title: "Remote advanced again",
    });
    expect((await restarted.getState()).queue[0]).toMatchObject({
      attempts: 1,
      lastError: "PERMISSION_DENIED",
    });

    remote.completeErrors.delete("remote-terminal-bad");
    await restarted.enqueueComplete(badId);
    const reactivated = (await restarted.getState()).queue[0];
    expect(reactivated).toMatchObject({ attempts: 0 });
    expect(reactivated).not.toHaveProperty("lastError");
    const recovered = await restarted.syncNow({ forceFull: true });
    expect(recovered).toMatchObject({ pushed: 1 });
    expect(recovered).not.toHaveProperty("issue");
    expect(remote.completeAttempts).toEqual([
      "remote-terminal-bad",
      "remote-terminal-bad",
    ]);
    expect((await restarted.getState()).queue).toEqual([]);
  });

  it("distinguishes a retryable rate limit from offline work and resumes it later", async () => {
    const waits: number[] = [];
    const harness = createHarness({
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    const remote = harness.remote as FakeRemote;
    const local = (
      await harness.taskService.createTask({
        title: "Rate limited task",
        sync: { status: "pending" },
      })
    ).task;
    await harness.service.enqueueUpsert(local.id);
    remote.rateLimitedCreates = 3;

    const limited = await harness.service.syncNow();

    expect(limited).toMatchObject({
      pushed: 0,
      offline: false,
      issue: { code: "RATE_LIMITED", retryable: true },
    });
    expect(waits).toEqual([40, 40]);
    expect(await harness.adapter.getTask(local.id)).toMatchObject({
      sync: { status: "failed", error: "RATE_LIMITED" },
    });
    expect((await harness.service.getState()).queue).toHaveLength(1);

    remote.rateLimitedCreates = 0;
    const recovered = await harness.service.resumeAfterReconnect();
    expect(recovered).toMatchObject({ pushed: 1 });
    expect(recovered?.issue).toBeUndefined();
    expect(await harness.adapter.getTask(local.id)).toMatchObject({
      sync: { status: "synced" },
    });
  });

  it("reports background polling outcomes to the controller without unhandled failures", async () => {
    let poll: (() => void) | undefined;
    let cleared = false;
    const scheduler: FeishuPollingScheduler = {
      setInterval: (callback) => {
        poll = callback;
        return "poll-handle";
      },
      clearInterval: (handle) => {
        expect(handle).toBe("poll-handle");
        cleared = true;
      },
    };
    const online = { value: false };
    const harness = createHarness({ online, scheduler });
    let resolveReport!: (value: Awaited<ReturnType<typeof harness.service.syncNow>>) => void;
    const report = new Promise<Awaited<ReturnType<typeof harness.service.syncNow>>>(
      (resolve) => {
        resolveReport = resolve;
      },
    );

    harness.service.startPolling(1_000, { onReport: resolveReport });
    expect(poll).toBeTypeOf("function");
    poll!();

    await expect(report).resolves.toMatchObject({
      offline: true,
      issue: { code: "NETWORK_UNAVAILABLE", retryable: true },
    });
    harness.service.stopPolling();
    expect(cleared).toBe(true);
  });

  it("replaces an active polling schedule when the user changes its interval", () => {
    const intervals: number[] = [];
    const cleared: unknown[] = [];
    const scheduler: FeishuPollingScheduler = {
      setInterval: (_callback, milliseconds) => {
        intervals.push(milliseconds);
        return `poll-${intervals.length}`;
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    };
    const harness = createHarness({ scheduler });

    harness.service.startPolling(60_000);
    harness.service.startPolling(60_000);
    expect(intervals).toEqual([60_000]);

    harness.service.startPolling(5 * 60_000);
    expect(cleared).toEqual(["poll-1"]);
    expect(intervals).toEqual([60_000, 5 * 60_000]);

    harness.service.stopPolling();
    expect(cleared).toEqual(["poll-1", "poll-2"]);
  });

  it("persists offline work, resumes after restart, backs off on 429 and never uploads private data", async () => {
    const waits: number[] = [];
    const online = { value: false };
    const stateStore = new MemorySyncStateStore();
    const harness = createHarness({
      stateStore,
      online,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    const local = (
      await harness.taskService.createTask({
        title: "Local public title",
        notes: "Local public notes",
        privateNotes: "DO NOT UPLOAD",
        plannedDate: "2026-08-25",
        tags: ["PRIVATE-TAG"],
        customFields: { agentPlan: "PRIVATE PLAN" },
      })
    ).task;
    const queued = await harness.service.enqueueUpsert(local.id);
    expect(queued.kind).toBe("create");
    const offline = await harness.service.syncNow();
    expect(offline).toMatchObject({
      offline: true,
      issue: { code: "NETWORK_UNAVAILABLE", retryable: true },
    });
    expect(stateStore.state?.queue).toHaveLength(1);
    expect((harness.remote as FakeRemote).createPayloads).toEqual([]);

    // Simulate an application restart with the same durable state/local data.
    online.value = true;
    const remote = harness.remote as FakeRemote;
    remote.rateLimitedCreates = 1;
    const restarted = new FeishuSyncService({
      remote,
      adapter: harness.adapter,
      stateStore,
      connectivity: { isOnline: () => online.value },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      now: () => NOW,
      createId: () => "restart-generated-id",
      fullSyncIntervalMs: 60_000,
    });
    const recovered = await restarted.resumeAfterReconnect();
    expect(recovered).toMatchObject({ pushed: 1, offline: false });
    expect(waits).toEqual([40]);
    expect(remote.createTokens).toEqual([
      queued.clientToken,
      queued.clientToken,
    ]);
    const serializedPayloads = JSON.stringify(remote.createPayloads);
    for (const forbidden of [
      "DO NOT UPLOAD",
      "2026-08-25",
      "PRIVATE-TAG",
      "PRIVATE PLAN",
      "privateNotes",
      "plannedDate",
      "tags",
      "customFields",
    ]) {
      expect(serializedPayloads).not.toContain(forbidden);
    }
    expect(stateStore.state?.queue).toEqual([]);
    const mapped = await harness.adapter.getTask(local.id);
    expect(mapped).toMatchObject({
      privateNotes: "DO NOT UPLOAD",
      plannedDate: "2026-08-25",
      tags: ["PRIVATE-TAG"],
      source: { type: "feishu", accountId: "account-1" },
    });

    await harness.localStore.transact((state) => {
      const task = state.tasks[local.id];
      task.status = "completed";
      task.completedAt = new Date(NOW).toISOString();
      task.sync.status = "pending";
    });
    await restarted.enqueueComplete(local.id);
    await restarted.syncNow();
    expect(remote.completeCalls).toBe(1);
    expect(remote.tasks.values().next().value?.status).toBe("completed");

    await harness.localStore.transact((state) => {
      const task = state.tasks[local.id];
      task.deletedAt = new Date(NOW).toISOString();
      task.sync.status = "pending";
    });
    await restarted.enqueueDelete(local.id);
    await restarted.syncNow();
    expect(remote.tasks.size).toBe(0);
    expect(remote.deleted).toEqual(["created-guid-1"]);
    expect(await harness.adapter.getTask(local.id, true)).toMatchObject({
      sync: { status: "remote-deleted" },
    });
  });

  it("lets the UI resolve conflicts by keeping local, using Feishu, or copying both", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("conflict-guid", {
      guid: "conflict-guid",
      summary: "Base title",
      description: "Base notes",
      status: "open",
      updated_at: "base-version",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "conflict-guid"
    ];

    const makeConflict = async (localTitle: string, remoteTitle: string) => {
      await harness.localStore.transact((state) => {
        const task = state.tasks[localId];
        task.title = localTitle;
        task.privateNotes = "STAYS LOCAL";
        task.sync.status = "pending";
      });
      remote.tasks.set("conflict-guid", {
        ...remote.tasks.get("conflict-guid")!,
        summary: remoteTitle,
        updated_at: `${remoteTitle}-version`,
      });
      await harness.service.enqueueUpsert(localId);
      const report = await harness.service.syncNow();
      expect(report.conflicts[0]?.fields.map((field) => field.field)).toEqual([
        "title",
      ]);
    };

    await makeConflict("Keep this local title", "First remote title");
    await harness.service.resolveConflict(localId, "keep-local");
    await harness.service.syncNow();
    expect(remote.tasks.get("conflict-guid")?.summary).toBe(
      "Keep this local title",
    );

    await makeConflict("Second local title", "Adopt this Feishu title");
    const adopted = await harness.service.resolveConflict(
      localId,
      "use-feishu",
    );
    expect(adopted.task).toMatchObject({
      title: "Adopt this Feishu title",
      privateNotes: "STAYS LOCAL",
      sync: { status: "synced" },
    });

    await makeConflict("Preserve me as a copy", "Original follows Feishu");
    const copied = await harness.service.resolveConflict(localId, "duplicate");
    expect(copied.task.title).toBe("Original follows Feishu");
    expect(copied.duplicate).toMatchObject({
      title: "Preserve me as a copy",
      privateNotes: "STAYS LOCAL",
      source: { type: "local" },
      sync: { status: "local" },
    });
    expect(await harness.service.listConflicts()).toEqual([]);
  });
});

describe("Feishu all-day time synchronization", () => {
  it("imports all-day dates, converts a changed slot to timed, and clears the companion flag", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const initialStart = "2026-08-12T00:00:00.000Z";
    const initialDue = "2026-08-13T00:00:00.000Z";
    const timedStart = "2026-08-12T09:30:00.000Z";
    remote.tasks.set("all-day-guid", {
      guid: "all-day-guid",
      summary: "Remote all-day task",
      start: { timestamp: String(Date.parse(initialStart)), is_all_day: true },
      due: { timestamp: String(Date.parse(initialDue)), is_all_day: true },
      status: "open",
      updated_at: "all-day-v1",
    });

    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "all-day-guid"
    ];
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      startAt: initialStart,
      startAtIsAllDay: true,
      dueAt: initialDue,
      dueAtIsAllDay: true,
    });

    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      task.startAt = timedStart;
      delete task.startAtIsAllDay;
      delete task.dueAt;
      delete task.dueAtIsAllDay;
      task.sync.status = "pending";
    });
    await harness.service.enqueueUpsert(localId);
    await harness.service.syncNow({ forceFull: true });

    expect(remote.patches.at(-1)).toEqual({
      task: {
        start: { timestamp: String(Date.parse(timedStart)), is_all_day: false },
      },
      update_fields: ["start", "due"],
    });
    expect(remote.tasks.get("all-day-guid")).toMatchObject({
      start: { timestamp: String(Date.parse(timedStart)), is_all_day: false },
    });
    expect(remote.tasks.get("all-day-guid")?.due).toBeUndefined();
    const saved = await harness.adapter.getTask(localId);
    expect(saved).toMatchObject({ startAt: timedStart, sync: { status: "synced" } });
    expect(saved?.startAtIsAllDay).toBeUndefined();
    expect(saved?.dueAt).toBeUndefined();
    expect(saved?.dueAtIsAllDay).toBeUndefined();
  });

  it("preserves a newer all-day toggle made while an earlier time update is in flight", async () => {
    const remote = new DelayedPushRemote();
    const harness = createHarness({ remote });
    const start = "2026-08-14T00:00:00.000Z";
    const due = "2026-08-15T00:00:00.000Z";
    remote.tasks.set("all-day-race-guid", {
      guid: "all-day-race-guid",
      summary: "All-day race",
      start: { timestamp: String(Date.parse(start)), is_all_day: false },
      due: { timestamp: String(Date.parse(due)), is_all_day: false },
      status: "open",
      updated_at: "all-day-race-v1",
    });
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "all-day-race-guid"
    ];

    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      task.startAtIsAllDay = true;
      task.sync.status = "pending";
    });
    await harness.service.enqueueUpsert(localId);
    const firstRequest = remote.holdNextUpdate();
    const pushing = harness.service.syncNow({ forceFull: true });
    await firstRequest.started;

    await harness.localStore.transact((state) => {
      const task = state.tasks[localId];
      task.dueAtIsAllDay = true;
      task.sync.status = "pending";
    });
    const followUpRequest = remote.holdNextUpdate();
    firstRequest.release();

    await followUpRequest.started;
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      startAtIsAllDay: true,
      dueAtIsAllDay: true,
      sync: { status: "pending" },
    });

    followUpRequest.release();
    await pushing;

    expect(remote.patches).toEqual([
      {
        task: {
          start: { timestamp: String(Date.parse(start)), is_all_day: true },
        },
        update_fields: ["start"],
      },
      {
        task: {
          due: { timestamp: String(Date.parse(due)), is_all_day: true },
        },
        update_fields: ["due"],
      },
    ]);
    expect(remote.tasks.get("all-day-race-guid")).toMatchObject({
      start: { timestamp: String(Date.parse(start)), is_all_day: true },
      due: { timestamp: String(Date.parse(due)), is_all_day: true },
    });
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      startAtIsAllDay: true,
      dueAtIsAllDay: true,
      sync: { status: "synced" },
    });
  });

  it("creates, queues, updates, and reverse-pulls assignee/follower membership", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const created = (
      await harness.taskService.createTask({
        source: { type: "feishu", accountId: "account-1" },
        title: "Member lifecycle",
        assigneeIds: ["ou_owner", "ou_secondary"],
        followerIds: ["ou_watcher"],
        sync: { status: "pending" },
      })
    ).task;

    const createdReport = await harness.service.syncNow({ forceFull: true });
    expect(createdReport).toMatchObject({ pushed: 1, offline: false });
    expect(remote.createPayloads[0]?.members).toEqual([
      { id: "ou_owner", type: "user", role: "assignee" },
      { id: "ou_secondary", type: "user", role: "assignee" },
      { id: "ou_watcher", type: "user", role: "follower" },
    ]);
    const remoteGuid = (await harness.adapter.getTask(created.id))?.source
      .externalId!;
    expect(remote.tasks.get(remoteGuid)?.members).toEqual(
      remote.createPayloads[0]?.members,
    );

    // This mirrors a normal TaskService member mutation: state is pending
    // before the main-process mutation coordinator reaches enqueueUpsert.
    // syncNow must capture it durably and reconcile through the Task v2
    // member actions, never a collection-replacement PATCH.
    await harness.localStore.transact((state) => {
      const task = state.tasks[created.id];
      task.assigneeIds = ["ou_secondary", "ou_new"];
      task.followerIds = [];
      task.sync.status = "pending";
    });
    const updatedReport = await harness.service.syncNow({ forceFull: true });
    expect(updatedReport).toMatchObject({ pushed: 1, offline: false });
    expect(remote.patches).toEqual([]);
    expect(remote.memberAdds.at(-1)).toEqual([
      { id: "ou_new", type: "user", role: "assignee" },
    ]);
    expect(remote.memberRemoves.at(-1)).toEqual([
      { id: "ou_owner", type: "user", role: "assignee" },
      { id: "ou_watcher", type: "user", role: "follower" },
    ]);
    expect(remote.tasks.get(remoteGuid)?.members).toEqual([
      { id: "ou_secondary", type: "user", role: "assignee" },
      { id: "ou_new", type: "user", role: "assignee" },
    ]);
    expect(await harness.adapter.getTask(created.id)).toMatchObject({
      assigneeIds: ["ou_new", "ou_secondary"],
      followerIds: [],
      sync: { status: "synced" },
    });
    expect((await harness.service.getState()).queue).toEqual([]);

    remote.tasks.set(remoteGuid, {
      ...remote.tasks.get(remoteGuid)!,
      members: [
        { id: "ou_remote_owner", type: "user", role: "assignee" },
        { id: "ou_remote_watch", type: "user", role: "follower" },
      ],
      updated_at: "members-from-feishu",
    });
    const pulledReport = await harness.service.syncNow({ forceFull: true });
    expect(pulledReport).toMatchObject({ pulled: 1, offline: false });
    expect(await harness.adapter.getTask(created.id)).toMatchObject({
      assigneeIds: ["ou_remote_owner"],
      followerIds: ["ou_remote_watch"],
      sync: { status: "synced" },
    });
    expect(
      (await harness.service.getState()).mappingsByLocalId[created.id]?.base,
    ).toMatchObject({
      assigneeIds: ["ou_remote_owner"],
      followerIds: ["ou_remote_watch"],
    });
  });
});

describe("Feishu Task v2 tasklist synchronization", () => {
  it("pulls an unambiguous provider binding without overwriting local organization", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("tasklist-pull-guid", {
      guid: "tasklist-pull-guid",
      summary: "Remote tasklist binding",
      status: "open",
      updated_at: "tasklist-v1",
    });
    remote.tasklistsByGuid.set("tasklist-pull-guid", [
      { tasklist_guid: "tasklist-a", section_guid: "section-a" },
    ]);

    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "tasklist-pull-guid"
    ];
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      source: {
        tasklist: { tasklistGuid: "tasklist-a", sectionGuid: "section-a" },
      },
    });

    await harness.localStore.transact((state) => {
      const task = state.tasks[localId]!;
      task.projectId = "personal-project";
      task.listId = "local-list-name";
      task.sectionId = "local-section-name";
    });
    remote.tasklistsByGuid.set("tasklist-pull-guid", [
      { tasklist_guid: "tasklist-b", section_guid: "section-b" },
    ]);
    remote.tasks.set("tasklist-pull-guid", {
      ...remote.tasks.get("tasklist-pull-guid")!,
      updated_at: "tasklist-v2",
    });

    await harness.service.syncNow({ forceFull: true });
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      source: {
        tasklist: { tasklistGuid: "tasklist-b", sectionGuid: "section-b" },
      },
      projectId: "personal-project",
      listId: "local-list-name",
      sectionId: "local-section-name",
    });
  });

  it("uses only an explicit source.tasklist binding on create and cross-list move", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const local = (
      await harness.taskService.createTask({
        source: {
          type: "feishu",
          accountId: "account-1",
          tasklist: { tasklistGuid: "tasklist-a", sectionGuid: "section-a" },
        },
        title: "Explicit tasklist only",
        projectId: "local-project",
        listId: "local-list-name",
        sectionId: "local-section-name",
        sync: { status: "pending" },
      })
    ).task;

    await harness.service.syncNow({ forceFull: true });
    const remoteGuid = (await harness.adapter.getTask(local.id))?.source.externalId!;
    expect(remote.tasklistsByGuid.get(remoteGuid)).toEqual([
      { tasklist_guid: "tasklist-a", section_guid: "section-a" },
    ]);
    expect(remote.tasklistActions).toEqual([
      { kind: "add", taskGuid: remoteGuid, tasklistGuid: "tasklist-a" },
    ]);
    expect(await harness.adapter.getTask(local.id)).toMatchObject({
      projectId: "local-project",
      listId: "local-list-name",
      sectionId: "local-section-name",
    });

    await harness.localStore.transact((state) => {
      const task = state.tasks[local.id]!;
      task.source = {
        ...task.source,
        tasklist: { tasklistGuid: "tasklist-b", sectionGuid: "section-b" },
      };
      task.sync.status = "pending";
    });
    await harness.service.syncNow({ forceFull: true });

    expect(remote.tasklistsByGuid.get(remoteGuid)).toEqual([
      { tasklist_guid: "tasklist-b", section_guid: "section-b" },
    ]);
    expect(remote.tasklistActions).toEqual([
      { kind: "add", taskGuid: remoteGuid, tasklistGuid: "tasklist-a" },
      { kind: "add", taskGuid: remoteGuid, tasklistGuid: "tasklist-b" },
      { kind: "remove", taskGuid: remoteGuid, tasklistGuid: "tasklist-a" },
    ]);
    expect(await harness.adapter.getTask(local.id)).toMatchObject({
      source: {
        tasklist: { tasklistGuid: "tasklist-b", sectionGuid: "section-b" },
      },
      projectId: "local-project",
      listId: "local-list-name",
      sectionId: "local-section-name",
      sync: { status: "synced" },
    });
  });

  it("never treats free-form project/list/section metadata as a Feishu tasklist", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    const local = (
      await harness.taskService.createTask({
        source: { type: "feishu", accountId: "account-1" },
        title: "Keep local organization local",
        projectId: "project-not-a-tasklist-guid",
        listId: "list-not-a-tasklist-guid",
        sectionId: "section-not-a-tasklist-guid",
        sync: { status: "pending" },
      })
    ).task;

    await harness.service.syncNow({ forceFull: true });
    const saved = await harness.adapter.getTask(local.id);
    const remoteGuid = saved?.source.externalId!;
    expect(remote.tasklistActions).toEqual([]);
    expect(remote.tasklistsByGuid.get(remoteGuid)).toBeUndefined();
    expect(JSON.stringify(remote.createPayloads)).not.toContain(
      "project-not-a-tasklist-guid",
    );
    expect(JSON.stringify(remote.createPayloads)).not.toContain(
      "list-not-a-tasklist-guid",
    );
    expect(JSON.stringify(remote.createPayloads)).not.toContain(
      "section-not-a-tasklist-guid",
    );
    expect(saved).toMatchObject({
      projectId: "project-not-a-tasklist-guid",
      listId: "list-not-a-tasklist-guid",
      sectionId: "section-not-a-tasklist-guid",
    });
  });

  it("surfaces divergent explicit tasklist bindings as a conflict without writing either side", async () => {
    const harness = createHarness();
    const remote = harness.remote as FakeRemote;
    remote.tasks.set("tasklist-conflict-guid", {
      guid: "tasklist-conflict-guid",
      summary: "Tasklist conflict",
      status: "open",
      updated_at: "tasklist-conflict-v1",
    });
    remote.tasklistsByGuid.set("tasklist-conflict-guid", [
      { tasklist_guid: "tasklist-base" },
    ]);
    await harness.service.syncNow({ forceFull: true });
    const localId = (await harness.service.getState()).localIdByGuid[
      "tasklist-conflict-guid"
    ];
    await harness.localStore.transact((state) => {
      const task = state.tasks[localId]!;
      task.source = {
        ...task.source,
        tasklist: { tasklistGuid: "tasklist-local" },
      };
      task.sync.status = "pending";
    });
    remote.tasklistsByGuid.set("tasklist-conflict-guid", [
      { tasklist_guid: "tasklist-remote" },
    ]);
    remote.tasks.set("tasklist-conflict-guid", {
      ...remote.tasks.get("tasklist-conflict-guid")!,
      updated_at: "tasklist-conflict-v2",
    });

    const report = await harness.service.syncNow({ forceFull: true });
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.fields).toEqual([
      {
        field: "tasklist",
        base: { tasklistGuid: "tasklist-base" },
        local: { tasklistGuid: "tasklist-local" },
        remote: { tasklistGuid: "tasklist-remote" },
      },
    ]);
    expect(remote.tasklistActions).toEqual([]);
    expect(await harness.adapter.getTask(localId)).toMatchObject({
      source: { tasklist: { tasklistGuid: "tasklist-local" } },
      sync: { status: "conflict" },
    });
  });

  it("keeps an explicit tasklist write queued and asks for reauthorization on missing scope", async () => {
    class TasklistWriteDeniedRemote extends FakeRemote {
      override async addTaskToTasklist(
        _taskGuid: string,
        _tasklist: FeishuTasklistMembership,
      ): Promise<FeishuTaskV2> {
        throw new FeishuTasklistPermissionError("write", { status: 403 });
      }
    }
    const remote = new TasklistWriteDeniedRemote();
    const harness = createHarness({ remote });
    const local = (
      await harness.taskService.createTask({
        source: {
          type: "feishu",
          accountId: "account-1",
          tasklist: { tasklistGuid: "tasklist-requires-scope" },
        },
        title: "Tasklist needs scope",
        sync: { status: "pending" },
      })
    ).task;

    const report = await harness.service.syncNow({ forceFull: true });
    expect(report.issue).toMatchObject({
      code: "PERMISSION_DENIED",
      retryable: false,
      message: expect.stringContaining("task:tasklist:write"),
    });
    expect((await harness.service.getState()).queue).toHaveLength(1);
    expect(await harness.adapter.getTask(local.id)).toMatchObject({
      sync: { status: "permission-denied", error: "PERMISSION_DENIED" },
    });
  });

  it("keeps the created GUID when a later tasklist mutation fails, so a retry updates instead of creating a duplicate", async () => {
    class FirstTasklistWriteDeniedRemote extends FakeRemote {
      addAttempts = 0;

      override async addTaskToTasklist(
        taskGuid: string,
        tasklist: FeishuTasklistMembership,
      ): Promise<FeishuTaskV2> {
        this.addAttempts += 1;
        if (this.addAttempts === 1) {
          throw new FeishuTasklistPermissionError("write", { status: 403 });
        }
        return super.addTaskToTasklist(taskGuid, tasklist);
      }
    }
    const remote = new FirstTasklistWriteDeniedRemote();
    const harness = createHarness({ remote });
    const local = (
      await harness.taskService.createTask({
        source: {
          type: "feishu",
          accountId: "account-1",
          tasklist: { tasklistGuid: "tasklist-retry-after-create" },
        },
        title: "Persist GUID before tasklist retry",
        sync: { status: "pending" },
      })
    ).task;

    const first = await harness.service.syncNow({ forceFull: true });
    expect(first.issue).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(remote.createPayloads).toHaveLength(1);
    expect(remote.tasks).toHaveLength(1);
    expect(await harness.adapter.getTask(local.id, true)).toMatchObject({
      source: { externalId: "created-guid-1" },
      sync: { status: "permission-denied" },
    });
    expect(
      (await harness.service.getState()).mappingsByLocalId[local.id],
    ).toMatchObject({ guid: "created-guid-1" });

    // Reauthorization/user retry explicitly reactivates the quarantined 403;
    // background polling alone must not issue the same denied write forever.
    await harness.service.enqueueUpsert(local.id);
    const retried = await harness.service.syncNow({ forceFull: true });
    expect(retried).toMatchObject({ pushed: 1, offline: false });
    expect(remote.createPayloads).toHaveLength(1);
    expect(remote.tasks).toHaveLength(1);
    expect(remote.tasklistActions).toEqual([
      {
        kind: "add",
        taskGuid: "created-guid-1",
        tasklistGuid: "tasklist-retry-after-create",
      },
    ]);
    expect(await harness.adapter.getTask(local.id, true)).toMatchObject({
      source: {
        externalId: "created-guid-1",
        tasklist: { tasklistGuid: "tasklist-retry-after-create" },
      },
      sync: { status: "synced" },
    });
  });

  it("continues a pull when tasklist read scope is missing and reports how to reauthorize", async () => {
    class TasklistReadDeniedRemote extends FakeRemote {
      override async listTasklists(
        _taskGuid: string,
      ): Promise<FeishuTasklistMembership[]> {
        throw new FeishuTasklistPermissionError("read", { status: 403 });
      }
    }
    const remote = new TasklistReadDeniedRemote();
    remote.tasks.set("tasklist-read-denied", {
      guid: "tasklist-read-denied",
      summary: "Still import ordinary task fields",
      status: "open",
      updated_at: "tasklist-read-v1",
    });
    const harness = createHarness({ remote });

    const report = await harness.service.syncNow({ forceFull: true });
    expect(report).toMatchObject({
      pulled: 1,
      issue: {
        code: "PERMISSION_DENIED",
        retryable: false,
        message: expect.stringContaining("task:tasklist:read"),
      },
    });
    const localId = (await harness.service.getState()).localIdByGuid[
      "tasklist-read-denied"
    ];
    const local = await harness.adapter.getTask(localId);
    expect(local).toMatchObject({
      title: "Still import ordinary task fields",
      sync: { status: "synced" },
    });
    expect(local?.source.tasklist).toBeUndefined();
  });
});

describe("FeishuSyncService with the real HTTP client", () => {
  it("recovers a queued create through the client 401 refresh path", async () => {
    const localStore = new MemoryLocalStore();
    const taskService = new MemoryTaskService(localStore, () => NOW);
    const adapter = new FeishuTaskAdapter({
      taskService,
      localStore,
      accountId: "account-http",
      now: () => NOW,
    });
    const local = (
      await taskService.createTask({
        title: "HTTP-created task",
        privateNotes: "HTTP PRIVATE",
        plannedDate: "2026-09-01",
      })
    ).task;
    const auth: FeishuAuthConfig = {
      mode: "local-development",
      clientId: "cli_test",
      clientSecret: "dev-secret",
      redirectUri: "http://127.0.0.1/callback",
      acknowledgeInsecureLocalCredentials: true,
    };
    let storedToken: FeishuTokenSet | undefined = {
      accessToken: "expired-by-server",
      refreshToken: "refresh-old",
      tokenType: "Bearer",
      scope: [],
      expiresAt: NOW + 3_600_000,
    };
    let swaps = 0;
    const tokenStore: FeishuTokenStore = {
      read: async () => storedToken && clone(storedToken),
      compareAndSwap: async (expected, next) => {
        swaps += 1;
        if (storedToken?.refreshToken !== expected) return false;
        storedToken = clone(next);
        return true;
      },
    };
    const authorizations: string[] = [];
    let createBody: Record<string, unknown> | undefined;
    const client = new FeishuClient({
      auth,
      tokenStore,
      now: () => NOW,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/authen/v2/oauth/token")) {
          return new Response(
            JSON.stringify({
              code: 0,
              access_token: "refreshed-access",
              refresh_token: "refresh-rotated",
              token_type: "Bearer",
              expires_in: 7_200,
            }),
            { status: 200 },
          );
        }
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        authorizations.push(authorization);
        if (init?.method === "POST") {
          if (authorization.includes("expired-by-server")) {
            return new Response(JSON.stringify({ code: 401, msg: "expired" }), {
              status: 401,
            });
          }
          createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                task: {
                  guid: "http-created-guid",
                  summary: "HTTP-created task",
                  status: "open",
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  guid: "http-created-guid",
                  summary: "HTTP-created task",
                  status: "open",
                },
              ],
              has_more: false,
            },
          }),
          { status: 200 },
        );
      },
    });
    const service = new FeishuSyncService({
      remote: client,
      adapter,
      stateStore: new MemorySyncStateStore(),
      now: () => NOW,
      createId: (() => {
        let id = 0;
        return () => `http-sync-${++id}`;
      })(),
    });

    await service.enqueueUpsert(local.id);
    await expect(service.syncNow({ forceFull: true })).resolves.toMatchObject({
      pushed: 1,
      offline: false,
    });
    expect(authorizations.slice(0, 2)).toEqual([
      "Bearer expired-by-server",
      "Bearer refreshed-access",
    ]);
    expect(swaps).toBe(1);
    expect(storedToken?.refreshToken).toBe("refresh-rotated");
    expect(JSON.stringify(createBody)).not.toContain("HTTP PRIVATE");
    expect(JSON.stringify(createBody)).not.toContain("2026-09-01");
  });
});
