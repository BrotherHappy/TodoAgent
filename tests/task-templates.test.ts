import { describe, expect, it } from "vitest";
import {
  allTaskTemplates,
  buildTaskTemplateInputs,
  builtInTaskTemplates,
  installTaskTemplate,
  loadCustomTaskTemplates,
  parseTaskTemplateJson,
  previewTaskTemplate,
  removeTaskTemplate,
  replaceTemplateVariables,
  validateTaskTemplate,
} from "../src/renderer/task-templates";

class MemoryStorage {
  #values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe("task templates", () => {
  it("ships safe built-in workflows and renders placeholders with date offsets", () => {
    const template = builtInTaskTemplates.find((item) => item.id === "publish-article")!;
    const preview = previewTaskTemplate(template, "Todo Pet 发布说明", {
      date: "2026-08-19",
      dueAt: "2026-08-19T18:00:00.000Z",
      now: new Date("2026-08-19T09:00:00.000Z"),
    });
    expect(preview.steps.map((step) => step.title)).toEqual([
      "列出提纲：Todo Pet 发布说明",
      "完成初稿：Todo Pet 发布说明",
      "校对并发布：Todo Pet 发布说明",
    ]);
    expect(preview.steps.map((step) => step.plannedDate)).toEqual([
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ]);
    expect(replaceTemplateVariables("{{title}} · {{date}}", {
      title: "演示",
      date: "2026-08-19",
      now: "now",
    })).toBe("演示 · 2026-08-19");
  });

  it("creates a batch of local task inputs and carries only the first reminder", () => {
    const template = builtInTaskTemplates.find((item) => item.id === "meeting-follow-up")!;
    const inputs = buildTaskTemplateInputs(template, "季度评审", {
      date: "2026-08-19",
      notes: "会前材料已附",
      tags: ["工作"],
      priority: "high",
      reminderAt: "2026-08-19T09:30:00.000Z",
    });
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toMatchObject({
      title: "整理会议记录：季度评审",
      notes: "会前材料已附",
      plannedDate: "2026-08-19",
      priority: "medium",
      tags: ["工作", "会议"],
    });
    expect(inputs[0].reminders).toHaveLength(1);
    expect(inputs[1].reminders).toEqual([]);
    expect(inputs[2].plannedDate).toBe("2026-08-21");
    expect(inputs[0].customFields).toEqual({
      templateId: "meeting-follow-up",
      templateStepId: "notes",
    });
  });

  it("rejects scripts, unknown placeholders and unsafe step fields", () => {
    const base = {
      id: "safe-template",
      name: "安全模板",
      description: "测试",
      defaultSource: "local",
      steps: [{ id: "one", titleTemplate: "处理 {{title}}" }],
    };
    expect(validateTaskTemplate({ ...base, script: "alert(1)" })).toMatchObject({ ok: false });
    expect(validateTaskTemplate({
      ...base,
      steps: [{ id: "one", titleTemplate: "执行 {{unknown}}" }],
    })).toMatchObject({ ok: false });
    expect(validateTaskTemplate({
      ...base,
      steps: [{ id: "one", titleTemplate: "处理 {{title}}", command: "rm -rf" }],
    })).toMatchObject({ ok: false });
    expect(parseTaskTemplateJson("not json")).toMatchObject({ ok: false });
  });

  it("keeps preview usable when a persisted draft contains an invalid due date", () => {
    const template = builtInTaskTemplates.find((item) => item.id === "publish-article")!;
    const preview = previewTaskTemplate(template, "异常日期演示", {
      date: "2026-08-19",
      dueAt: "not-a-date",
    });
    expect(preview.steps.every((step) => step.dueAt === undefined)).toBe(true);
  });

  it("persists custom templates without allowing built-in IDs to be replaced", () => {
    const storage = new MemoryStorage();
    const parsed = parseTaskTemplateJson(JSON.stringify({
      id: "launch-checklist",
      name: "发布检查",
      description: "发布前确认",
      defaultSource: "local",
      steps: [{ id: "check", titleTemplate: "检查：{{title}}", estimatedMinutes: 30 }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    installTaskTemplate(parsed.template, storage);
    expect(loadCustomTaskTemplates(storage)).toHaveLength(1);
    expect(allTaskTemplates(loadCustomTaskTemplates(storage))).toHaveLength(
      builtInTaskTemplates.length + 1,
    );
    expect(validateTaskTemplate({
      ...parsed.template,
      id: "publish-article",
    })).toMatchObject({ ok: false });
    removeTaskTemplate("launch-checklist", storage);
    expect(loadCustomTaskTemplates(storage)).toEqual([]);
  });
});
