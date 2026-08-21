import { describe, expect, it } from "vitest";
import { parseSmartViewQuery } from "../src/renderer/smart-view-query";

describe("parseSmartViewQuery", () => {
  const options = {
    projects: ["研究项目", "个人"],
    tags: ["论文", "发布"],
    sections: ["本周发布", "下周整理"],
    contexts: ["办公室", "家"],
  };

  it("turns a natural-language request into previewable filters", () => {
    const result = parseSmartViewQuery("本周高优先级的飞书任务 项目：研究项目 标签：论文", options);

    expect(result.kind).toBe("suggestion");
    if (result.kind !== "suggestion") return;
    expect(result.value.filters).toEqual({
      priority: "high",
      flagged: false,
      projectId: "研究项目",
      tag: "论文",
      sectionId: "all",
      context: "all",
      dateFilter: "next-7-days",
      sort: "manual",
      sourceType: "feishu",
    });
    expect(result.value.summary).toEqual([
      "高优先级",
      "未来 7 天",
      "飞书",
      "项目：研究项目",
      "标签：论文",
    ]);
  });

  it("supports explicit context and sort without a model", () => {
    const result = parseSmartViewQuery("情境:办公室 按截止时间", options);

    expect(result.kind).toBe("suggestion");
    if (result.kind !== "suggestion") return;
    expect(result.value.filters.context).toBe("办公室");
    expect(result.value.filters.sort).toBe("due");
  });

  it("supports a local section heading and fails closed for unknown headings", () => {
    const result = parseSmartViewQuery("分组：本周发布 按标题", options);
    expect(result).toMatchObject({
      kind: "suggestion",
      value: {
        filters: { sectionId: "本周发布", sort: "title" },
        summary: ["按标题", "分组：本周发布"],
      },
    });
    expect(parseSmartViewQuery("分组标题：本周发布", options)).toMatchObject({
      kind: "suggestion",
      value: { filters: { sectionId: "本周发布" } },
    });
    expect(parseSmartViewQuery("分组：不存在", options)).toMatchObject({
      kind: "error",
      value: {
        message: "没有找到分组标题“不存在”，请先在任务中使用已有分组标题。",
      },
    });
  });

  it("recognizes the private attention marker", () => {
    const result = parseSmartViewQuery("已标记的高优先级任务", options);

    expect(result).toMatchObject({
      kind: "suggestion",
      value: {
        filters: { flagged: true, priority: "high" },
        summary: ["高优先级", "重点标记"],
      },
    });
  });

  it("fails closed for unknown values and ambiguous categories", () => {
    expect(parseSmartViewQuery("项目：不存在", options)).toMatchObject({
      kind: "error",
      value: { message: "没有找到项目“不存在”，请先创建或选择已有项目。" },
    });
    expect(parseSmartViewQuery("今天 未来7天", options)).toMatchObject({
      kind: "error",
      value: { message: expect.stringContaining("日期条件有多个") },
    });
  });

  it("rejects empty, overlong and unrecognized requests", () => {
    expect(parseSmartViewQuery("", options)).toMatchObject({ kind: "error" });
    expect(parseSmartViewQuery("x".repeat(121), options)).toMatchObject({
      kind: "error",
      value: { message: "筛选语句最多 120 个字。" },
    });
    expect(parseSmartViewQuery("帮我看看最近的事情", options)).toMatchObject({
      kind: "error",
      value: { message: expect.stringContaining("没有识别到筛选条件") },
    });
  });
});
