import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkTaskEditSheet } from "../src/renderer/BulkTaskEditSheet";
import type { TaskList, TaskProject } from "../src/shared/models";

afterEach(() => cleanup());

const projects: TaskProject[] = [
  {
    id: "project-release",
    name: "发布",
    color: "violet",
    archived: false,
    privateOrder: 0,
    createdAt: "2026-08-21T08:00:00.000Z",
    updatedAt: "2026-08-21T08:00:00.000Z",
  },
];
const lists: TaskList[] = [
  {
    id: "list-week",
    name: "本周",
    color: "blue",
    archived: false,
    privateOrder: 0,
    createdAt: "2026-08-21T08:00:00.000Z",
    updatedAt: "2026-08-21T08:00:00.000Z",
  },
];

describe("BulkTaskEditSheet", () => {
  it("builds a reviewed private attribute patch", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <BulkTaskEditSheet
        count={3}
        projects={projects}
        lists={lists}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText("批量优先级"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("批量重点标记"), { target: { value: "on" } });
    fireEvent.change(screen.getByLabelText("批量项目"), { target: { value: "project-release" } });
    fireEvent.change(screen.getByLabelText("批量清单"), { target: { value: "list-week" } });
    fireEvent.change(screen.getByLabelText("批量标签操作"), { target: { value: "add" } });
    fireEvent.change(screen.getByLabelText("批量标签值"), { target: { value: "重要, 发布" } });
    fireEvent.click(screen.getByRole("button", { name: "预览批量修改" }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm).toHaveBeenCalledWith({
      priority: "high",
      flagged: true,
      projectId: "project-release",
      listId: "list-week",
      tags: { mode: "add", values: ["重要", "发布"] },
    });
  });

  it("allows replacing all tags with an empty list", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <BulkTaskEditSheet count={1} onClose={vi.fn()} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText("批量标签操作"), { target: { value: "replace" } });
    fireEvent.click(screen.getByRole("button", { name: "预览批量修改" }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm).toHaveBeenCalledWith({
      tags: { mode: "replace", values: [] },
    });
  });

  it("starts in the first field and keeps Tab inside the sheet", () => {
    render(
      <BulkTaskEditSheet count={1} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );
    const firstField = screen.getByLabelText("批量优先级");
    const close = screen.getByRole("button", { name: "关闭批量编辑" });
    const lastAction = screen.getByRole("button", { name: "预览批量修改" });

    expect(firstField).toHaveFocus();
    lastAction.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(lastAction).toHaveFocus();
  });
});
