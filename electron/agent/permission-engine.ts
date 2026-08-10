import { createHash, randomUUID } from 'node:crypto';

import type {
  AgentJsonValue,
  ApprovalChoice,
  ApprovalRequest,
  EffectPlan,
  ExecutionGrant,
  FullAccessLease,
  FullAccessToolScope,
  GrantSource,
  PermissionContext,
  PermissionDecision,
  PermissionTarget,
  ToolInvocation,
} from '../../src/shared/agent-types';

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

export const hashPermissionValue = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

const parseTimestamp = (value: string, field: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PermissionEngineError('INVALID_TIMESTAMP', `${field} must be a valid timestamp.`);
  }
  return parsed;
};

const clone = <T>(value: T): T => structuredClone(value);

const targetKey = (target: PermissionTarget): string => `${target.kind}\u0000${target.value}`;

export class PermissionEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermissionEngineError';
  }
}

export interface FullAccessLeaseInput {
  leaseId?: string;
  authenticatedAt: string;
  expiresAt: string;
  scopes: FullAccessToolScope[];
}

export interface PermissionEngineOptions {
  now?: () => Date;
  idFactory?: () => string;
  policyRevision?: number | (() => number);
  approvalTtlMs?: number;
  grantTtlMs?: number;
}

interface StoredGrant {
  grant: ExecutionGrant;
  used: boolean;
}

const isR2OrR3 = (risk: EffectPlan['risk']): risk is 'R2' | 'R3' =>
  risk === 'R2' || risk === 'R3';

export class PermissionEngine {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly getPolicyRevision: () => number;
  private readonly approvalTtlMs: number;
  private readonly grantTtlMs: number;
  private readonly runEpochs = new Map<string, number>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly grants = new Map<string, StoredGrant>();
  private readonly leases = new Map<string, FullAccessLease>();
  private modeEpoch = 0;

  constructor(options: PermissionEngineOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    const configuredPolicyRevision = options.policyRevision;
    this.getPolicyRevision =
      typeof configuredPolicyRevision === 'function'
        ? configuredPolicyRevision
        : () => configuredPolicyRevision ?? 1;
    this.approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000;
    this.grantTtlMs = options.grantTtlMs ?? 60_000;
  }

  getModeEpoch(): number {
    return this.modeEpoch;
  }

  getRunEpoch(runId: string): number {
    return this.runEpochs.get(runId) ?? 0;
  }

  createFullAccessLease(input: FullAccessLeaseInput): FullAccessLease {
    const now = this.now();
    const authenticatedAt = parseTimestamp(input.authenticatedAt, 'authenticatedAt');
    const expiresAt = parseTimestamp(input.expiresAt, 'expiresAt');
    if (authenticatedAt > now.getTime()) {
      throw new PermissionEngineError(
        'AUTHENTICATION_IN_FUTURE',
        'Full access authentication cannot be in the future.',
      );
    }
    if (expiresAt <= now.getTime()) {
      throw new PermissionEngineError('LEASE_EXPIRED', 'Full access lease must expire in the future.');
    }
    if (input.scopes.length === 0) {
      throw new PermissionEngineError('EMPTY_SCOPE', 'Full access requires at least one exact scope.');
    }

    const scopes = input.scopes.map((scope) => {
      if (scope.toolName.trim() === '' || scope.risks.length === 0 || scope.targets.length === 0) {
        throw new PermissionEngineError(
          'INVALID_SCOPE',
          'Each full access scope requires a tool, risk, and exact target.',
        );
      }
      const targets = scope.targets.map((target) => {
        if (target.value.trim() === '') {
          throw new PermissionEngineError('INVALID_SCOPE', 'Scope targets cannot be empty.');
        }
        return { ...target };
      });
      return {
        toolName: scope.toolName,
        risks: [...new Set(scope.risks)],
        targets,
      };
    });

    const lease: FullAccessLease = {
      leaseId: input.leaseId ?? this.idFactory(),
      authenticatedAt: new Date(authenticatedAt).toISOString(),
      issuedAt: now.toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      modeEpoch: this.modeEpoch,
      policyRevision: this.getPolicyRevision(),
      scopes,
    };
    if (lease.leaseId.trim() === '') {
      throw new PermissionEngineError('INVALID_LEASE_ID', 'Full access lease IDs cannot be empty.');
    }
    if (this.leases.has(lease.leaseId)) {
      throw new PermissionEngineError('DUPLICATE_LEASE_ID', 'Full access lease IDs must be unique.');
    }
    this.leases.set(lease.leaseId, clone(lease));
    return lease;
  }

