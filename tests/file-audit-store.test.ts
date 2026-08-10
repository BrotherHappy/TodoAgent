import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../electron/agent/audit-log';
import { FileAuditStore } from '../electron/agent/file-audit-store';

describe('FileAuditStore', () => {
  let directory: string;

  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-audit-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('persists a verifiable chain without leaking credentials', async () => {
    const store = new FileAuditStore({ directory });
    const log = new AuditLog({ store });
    await log.append({ runId: 'run', actor: 'user', event: 'test', details: { apiKey: 'sk-secret-value' } });
    const reopened = new AuditLog({ store: new FileAuditStore({ directory }) });
    expect(await reopened.verify()).toEqual({ valid: true });
    expect(await readFile(store.filePath, 'utf8')).not.toContain('sk-secret-value');
  });

  it('recovers the previous valid copy after main-file corruption', async () => {
    const store = new FileAuditStore({ directory });
    const log = new AuditLog({ store });
    await log.append({ runId: 'one', actor: 'system', event: 'first' });
    await log.append({ runId: 'two', actor: 'system', event: 'second' });
    await writeFile(store.filePath, '{corrupt', 'utf8');
    const recovered = await new FileAuditStore({ directory }).readAll();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].event).toBe('first');
  });

  it('rejects invalid storage bounds at construction time', () => {
    expect(() => new FileAuditStore({ directory, maxRecords: 0 })).toThrow('INVALID_AUDIT_MAX_RECORDS');
    expect(() => new FileAuditStore({ directory, maxBytes: 1.5 })).toThrow('INVALID_AUDIT_MAX_BYTES');
  });
});
