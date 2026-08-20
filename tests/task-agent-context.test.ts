import { describe, expect, it } from "vitest";
import { buildTaskAgentPrompt } from "../src/renderer/task-agent-context";

describe("buildTaskAgentPrompt", () => {
  it("keeps a selected local task and its safe read-only boundary in the draft", () => {
    const prompt = buildTaskAgentPrompt({
      id: "local-42",
      title: "整理研究笔记",
      status: "open",
      source: { type: "local" },
    });

    expect(prompt).toContain("整理研究笔记");
    expect(prompt).toContain("任务 ID：local-42");
    expect(prompt).toContain("当前状态：待办");
    expect(prompt).toContain("来源：本地");
    expect(prompt).toContain("未经我明确确认不要修改任务");
  });

  it("describes completed Feishu tasks without changing the user title", () => {
    const prompt = buildTaskAgentPrompt({
      id: "feishu-7",
      title: "发布版本 v1.59",
      status: "completed",
      source: { type: "feishu" },
    });

    expect(prompt).toContain("发布版本 v1.59");
    expect(prompt).toContain("当前状态：已完成");
    expect(prompt).toContain("来源：飞书");
  });
});
