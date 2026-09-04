import { randomUUID } from 'node:crypto';

import type { FeishuTasklistBinding, Task } from '../../src/shared/models';
import { hasTaskTitle } from '../../src/shared/task-title';
import type {
  FeishuFieldConflict,
  FeishuSyncOperationKind,
  FeishuSyncedTaskField,
  FeishuTaskApi,
  FeishuTaskSyncSnapshot,
  FeishuTaskV2,
} from '../../src/shared/feishu-types';
import {
  FeishuApiError,
  FeishuAuthenticationError,
  FeishuNetworkError,
  FeishuNotFoundError,
  FeishuPermissionError,
  FeishuRateLimitError,
  FeishuTasklistPermissionError,
} from './feishu-client';
import {
  buildFeishuTaskMemberMutations,
  chunkFeishuTaskMembers,
  FEISHU_TASK_MEMBER_ADD_BATCH_SIZE,
  FEISHU_TASK_MEMBER_REMOVE_BATCH_SIZE,
  FeishuTaskDataError,
  hasKnownFeishuTaskMembers,
  localTaskToFeishuSnapshot,
  remoteTaskToFeishuSnapshot,
  threeWayMergeFeishuTask,
} from './sync-engine';
import { FeishuTaskAdapter } from './feishu-task-adapter';
import {
  feishuTasklistBindingsEqual,
  tasklistMembershipFromBinding,
} from './tasklist-binding';

export type FeishuApplicationQueueKind =
  | FeishuSyncOperationKind
  | 'complete'
  | 'reopen';

export interface FeishuApplicationQueueItem {
  id: string;
  localId: string;
  kind: FeishuApplicationQueueKind;
  clientToken?: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface FeishuTaskMapping {
  localId: string;
  guid: string;
  base: FeishuTaskSyncSnapshot;
  remoteVersion?: string;
  deleted?: boolean;
}

export interface FeishuApplicationConflict {
  localId: string;
  guid: string;
  base: FeishuTaskSyncSnapshot;
  local: FeishuTaskSyncSnapshot;
  remote: FeishuTaskSyncSnapshot;
  fields: FeishuFieldConflict[];
  remoteVersion?: string;
  detectedAt: string;
}

export interface FeishuApplicationSyncState {
  schemaVersion: 1;
  accountId: string;
  /** Opaque authorized-user/app binding. Missing only on legacy state. */
  syncIdentityId?: string;
  mappingsByLocalId: Record<string, FeishuTaskMapping>;
  localIdByGuid: Record<string, string>;
  queue: FeishuApplicationQueueItem[];
  conflicts: Record<string, FeishuApplicationConflict>;
  cursor?: string;
  lastIncrementalSyncAt?: string;
  lastFullSyncAt?: string;
}

/** LocalStore-like persistence is injected; implementations should write atomically. */
export interface FeishuApplicationStateStore {
  load(): Promise<FeishuApplicationSyncState | undefined>;
  save(state: FeishuApplicationSyncState): Promise<void>;
}

export interface FeishuTaskChangePage {
  items: FeishuTaskV2[];
  deletedGuids: string[];
  nextCursor?: string;
  hasMore: boolean;
  cursorInvalid?: boolean;
}

/**
 * Task v2 remains the source of truth. Incremental methods can be backed by a
 * relay event log; if absent or expired the service falls back to a full list.
 */
export interface FeishuApplicationRemoteApi extends FeishuTaskApi {
  listTaskChanges?(options: {
    cursor: string;
    pageSize: number;
  }): Promise<FeishuTaskChangePage>;
  getCurrentSyncCursor?(): Promise<string>;
}

export interface FeishuConnectivityPort {
  isOnline(): boolean | Promise<boolean>;
}

export interface FeishuPollingScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * A deliberately small, sanitized summary of a run-level problem. Provider
 * response text is intentionally not included here: the desktop controller
 * owns the user-facing, stable wording.
 */
export type FeishuSyncIssueCode =
  | 'NETWORK_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'SYNC_FAILED';

export interface FeishuSyncIssue {
  code: FeishuSyncIssueCode;
  retryable: boolean;
  /** A stable, non-provider remediation instruction when one is available. */
  message?: string;
}

/** Lets the desktop controller reflect background polling honestly. */
export interface FeishuPollingCallbacks {
  onReport?(report: FeishuSyncRunReport): void;
  onError?(error: unknown): void;
}

export interface FeishuSyncServiceOptions {
  remote: FeishuApplicationRemoteApi;
  adapter: FeishuTaskAdapter;
  stateStore: FeishuApplicationStateStore;
  syncIdentityId?: string;
  connectivity?: FeishuConnectivityPort;
  scheduler?: FeishuPollingScheduler;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  createId?: () => string;
  pageSize?: number;
  maxBackoffRetries?: number;
  baseBackoffMs?: number;
  fullSyncIntervalMs?: number;
}

export interface FeishuSyncRunOptions {
  forceFull?: boolean;
}

export interface FeishuSyncRunReport {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: FeishuApplicationConflict[];
  offline: boolean;
  usedFullSync: boolean;
  cursor?: string;
  /** Present when the run retained work or could not reach Feishu. */
  issue?: FeishuSyncIssue;
  /** Incomplete items are isolated; retain the cursor so a later pull retries them. */
  skippedInvalidTasks?: number;
}

export type FeishuConflictDecision =
  | 'keep-local'
  | 'use-feishu'
  | 'duplicate';

type FeishuPushResult =
  | {
      outcome: 'pushed';
      /** A local edit happened while this request was in flight. */
      followUpKind?: FeishuApplicationQueueKind;
    }
  | { outcome: 'conflict' }
  | { outcome: 'deleted' };

export interface FeishuConflictResolutionResult {
  decision: FeishuConflictDecision;
  task: Task;
  duplicate?: Task;
}

export class FeishuSyncCursorExpiredError extends Error {
  constructor(message = 'The incremental Feishu sync cursor has expired.') {
    super(message);
    this.name = 'FeishuSyncCursorExpiredError';
  }
}

const clone = <Value>(value: Value): Value => structuredClone(value);

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const defaultScheduler: FeishuPollingScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function emptyState(
  accountId: string,
  syncIdentityId?: string,
): FeishuApplicationSyncState {
  return {
    schemaVersion: 1,
    accountId,
    ...(syncIdentityId === undefined ? {} : { syncIdentityId }),
    mappingsByLocalId: {},
    localIdByGuid: {},
    queue: [],
    conflicts: {},
  };
}

function snapshotTimestamp(value: string | undefined, isAllDay = false):
  | { timestamp: string; is_all_day: boolean }
  | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? { timestamp: String(timestamp), is_all_day: isAllDay === true }
    : undefined;
}

