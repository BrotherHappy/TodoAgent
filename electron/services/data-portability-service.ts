import { createHash, randomUUID } from 'node:crypto';

import type { AuditRecord } from '../../src/shared/agent-types';
import type {
  LocalAppState,
  Task,
  TaskDraft,
  TaskOperation,
} from '../../src/shared/models';
import {
  defaultSettings,
  FLOATING_HOVER_EXPAND_DELAY_MAX_MS,
  FLOATING_HOVER_EXPAND_DELAY_MIN_MS,
  type AppSettings,
} from '../../src/shared/settings';

export const PORTABLE_DATA_FORMAT = 'todo-agent-portable-data' as const;
export type ExportRedaction = 'none' | 'private' | 'strict';
export type ImportConflictStrategy = 'skip' | 'overwrite' | 'copy';

export interface DataPortabilitySnapshot {
  taskState: LocalAppState;
  settings: AppSettings;
  permissionAudit: AuditRecord[];
}

/**
 * Implementations must commit a transaction as one durable unit, or leave the
 * previous snapshot unchanged. A journaled multi-file adapter or a single
 * atomic database transaction both satisfy this contract.
 */
export interface DataPortabilityRepository {
  readSnapshot(): Promise<DataPortabilitySnapshot>;
  transact<Result>(
    mutator: (draft: DataPortabilitySnapshot) => Result | Promise<Result>,
  ): Promise<Result>;
}

export interface PortableDataSelection {
  tasks: boolean;
  drafts: boolean;
  operations: boolean;
  settings: boolean;
  permissionAudit: boolean;
}

export interface PortableDataPayload {
  tasks?: Task[];
  drafts?: TaskDraft[];
  operations?: TaskOperation[];
  settings?: AppSettings;
  permissionAudit?: AuditRecord[];
}

export interface PortableDataBundle {
  format: typeof PORTABLE_DATA_FORMAT;
  schemaVersion: 1;
  exportedAt: string;
  redaction: ExportRedaction;
  data: PortableDataPayload;
}

export interface DataExportOptions {
  include?: Partial<PortableDataSelection>;
  redaction?: ExportRedaction;
  pretty?: boolean;
}

export interface ImportCategoryPlan {
  incoming: number;
  conflicts: string[];
  create: number;
  overwrite: number;
  skip: number;
  copy: number;
}

export interface DataImportPreview {
  digest: string;
  strategy: ImportConflictStrategy;
  exportedAt: string;
  redaction: ExportRedaction;
  tasks: ImportCategoryPlan;
  drafts: ImportCategoryPlan;
  operations: ImportCategoryPlan;
  settings: {
    included: boolean;
    differs: boolean;
    action: 'none' | 'overwrite' | 'skip';
  };
  permissionAudit: {
    incoming: number;
    existing: number;
    action: 'none' | 'replace' | 'skip';
  };
  warnings: string[];
}

export interface DataImportOptions {
  strategy: ImportConflictStrategy;
  /** Pins execution to a previously displayed preview. */
  expectedDigest?: string;
}

export interface DataImportResult {
  digest: string;
  strategy: ImportConflictStrategy;
  tasks: Omit<ImportCategoryPlan, 'conflicts'>;
  drafts: Omit<ImportCategoryPlan, 'conflicts'>;
  operations: Omit<ImportCategoryPlan, 'conflicts'>;
  settings: 'none' | 'overwritten' | 'skipped';
  permissionAudit: 'none' | 'replaced' | 'skipped';
  copiedTaskIds: Record<string, string>;
}

export interface DataPortabilityServiceOptions {
  repository: DataPortabilityRepository;
  now?: () => Date;
  maxImportBytes?: number;
  createCopyId?: (
    kind: 'task' | 'draft' | 'operation',
    originalId: string,
    attempt: number,
  ) => string;
}

export class DataImportValidationError extends Error {
  constructor(
    message: string,
    readonly path = '$',
  ) {
    super(`${message} (${path})`);
    this.name = 'DataImportValidationError';
  }
}

export class DataImportPreviewMismatchError extends Error {
  constructor() {
    super('The import file changed after preview. Generate a new preview before importing.');
    this.name = 'DataImportPreviewMismatchError';
  }
}

const DEFAULT_SELECTION: PortableDataSelection = {
  tasks: true,
  drafts: true,
  operations: true,
  settings: true,
  permissionAudit: true,
};
const REDACTED = '[REDACTED]';
const SAFE_ID = /^[^\u0000-\u001f]{1,512}$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const MAX_NODES = 250_000;
const MAX_DEPTH = 40;
const MAX_STRING_LENGTH = 2 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dangerousKey = (key: string): boolean =>
  key === '__proto__' || key === 'prototype' || key === 'constructor';

const normalizedKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

const isCredentialKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return (
    normalized === 'apikey' ||
    normalized === 'token' ||
    normalized === 'authtoken' ||
    normalized === 'accesstoken' ||
    normalized === 'refreshtoken' ||
    normalized === 'bearertoken' ||
    normalized === 'sessiontoken' ||
    normalized === 'clienttoken' ||
    normalized === 'secret' ||
    normalized === 'clientsecret' ||
    normalized === 'password' ||
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'encryptedvalue' ||
    normalized === 'credential' ||
    normalized === 'credentialid' ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('authtoken') ||
    normalized.endsWith('clientsecret') ||
    normalized.endsWith('password')
  );
};

const scrubSensitiveString = (value: string): string =>
  value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, REDACTED)
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*([^\s,;]+)/gi,
      (_match, label: string) => `${label}=${REDACTED}`,
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|secret|password)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    );

const assertSafeTree = (root: unknown): void => {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: root, path: '$', depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new DataImportValidationError('Import contains too many values', current.path);
    }
    if (current.depth > MAX_DEPTH) {
      throw new DataImportValidationError('Import is nested too deeply', current.path);
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_STRING_LENGTH) {
        throw new DataImportValidationError('String is too large', current.path);
      }
      if (scrubSensitiveString(current.value) !== current.value) {
        throw new DataImportValidationError('Credentials are forbidden in imports', current.path);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) =>
        stack.push({ value: entry, path: `${current.path}[${index}]`, depth: current.depth + 1 }),
      );
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [key, entry] of Object.entries(current.value)) {
      const path = `${current.path}.${key}`;
      if (dangerousKey(key)) {
        throw new DataImportValidationError('Prototype keys are forbidden', path);
      }
      if (isCredentialKey(key)) {
        throw new DataImportValidationError('Credential fields are forbidden', path);
      }
      stack.push({ value: entry, path, depth: current.depth + 1 });
    }
  }
};

const scrubCredentials = (value: unknown): unknown => {
  if (typeof value === 'string') return scrubSensitiveString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubCredentials(entry));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (dangerousKey(key) || isCredentialKey(key) || key === 'localPath') continue;
    result[key] = scrubCredentials(entry);
  }
  return result;
};

