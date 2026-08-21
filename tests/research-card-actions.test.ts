import { describe, expect, it } from "vitest";

import { buildResearchActionTaskInput } from "../src/shared/research-card-actions";

describe("research-card-actions", () => {
  it("creates a local task draft with provenance and private planning", () => {
    const draft = buildResearchActionTaskInput(
      {
        title: "调研同步方案",
        plannedDate: "2026-08-21",
        projectId: "project-1",
      },
      {
        title: "竞品结论",
        url: "https://example.com/research",
      },
      "验证官方来源",
    );

    expect(draft).toEqual({
      title: "验证官方来源",
      notes: "来源研究卡：竞品结论\n来源链接：https://example.com/research\n原任务：调研同步方案",
      source: { type: "local" },
      sync: { status: "local" },
      projectId: "project-1",
      plannedDate: "2026-08-21",
    });
  });

  it("does not invent optional project or date fields", () => {
    const draft = buildResearchActionTaskInput(
      { title: "临时研究" },
      { title: "没有来源" },
      "整理一条结论",
    );

    expect(draft.projectId).toBeUndefined();
    expect(draft.plannedDate).toBeUndefined();
    expect(draft.source).toEqual({ type: "local" });
  });
});