function remoteFromSnapshot(
  guid: string,
  value: FeishuTaskSyncSnapshot,
  now: number,
  remoteVersion?: string,
): FeishuTaskV2 {
  const members =
    value.assigneeIds === undefined && value.followerIds === undefined
      ? undefined
      : [
          ...(value.assigneeIds ?? []).map((id) => ({
            id,
            type: 'user' as const,
            role: 'assignee' as const,
          })),
          ...(value.followerIds ?? []).map((id) => ({
            id,
            type: 'user' as const,
            role: 'follower' as const,
          })),
        ];
  const tasklist = tasklistMembershipFromBinding(value.tasklist);
  return {
    guid,
    summary: value.title,
    description: value.notes,
    start: snapshotTimestamp(value.startAt, value.startAtIsAllDay),
    due: snapshotTimestamp(value.dueAt, value.dueAtIsAllDay),
    ...(members === undefined ? {} : { members }),
    ...(value.tasklist === undefined
      ? {}
      : { tasklists: tasklist ? [tasklist] : [] }),
    status: value.status,
    completed_at: value.status === 'completed' ? String(now) : undefined,
    updated_at: remoteVersion,
  };
}

/**
 * Task v2 responses may omit `members` on a partial confirmation. Omission
 * must not erase an already-confirmed membership base: the next full task
 * read can still refresh it, while a successful member PATCH keeps its known
 * local/merged value for conflict detection.
 */
function retainKnownMemberSnapshot(
  snapshot: FeishuTaskSyncSnapshot,
  fallback: FeishuTaskSyncSnapshot,
): FeishuTaskSyncSnapshot {
  return {
    ...snapshot,
    ...(snapshot.assigneeIds === undefined && fallback.assigneeIds !== undefined
      ? { assigneeIds: clone(fallback.assigneeIds) }
      : {}),
    ...(snapshot.followerIds === undefined && fallback.followerIds !== undefined
      ? { followerIds: clone(fallback.followerIds) }
      : {}),
  };
}

/**
 * Restores one provider-owned field from an earlier snapshot while retaining
 * every unrelated value from the target. Time and all-day flags form one
 * atomic slot, just like the three-way merge layer.
 */
function copySnapshotField(
  target: FeishuTaskSyncSnapshot,
  source: FeishuTaskSyncSnapshot,
  field: FeishuSyncedTaskField,
): void {
  if (field === 'tasklist') {
    if (source.tasklist === undefined) delete target.tasklist;
    else target.tasklist = clone(source.tasklist);
    return;
  }
  if (field === 'assigneeIds' || field === 'followerIds') {
    if (source[field] === undefined) delete target[field];
    else target[field] = clone(source[field]);
    return;
  }
  if (field === 'startAt' || field === 'dueAt') {
    if (source[field] === undefined) delete target[field];
    else target[field] = source[field];
    const allDayField =
      field === 'startAt' ? 'startAtIsAllDay' : 'dueAtIsAllDay';
    if (source[allDayField] === true) target[allDayField] = true;
    else delete target[allDayField];
    return;
  }
  if (field === 'title') {
    target.title = source.title;
  } else if (field === 'notes') {
    target.notes = source.notes;
  } else {
    target.status = source.status;
  }
}

function isBackoffError(error: unknown): boolean {
  return (
    error instanceof FeishuRateLimitError ||
    (error instanceof FeishuApiError &&
      error.status !== undefined &&
      error.status >= 500 &&
      error.status <= 599)
  );
}

function isOfflineError(error: unknown): boolean {
  return (
    error instanceof FeishuNetworkError ||
    error instanceof FeishuRateLimitError ||
    (error instanceof FeishuApiError && error.retryable)
  );
}

function isNetworkUnavailableError(error: unknown): boolean {
  return (
    error instanceof FeishuNetworkError ||
    (error instanceof FeishuApiError &&
      error.retryable &&
      !(error instanceof FeishuRateLimitError))
  );
}

/**
 * Keep operational state machine errors separate from raw provider messages.
 * This is shared by queue draining and pull failures so a terminal permission
 * error can never be represented as an "offline" retry.
 */
export function classifyFeishuSyncIssue(error: unknown): FeishuSyncIssue {
  if (error instanceof FeishuTaskDataError) {
    return { code: 'SYNC_FAILED', retryable: false, message: error.message };
  }
  if (error instanceof FeishuTasklistPermissionError) {
    return {
      code: 'PERMISSION_DENIED',
      retryable: false,
      message: `飞书清单权限不足。请在应用后台启用 ${error.requiredScope} 后重新授权，再重试同步。`,
    };
  }
  if (error instanceof FeishuPermissionError) {
    return { code: 'PERMISSION_DENIED', retryable: false };
  }
  if (error instanceof FeishuAuthenticationError) {
    return { code: 'AUTH_REQUIRED', retryable: true };
  }
  if (error instanceof FeishuRateLimitError) {
    return { code: 'RATE_LIMITED', retryable: true };
  }
  if (isNetworkUnavailableError(error)) {
    return { code: 'NETWORK_UNAVAILABLE', retryable: true };
  }
  return { code: 'SYNC_FAILED', retryable: false };
}

function tasklistPermissionError(
  error: unknown,
  access: 'read' | 'write',
): unknown {
  if (error instanceof FeishuTasklistPermissionError) return error;
  if (
    error instanceof FeishuPermissionError ||
    (error instanceof FeishuApiError && error.status === 403)
  ) {
    return new FeishuTasklistPermissionError(access, {
      status: error.status,
      code: error.code,
      cause: error,
    });
  }
  return error;
}

function recordSyncIssue(
  report: FeishuSyncRunReport,
  issue: FeishuSyncIssue,
): void {
  // Do not hide an actionable, terminal error behind a later retryable one.
  if (!report.issue || (report.issue.retryable && !issue.retryable)) {
    report.issue = issue;
  }
}

