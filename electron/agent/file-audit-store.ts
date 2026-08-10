import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AuditRecord } from '../../src/shared/agent-types';
import type { AuditStore } from './audit-log';

interface AuditEnvelope {
  schemaVersion: 1;
  records: AuditRecord[];
}

export interface FileAuditStoreOptions {
  directory: string;
  fileName?: string;
  maxRecords?: number;
  maxBytes?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  isRecord(error) && error.code === 'ENOENT';

const clone = <Value>(value: Value): Value => structuredClone(value);

const syncDirectory = async (directory: string): Promise<void> => {
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
};

function validateRecords(value: unknown, maxRecords: number): AuditRecord[] {
  if (!Array.isArray(value) || value.length > maxRecords) throw new Error('INVALID_AUDIT_RECORDS');
  value.forEach((entry, index) => {
    if (
      !isRecord(entry) ||
      entry.sequence !== index + 1 ||
      typeof entry.timestamp !== 'string' ||
      Number.isNaN(Date.parse(entry.timestamp)) ||
      typeof entry.runId !== 'string' ||
      typeof entry.actor !== 'string' ||
      typeof entry.event !== 'string' ||
      typeof entry.previousHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry.previousHash) ||
      typeof entry.eventHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry.eventHash)
    ) {
      throw new Error('INVALID_AUDIT_RECORD');
    }
  });
  return clone(value as AuditRecord[]);
}

export class FileAuditStore implements AuditStore {
  readonly filePath: string;
  readonly backupPath: string;
  readonly #directory: string;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: FileAuditStoreOptions) {
    const fileName = options.fileName ?? 'agent-audit.v1.json';
    if (!fileName || path.basename(fileName) !== fileName) throw new TypeError('INVALID_AUDIT_FILE_NAME');
    this.#directory = path.resolve(options.directory);
    this.filePath = path.join(this.#directory, fileName);
    this.backupPath = path.join(this.#directory, `${fileName}.backup`);
    this.#maxRecords = options.maxRecords ?? 20_000;
    this.#maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isInteger(this.#maxRecords) || this.#maxRecords < 1) {
      throw new TypeError('INVALID_AUDIT_MAX_RECORDS');
    }
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new TypeError('INVALID_AUDIT_MAX_BYTES');
    }
  }

  async readAll(): Promise<AuditRecord[]> {
    await this.#queue;
    await mkdir(this.#directory, { recursive: true });
    try {
      return this.#parse(await readFile(this.filePath, 'utf8'));
    } catch (mainError) {
      try {
        const backupText = await readFile(this.backupPath, 'utf8');
        const recovered = this.#parse(backupText);
        await this.#writeAtomic(this.filePath, backupText);
        return recovered;
      } catch (backupError) {
        if (isMissing(mainError) && isMissing(backupError)) return [];
        throw new Error('AUDIT_STORE_CORRUPT', { cause: [mainError, backupError] });
      }
    }
  }

  async append(record: AuditRecord): Promise<void> {
    const operation = this.#queue.then(async () => {
      let current: AuditRecord[];
      try {
        current = this.#parse(await readFile(this.filePath, 'utf8'));
      } catch (error) {
        if (!isMissing(error)) throw error;
        current = [];
      }
      if (record.sequence !== current.length + 1) throw new Error('AUDIT_SEQUENCE_MISMATCH');
      const next = [...current, clone(record)];
      validateRecords(next, this.#maxRecords);
      const serialized = `${JSON.stringify({ schemaVersion: 1, records: next } satisfies AuditEnvelope, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > this.#maxBytes) throw new Error('AUDIT_STORE_TOO_LARGE');
      await mkdir(this.#directory, { recursive: true });
      if (current.length > 0) {
        const previous = `${JSON.stringify({ schemaVersion: 1, records: current } satisfies AuditEnvelope, null, 2)}\n`;
        await this.#writeAtomic(this.backupPath, previous);
      }
      await this.#writeAtomic(this.filePath, serialized);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #parse(text: string): AuditRecord[] {
    if (Buffer.byteLength(text, 'utf8') > this.#maxBytes) throw new Error('AUDIT_STORE_TOO_LARGE');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw new Error('INVALID_AUDIT_SCHEMA');
    return validateRecords(parsed.records, this.#maxRecords);
  }

  async #writeAtomic(target: string, contents: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const temporary = path.join(this.#directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await syncDirectory(this.#directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