const stableStringify = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
};

const digest = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

const clone = <Value>(value: Value): Value => structuredClone(value);
const same = (left: unknown, right: unknown): boolean =>
  stableStringify(left) === stableStringify(right);

const assertOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void => {
  const set = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !set.has(key));
  if (unknown !== undefined) {
    throw new DataImportValidationError(`Unknown field: ${unknown}`, `${path}.${unknown}`);
  }
};

const expectRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new DataImportValidationError('Expected an object', path);
  return value;
};

const expectString = (value: unknown, path: string, allowEmpty = true): string => {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new DataImportValidationError('Expected a string', path);
  }
  return value;
};

const expectBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw new DataImportValidationError('Expected a boolean', path);
  return value;
};

const expectNumber = (
  value: unknown,
  path: string,
  options: { integer?: boolean; minimum?: number; maximum?: number } = {},
): number => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isSafeInteger(value)) ||
    (options.minimum !== undefined && value < options.minimum) ||
    (options.maximum !== undefined && value > options.maximum)
  ) {
    throw new DataImportValidationError('Expected a valid number', path);
  }
  return value;
};

const expectEnum = <Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  path: string,
): Value => {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new DataImportValidationError(`Expected one of: ${allowed.join(', ')}`, path);
  }
  return value as Value;
};

const expectId = (value: unknown, path: string): string => {
  const id = expectString(value, path, false);
  if (!SAFE_ID.test(id) || dangerousKey(id)) {
    throw new DataImportValidationError('Unsafe identifier', path);
  }
  return id;
};

const expectIsoDateTime = (value: unknown, path: string): string => {
  const text = expectString(value, path, false);
  if (Number.isNaN(Date.parse(text))) {
    throw new DataImportValidationError('Expected an ISO date-time', path);
  }
  return text;
};

const expectLocalDate = (value: unknown, path: string): string => {
  const text = expectString(value, path, false);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) !== text
  ) {
    throw new DataImportValidationError('Expected YYYY-MM-DD', path);
  }
  return text;
};

const expectOptional = (
  value: Record<string, unknown>,
  key: string,
  path: string,
  validator: (entry: unknown, entryPath: string) => unknown,
): void => {
  if (value[key] !== undefined) validator(value[key], `${path}.${key}`);
};

const expectStringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) throw new DataImportValidationError('Expected an array', path);
  return value.map((entry, index) => expectId(entry, `${path}[${index}]`));
};

const assertJsonValue = (value: unknown, path: string): void => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => assertJsonValue(entry, `${path}.${key}`));
    return;
  }
  throw new DataImportValidationError('Expected JSON-compatible data', path);
};

