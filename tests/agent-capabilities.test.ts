import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../electron/agent/tool-registry";
import type { ExecutionGrant } from "../src/shared/agent-types";
import {
  AGENT_CAPABILITY_DESCRIPTORS,
  enabledAgentCapabilityKeys,
  isAgentToolEnabled,
} from "../src/shared/agent-capabilities";
import { defaultSettings } from "../src/shared/settings";

describe("Agent capability layers", () => {
  it("covers every built-in tool family with a known capability", () => {
    const names = [
      "task_list",
      "task_bulk_update",
      "move_to_today",
      "set_reminder",
      "undo_task_operation",
      "file_read",
      "terminal_run",
      "clipboard_read",
      "screen_capture",
      "http_fetch",
      "web_search",
      "url_open",
    ];
    expect(names.every((name) => isAgentToolEnabled(name, defaultSettings.agentCapabilities))).toBe(true);
    expect(isAgentToolEnabled("future_unregistered_tool", defaultSettings.agentCapabilities)).toBe(false);
  });

  it("removes only the disabled family from the model tool list", () => {
    const capabilities = {
      ...defaultSettings.agentCapabilities,
      filesAndTerminal: false,
      webResearch: false,
    };
    expect(isAgentToolEnabled("file_read", capabilities)).toBe(false);
    expect(isAgentToolEnabled("terminal_run", capabilities)).toBe(false);
    expect(isAgentToolEnabled("web_search", capabilities)).toBe(false);
    expect(isAgentToolEnabled("task_list", capabilities)).toBe(true);
    expect(isAgentToolEnabled("clipboard_read", capabilities)).toBe(true);
    expect(enabledAgentCapabilityKeys(capabilities)).toEqual([
      "taskManagement",
      "feishuSync",
      "clipboardAndScreen",
    ]);
  });

  it("keeps the visible order stable for the permissions center", () => {
    expect(AGENT_CAPABILITY_DESCRIPTORS.map((descriptor) => descriptor.key)).toEqual([
      "taskManagement",
      "feishuSync",
      "webResearch",
      "filesAndTerminal",
      "clipboardAndScreen",
    ]);
  });

  it("re-checks a capability between approval and execution", async () => {
    let enabled = true;
    let executions = 0;
    const registry = new ToolRegistry(
      [
        {
          name: "web_search",
          version: 1,
          description: "test",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          argumentsSchema: z.strictObject({}),
          analyze: () => ({
            risk: "R0" as const,
            targets: [],
            reads: [],
            writes: [],
            network: [],
            externalEffects: [],
            reversible: true,
            preview: { action: "test" },
            baseVersions: {},
          }),
          execute: async (args, context) => {
            void args;
            executions += 1;
            return {
              invocationId: context.invocation.invocationId,
              status: "ok" as const,
              data: { ok: true },
            };
          },
        },
      ],
      { isToolEnabled: () => enabled },
    );
    const prepared = await registry.prepare("run", {
      id: "call",
      name: "web_search",
      arguments: {},
      argumentsJson: "{}",
    });
    enabled = false;
    await expect(
      registry.execute(
        prepared.invocation,
        {
          invocationId: prepared.invocation.invocationId,
          runId: prepared.invocation.runId,
          toolName: prepared.invocation.toolName,
          argumentsHash: prepared.invocation.argumentsHash,
          maxUses: 1,
          previewHash: prepared.effects.previewHash,
          risk: prepared.effects.risk,
        } as ExecutionGrant,
        new AbortController().signal,
      ),
    ).rejects.toThrow("currently disabled");
    expect(executions).toBe(0);
  });
});
