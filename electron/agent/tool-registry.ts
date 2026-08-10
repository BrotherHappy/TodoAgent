import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type {
  AgentJsonValue,
  EffectPlan,
  ExecutionGrant,
  JsonSchema,
  ModelFunctionTool,
  NormalizedToolCall,
  ToolInvocation,
  ToolResult,
} from '../../src/shared/agent-types';
import { hashPermissionValue } from './permission-engine';

export type UnhashedEffectPlan = Omit<EffectPlan, 'previewHash'>;

export interface ToolAnalysisContext {
  runId: string;
  /** Registry calls always supply this; optional keeps direct trusted-tool analysis compatible. */
  signal?: AbortSignal;
}

export interface ToolExecutionContext {
  runId: string;
  invocation: ToolInvocation;
  grant: ExecutionGrant;
  signal: AbortSignal;
}

export interface TrustedToolDefinition<
  TArguments extends AgentJsonValue = AgentJsonValue,
  TResult extends AgentJsonValue = AgentJsonValue,
> {
  name: string;
  version: number;
  description: string;
  parameters: JsonSchema;
  argumentsSchema: z.ZodType<TArguments>;
  resultSchema?: z.ZodType<TResult>;
  /** Dot paths relative to the argument object which must never enter the audit log. */
  sensitiveArgumentPaths?: string[];
  analyze(
    args: TArguments,
    context: ToolAnalysisContext,
  ): Promise<UnhashedEffectPlan> | UnhashedEffectPlan;
  execute(args: TArguments, context: ToolExecutionContext): Promise<ToolResult<TResult>>;
}

export interface PreparedToolInvocation {
  invocation: ToolInvocation;
  effects: EffectPlan;
  sensitiveArgumentPaths: string[];
  /**
   * A provider can replay the same tool-call ID after a transport retry. Once
   * this registry has a terminal side-effect result for that ID, the runtime
   * must return this receipt instead of authorizing and executing it again.
   */
  replayedResult?: ToolResult;
}

export interface ToolRegistryOptions {
  now?: () => Date;
  idFactory?: () => string;
}

interface StoredPreparedInvocation {
  invocationHash: string;
  effects: EffectPlan;
}

interface StoredProviderCallResult {
  toolName: string;
  argumentsHash: string;
  invocation: ToolInvocation;
  effects: EffectPlan;
  result: ToolResult;
}

export class ToolRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

/**
 * The trusted executor was entered but did not produce a verifiable result.
 * Callers must surface this as an unknown-effect outcome rather than treating
 * it like a safe retryable validation failure.
 */
export class ToolExecutionUnverifiedError extends ToolRegistryError {
  constructor(readonly result: ToolResult) {
    super(
      result.errorCode ?? 'TOOL_EXECUTION_UNVERIFIED',
      result.message ?? 'The tool completion could not be verified.',
    );
    this.name = 'ToolExecutionUnverifiedError';
  }
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const assertStrictObjectSchema = (
  name: string,
  schema: Record<string, unknown>,
  location: string,
): void => {
  if (schema.additionalProperties !== false) {
    throw new ToolRegistryError(
      'NON_STRICT_SCHEMA',
      `Tool ${name} object ${location} must set additionalProperties=false.`,
    );
  }
  const properties = schema.properties;
  const required = schema.required;
  if (
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    !Array.isArray(required) ||
    required.some((entry) => typeof entry !== 'string')
  ) {
    throw new ToolRegistryError(
      'NON_STRICT_SCHEMA',
      `Tool ${name} object ${location} must declare properties and required fields.`,
    );
  }
  const propertyNames = Object.keys(properties).sort();
  const requiredNames = [...required].sort();
  if (
    propertyNames.length !== requiredNames.length ||
    propertyNames.some((property, index) => property !== requiredNames[index])
  ) {
    throw new ToolRegistryError(
      'NON_STRICT_SCHEMA',
      `Tool ${name} object ${location} must require every property; nullable fields represent optional values.`,
    );
  }
};

const assertNestedStrictness = (
  name: string,
  value: unknown,
  location = '$',
): void => {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNestedStrictness(name, entry, `${location}[${index}]`));
    return;
  }
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object') {
    assertStrictObjectSchema(name, schema, location);
  }
  for (const [key, entry] of Object.entries(schema)) {
    assertNestedStrictness(name, entry, `${location}.${key}`);
  }
};

const assertStrictJsonSchema = (name: string, schema: JsonSchema): void => {
  if (schema.type !== 'object') {
    throw new ToolRegistryError('NON_STRICT_SCHEMA', `Tool ${name} must use an object schema.`);
  }
  assertNestedStrictness(name, schema);
};