  evaluate(
    invocation: ToolInvocation,
    effects: EffectPlan,
    context: PermissionContext,
  ): PermissionDecision {
    this.assertInvocationIntegrity(invocation, effects);

    if (effects.risk === 'R4') {
      return {
        kind: 'deny',
        reasonCode: 'R4_PERMANENTLY_FORBIDDEN',
        message: 'This capability is permanently unavailable to the Agent.',
      };
    }

    if (context.mode === 'read-only') {
      if (effects.risk !== 'R0') {
        return {
          kind: 'deny',
          reasonCode: 'READ_ONLY_MODE',
          message: 'The Agent is currently restricted to read-only actions.',
        };
      }
      return this.allow(invocation, effects, 'automatic');
    }

    if (effects.risk === 'R0' || effects.risk === 'R1') {
      return this.allow(invocation, effects, 'automatic');
    }

    if (
      context.mode === 'full-access' &&
      isR2OrR3(effects.risk) &&
      this.leaseAllows(context.fullAccessLease, invocation, effects)
    ) {
      return this.allow(
        invocation,
        effects,
        'full-access',
        context.fullAccessLease?.leaseId,
      );
    }

    return this.requestConfirmation(invocation, effects);
  }

  resolveApproval(approvalId: string, choice: ApprovalChoice): PermissionDecision {
    const request = this.approvals.get(approvalId);
    if (request === undefined) {
      return {
        kind: 'deny',
        reasonCode: 'UNKNOWN_APPROVAL',
        message: 'The approval request is no longer available.',
      };
    }
    this.approvals.delete(approvalId);

    if (choice === 'deny') {
      return {
        kind: 'deny',
        reasonCode: 'USER_DENIED',
        message: 'The user denied this action.',
      };
    }
    if (choice !== 'once') {
      return {
        kind: 'deny',
        reasonCode: 'INVALID_APPROVAL_CHOICE',
        message: 'The approval response was not recognized.',
      };
    }

    const now = this.now().getTime();
    if (parseTimestamp(request.expiresAt, 'expiresAt') <= now) {
      return {
        kind: 'deny',
        reasonCode: 'APPROVAL_EXPIRED',
        message: 'The approval request expired before it was accepted.',
      };
    }
    if (
      request.policyRevision !== this.getPolicyRevision() ||
      request.runEpoch !== this.getRunEpoch(request.invocation.runId) ||
      request.modeEpoch !== this.modeEpoch
    ) {
      return {
        kind: 'deny',
        reasonCode: 'APPROVAL_STALE',
        message: 'Permissions changed while the action was awaiting approval.',
      };
    }

    const expectedDigest = this.approvalDigest(request.invocation, request.effects);
    if (request.decisionDigest !== expectedDigest) {
      return {
        kind: 'deny',
        reasonCode: 'APPROVAL_TAMPERED',
        message: 'The approved action no longer matches the reviewed action.',
      };
    }
    return this.allow(request.invocation, request.effects, 'user-approved');
  }

  consumeGrant(
    grant: ExecutionGrant,
    invocation: ToolInvocation,
    effects: EffectPlan,
    context: PermissionContext,
  ): void {
    this.assertInvocationIntegrity(invocation, effects);
    const stored = this.grants.get(grant.grantId);
    if (stored === undefined || stored.used) {
      throw new PermissionEngineError('GRANT_UNAVAILABLE', 'The execution grant is invalid or used.');
    }

    const trustedGrant = stored.grant;
    if (hashPermissionValue(grant) !== hashPermissionValue(trustedGrant)) {
      throw new PermissionEngineError('GRANT_TAMPERED', 'The execution grant was modified.');
    }
    if (
      trustedGrant.invocationId !== invocation.invocationId ||
      trustedGrant.runId !== invocation.runId ||
      trustedGrant.toolName !== invocation.toolName ||
      trustedGrant.argumentsHash !== invocation.argumentsHash ||
      trustedGrant.previewHash !== effects.previewHash ||
      trustedGrant.risk !== effects.risk
    ) {
      throw new PermissionEngineError('GRANT_SCOPE_MISMATCH', 'The grant does not cover this action.');
    }

    const now = this.now().getTime();
    if (parseTimestamp(trustedGrant.expiresAt, 'expiresAt') <= now) {
      throw new PermissionEngineError('GRANT_EXPIRED', 'The execution grant has expired.');
    }
    if (
      trustedGrant.policyRevision !== this.getPolicyRevision() ||
      trustedGrant.runEpoch !== this.getRunEpoch(invocation.runId) ||
      trustedGrant.modeEpoch !== this.modeEpoch
    ) {
      throw new PermissionEngineError('GRANT_STALE', 'The execution grant was invalidated.');
    }
    if (
      trustedGrant.source === 'full-access' &&
      (context.mode !== 'full-access' ||
        !this.leaseAllows(context.fullAccessLease, invocation, effects) ||
        context.fullAccessLease?.leaseId !== trustedGrant.leaseId)
    ) {
      throw new PermissionEngineError(
        'FULL_ACCESS_INVALID',
        'The full access lease no longer covers this action.',
      );
    }
    if (context.mode === 'read-only' && trustedGrant.risk !== 'R0') {
      throw new PermissionEngineError(
        'PERMISSION_MODE_CHANGED',
        'The current permission mode no longer permits this action.',
      );
    }

    stored.used = true;
  }

