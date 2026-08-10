import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  emptyReminderRuntimeState,
  type ReminderRuntimeState,
} from '../../src/shared/reminders';
import type { ReminderStateStore } from './reminder-service';

interface StoredReminderRuntimeState {
  schemaVersion: 1;
  state: ReminderRuntimeState;
}

export interface ReminderRuntimeStoreOptions {
  directory: string;
  fileName?: string;
  maxBytes?: number;
}

export class ReminderRuntimeStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderRuntimeStoreValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeKey = (value: string): boolean =>
  value !== '__proto__' &&
  value !== 'prototype' &&
  value !== 'constructor' &&
  !/[\u0000-\u001f]/.test(value);

const isIsoDateTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const isLocalDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
};

const validateStringRecord = (
  value: unknown,
  valueValidator: (entry: unknown) => boolean,
  field: string,
): void => {
  if (!isRecord(value)) {
    throw new ReminderRuntimeStoreValidationError(`${field} must be an object.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeKey(key) || !valueValidator(entry)) {
      throw new ReminderRuntimeStoreValidationError(`${field} contains an invalid entry.`);
    }
  }
};

const validateRuntimeState = (value: unknown): ReminderRuntimeState => {
  if (!isRecord(value)) {
    throw new ReminderRuntimeStoreValidationError('Reminder runtime state must be an object.');
  }
  const allowed = new Set([
    'delivered',
    'dismissed',
    'snoozedUntil',
    'lastMorningBriefDate',
    'lastRiskNoticeDate',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ReminderRuntimeStoreValidationError('Reminder runtime state contains unknown fields.');
  }
  validateStringRecord(value.delivered, isIsoDateTime, 'delivered');
  validateStringRecord(
    value.dismissed,
    (entry) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0,
    'dismissed',
  );
  validateStringRecord(value.snoozedUntil, isIsoDateTime, 'snoozedUntil');
  if (
    value.lastMorningBriefDate !== undefined &&
    !isLocalDate(value.lastMorningBriefDate)
  ) {
    throw new ReminderRuntimeStoreValidationError('lastMorningBriefDate is invalid.');
  }
  if (value.lastRiskNoticeDate !== undefined && !isLocalDate(value.lastRiskNoticeDate)) {
    throw new ReminderRuntimeStoreValidationError('lastRiskNoticeDate is invalid.');
  }
  return structuredClone(value) as unknown as ReminderRuntimeState;
};

const parseEnvelope = (text: string, maxBytes: number): ReminderRuntimeState => {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ReminderRuntimeStoreValidationError('Reminder runtime state is too large.');
  }
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Object.hasOwn(parsed, 'state') ||
    Object.keys(parsed).some((key) => !['schemaVersion', 'state'].includes(key))
  ) {
    throw new ReminderRuntimeStoreValidationError('Unsupported reminder runtime schema.');
  }
  return validateRuntimeState(parsed.state);
};

const serializeEnvelope = (state: ReminderRuntimeState): string => {
  const envelope: StoredReminderRuntimeState = {
    schemaVersion: 1,
    state: validateRuntimeState(state),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
};

const isMissingFile = (error: unknown): boolean =>
  isRecord(error) && error.code === 'ENOENT';

const isRecoverableDataError = (error: unknown): boolean =>
  isMissingFile(error) ||
  error instanceof SyntaxError ||
  error instanceof ReminderRuntimeStoreValidationError;

const syncDirectory = async (directory: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isRecord(error) ||
      !['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(
        String(error.code),
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
};

/**
 * Durable, best-effort runtime state. If both copies are corrupt it returns
 * undefined so ReminderScheduler can safely rebuild an empty state.
 */
export class ReminderRuntimeStore implements ReminderStateStore {
  readonly directory: string;
  readonly filePath: string;
  readonly backupPath: string;

  readonly #maxBytes: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(optionsOrDirectory: ReminderRuntimeStoreOptions | string) {
    const options =
      typeof optionsOrDirectory === 'string'
        ? { directory: optionsOrDirectory }
        : optionsOrDirectory;
    const fileName = options.fileName ?? 'reminder-runtime.v1.json';
    if (
      fileName.length === 0 ||
      fileName === '.' ||
      fileName === '..' ||
      path.posix.basename(fileName) !== fileName ||
      path.win32.basename(fileName) !== fileName
    ) {
      throw new TypeError('Reminder runtime fileName must not contain a path.');
    }
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    ) {
      throw new TypeError('maxBytes must be a positive safe integer.');
    }
    this.directory = path.resolve(options.directory);
    this.filePath = path.join(this.directory, fileName);
    this.backupPath = path.join(this.directory, `${fileName}.backup`);
    this.#maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  }

  async load(): Promise<ReminderRuntimeState | undefined> {
    return this.#enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      try {
        return parseEnvelope(await readFile(this.filePath, 'utf8'), this.#maxBytes);
      } catch (mainError) {
        if (!isRecoverableDataError(mainError)) throw mainError;
        let backupText: string;
        let recovered: ReminderRuntimeState;
        try {
          backupText = await readFile(this.backupPath, 'utf8');
          recovered = parseEnvelope(backupText, this.#maxBytes);
        } catch (backupError) {
          if (!isRecoverableDataError(backupError)) throw backupError;
          // Runtime delivery history can be recreated. Returning undefined is
          // safer than preventing the application from starting.
          return undefined;
        }
        await this.#writeAtomic(this.filePath, backupText);
        return recovered;
      }
    });
  }

  async save(state: ReminderRuntimeState): Promise<void> {
    await this.#enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      const serialized = serializeEnvelope(state);
      if (Buffer.byteLength(serialized, 'utf8') > this.#maxBytes) {
        throw new ReminderRuntimeStoreValidationError('Reminder runtime state is too large.');
      }
      try {
        const previous = await readFile(this.filePath, 'utf8');
        parseEnvelope(previous, this.#maxBytes);
        await this.#writeAtomic(this.backupPath, previous);
      } catch (error) {
        if (
          !isMissingFile(error) &&
          !(error instanceof SyntaxError) &&
          !(error instanceof ReminderRuntimeStoreValidationError)
        ) {
          throw error;
        }
      }
      await this.#writeAtomic(this.filePath, serialized);
    });
  }

  async reset(): Promise<void> {
    await this.save(emptyReminderRuntimeState());
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #writeAtomic(targetPath: string, contents: string): Promise<void> {
    const temporaryPath = path.join(
      this.directory,
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
