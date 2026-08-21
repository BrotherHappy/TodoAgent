import { createHash, randomUUID } from 'node:crypto';

import type { AuditRecord } from '../../src/shared/agent-types';
import type {
  LocalAppState,
  TaskProject,
  TaskProjectColor,
  TaskList,
  TaskListColor,
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
import {
  normalizeTaskAutomationRules,
  TASK_AUTOMATION_MAX_RULES,
} from '../../src/shared/task-automations';

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
  projects: boolean;
  lists: boolean;
  drafts: boolean;
  operations: boolean;
  settings: boolean;
  permissionAudit: boolean;
}

export interface PortableDataPayload {
  tasks?: Task[];
  projects?: TaskProject[];
  lists?: TaskList[];
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

/** Options for the human-readable Markdown export.  Markdown intentionally
 * has a smaller surface than the lossless JSON bundle: it contains tasks and
 * their project/list context, and can optionally include a safe, snapshot-free
 * task event timeline. Drafts, settings and permission-audit records are
 * never included. */
export interface DataMarkdownExportOptions {
  include?: Pick<Partial<PortableDataSelection>, 'tasks' | 'projects' | 'lists' | 'operations'>;
  redaction?: ExportRedaction;
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
  projects: ImportCategoryPlan;
  lists: ImportCategoryPlan;
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
  projects: Omit<ImportCategoryPlan, 'conflicts'>;
  lists: Omit<ImportCategoryPlan, 'conflicts'>;
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
    kind: 'task' | 'project' | 'list' | 'draft' | 'operation',
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
  projects: true,
  lists: true,
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

const validateProject = (value: unknown, path: string): TaskProject => {
  const project = expectRecord(value, path);
  assertOnlyKeys(project, ['id', 'name', 'color', 'archived', 'privateOrder', 'createdAt', 'updatedAt'], path);
  expectId(project.id, `${path}.id`);
  const name = expectString(project.name, `${path}.name`, false).trim();
  if (name.length > 80) throw new DataImportValidationError('Project name is too long', `${path}.name`);
  expectEnum(project.color, ['violet', 'blue', 'green', 'amber', 'rose', 'slate'] as const satisfies readonly TaskProjectColor[], `${path}.color`);
  expectBoolean(project.archived, `${path}.archived`);
  expectNumber(project.privateOrder, `${path}.privateOrder`, { minimum: 0 });
  expectIsoDateTime(project.createdAt, `${path}.createdAt`);
  expectIsoDateTime(project.updatedAt, `${path}.updatedAt`);
  return clone({ ...project, name }) as unknown as TaskProject;
};

const validateList = (value: unknown, path: string): TaskList => {
  const list = expectRecord(value, path);
  assertOnlyKeys(list, ['id', 'name', 'color', 'archived', 'privateOrder', 'createdAt', 'updatedAt'], path);
  expectId(list.id, `${path}.id`);
  const name = expectString(list.name, `${path}.name`, false).trim();
  if (name.length > 80) throw new DataImportValidationError('List name is too long', `${path}.name`);
  expectEnum(list.color, ['violet', 'blue', 'green', 'amber', 'rose', 'slate'] as const satisfies readonly TaskListColor[], `${path}.color`);
  expectBoolean(list.archived, `${path}.archived`);
  expectNumber(list.privateOrder, `${path}.privateOrder`, { minimum: 0 });
  expectIsoDateTime(list.createdAt, `${path}.createdAt`);
  expectIsoDateTime(list.updatedAt, `${path}.updatedAt`);
  return clone({ ...list, name }) as unknown as TaskList;
};

const validateTask = (value: unknown, path: string): Task => {
  const task = expectRecord(value, path);
  assertOnlyKeys(task, [
    'id', 'source', 'title', 'notes', 'privateNotes', 'status', 'priority', 'flagged', 'deferUntil',
    'projectId', 'listId', 'sectionId', 'tags', 'contexts', 'parentId', 'dependencyIds',
    'assigneeIds', 'followerIds', 'attachments', 'links', 'customFields', 'comments', 'researchCards',
    'plannedDate', 'startAt', 'startAtIsAllDay', 'dueAt', 'dueAtIsAllDay',
    'timeBlock', 'reminders', 'completedAt',
    'recurrence', 'recurrenceSeriesId', 'recurrenceIndex', 'estimatedMinutes',
    'actualMinutes', 'focusStartedAt', 'focusElapsedSeconds', 'focusSessions',
    'privateOrder', 'completionMode', 'currentUserRole', 'currentUserCompleted',
    'sync', 'createdAt', 'updatedAt', 'deletedAt',
  ], path);
  expectId(task.id, `${path}.id`);
  const source = expectRecord(task.source, `${path}.source`);
  // syncIdentityId is deliberately not portable. Accepting a caller-supplied
  // owner digest would let an imported task enter an existing provider queue.
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
  expectOptional(task, 'flagged', path, expectBoolean);
  expectOptional(task, 'deferUntil', path, expectLocalDate);
  ['projectId', 'listId', 'sectionId', 'parentId', 'recurrenceSeriesId'].forEach((key) =>
    expectOptional(task, key, path, expectId),
  );
  expectStringArray(task.tags, `${path}.tags`);
  expectOptional(task, 'contexts', path, (value, valuePath) => {
    const contexts = expectStringArray(value, valuePath);
    if (contexts.length > 20) {
      throw new DataImportValidationError('Too many contexts', valuePath);
    }
    const normalized = contexts.map((entry) => entry.trim().toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      throw new DataImportValidationError('Duplicate contexts', valuePath);
    }
    contexts.forEach((entry, index) => {
      if (entry.trim().length === 0 || entry.trim().length > 40) {
        throw new DataImportValidationError('Context must be 1-40 characters', `${valuePath}[${index}]`);
      }
    });
  });
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
  if (task.comments !== undefined) {
    if (!Array.isArray(task.comments)) {
      throw new DataImportValidationError('Expected an array', `${path}.comments`);
    }
    if (task.comments.length > 100) {
      throw new DataImportValidationError('Too many comments', `${path}.comments`);
    }
    const commentIds = new Set<string>();
    task.comments.forEach((entry, index) => {
      const commentPath = `${path}.comments[${index}]`;
      const comment = expectRecord(entry, commentPath);
      assertOnlyKeys(comment, ['id', 'body', 'author', 'createdAt', 'updatedAt'], commentPath);
      const id = expectId(comment.id, `${commentPath}.id`);
      if (commentIds.has(id)) {
        throw new DataImportValidationError('Duplicate comment id', `${commentPath}.id`);
      }
      commentIds.add(id);
      const body = expectString(comment.body, `${commentPath}.body`, false).trim();
      if (body.length > 10_000) {
        throw new DataImportValidationError('Comment body is too long', `${commentPath}.body`);
      }
      expectEnum(comment.author, ['user', 'agent'] as const, `${commentPath}.author`);
      const createdAt = expectIsoDateTime(comment.createdAt, `${commentPath}.createdAt`);
      const updatedAt = expectIsoDateTime(comment.updatedAt, `${commentPath}.updatedAt`);
      if (Date.parse(updatedAt) < Date.parse(createdAt)) {
        throw new DataImportValidationError('Comment updatedAt is before createdAt', commentPath);
      }
      comment.body = body;
    });
  }
  if (task.researchCards !== undefined) {
    if (!Array.isArray(task.researchCards)) {
      throw new DataImportValidationError('Expected an array', `${path}.researchCards`);
    }
    if (task.researchCards.length > 20) {
      throw new DataImportValidationError('Too many research cards', `${path}.researchCards`);
    }
    const cardIds = new Set<string>();
    task.researchCards.forEach((entry, index) => {
      const cardPath = `${path}.researchCards[${index}]`;
      const card = expectRecord(entry, cardPath);
      assertOnlyKeys(card, ['id', 'title', 'url', 'summary', 'actionItems', 'capturedAt'], cardPath);
      const id = expectId(card.id, `${cardPath}.id`);
      if (cardIds.has(id)) {
        throw new DataImportValidationError('Duplicate research card id', `${cardPath}.id`);
      }
      cardIds.add(id);
      const title = expectString(card.title, `${cardPath}.title`, false).trim();
      if (title.length > 200) {
        throw new DataImportValidationError('Research card title is too long', `${cardPath}.title`);
      }
      expectOptional(card, 'url', cardPath, expectSafeWebUrl);
      const summary = expectString(card.summary, `${cardPath}.summary`).trim();
      if (summary.length > 5_000) {
        throw new DataImportValidationError('Research card summary is too long', `${cardPath}.summary`);
      }
      if (!Array.isArray(card.actionItems)) {
        throw new DataImportValidationError('Expected an array', `${cardPath}.actionItems`);
      }
      if (card.actionItems.length > 20) {
        throw new DataImportValidationError('Too many research card action items', `${cardPath}.actionItems`);
      }
      card.actionItems = card.actionItems.map((item, actionIndex) => {
        const text = expectString(item, `${cardPath}.actionItems[${actionIndex}]`, false).trim();
        if (text.length > 500) {
          throw new DataImportValidationError('Research card action item is too long', `${cardPath}.actionItems[${actionIndex}]`);
        }
        return text;
      });
      expectIsoDateTime(card.capturedAt, `${cardPath}.capturedAt`);
      card.title = title;
      card.summary = summary;
    });
  }
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
    'create', 'update', 'complete', 'reopen', 'bulk', 'move-to-today', 'focus',
    'skip-recurring', 'reorder-today', 'plan-today', 'trash', 'restore', 'purge',
  ] as const, `${path}.kind`);
  expectIsoDateTime(operation.createdAt, `${path}.createdAt`);
  expectOptional(operation, 'undoneAt', path, expectIsoDateTime);
  if (!Array.isArray(operation.changes)) {
    throw new DataImportValidationError('Expected an array', `${path}.changes`);
  }
  const changedTaskIds = new Set<string>();
  operation.changes.forEach((entry, index) => {
    const changePath = `${path}.changes[${index}]`;
    const change = expectRecord(entry, changePath);
    assertOnlyKeys(change, ['taskId', 'before', 'after'], changePath);
    const taskId = expectId(change.taskId, `${changePath}.taskId`);
    if (changedTaskIds.has(taskId)) {
      throw new DataImportValidationError(
        'Operation contains duplicate task changes',
        `${changePath}.taskId`,
      );
    }
    changedTaskIds.add(taskId);
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
    if (operation.kind === 'plan-today') {
      if (change.before === null || change.after === null) {
        throw new DataImportValidationError(
          'Today plan changes require both snapshots',
          changePath,
        );
      }
      const allowedFields = new Set([
        'plannedDate',
        'privateOrder',
        'estimatedMinutes',
        'updatedAt',
      ]);
      const before = change.before as Record<string, unknown>;
      const after = change.after as Record<string, unknown>;
      for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!allowedFields.has(field) && !same(before[field], after[field])) {
          throw new DataImportValidationError(
            `Today plan operation changes shared field: ${field}`,
            changePath,
          );
        }
      }
    }
  });
  return clone(operation) as unknown as TaskOperation;
};

