import { describe, expect, it } from 'vitest';

import {
  AUDIT_GENESIS_HASH,
  AuditLog,
  InMemoryAuditStore,
} from '../electron/agent/audit-log';

describe('AuditLog', () => {
  it('creates and verifies a chained SHA-256 audit history', async () => {
    let tick = 0;
    const store = new InMemoryAuditStore();
    const log = new AuditLog({
      store,
      now: () => new Date(Date.parse('2026-08-09T09:00:00.000Z') + tick++),
    });

    const first = await log.append({
      runId: 'run-1',
      actor: 'model',
      event: 'tool.proposed',
      toolName: 'task_update',
      arguments: { taskId: 'task-1' },
    });
    const second = await log.append({
      runId: 'run-1',
      actor: 'system',
      event: 'tool.execution.finished',
      toolName: 'task_update',
      outcome: 'ok',
    });

    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe(AUDIT_GENESIS_HASH);
    expect(first.eventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.eventHash);
    await expect(log.verify()).resolves.toEqual({ valid: true });
  });

  it('detects record tampering', async () => {
    const log = new AuditLog({ store: new InMemoryAuditStore() });
    await log.append({ runId: 'run-1', actor: 'system', event: 'run.started' });
    await log.append({ runId: 'run-1', actor: 'system', event: 'run.finished' });
    const records = await log.records();
    records[0].event = 'tampered';

    await expect(log.verify(records)).resolves.toEqual({
      valid: false,
      invalidSequence: 1,
      reason: 'event-hash',
    });
  });

  it('redacts API keys, authorization headers, tokens, and explicit sensitive paths', async () => {
    const apiKey = 'plain-provider-key-value';
    const bearer = 'bearer-secret-value';
    const log = new AuditLog({ store: new InMemoryAuditStore() });
    const record = await log.append({
      runId: 'run-1',
      actor: 'system',
      event: 'model.request.failed',
      arguments: {
        apiKey,
        headers: { Authorization: `Bearer ${bearer}` },
        nested: { accessToken: 'token-value' },
      },
      details: {
        message: `Upstream echoed Authorization: Bearer ${bearer}`,
        custom: { privateValue: 'explicit-secret' },
      },
      sensitivePaths: ['details.custom.privateValue'],
    });
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(bearer);
    expect(serialized).not.toContain('token-value');
    expect(serialized).not.toContain('explicit-secret');
    expect(serialized).toContain('[REDACTED]');
    await expect(log.verify()).resolves.toEqual({ valid: true });
  });

  it('serializes concurrent appends without duplicate sequence numbers', async () => {
    const log = new AuditLog({ store: new InMemoryAuditStore() });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        log.append({
          runId: 'run-concurrent',
          actor: 'system',
          event: `event-${index}`,
        }),
      ),
    );

    const records = await log.records();
    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    await expect(log.verify(records)).resolves.toEqual({ valid: true });
  });
});
