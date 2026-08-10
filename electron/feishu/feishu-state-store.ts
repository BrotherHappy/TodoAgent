import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import type {
  FeishuApplicationConflict,
  FeishuApplicationQueueItem,
  FeishuApplicationSyncState,
  FeishuTaskMapping,
} from './feishu-sync-service';
import type {
  FeishuFieldConflict,
  FeishuSyncFieldValue,
  FeishuTaskSyncSnapshot,
} from '../../src/shared/feishu-types';
import type { FeishuTasklistBinding } from '../../src/shared/models';

export interface FeishuStateStoreOptions {
  directory: string;
  fileName?: string;
}

export class FeishuStateStoreCorruptionError extends Error {
  readonly causes: unknown[];

  constructor(message: string, causes: unknown[]) {
    super(message);
    this.name = 'FeishuStateStoreCorruptionError';
    this.causes = causes;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string.`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean.`);
  return value;
}

/**
 * Member snapshots were added after the first state-file format. Their
 * absence remains valid migration input; when present, rebuild a canonical
 * non-empty ID set rather than persisting malformed provider data.
 */
function optionalMemberIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${field} must be an array of strings.`);
  }
  const normalized = value.map((item) => item.trim());
  if (normalized.some((item) => item.length === 0)) {
    throw new TypeError(`${field} must not contain empty member IDs.`);
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function optionalTasklistBinding(
  value: unknown,
  field: string,
): FeishuTasklistBinding | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError(`${field} must be an object.`);
  const unknown = Object.keys(value).filter(
    (key) => key !== 'tasklistGuid' && key !== 'sectionGuid',
  );
  if (unknown.length > 0) {
    throw new TypeError(`${field} contains unknown properties.`);
  }
  const tasklistGuid = optionalString(value.tasklistGuid, `${field}.tasklistGuid`);
  const sectionGuid = optionalString(value.sectionGuid, `${field}.sectionGuid`);
  if (sectionGuid !== undefined && tasklistGuid === undefined) {
    throw new TypeError(`${field}.sectionGuid requires tasklistGuid.`);
  }
  return {
    ...(tasklistGuid === undefined ? {} : { tasklistGuid }),
    ...(sectionGuid === undefined ? {} : { sectionGuid }),
  };
}

function snapshot(value: unknown, field: string): FeishuTaskSyncSnapshot {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object.`);
  const status = requiredString(value.status, `${field}.status`);
  if (status !== 'open' && status !== 'completed') {
    throw new TypeError(`${field}.status is invalid.`);
  }
  const startAt = optionalString(value.startAt, `${field}.startAt`);
  const dueAt = optionalString(value.dueAt, `${field}.dueAt`);
  const startAtIsAllDay = optionalBoolean(
    value.startAtIsAllDay,
    `${field}.startAtIsAllDay`,
  );
  const dueAtIsAllDay = optionalBoolean(
    value.dueAtIsAllDay,
    `${field}.dueAtIsAllDay`,
  );
  if (startAtIsAllDay === true && startAt === undefined) {
    throw new TypeError(`${field}.startAtIsAllDay requires startAt.`);
  }
  if (dueAtIsAllDay === true && dueAt === undefined) {
    throw new TypeError(`${field}.dueAtIsAllDay requires dueAt.`);
  }
  const tasklist = optionalTasklistBinding(value.tasklist, `${field}.tasklist`);
  return {
    title: requiredString(value.title, `${field}.title`),
    notes:
      typeof value.notes === 'string'
        ? value.notes
        : (() => {
            throw new TypeError(`${field}.notes must be a string.`);
          })(),
    startAt,
    ...(startAtIsAllDay === true ? { startAtIsAllDay: true } : {}),
    dueAt,
    ...(dueAtIsAllDay === true ? { dueAtIsAllDay: true } : {}),
    status,
    assigneeIds: optionalMemberIds(value.assigneeIds, `${field}.assigneeIds`),
    followerIds: optionalMemberIds(value.followerIds, `${field}.followerIds`),
    ...(tasklist === undefined ? {} : { tasklist }),
  };
}