function isTerminalItemError(error: unknown): boolean {
  if (error instanceof FeishuTaskDataError) return true;
  if (error instanceof FeishuPermissionError) return true;
  if (error instanceof FeishuAuthenticationError) return false;
  if (error instanceof FeishuNotFoundError) return false;
  if (isOfflineError(error)) return false;
  return (
    error instanceof FeishuApiError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * A terminal 4xx is retained for repair/inspection, but it is quarantined
 * from automatic retries. The durable attempts/lastError pair intentionally
 * carries this state without a schema migration; an explicit new mutation
 * clears both fields and reactivates the item.
 */
function terminalQueueIssue(
  item: FeishuApplicationQueueItem,
): FeishuSyncIssue | undefined {
  if (item.attempts < 1) return undefined;
  if (item.lastError === 'PERMISSION_DENIED') {
    return { code: 'PERMISSION_DENIED', retryable: false };
  }
  if (item.lastError === 'SYNC_FAILED') {
    return { code: 'SYNC_FAILED', retryable: false };
  }
  return undefined;
}

export class FeishuSyncService {
  private readonly remote: FeishuApplicationRemoteApi;
  private readonly adapter: FeishuTaskAdapter;
  private readonly stateStore: FeishuApplicationStateStore;
  private readonly syncIdentityId?: string;
  private readonly connectivity: FeishuConnectivityPort;
  private readonly scheduler: FeishuPollingScheduler;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly pageSize: number;
  private readonly maxBackoffRetries: number;
  private readonly baseBackoffMs: number;
  private readonly fullSyncIntervalMs: number;
  private state?: FeishuApplicationSyncState;
  private serial: Promise<void> = Promise.resolve();
  private pollingHandle?: unknown;
  private pollingIntervalMs?: number;

  constructor(options: FeishuSyncServiceOptions) {
    this.remote = options.remote;
    this.adapter = options.adapter;
    this.stateStore = options.stateStore;
    this.syncIdentityId = options.syncIdentityId;
    this.connectivity = options.connectivity ?? { isOnline: () => true };
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100));
    this.maxBackoffRetries = Math.max(0, options.maxBackoffRetries ?? 2);
    this.baseBackoffMs = Math.max(0, options.baseBackoffMs ?? 500);
    this.fullSyncIntervalMs = Math.max(
      60_000,
      options.fullSyncIntervalMs ?? 6 * 60 * 60 * 1_000,
    );
  }

  private runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureState(): Promise<FeishuApplicationSyncState> {
    if (this.state) return this.state;
    const loaded = await this.stateStore.load();
    const legacyMatchesLabel =
      loaded?.syncIdentityId === undefined &&
      loaded?.accountId === this.adapter.accountId;
    const boundIdentityMatches =
      this.syncIdentityId !== undefined &&
      loaded?.syncIdentityId === this.syncIdentityId;
    if (
      loaded &&
      loaded.schemaVersion === 1 &&
      (boundIdentityMatches ||
        (this.syncIdentityId === undefined
          ? loaded.accountId === this.adapter.accountId
          : legacyMatchesLabel))
    ) {
      this.state = {
        ...clone(loaded),
        accountId: this.adapter.accountId,
        ...(this.syncIdentityId === undefined
          ? {}
          : { syncIdentityId: this.syncIdentityId }),
      };
      if (
        this.syncIdentityId !== undefined &&
        loaded.syncIdentityId === undefined
      ) {
        await this.adapter.claimLegacyTasks(
          [
            ...Object.keys(loaded.mappingsByLocalId),
            ...loaded.queue.map((item) => item.localId),
            ...Object.keys(loaded.conflicts),
          ],
          this.syncIdentityId,
        );
        await this.stateStore.save(clone(this.state));
      }
      if (boundIdentityMatches) await this.adapter.relabelOwnedTasks();
    } else {
      this.state = emptyState(this.adapter.accountId, this.syncIdentityId);
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    const state = await this.ensureState();
    await this.stateStore.save(clone(state));
  }

  private setMapping(mapping: FeishuTaskMapping): void {
    const state = this.state!;
    const previous = state.mappingsByLocalId[mapping.localId];
    if (previous && previous.guid !== mapping.guid) {
      delete state.localIdByGuid[previous.guid];
    }
    const otherLocalId = state.localIdByGuid[mapping.guid];
    if (otherLocalId && otherLocalId !== mapping.localId) {
      delete state.mappingsByLocalId[otherLocalId];
    }
    state.mappingsByLocalId[mapping.localId] = clone(mapping);
    state.localIdByGuid[mapping.guid] = mapping.localId;
  }

  private async reconcileMappings(): Promise<boolean> {
    const state = await this.ensureState();
    let changed = false;
    for (const task of await this.adapter.listAccountTasks()) {
      const guid = task.source.externalId;
      if (!guid) continue;
      if (
        state.localIdByGuid[guid] === task.id &&
        state.mappingsByLocalId[task.id]
      ) {
        const base = state.mappingsByLocalId[task.id].base;
        if (!hasTaskTitle(task.title) && hasTaskTitle(base.title)) {
          await this.adapter.restoreMissingTitle(task.id, guid, base.title);
        }
        continue;
      }
      // Never manufacture a corrupt merge baseline from a legacy record.
      // A current provider read must supply the missing title first.
      if (!hasTaskTitle(task.title)) continue;
      this.setMapping({
        localId: task.id,
        guid,
        base: localTaskToFeishuSnapshot(task),
        remoteVersion: task.source.remoteVersion,
        deleted: task.sync.status === 'remote-deleted',
      });
      changed = true;
    }
    return changed;
  }

  /**
   * TaskService persists a mutation before the desktop debounce calls one of
   * the notifyLocal* hooks. A manual sync can therefore start while the task is
   * already pending but the durable sync queue is still empty. Capture those
   * mutations here so every sync entry point has the same write semantics.
   */
  private async capturePendingLocalChanges(): Promise<boolean> {
    const state = await this.ensureState();
    let changed = false;
    for (const task of await this.adapter.listAccountTasks()) {
      if (task.sync.status !== 'pending') continue;
      const existing = state.queue.find((item) => item.localId === task.id);
      let mapping = state.mappingsByLocalId[task.id];

      let kind: FeishuApplicationQueueKind;
      if (task.deletedAt) {
        kind = 'delete';
      } else if (!mapping) {
        kind = 'create';
      } else if (mapping.deleted) {
        // A local restore after a confirmed/legacy remote deletion must not
        // decide whether to create a replacement until a sync pass can check
        // the exact old GUID. Queue an update intent durably even while
        // offline; pushUpdate resolves it as either a safe reuse or a fresh
        // idempotent create once network access is available.
        kind = 'update';
      } else if (task.status === 'completed') {
        // A completed pending task must retain an explicit completion intent.
        // Relying only on a reconstructed merge base can otherwise pull the
        // remote open status back over the local write.
        kind = 'complete';
      } else if (existing?.kind === 'reopen' || mapping.base.status === 'completed') {
        kind = 'reopen';
      } else {
        kind = 'update';
      }

      const previousKind = existing?.kind;
      const previousLength = state.queue.length;
      const queued = this.enqueueInState(task.id, kind);
      if (
        previousLength !== state.queue.length ||
        previousKind !== queued.kind
      ) {
        changed = true;
      }
    }
    return changed;
  }

  async initialize(): Promise<FeishuApplicationSyncState> {
    return this.runExclusive(async () => {
      await this.ensureState();
      if (await this.reconcileMappings()) await this.persist();
      return clone(this.state!);
    });
  }

  async getState(): Promise<FeishuApplicationSyncState> {
    return this.runExclusive(async () => clone(await this.ensureState()));
  }

  private enqueueInState(
    localId: string,
    kind: FeishuApplicationQueueKind,
    options: { reactivateTerminal?: boolean } = {},
  ): FeishuApplicationQueueItem {
    const state = this.state!;
    const create = state.queue.find(
      (item) => item.localId === localId && item.kind === 'create',
    );
    if (create && kind !== 'delete') {
      if (options.reactivateTerminal && terminalQueueIssue(create)) {
        create.attempts = 0;
        delete create.lastError;
      }
      return create;
    }

    if (kind === 'delete') {
      state.queue = state.queue.filter((item) => item.localId !== localId);
    } else {
      // Restoring a task before its queued delete is pushed cancels that
      // deletion and replaces it with an upsert.
      state.queue = state.queue.filter(
        (item) => !(item.localId === localId && item.kind === 'delete'),
      );
      const existing = state.queue.find(
        (item) => item.localId === localId && item.kind !== 'delete',
      );
      if (existing) {
        if (terminalQueueIssue(existing) && !options.reactivateTerminal) {
          return existing;
        }
        existing.kind = kind;
        if (options.reactivateTerminal && terminalQueueIssue(existing)) {
          existing.attempts = 0;
          delete existing.lastError;
        }
        return existing;
      }
    }

    const item: FeishuApplicationQueueItem = {
      id: this.createId(),
      localId,
      kind,
      clientToken: kind === 'create' ? this.createId() : undefined,
      createdAt: new Date(this.now()).toISOString(),
      attempts: 0,
    };
    state.queue.push(item);
    return item;
  }

  private async enqueue(
    localId: string,
    requestedKind: FeishuApplicationQueueKind,
  ): Promise<FeishuApplicationQueueItem> {
    await this.ensureState();
    const claimed = await this.adapter.claimTask(localId);
    if (!claimed) {
      throw new Error("Feishu task is not owned by the active authorized identity.");
    }
    const mapping = this.state!.mappingsByLocalId[localId];
    const kind =
      requestedKind === 'update' && !mapping ? 'create' : requestedKind;
    const item = this.enqueueInState(localId, kind, {
      // Calls reaching this method are explicit TaskService notifications or
      // user/API enqueue requests. Unlike capturePendingLocalChanges, they
      // represent a new edit and may safely reactivate a quarantined item.
      reactivateTerminal: true,
    });
    await this.adapter.setSyncStatus(localId, 'pending');
    await this.persist();
    return clone(item);
  }

  async enqueueUpsert(localId: string): Promise<FeishuApplicationQueueItem> {
    return this.runExclusive(() => this.enqueue(localId, 'update'));
  }

  async enqueueDelete(localId: string): Promise<FeishuApplicationQueueItem> {
    return this.runExclusive(() => this.enqueue(localId, 'delete'));
  }

  async enqueueComplete(
    localId: string,
    completed = true,
  ): Promise<FeishuApplicationQueueItem> {
    return this.runExclusive(() =>
      this.enqueue(localId, completed ? 'complete' : 'reopen'),
    );
  }

  /** Names suitable for wiring directly to TaskService mutation events. */
  readonly notifyLocalUpsert = (localId: string) => this.enqueueUpsert(localId);
  readonly notifyLocalDelete = (localId: string) => this.enqueueDelete(localId);
  readonly notifyLocalComplete = (localId: string, completed = true) =>
    this.enqueueComplete(localId, completed);

  private async withBackoff<Result>(operation: () => Promise<Result>): Promise<Result> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isBackoffError(error) || attempt >= this.maxBackoffRetries) throw error;
        const delay =
          error instanceof FeishuApiError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : this.baseBackoffMs * 2 ** attempt;
        await this.sleep(delay);
      }
    }
  }

  private async completeRemoteTitle(remote: FeishuTaskV2): Promise<FeishuTaskV2> {
    if (hasTaskTitle(remote.summary)) return remote;
    // A compact list/action response is not a request to erase the title.
    // Retry only the read, never the successful write that produced it.
    const complete = await this.withBackoff(() => this.remote.getTask(remote.guid));
    if (complete.guid !== remote.guid || !hasTaskTitle(complete.summary)) {
      throw new FeishuTaskDataError();
    }
    return {
      ...complete,
      ...(complete.tasklists === undefined && remote.tasklists !== undefined
        ? { tasklists: remote.tasklists }
        : {}),
    };
  }

  /**
   * Task list membership is not guaranteed on an ordinary Task response.
   * Read it through the dedicated endpoint when available. For pull-only
   * work a missing/denied capability is a safe downgrade: other task fields
   * still sync and the report tells the user how to reauthorize. A requested
   * write must instead remain queued and fail visibly.
   */
  private async enrichTasklists(
    remote: FeishuTaskV2,
    report?: FeishuSyncRunReport,
    required = false,
  ): Promise<FeishuTaskV2> {
    if (remote.tasklists !== undefined) return remote;
    if (!this.remote.listTasklists) {
      if (!required) return remote;
      throw new FeishuTasklistPermissionError('write', { status: 403 });
    }
    try {
      const tasklists = await this.withBackoff(() =>
        this.remote.listTasklists!(remote.guid),
      );
      return { ...remote, tasklists };
    } catch (error) {
      const mapped = tasklistPermissionError(error, required ? 'write' : 'read');
      if (!required && mapped instanceof FeishuTasklistPermissionError) {
        if (report) recordSyncIssue(report, classifyFeishuSyncIssue(mapped));
        return remote;
      }
      throw mapped;
    }
  }

  private async runTasklistWrite<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.withBackoff(operation);
    } catch (error) {
      throw tasklistPermissionError(error, 'write');
    }
  }

  /**
   * Reconciles the one explicit local Tasklist binding without touching any
   * other remote tasklist association. Cross-list moves add first; a section
   * move within the same list removes then adds because add_tasklist is
   * idempotent and cannot safely be assumed to update section placement.
   */
  private async syncTasklistBinding(
    remote: FeishuTaskV2,
    previous: FeishuTasklistBinding | undefined,
    next: FeishuTasklistBinding | undefined,
  ): Promise<FeishuTaskV2> {
    if (previous === undefined && next === undefined) {
      return this.enrichTasklists(remote);
    }
    if (
      !this.remote.listTasklists ||
      !this.remote.addTaskToTasklist ||
      !this.remote.removeTaskFromTasklist
    ) {
      throw new FeishuTasklistPermissionError('write', { status: 403 });
    }

    let current = await this.enrichTasklists(remote, undefined, true);
    if (feishuTasklistBindingsEqual(previous, next)) return current;

    const previousMembership = tasklistMembershipFromBinding(previous);
    const nextMembership = tasklistMembershipFromBinding(next);
    const previousGuid = previousMembership?.tasklist_guid;
    const nextGuid = nextMembership?.tasklist_guid;
    const hasPrevious = (): boolean =>
      Boolean(
        previousGuid &&
          current.tasklists?.some(
            (membership) => membership.tasklist_guid === previousGuid,
          ),
      );
    const sameTasklist = previousGuid !== undefined && previousGuid === nextGuid;
    const sectionChanged =
      sameTasklist &&
      previousMembership?.section_guid !== nextMembership?.section_guid;

    const addNext = async (): Promise<void> => {
      if (!nextMembership) return;
      current = await this.runTasklistWrite(() =>
        this.remote.addTaskToTasklist!(current.guid, nextMembership),
      );
      current = await this.enrichTasklists(current, undefined, true);
    };
    const removePrevious = async (): Promise<void> => {
      if (!previousGuid || !hasPrevious()) return;
      current = await this.runTasklistWrite(() =>
        this.remote.removeTaskFromTasklist!(current.guid, previousGuid),
      );
      current = await this.enrichTasklists(current, undefined, true);
    };

    if (sectionChanged) {
      await removePrevious();
      await addNext();
      return current;
    }
    if (
      nextMembership &&
      !current.tasklists?.some(
        (membership) =>
          membership.tasklist_guid === nextMembership.tasklist_guid &&
          membership.section_guid === nextMembership.section_guid,
      )
    ) {
      await addNext();
    }
    if (previousGuid && previousGuid !== nextGuid) await removePrevious();
    return current;
  }

  private registerConflict(
    localId: string,
    guid: string,
    base: FeishuTaskSyncSnapshot,
    local: FeishuTaskSyncSnapshot,
    remote: FeishuTaskSyncSnapshot,
    fields: FeishuFieldConflict[],
    remoteVersion?: string,
  ): FeishuApplicationConflict {
    const conflict: FeishuApplicationConflict = {
      localId,
      guid,
      base: clone(base),
      local: clone(local),
      remote: clone(remote),
      fields: clone(fields),
      remoteVersion,
      detectedAt: new Date(this.now()).toISOString(),
    };
    this.state!.conflicts[localId] = conflict;
    return conflict;
  }

  private async pushCreate(
    item: FeishuApplicationQueueItem,
    task: Task,
  ): Promise<FeishuPushResult> {
    const expectedLocalSnapshot = localTaskToFeishuSnapshot(task);
    const clientToken = item.clientToken ?? this.createId();
    item.clientToken = clientToken;
    let remote = await this.withBackoff(() =>
      this.remote.createTask(this.adapter.toCreatePayload(task), clientToken),
    );

    // A Task v2 create can succeed before a following completion/tasklist
    // request fails. Persist the real GUID immediately, while the local task
    // still remains pending. Feishu's client_token idempotency window is only
    // temporary; after a restart or a later retry, a durable mapping makes us
    // PATCH this exact task instead of accidentally POSTing a second one.
    // A compact POST response can contain only the new GUID. Checkpoint the
    // submitted values as pending intent in that case, then GET the exact
    // task before marking it synced. Persisting the GUID before that read
    // also prevents a duplicate POST after a network failure or restart.
    const createConfirmationSnapshot = hasTaskTitle(remote.summary)
      ? remoteTaskToFeishuSnapshot(remote)
      : { ...expectedLocalSnapshot, status: 'open' as const, tasklist: undefined };
    const createdSnapshot = clone(createConfirmationSnapshot);
    // A Task v2 create request has no tasklist membership field. When this
    // create intends to add an explicit binding, the just-created remote task
    // therefore has a known empty base even if its compact response omits the
    // tasklists collection. Recording that fact prevents a retry after a
    // failed add_tasklist from being misclassified as a concurrent conflict.
    if (
      expectedLocalSnapshot.tasklist !== undefined &&
      createdSnapshot.tasklist === undefined
    ) {
      createdSnapshot.tasklist = {};
    }
    const created = await this.adapter.applyRemoteAfterPush(
      task.id,
      remote,
      expectedLocalSnapshot,
      {
        // Do not apply the mapping-only known-empty tasklist below yet: the
        // local task may carry the user's explicit add-tasklist intent, which
        // still has to be sent after this checkpoint.
        snapshot: createConfirmationSnapshot,
        status: 'pending',
      },
    );
    this.setMapping({
      localId: task.id,
      guid: remote.guid,
      base: createdSnapshot,
      remoteVersion: remote.updated_at,
      deleted: false,
    });
    delete this.state!.conflicts[task.id];
    await this.persist();

    // A user can trash the task while the create request is in flight. The
    // mapping above is still essential so a following delete addresses the
    // newly-created remote task, but no further public mutations should be
    // issued from this older create intent.
    if (created.locallyDeleted) {
      return { outcome: 'pushed', followUpKind: 'delete' };
    }

    remote = await this.completeRemoteTitle(remote);

    // Subsequent confirmation must compare against the local state produced
    // by the durable create checkpoint, not the pre-create object. The
    // checkpoint may have filled provider-owned metadata (for example the
    // exact GUID or a known empty tasklist) without representing a newer user
    // mutation that should cause an unnecessary second push.
    const expectedAfterCreate = localTaskToFeishuSnapshot(created.task);
    // If a user edited the task while the create POST was in flight, the
    // checkpoint deliberately preserved those fields locally. Keep comparing
    // the final confirmation against the original pre-create values for just
    // those fields, so the final confirmation cannot overwrite the newer
    // local edit before its follow-up PATCH is queued.
    const expectedForFinal = clone(expectedAfterCreate);
    for (const field of created.preservedLocalFields) {
      copySnapshotField(expectedForFinal, expectedLocalSnapshot, field);
    }

    if (task.status === 'completed') {
      remote = await this.withBackoff(() => this.remote.completeTask(remote.guid));
    }
    remote = await this.syncTasklistBinding(
      remote,
      undefined,
      expectedLocalSnapshot.tasklist,
    );
    remote = await this.completeRemoteTitle(remote);
    const confirmed = retainKnownMemberSnapshot(
      remoteTaskToFeishuSnapshot(remote),
      createdSnapshot,
    );
    const applied = await this.adapter.applyRemoteAfterPush(
      task.id,
      remote,
      expectedForFinal,
      {
        snapshot: confirmed,
        status: 'synced',
      },
    );
    this.setMapping({
      localId: task.id,
      guid: remote.guid,
      base: confirmed,
      remoteVersion: remote.updated_at,
    });
    delete this.state!.conflicts[task.id];
    const preservedLocalFields = [
      ...new Set([
        ...created.preservedLocalFields,
        ...applied.preservedLocalFields,
      ]),
    ];
    return {
      outcome: 'pushed',
      followUpKind: this.followUpKindForPreservedLocalChange(
        applied.task,
        preservedLocalFields,
        applied.locallyDeleted,
      ),
    };
  }

  private followUpKindForPreservedLocalChange(
    task: Task,
    preservedLocalFields: readonly FeishuSyncedTaskField[],
    locallyDeleted: boolean,
  ): FeishuApplicationQueueKind | undefined {
    if (!locallyDeleted && preservedLocalFields.length === 0) return undefined;
    if (task.deletedAt) return 'delete';
    if (preservedLocalFields.includes('status')) {
      return task.status === 'completed' ? 'complete' : 'reopen';
    }
    return 'update';
  }

  private async pushUpdate(
    item: FeishuApplicationQueueItem,
    task: Task,
  ): Promise<FeishuPushResult> {
    const mapping = this.state!.mappingsByLocalId[task.id];
    if (!mapping) return this.pushCreate(item, task);

    let remote: FeishuTaskV2;
    try {
      remote = await this.withBackoff(() => this.remote.getTask(mapping.guid));
    } catch (error) {
      const isNotFound =
        error instanceof FeishuNotFoundError ||
        (error instanceof FeishuApiError && error.status === 404);
      if (!isNotFound) throw error;

      // Restoring a local tombstone is an explicit request to have a usable
      // task again. Do not create a duplicate pre-emptively: this exact read
      // is the only authoritative proof that the previous GUID is gone. Once
      // it is a 404, create one replacement with the queue item's stable
      // client token. A historical false deletion instead reaches the normal
      // successful GET path below and reuses the original GUID.
      if (mapping.deleted && !task.deletedAt) {
        return this.pushCreate(item, task);
      }
      mapping.deleted = true;
      await this.adapter.markRemoteDeleted(task.id, mapping.guid);
      return { outcome: 'deleted' };
    }

    remote = await this.enrichTasklists(remote);
    const local = localTaskToFeishuSnapshot(task);
    const rawRemoteSnapshot = remoteTaskToFeishuSnapshot(remote);
    const remoteSnapshot = retainKnownMemberSnapshot(
      rawRemoteSnapshot,
      mapping.base,
    );
    const merge = threeWayMergeFeishuTask(mapping.base, local, remoteSnapshot);
    if (merge.conflicts.length > 0) {
      this.registerConflict(
        task.id,
        mapping.guid,
        mapping.base,
        local,
        remoteSnapshot,
        merge.conflicts,
        remote.updated_at,
      );
      await this.adapter.setSyncStatus(task.id, 'conflict', {
        error: 'The task changed locally and in Feishu.',
        conflictFields: merge.conflicts.map((conflict) => conflict.field),
      });
      return { outcome: 'conflict' };
    }

    const patch = this.adapter.toPatchPayload(merge.merged, merge.localChanges);
    if (patch) {
      remote = await this.withBackoff(() =>
        this.remote.updateTask(mapping.guid, patch),
      );
    }
    if (item.kind === 'complete') {
      remote = await this.withBackoff(() =>
        this.remote.completeTask(mapping.guid),
      );
    } else if (item.kind === 'reopen') {
      remote = await this.withBackoff(() =>
        this.remote.reopenTask(mapping.guid),
      );
    } else if (merge.localChanges.includes('status')) {
      remote =
        merge.merged.status === 'completed'
          ? await this.withBackoff(() => this.remote.completeTask(mapping.guid))
          : await this.withBackoff(() => this.remote.reopenTask(mapping.guid));
    }

    const memberChanges = merge.localChanges.some(
      (field) => field === 'assigneeIds' || field === 'followerIds',
    );
    if (memberChanges) {
      // Task v2 intentionally uses add_members/remove_members actions for
      // membership. Do not calculate a removal from a partial GET response.
      let currentMembers = rawRemoteSnapshot;
      if (!hasKnownFeishuTaskMembers(currentMembers)) {
        remote = await this.withBackoff(() => this.remote.getTask(mapping.guid));
        currentMembers = remoteTaskToFeishuSnapshot(remote);
      }
      if (!hasKnownFeishuTaskMembers(currentMembers)) {
        throw new FeishuApiError(
          'Feishu did not return the task member collection needed for a safe update.',
        );
      }
      const mutations = buildFeishuTaskMemberMutations(
        currentMembers,
        merge.merged,
      );
      for (const batch of chunkFeishuTaskMembers(
        mutations.add,
        FEISHU_TASK_MEMBER_ADD_BATCH_SIZE,
      )) {
        remote = await this.withBackoff(() =>
          this.remote.addTaskMembers(mapping.guid, batch),
        );
      }
      for (const batch of chunkFeishuTaskMembers(
        mutations.remove,
        FEISHU_TASK_MEMBER_REMOVE_BATCH_SIZE,
      )) {
        remote = await this.withBackoff(() =>
          this.remote.removeTaskMembers(mapping.guid, batch),
        );
      }

      // Both membership action responses and ordinary PATCH responses can be
      // partial. Confirm a complete collection before advancing the durable
      // merge base, otherwise a later pull could wrongly treat it as empty.
      remote = await this.withBackoff(() => this.remote.getTask(mapping.guid));
      if (!hasKnownFeishuTaskMembers(remoteTaskToFeishuSnapshot(remote))) {
        throw new FeishuApiError(
          'Feishu did not confirm task members after the update; sync remains pending.',
        );
      }
    }

    if (merge.localChanges.includes('tasklist')) {
      remote = await this.syncTasklistBinding(
        remote,
        mapping.base.tasklist,
        merge.merged.tasklist,
      );
    } else {
      remote = await this.enrichTasklists(remote);
    }

    remote = await this.completeRemoteTitle(remote);
    const confirmed = retainKnownMemberSnapshot(
      remoteTaskToFeishuSnapshot(remote),
      memberChanges ? merge.merged : remoteSnapshot,
    );
    const applied = await this.adapter.applyRemoteAfterPush(
      task.id,
      remote,
      local,
      {
        snapshot: confirmed,
        status: 'synced',
      },
    );
    this.setMapping({
      ...mapping,
      base: confirmed,
      remoteVersion: remote.updated_at ?? mapping.remoteVersion,
      deleted: false,
    });
    delete this.state!.conflicts[task.id];
    return {
      outcome: 'pushed',
      followUpKind: this.followUpKindForPreservedLocalChange(
        applied.task,
        applied.preservedLocalFields,
        applied.locallyDeleted,
      ),
    };
  }

  private async pushDelete(
    task: Task,
  ): Promise<FeishuPushResult> {
    const mapping = this.state!.mappingsByLocalId[task.id];
    if (!mapping) {
      // The task was discarded before its first create request completed, so
      // there is no remote GUID to delete. Mark this local tombstone settled;
      // otherwise capturePendingLocalChanges would enqueue the same no-op
      // delete forever on every automatic sync pass.
      await this.adapter.markUncreatedDeletionSynced(task.id);
      return { outcome: 'deleted' };
    }

    try {
      await this.withBackoff(() => this.remote.deleteTask(mapping.guid));
    } catch (error) {
      if (!(error instanceof FeishuNotFoundError)) throw error;
    }
    mapping.deleted = true;
    await this.adapter.markRemoteDeleted(task.id, mapping.guid);
    return { outcome: 'deleted' };
  }

  private async pushItem(
    item: FeishuApplicationQueueItem,
  ): Promise<FeishuPushResult> {
    const task = await this.adapter.getTask(item.localId, true);
    if (!task) return { outcome: 'deleted' };
    if (item.kind === 'delete') return this.pushDelete(task);
    if (item.kind === 'create') {
      // A previous create POST may already have returned a GUID before a
      // later step failed. Resume against that mapping rather than relying on
      // a client_token whose provider idempotency window may have expired.
      const mapping = this.state!.mappingsByLocalId[item.localId];
      if (mapping && !mapping.deleted) return this.pushUpdate(item, task);
      return this.pushCreate(item, task);
    }
    return this.pushUpdate(item, task);
  }

  private async markFailure(
    item: FeishuApplicationQueueItem,
    error: unknown,
  ): Promise<{
    disposition: 'drop-and-continue' | 'retain-and-continue' | 'stop';
    remoteDeleted: boolean;
    issue?: FeishuSyncIssue;
  }> {
    item.attempts += 1;
    let status: Task['sync']['status'] = 'failed';
    const mapping = this.state!.mappingsByLocalId[item.localId];
    const notFound =
      error instanceof FeishuNotFoundError ||
      (error instanceof FeishuApiError && error.status === 404);
    const permissionDenied =
      error instanceof FeishuPermissionError ||
      (error instanceof FeishuApiError && error.status === 403);
    const issue = notFound ? undefined : classifyFeishuSyncIssue(error);
    // Queue/task state is durable and may later be exported. Keep a stable,
    // non-provider summary here rather than raw response text.
    item.lastError = notFound ? 'REMOTE_NOT_FOUND' : issue!.code;

    if (notFound) {
      status = 'remote-deleted';
      if (mapping) {
        mapping.deleted = true;
        await this.adapter.markRemoteDeleted(item.localId, mapping.guid);
      } else {
        await this.adapter.setSyncStatus(item.localId, status, {
          error: item.lastError,
        });
      }
    } else if (permissionDenied) status = 'permission-denied';
    else if (error instanceof FeishuAuthenticationError) status = 'failed';
    else if (isNetworkUnavailableError(error)) status = 'offline';

    if (!notFound) {
      await this.adapter.setSyncStatus(item.localId, status, {
        error: item.lastError,
      });
    }
    return {
      disposition: notFound
        ? 'drop-and-continue'
        : isTerminalItemError(error)
          ? 'retain-and-continue'
          : 'stop',
      remoteDeleted: notFound,
      issue,
    };
  }

  private async drainQueue(
    report: FeishuSyncRunReport,
  ): Promise<{ stopped: boolean; retainedItemFailures: boolean }> {
    const state = this.state!;
    let retainedItemFailures = false;
    for (const item of state.queue) {
      const issue = terminalQueueIssue(item);
      if (!issue) continue;
      retainedItemFailures = true;
      recordSyncIssue(report, issue);
    }
    // A newer local mutation can arrive while a network request is in flight.
    // A guarded confirmation replaces the completed item with a fresh item;
    // process that fresh item in this run rather than waiting for the next poll.
    // Failed items retain their id and are visited only once per run.
    const visitedItemIds = new Set<string>();
    for (;;) {
      const item = state.queue.find(
        (candidate) =>
          !visitedItemIds.has(candidate.id) && !terminalQueueIssue(candidate),
      );
      if (!item) break;
      visitedItemIds.add(item.id);
      try {
        const result = await this.pushItem(item);
        if (result.outcome === 'pushed') {
          report.pushed += 1;
        } else if (result.outcome === 'deleted') {
          report.deleted += 1;
        }
        state.queue = state.queue.filter((candidate) => candidate.id !== item.id);
        if (result.outcome === 'pushed' && result.followUpKind) {
          const latest = await this.adapter.getTask(item.localId, true);
          if (latest) {
            this.enqueueInState(
              item.localId,
              latest.deletedAt ? 'delete' : result.followUpKind,
            );
          }
        }
        await this.persist();
      } catch (error) {
        const disposition = await this.markFailure(item, error);
        if (disposition.issue) recordSyncIssue(report, disposition.issue);
        if (disposition.disposition === 'drop-and-continue') {
          if (disposition.remoteDeleted) report.deleted += 1;
          state.queue = state.queue.filter(
            (candidate) => candidate.id !== item.id,
          );
          await this.persist();
          continue;
        }
        if (disposition.disposition === 'retain-and-continue') {
          retainedItemFailures = true;
          await this.persist();
          continue;
        }
        if (isNetworkUnavailableError(error)) report.offline = true;
        await this.persist();
        return { stopped: true, retainedItemFailures };
      }
    }
    return { stopped: false, retainedItemFailures };
  }

  private async applyRemoteChange(
    incomingRemote: FeishuTaskV2,
    report: FeishuSyncRunReport,
  ): Promise<void> {
    let completeRemote: FeishuTaskV2;
    try {
      completeRemote = await this.completeRemoteTitle(incomingRemote);
    } catch (error) {
      if (!(error instanceof FeishuTaskDataError) &&
          !(error instanceof FeishuNotFoundError) &&
          !(error instanceof FeishuPermissionError)) throw error;
      report.skippedInvalidTasks = (report.skippedInvalidTasks ?? 0) + 1;
      recordSyncIssue(report, classifyFeishuSyncIssue(
        error instanceof FeishuPermissionError ? error : new FeishuTaskDataError(),
      ));
      return;
    }
    const remote = await this.enrichTasklists(completeRemote, report);
    const state = this.state!;
    let localId = state.localIdByGuid[remote.guid];

    if (!localId) {
      const created = await this.adapter.createFromRemote(remote);
      localId = created.id;
      const base = remoteTaskToFeishuSnapshot(remote);
      this.setMapping({
        localId,
        guid: remote.guid,
        base,
        remoteVersion: remote.updated_at,
      });
      delete state.conflicts[localId];
      report.pulled += 1;
      return;
    }

    const mapping = state.mappingsByLocalId[localId] ?? {
      localId,
      guid: remote.guid,
      base: remoteTaskToFeishuSnapshot(remote),
    };
    const hasPendingDelete = state.queue.some(
      (item) => item.localId === localId && item.kind === 'delete',
    );
    const remoteSnapshot = retainKnownMemberSnapshot(
      remoteTaskToFeishuSnapshot(remote),
      mapping.base,
    );
    const retainedItem = state.queue.find(
      (item) => item.localId === localId && terminalQueueIssue(item),
    );
    const retainedIssue = retainedItem
      ? terminalQueueIssue(retainedItem)
      : undefined;
    const merge = await this.adapter.mergeAndApplyRemote(
      localId,
      remote,
      mapping.base,
      remoteSnapshot,
      retainedIssue
        ? {
            localChangesStatus:
              retainedIssue.code === 'PERMISSION_DENIED'
                ? 'permission-denied'
                : 'failed',
            localChangesError: retainedIssue.code,
          }
        : {},
    );

    if (merge.outcome === 'missing') {
      const created = await this.adapter.createFromRemote(remote);
      this.setMapping({
        localId: created.id,
        guid: remote.guid,
        base: remoteSnapshot,
        remoteVersion: remote.updated_at,
      });
      delete state.conflicts[localId];
      report.pulled += 1;
      return;
    }
    if (merge.outcome === 'locally-deleted') {
      if (!hasPendingDelete) this.enqueueInState(localId, 'delete');
      return;
    }
    if (merge.outcome === 'conflict') {
      const conflict = this.registerConflict(
        localId,
        remote.guid,
        mapping.base,
        merge.local,
        remoteSnapshot,
        merge.conflicts,
        remote.updated_at,
      );
      report.conflicts.push(clone(conflict));
      return;
    }

    this.setMapping({
      ...mapping,
      guid: remote.guid,
      base: remoteSnapshot,
      remoteVersion: remote.updated_at,
      deleted: false,
    });
    delete state.conflicts[localId];
    if (merge.localChanges.length > 0) this.enqueueInState(localId, 'update');
    report.pulled += 1;
  }

  private async applyRemoteDelete(
    guid: string,
    report: FeishuSyncRunReport,
  ): Promise<void> {
    const localId = this.state!.localIdByGuid[guid];
    if (!localId) return;
    const mapping = this.state!.mappingsByLocalId[localId];
    if (mapping) mapping.deleted = true;
    delete this.state!.conflicts[localId];
    this.state!.queue = this.state!.queue.filter(
      (item) => item.localId !== localId,
    );
    await this.adapter.markRemoteDeleted(localId, guid);
    report.deleted += 1;
  }

  private async fullPull(report: FeishuSyncRunReport): Promise<void> {
    report.usedFullSync = true;
    const remotes = await this.withBackoff(() =>
      this.remote.listAllAccessibleTasks
        ? this.remote.listAllAccessibleTasks()
        : this.remote.listAllTasks(),
    );
    for (const remote of remotes) {
      await this.applyRemoteChange(remote, report);
    }

    // Task v2's `type=my_tasks` list is not an authoritative task catalogue:
    // it can omit a task because of membership/permission scope or because a
    // just-created task has not reached that list yet. Absence from that list
    // therefore cannot prove remote deletion. Only an explicit incremental
    // deletion event, or a 404 returned while addressing the exact task, may
    // move a local task into recoverable remote-deleted state.
    if (report.skippedInvalidTasks) delete this.state!.lastFullSyncAt;
    else this.state!.lastFullSyncAt = new Date(this.now()).toISOString();
    if (!report.skippedInvalidTasks && this.remote.getCurrentSyncCursor) {
      this.state!.cursor = await this.withBackoff(() =>
        this.remote.getCurrentSyncCursor!(),
      );
    }
    await this.persist();
  }

  private async incrementalPull(report: FeishuSyncRunReport): Promise<void> {
    const state = this.state!;
    if (!state.cursor || !this.remote.listTaskChanges) {
      await this.fullPull(report);
      return;
    }
    let cursor = state.cursor;
    const seenCursors = new Set<string>([cursor]);

    for (;;) {
      const page = await this.withBackoff(() =>
        this.remote.listTaskChanges!({ cursor, pageSize: this.pageSize }),
      );
      if (page.cursorInvalid) throw new FeishuSyncCursorExpiredError();
      for (const remote of page.items) await this.applyRemoteChange(remote, report);
      for (const guid of page.deletedGuids) {
        await this.applyRemoteDelete(guid, report);
      }
      if (page.nextCursor) {
        if (seenCursors.has(page.nextCursor) && page.hasMore) {
          throw new FeishuSyncCursorExpiredError(
            'The incremental Feishu cursor did not advance.',
          );
        }
        cursor = page.nextCursor;
        seenCursors.add(cursor);
        if (!report.skippedInvalidTasks) state.cursor = cursor;
      }
      if (report.skippedInvalidTasks) delete state.lastFullSyncAt;
      else state.lastIncrementalSyncAt = new Date(this.now()).toISOString();
      await this.persist();
      if (!page.hasMore) return;
      if (!page.nextCursor) {
        throw new FeishuSyncCursorExpiredError(
          'The incremental page has_more flag had no next cursor.',
        );
      }
    }
  }

  private fullSyncDue(forceFull: boolean): boolean {
    const state = this.state!;
    if (forceFull || !state.cursor || !this.remote.listTaskChanges) return true;
    if (!state.lastFullSyncAt) return true;
    return this.now() - Date.parse(state.lastFullSyncAt) >= this.fullSyncIntervalMs;
  }

  async syncNow(options: FeishuSyncRunOptions = {}): Promise<FeishuSyncRunReport> {
    return this.runExclusive(async () => {
      await this.ensureState();
      const mappingsChanged = await this.reconcileMappings();
      const pendingChangesCaptured = await this.capturePendingLocalChanges();
      if (mappingsChanged || pendingChangesCaptured) await this.persist();
      const report: FeishuSyncRunReport = {
        pushed: 0,
        pulled: 0,
        deleted: 0,
        conflicts: [],
        offline: false,
        usedFullSync: false,
        cursor: this.state!.cursor,
      };

      if (!(await this.connectivity.isOnline())) {
        report.offline = true;
        report.issue = { code: 'NETWORK_UNAVAILABLE', retryable: true };
        for (const item of this.state!.queue) {
          await this.adapter.setSyncStatus(item.localId, 'offline', {
            error: 'Offline; change remains queued.',
          });
        }
        await this.persist();
        return report;
      }

      const queueResult = await this.drainQueue(report);
      if (queueResult.stopped) {
        report.cursor = this.state!.cursor;
        report.conflicts = Object.values(this.state!.conflicts).map(clone);
        return report;
      }

      try {
        if (this.fullSyncDue(options.forceFull === true)) {
          await this.fullPull(report);
        } else {
          try {
            await this.incrementalPull(report);
          } catch (error) {
            if (!(error instanceof FeishuSyncCursorExpiredError)) throw error;
            await this.fullPull(report);
          }
        }
      } catch (error) {
        if (!isOfflineError(error)) throw error;
        const issue = classifyFeishuSyncIssue(error);
        recordSyncIssue(report, issue);
        if (issue.code === 'NETWORK_UNAVAILABLE') report.offline = true;
      }
      report.cursor = this.state!.cursor;
      report.conflicts = Object.values(this.state!.conflicts).map(clone);
      return report;
    });
  }

  async listConflicts(): Promise<FeishuApplicationConflict[]> {
    return this.runExclusive(async () =>
      Object.values((await this.ensureState()).conflicts).map(clone),
    );
  }

  async resolveConflict(
    localId: string,
    decision: FeishuConflictDecision,
  ): Promise<FeishuConflictResolutionResult> {
    return this.runExclusive(async () => {
      const state = await this.ensureState();
      const conflict = state.conflicts[localId];
      if (!conflict) throw new Error(`Task ${localId} has no Feishu conflict.`);
      const mapping = state.mappingsByLocalId[localId];
      if (!mapping) throw new Error(`Task ${localId} has no Feishu mapping.`);
      let duplicate: Task | undefined;

      if (decision === 'keep-local') {
        mapping.base = clone(conflict.remote);
        mapping.remoteVersion = conflict.remoteVersion;
        delete state.conflicts[localId];
        this.enqueueInState(localId, 'update');
        await this.adapter.setSyncStatus(localId, 'pending');
      } else {
        if (decision === 'duplicate') {
          duplicate = await this.adapter.duplicateAsLocal(localId);
        }
        await this.adapter.applyRemote(
          localId,
          remoteFromSnapshot(
            conflict.guid,
            conflict.remote,
            this.now(),
            conflict.remoteVersion,
          ),
          { snapshot: conflict.remote, status: 'synced' },
        );
        mapping.base = clone(conflict.remote);
        mapping.remoteVersion = conflict.remoteVersion;
        mapping.deleted = false;
        delete state.conflicts[localId];
        state.queue = state.queue.filter((item) => item.localId !== localId);
      }

      await this.persist();
      const task = await this.adapter.getTask(localId, true);
      if (!task) throw new Error(`Local task ${localId} disappeared.`);
      return { decision, task, duplicate };
    });
  }

  startPolling(
    intervalMs = 60_000,
    callbacks: FeishuPollingCallbacks = {},
  ): void {
    const nextIntervalMs = Math.max(1_000, intervalMs);
    if (this.pollingHandle !== undefined) {
      if (this.pollingIntervalMs === nextIntervalMs) return;
      this.scheduler.clearInterval(this.pollingHandle);
      this.pollingHandle = undefined;
    }
    this.pollingIntervalMs = nextIntervalMs;
    this.pollingHandle = this.scheduler.setInterval(() => {
      void this.syncNow().then(
        (report) => {
          try {
            callbacks.onReport?.(report);
          } catch {
            // Presentation observers must not create an unhandled rejection.
          }
        },
        (error: unknown) => {
          try {
            callbacks.onError?.(error);
          } catch {
            // Presentation observers must not create an unhandled rejection.
          }
        },
      );
    }, nextIntervalMs);
  }

  stopPolling(): void {
    if (this.pollingHandle === undefined) return;
    this.scheduler.clearInterval(this.pollingHandle);
    this.pollingHandle = undefined;
    this.pollingIntervalMs = undefined;
  }

  async resumeAfterReconnect(): Promise<FeishuSyncRunReport | undefined> {
    if (!(await this.connectivity.isOnline())) return undefined;
    return this.syncNow();
  }
}
