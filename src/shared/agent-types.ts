import type { JsonValue } from './models';

export type AgentJsonValue = JsonValue;
export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
export type PermissionMode = 'read-only' | 'standard' | 'full-access';

export type PermissionTargetKind =
  | 'task'
  | 'account'
  | 'project'
  | 'origin'
  | 'path'
  | 'command'
  | 'app'
  | 'network';

/** Values must already be canonicalized by the trusted tool analyzer. */
export interface PermissionTarget {
  kind: PermissionTargetKind;
  value: string;
}

export interface EffectPlan {
  risk: RiskLevel;
  targets: PermissionTarget[];
  reads: string[];
  writes: string[];
  network: string[];
  externalEffects: string[];
  reversible: boolean;
  preview: AgentJsonValue;
  previewHash: string;
  baseVersions: Record<string, string>;
}

export interface ToolInvocation {
  invocationId: string;
  runId: string;
  providerCallId: string;
  toolName: string;
  toolVersion: number;
  arguments: AgentJsonValue;
  argumentsHash: string;
  createdAt: string;
}

export interface FullAccessToolScope {
  toolName: string;
  risks: Array<'R2' | 'R3'>;
  /** Every target in an invocation must exactly match one entry here. */
  targets: PermissionTarget[];
}

export interface FullAccessLease {
  leaseId: string;
  authenticatedAt: string;
  issuedAt: string;
  expiresAt: string;
  modeEpoch: number;
  policyRevision: number;
  scopes: FullAccessToolScope[];
}

export type GrantSource = 'automatic' | 'user-approved' | 'full-access';

export interface ExecutionGrant {
  grantId: string;
  invocationId: string;
  runId: string;
  toolName: string;
  argumentsHash: string;
  previewHash: string;
  risk: RiskLevel;
  source: GrantSource;
  leaseId?: string;
  issuedAt: string;
  expiresAt: string;
  policyRevision: number;
  runEpoch: number;
  modeEpoch: number;
  maxUses: 1;
}

export type ApprovalChoice = 'deny' | 'once';

export interface ApprovalRequest {
  approvalId: string;
  invocation: ToolInvocation;
  effects: EffectPlan;
  decisionDigest: string;
  policyRevision: number;
  runEpoch: number;
  modeEpoch: number;
  createdAt: string;
  expiresAt: string;
  allowedChoices: ApprovalChoice[];
}

export type PermissionDecision =
  | {
      kind: 'allow';
      reason: GrantSource;
      grant: ExecutionGrant;
    }
  | {
      kind: 'confirm';
      request: ApprovalRequest;
    }
  | {
      kind: 'deny';
      reasonCode: string;
      message: string;
    };

export interface PermissionContext {
  mode: PermissionMode;
  fullAccessLease?: FullAccessLease;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
  description?: string;
  [key: string]: unknown;
}

export interface ModelFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
    strict?: boolean;
  };
}

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ModelMessage =
  | { role: 'system' | 'developer' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ModelToolCall[];
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
    };

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: AgentJsonValue;
  argumentsJson: string;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelCompletion {
  id?: string;
  assistantMessage: Extract<ModelMessage, { role: 'assistant' }>;
  toolCalls: NormalizedToolCall[];
  finishReason: string;
  usage?: ModelUsage;
}

export interface ModelCompletionRequest {
  messages: ModelMessage[];
  tools: ModelFunctionTool[];
  toolChoice?: 'auto' | 'none' | 'required';
}

export type ToolResultStatus =
  | 'ok'
  | 'failed'
  | 'partial'
  | 'cancelled'
  | 'effect-unknown';

export interface ToolResult<T extends AgentJsonValue = AgentJsonValue> {
  invocationId: string;
  status: ToolResultStatus;
  data?: T;
  errorCode?: string;
  message?: string;
  externalReceipts?: string[];
  undoToken?: string;
}

export type AgentRunState =
  | 'model-streaming'
  | 'awaiting-approval'
  | 'tool-running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial'
  | 'external-effect';

export type AgentRunEventType =
  | 'run-state'
  | 'model-delta'
  | 'model-completed'
  | 'tool-proposed'
  | 'approval-required'
  | 'approval-decided'
  | 'tool-started'
  | 'tool-finished'
  | 'run-terminal';

export interface AgentRunEvent {
  version: 1;
  runId: string;
  sequence: number;
  timestamp: string;
  type: AgentRunEventType;
  payload: AgentJsonValue;
}

export interface AuditEventInput {
  runId: string;
  invocationId?: string;
  actor: 'user' | 'model' | 'system';
  event: string;
  toolName?: string;
  risk?: RiskLevel;
  arguments?: AgentJsonValue;
  effects?: EffectPlan;
  policyReason?: string;
  grantId?: string;
  outcome?: string;
  details?: AgentJsonValue;
  sensitivePaths?: string[];
}

export interface AuditRecord extends Omit<AuditEventInput, 'sensitivePaths'> {
  sequence: number;
  timestamp: string;
  previousHash: string;
  eventHash: string;
}