function mapping(value: unknown, field: string): FeishuTaskMapping {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object.`);
  return {
    localId: requiredString(value.localId, `${field}.localId`),
    guid: requiredString(value.guid, `${field}.guid`),
    base: snapshot(value.base, `${field}.base`),
    remoteVersion: optionalString(value.remoteVersion, `${field}.remoteVersion`),
    deleted: value.deleted === true ? true : undefined,
  };
}

function queueItem(value: unknown, field: string): FeishuApplicationQueueItem {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object.`);
  const kind = requiredString(value.kind, `${field}.kind`);
  if (!['create', 'update', 'delete', 'complete', 'reopen'].includes(kind)) {
    throw new TypeError(`${field}.kind is invalid.`);
  }
  if (
    typeof value.attempts !== 'number' ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0
  ) {
    throw new TypeError(`${field}.attempts must be a non-negative integer.`);
  }
  return {
    id: requiredString(value.id, `${field}.id`),
    localId: requiredString(value.localId, `${field}.localId`),
    kind: kind as FeishuApplicationQueueItem['kind'],
    clientToken: optionalString(value.clientToken, `${field}.clientToken`),
    createdAt: requiredString(value.createdAt, `${field}.createdAt`),
    attempts: value.attempts,
    lastError: optionalString(value.lastError, `${field}.lastError`),
  };
}

function fieldConflict(value: unknown, field: string): FeishuFieldConflict {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object.`);
  const name = requiredString(value.field, `${field}.field`);
  if (
    ![
      'title',
      'notes',
      'startAt',
      'dueAt',
      'status',
      'assigneeIds',
      'followerIds',
      'tasklist',
    ].includes(name)
  ) {
    throw new TypeError(`${field}.field is invalid.`);
  }
  const valueFor = (key: 'base' | 'local' | 'remote'): FeishuSyncFieldValue =>
    name === 'assigneeIds' || name === 'followerIds'
      ? optionalMemberIds(value[key], `${field}.${key}`)
      : name === 'tasklist'
        ? optionalTasklistBinding(value[key], `${field}.${key}`)
        : optionalString(value[key], `${field}.${key}`);
  const base = valueFor('base');
  const local = valueFor('local');
  const remote = valueFor('remote');
  const allDayFlag = (key: 'base' | 'local' | 'remote'): boolean | undefined =>
    name === 'startAt' || name === 'dueAt'
      ? optionalBoolean(value[`${key}IsAllDay`], `${field}.${key}IsAllDay`)
      : undefined;
  const baseIsAllDay = allDayFlag('base');
  const localIsAllDay = allDayFlag('local');
  const remoteIsAllDay = allDayFlag('remote');
  if (
    (baseIsAllDay === true && typeof base !== 'string') ||
    (localIsAllDay === true && typeof local !== 'string') ||
    (remoteIsAllDay === true && typeof remote !== 'string')
  ) {
    throw new TypeError(`${field} all-day metadata requires a timestamp.`);
  }
  const allDayMetadata =
    name === 'startAt' || name === 'dueAt'
      ? {
          ...(baseIsAllDay === true ? { baseIsAllDay: true } : {}),
          ...(localIsAllDay === true ? { localIsAllDay: true } : {}),
          ...(remoteIsAllDay === true ? { remoteIsAllDay: true } : {}),
        }
      : {};
  return {
    field: name as FeishuFieldConflict['field'],
    base,
    local,
    remote,
    ...allDayMetadata,
  };
}

function conflict(value: unknown, field: string): FeishuApplicationConflict {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object.`);
  if (!Array.isArray(value.fields)) {
    throw new TypeError(`${field}.fields must be an array.`);
  }
  return {
    localId: requiredString(value.localId, `${field}.localId`),
    guid: requiredString(value.guid, `${field}.guid`),
    base: snapshot(value.base, `${field}.base`),
    local: snapshot(value.local, `${field}.local`),
    remote: snapshot(value.remote, `${field}.remote`),
    fields: value.fields.map((item, index) =>
      fieldConflict(item, `${field}.fields[${index}]`),
    ),
    remoteVersion: optionalString(value.remoteVersion, `${field}.remoteVersion`),
    detectedAt: requiredString(value.detectedAt, `${field}.detectedAt`),
  };
}

/**
 * Parses and rebuilds a strict allow-list. Unknown properties—including any
 * accidentally attached access token, app secret or PKCE verifier—are dropped
 * before state is ever written back to disk.
 */
