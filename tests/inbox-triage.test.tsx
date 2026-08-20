import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxTriageSheet } from "../src/renderer/InboxTriageSheet";
import type { Task } from "../src/shared/models";

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title: id,
  notes: "",
  privateNotes: "",
  status: "open",
  priority: "medium",
  tags: [],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  focusSessions: [],
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  ...overrides,
});

const renderSheet = (tasks: Task[]) => {
  const props = {
    tasks,
    onUpdate: vi.fn(async () => "operation-plan"),
    onComplete: vi.fn(async () => "operation-complete"),
    onOpenTask: vi.fn(),
    onClose: vi.fn(),
  };
  render(<InboxTriageSheet {...props} />);
  return props;
};

afterEach(() => cleanup());

describe("InboxTriageSheet", () => {
  it("moves one task at a time and keeps skip local", async () => {
    const user = userEvent.setup();
    const props = renderSheet([makeTask("整理资料"), makeTask("回复消息")]);

    expect(screen.getByRole("heading", { name: "把想法放到合适的位置" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "整理资料" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^稍后\s*S$/u }));
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "回复消息" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /今天/u }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledTimes(1));
    expect(props.onUpdate).toHaveBeenCalledWith(
      "回复消息",
      expect.objectContaining({ plannedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) }),
    );
    expect(screen.getByText("暂存清爽了")).toBeVisible();
  });

  it("supports keyboard shortcuts and opens the current task without mutating it", async () => {
    const props = renderSheet([makeTask("准备演示")]);

    fireEvent.keyDown(window, { key: "o" });
    expect(props.onOpenTask).toHaveBeenCalledWith("准备演示");
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("completes the current task and exposes a gentle close path", async () => {
    const user = userEvent.setup();
    const props = renderSheet([makeTask("清理桌面")]);

    await user.click(screen.getByRole("button", { name: /完成/u }));
    await waitFor(() => expect(props.onComplete).toHaveBeenCalledWith(expect.objectContaining({ id: "清理桌面" })));
    expect(screen.getByText("暂存清爽了")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "回到任务列表" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
