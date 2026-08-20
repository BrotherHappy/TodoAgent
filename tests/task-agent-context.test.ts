import { describe, expect, it } from "vitest";
import {
  buildBulkTaskAgentPrompt,
  buildTaskAgentPrompt,
} from "../src/renderer/task-agent-context";

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

  it("creates a review-first draft for a selected batch and caps inline context", () => {
    const tasks = Array.from({ length: 22 }, (_, index) => ({
      id: `task-${index + 1}`,
      title: `任务 ${index + 1}`,
      status: "open" as const,
      source: { type: index % 2 === 0 ? ("local" as const) : ("feishu" as const) },
    }));

    const prompt = buildBulkTaskAgentPrompt(tasks);

    expect(prompt).toContain("我在任务列表中选中了 22 项任务");
    expect(prompt).toContain("任务 1");
    expect(prompt).toContain("任务 20");
    expect(prompt).not.toContain("任务 21");
    expect(prompt).toContain("其余 2 项只保留在列表选择中");
    expect(prompt).toContain("未经我明确确认不要修改");
    expect(prompt).toContain("不要猜测完成、删除或改期操作");
  });
});
