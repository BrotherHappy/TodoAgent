import { describe, expect, it } from "vitest";

import {
  resolveAgentTaskSourceSelection,
  resolveAgentTaskSourcePolicy,
  taskSourcePolicyInstruction,
} from "../electron/agent/task-source-policy";

describe("Agent task source policy", () => {
  it.each([
    ["创建一个本地任务，标题是整理周报", { kind: "explicit", source: "local" }],
    ["请在飞书创建一个任务，标题是同步周报", { kind: "explicit", source: "feishu" }],
    ["创建一个任务，标题是整理周报", { kind: "default-local", source: "local" }],
  ] as const)("resolves %s without trusting the model to choose a source", (message, expected) => {
    expect(resolveAgentTaskSourcePolicy(message)).toEqual(expected);
  });

  it("requires clarification for conflicting or unbound source references", () => {
    expect(
      resolveAgentTaskSourcePolicy("创建一个本地任务并同步到飞书"),
    ).toEqual({
      kind: "clarification-required",
      reason: "conflicting-explicit-sources",
    });
    expect(
      resolveAgentTaskSourcePolicy("创建一个任务。放到飞书"),
    ).toEqual({
      kind: "clarification-required",
      reason: "unbound-source-reference",
    });
  });

  it("recognizes an explicit source label without confusing a title containing 飞书 for a destination", () => {
    expect(
      resolveAgentTaskSourcePolicy("创建一个任务，来源是飞书，标题是同步周报"),
    ).toEqual({ kind: "explicit", source: "feishu" });
    expect(
      resolveAgentTaskSourcePolicy("创建一个任务，来源是本地，标题是整理周报"),
    ).toEqual({ kind: "explicit", source: "local" });
    expect(
      resolveAgentTaskSourcePolicy("创建一个任务，标题是飞书集成"),
    ).toEqual({ kind: "default-local", source: "local" });
    expect(
      resolveAgentTaskSourcePolicy('Create a task titled "Feishu integration"'),
    ).toEqual({ kind: "default-local", source: "local" });
  });

  it("recognizes common English explicit source requests and only accepts bare source words as a selection", () => {
    expect(resolveAgentTaskSourcePolicy("Create a Feishu task")).toEqual({
      kind: "explicit",
      source: "feishu",
    });
    expect(resolveAgentTaskSourcePolicy("create a local task")).toEqual({
      kind: "explicit",
      source: "local",
    });
    expect(resolveAgentTaskSourceSelection("飞书")).toBe("feishu");
    expect(resolveAgentTaskSourceSelection("Feishu")).toBe("feishu");
    expect(resolveAgentTaskSourceSelection("本地吧")).toBe("local");
    expect(resolveAgentTaskSourceSelection("标题叫飞书")).toBeUndefined();
  });

  it("tells the model to stop rather than inventing a source when clarification is required", () => {
    const policy = resolveAgentTaskSourcePolicy(
      "创建一个本地任务并同步到飞书",
    );
    expect(taskSourcePolicyInstruction(policy)).toContain("不要调用 task_create");
    expect(taskSourcePolicyInstruction(policy)).toContain("本地还是飞书");
  });
});
