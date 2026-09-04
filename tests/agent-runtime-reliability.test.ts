import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { AgentRuntime } from "../electron/agent/agent-runtime";
import { AuditLog, InMemoryAuditStore } from "../electron/agent/audit-log";
import { PermissionEngine } from "../electron/agent/permission-engine";
import {
  ToolRegistry,
  type TrustedToolDefinition,
} from "../electron/agent/tool-registry";
import type {
  AgentJsonValue,
  AgentRunEvent,
  ModelCompletion,
  NormalizedToolCall,
} from "../src/shared/agent-types";

type CounterArguments = { value: string };

const counterSchema = z.strictObject({ value: z.string().min(1) });

const toolCall = (
  value: string,
  id = "provider-call-1",
  name = "counter_write",
): NormalizedToolCall => ({
  id,
  name,
  arguments: { value },
  argumentsJson: JSON.stringify({ value }),
});

const completionWith = (
  call: NormalizedToolCall,
): ModelCompletion => ({
  assistantMessage: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      },
    ],
  },
  toolCalls: [call],
  finishReason: "tool_calls",
});

const finalCompletion = (): ModelCompletion => ({
  assistantMessage: { role: "assistant", content: "已处理" },
  toolCalls: [],
  finishReason: "stop",
});

const counterTool = (
  execute: TrustedToolDefinition<CounterArguments>["execute"],
  name = "counter_write",
): TrustedToolDefinition<CounterArguments> => ({
  name,
  version: 1,
  description: "Test-only side-effect counter.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  argumentsSchema: counterSchema,
  analyze: (args) => ({
    risk: "R1",
    targets: [{ kind: "task", value: args.value }],
    reads: [],
    writes: ["increment test counter"],
    network: [],
    externalEffects: [],
    reversible: true,
    preview: { action: "counter-write", value: args.value },
    baseVersions: {},
  }),
  execute,
});

const runWith = async (
  completions: ModelCompletion[],
  registry: ToolRegistry,
) => {
  const gateway = {
    complete: vi.fn(async () => {
      const completion = completions.shift();
      if (!completion) throw new Error("Unexpected model turn.");
      return completion;
    }),
  };
  const runtime = new AgentRuntime({
    modelGateway: gateway,
    permissionEngine: new PermissionEngine(),
    auditLog: new AuditLog({ store: new InMemoryAuditStore() }),
    toolRegistry: registry,
    getPermissionContext: () => ({ mode: "standard" }),
    requestApproval: () => "once",
  });
  return runtime.run({
    runId: "reliability-run",
    messages: [{ role: "user", content: "Run the test action." }],
  });
};

describe("Agent tool-run reliability", () => {
  it("emits a terminal denied event when permission policy blocks a tool", async () => {
    const events: AgentRunEvent[] = [];
    const base = counterTool(async () => ({
      invocationId: "never-executed",
      status: "ok" as const,
    }));
    const registry = new ToolRegistry([
      {
        ...base,
        analyze: (args: CounterArguments, context) => ({
          ...base.analyze(args, context),
          risk: "R2" as const,
        }),
      },
    ]);
    const completions = [
      completionWith(toolCall("blocked", "denied-call")),
      finalCompletion(),
    ];
    const runtime = new AgentRuntime({
      modelGateway: {
        complete: vi.fn(async () => {
          const completion = completions.shift();
          if (!completion) throw new Error("Unexpected model turn.");
          return completion;
        }),
      },
      permissionEngine: new PermissionEngine(),
      auditLog: new AuditLog({ store: new InMemoryAuditStore() }),
      toolRegistry: registry,
      getPermissionContext: () => ({ mode: "standard" }),
      requestApproval: () => "deny",
    });

    const output = await runtime.run({
      runId: "denied-event-run",
      messages: [{ role: "user", content: "请执行被拒绝的操作" }],
      onEvent: (event) => events.push(event),
    });

    expect(output.state).toBe("partial");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-finished",
        payload: expect.objectContaining({
          toolName: "counter_write",
          status: "denied",
          errorCode: "USER_DENIED",
        }),
      }),
    );
  });

  it("replays a successful provider call receipt without repeating its side effect", async () => {
    let executions = 0;
    const registry = new ToolRegistry([
      counterTool(async (_args, context) => {
        executions += 1;
        return {
          invocationId: context.invocation.invocationId,
          status: "ok",
          data: { executions },
        };
      }),
    ]);

    const output = await runWith(
      [
        completionWith(toolCall("first", "replayed-success")),
        completionWith(toolCall("first", "replayed-success")),
        finalCompletion(),
      ],
      registry,
    );

    expect(output).toMatchObject({ state: "completed" });
    expect(executions).toBe(1);
    expect(
      output.messages.filter(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "replayed-success",
      ),
    ).toHaveLength(2);
  });

  it("deduplicates an identical task creation when a streamed loop assigns a fresh provider call ID", async () => {
    let executions = 0;
    const registry = new ToolRegistry([
      counterTool(async (_args, context) => {
        executions += 1;
        return {
          invocationId: context.invocation.invocationId,
          status: "ok",
          data: { executions },
        };
      }, "task_create"),
    ]);

    const output = await runWith(
      [
        completionWith(toolCall("same task", "create-first", "task_create")),
        completionWith(toolCall("same task", "create-after-stream", "task_create")),
        finalCompletion(),
      ],
      registry,
    );

    expect(output).toMatchObject({ state: "completed" });
    expect(executions).toBe(1);
    expect(
      output.messages.filter(
        (message) =>
          message.role === "tool" &&
          (message.tool_call_id === "create-first" ||
            message.tool_call_id === "create-after-stream"),
      ),
    ).toHaveLength(2);
  });

  it("does not rerun an unverified side effect and exposes an external-effect outcome", async () => {
    let executions = 0;
    const registry = new ToolRegistry([
      counterTool(async () => {
        executions += 1;
        const error = Object.assign(new Error("transport dropped"), {
          code: "SIMULATED_TOOL_FAILURE",
        });
        throw error;
      }),
    ]);

    const output = await runWith(
      [
        completionWith(toolCall("first", "replayed-unknown")),
        completionWith(toolCall("first", "replayed-unknown")),
        finalCompletion(),
      ],
      registry,
    );

    expect(output).toMatchObject({
      state: "external-effect",
      errorCode: "SIMULATED_TOOL_FAILURE",
    });
    expect(executions).toBe(1);
    const toolOutputs = output.messages.filter(
      (message) =>
        message.role === "tool" && message.tool_call_id === "replayed-unknown",
    );
    expect(toolOutputs).toHaveLength(2);
    for (const message of toolOutputs) {
      if (message.role !== "tool") continue;
      expect(JSON.parse(message.content) as AgentJsonValue).toMatchObject({
        status: "effect-unknown",
      });
    }
  });

  it("rejects a changed replayed provider call and never reports the run as completed", async () => {
    let executions = 0;
    const registry = new ToolRegistry([
      counterTool(async (_args, context) => {
        executions += 1;
        return {
          invocationId: context.invocation.invocationId,
          status: "ok",
          data: { executions },
        };
      }),
    ]);

    const output = await runWith(
      [
        completionWith(toolCall("first", "changed-replay")),
        completionWith(toolCall("second", "changed-replay")),
        finalCompletion(),
      ],
      registry,
    );

    expect(output).toMatchObject({
      state: "partial",
      errorCode: "DUPLICATE_PROVIDER_CALL_MISMATCH",
    });
    expect(executions).toBe(1);
  });
});
