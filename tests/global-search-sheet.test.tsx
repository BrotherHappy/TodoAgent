import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalSearchSheet } from "../src/renderer/GlobalSearchSheet";
import { clearGlobalSearchHistory, rememberGlobalSearch } from "../src/renderer/global-search-history";
import { clearGlobalSearchPresets, saveGlobalSearchPreset } from "../src/renderer/global-search-presets";
import type { Task } from "../src/shared/models";
import type { CalendarEvent } from "../src/shared/calendar-events";

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

const props = (onSelect = vi.fn(), calendarEvents: readonly CalendarEvent[] = []) => ({
  tasks: [task("task-1", "整理发布清单")],
  projects: [],
  lists: [],
  calendarEvents,
  conversations: [],
  onClose: vi.fn(),
  onSelect,
});

describe("GlobalSearchSheet", () => {
  afterEach(() => {
    cleanup();
    clearGlobalSearchHistory();
    clearGlobalSearchPresets();
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

  it("saves a named shortcut, reuses it, and removes it locally", () => {
    const onSelect = vi.fn();
    render(<GlobalSearchSheet {...props(onSelect)} />);
    const input = screen.getByRole("combobox", { name: "全局搜索" });
    fireEvent.change(input, { target: { value: "发布" } });
    fireEvent.click(screen.getByRole("button", { name: "保存为快捷搜索" }));

    const nameInput = screen.getByRole("textbox", { name: "快捷搜索名称" });
    fireEvent.change(nameInput, { target: { value: "发布清单" } });
    fireEvent.click(screen.getByRole("button", { name: "保存快捷搜索" }));
    expect(screen.queryByRole("textbox", { name: "快捷搜索名称" })).toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("快捷搜索")).toBeVisible();
    expect(screen.getByRole("button", { name: "打开快捷搜索：发布清单" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开快捷搜索：发布清单" }));
    expect(input).toHaveValue("发布");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "删除快捷搜索：发布清单" }));
    expect(screen.queryByText("快捷搜索")).toBeNull();
  });

  it("loads saved shortcuts when the sheet opens", () => {
    saveGlobalSearchPreset("今天要做", "今天", "todo-agent:global-search-presets:v1");
    render(<GlobalSearchSheet {...props()} />);
    expect(screen.getByRole("button", { name: "打开快捷搜索：今天要做" })).toBeVisible();
  });

  it("opens a local calendar result from the 日历 filter", () => {
    const onSelect = vi.fn();
    const event = {
      id: "calendar-1",
      summary: "产品同步会",
      description: "发布窗口确认",
      startAt: "2026-08-22T10:00:00+08:00",
      endAt: "2026-08-22T11:00:00+08:00",
      allDay: false,
      sourceName: "工作日历",
    };
    render(<GlobalSearchSheet {...props(onSelect, [event])} />);
    const input = screen.getByRole("combobox", { name: "全局搜索" });
    fireEvent.change(input, { target: { value: "产品同步" } });
    fireEvent.click(screen.getByRole("option", { name: /产品同步会/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: "calendar",
      calendarEvent: event,
    }));
  });
});