export function sanitizeFeishuSyncState(value: unknown): FeishuApplicationSyncState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new TypeError('Feishu sync state must use schema version 1.');
  }
  if (
    !isRecord(value.mappingsByLocalId) ||
    !isRecord(value.localIdByGuid) ||
    !Array.isArray(value.queue) ||
    !isRecord(value.conflicts)
  ) {
    throw new TypeError('Feishu sync state collections are invalid.');
  }

  const mappingsByLocalId: Record<string, FeishuTaskMapping> = {};
  for (const [key, item] of Object.entries(value.mappingsByLocalId)) {
    const parsed = mapping(item, `mappingsByLocalId.${key}`);
    if (parsed.localId !== key) {
      throw new TypeError(`Mapping key ${key} does not match localId.`);
    }
    mappingsByLocalId[key] = parsed;
  }

  const localIdByGuid: Record<string, string> = {};
  for (const [guid, localId] of Object.entries(value.localIdByGuid)) {
    localIdByGuid[guid] = requiredString(localId, `localIdByGuid.${guid}`);
  }
  for (const item of Object.values(mappingsByLocalId)) {
    if (localIdByGuid[item.guid] !== item.localId) {
      throw new TypeError(`Reverse mapping for ${item.guid} is inconsistent.`);
    }
  }

  const conflicts: Record<string, FeishuApplicationConflict> = {};
  for (const [key, item] of Object.entries(value.conflicts)) {
    const parsed = conflict(item, `conflicts.${key}`);
    if (parsed.localId !== key) {
      throw new TypeError(`Conflict key ${key} does not match localId.`);
    }
    conflicts[key] = parsed;
  }

  return {
    schemaVersion: 1,
    accountId: requiredString(value.accountId, 'accountId'),
    mappingsByLocalId,
    localIdByGuid,
    queue: value.queue.map((item, index) => queueItem(item, `queue[${index}]`)),
    conflicts,
    cursor: optionalString(value.cursor, 'cursor'),
    lastIncrementalSyncAt: optionalString(
      value.lastIncrementalSyncAt,
      'lastIncrementalSyncAt',
    ),
    lastFullSyncAt: optionalString(value.lastFullSyncAt, 'lastFullSyncAt'),
  };
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isRecord(error) ||
      !['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(String(error.code))
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export class FeishuStateStore {
  readonly directory: string;
  readonly filePath: string;
  readonly backupPath: string;
  private serial: Promise<void> = Promise.resolve();

  constructor(options: FeishuStateStoreOptions | string) {
    const normalized =
      typeof options === 'string' ? { directory: options } : options;
    const fileName = normalized.fileName ?? 'sync-state.v1.json';
    if (
      !fileName ||
      fileName === '.' ||
      fileName === '..' ||
      path.posix.basename(fileName) !== fileName ||
      path.win32.basename(fileName) !== fileName
    ) {
      throw new TypeError('Feishu state fileName must not contain a path.');
    }
    this.directory = path.resolve(normalized.directory);
    this.filePath = path.join(this.directory, fileName);
    this.backupPath = path.join(this.directory, `${fileName}.backup`);
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async load(): Promise<FeishuApplicationSyncState | undefined> {
    return this.enqueue(() => this.loadUnsafe());
  }

  async save(state: FeishuApplicationSyncState): Promise<void> {
    await this.enqueue(async () => {
      const sanitized = sanitizeFeishuSyncState(state);
      await mkdir(this.directory, { recursive: true });

      try {
        const previousText = await readFile(this.filePath, 'utf8');
        sanitizeFeishuSyncState(JSON.parse(previousText) as unknown);
        await this.writeAtomically(this.backupPath, previousText);
      } catch (error) {
        // Never replace a good backup with a missing or corrupt primary.
        if (!missing(error) && !(error instanceof SyntaxError) && !(error instanceof TypeError)) {
          throw error;
        }
      }

      await this.writeAtomically(
        this.filePath,
        `${JSON.stringify(sanitized, null, 2)}\n`,
      );
    });
  }

  private async loadUnsafe(): Promise<FeishuApplicationSyncState | undefined> {
    await mkdir(this.directory, { recursive: true });
    let primaryError: unknown;
    try {
      const text = await readFile(this.filePath, 'utf8');
      return sanitizeFeishuSyncState(JSON.parse(text) as unknown);
    } catch (error) {
      primaryError = error;
    }

    try {
      const backupText = await readFile(this.backupPath, 'utf8');
      const recovered = sanitizeFeishuSyncState(JSON.parse(backupText) as unknown);
      await this.writeAtomically(
        this.filePath,
        `${JSON.stringify(recovered, null, 2)}\n`,
      );
      return recovered;
    } catch (backupError) {
      if (missing(primaryError) && missing(backupError)) return undefined;
      throw new FeishuStateStoreCorruptionError(
        'Neither the Feishu sync state nor its backup can be read.',
        [primaryError, backupError],
      );
    }
  }

  private async writeAtomically(target: string, contents: string): Promise<void> {
    const temporary = path.join(
      this.directory,
      `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
