import { describe, expect, it } from 'vitest';

import type {
  AgentJsonValue,
  EffectPlan,
  PermissionContext,
  PermissionTarget,
  RiskLevel,
  ToolInvocation,
} from '../src/shared/agent-types';
import {
  hashPermissionValue,
  PermissionEngine,
  PermissionEngineError,
} from '../electron/agent/permission-engine';

const createHarness = () => {
  let timestamp = Date.parse('2026-08-09T09:00:00.000Z');
  let id = 0;
  const engine = new PermissionEngine({
    now: () => new Date(timestamp),
    idFactory: () => `id-${++id}`,
    policyRevision: 7,
    approvalTtlMs: 10_000,
    grantTtlMs: 5_000,
  });
  return {
    engine,
    now: () => timestamp,
    advance: (milliseconds: number) => {
      timestamp += milliseconds;
    },
  };
};

const action = (
  risk: RiskLevel,
  targets: PermissionTarget[] = [{ kind: 'task', value: 'task-1' }],
): { invocation: ToolInvocation; effects: EffectPlan } => {
  const args: AgentJsonValue = { taskId: 'task-1', title: 'Reviewed title' };
  const preview: AgentJsonValue = {
    before: { title: 'Old title' },
    after: { title: 'Reviewed title' },
  };
  return {
    invocation: {
      invocationId: `invocation-${risk}`,
      runId: 'run-1',
      providerCallId: `call-${risk}`,
      toolName: 'task_update',
      toolVersion: 1,
      arguments: args,
      argumentsHash: hashPermissionValue(args),
      createdAt: '2026-08-09T09:00:00.000Z',
    },
    effects: {
      risk,
      targets,
      reads: ['task-1'],
      writes: risk === 'R0' ? [] : ['task-1'],
      network: [],
      externalEffects: [],
      reversible: risk !== 'R4',
      preview,
      previewHash: hashPermissionValue(preview),
      baseVersions: { 'task-1': 'version-1' },
    },
  };
};