const validateTask = (value: unknown, path: string): Task => {
  const task = expectRecord(value, path);
  assertOnlyKeys(task, [
    'id', 'source', 'title', 'notes', 'privateNotes', 'status', 'priority',
    'projectId', 'listId', 'sectionId', 'tags', 'parentId', 'dependencyIds',
    'assigneeIds', 'followerIds', 'attachments', 'links', 'customFields',
    'plannedDate', 'startAt', 'startAtIsAllDay', 'dueAt', 'dueAtIsAllDay',
    'timeBlock', 'reminders', 'completedAt',
    'recurrence', 'recurrenceSeriesId', 'recurrenceIndex', 'estimatedMinutes',
    'actualMinutes', 'focusStartedAt', 'focusElapsedSeconds', 'focusSessions',
    'privateOrder', 'completionMode', 'currentUserRole', 'currentUserCompleted',
    'sync', 'createdAt', 'updatedAt', 'deletedAt',
  ], path);
  expectId(task.id, `${path}.id`);
  const source = expectRecord(task.source, `${path}.source`);
  assertOnlyKeys(source, ['type', 'accountId', 'tenantId', 'externalId', 'remoteVersion', 'tasklist'], `${path}.source`);
  expectEnum(source.type, ['local', 'feishu'] as const, `${path}.source.type`);
  ['accountId', 'tenantId', 'externalId', 'remoteVersion'].forEach((key) =>
    expectOptional(source, key, `${path}.source`, expectString),
  );
  if (source.tasklist !== undefined) {
    if (source.type !== 'feishu') {
      throw new DataImportValidationError('Tasklist binding is only valid for Feishu tasks', `${path}.source.tasklist`);
    }
    const tasklist = expectRecord(source.tasklist, `${path}.source.tasklist`);
    assertOnlyKeys(tasklist, ['tasklistGuid', 'sectionGuid'], `${path}.source.tasklist`);
    expectOptional(tasklist, 'tasklistGuid', `${path}.source.tasklist`, expectId);
    expectOptional(tasklist, 'sectionGuid', `${path}.source.tasklist`, expectId);
    if (tasklist.sectionGuid !== undefined && tasklist.tasklistGuid === undefined) {
      throw new DataImportValidationError('sectionGuid requires tasklistGuid', `${path}.source.tasklist.sectionGuid`);
    }
  }
  expectString(task.title, `${path}.title`, false);
  expectString(task.notes, `${path}.notes`);
  expectString(task.privateNotes, `${path}.privateNotes`);
  expectEnum(task.status, ['open', 'completed', 'cancelled'] as const, `${path}.status`);
  expectEnum(task.priority, ['none', 'low', 'medium', 'high', 'urgent'] as const, `${path}.priority`);
  ['projectId', 'listId', 'sectionId', 'parentId', 'recurrenceSeriesId'].forEach((key) =>
    expectOptional(task, key, path, expectId),
  );
  expectStringArray(task.tags, `${path}.tags`);
  expectStringArray(task.dependencyIds, `${path}.dependencyIds`);
  expectStringArray(task.assigneeIds, `${path}.assigneeIds`);
  expectStringArray(task.followerIds, `${path}.followerIds`);

  if (!Array.isArray(task.attachments)) throw new DataImportValidationError('Expected an array', `${path}.attachments`);
  task.attachments.forEach((entry, index) => {
    const attachmentPath = `${path}.attachments[${index}]`;
    const attachment = expectRecord(entry, attachmentPath);
    assertOnlyKeys(attachment, ['id', 'name', 'mimeType', 'size', 'url'], attachmentPath);
    expectId(attachment.id, `${attachmentPath}.id`);
    expectString(attachment.name, `${attachmentPath}.name`, false);
    expectOptional(attachment, 'mimeType', attachmentPath, expectString);
    expectOptional(attachment, 'size', attachmentPath, (item, itemPath) =>
      expectNumber(item, itemPath, { minimum: 0 }),
    );
    expectOptional(attachment, 'url', attachmentPath, expectSafeWebUrl);
  });

  if (!Array.isArray(task.links)) throw new DataImportValidationError('Expected an array', `${path}.links`);
  task.links.forEach((entry, index) => {
    const linkPath = `${path}.links[${index}]`;
    const link = expectRecord(entry, linkPath);
    assertOnlyKeys(link, ['id', 'url', 'label'], linkPath);
    expectId(link.id, `${linkPath}.id`);
    expectSafeWebUrl(link.url, `${linkPath}.url`);
    expectOptional(link, 'label', linkPath, expectString);
  });

  const customFields = expectRecord(task.customFields, `${path}.customFields`);
  assertJsonValue(customFields, `${path}.customFields`);
  expectOptional(task, 'plannedDate', path, expectLocalDate);
  expectOptional(task, 'startAtIsAllDay', path, expectBoolean);
  expectOptional(task, 'dueAtIsAllDay', path, expectBoolean);
  ['startAt', 'dueAt', 'completedAt', 'focusStartedAt', 'createdAt', 'updatedAt', 'deletedAt']
    .forEach((key) => {
      if (key === 'createdAt' || key === 'updatedAt') expectIsoDateTime(task[key], `${path}.${key}`);
      else expectOptional(task, key, path, expectIsoDateTime);
    });

  if (task.startAtIsAllDay === true && typeof task.startAt !== 'string') {
    throw new DataImportValidationError(
      'An all-day start flag requires startAt',
      `${path}.startAtIsAllDay`,
    );
  }
  if (task.dueAtIsAllDay === true && typeof task.dueAt !== 'string') {
    throw new DataImportValidationError(
      'An all-day due flag requires dueAt',
      `${path}.dueAtIsAllDay`,
    );
  }

  if (
    typeof task.startAt === 'string' &&
    typeof task.dueAt === 'string' &&
    Date.parse(task.dueAt) < Date.parse(task.startAt)
  ) {
    throw new DataImportValidationError('Task due time is before its start time', path);
  }

  if (task.timeBlock !== undefined) {
    const block = expectRecord(task.timeBlock, `${path}.timeBlock`);
    assertOnlyKeys(block, ['startAt', 'endAt'], `${path}.timeBlock`);
    const start = expectIsoDateTime(block.startAt, `${path}.timeBlock.startAt`);
    const end = expectIsoDateTime(block.endAt, `${path}.timeBlock.endAt`);
    if (Date.parse(end) <= Date.parse(start)) {
      throw new DataImportValidationError('Time block ends before it starts', `${path}.timeBlock`);
    }
  }

  if (!Array.isArray(task.reminders)) throw new DataImportValidationError('Expected an array', `${path}.reminders`);
  task.reminders.forEach((entry, index) => {
    const reminderPath = `${path}.reminders[${index}]`;
    const reminder = expectRecord(entry, reminderPath);
    assertOnlyKeys(reminder, ['id', 'at', 'enabled', 'source', 'label'], reminderPath);
    expectId(reminder.id, `${reminderPath}.id`);
    expectIsoDateTime(reminder.at, `${reminderPath}.at`);
    expectBoolean(reminder.enabled, `${reminderPath}.enabled`);
    expectEnum(reminder.source, ['local', 'feishu'] as const, `${reminderPath}.source`);
    expectOptional(reminder, 'label', reminderPath, expectString);
  });

  if (task.recurrence !== undefined) {
    const recurrence = expectRecord(task.recurrence, `${path}.recurrence`);
    assertOnlyKeys(recurrence, ['frequency', 'interval', 'weekdays', 'dayOfMonth', 'endsAt', 'maxOccurrences'], `${path}.recurrence`);
    const frequency = expectEnum(recurrence.frequency, ['daily', 'weekly', 'monthly'] as const, `${path}.recurrence.frequency`);
    expectNumber(recurrence.interval, `${path}.recurrence.interval`, { integer: true, minimum: 1 });
    if (recurrence.weekdays !== undefined) {
      if (frequency !== 'weekly' || !Array.isArray(recurrence.weekdays) || recurrence.weekdays.length === 0) {
        throw new DataImportValidationError('Invalid weekly weekdays', `${path}.recurrence.weekdays`);
      }
      recurrence.weekdays.forEach((day, index) => {
        const parsed = expectNumber(day, `${path}.recurrence.weekdays[${index}]`, { integer: true, minimum: 0 });
        if (parsed > 6) throw new DataImportValidationError('Weekday must be 0-6', `${path}.recurrence.weekdays[${index}]`);
      });
    }
    if (recurrence.dayOfMonth !== undefined) {
      const day = expectNumber(recurrence.dayOfMonth, `${path}.recurrence.dayOfMonth`, { integer: true, minimum: 1 });
      if (frequency !== 'monthly' || day > 31) throw new DataImportValidationError('Invalid monthly day', `${path}.recurrence.dayOfMonth`);
    }
    if (recurrence.endsAt !== undefined) {
      if (typeof recurrence.endsAt !== 'string') throw new DataImportValidationError('Invalid recurrence end', `${path}.recurrence.endsAt`);
      if (/^\d{4}-\d{2}-\d{2}$/.test(recurrence.endsAt)) expectLocalDate(recurrence.endsAt, `${path}.recurrence.endsAt`);
      else expectIsoDateTime(recurrence.endsAt, `${path}.recurrence.endsAt`);
    }
    expectOptional(recurrence, 'maxOccurrences', `${path}.recurrence`, (entry, entryPath) =>
      expectNumber(entry, entryPath, { integer: true, minimum: 1 }),
    );
  }

  ['recurrenceIndex', 'estimatedMinutes', 'actualMinutes', 'focusElapsedSeconds', 'privateOrder']
    .forEach((key) => {
      if (key === 'focusElapsedSeconds' || key === 'privateOrder') {
        expectNumber(task[key], `${path}.${key}`, { minimum: 0 });
      } else {
        expectOptional(task, key, path, (entry, entryPath) =>
          expectNumber(entry, entryPath, { minimum: 0 }),
        );
      }
    });
  if (task.focusSessions !== undefined) {
    if (!Array.isArray(task.focusSessions)) throw new DataImportValidationError('Expected an array', `${path}.focusSessions`);
    task.focusSessions.forEach((entry, index) => {
      const sessionPath = `${path}.focusSessions[${index}]`;
      const session = expectRecord(entry, sessionPath);
      assertOnlyKeys(session, ['id', 'startedAt', 'endedAt', 'elapsedSeconds'], sessionPath);
      expectId(session.id, `${sessionPath}.id`);
      expectIsoDateTime(session.startedAt, `${sessionPath}.startedAt`);
      expectIsoDateTime(session.endedAt, `${sessionPath}.endedAt`);
      expectNumber(session.elapsedSeconds, `${sessionPath}.elapsedSeconds`, { integer: true, minimum: 0 });
    });
  }
  expectOptional(task, 'completionMode', path, (entry, entryPath) =>
    expectEnum(entry, ['single', 'any-assignee', 'all-assignees'] as const, entryPath),
  );
  expectOptional(task, 'currentUserRole', path, (entry, entryPath) =>
    expectEnum(entry, ['assignee', 'follower', 'viewer'] as const, entryPath),
  );
  expectOptional(task, 'currentUserCompleted', path, expectBoolean);

  const sync = expectRecord(task.sync, `${path}.sync`);
  assertOnlyKeys(sync, ['status', 'lastSyncedAt', 'error', 'conflictFields', 'tombstone'], `${path}.sync`);
  expectEnum(sync.status, [
    'local', 'synced', 'pending', 'syncing', 'offline', 'failed', 'conflict',
    'read-only', 'permission-denied', 'remote-deleted',
  ] as const, `${path}.sync.status`);
  expectOptional(sync, 'lastSyncedAt', `${path}.sync`, expectIsoDateTime);
  expectOptional(sync, 'error', `${path}.sync`, expectString);
  if (sync.conflictFields !== undefined) expectStringArray(sync.conflictFields, `${path}.sync.conflictFields`);
  if (sync.tombstone !== undefined) {
    const tombstone = expectRecord(sync.tombstone, `${path}.sync.tombstone`);
    assertOnlyKeys(tombstone, ['deletedAt', 'confirmedAt'], `${path}.sync.tombstone`);
    expectIsoDateTime(tombstone.deletedAt, `${path}.sync.tombstone.deletedAt`);
    expectOptional(tombstone, 'confirmedAt', `${path}.sync.tombstone`, expectIsoDateTime);
  }
  return clone(task) as unknown as Task;
};

