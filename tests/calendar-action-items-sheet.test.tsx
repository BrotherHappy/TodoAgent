import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarActionItemsSheet } from "../src/renderer/CalendarActionItemsSheet";

const event = {
  id: "calendar-sheet",
  summary: "产品同步会",
  startAt: "2026-08-20T10:00:00.000Z",
  endAt: "2026-08-20T11:00:00.000Z",
  allDay: false,
  sourceName: "工作日历",
};

const drafts = [
  {
    id: "action-1",
    title: "联系客户",
    notes: "会议：产品同步会",
    plannedDate: "2026-08-20",
  },
  {
    id: "action-2",
    title: "更新方案",
    notes: "会议：产品同步会",
    plannedDate: "2026-08-20",
  },
];

afterEach(cleanup);

describe("CalendarActionItemsSheet", () => {
  it("lets the user edit and select the local task batch before confirming", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <CalendarActionItemsSheet
        event={event}
        drafts={drafts}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog", { name: "会议行动项预览" })).toBeVisible();
    expect(screen.getByText("产品同步会")).toBeVisible();
    const second = screen.getByLabelText("选择行动项 2");
    fireEvent.click(second);
    fireEvent.change(screen.getByLabelText("行动项 1"), {
      target: { value: "联系客户（今天）" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建 1 项本地任务" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([
      expect.objectContaining({ title: "联系客户（今天）" }),
    ]));
  });

  it("keeps the preview open and exposes an actionable error when creation fails", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("本地存储不可用");
    });
    render(
      <CalendarActionItemsSheet
        event={event}
        drafts={drafts}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建 2 项本地任务" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("本地存储不可用"));
    expect(within(screen.getByRole("dialog")).getByText("创建 2 项本地任务")).toBeVisible();
  });

  it("focuses the first draft and closes from Escape without leaking focus", () => {
    const onClose = vi.fn();
    render(
      <CalendarActionItemsSheet
        event={event}
        drafts={drafts}
        onClose={onClose}
        onConfirm={vi.fn(async () => undefined)}
      />,
    );

    const firstInput = screen.getByLabelText("行动项 1");
    const close = screen.getByRole("button", { name: "关闭会议行动项预览" });
    const lastAction = screen.getByRole("button", { name: "创建 2 项本地任务" });
    expect(firstInput).toHaveFocus();
    lastAction.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
