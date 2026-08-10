import { randomUUID } from 'node:crypto';

import type { FeishuTasklistBinding, Task } from '../../src/shared/models';
import {
  type FeishuCreateTaskPayload,
  type FeishuFieldConflict,
  type FeishuPatchTaskPayload,
  type FeishuSyncOperationKind,
  type FeishuSyncQueueItem,
  type FeishuSyncQueueStore,
  type FeishuSyncResult,
  type FeishuSyncTaskStore,
  type FeishuSyncedTaskField,
  type FeishuTaskApi,
  type FeishuTaskMember,
  type FeishuTaskSyncSnapshot,
  type FeishuTaskTimestamp,
  type FeishuTaskV2,
  type FeishuThreeWayMergeResult,
  type FeishuSyncFieldValue,
} from '../../src/shared/feishu-types';
import {
  FeishuApiError,
  FeishuConflictError,
  FeishuNetworkError,
  FeishuNotFoundError,
  FeishuPermissionError,
  FeishuRateLimitError,
  FeishuTasklistPermissionError,
} from './feishu-client';
import {
  cloneFeishuTasklistBinding,
  explicitFeishuTasklistBinding,
  feishuTasklistBindingsEqual,
  tasklistBindingFromRemoteTask,
  tasklistMembershipFromBinding,
} from './tasklist-binding';

const SYNCED_FIELDS: readonly FeishuSyncedTaskField[] = [
  'title',
  'notes',
  'startAt',
  'dueAt',
  'status',
  'assigneeIds',
  'followerIds',
  'tasklist',
];

const MEMBER_FIELDS = new Set<FeishuSyncedTaskField>([
  'assigneeIds',
  'followerIds',
]);

// `is_all_day` is not an independent field in Task v2: it changes the
// meaning of the corresponding start/due timestamp. Keep it out of the
// public field list and merge each time slot atomically, so a concurrent
// timestamp edit and an all-day toggle cannot be silently recombined.
const TIME_FIELDS = new Set<FeishuSyncedTaskField>(['startAt', 'dueAt']);

function isTasklistField(field: FeishuSyncedTaskField): field is 'tasklist' {
  return field === 'tasklist';
}

export interface BuildFeishuPayloadOptions {
  /** Optional explicit Feishu open_id; local assignee ids are never guessed. */
  currentUserOpenId?: string;
}