describe('PermissionEngine', () => {
  it('implements the standard R0-R4 decision table', () => {
    const { engine } = createHarness();
    const standard: PermissionContext = { mode: 'standard' };
    const r0 = action('R0');
    const r1 = action('R1');
    const r2 = action('R2');
    const r3 = action('R3');
    const r4 = action('R4');

    expect(engine.evaluate(r0.invocation, r0.effects, standard)).toMatchObject({
      kind: 'allow',
      reason: 'automatic',
    });
    expect(engine.evaluate(r1.invocation, r1.effects, standard)).toMatchObject({
      kind: 'allow',
      reason: 'automatic',
    });
    expect(engine.evaluate(r2.invocation, r2.effects, standard)).toMatchObject({
      kind: 'confirm',
    });
    expect(engine.evaluate(r3.invocation, r3.effects, standard)).toMatchObject({
      kind: 'confirm',
    });
    expect(engine.evaluate(r4.invocation, r4.effects, standard)).toEqual({
      kind: 'deny',
      reasonCode: 'R4_PERMANENTLY_FORBIDDEN',
      message: 'This capability is permanently unavailable to the Agent.',
    });
  });

  it('allows only R0 in read-only mode', () => {
    const { engine } = createHarness();
    const context: PermissionContext = { mode: 'read-only' };
    const r0 = action('R0');
    const r1 = action('R1');

    expect(engine.evaluate(r0.invocation, r0.effects, context).kind).toBe('allow');
    expect(engine.evaluate(r1.invocation, r1.effects, context)).toMatchObject({
      kind: 'deny',
      reasonCode: 'READ_ONLY_MODE',
    });
  });

  it('turns an approval into a single-use grant', () => {
    const { engine } = createHarness();
    const context: PermissionContext = { mode: 'standard' };
    const reviewed = action('R3');
    const requested = engine.evaluate(reviewed.invocation, reviewed.effects, context);
    expect(requested.kind).toBe('confirm');
    if (requested.kind !== 'confirm') {
      throw new Error('Expected confirmation.');
    }

    const approved = engine.resolveApproval(requested.request.approvalId, 'once');
    expect(approved.kind).toBe('allow');
    if (approved.kind !== 'allow') {
      throw new Error('Expected execution grant.');
    }
    engine.consumeGrant(approved.grant, reviewed.invocation, reviewed.effects, context);
    expect(() =>
      engine.consumeGrant(approved.grant, reviewed.invocation, reviewed.effects, context),
    ).toThrowError(expect.objectContaining({ code: 'GRANT_UNAVAILABLE' }));
  });

  it('rechecks read-only mode after a user approves but before execution starts', () => {
    const { engine } = createHarness();
    const reviewed = action('R2');
    const requested = engine.evaluate(reviewed.invocation, reviewed.effects, { mode: 'standard' });
    if (requested.kind !== 'confirm') throw new Error('Expected confirmation.');
    const approved = engine.resolveApproval(requested.request.approvalId, 'once');
    if (approved.kind !== 'allow') throw new Error('Expected execution grant.');

    expect(() => engine.consumeGrant(
      approved.grant,
      reviewed.invocation,
      reviewed.effects,
      { mode: 'read-only' },
    )).toThrowError(expect.objectContaining({ code: 'PERMISSION_MODE_CHANGED' }));
  });

  it('expires unused grants and rechecks a permission-mode downgrade before execution', () => {
    const { engine, advance } = createHarness();
    const reviewed = action('R1');
    const expiring = engine.evaluate(reviewed.invocation, reviewed.effects, { mode: 'standard' });
    if (expiring.kind !== 'allow') {
      throw new Error('Expected automatic grant.');
    }

    advance(5_001);
    expect(() =>
      engine.consumeGrant(expiring.grant, reviewed.invocation, reviewed.effects, {
        mode: 'standard',
      }),
    ).toThrowError(expect.objectContaining({ code: 'GRANT_EXPIRED' }));

    const fresh = engine.evaluate(reviewed.invocation, reviewed.effects, { mode: 'standard' });
    if (fresh.kind !== 'allow') {
      throw new Error('Expected automatic grant.');
    }
    expect(() =>
      engine.consumeGrant(fresh.grant, reviewed.invocation, reviewed.effects, {
        mode: 'read-only',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PERMISSION_MODE_CHANGED' }));
  });

  it('auto-allows R2/R3 only when every target is inside an exact full access lease', () => {
    const { engine, now } = createHarness();
    const lease = engine.createFullAccessLease({
      leaseId: 'lease-1',
      authenticatedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 60_000).toISOString(),
      scopes: [
        {
          toolName: 'task_update',
          risks: ['R2', 'R3'],
          targets: [
            { kind: 'task', value: 'task-1' },
            { kind: 'account', value: 'feishu:user@tenant-a' },
          ],
        },
      ],
    });
    const context: PermissionContext = { mode: 'full-access', fullAccessLease: lease };
    const covered = action('R2', [
      { kind: 'task', value: 'task-1' },
      { kind: 'account', value: 'feishu:user@tenant-a' },
    ]);
    const newTarget = action('R2', [
      { kind: 'task', value: 'task-2' },
      { kind: 'account', value: 'feishu:user@tenant-a' },
    ]);

    expect(engine.evaluate(covered.invocation, covered.effects, context)).toMatchObject({
      kind: 'allow',
      reason: 'full-access',
      grant: { leaseId: 'lease-1', maxUses: 1 },
    });
    expect(engine.evaluate(newTarget.invocation, newTarget.effects, context).kind).toBe('confirm');
  });

  it('accepts only an internally issued, untampered full access lease', () => {
    const { engine, now } = createHarness();
    const lease = engine.createFullAccessLease({
      leaseId: 'lease-authenticated',
      authenticatedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 60_000).toISOString(),
      scopes: [
        {
          toolName: 'task_update',
          risks: ['R2'],
          targets: [{ kind: 'task', value: 'task-1' }],
        },
      ],
    });
    lease.scopes[0].targets.push({ kind: 'task', value: 'task-2' });
    const reviewed = action('R2', [{ kind: 'task', value: 'task-2' }]);

    expect(
      engine.evaluate(reviewed.invocation, reviewed.effects, {
        mode: 'full-access',
        fullAccessLease: lease,
      }).kind,
    ).toBe('confirm');
  });

  it('invalidates queued grants with the run stop epoch', () => {
    const { engine } = createHarness();
    const context: PermissionContext = { mode: 'standard' };
    const reviewed = action('R1');
    const allowed = engine.evaluate(reviewed.invocation, reviewed.effects, context);
    if (allowed.kind !== 'allow') {
      throw new Error('Expected automatic grant.');
    }

    expect(engine.stopRun(reviewed.invocation.runId)).toBe(1);
    expect(() =>
      engine.consumeGrant(allowed.grant, reviewed.invocation, reviewed.effects, context),
    ).toThrowError(expect.objectContaining({ code: 'GRANT_UNAVAILABLE' }));
  });

  it('invalidates a full access lease and all grants when the global stop epoch changes', () => {
    const { engine, now } = createHarness();
    const lease = engine.createFullAccessLease({
      authenticatedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 60_000).toISOString(),
      scopes: [
        {
          toolName: 'task_update',
          risks: ['R3'],
          targets: [{ kind: 'task', value: 'task-1' }],
        },
      ],
    });
    const context: PermissionContext = { mode: 'full-access', fullAccessLease: lease };
    const reviewed = action('R3');
    const allowed = engine.evaluate(reviewed.invocation, reviewed.effects, context);
    if (allowed.kind !== 'allow') {
      throw new Error('Expected full access grant.');
    }

    expect(engine.stopAll()).toBe(1);
    expect(() =>
      engine.consumeGrant(allowed.grant, reviewed.invocation, reviewed.effects, context),
    ).toThrowError(PermissionEngineError);
    expect(engine.evaluate(reviewed.invocation, reviewed.effects, context).kind).toBe('confirm');
  });

  it('rejects changed arguments or previews before making a policy decision', () => {
    const { engine } = createHarness();
    const reviewed = action('R1');
    reviewed.invocation.arguments = { taskId: 'task-2' };

    expect(() =>
      engine.evaluate(reviewed.invocation, reviewed.effects, { mode: 'standard' }),
    ).toThrowError(expect.objectContaining({ code: 'ARGUMENT_HASH_MISMATCH' }));
  });
});
