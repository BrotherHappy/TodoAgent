import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import { buildAgentQuickSuggestions } from "../src/renderer/agent-quick-suggestions";

const task = (status: Task["status"]): Task =>
  ({
    id: crypto.randomUUID(),
    title: "示例任务",
    status,
    source: { type: "local" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as Task;

describe("buildAgentQuickSuggestions", () => {
  it("offers read-only planning prompts when open work exists", () => {
    const suggestions = buildAgentQuickSuggestions([task("open"), task("completed")]);
    expect(suggestions.map((item) => item.label)).toEqual([
      "看看今天",
      "排一下今天",
      "找个下一步",
    ]);
    expect(suggestions.every((item) => /不要.*修改|只读|先展示方案/u.test(item.prompt))).toBe(true);
  });

  it("offers low-pressure reflection when there is no open work", () => {
    const suggestions = buildAgentQuickSuggestions([task("completed")]);
    expect(suggestions.map((item) => item.label)).toEqual([
      "回顾完成项",
      "给我一个轻量开始",
      "告诉我能做什么",
    ]);
  });
});
