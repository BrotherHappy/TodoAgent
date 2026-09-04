import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/models";
import { TaskTemplateSaveSheet } from "../src/renderer/TaskTemplateSaveSheet";
import type { TaskTemplate } from "../src/renderer/task-templates";

const task: Task = {
  id: "task-1",
  source: { type: "feishu", externalId: "remote-1", accountId: "account" },
  title: "整理发布清单",
  notes: "先确认截图和链接",
  privateNotes: "只留在本机",
  status: "open",
  priority: "high",
  tags: ["发布"],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  privateOrder: 0,
  sync: { status: "synced" },
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
  estimatedMinutes: 45,
};

afterEach(() => cleanup());

describe("TaskTemplateSaveSheet", () => {
  it("shows the local-only boundary and saves an editable template", async () => {
    const onConfirm = vi.fn(async (_template: TaskTemplate) => undefined);
    render(
      <TaskTemplateSaveSheet
        task={task}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/不会复制/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模板名称"), {
      target: { value: "每周发布" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存本地模板" }));

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    const [template] = onConfirm.mock.calls[0]!;
    expect(template).toMatchObject({
      name: "每周发布",
      defaultSource: "local",
      steps: [{ titleTemplate: "{{title}}", estimatedMinutes: 45 }],
    });
    expect(template.id).toMatch(/^[a-z0-9][a-z0-9-]{1,39}$/u);
  });

  it("requires a name before saving", () => {
    const onConfirm = vi.fn(async (_template: TaskTemplate) => undefined);
    render(
      <TaskTemplateSaveSheet
        task={task}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "保存本地模板" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请先填写模板名称");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("lets the user opt out of copying the parent task's subtasks", async () => {
    const onConfirm = vi.fn(async (_template: TaskTemplate) => undefined);
    const subtask: Task = {
      ...task,
      id: "subtask-1",
      parentId: task.id,
      title: "校对说明",
      notes: "检查链接",
      priority: "medium",
      estimatedMinutes: 15,
    };
    render(
      <TaskTemplateSaveSheet
        task={task}
        subtasks={[subtask]}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /包含 1 个子任务/ })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /包含 1 个子任务/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存本地模板" }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm.mock.calls[0]![0].steps).toHaveLength(1);
  });

  it("focuses the template name, traps Tab, and closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <TaskTemplateSaveSheet task={task} onClose={onClose} onConfirm={vi.fn(async () => undefined)} />,
    );

    const name = screen.getByLabelText("模板名称");
    const close = screen.getByRole("button", { name: "关闭模板保存" });
    const save = screen.getByRole("button", { name: "保存本地模板" });
    expect(name).toHaveFocus();
    save.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
