import { describe, expect, it } from "vitest";
import {
  allTaskTemplates,
  buildTaskTemplateFromTask,
  buildTaskTemplateInputs,
  builtInTaskTemplates,
  installTaskTemplate,
  loadCustomTaskTemplates,
  parseTaskTemplateJson,
  previewTaskTemplate,
  parentTaskIdForTemplateInput,
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
  it("turns an existing task into a local-only reusable recipe", () => {
    const template = buildTaskTemplateFromTask(
      {
        title: "整理发布清单",
        notes: "先确认截图和链接",
        tags: ["发布", "发布"],
        priority: "high",
        estimatedMinutes: 45,
      },
      {
        id: "publish-checklist-abc",
        name: "发布检查",
        description: "每次发布前复用",
        now: new Date("2026-08-21T08:00:00.000Z"),
      },
    );
    expect(template).toMatchObject({
      id: "publish-checklist-abc",
      name: "发布检查",
      defaultSource: "local",
      steps: [
        {
          id: "task",
          titleTemplate: "{{title}}",
          notesTemplate: "先确认截图和链接",
          tags: ["发布"],
          priority: "high",
          estimatedMinutes: 45,
          plannedDayOffset: 0,
        },
      ],
      createdAt: "2026-08-21T08:00:00.000Z",
      updatedAt: "2026-08-21T08:00:00.000Z",
    });
  });

  it("can preserve a small parent/subtask checklist while keeping it local", () => {
    const template = buildTaskTemplateFromTask(
      {
        title: "发布版本",
        notes: "",
        tags: ["发布"],
        priority: "high",
        estimatedMinutes: 30,
      },
      {
        id: "release-checklist-abc",
        name: "发布清单",
        subtasks: [
          {
            title: "校对说明",
            notes: "检查链接",
            tags: ["校对"],
            priority: "medium",
            estimatedMinutes: 15,
          },
          {
            title: "通知团队",
            notes: "",
            tags: [],
            priority: "none",
            estimatedMinutes: undefined,
          },
        ],
        includeSubtasks: true,
      },
    );
    expect(template.steps).toHaveLength(3);
    expect(template.steps[1]).toMatchObject({
      id: "subtask-1",
      titleTemplate: "校对说明",
      parentStepId: "task",
    });
    expect(template.steps[2]?.parentStepId).toBe("task");

    const inputs = buildTaskTemplateInputs(template, "新版本", {
      date: "2026-08-21",
    });
    expect(inputs[1]?.customFields).toMatchObject({
      templateStepId: "subtask-1",
      templateParentStepId: "task",
    });
    const created = new Map([["task", "created-parent"]]);
    expect(parentTaskIdForTemplateInput(inputs[1]!, "local", created)).toBe(
      "created-parent",
    );
    expect(parentTaskIdForTemplateInput(inputs[1]!, "feishu", created)).toBe(
      undefined,
    );
  });

  it("does not copy provider identity or invalid estimates into a template", () => {
    const template = buildTaskTemplateFromTask(
      {
        title: "飞书任务",
        notes: "包含 {{unsupported}} 变量的旧备注",
        tags: [],
        priority: "none",
        estimatedMinutes: 1,
      },
      { id: "feishu-recipe-abc", name: "飞书任务模板" },
    );
    expect(template.defaultSource).toBe("local");
    expect(template.steps[0]).not.toHaveProperty("notesTemplate");
    expect(template.steps[0]).not.toHaveProperty("estimatedMinutes");
    expect(template.steps[0]).not.toHaveProperty("source");
  });

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
    expect(validateTaskTemplate({
      ...base,
      steps: [
        { id: "one", titleTemplate: "父步骤" },
        { id: "two", titleTemplate: "子步骤", parentStepId: "missing" },
      ],
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