function expectSafeWebUrl(value: unknown, path: string): string {
  const text = expectString(value, path, false);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DataImportValidationError('Invalid URL', path);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DataImportValidationError('Only HTTP(S) URLs may be imported', path);
  }
  if (url.username || url.password) {
    throw new DataImportValidationError('URL credentials are forbidden', path);
  }
  return text;
}

const validateDraft = (value: unknown, path: string): TaskDraft => {
  const draft = expectRecord(value, path);
  assertOnlyKeys(draft, ['id', 'kind', 'text', 'taskId', 'data', 'createdAt', 'updatedAt'], path);
  expectId(draft.id, `${path}.id`);
  expectEnum(draft.kind, ['quick-capture', 'task-editor', 'agent'] as const, `${path}.kind`);
  expectString(draft.text, `${path}.text`);
  expectOptional(draft, 'taskId', path, expectId);
  if (draft.data !== undefined) assertJsonValue(draft.data, `${path}.data`);
  expectIsoDateTime(draft.createdAt, `${path}.createdAt`);
  expectIsoDateTime(draft.updatedAt, `${path}.updatedAt`);
  return clone(draft) as unknown as TaskDraft;
};

const validateOperation = (value: unknown, path: string): TaskOperation => {
  const operation = expectRecord(value, path);
  assertOnlyKeys(operation, ['id', 'kind', 'createdAt', 'changes', 'undoneAt'], path);
  expectId(operation.id, `${path}.id`);
  expectEnum(operation.kind, [
    'create', 'update', 'complete', 'reopen', 'move-to-today', 'focus',
    'reorder-today', 'trash', 'restore', 'purge',
  ] as const, `${path}.kind`);
  expectIsoDateTime(operation.createdAt, `${path}.createdAt`);
  expectOptional(operation, 'undoneAt', path, expectIsoDateTime);
  if (!Array.isArray(operation.changes)) {
    throw new DataImportValidationError('Expected an array', `${path}.changes`);
  }
  operation.changes.forEach((entry, index) => {
    const changePath = `${path}.changes[${index}]`;
    const change = expectRecord(entry, changePath);
    assertOnlyKeys(change, ['taskId', 'before', 'after'], changePath);
    const taskId = expectId(change.taskId, `${changePath}.taskId`);
    if (change.before !== null) {
      const before = validateTask(change.before, `${changePath}.before`);
      if (before.id !== taskId) throw new DataImportValidationError('Snapshot task id mismatch', `${changePath}.before.id`);
    }
    if (change.after !== null) {
      const after = validateTask(change.after, `${changePath}.after`);
      if (after.id !== taskId) throw new DataImportValidationError('Snapshot task id mismatch', `${changePath}.after.id`);
    }
    if (change.before === null && change.after === null) {
      throw new DataImportValidationError('Operation change has no snapshot', changePath);
    }
  });
  return clone(operation) as unknown as TaskOperation;
};