export interface FeishuSyncEngineOptions {
  client: FeishuTaskApi;
  queueStore: FeishuSyncQueueStore;
  taskStore: FeishuSyncTaskStore;
  accountId?: string;
  currentUserOpenId?: string;
  now?: () => number;
  createId?: () => string;
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

function isMemberField(
  field: FeishuSyncedTaskField,
): field is 'assigneeIds' | 'followerIds' {
  return MEMBER_FIELDS.has(field);
}

function isTimeField(
  field: FeishuSyncedTaskField,
): field is 'startAt' | 'dueAt' {
  return TIME_FIELDS.has(field);
}

function allDayKey(
  field: 'startAt' | 'dueAt',
): 'startAtIsAllDay' | 'dueAtIsAllDay' {
  return field === 'startAt' ? 'startAtIsAllDay' : 'dueAtIsAllDay';
}

function isAllDay(
  snapshot: FeishuTaskSyncSnapshot,
  field: 'startAt' | 'dueAt',
): boolean {
  return snapshot[field] !== undefined && snapshot[allDayKey(field)] === true;
}

/**
 * Feishu does not assign semantics to member ordering. Canonicalising the
 * locally persisted representation prevents a harmless provider reorder from
 * producing a spurious conflict or PATCH.
 */
export function canonicalFeishuMemberIds(
  values: readonly string[] | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim()).filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function feishuSyncFieldValuesEqual(
  left: FeishuSyncFieldValue,
  right: FeishuSyncFieldValue,
): boolean {
  if (isTasklistBindingValue(left) || isTasklistBindingValue(right)) {
    if (!isTasklistBindingValue(left) || !isTasklistBindingValue(right)) {
      return false;
    }
    return feishuTasklistBindingsEqual(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function isTasklistBindingValue(
  value: FeishuSyncFieldValue,
): value is FeishuTasklistBinding {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Field equality used by both merge and push-race preservation. Time slots
 * compare their ISO timestamp and `is_all_day` together; every other field
 * retains its existing scalar/member-set comparison semantics.
 */
export function feishuSnapshotFieldsEqual(
  left: FeishuTaskSyncSnapshot,
  right: FeishuTaskSyncSnapshot,
  field: FeishuSyncedTaskField,
): boolean {
  if (
    !feishuSyncFieldValuesEqual(valueOf(left, field), valueOf(right, field))
  ) {
    return false;
  }
  return !isTimeField(field) || isAllDay(left, field) === isAllDay(right, field);
}

/**
 * Feishu represents unset completion timestamps as the string "0". Treat only
 * finite, positive timestamps as present so "0", negative values and malformed
 * API data cannot turn an open task into a completed one.
 */
export function hasPositiveFeishuTimestamp(
  value: string | undefined,
): boolean {
  if (!value?.trim()) return false;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0;
}

/** Feishu has returned both `done` and `completed` across Task v2 surfaces. */
export function isFeishuTaskCompleted(task: FeishuTaskV2): boolean {
  const status = task.status?.trim().toLowerCase();
  return (
    status === 'done' ||
    status === 'completed' ||
    hasPositiveFeishuTimestamp(task.completed_at)
  );
}

function valueOf(
  snapshot: FeishuTaskSyncSnapshot,
  field: FeishuSyncedTaskField,
): FeishuSyncFieldValue {
  return isTasklistField(field) ? snapshot.tasklist : snapshot[field];
}

function assignValue(
  snapshot: FeishuTaskSyncSnapshot,
  field: FeishuSyncedTaskField,
  value: FeishuSyncFieldValue,
): void {
  if (isTasklistField(field)) {
    if (value === undefined) {
      delete snapshot.tasklist;
    } else if (isTasklistBindingValue(value)) {
      snapshot.tasklist = cloneFeishuTasklistBinding(value);
    }
  } else if (isMemberField(field)) {
    if (value === undefined) {
      delete snapshot[field];
    } else {
      snapshot[field] = canonicalFeishuMemberIds(
        Array.isArray(value) ? value : [],
      );
    }
  } else if (field === 'title' || field === 'notes') {
    snapshot[field] = typeof value === 'string' ? value : '';
  } else if (field === 'status') {
    snapshot.status = value === 'completed' ? 'completed' : 'open';
  } else if (value === undefined) {
    delete snapshot[field];
  } else {
    snapshot[field] = typeof value === 'string' ? value : undefined;
  }
}

function assignSnapshotField(
  target: FeishuTaskSyncSnapshot,
  field: FeishuSyncedTaskField,
  source: FeishuTaskSyncSnapshot,
): void {
  assignValue(target, field, valueOf(source, field));
  if (!isTimeField(field)) return;
  const key = allDayKey(field);
  if (isAllDay(source, field)) target[key] = true;
  else delete target[key];
}

function timeConflictMetadata(
  field: FeishuSyncedTaskField,
  base: FeishuTaskSyncSnapshot,
  local: FeishuTaskSyncSnapshot,
  remote: FeishuTaskSyncSnapshot,
): Pick<
  FeishuFieldConflict,
  'baseIsAllDay' | 'localIsAllDay' | 'remoteIsAllDay'
> {
  if (!isTimeField(field)) return {};
  return {
    ...(isAllDay(base, field) ? { baseIsAllDay: true } : {}),
    ...(isAllDay(local, field) ? { localIsAllDay: true } : {}),
    ...(isAllDay(remote, field) ? { remoteIsAllDay: true } : {}),
  };
}

/**
 * Three-way field merge. The base is the last confirmed common snapshot, so a
 * field changed on only one side is safe to propagate. Divergent changes to the
 * same field are surfaced and never silently overwritten.
 */
export function threeWayMergeFeishuTask(
  base: FeishuTaskSyncSnapshot,
  local: FeishuTaskSyncSnapshot,
  remote: FeishuTaskSyncSnapshot,
): FeishuThreeWayMergeResult {
  const merged: FeishuTaskSyncSnapshot = { ...base };
  const localChanges: FeishuSyncedTaskField[] = [];
  const remoteChanges: FeishuSyncedTaskField[] = [];
  const conflicts: FeishuFieldConflict[] = [];

  for (const field of SYNCED_FIELDS) {
    const baseValue = valueOf(base, field);
    const localValue = valueOf(local, field);
    const remoteValue = valueOf(remote, field);

    // A task can be in multiple Task v2 tasklists while the product tracks a
    // single explicit mapping. Undefined therefore means “unknown or
    // ambiguous”, not an empty collection. Never turn it into a local clear.
    if (isTasklistField(field) && remoteValue === undefined) {
      const localChanged = !feishuSyncFieldValuesEqual(localValue, baseValue);
      if (localChanged || (baseValue === undefined && localValue !== undefined)) {
        assignSnapshotField(merged, field, local);
        localChanges.push(field);
      } else {
        assignSnapshotField(merged, field, base);
      }
      continue;
    }

    // Old state predates explicit tasklist snapshots. A remote, unambiguous
    // mapping can safely initialize it, but a newly explicit local mapping
    // that differs from a fetched remote value must be surfaced rather than
    // overwritten during migration.
    if (isTasklistField(field) && baseValue === undefined) {
      if (
        localValue !== undefined &&
        remoteValue !== undefined &&
        !feishuSyncFieldValuesEqual(localValue, remoteValue)
      ) {
        conflicts.push({ field, base: baseValue, local: localValue, remote: remoteValue });
        assignSnapshotField(merged, field, local);
      } else if (remoteValue !== undefined) {
        assignSnapshotField(merged, field, remote);
        if (!feishuSyncFieldValuesEqual(localValue, remoteValue)) {
          remoteChanges.push(field);
        }
      } else {
        assignSnapshotField(merged, field, local);
      }
      continue;
    }

    // State written before member sync has no common membership base. A
    // remote member list is therefore authoritative for that first pass: it
    // avoids falsely treating an old, untouched local copy as a concurrent
    // edit. The next saved base is complete and uses normal three-way rules.
    if (isMemberField(field) && baseValue === undefined) {
      if (remoteValue !== undefined) {
        assignSnapshotField(merged, field, remote);
        if (!feishuSyncFieldValuesEqual(localValue, remoteValue)) remoteChanges.push(field);
      } else {
        // A partial Task v2 response did not include members. Preserve the
        // local value without inventing a remote clear or emitting a PATCH.
        assignSnapshotField(merged, field, local);
      }
      continue;
    }

    // `members` is optional on a Task v2 object. Absence means the response
    // is incomplete, not that every assignee/follower was removed. A local
    // edit can still be pushed safely against a known base, but a pull must
    // never clear memberships from an omitted field.
    if (isMemberField(field) && remoteValue === undefined) {
      const localChanged = !feishuSyncFieldValuesEqual(localValue, baseValue);
      if (localChanged) {
        assignSnapshotField(merged, field, local);
        localChanges.push(field);
      } else {
        assignSnapshotField(merged, field, base);
      }
      continue;
    }

    const localChanged = !feishuSnapshotFieldsEqual(local, base, field);
    const remoteChanged = !feishuSnapshotFieldsEqual(remote, base, field);

    if (
      localChanged &&
      remoteChanged &&
      !feishuSnapshotFieldsEqual(local, remote, field)
    ) {
      conflicts.push({
        field,
        base: baseValue,
        local: localValue,
        remote: remoteValue,
        ...timeConflictMetadata(field, base, local, remote),
      });
      // Preserve the user's local edit while the UI asks for a resolution.
      assignSnapshotField(merged, field, local);
      continue;
    }

    if (localChanged) {
      assignSnapshotField(merged, field, local);
      if (!feishuSnapshotFieldsEqual(local, remote, field)) localChanges.push(field);
      continue;
    }

    if (remoteChanged) {
      assignSnapshotField(merged, field, remote);
      remoteChanges.push(field);
      continue;
    }

    assignSnapshotField(merged, field, base);
  }

  return { merged, localChanges, remoteChanges, conflicts };
}

/** Short alias for callers that do not need the transport name in scope. */
export const threeWayMerge = threeWayMergeFeishuTask;

function timestampToIso(value: FeishuTaskTimestamp | undefined): string | undefined {
  const timestamp = value?.timestamp;
  if (!hasPositiveFeishuTimestamp(timestamp)) return undefined;
  const raw = Number(timestamp);
  // Be lenient with older data that may contain Unix seconds.
  const milliseconds = Math.abs(raw) < 100_000_000_000 ? raw * 1_000 : raw;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isoToTimestamp(
  value: string | undefined,
  isAllDay = false,
): FeishuTaskTimestamp | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return { timestamp: String(milliseconds), is_all_day: isAllDay === true };
}

export function localTaskToFeishuSnapshot(task: Task): FeishuTaskSyncSnapshot {
  const snapshot: FeishuTaskSyncSnapshot = {
    title: task.title,
    notes: task.notes,
    startAt: task.startAt,
    dueAt: task.dueAt,
    status: task.status === 'completed' ? 'completed' : 'open',
    assigneeIds: canonicalFeishuMemberIds(task.assigneeIds),
    followerIds: canonicalFeishuMemberIds(task.followerIds),
  };
  if (task.startAt !== undefined && task.startAtIsAllDay === true) {
    snapshot.startAtIsAllDay = true;
  }
  if (task.dueAt !== undefined && task.dueAtIsAllDay === true) {
    snapshot.dueAtIsAllDay = true;
  }
  const tasklist = explicitFeishuTasklistBinding(task);
  if (tasklist !== undefined) snapshot.tasklist = tasklist;
  return snapshot;
}

function remoteMemberIds(
  task: FeishuTaskV2,
  role: FeishuTaskMember['role'],
): string[] | undefined {
  if (task.members === undefined) return undefined;
  return canonicalFeishuMemberIds(
    task.members
      // The local task schema stores only user IDs. Preserve Task v2 `app`
      // members remotely instead of misidentifying them as users on a later
      // add/remove operation.
      .filter((member) => member.role === role && member.type !== 'app')
      .map((member) => member.id),
  );
}

export function remoteTaskToFeishuSnapshot(
  task: FeishuTaskV2,
): FeishuTaskSyncSnapshot {
  const status = isFeishuTaskCompleted(task) ? 'completed' : 'open';
  const startAt = timestampToIso(task.start);
  const dueAt = timestampToIso(task.due);
  const snapshot: FeishuTaskSyncSnapshot = {
    title: task.summary ?? '',
    notes: task.description ?? '',
    startAt,
    dueAt,
    status,
  };
  if (startAt !== undefined && task.start?.is_all_day === true) {
    snapshot.startAtIsAllDay = true;
  }
  if (dueAt !== undefined && task.due?.is_all_day === true) {
    snapshot.dueAtIsAllDay = true;
  }
  const assigneeIds = remoteMemberIds(task, 'assignee');
  const followerIds = remoteMemberIds(task, 'follower');
  if (assigneeIds !== undefined) snapshot.assigneeIds = assigneeIds;
  if (followerIds !== undefined) snapshot.followerIds = followerIds;
  const tasklist = tasklistBindingFromRemoteTask(task);
  if (tasklist !== undefined) snapshot.tasklist = tasklist;
  return snapshot;
}

function memberPayload(
  assigneeIds: readonly string[] | undefined,
  followerIds: readonly string[] | undefined,
): FeishuTaskMember[] {
  return [
    ...canonicalFeishuMemberIds(assigneeIds).map((id) => ({
      id,
      type: 'user' as const,
      role: 'assignee' as const,
    })),
    ...canonicalFeishuMemberIds(followerIds).map((id) => ({
      id,
      type: 'user' as const,
      role: 'follower' as const,
    })),
  ];
}

export interface FeishuTaskMemberMutations {
  /** Member-role pairs that must be added without disturbing other roles. */
  add: FeishuTaskMember[];
  /** Member-role pairs that must be removed after additions have succeeded. */
  remove: FeishuTaskMember[];
}

/** Task v2 permits up to 50 additions and 500 removals per request. */
export const FEISHU_TASK_MEMBER_ADD_BATCH_SIZE = 50;
export const FEISHU_TASK_MEMBER_REMOVE_BATCH_SIZE = 500;

export function chunkFeishuTaskMembers(
  members: readonly FeishuTaskMember[],
  batchSize: number,
): FeishuTaskMember[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('A positive member batch size is required.');
  }
  const batches: FeishuTaskMember[][] = [];
  for (let index = 0; index < members.length; index += batchSize) {
    batches.push(members.slice(index, index + batchSize));
  }
  return batches;
}

/**
 * Returns whether a Task v2 response carried its complete member collection.
 * A missing `members` field is a partial response, not an empty collection,
 * and must never be used as the basis for a destructive removal request.
 */
export function hasKnownFeishuTaskMembers(
  snapshot: FeishuTaskSyncSnapshot,
): boolean {
  return (
    snapshot.assigneeIds !== undefined && snapshot.followerIds !== undefined
  );
}

/**
 * Keeps a last-confirmed member base when a later Task v2 response is partial.
 * This is safe for scalar/status confirmations because they do not mutate
 * membership, and avoids turning an omission into an accidental local clear.
 */
export function retainKnownFeishuTaskMembers(
  snapshot: FeishuTaskSyncSnapshot,
  fallback: FeishuTaskSyncSnapshot,
): FeishuTaskSyncSnapshot {
  return {
    ...snapshot,
    ...(snapshot.assigneeIds === undefined && fallback.assigneeIds !== undefined
      ? { assigneeIds: canonicalFeishuMemberIds(fallback.assigneeIds) }
      : {}),
    ...(snapshot.followerIds === undefined && fallback.followerIds !== undefined
      ? { followerIds: canonicalFeishuMemberIds(fallback.followerIds) }
      : {}),
  };
}

/**
 * Reconciles exact member-role pairs using Task v2's add/remove endpoints.
 * The same person can hold both roles, so identity includes both their id and
 * role. Additions intentionally precede removals at the call site: a role
 * change never leaves the task briefly without its intended responsible user.
 */
export function buildFeishuTaskMemberMutations(
  current: FeishuTaskSyncSnapshot,
  desired: FeishuTaskSyncSnapshot,
): FeishuTaskMemberMutations {
  if (!hasKnownFeishuTaskMembers(current)) {
    throw new Error(
      'Cannot safely update Feishu task members from a partial Task v2 response.',
    );
  }

  const currentMembers = memberPayload(
    current.assigneeIds,
    current.followerIds,
  );
  const desiredMembers = memberPayload(
    desired.assigneeIds,
    desired.followerIds,
  );
  const key = (member: FeishuTaskMember): string =>
    `${member.role}\u0000${member.id}`;
  const currentKeys = new Set(currentMembers.map(key));
  const desiredKeys = new Set(desiredMembers.map(key));

  return {
    add: desiredMembers.filter((member) => !currentKeys.has(key(member))),
    remove: currentMembers.filter((member) => !desiredKeys.has(key(member))),
  };
}

/**
 * Explicit allow-list. In particular, privateNotes, plannedDate, priority,
 * tags, privateOrder, estimates, focus state, local custom fields and Agent
 * plans can never enter a Feishu request through this function.
 */
export function buildFeishuCreatePayload(
  task: Task,
  options: BuildFeishuPayloadOptions = {},
): FeishuCreateTaskPayload {
  const payload: FeishuCreateTaskPayload = {
    summary: task.title,
    description: task.notes,
  };
  const start = isoToTimestamp(task.startAt, task.startAtIsAllDay);
  const due = isoToTimestamp(task.dueAt, task.dueAtIsAllDay);
  if (start) payload.start = start;
  if (due) payload.due = due;
  const assigneeIds = canonicalFeishuMemberIds(task.assigneeIds);
  const members = memberPayload(
    assigneeIds.length > 0
      ? assigneeIds
      : options.currentUserOpenId
        ? [options.currentUserOpenId]
        : [],
    task.followerIds,
  );
  if (members.length > 0) {
    payload.members = members;
  }
  return payload;
}

export function buildFeishuPatchPayload(
  snapshot: FeishuTaskSyncSnapshot,
  changedFields: readonly FeishuSyncedTaskField[],
): FeishuPatchTaskPayload | undefined {
  const task: FeishuPatchTaskPayload['task'] = {};
  const updateFields: string[] = [];

  for (const field of changedFields) {
    if (field === 'title') {
      task.summary = snapshot.title;
      updateFields.push('summary');
    } else if (field === 'notes') {
      task.description = snapshot.notes;
      updateFields.push('description');
    } else if (field === 'startAt') {
      const start = isoToTimestamp(
        snapshot.startAt,
        snapshot.startAtIsAllDay,
      );
      if (start) task.start = start;
      updateFields.push('start');
    } else if (field === 'dueAt') {
      const due = isoToTimestamp(
        snapshot.dueAt,
        snapshot.dueAtIsAllDay,
      );
      if (due) task.due = due;
      updateFields.push('due');
    }
    // Task v2 membership is intentionally excluded from PATCH. It uses the
    // add_members/remove_members actions; see buildFeishuTaskMemberMutations.
    // Completion is handled by Task v2's complete/uncomplete actions.
  }

  return updateFields.length > 0
    ? { task, update_fields: [...new Set(updateFields)] }
    : undefined;
}

function applySnapshot(
  task: Task,
  snapshot: FeishuTaskSyncSnapshot,
  now: () => number,
): Task {
  const completedAt =
    snapshot.status === 'completed'
      ? task.completedAt ?? isoNow(now)
      : undefined;
  const applied: Task = {
    ...task,
    title: snapshot.title,
    notes: snapshot.notes,
    startAt: snapshot.startAt,
    dueAt: snapshot.dueAt,
    ...(snapshot.assigneeIds === undefined
      ? {}
      : { assigneeIds: canonicalFeishuMemberIds(snapshot.assigneeIds) }),
    ...(snapshot.followerIds === undefined
      ? {}
      : { followerIds: canonicalFeishuMemberIds(snapshot.followerIds) }),
    status: snapshot.status,
    completedAt,
    updatedAt: isoNow(now),
  };
  if (snapshot.startAt !== undefined && snapshot.startAtIsAllDay === true) {
    applied.startAtIsAllDay = true;
  } else {
    delete applied.startAtIsAllDay;
  }
  if (snapshot.dueAt !== undefined && snapshot.dueAtIsAllDay === true) {
    applied.dueAtIsAllDay = true;
  } else {
    delete applied.dueAtIsAllDay;
  }
  // Tasklist binding is deliberately independent from generic local
  // list/project metadata. A provider association belongs only in
  // source.tasklist: even a confirmed Feishu GUID must never overwrite,
  // clear, or otherwise reinterpret the user's local list/section fields.
  if (snapshot.tasklist !== undefined) {
    const binding = cloneFeishuTasklistBinding(snapshot.tasklist)!;
    applied.source = { ...applied.source, tasklist: binding };
  }
  return applied;
}

function taskWithSyncStatus(
  task: Task,
  status: Task['sync']['status'],
  now: () => number,
  details: Partial<Task['sync']> = {},
): Task {
  return {
    ...task,
    sync: {
      ...task.sync,
      ...details,
      status,
      ...(status === 'synced' ? { lastSyncedAt: isoNow(now), error: undefined } : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableFeishuSyncError(error: unknown): boolean {
  return (
    error instanceof FeishuNetworkError ||
    error instanceof FeishuRateLimitError ||
    (error instanceof FeishuApiError && error.retryable)
  );
}

export class FeishuSyncEngine {
  private readonly client: FeishuTaskApi;
  private readonly queueStore: FeishuSyncQueueStore;
  private readonly taskStore: FeishuSyncTaskStore;
  private readonly accountId?: string;
  private readonly currentUserOpenId?: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private queue: FeishuSyncQueueItem[] = [];
  private queueLoad?: Promise<void>;
  private queueSerial: Promise<void> = Promise.resolve();
  private drainInFlight?: Promise<FeishuSyncResult[]>;
  private readonly taskTails = new Map<string, Promise<void>>();

  constructor(options: FeishuSyncEngineOptions) {
    this.client = options.client;
    this.queueStore = options.queueStore;
    this.taskStore = options.taskStore;
    this.accountId = options.accountId;
    this.currentUserOpenId = options.currentUserOpenId;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  private async ensureQueue(): Promise<void> {
    if (!this.queueLoad) {
      this.queueLoad = this.queueStore.load().then((items) => {
        this.queue = items.map((item) => ({ ...item }));
      });
    }
    await this.queueLoad;
  }

  private serializeQueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queueSerial.then(operation, operation);
    this.queueSerial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async pendingOperations(): Promise<FeishuSyncQueueItem[]> {
    return this.serializeQueue(async () => {
      await this.ensureQueue();
      return this.queue.map((item) => ({ ...item }));
    });
  }

  async enqueue(
    taskId: string,
    kind: FeishuSyncOperationKind,
    options: { clientToken?: string } = {},
  ): Promise<FeishuSyncQueueItem> {
    return this.serializeQueue(async () => {
      await this.ensureQueue();

      const existing = this.queue.find(
        (item) =>
          item.taskId === taskId &&
          (item.kind === kind || (item.kind === 'create' && kind === 'update')),
      );
      if (existing) return { ...existing };

      if (kind === 'delete') {
        this.queue = this.queue.filter((item) => item.taskId !== taskId);
      }
      const item: FeishuSyncQueueItem = {
        id: this.createId(),
        taskId,
        kind,
        clientToken:
          kind === 'create' ? options.clientToken ?? this.createId() : undefined,
        enqueuedAt: isoNow(this.now),
        attempts: 0,
      };
      this.queue.push(item);
      await this.queueStore.save(this.queue);
      return { ...item };
    });
  }

  private serializeTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskTails.get(taskId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.taskTails.set(taskId, tail);
    void tail.finally(() => {
      if (this.taskTails.get(taskId) === tail) this.taskTails.delete(taskId);
    });
    return result;
  }

  async syncTask(
    taskId: string,
    kind: FeishuSyncOperationKind = 'update',
    clientToken?: string,
  ): Promise<FeishuSyncResult> {
    return this.serializeTask(taskId, async () => {
      const task = await this.taskStore.get(taskId);
      if (!task) throw new Error(`Task ${taskId} does not exist.`);

      const syncing = taskWithSyncStatus(task, 'syncing', this.now);
      await this.taskStore.save(syncing);

      try {
        if (kind === 'delete') return await this.deleteRemoteTask(syncing);
        if (kind === 'create' || !syncing.source.externalId) {
          return await this.createRemoteTask(
            syncing,
            clientToken ?? this.createId(),
          );
        }
        return await this.updateRemoteTask(syncing);
      } catch (error) {
        let status: Task['sync']['status'] = 'failed';
        if (error instanceof FeishuPermissionError) status = 'permission-denied';
        else if (error instanceof FeishuNotFoundError) status = 'remote-deleted';
        else if (error instanceof FeishuConflictError) status = 'conflict';
        else if (isRetryableFeishuSyncError(error)) status = 'offline';
        await this.taskStore.save(
          taskWithSyncStatus(syncing, status, this.now, {
            error: errorMessage(error),
          }),
        );
        throw error;
      }
    });
  }

  private async createRemoteTask(
    task: Task,
    clientToken: string,
  ): Promise<FeishuSyncResult> {
    let remote = await this.client.createTask(
      buildFeishuCreatePayload(task, {
        currentUserOpenId: this.currentUserOpenId,
      }),
      clientToken,
    );
    if (task.status === 'completed') {
      remote = await this.client.completeTask(remote.guid);
    }

    const requestedTasklist = localTaskToFeishuSnapshot(task).tasklist;
    remote = await this.syncTasklistBinding(
      remote,
      undefined,
      requestedTasklist,
    );

    const snapshot = remoteTaskToFeishuSnapshot(remote);
    let saved = applySnapshot(task, snapshot, this.now);
    saved = {
      ...saved,
      source: {
        ...saved.source,
        type: 'feishu',
        accountId: this.accountId ?? saved.source.accountId,
        externalId: remote.guid,
        remoteVersion: remote.updated_at,
      },
    };
    saved = taskWithSyncStatus(saved, 'synced', this.now, {
      conflictFields: undefined,
    });
    await this.taskStore.save(saved);
    await this.taskStore.saveBase(task.id, snapshot);
    return { status: 'synced', task: saved };
  }

  private async updateRemoteTask(task: Task): Promise<FeishuSyncResult> {
    const taskGuid = task.source.externalId;
    if (!taskGuid) throw new Error('A Feishu task guid is required for update.');

    let remote = await this.enrichTasklists(await this.client.getTask(taskGuid));
    const remoteSnapshot = remoteTaskToFeishuSnapshot(remote);
    const base = (await this.taskStore.getBase(task.id)) ?? remoteSnapshot;
    const local = localTaskToFeishuSnapshot(task);
    const merge = threeWayMergeFeishuTask(base, local, remoteSnapshot);

    if (merge.conflicts.length > 0) {
      const conflictTask = taskWithSyncStatus(task, 'conflict', this.now, {
        conflictFields: merge.conflicts.map(({ field }) => field),
        error: 'The task changed locally and in Feishu.',
      });
      await this.taskStore.save(conflictTask);
      return {
        status: 'conflict',
        task: conflictTask,
        conflicts: merge.conflicts,
      };
    }

    const patch = buildFeishuPatchPayload(merge.merged, merge.localChanges);
    if (patch) remote = await this.client.updateTask(taskGuid, patch);
    if (merge.localChanges.includes('status')) {
      remote =
        merge.merged.status === 'completed'
          ? await this.client.completeTask(taskGuid)
          : await this.client.reopenTask(taskGuid);
    }

    const memberChanges = merge.localChanges.some(isMemberField);
    if (memberChanges) {
      // Use the Task v2 member actions rather than PATCH. If the first GET
      // was a partial response, refresh once; we refuse to infer a removal
      // from an unknown collection.
      let currentMembers = remoteSnapshot;
      if (!hasKnownFeishuTaskMembers(currentMembers)) {
        remote = await this.client.getTask(taskGuid);
        currentMembers = remoteTaskToFeishuSnapshot(remote);
      }
      const mutations = buildFeishuTaskMemberMutations(
        currentMembers,
        merge.merged,
      );
      for (const batch of chunkFeishuTaskMembers(
        mutations.add,
        FEISHU_TASK_MEMBER_ADD_BATCH_SIZE,
      )) {
        remote = await this.client.addTaskMembers(taskGuid, batch);
      }
      for (const batch of chunkFeishuTaskMembers(
        mutations.remove,
        FEISHU_TASK_MEMBER_REMOVE_BATCH_SIZE,
      )) {
        remote = await this.client.removeTaskMembers(taskGuid, batch);
      }

      // Action responses can be partial. A full confirmation is necessary
      // before replacing the persisted three-way membership base.
      remote = await this.client.getTask(taskGuid);
      if (!hasKnownFeishuTaskMembers(remoteTaskToFeishuSnapshot(remote))) {
        throw new Error(
          'Feishu did not return task members after updating them; sync was kept pending.',
        );
      }
    }

    if (merge.localChanges.includes('tasklist')) {
      remote = await this.syncTasklistBinding(
        remote,
        base.tasklist,
        merge.merged.tasklist,
      );
    } else {
      remote = await this.enrichTasklists(remote);
    }

    const confirmed = retainKnownFeishuTaskMembers(
      remoteTaskToFeishuSnapshot(remote),
      memberChanges ? merge.merged : remoteSnapshot,
    );
    let saved = applySnapshot(task, confirmed, this.now);
    saved = {
      ...saved,
      source: {
        ...saved.source,
        remoteVersion: remote.updated_at ?? saved.source.remoteVersion,
      },
    };
    saved = taskWithSyncStatus(saved, 'synced', this.now, {
      conflictFields: undefined,
    });
    await this.taskStore.save(saved);
    await this.taskStore.saveBase(task.id, confirmed);
    return { status: 'synced', task: saved };
  }

  /**
   * Fetches the association collection explicitly. A normal Task response is
   * allowed to omit `tasklists`; omission is not evidence of no tasklist.
   */
  private async enrichTasklists(remote: FeishuTaskV2): Promise<FeishuTaskV2> {
    if (remote.tasklists !== undefined) return remote;
    if (!this.client.listTasklists) return remote;
    const tasklists = await this.client.listTasklists(remote.guid);
    return { ...remote, tasklists };
  }

  /**
   * Applies one explicitly-owned binding while preserving every unrelated
   * remote tasklist. A move to another list adds first, then removes the old
   * known list; a section move in the same list removes then adds because
   * add_tasklist is idempotent and cannot be assumed to relocate sections.
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
      !this.client.listTasklists ||
      !this.client.addTaskToTasklist ||
      !this.client.removeTaskFromTasklist
    ) {
      throw new FeishuTasklistPermissionError('write', { status: 403 });
    }
    let current = await this.enrichTasklists(remote);
    if (feishuTasklistBindingsEqual(previous, next)) return current;

    const previousMembership = tasklistMembershipFromBinding(previous);
    const nextMembership = tasklistMembershipFromBinding(next);
    const hasMembership = (tasklistGuid: string | undefined): boolean =>
      Boolean(
        tasklistGuid &&
          current.tasklists?.some(
            (membership) => membership.tasklist_guid === tasklistGuid,
          ),
      );
    const previousGuid = previousMembership?.tasklist_guid;
    const nextGuid = nextMembership?.tasklist_guid;
    const sameTasklist = previousGuid !== undefined && previousGuid === nextGuid;
    const sectionChanged =
      sameTasklist &&
      previousMembership?.section_guid !== nextMembership?.section_guid;

    const addNext = async (): Promise<void> => {
      if (!nextMembership) return;
      current = await this.client.addTaskToTasklist!(
        current.guid,
        nextMembership,
      );
      current = await this.enrichTasklists(current);
    };
    const removePrevious = async (): Promise<void> => {
      if (!previousGuid || !hasMembership(previousGuid)) return;
      current = await this.client.removeTaskFromTasklist!(current.guid, previousGuid);
      current = await this.enrichTasklists(current);
    };

    if (sectionChanged) {
      await removePrevious();
      await addNext();
      return current;
    }

    if (nextMembership && !hasMembership(nextGuid)) await addNext();
    if (previousGuid && previousGuid !== nextGuid) await removePrevious();
    return current;
  }

  private async deleteRemoteTask(task: Task): Promise<FeishuSyncResult> {
    if (task.source.externalId) {
      await this.client.deleteTask(task.source.externalId);
    }
    const deleted = taskWithSyncStatus(task, 'remote-deleted', this.now, {
      tombstone: {
        deletedAt: task.deletedAt ?? isoNow(this.now),
        confirmedAt: isoNow(this.now),
      },
    });
    await this.taskStore.save(deleted);
    return { status: 'deleted', task: deleted };
  }

  private async updateQueuedFailure(id: string, error: unknown): Promise<void> {
    await this.serializeQueue(async () => {
      await this.ensureQueue();
      const item = this.queue.find((candidate) => candidate.id === id);
      if (!item) return;
      item.attempts += 1;
      item.lastError = errorMessage(error);
      await this.queueStore.save(this.queue);
    });
  }

  private async removeQueuedItem(id: string): Promise<void> {
    await this.serializeQueue(async () => {
      await this.ensureQueue();
      const next = this.queue.filter((item) => item.id !== id);
      if (next.length === this.queue.length) return;
      this.queue = next;
      await this.queueStore.save(this.queue);
    });
  }

  /**
   * Replays persisted operations in order. Any failure remains durably queued;
   * the drain stops so an offline app does not spin or reorder later mutations.
   */
  async drain(): Promise<FeishuSyncResult[]> {
    if (this.drainInFlight) return this.drainInFlight;
    const run = (async (): Promise<FeishuSyncResult[]> => {
      const results: FeishuSyncResult[] = [];
      const items = await this.pendingOperations();
      for (const item of items) {
        try {
          const result = await this.syncTask(
            item.taskId,
            item.kind,
            item.clientToken,
          );
          results.push(result);
          await this.removeQueuedItem(item.id);
        } catch (error) {
          await this.updateQueuedFailure(item.id, error);
          break;
        }
      }
      return results;
    })();
    this.drainInFlight = run;
    try {
      return await run;
    } finally {
      if (this.drainInFlight === run) this.drainInFlight = undefined;
    }
  }
}