const validateSettings = (value: unknown, path: string): AppSettings => {
  const settings = expectRecord(value, path);
  assertOnlyKeys(settings, [
    'schemaVersion', 'theme', 'launchAtLogin', 'closeToTray', 'quickCaptureShortcut',
    'notifications', 'floating', 'focus', 'planning', 'weather', 'pet', 'ai', 'feishu', 'modelDataScope', 'agentCapabilities', 'persona', 'automations', 'permissionMode',
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
    'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
    'dailyTaskReminderLimit', 'taskIgnoreBackoffEnabled',
    'taskReminderMinIntervalMinutes', 'taskReminderSourceMode', 'taskReminderProjectMode', 'mutedUntil',
  ], `${path}.notifications`);
  ['enabled', 'sound', 'banners', 'badge', 'morningBrief', 'quietHoursEnabled'].forEach((key) =>
    expectBoolean(notifications[key], `${path}.notifications.${key}`),
  );
  ['morningBriefTime', 'quietHoursStart', 'quietHoursEnd'].forEach((key) => {
    const time = expectString(notifications[key], `${path}.notifications.${key}`);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new DataImportValidationError('Expected HH:mm', `${path}.notifications.${key}`);
  });
  expectOptional(notifications, 'dailyTaskReminderLimit', `${path}.notifications`, (entry, entryPath) =>
    expectNumber(entry, entryPath, { integer: true, minimum: 0, maximum: 50 }),
  );
  expectOptional(notifications, 'taskIgnoreBackoffEnabled', `${path}.notifications`, expectBoolean);
  expectOptional(notifications, 'taskReminderMinIntervalMinutes', `${path}.notifications`, (entry, entryPath) =>
    expectNumber(entry, entryPath, { integer: true, minimum: 0, maximum: 1_440 }),
  );
  expectOptional(notifications, 'taskReminderSourceMode', `${path}.notifications`, (entry, entryPath) => {
    const modes = expectRecord(entry, entryPath);
    assertOnlyKeys(modes, ['local', 'feishu'], entryPath);
    expectEnum(modes.local, ['normal', 'important-only', 'off'] as const, `${entryPath}.local`);
    expectEnum(modes.feishu, ['normal', 'important-only', 'off'] as const, `${entryPath}.feishu`);
  });
  expectOptional(notifications, 'taskReminderProjectMode', `${path}.notifications`, (entry, entryPath) => {
    const modes = expectRecord(entry, entryPath);
    if (Object.keys(modes).length > 100) {
      throw new DataImportValidationError('最多配置 100 个项目提醒策略', entryPath);
    }
    Object.entries(modes).forEach(([projectId, mode]) => {
      if (!projectId.trim() || projectId.length > 512) {
        throw new DataImportValidationError('项目 ID 长度无效', `${entryPath}.${projectId}`);
      }
      expectEnum(mode, ['normal', 'important-only', 'off'] as const, `${entryPath}.${projectId}`);
    });
  });
  expectOptional(notifications, 'mutedUntil', `${path}.notifications`, expectIsoDateTime);

  const floating = expectRecord(settings.floating, `${path}.floating`);
  assertOnlyKeys(floating, ['enabled', 'hoverExpandDelayMs', 'topMode', 'locked', 'hideInFullscreen', 'privacyMode', 'selectedTab', 'scalePercent', 'lastDisplayId', 'positions', 'mousePassthrough', 'shape'], `${path}.floating`);
  ['enabled', 'locked', 'hideInFullscreen', 'privacyMode'].forEach((key) =>
    expectBoolean(floating[key], `${path}.floating.${key}`),
  );
  if (floating.mousePassthrough !== undefined) {
    expectBoolean(floating.mousePassthrough, `${path}.floating.mousePassthrough`);
  }
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

  const focus = settings.focus === undefined
    ? expectRecord(clone(defaultSettings.focus), `${path}.focus`)
    : expectRecord(settings.focus, `${path}.focus`);
  assertOnlyKeys(focus, [
    'focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'cycles',
    'autoStartBreak', 'autoStartNextRound', 'environmentSound',
    'shieldMode', 'shieldApplications',
  ], `${path}.focus`);
  expectNumber(focus.focusMinutes, `${path}.focus.focusMinutes`, { integer: true, minimum: 1, maximum: 240 });
  expectNumber(focus.shortBreakMinutes, `${path}.focus.shortBreakMinutes`, { integer: true, minimum: 1, maximum: 60 });
  expectNumber(focus.longBreakMinutes, `${path}.focus.longBreakMinutes`, { integer: true, minimum: 1, maximum: 120 });
  expectNumber(focus.cycles, `${path}.focus.cycles`, { integer: true, minimum: 1, maximum: 12 });
  expectBoolean(focus.autoStartBreak, `${path}.focus.autoStartBreak`);
  expectBoolean(focus.autoStartNextRound, `${path}.focus.autoStartNextRound`);
  expectEnum(focus.environmentSound, ['off', 'rain', 'forest', 'cafe', 'white-noise'] as const, `${path}.focus.environmentSound`);
  const shieldMode = focus.shieldMode === undefined
    ? defaultSettings.focus.shieldMode
    : expectEnum(focus.shieldMode, ['off', 'gentle', 'pause'] as const, `${path}.focus.shieldMode`);
  const shieldApplications = focus.shieldApplications === undefined
    ? []
    : (() => {
        if (!Array.isArray(focus.shieldApplications)) {
          throw new DataImportValidationError('Expected an array', `${path}.focus.shieldApplications`);
        }
        return focus.shieldApplications.map((entry, index) => {
          const value = expectString(entry, `${path}.focus.shieldApplications[${index}]`, false).trim();
          if (value.length > 80) {
            throw new DataImportValidationError('Application name is too long', `${path}.focus.shieldApplications[${index}]`);
          }
          return value;
        });
      })();

  const planning = settings.planning === undefined
    ? expectRecord(clone(defaultSettings.planning), `${path}.planning`)
    : expectRecord(settings.planning, `${path}.planning`);
  assertOnlyKeys(planning, ['urgencyWeights'], `${path}.planning`);
  const urgencyWeights = expectRecord(planning.urgencyWeights, `${path}.planning.urgencyWeights`);
  assertOnlyKeys(urgencyWeights, ['deadline', 'plannedToday', 'priority', 'quickWin'], `${path}.planning.urgencyWeights`);
  Object.keys(defaultSettings.planning.urgencyWeights).forEach((key) =>
    expectNumber(urgencyWeights[key], `${path}.planning.urgencyWeights.${key}`, {
      integer: true,
      minimum: 0,
      maximum: 100,
    }),
  );

  const weather = settings.weather === undefined
    ? expectRecord(clone(defaultSettings.weather), `${path}.weather`)
    : expectRecord(settings.weather, `${path}.weather`);
  assertOnlyKeys(weather, [
    'enabled', 'city', 'latitude', 'longitude', 'resolvedName', 'cacheMinutes',
  ], `${path}.weather`);
  expectBoolean(weather.enabled, `${path}.weather.enabled`);
  expectString(weather.city, `${path}.weather.city`);
  if (weather.latitude !== undefined) expectNumber(weather.latitude, `${path}.weather.latitude`, { minimum: -90, maximum: 90 });
  if (weather.longitude !== undefined) expectNumber(weather.longitude, `${path}.weather.longitude`, { minimum: -180, maximum: 180 });
  expectOptional(weather, 'resolvedName', `${path}.weather`, expectString);
  expectNumber(weather.cacheMinutes, `${path}.weather.cacheMinutes`, { integer: true, minimum: 30, maximum: 120 });

  const importedPet = settings.pet === undefined
    ? {}
    : expectRecord(settings.pet, `${path}.pet`);
  assertOnlyKeys(importedPet, [
    'interactionsEnabled', 'proactiveMessages', 'inputReactionsEnabled', 'vacationMode', 'wellbeingReminders',
    'autoDiary', 'relationshipMemory', 'actionPack', 'animationIntensity',
    'proactiveIntervalMinutes', 'proactiveDailyLimit', 'meetingMode', 'seasonalEvents',
  ], `${path}.pet`);
  const pet = {
    ...clone(defaultSettings.pet),
    ...importedPet,
  };
  ([
    'interactionsEnabled', 'proactiveMessages', 'inputReactionsEnabled', 'vacationMode', 'wellbeingReminders',
    'autoDiary', 'relationshipMemory', 'meetingMode', 'seasonalEvents',
  ] as const).forEach((key) =>
    expectBoolean(pet[key], `${path}.pet.${key}`),
  );
  expectEnum(
    pet.actionPack,
    ['balanced', 'calm', 'playful', 'focused'] as const,
    `${path}.pet.actionPack`,
  );
  expectEnum(
    pet.animationIntensity,
    ['gentle', 'lively'] as const,
    `${path}.pet.animationIntensity`,
  );
  expectNumber(
    pet.proactiveIntervalMinutes,
    `${path}.pet.proactiveIntervalMinutes`,
    { integer: true, minimum: 15, maximum: 240 },
  );
  expectNumber(
    pet.proactiveDailyLimit,
    `${path}.pet.proactiveDailyLimit`,
    { integer: true, minimum: 0, maximum: 20 },
  );

  const ai = expectRecord(settings.ai, `${path}.ai`);
  assertOnlyKeys(ai, [
    'enabled', 'endpoint', 'model', 'authMode', 'routing', 'fallback',
    'timeoutMs', 'retries', 'dailyTokenLimit', 'dailyCostLimit', 'pricing',
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
  if (ai.routing !== undefined) {
    expectEnum(
      ai.routing,
      ['primary-only', 'fallback-on-error', 'local-only'] as const,
      `${path}.ai.routing`,
    );
  }
  if (ai.fallback !== undefined) {
    const fallback = expectRecord(ai.fallback, `${path}.ai.fallback`);
    assertOnlyKeys(
      fallback,
      ['enabled', 'endpoint', 'model', 'authMode', 'pricing'],
      `${path}.ai.fallback`,
    );
    expectBoolean(fallback.enabled, `${path}.ai.fallback.enabled`);
    expectSafeWebUrl(fallback.endpoint, `${path}.ai.fallback.endpoint`);
    expectString(fallback.model, `${path}.ai.fallback.model`);
    if (fallback.authMode !== undefined) {
      expectEnum(
        fallback.authMode,
        ['bearer', 'none'] as const,
        `${path}.ai.fallback.authMode`,
      );
    }
    const pricing = fallback.pricing === undefined
      ? expectRecord(clone(defaultSettings.ai.fallback.pricing), `${path}.ai.fallback.pricing`)
      : expectRecord(fallback.pricing, `${path}.ai.fallback.pricing`);
    assertOnlyKeys(
      pricing,
      ['promptUsdPerMillionTokens', 'completionUsdPerMillionTokens'],
      `${path}.ai.fallback.pricing`,
    );
    expectNumber(
      pricing.promptUsdPerMillionTokens,
      `${path}.ai.fallback.pricing.promptUsdPerMillionTokens`,
      { minimum: 0, maximum: 100_000 },
    );
    expectNumber(
      pricing.completionUsdPerMillionTokens,
      `${path}.ai.fallback.pricing.completionUsdPerMillionTokens`,
      { minimum: 0, maximum: 100_000 },
    );
  }
  const pricing = ai.pricing === undefined
    ? expectRecord(clone(defaultSettings.ai.pricing), `${path}.ai.pricing`)
    : expectRecord(ai.pricing, `${path}.ai.pricing`);
  assertOnlyKeys(
    pricing,
    ['promptUsdPerMillionTokens', 'completionUsdPerMillionTokens'],
    `${path}.ai.pricing`,
  );
  expectNumber(
    pricing.promptUsdPerMillionTokens,
    `${path}.ai.pricing.promptUsdPerMillionTokens`,
    { minimum: 0, maximum: 100_000 },
  );
  expectNumber(
    pricing.completionUsdPerMillionTokens,
    `${path}.ai.pricing.completionUsdPerMillionTokens`,
    { minimum: 0, maximum: 100_000 },
  );
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
  const agentCapabilities: Record<string, unknown> = settings.agentCapabilities === undefined
    ? clone(defaultSettings.agentCapabilities) as unknown as Record<string, unknown>
    : expectRecord(settings.agentCapabilities, `${path}.agentCapabilities`);
  assertOnlyKeys(agentCapabilities, [
    'taskManagement', 'feishuSync', 'webResearch', 'filesAndTerminal', 'clipboardAndScreen',
  ], `${path}.agentCapabilities`);
  Object.keys(agentCapabilities).forEach((key) =>
    expectBoolean(agentCapabilities[key], `${path}.agentCapabilities.${key}`),
  );
  const persona = expectRecord(settings.persona, `${path}.persona`);
  assertOnlyKeys(persona, ['preset', 'name', 'userName', 'responseLength', 'proactiveLevel', 'reminderStrength', 'syncWithPet'], `${path}.persona`);
  expectEnum(persona.preset, ['minimal', 'warm', 'calm', 'strict'] as const, `${path}.persona.preset`);
  expectString(persona.name, `${path}.persona.name`);
  expectString(persona.userName, `${path}.persona.userName`);
  expectEnum(persona.responseLength, ['short', 'balanced', 'detailed'] as const, `${path}.persona.responseLength`);
  expectEnum(persona.proactiveLevel, ['quiet', 'balanced', 'active'] as const, `${path}.persona.proactiveLevel`);
  expectEnum(persona.reminderStrength, ['gentle', 'normal', 'firm'] as const, `${path}.persona.reminderStrength`);
  expectOptional(persona, 'syncWithPet', `${path}.persona`, expectBoolean);
  expectEnum(settings.permissionMode, ['read-only', 'standard', 'full-access'] as const, `${path}.permissionMode`);
  expectBoolean(settings.onboardingComplete, `${path}.onboardingComplete`);
  const automationRules = settings.automations === undefined
    ? []
    : (() => {
        if (!Array.isArray(settings.automations)) {
          throw new DataImportValidationError('Expected an array', `${path}.automations`);
        }
        if (settings.automations.length > TASK_AUTOMATION_MAX_RULES) {
          throw new DataImportValidationError(
            `最多导入 ${TASK_AUTOMATION_MAX_RULES} 条任务自动化规则`,
            `${path}.automations`,
          );
        }
        const normalized = normalizeTaskAutomationRules(settings.automations);
        if (normalized.length !== settings.automations.length) {
          throw new DataImportValidationError(
            '任务自动化规则包含无效或重复项',
            `${path}.automations`,
          );
        }
        return normalized;
      })();
  const validated = clone(settings) as unknown as AppSettings;
  validated.automations = automationRules;
  validated.notifications = {
    ...clone(defaultSettings.notifications),
    ...clone(notifications),
  } as AppSettings['notifications'];
  const { shape: _legacyShape, ...portableFloating } = floating;
  validated.floating = {
    ...clone(defaultSettings.floating),
    ...clone(portableFloating),
    topMode: 'always',
  } as AppSettings['floating'];
  validated.focus = {
    ...clone(defaultSettings.focus),
    ...clone(focus),
    shieldMode,
    shieldApplications,
  } as AppSettings['focus'];
  validated.planning = clone({
    urgencyWeights: clone(urgencyWeights),
  }) as unknown as AppSettings['planning'];
  validated.weather = clone(weather) as unknown as AppSettings['weather'];
  validated.pet = clone(pet) as unknown as AppSettings['pet'];
  validated.ai = {
    ...clone(defaultSettings.ai),
    ...clone(ai),
    pricing: {
      ...clone(defaultSettings.ai.pricing),
      ...(ai.pricing as Record<string, unknown>),
    },
    fallback: {
      ...clone(defaultSettings.ai.fallback),
      ...(ai.fallback as Record<string, unknown> | undefined),
      pricing: {
        ...clone(defaultSettings.ai.fallback.pricing),
        ...((ai.fallback as Record<string, unknown> | undefined)?.pricing as Record<string, unknown> | undefined),
      },
    },
  } as AppSettings['ai'];
  // The import format intentionally carries authentication *mode*, but never
  // an OS credential reference. Keep this explicit so later defaults cannot
  // silently reintroduce a credential identifier.
  delete validated.ai.credentialId;
  validated.feishu = {
    ...clone(defaultSettings.feishu),
    ...(settings.feishu === undefined ? {} : clone(settings.feishu)),
  } as AppSettings['feishu'];
  validated.persona = {
    ...clone(defaultSettings.persona),
    ...clone(persona),
    syncWithPet: persona.syncWithPet !== false,
  } as AppSettings['persona'];
  validated.agentCapabilities = {
    ...clone(defaultSettings.agentCapabilities),
    ...clone(agentCapabilities),
  } as AppSettings['agentCapabilities'];
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
  assertOnlyKeys(data, ['tasks', 'projects', 'lists', 'drafts', 'operations', 'settings', 'permissionAudit'], '$.data');
  const result: PortableDataBundle = {
    format: PORTABLE_DATA_FORMAT,
    schemaVersion: 1,
    exportedAt: bundle.exportedAt as string,
    redaction: bundle.redaction as ExportRedaction,
    data: {},
  };
  if (data.projects !== undefined) {
    if (!Array.isArray(data.projects)) throw new DataImportValidationError('Expected an array', '$.data.projects');
    result.data.projects = data.projects.map((project, index) => validateProject(project, `$.data.projects[${index}]`));
    assertUniqueIds(result.data.projects, '$.data.projects');
    const names = new Set<string>();
    result.data.projects.forEach((project, index) => {
      const normalized = project.name.toLocaleLowerCase();
      if (names.has(normalized)) throw new DataImportValidationError('Duplicate project name in import', `$.data.projects[${index}].name`);
      names.add(normalized);
    });
  }
  if (data.lists !== undefined) {
    if (!Array.isArray(data.lists)) throw new DataImportValidationError('Expected an array', '$.data.lists');
    result.data.lists = data.lists.map((list, index) => validateList(list, `$.data.lists[${index}]`));
    assertUniqueIds(result.data.lists, '$.data.lists');
    const names = new Set<string>();
    result.data.lists.forEach((list, index) => {
      const normalized = list.name.toLocaleLowerCase();
      if (names.has(normalized)) throw new DataImportValidationError('Duplicate list name in import', `$.data.lists[${index}].name`);
      names.add(normalized);
    });
  }
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
  // Provider identity bindings are device-local security metadata. Imports
  // must be claimed deliberately by the currently authorized identity.
  delete result.source.syncIdentityId;
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
    result.comments = [];
    result.researchCards = [];
  }
  if (redaction === 'strict') {
    result.title = REDACTED;
    delete result.projectId;
    delete result.listId;
    delete result.sectionId;
    result.tags = [];
    result.contexts = [];
    delete result.parentId;
    result.dependencyIds = [];
    result.assigneeIds = [];
    result.followerIds = [];
    result.source = { type: result.source.type };
    result.reminders = [];
  }
  return result;
};

const redactProject = (project: TaskProject, redaction: ExportRedaction): TaskProject => {
  const result = clone(project);
  // Keep strict exports collision-free when several projects are redacted;
  // the opaque id is not user content and is needed to preserve task links.
  if (redaction === 'strict') result.name = `${REDACTED} ${project.id}`;
  return result;
};

const redactList = (list: TaskList, redaction: ExportRedaction): TaskList => {
  const result = clone(list);
  if (redaction === 'strict') result.name = `${REDACTED} ${list.id}`;
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
  delete result.ai.fallback.credentialId;
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
  try {
    const endpoint = new URL(result.ai.fallback.endpoint);
    if (endpoint.username || endpoint.password) {
      endpoint.username = '';
      endpoint.password = '';
      result.ai.fallback.endpoint = endpoint.toString();
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
    result.ai.fallback.model = '';
    result.ai.fallback.enabled = false;
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

const markdownInline = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const markdownMultiline = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => `> ${line.length > 0 ? line : ' '}`)
    .join('\n');

const markdownDate = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC');
};

const markdownStatus = (status: Task['status']): string => {
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  return '待办';
};

const markdownPriority = (priority: Task['priority']): string | undefined => {
  const labels: Record<Task['priority'], string | undefined> = {
    none: undefined,
    low: '低',
    medium: '中',
    high: '高',
    urgent: '紧急',
  };
  return labels[priority];
};

const markdownSource = (task: Task): string =>
  task.source.type === 'feishu' ? '飞书' : '本地';

const markdownRecurrence = (task: Task): string | undefined => {
  const recurrence = task.recurrence;
  if (recurrence === undefined) return undefined;
  if (recurrence.frequency === 'daily') {
    return recurrence.interval === 1 ? '每天' : `每 ${recurrence.interval} 天`;
  }
  if (recurrence.frequency === 'monthly') {
    const day = recurrence.dayOfMonth === undefined ? '' : ` ${recurrence.dayOfMonth} 日`;
    return recurrence.interval === 1
      ? `每月${day}`.trim()
      : `每 ${recurrence.interval} 个月${day}`.trim();
  }
  const weekdays = recurrence.weekdays?.length
    ? `（周${recurrence.weekdays.map((day) => ['日', '一', '二', '三', '四', '五', '六'][day] ?? day).join('、')}）`
    : '';
  return recurrence.interval === 1
    ? `每周${weekdays}`
    : `每 ${recurrence.interval} 周${weekdays}`;
};

const markdownTaskSort = (left: Task, right: Task): number => {
  const statusRank = (task: Task): number =>
    task.status === 'open' ? 0 : task.status === 'completed' ? 1 : 2;
  const statusDifference = statusRank(left) - statusRank(right);
  if (statusDifference !== 0) return statusDifference;
  const leftDate = left.dueAt ?? left.plannedDate ?? left.startAt ?? '9999-12-31';
  const rightDate = right.dueAt ?? right.plannedDate ?? right.startAt ?? '9999-12-31';
  const dateDifference = leftDate.localeCompare(rightDate);
  if (dateDifference !== 0) return dateDifference;
  const orderDifference = left.privateOrder - right.privateOrder;
  if (orderDifference !== 0) return orderDifference;
  return left.title.localeCompare(right.title, 'zh-CN') || left.id.localeCompare(right.id);
};

const renderMarkdownTask = (
  task: Task,
  projects: ReadonlyMap<string, TaskProject>,
  lists: ReadonlyMap<string, TaskList>,
): string => {
  const checkbox = task.status === 'completed' ? 'x' : ' ';
  const title = markdownInline(task.title) || '未命名任务';
  const lines = [`- [${checkbox}] **${title}**`];
  const metadata: string[] = [
    `状态：${markdownStatus(task.status)}`,
    `来源：${markdownSource(task)}`,
  ];
  const priority = markdownPriority(task.priority);
  if (priority !== undefined) metadata.push(`优先级：${priority}`);
  if (task.flagged === true) metadata.push('重点标记');
  if (task.deferUntil !== undefined) metadata.push(`稍后：${task.deferUntil}`);
  if (task.projectId !== undefined) {
    metadata.push(`项目：${markdownInline(projects.get(task.projectId)?.name ?? task.projectId)}`);
  }
  if (task.listId !== undefined) {
    metadata.push(`清单：${markdownInline(lists.get(task.listId)?.name ?? task.listId)}`);
  }
  if (task.plannedDate !== undefined) metadata.push(`计划：${task.plannedDate}`);
  if (task.startAt !== undefined) metadata.push(`开始：${markdownDate(task.startAt) ?? task.startAt}`);
  if (task.dueAt !== undefined) metadata.push(`截止：${markdownDate(task.dueAt) ?? task.dueAt}`);
  if (task.estimatedMinutes !== undefined) metadata.push(`预计：${task.estimatedMinutes} 分钟`);
  if (task.actualMinutes !== undefined) metadata.push(`实际：${task.actualMinutes} 分钟`);
  const recurrence = markdownRecurrence(task);
  if (recurrence !== undefined) metadata.push(`循环：${recurrence}`);
  if (task.tags.length > 0) metadata.push(`标签：${task.tags.map((tag) => `#${markdownInline(tag)}`).join(' ')}`);
  if (task.contexts !== undefined && task.contexts.length > 0) {
    metadata.push(`情境：${task.contexts.map(markdownInline).join('、')}`);
  }
  lines.push(`  - ${metadata.join(' · ')}`);

  if (task.notes.trim().length > 0) {
    lines.push(`  - 备注：\n${markdownMultiline(task.notes.trim()).replace(/^/gm, '  ')}`);
  }
  if (task.privateNotes.trim().length > 0) {
    lines.push(`  - 私人备注：\n${markdownMultiline(task.privateNotes.trim()).replace(/^/gm, '  ')}`);
  }
  if (task.links.length > 0) {
    lines.push(`  - 链接：${task.links.map((link) => `[${markdownInline(link.label ?? link.url)}](${link.url})`).join('、')}`);
  }
  if (task.attachments.length > 0) {
    const attachments = task.attachments.map((attachment) => {
      const size = attachment.size === undefined ? '' : `，${attachment.size} B`;
      return `${markdownInline(attachment.name)}${attachment.mimeType ? `（${attachment.mimeType}${size}）` : size}`;
    });
    lines.push(`  - 附件：${attachments.join('、')}`);
  }
  return lines.join('\n');
};

const markdownOperationLabels: Record<TaskOperation['kind'], string> = {
  create: '创建任务',
  update: '更新任务',
  complete: '标记完成',
  reopen: '重新打开',
  bulk: '批量操作',
  'move-to-today': '移到今天',
  focus: '专注记录',
  'skip-recurring': '跳过本次循环',
  'reorder-today': '调整今日顺序',
  'plan-today': '安排今日计划',
  trash: '移入回收站',
  restore: '恢复任务',
  purge: '永久删除',
};

/**
 * Keep the event export useful without turning it into a second backup format.
 * These are the same user-facing fields used by the task inspector history;
 * internal timestamps, sync bookkeeping and provider metadata stay omitted.
 */
const markdownHistoryFields = [
  'title',
  'notes',
  'privateNotes',
  'status',
  'flagged',
  'deferUntil',
  'completedAt',
  'priority',
  'projectId',
  'listId',
  'sectionId',
  'tags',
  'contexts',
  'parentId',
  'dependencyIds',
  'assigneeIds',
  'followerIds',
  'attachments',
  'links',
  'customFields',
  'plannedDate',
  'startAt',
  'startAtIsAllDay',
  'dueAt',
  'dueAtIsAllDay',
  'timeBlock',
  'reminders',
  'recurrence',
  'recurrenceSeriesId',
  'recurrenceIndex',
  'estimatedMinutes',
  'actualMinutes',
  'focusElapsedSeconds',
  'focusSessions',
  'privateOrder',
  'completionMode',
  'currentUserRole',
  'currentUserCompleted',
] as const;

const markdownHistoryFieldLabels: Record<string, string> = {
  task: '任务记录',
  title: '标题',
  notes: '备注',
  privateNotes: '私人备注',
  status: '状态',
  flagged: '重点标记',
  deferUntil: '稍后日期',
  completedAt: '完成时间',
  priority: '优先级',
  projectId: '项目',
  listId: '清单',
  sectionId: '分组',
  tags: '标签',
  contexts: '情境',
  parentId: '父任务',
  dependencyIds: '依赖',
  assigneeIds: '负责人',
  followerIds: '关注人',
  attachments: '附件',
  links: '链接',
  customFields: '自定义字段',
  plannedDate: '计划日期',
  startAt: '开始时间',
  startAtIsAllDay: '全天开始',
  dueAt: '截止时间',
  dueAtIsAllDay: '全天截止',
  timeBlock: '时间块',
  reminders: '提醒',
  recurrence: '循环规则',
  recurrenceSeriesId: '循环系列',
  recurrenceIndex: '循环序号',
  estimatedMinutes: '预计时长',
  actualMinutes: '实际时长',
  focusElapsedSeconds: '专注时长',
  focusSessions: '专注次数',
  privateOrder: '排序',
  completionMode: '完成方式',
  currentUserRole: '我的角色',
  currentUserCompleted: '我的完成状态',
};

const markdownChangedFields = (before: Task | null, after: Task | null): string[] => {
  if (before === null || after === null) return ['task'];
  const beforeRecord = before as unknown as Record<string, unknown>;
  const afterRecord = after as unknown as Record<string, unknown>;
  return markdownHistoryFields.filter((field) =>
    JSON.stringify(beforeRecord[field]) !== JSON.stringify(afterRecord[field]),
  );
};

const renderMarkdownOperations = (
  operations: readonly TaskOperation[],
): string[] => {
  const lines = ['## 任务事件日志', '', '> 仅包含时间、操作类型、任务标识和字段摘要；不包含 before/after 快照。', ''];
  const ordered = [...operations].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  if (ordered.length === 0) {
    lines.push('暂无任务事件。', '');
    return lines;
  }
  ordered.forEach((operation) => {
    operation.changes.forEach((change) => {
      const task = change.after ?? change.before;
      const title = task?.title && task.title !== REDACTED
        ? markdownInline(task.title)
        : `任务 ${markdownInline(change.taskId)}`;
      const fields = markdownChangedFields(change.before, change.after)
        .map((field) => markdownHistoryFieldLabels[field] ?? field);
      const fieldSummary = fields.length > 0 ? ` · 字段：${fields.join('、')}` : '';
      const undone = operation.undoneAt === undefined ? '' : ' · 已撤销';
      lines.push(
        `- ${markdownDate(operation.createdAt) ?? operation.createdAt} · ${markdownOperationLabels[operation.kind] ?? operation.kind} · **${title}**（${change.taskId}）${fieldSummary}${undone}`,
      );
    });
  });
  lines.push('');
  return lines;
};

const renderMarkdownExport = (bundle: PortableDataBundle): string => {
  const tasks = [...(bundle.data.tasks ?? [])].sort(markdownTaskSort);
  const projects = new Map((bundle.data.projects ?? []).map((project) => [project.id, project]));
  const lists = new Map((bundle.data.lists ?? []).map((list) => [list.id, list]));
  const lines = [
    '# Todo Agent 任务导出',
    '',
    `> 导出时间：${bundle.exportedAt}`,
    `> 脱敏级别：${bundle.redaction === 'none' ? '不脱敏' : bundle.redaction === 'private' ? '私人内容已隐藏' : '严格脱敏'}`,
    '',
  ];

  if (projects.size > 0) {
    lines.push('## 项目', '');
    [...projects.values()]
      .filter((project) => !project.archived)
      .sort((left, right) => left.privateOrder - right.privateOrder || left.name.localeCompare(right.name, 'zh-CN'))
      .forEach((project) => lines.push(`- ${markdownInline(project.name)}`));
    lines.push('');
  }
  if (lists.size > 0) {
    lines.push('## 清单', '');
    [...lists.values()]
      .filter((list) => !list.archived)
      .sort((left, right) => left.privateOrder - right.privateOrder || left.name.localeCompare(right.name, 'zh-CN'))
      .forEach((list) => lines.push(`- ${markdownInline(list.name)}`));
    lines.push('');
  }

  const sections: Array<[Task['status'], string]> = [
    ['open', '待办'],
    ['completed', '已完成'],
    ['cancelled', '已取消'],
  ];
  if (tasks.length === 0) {
    lines.push('## 任务', '', '暂无任务。', '');
  } else {
    sections.forEach(([status, label]) => {
      const sectionTasks = tasks.filter((task) => task.status === status);
      if (sectionTasks.length === 0) return;
      lines.push(`## ${label}`, '');
      sectionTasks.forEach((task, index) => {
        lines.push(renderMarkdownTask(task, projects, lists));
        if (index < sectionTasks.length - 1) lines.push('');
      });
      lines.push('');
    });
  }
  if (bundle.data.operations !== undefined) {
    lines.push(...renderMarkdownOperations(bundle.data.operations));
  }
  lines.push(
    '---',
    '',
    '此文件由 Todo Agent 生成；凭据、访问令牌、本地文件路径和导入用审计链不会写入 Markdown。',
    ...(bundle.data.operations === undefined
      ? []
      : ['事件日志只含摘要，不包含任务快照。']),
    '',
  );
  return lines.join('\n');
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
  const projects = categoryPlan(
    (bundle.data.projects ?? []).map(({ id }) => id),
    new Set(Object.keys(current.taskState.projects ?? {})),
    strategy,
  );
  const lists = categoryPlan(
    (bundle.data.lists ?? []).map(({ id }) => id),
    new Set(Object.keys(current.taskState.lists ?? {})),
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
    projects,
    lists,
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

const remapTask = (
  task: Task,
  taskIds: ReadonlyMap<string, string>,
  projectIds: ReadonlyMap<string, string> = new Map(),
  listIds: ReadonlyMap<string, string> = new Map(),
): Task => {
  const result = clone(task);
  result.id = taskIds.get(result.id) ?? result.id;
  if (result.projectId !== undefined) result.projectId = projectIds.get(result.projectId) ?? result.projectId;
  if (result.listId !== undefined) result.listId = listIds.get(result.listId) ?? result.listId;
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
  projectIds: ReadonlyMap<string, string> = new Map(),
  listIds: ReadonlyMap<string, string> = new Map(),
): TaskOperation => ({
  ...clone(operation),
  id,
  changes: operation.changes.map((change) => ({
    taskId: taskIds.get(change.taskId) ?? change.taskId,
    before: change.before === null ? null : remapTask(change.before, taskIds, projectIds, listIds),
    after: change.after === null ? null : remapTask(change.after, taskIds, projectIds, listIds),
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
    if (include.projects) {
      data.projects = Object.values(snapshot.taskState.projects ?? {}).map((project) => redactProject(project, redaction));
    }
    if (include.lists) {
      data.lists = Object.values(snapshot.taskState.lists ?? {}).map((list) => redactList(list, redaction));
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

  async exportMarkdown(options: DataMarkdownExportOptions = {}): Promise<string> {
    const redaction = options.redaction ?? 'private';
    const bundle = await this.createExport({
      redaction,
      include: {
        tasks: options.include?.tasks ?? true,
        projects: options.include?.projects ?? true,
        lists: options.include?.lists ?? true,
        drafts: false,
        operations: options.include?.operations ?? false,
        settings: false,
        permissionAudit: false,
      },
    });
    return renderMarkdownExport(bundle);
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
      const usedProjectIds = new Set([
        ...Object.keys(draft.taskState.projects ?? {}),
        ...(bundle.data.projects ?? []).map(({ id }) => id),
      ]);
      const projectIds = new Map<string, string>();
      const usedListIds = new Set([
        ...Object.keys(draft.taskState.lists ?? {}),
        ...(bundle.data.lists ?? []).map(({ id }) => id),
      ]);
      const listIds = new Map<string, string>();
      if (options.strategy === 'copy') {
        preview.projects.conflicts.forEach((id) => {
          const copyId = this.#uniqueCopyId('project', id, usedProjectIds);
          projectIds.set(id, copyId);
          usedProjectIds.add(copyId);
        });
      }
      if (options.strategy === 'copy') {
        preview.lists.conflicts.forEach((id) => {
          const copyId = this.#uniqueCopyId('list', id, usedListIds);
          listIds.set(id, copyId);
          usedListIds.add(copyId);
        });
      }
      for (const source of bundle.data.projects ?? []) {
        const conflict = draft.taskState.projects?.[source.id] !== undefined;
        if (conflict && options.strategy === 'skip') continue;
        const imported = clone(source);
        if (conflict && options.strategy === 'copy') {
          imported.id = projectIds.get(source.id)!;
        }
        draft.taskState.projects[imported.id] = imported;
      }
      for (const source of bundle.data.lists ?? []) {
        const conflict = draft.taskState.lists?.[source.id] !== undefined;
        if (conflict && options.strategy === 'skip') continue;
        const imported = clone(source);
        if (conflict && options.strategy === 'copy') {
          imported.id = listIds.get(source.id)!;
        }
        draft.taskState.lists[imported.id] = imported;
      }
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
        const imported = remapTask(task, taskIds, projectIds, listIds);
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
        const imported = remapOperation(source, operationId, taskIds, projectIds, listIds);
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
        projects: this.#withoutConflicts(preview.projects),
        lists: this.#withoutConflicts(preview.lists),
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
    kind: 'task' | 'project' | 'list' | 'draft' | 'operation',
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