const validateSettings = (value: unknown, path: string): AppSettings => {
  const settings = expectRecord(value, path);
  assertOnlyKeys(settings, [
    'schemaVersion', 'theme', 'launchAtLogin', 'closeToTray', 'quickCaptureShortcut',
    'notifications', 'floating', 'ai', 'feishu', 'modelDataScope', 'persona', 'permissionMode',
    'onboardingComplete',
  ], path);
  if (settings.schemaVersion !== 1) throw new DataImportValidationError('Unsupported settings schema', `${path}.schemaVersion`);
  expectEnum(settings.theme, ['system', 'light', 'dark'] as const, `${path}.theme`);
  expectBoolean(settings.launchAtLogin, `${path}.launchAtLogin`);
  expectBoolean(settings.closeToTray, `${path}.closeToTray`);
  expectString(settings.quickCaptureShortcut, `${path}.quickCaptureShortcut`, false);
  const notifications = expectRecord(settings.notifications, `${path}.notifications`);
  assertOnlyKeys(notifications, [
    'enabled', 'sound', 'banners', 'badge', 'morningBrief', 'morningBriefTime',
    'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd', 'mutedUntil',
  ], `${path}.notifications`);
  ['enabled', 'sound', 'banners', 'badge', 'morningBrief', 'quietHoursEnabled'].forEach((key) =>
    expectBoolean(notifications[key], `${path}.notifications.${key}`),
  );
  ['morningBriefTime', 'quietHoursStart', 'quietHoursEnd'].forEach((key) => {
    const time = expectString(notifications[key], `${path}.notifications.${key}`);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new DataImportValidationError('Expected HH:mm', `${path}.notifications.${key}`);
  });
  expectOptional(notifications, 'mutedUntil', `${path}.notifications`, expectIsoDateTime);

  const floating = expectRecord(settings.floating, `${path}.floating`);
  assertOnlyKeys(floating, ['enabled', 'hoverExpandDelayMs', 'topMode', 'locked', 'hideInFullscreen', 'privacyMode', 'selectedTab', 'scalePercent', 'lastDisplayId', 'positions', 'shape'], `${path}.floating`);
  ['enabled', 'locked', 'hideInFullscreen', 'privacyMode'].forEach((key) =>
    expectBoolean(floating[key], `${path}.floating.${key}`),
  );
  if (floating.selectedTab !== undefined) {
    expectEnum(floating.selectedTab, ['all', 'today', 'focus', 'chat', 'home'] as const, `${path}.floating.selectedTab`);
  }
  if (floating.scalePercent !== undefined) {
    expectNumber(floating.scalePercent, `${path}.floating.scalePercent`, {
      integer: true,
      minimum: 75,
      maximum: 125,
    });
  }
  if (floating.shape !== undefined) {
    expectEnum(floating.shape, ['capsule', 'orb'] as const, `${path}.floating.shape`);
  }
  if (floating.hoverExpandDelayMs !== undefined) {
    expectNumber(floating.hoverExpandDelayMs, `${path}.floating.hoverExpandDelayMs`, {
      integer: true,
      minimum: FLOATING_HOVER_EXPAND_DELAY_MIN_MS,
      maximum: FLOATING_HOVER_EXPAND_DELAY_MAX_MS,
    });
  }
  if (floating.topMode !== undefined) {
    expectEnum(floating.topMode, ['always', 'focus-only', 'never'] as const, `${path}.floating.topMode`);
  }
  expectOptional(floating, 'lastDisplayId', `${path}.floating`, expectId);
  const positions = expectRecord(floating.positions, `${path}.floating.positions`);
  Object.entries(positions).forEach(([displayId, entry]) => {
    expectId(displayId, `${path}.floating.positions key`);
    const position = expectRecord(entry, `${path}.floating.positions.${displayId}`);
    assertOnlyKeys(position, ['x', 'y'], `${path}.floating.positions.${displayId}`);
    expectNumber(position.x, `${path}.floating.positions.${displayId}.x`);
    expectNumber(position.y, `${path}.floating.positions.${displayId}.y`);
  });

  const ai = expectRecord(settings.ai, `${path}.ai`);
  assertOnlyKeys(ai, [
    'enabled', 'endpoint', 'model', 'authMode', 'timeoutMs', 'retries',
    'dailyTokenLimit', 'dailyCostLimit',
  ], `${path}.ai`);
  expectBoolean(ai.enabled, `${path}.ai.enabled`);
  expectSafeWebUrl(ai.endpoint, `${path}.ai.endpoint`);
  expectString(ai.model, `${path}.ai.model`);
  // `authMode` was added after the first portable-data schema. Missing it is
  // a safe legacy import and must preserve the secure Bearer default; any
  // value that is present is still an explicit, closed enum.
  if (ai.authMode !== undefined) {
    expectEnum(ai.authMode, ['bearer', 'none'] as const, `${path}.ai.authMode`);
  }
  ['timeoutMs', 'retries', 'dailyTokenLimit', 'dailyCostLimit'].forEach((key) =>
    expectNumber(ai[key], `${path}.ai.${key}`, { minimum: 0 }),
  );

  if (settings.feishu !== undefined) {
    const feishu = expectRecord(settings.feishu, `${path}.feishu`);
    assertOnlyKeys(feishu, [
      'configured', 'mode', 'accountId', 'relayBaseUrl', 'clientId',
      'acknowledgeInsecureLocalCredentials', 'autoSync', 'pollingMinutes',
    ], `${path}.feishu`);
    expectBoolean(feishu.configured, `${path}.feishu.configured`);
    expectEnum(
      feishu.mode,
      [
        'personal-direct',
        'existing-direct',
        'relay',
        'local-development',
      ] as const,
      `${path}.feishu.mode`,
    );
    expectString(feishu.accountId, `${path}.feishu.accountId`, false);
    const relayBaseUrl = expectString(feishu.relayBaseUrl, `${path}.feishu.relayBaseUrl`);
    if (relayBaseUrl !== '') {
      expectSafeWebUrl(relayBaseUrl, `${path}.feishu.relayBaseUrl`);
      if (!relayBaseUrl.startsWith('https://')) {
        throw new DataImportValidationError('Feishu Relay must use HTTPS', `${path}.feishu.relayBaseUrl`);
      }
    }
    expectString(feishu.clientId, `${path}.feishu.clientId`);
    expectBoolean(feishu.acknowledgeInsecureLocalCredentials, `${path}.feishu.acknowledgeInsecureLocalCredentials`);
    expectBoolean(feishu.autoSync, `${path}.feishu.autoSync`);
    expectNumber(feishu.pollingMinutes, `${path}.feishu.pollingMinutes`, { integer: true, minimum: 1 });
  }

  const scope = expectRecord(settings.modelDataScope, `${path}.modelDataScope`);
  assertOnlyKeys(scope, ['taskTitlesAndTimes', 'notes', 'feishuContent', 'attachmentText', 'chatHistory'], `${path}.modelDataScope`);
  Object.keys(scope).forEach((key) => expectBoolean(scope[key], `${path}.modelDataScope.${key}`));
  const persona = expectRecord(settings.persona, `${path}.persona`);
  assertOnlyKeys(persona, ['preset', 'name', 'userName', 'responseLength', 'proactiveLevel', 'reminderStrength'], `${path}.persona`);
  expectEnum(persona.preset, ['minimal', 'warm', 'calm', 'strict'] as const, `${path}.persona.preset`);
  expectString(persona.name, `${path}.persona.name`);
  expectString(persona.userName, `${path}.persona.userName`);
  expectEnum(persona.responseLength, ['short', 'balanced', 'detailed'] as const, `${path}.persona.responseLength`);
  expectEnum(persona.proactiveLevel, ['quiet', 'balanced', 'active'] as const, `${path}.persona.proactiveLevel`);
  expectEnum(persona.reminderStrength, ['gentle', 'normal', 'firm'] as const, `${path}.persona.reminderStrength`);
  expectEnum(settings.permissionMode, ['read-only', 'standard', 'full-access'] as const, `${path}.permissionMode`);
  expectBoolean(settings.onboardingComplete, `${path}.onboardingComplete`);
  const validated = clone(settings) as unknown as AppSettings;
  const { shape: _legacyShape, ...portableFloating } = floating;
  validated.floating = {
    ...clone(defaultSettings.floating),
    ...clone(portableFloating),
    topMode: 'always',
  } as AppSettings['floating'];
  validated.ai = {
    ...clone(defaultSettings.ai),
    ...clone(ai),
  } as AppSettings['ai'];
  // The import format intentionally carries authentication *mode*, but never
  // an OS credential reference. Keep this explicit so later defaults cannot
  // silently reintroduce a credential identifier.
  delete validated.ai.credentialId;
  validated.feishu = {
    ...clone(defaultSettings.feishu),
    ...(settings.feishu === undefined ? {} : clone(settings.feishu)),
  } as AppSettings['feishu'];
  // Portable settings must never recreate OS credential references from
  // defaults after the export redaction step.
  delete validated.feishu.tokenCredentialId;
  delete validated.feishu.appSecretCredentialId;
  return validated;
};

