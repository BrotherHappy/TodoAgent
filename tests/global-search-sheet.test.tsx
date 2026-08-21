import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalSearchSheet } from "../src/renderer/GlobalSearchSheet";
import { clearGlobalSearchHistory, rememberGlobalSearch } from "../src/renderer/global-search-history";
import type { Task } from "../src/shared/models";

const task = (id: string, title: string): Task => ({
  id,
  source: { type: "local" },
  title,
  notes: "",
  privateNotes: "",
  status: "open",
  priority: "none",
  tags: [],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
});

const props = (onSelect = vi.fn()) => ({
  tasks: [task("task-1", "整理发布清单")],
  projects: [],
  lists: [],
  conversations: [],
  onClose: vi.fn(),
  onSelect,
});

describe("GlobalSearchSheet", () => {
  afterEach(() => {
    cleanup();
    clearGlobalSearchHistory();
  });

  it("focuses the input, filters results and opens the selected task", async () => {
    const onSelect = vi.fn();
    render(<GlobalSearchSheet {...props(onSelect)} />);
    const input = screen.getByRole("combobox", { name: "全局搜索" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "发布" } });
    expect(screen.getByRole("option", { name: /整理发布清单/ })).toBeVisible();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1", kind: "task" }));
  });

  it("shows recent queries only after a result is opened and supports one-click reuse", () => {
    const onSelect = vi.fn();
    render(<GlobalSearchSheet {...props(onSelect)} />);
    const input = screen.getByRole("combobox", { name: "全局搜索" });
    fireEvent.change(input, { target: { value: "发布" } });
    fireEvent.click(screen.getByRole("option", { name: /整理发布清单/ }));
    expect(onSelect).toHaveBeenCalledOnce();

    cleanup();
    render(<GlobalSearchSheet {...props()} />);
    expect(screen.getByText("最近搜索")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /发布/ }));
    expect(screen.getByRole("combobox", { name: "全局搜索" })).toHaveValue("发布");
  });

  it("clears recent queries without closing the sheet", () => {
    rememberGlobalSearch("今天");
    render(<GlobalSearchSheet {...props()} />);
    expect(screen.getByText("最近搜索")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.queryByText("最近搜索")).toBeNull();
    expect(screen.getByRole("combobox", { name: "全局搜索" })).toHaveFocus();
  });
});