export class ToolRegistry {
  private readonly tools = new Map<string, TrustedToolDefinition>();
  private readonly preparedInvocations = new Map<string, StoredPreparedInvocation>();
  private readonly providerCallResults = new Map<
    string,
    StoredProviderCallResult
  >();
  /**
   * A model can continue a streamed tool loop with a fresh provider call ID
   * after it has already received (or lost) the first create receipt. For a
   * single Agent run, an identical task_create or task_bulk_create is one
   * user-visible request, not permission to create duplicate task(s). Keep
   * this intentionally narrow: other tools, different normalized arguments,
   * and later runs are all independently reviewed and executed.
   */
  private readonly semanticTaskCreationResults = new Map<
    string,
    StoredProviderCallResult
  >();
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    definitions: TrustedToolDefinition[] = [],
    options: ToolRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register<TArguments extends AgentJsonValue, TResult extends AgentJsonValue>(
    definition: TrustedToolDefinition<TArguments, TResult>,
  ): void {
    if (!TOOL_NAME_PATTERN.test(definition.name)) {
      throw new ToolRegistryError(
        'INVALID_TOOL_NAME',
        `Tool name ${definition.name} is not compatible with Chat Completions.`,
      );
    }
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new ToolRegistryError('INVALID_TOOL_VERSION', 'Tool versions must be positive integers.');
    }
    if (this.tools.has(definition.name)) {
      throw new ToolRegistryError('DUPLICATE_TOOL', `Tool ${definition.name} is already registered.`);
    }
    assertStrictJsonSchema(definition.name, definition.parameters);
    this.tools.set(definition.name, definition as TrustedToolDefinition);
  }

  listModelTools(): ModelFunctionTool[] {
    return [...this.tools.values()].map((definition) => ({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: structuredClone(definition.parameters),
        strict: true,
      },
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async prepare(
    runId: string,
    call: NormalizedToolCall,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PreparedToolInvocation> {
    if (signal.aborted) {
      throw new ToolRegistryError('ANALYSIS_ABORTED', 'The tool run was stopped before analysis.');
    }
    const definition = this.requireDefinition(call.name);
    const parsed = definition.argumentsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      throw new ToolRegistryError(
        'INVALID_TOOL_ARGUMENTS',
        `Tool ${call.name} arguments failed validation: ${z.prettifyError(parsed.error)}`,
      );
    }
    const args = parsed.data as AgentJsonValue;
    const argumentsHash = hashPermissionValue(args);
    const replayKey = this.providerCallKey(runId, call.id);
    const previous = this.providerCallResults.get(replayKey);
    if (previous !== undefined) {
      if (
        previous.toolName !== definition.name ||
        previous.argumentsHash !== argumentsHash
      ) {
        throw new ToolRegistryError(
          'DUPLICATE_PROVIDER_CALL_MISMATCH',
          `Provider tool call ${call.id} was replayed with a different tool or arguments.`,
        );
      }
      return {
        invocation: structuredClone(previous.invocation),
        effects: structuredClone(previous.effects),
        sensitiveArgumentPaths: [...(definition.sensitiveArgumentPaths ?? [])],
        replayedResult: structuredClone(previous.result),
      };
    }
    const semanticCreationKey = this.semanticTaskCreationKey(
      runId,
      definition.name,
      argumentsHash,
    );
    const semanticPrevious = semanticCreationKey
      ? this.semanticTaskCreationResults.get(semanticCreationKey)
      : undefined;
    if (semanticPrevious !== undefined) {
      return {
        invocation: structuredClone(semanticPrevious.invocation),
        effects: structuredClone(semanticPrevious.effects),
        sensitiveArgumentPaths: [...(definition.sensitiveArgumentPaths ?? [])],
        replayedResult: structuredClone(semanticPrevious.result),
      };
    }
    const invocation: ToolInvocation = {
      invocationId: this.idFactory(),
      runId,
      providerCallId: call.id,
      toolName: definition.name,
      toolVersion: definition.version,
      arguments: structuredClone(args),
      argumentsHash,
      createdAt: this.now().toISOString(),
    };
    const unhashedEffects = await definition.analyze(args, { runId, signal });
    if (signal.aborted) {
      throw new ToolRegistryError('ANALYSIS_ABORTED', 'The tool run was stopped during analysis.');
    }
    const effects: EffectPlan = {
      ...structuredClone(unhashedEffects),
      previewHash: hashPermissionValue(unhashedEffects.preview),
    };
    this.preparedInvocations.set(invocation.invocationId, {
      invocationHash: hashPermissionValue(invocation),
      effects: structuredClone(effects),
    });
    return {
      invocation,
      effects,
      sensitiveArgumentPaths: [...(definition.sensitiveArgumentPaths ?? [])],
    };
  }

  async execute(
    invocation: ToolInvocation,
    grant: ExecutionGrant,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      throw new ToolRegistryError('EXECUTION_ABORTED', 'The tool run was stopped before execution.');
    }
    if (
      grant.invocationId !== invocation.invocationId ||
      grant.runId !== invocation.runId ||
      grant.toolName !== invocation.toolName ||
      grant.argumentsHash !== invocation.argumentsHash ||
      grant.maxUses !== 1
    ) {
      throw new ToolRegistryError(
        'GRANT_SCOPE_MISMATCH',
        'The execution grant does not match this invocation.',
      );
    }
    const prepared = this.preparedInvocations.get(invocation.invocationId);
    this.preparedInvocations.delete(invocation.invocationId);
    if (
      prepared === undefined ||
      prepared.invocationHash !== hashPermissionValue(invocation) ||
      prepared.effects.previewHash !== grant.previewHash ||
      prepared.effects.risk !== grant.risk
    ) {
      throw new ToolRegistryError(
        'PREPARED_INVOCATION_MISMATCH',
        'The execution request does not match the invocation prepared for review.',
      );
    }
    const definition = this.requireDefinition(invocation.toolName);
    if (definition.version !== invocation.toolVersion) {
      throw new ToolRegistryError(
        'TOOL_VERSION_CHANGED',
        `Tool ${invocation.toolName} changed after it was reviewed.`,
      );
    }
    const parsedArguments = definition.argumentsSchema.safeParse(invocation.arguments);
    if (!parsedArguments.success) {
      throw new ToolRegistryError(
        'INVALID_TOOL_ARGUMENTS',
        `Tool ${invocation.toolName} arguments changed after validation.`,
      );
    }
    const currentUnhashedEffects = await definition.analyze(
      parsedArguments.data as AgentJsonValue,
      { runId: invocation.runId, signal },
    );
    if (signal.aborted) {
      throw new ToolRegistryError('EXECUTION_ABORTED', 'The tool run was stopped during final analysis.');
    }
    const currentEffects: EffectPlan = {
      ...structuredClone(currentUnhashedEffects),
      previewHash: hashPermissionValue(currentUnhashedEffects.preview),
    };
    if (hashPermissionValue(currentEffects) !== hashPermissionValue(prepared.effects)) {
      throw new ToolRegistryError(
        'EFFECT_PLAN_CHANGED',
        'The reviewed targets, preview, or base versions changed before execution.',
      );
    }
    try {
      const result = await definition.execute(parsedArguments.data as AgentJsonValue, {
        runId: invocation.runId,
        invocation,
        grant,
        signal,
      });
      if (result.invocationId !== invocation.invocationId) {
        throw new ToolRegistryError(
          'RESULT_INVOCATION_MISMATCH',
          `Tool ${invocation.toolName} returned a result for another invocation.`,
        );
      }
      if (definition.resultSchema !== undefined && result.data !== undefined) {
        const parsedResult = definition.resultSchema.safeParse(result.data);
        if (!parsedResult.success) {
          throw new ToolRegistryError(
            'INVALID_TOOL_RESULT',
            `Tool ${invocation.toolName} returned an invalid result.`,
          );
        }
        result.data = parsedResult.data as AgentJsonValue;
      }
      if (this.shouldReplayResult(result)) {
        this.storeReplayResult(invocation, prepared.effects, result);
      }
      return result;
    } catch (error) {
      // An exception raised by the executor can happen after the underlying
      // adapter has begun a write or a network request. Preserve an
      // effect-unknown receipt for this exact provider call, so a provider
      // retry cannot accidentally repeat an already-successful side effect.
      const unknownResult: ToolResult = {
        invocationId: invocation.invocationId,
        status: 'effect-unknown',
        errorCode: this.errorCodeOf(error, 'TOOL_EXECUTION_UNVERIFIED'),
        message:
          'The tool started but its completion could not be verified. Do not retry this provider tool-call ID.',
      };
      this.storeReplayResult(invocation, prepared.effects, unknownResult);
      throw new ToolExecutionUnverifiedError(unknownResult);
    }
  }

  private storeReplayResult(
    invocation: ToolInvocation,
    effects: EffectPlan,
    result: ToolResult,
  ): void {
    const stored: StoredProviderCallResult = {
      toolName: invocation.toolName,
      argumentsHash: invocation.argumentsHash,
      invocation: structuredClone(invocation),
      effects: structuredClone(effects),
      result: structuredClone(result),
    };
    this.providerCallResults.set(
      this.providerCallKey(invocation.runId, invocation.providerCallId),
      stored,
    );
    const semanticCreationKey = this.semanticTaskCreationKey(
      invocation.runId,
      invocation.toolName,
      invocation.argumentsHash,
    );
    if (semanticCreationKey) {
      this.semanticTaskCreationResults.set(semanticCreationKey, stored);
    }
  }

  private providerCallKey(runId: string, providerCallId: string): string {
    return `${runId}\u0000${providerCallId}`;
  }

  private semanticTaskCreationKey(
    runId: string,
    toolName: string,
    argumentsHash: string,
  ): string | undefined {
    if (toolName !== 'task_create' && toolName !== 'task_bulk_create') {
      return undefined;
    }
    return `${runId}\u0000${toolName}\u0000${argumentsHash}`;
  }

  private shouldReplayResult(result: ToolResult): boolean {
    return (
      result.status === 'ok' ||
      result.status === 'partial' ||
      result.status === 'effect-unknown' ||
      result.undoToken !== undefined ||
      (result.externalReceipts?.length ?? 0) > 0
    );
  }

  private errorCodeOf(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code.trim()) return code;
    }
    return error instanceof Error && error.name ? error.name : fallback;
  }

  private requireDefinition(name: string): TrustedToolDefinition {
    const definition = this.tools.get(name);
    if (definition === undefined) {
      throw new ToolRegistryError('UNKNOWN_TOOL', `Tool ${name} is not registered.`);
    }
    return definition;
  }
}