const validateAudit = (value: unknown, path: string): AuditRecord => {
  const record = expectRecord(value, path);
  assertOnlyKeys(record, [
    'runId', 'invocationId', 'actor', 'event', 'toolName', 'risk', 'arguments',
    'effects', 'policyReason', 'grantId', 'outcome', 'details', 'sequence',
    'timestamp', 'previousHash', 'eventHash',
  ], path);
  expectId(record.runId, `${path}.runId`);
  expectOptional(record, 'invocationId', path, expectId);
  expectEnum(record.actor, ['user', 'model', 'system'] as const, `${path}.actor`);
  expectString(record.event, `${path}.event`, false);
  expectOptional(record, 'toolName', path, expectString);
  expectOptional(record, 'risk', path, (entry, entryPath) =>
    expectEnum(entry, ['R0', 'R1', 'R2', 'R3', 'R4'] as const, entryPath),
  );
  ['arguments', 'effects', 'details'].forEach((key) => {
    if (record[key] !== undefined) assertJsonValue(record[key], `${path}.${key}`);
  });
  ['policyReason', 'grantId', 'outcome'].forEach((key) =>
    expectOptional(record, key, path, expectString),
  );
  expectNumber(record.sequence, `${path}.sequence`, { integer: true, minimum: 1 });
  expectIsoDateTime(record.timestamp, `${path}.timestamp`);
  const previousHash = expectString(record.previousHash, `${path}.previousHash`);
  const eventHash = expectString(record.eventHash, `${path}.eventHash`);
  if (!SHA_256.test(previousHash) || !SHA_256.test(eventHash)) {
    throw new DataImportValidationError('Audit hash must be SHA-256', path);
  }
  return clone(record) as unknown as AuditRecord;
};

const rehashAudit = (records: readonly AuditRecord[]): AuditRecord[] => {
  let previousHash = '0'.repeat(64);
  return records.map((input, index) => {
    const { eventHash: _eventHash, previousHash: _previousHash, ...event } = clone(input);
    const hashable = { ...event, sequence: index + 1, previousHash };
    const record: AuditRecord = { ...hashable, eventHash: digest(hashable) };
    previousHash = record.eventHash;
    return record;
  });
};

const assertAuditChain = (records: readonly AuditRecord[], path: string): void => {
  let previousHash = '0'.repeat(64);
  records.forEach((record, index) => {
    if (record.sequence !== index + 1) {
      throw new DataImportValidationError('Audit sequence is not contiguous', `${path}[${index}].sequence`);
    }
    if (record.previousHash !== previousHash) {
      throw new DataImportValidationError('Audit previous hash mismatch', `${path}[${index}].previousHash`);
    }
    const { eventHash, ...hashable } = record;
    if (eventHash !== digest(hashable)) {
      throw new DataImportValidationError('Audit event hash mismatch', `${path}[${index}].eventHash`);
    }
    previousHash = eventHash;
  });
};

const parseBundle = (json: string, maxBytes: number): PortableDataBundle => {
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new DataImportValidationError('Import exceeds the configured size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new DataImportValidationError('Import is not valid JSON');
  }
  assertSafeTree(parsed);
  const bundle = expectRecord(parsed, '$');
  assertOnlyKeys(bundle, ['format', 'schemaVersion', 'exportedAt', 'redaction', 'data'], '$');
  if (bundle.format !== PORTABLE_DATA_FORMAT) throw new DataImportValidationError('Unknown import format', '$.format');
  if (bundle.schemaVersion !== 1) throw new DataImportValidationError('Unsupported import schema', '$.schemaVersion');
  expectIsoDateTime(bundle.exportedAt, '$.exportedAt');
  expectEnum(bundle.redaction, ['none', 'private', 'strict'] as const, '$.redaction');
  const data = expectRecord(bundle.data, '$.data');
  assertOnlyKeys(data, ['tasks', 'drafts', 'operations', 'settings', 'permissionAudit'], '$.data');
  const result: PortableDataBundle = {
    format: PORTABLE_DATA_FORMAT,
    schemaVersion: 1,
    exportedAt: bundle.exportedAt as string,
    redaction: bundle.redaction as ExportRedaction,
    data: {},
  };
  if (data.tasks !== undefined) {
    if (!Array.isArray(data.tasks)) throw new DataImportValidationError('Expected an array', '$.data.tasks');
    result.data.tasks = data.tasks.map((task, index) => validateTask(task, `$.data.tasks[${index}]`));
    assertUniqueIds(result.data.tasks, '$.data.tasks');
  }
  if (data.drafts !== undefined) {
    if (!Array.isArray(data.drafts)) throw new DataImportValidationError('Expected an array', '$.data.drafts');
    result.data.drafts = data.drafts.map((draft, index) => validateDraft(draft, `$.data.drafts[${index}]`));
    assertUniqueIds(result.data.drafts, '$.data.drafts');
  }
  if (data.operations !== undefined) {
    if (!Array.isArray(data.operations)) throw new DataImportValidationError('Expected an array', '$.data.operations');
    result.data.operations = data.operations.map((operation, index) => validateOperation(operation, `$.data.operations[${index}]`));
    assertUniqueIds(result.data.operations, '$.data.operations');
  }
  if (data.settings !== undefined) result.data.settings = validateSettings(data.settings, '$.data.settings');
  if (data.permissionAudit !== undefined) {
    if (!Array.isArray(data.permissionAudit)) throw new DataImportValidationError('Expected an array', '$.data.permissionAudit');
    result.data.permissionAudit = data.permissionAudit.map((record, index) => validateAudit(record, `$.data.permissionAudit[${index}]`));
    assertAuditChain(result.data.permissionAudit, '$.data.permissionAudit');
  }
  return result;
};

const assertUniqueIds = (
  values: readonly { id: string }[],
  path: string,
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) throw new DataImportValidationError('Duplicate id in import', `${path}[${index}].id`);
    seen.add(value.id);
  });
};