  stopRun(runId: string): number {
    const nextEpoch = this.getRunEpoch(runId) + 1;
    this.runEpochs.set(runId, nextEpoch);
    for (const [approvalId, approval] of this.approvals) {
      if (approval.invocation.runId === runId) {
        this.approvals.delete(approvalId);
      }
    }
    for (const [grantId, stored] of this.grants) {
      if (stored.grant.runId === runId) {
        this.grants.delete(grantId);
      }
    }
    return nextEpoch;
  }

  stopAll(): number {
    this.modeEpoch += 1;
    this.approvals.clear();
    this.grants.clear();
    this.leases.clear();
    return this.modeEpoch;
  }

  private allow(
    invocation: ToolInvocation,
    effects: EffectPlan,
    source: GrantSource,
    leaseId?: string,
  ): PermissionDecision {
    const now = this.now();
    const grant: ExecutionGrant = {
      grantId: this.idFactory(),
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      toolName: invocation.toolName,
      argumentsHash: invocation.argumentsHash,
      previewHash: effects.previewHash,
      risk: effects.risk,
      source,
      leaseId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.grantTtlMs).toISOString(),
      policyRevision: this.getPolicyRevision(),
      runEpoch: this.getRunEpoch(invocation.runId),
      modeEpoch: this.modeEpoch,
      maxUses: 1,
    };
    this.grants.set(grant.grantId, { grant: clone(grant), used: false });
    return { kind: 'allow', reason: source, grant };
  }

  private requestConfirmation(
    invocation: ToolInvocation,
    effects: EffectPlan,
  ): PermissionDecision {
    const now = this.now();
    const request: ApprovalRequest = {
      approvalId: this.idFactory(),
      invocation: clone(invocation),
      effects: clone(effects),
      decisionDigest: this.approvalDigest(invocation, effects),
      policyRevision: this.getPolicyRevision(),
      runEpoch: this.getRunEpoch(invocation.runId),
      modeEpoch: this.modeEpoch,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.approvalTtlMs).toISOString(),
      allowedChoices: ['deny', 'once'],
    };
    this.approvals.set(request.approvalId, clone(request));
    return { kind: 'confirm', request };
  }

  private approvalDigest(invocation: ToolInvocation, effects: EffectPlan): string {
    return hashPermissionValue({
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      toolName: invocation.toolName,
      toolVersion: invocation.toolVersion,
      argumentsHash: invocation.argumentsHash,
      previewHash: effects.previewHash,
      risk: effects.risk,
      targets: effects.targets,
      baseVersions: effects.baseVersions,
    });
  }

  private leaseAllows(
    lease: FullAccessLease | undefined,
    invocation: ToolInvocation,
    effects: EffectPlan,
  ): boolean {
    if (lease === undefined || !isR2OrR3(effects.risk)) {
      return false;
    }
    const issuedLease = this.leases.get(lease.leaseId);
    if (
      issuedLease === undefined ||
      hashPermissionValue(lease) !== hashPermissionValue(issuedLease)
    ) {
      return false;
    }
    const risk = effects.risk;
    const now = this.now().getTime();
    if (
      parseTimestamp(lease.authenticatedAt, 'authenticatedAt') > now ||
      parseTimestamp(lease.expiresAt, 'expiresAt') <= now ||
      lease.modeEpoch !== this.modeEpoch ||
      lease.policyRevision !== this.getPolicyRevision()
    ) {
      return false;
    }

    if (effects.targets.length === 0) {
      return false;
    }
    return lease.scopes.some((scope) => {
      if (scope.toolName !== invocation.toolName || !scope.risks.includes(risk)) {
        return false;
      }
      const allowedTargets = new Set(scope.targets.map(targetKey));
      return effects.targets.every((target) => allowedTargets.has(targetKey(target)));
    });
  }

  private assertInvocationIntegrity(invocation: ToolInvocation, effects: EffectPlan): void {
    if (invocation.argumentsHash !== hashPermissionValue(invocation.arguments)) {
      throw new PermissionEngineError(
        'ARGUMENT_HASH_MISMATCH',
        'The invocation arguments do not match their trusted digest.',
      );
    }
    if (effects.previewHash !== hashPermissionValue(effects.preview)) {
      throw new PermissionEngineError(
        'PREVIEW_HASH_MISMATCH',
        'The effect preview does not match its trusted digest.',
      );
    }
    if (effects.targets.some((target) => target.value.trim() === '')) {
      throw new PermissionEngineError('INVALID_TARGET', 'Permission targets cannot be empty.');
    }
  }
}
