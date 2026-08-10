import { createHash } from 'node:crypto';

import type {
  AgentJsonValue,
  AuditEventInput,
  AuditRecord,
} from '../../src/shared/agent-types';

export const AUDIT_GENESIS_HASH = '0'.repeat(64);
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(api.?key|authorization|token|secret|password|cookie|credential)/i;

const stableStringify = (value: unknown): string => {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
};

const auditHash = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

const redactString = (value: string): string =>
  value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED);

const redactValue = (
  value: unknown,
  explicitPaths: ReadonlySet<string>,
  currentPath = '',
): unknown => {
  if (explicitPaths.has(currentPath)) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactValue(entry, explicitPaths, currentPath === '' ? `${index}` : `${currentPath}.${index}`),
    );
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const path = currentPath === '' ? key : `${currentPath}.${key}`;
    output[key] =
      SENSITIVE_KEY.test(key) || explicitPaths.has(path)
        ? REDACTED
        : redactValue(entry, explicitPaths, path);
  }
  return output;
};

export interface AuditStore {
  readAll(): Promise<AuditRecord[]>;
  append(record: AuditRecord): Promise<void>;
}

export class InMemoryAuditStore implements AuditStore {
  private readonly records: AuditRecord[] = [];

  async readAll(): Promise<AuditRecord[]> {
    return structuredClone(this.records);
  }

  async append(record: AuditRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

export interface AuditLogOptions {
  store: AuditStore;
  now?: () => Date;
}

export interface AuditVerificationResult {
  valid: boolean;
  invalidSequence?: number;
  reason?: 'sequence' | 'previous-hash' | 'event-hash';
}

export class AuditLog {
  private readonly now: () => Date;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AuditLogOptions) {
    this.now = options.now ?? (() => new Date());
  }

  append(input: AuditEventInput): Promise<AuditRecord> {
    const operation = this.appendQueue.then(() => this.appendUnlocked(input));
    this.appendQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async records(): Promise<AuditRecord[]> {
    await this.appendQueue;
    return this.options.store.readAll();
  }

  async verify(records?: AuditRecord[]): Promise<AuditVerificationResult> {
    const entries = records ?? (await this.records());
    let previousHash = AUDIT_GENESIS_HASH;
    for (let index = 0; index < entries.length; index += 1) {
      const record = entries[index];
      const expectedSequence = index + 1;
      if (record.sequence !== expectedSequence) {
        return { valid: false, invalidSequence: expectedSequence, reason: 'sequence' };
      }
      if (record.previousHash !== previousHash) {
        return { valid: false, invalidSequence: expectedSequence, reason: 'previous-hash' };
      }
      const { eventHash, ...hashable } = record;
      if (eventHash !== auditHash(hashable)) {
        return { valid: false, invalidSequence: expectedSequence, reason: 'event-hash' };
      }
      previousHash = record.eventHash;
    }
    return { valid: true };
  }

  private async appendUnlocked(input: AuditEventInput): Promise<AuditRecord> {
    const existing = await this.options.store.readAll();
    const previous = existing.at(-1);
    const explicitPaths = new Set(input.sensitivePaths ?? []);
    const sanitized = redactValue(input, explicitPaths) as Omit<AuditEventInput, 'sensitivePaths'>;
    delete (sanitized as Partial<AuditEventInput>).sensitivePaths;

    const hashable: Omit<AuditRecord, 'eventHash'> = {
      ...sanitized,
      sequence: (previous?.sequence ?? 0) + 1,
      timestamp: this.now().toISOString(),
      previousHash: previous?.eventHash ?? AUDIT_GENESIS_HASH,
    };
    const record: AuditRecord = {
      ...hashable,
      eventHash: auditHash(hashable),
    };
    await this.options.store.append(record);
    return structuredClone(record);
  }
}

export const redactAuditData = (
  value: AgentJsonValue,
  sensitivePaths: string[] = [],
): AgentJsonValue => redactValue(value, new Set(sensitivePaths)) as AgentJsonValue;