const redactTask = (task: Task, redaction: ExportRedaction): Task => {
  const result = clone(task);
  result.attachments = result.attachments.map(({ localPath: _localPath, ...attachment }) => {
    if (attachment.url !== undefined) {
      try {
        const url = new URL(attachment.url);
        if (
          (url.protocol !== 'http:' && url.protocol !== 'https:') ||
          url.username ||
          url.password
        ) {
          delete attachment.url;
        }
      } catch {
        delete attachment.url;
      }
    }
    return attachment;
  });
  result.links = result.links.filter((link) => {
    try {
      const url = new URL(link.url);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch {
      return false;
    }
  });
  if (redaction !== 'none') {
    result.notes = '';
    result.privateNotes = '';
    result.customFields = {};
    result.attachments = [];
    result.links = [];
  }
  if (redaction === 'strict') {
    result.title = REDACTED;
    delete result.projectId;
    delete result.listId;
    delete result.sectionId;
    result.tags = [];
    delete result.parentId;
    result.dependencyIds = [];
    result.assigneeIds = [];
    result.followerIds = [];
    result.source = { type: result.source.type };
    result.reminders = [];
  }
  return result;
};

const redactDraft = (draft: TaskDraft, redaction: ExportRedaction): TaskDraft => {
  const result = clone(draft);
  if (redaction !== 'none') {
    result.text = REDACTED;
    delete result.data;
  }
  if (redaction === 'strict') delete result.taskId;
  return result;
};

const redactOperation = (operation: TaskOperation, redaction: ExportRedaction): TaskOperation => {
  const result = clone(operation);
  result.changes = result.changes.map((change) => ({
    ...change,
    before: change.before === null ? null : redactTask(change.before, redaction),
    after: change.after === null ? null : redactTask(change.after, redaction),
  }));
  return result;
};

const redactSettings = (settings: AppSettings, redaction: ExportRedaction): AppSettings => {
  const result = clone(settings);
  delete result.ai.credentialId;
  delete result.feishu.tokenCredentialId;
  delete result.feishu.appSecretCredentialId;
  try {
    const endpoint = new URL(result.ai.endpoint);
    if (endpoint.username || endpoint.password) {
      endpoint.username = '';
      endpoint.password = '';
      result.ai.endpoint = endpoint.toString();
    }
  } catch {
    // Strict import validation below fails closed for malformed endpoints.
  }
  if (redaction !== 'none') {
    result.floating.positions = {};
    result.persona.userName = '';
    result.feishu.accountId = 'primary';
  }
  if (redaction === 'strict') {
    result.persona.name = REDACTED;
    result.ai.model = '';
    result.feishu.configured = false;
    result.feishu.clientId = '';
    result.feishu.relayBaseUrl = '';
  }
  return result;
};

const redactAudit = (records: readonly AuditRecord[], redaction: ExportRedaction): AuditRecord[] => {
  const redacted = records.map((input) => {
    const record = clone(input);
    if (redaction !== 'none') {
      delete record.arguments;
      delete record.effects;
      delete record.details;
    }
    if (redaction === 'strict') {
      record.runId = REDACTED;
      delete record.invocationId;
      delete record.grantId;
      delete record.policyReason;
    }
    return scrubCredentials(record) as AuditRecord;
  });
  return rehashAudit(redacted);
};

const categoryPlan = (
  incomingIds: readonly string[],
  existingIds: ReadonlySet<string>,
  strategy: ImportConflictStrategy,
): ImportCategoryPlan => {
  const conflicts = incomingIds.filter((id) => existingIds.has(id));
  return {
    incoming: incomingIds.length,
    conflicts,
    create: incomingIds.length - conflicts.length,
    overwrite: strategy === 'overwrite' ? conflicts.length : 0,
    skip: strategy === 'skip' ? conflicts.length : 0,
    copy: strategy === 'copy' ? conflicts.length : 0,
  };
};

const planImport = (
  bundle: PortableDataBundle,
  current: DataPortabilitySnapshot,
  strategy: ImportConflictStrategy,
): DataImportPreview => {
  const tasks = categoryPlan(
    (bundle.data.tasks ?? []).map(({ id }) => id),
    new Set(Object.keys(current.taskState.tasks)),
    strategy,
  );
  const drafts = categoryPlan(
    (bundle.data.drafts ?? []).map(({ id }) => id),
    new Set(Object.keys(current.taskState.drafts)),
    strategy,
  );
  const operations = categoryPlan(
    (bundle.data.operations ?? []).map(({ id }) => id),
    new Set(current.taskState.operations.map(({ id }) => id)),
    strategy,
  );
  const settingsIncluded = bundle.data.settings !== undefined;
  const settingsDiffers = settingsIncluded && !same(bundle.data.settings, current.settings);
  const auditIncoming = bundle.data.permissionAudit?.length ?? 0;
  const auditExisting = current.permissionAudit.length;
  const warnings: string[] = [];
  if (strategy === 'copy' && settingsIncluded && settingsDiffers) {
    warnings.push('设置是单例数据，复制策略会保留当前设置。');
  }
  if (auditIncoming > 0 && auditExisting > 0 && strategy !== 'overwrite') {
    warnings.push('权限审计是哈希链，不能复制或拼接；当前审计记录会被保留。');
  }
  return {
    digest: digest({ bundle, strategy, current }),
    strategy,
    exportedAt: bundle.exportedAt,
    redaction: bundle.redaction,
    tasks,
    drafts,
    operations,
    settings: {
      included: settingsIncluded,
      differs: settingsDiffers,
      action: !settingsIncluded || !settingsDiffers
        ? 'none'
        : strategy === 'overwrite'
          ? 'overwrite'
          : 'skip',
    },
    permissionAudit: {
      incoming: auditIncoming,
      existing: auditExisting,
      action: auditIncoming === 0
        ? 'none'
        : auditExisting === 0 || strategy === 'overwrite'
          ? 'replace'
          : 'skip',
    },
    warnings,
  };
};

const remapTask = (task: Task, taskIds: ReadonlyMap<string, string>): Task => {
  const result = clone(task);
  result.id = taskIds.get(result.id) ?? result.id;
  if (result.parentId !== undefined) result.parentId = taskIds.get(result.parentId) ?? result.parentId;
  result.dependencyIds = result.dependencyIds.map((id) => taskIds.get(id) ?? id);
  if (result.recurrenceSeriesId !== undefined) {
    result.recurrenceSeriesId = taskIds.get(result.recurrenceSeriesId) ?? result.recurrenceSeriesId;
  }
  return result;
};

const remapOperation = (
  operation: TaskOperation,
  id: string,
  taskIds: ReadonlyMap<string, string>,
): TaskOperation => ({
  ...clone(operation),
  id,
  changes: operation.changes.map((change) => ({
    taskId: taskIds.get(change.taskId) ?? change.taskId,
    before: change.before === null ? null : remapTask(change.before, taskIds),
    after: change.after === null ? null : remapTask(change.after, taskIds),
  })),
});

export class DataPortabilityService {
  readonly #repository: DataPortabilityRepository;
  readonly #now: () => Date;
  readonly #maxImportBytes: number;
  readonly #createCopyId: NonNullable<DataPortabilityServiceOptions['createCopyId']>;

  constructor(options: DataPortabilityServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#maxImportBytes = options.maxImportBytes ?? 25 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxImportBytes) || this.#maxImportBytes < 1) {
      throw new TypeError('maxImportBytes must be a positive safe integer.');
    }
    this.#createCopyId = options.createCopyId ?? ((kind) => `${kind}_${randomUUID()}_copy`);
  }

  async createExport(options: DataExportOptions = {}): Promise<PortableDataBundle> {
    const snapshot = await this.#repository.readSnapshot();
    const include = { ...DEFAULT_SELECTION, ...options.include };
    const redaction = options.redaction ?? 'none';
    const data: PortableDataPayload = {};
    if (include.tasks) {
      data.tasks = Object.values(snapshot.taskState.tasks).map((task) => redactTask(task, redaction));
    }
    if (include.drafts) {
      data.drafts = Object.values(snapshot.taskState.drafts).map((draft) => redactDraft(draft, redaction));
    }
    if (include.operations) {
      data.operations = snapshot.taskState.operations.map((operation) => redactOperation(operation, redaction));
    }
    if (include.settings) data.settings = redactSettings(snapshot.settings, redaction);
    if (include.permissionAudit) data.permissionAudit = redactAudit(snapshot.permissionAudit, redaction);

    const bundle = scrubCredentials({
      format: PORTABLE_DATA_FORMAT,
      schemaVersion: 1,
      exportedAt: this.#now().toISOString(),
      redaction,
      data,
    }) as PortableDataBundle;
    // The same strict parser used for hostile files verifies that our output is
    // round-trippable and credential-free before it leaves the service.
    return parseBundle(JSON.stringify(bundle), this.#maxImportBytes);
  }

  async exportJson(options: DataExportOptions = {}): Promise<string> {
    const bundle = await this.createExport(options);
    return `${JSON.stringify(bundle, null, options.pretty === false ? 0 : 2)}\n`;
  }

  async previewImport(
    json: string,
    strategy: ImportConflictStrategy,
  ): Promise<DataImportPreview> {
    this.#assertStrategy(strategy);
    const bundle = parseBundle(json, this.#maxImportBytes);
    return planImport(bundle, await this.#repository.readSnapshot(), strategy);
  }

  async importJson(json: string, options: DataImportOptions): Promise<DataImportResult> {
    this.#assertStrategy(options.strategy);
    const bundle = parseBundle(json, this.#maxImportBytes);
    return this.#repository.transact((draft) => {
      const preview = planImport(bundle, draft, options.strategy);
      if (
        options.expectedDigest !== undefined &&
        options.expectedDigest !== preview.digest
      ) {
        throw new DataImportPreviewMismatchError();
      }
      const usedTaskIds = new Set([
        ...Object.keys(draft.taskState.tasks),
        ...(bundle.data.tasks ?? []).map(({ id }) => id),
      ]);
      const taskIds = new Map<string, string>();
      if (options.strategy === 'copy') {
        preview.tasks.conflicts.forEach((id) => {
          const copyId = this.#uniqueCopyId('task', id, usedTaskIds);
          taskIds.set(id, copyId);
          usedTaskIds.add(copyId);
        });
      }
      for (const task of bundle.data.tasks ?? []) {
        const conflict = draft.taskState.tasks[task.id] !== undefined;
        if (conflict && options.strategy === 'skip') continue;
        const imported = remapTask(task, taskIds);
        draft.taskState.tasks[imported.id] = imported;
      }

      const usedDraftIds = new Set([
        ...Object.keys(draft.taskState.drafts),
        ...(bundle.data.drafts ?? []).map(({ id }) => id),
      ]);
      for (const source of bundle.data.drafts ?? []) {
        const conflict = draft.taskState.drafts[source.id] !== undefined;
        if (conflict && options.strategy === 'skip') continue;
        const imported = clone(source);
        if (conflict && options.strategy === 'copy') {
          imported.id = this.#uniqueCopyId('draft', source.id, usedDraftIds);
          usedDraftIds.add(imported.id);
        }
        if (imported.taskId !== undefined) imported.taskId = taskIds.get(imported.taskId) ?? imported.taskId;
        draft.taskState.drafts[imported.id] = imported;
      }

      const usedOperationIds = new Set([
        ...draft.taskState.operations.map(({ id }) => id),
        ...(bundle.data.operations ?? []).map(({ id }) => id),
      ]);
      for (const source of bundle.data.operations ?? []) {
        const existingIndex = draft.taskState.operations.findIndex(({ id }) => id === source.id);
        if (existingIndex >= 0 && options.strategy === 'skip') continue;
        const operationId = existingIndex >= 0 && options.strategy === 'copy'
          ? this.#uniqueCopyId('operation', source.id, usedOperationIds)
          : source.id;
        usedOperationIds.add(operationId);
        const imported = remapOperation(source, operationId, taskIds);
        if (existingIndex >= 0 && options.strategy === 'overwrite') {
          draft.taskState.operations[existingIndex] = imported;
        } else {
          draft.taskState.operations.push(imported);
        }
      }

      if (preview.settings.action === 'overwrite' && bundle.data.settings !== undefined) {
        draft.settings = clone(bundle.data.settings);
      }
      if (preview.permissionAudit.action === 'replace') {
        draft.permissionAudit = clone(bundle.data.permissionAudit ?? []);
      }

      return {
        digest: preview.digest,
        strategy: options.strategy,
        tasks: this.#withoutConflicts(preview.tasks),
        drafts: this.#withoutConflicts(preview.drafts),
        operations: this.#withoutConflicts(preview.operations),
        settings: preview.settings.action === 'overwrite'
          ? 'overwritten'
          : preview.settings.action === 'skip'
            ? 'skipped'
            : 'none',
        permissionAudit: preview.permissionAudit.action === 'replace'
          ? 'replaced'
          : preview.permissionAudit.action === 'skip'
            ? 'skipped'
            : 'none',
        copiedTaskIds: Object.fromEntries(taskIds),
      } satisfies DataImportResult;
    });
  }

  #uniqueCopyId(
    kind: 'task' | 'draft' | 'operation',
    originalId: string,
    used: ReadonlySet<string>,
  ): string {
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const id = this.#createCopyId(kind, originalId, attempt);
      if (SAFE_ID.test(id) && !dangerousKey(id) && !used.has(id)) return id;
    }
    throw new DataImportValidationError(`Unable to generate a unique ${kind} copy id`);
  }

  #withoutConflicts(plan: ImportCategoryPlan): Omit<ImportCategoryPlan, 'conflicts'> {
    const { conflicts: _conflicts, ...counts } = plan;
    return counts;
  }

  #assertStrategy(strategy: string): asserts strategy is ImportConflictStrategy {
    if (!['skip', 'overwrite', 'copy'].includes(strategy)) {
      throw new DataImportValidationError('Unknown conflict strategy', '$.strategy');
    }
  }
}
