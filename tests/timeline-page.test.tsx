import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelinePage, type TimelinePageProps } from "../src/renderer/TimelinePage";
import type { Task } from "../src/shared/models";
import { addLocalDays, localDateKey, localIsoAt } from "../src/renderer/timeline-utils";
import { writeHiddenCalendarSources } from "../src/renderer/calendar-view-preferences";
import { calendarSourceColor, writeCalendarSourceColors } from "../src/renderer/calendar-source-preferences";

const date = localDateKey();

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
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

function props(overrides: Partial<TimelinePageProps> = {}): TimelinePageProps {
  return {
    tasks: [],
    loading: false,
    onRetry: vi.fn(),
    onSelect: vi.fn(),
    onMove: vi.fn(async () => "operation-1"),
    onUndo: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  writeHiddenCalendarSources([]);
  writeCalendarSourceColors({});
});

describe("TimelinePage", () => {
  it("shows scheduled and unscheduled tasks on the selected day", () => {
    render(
      <TimelinePage
        {...props({
          tasks: [
            makeTask("写报告", { startAt: localIsoAt(date, 9 * 60), estimatedMinutes: 45 }),
            makeTask("整理资料", { plannedDate: date }),
          ],
        })}
      />,
    );

    expect(screen.getByRole("heading", { name: "时间线" })).toBeVisible();
    expect(screen.getByRole("button", { name: /写报告，45分钟/u })).toBeVisible();
    expect(screen.getByRole("button", { name: /整理资料/u })).toBeVisible();
    expect(screen.getByText("已安排 1 项")).toBeVisible();
    expect(screen.getByText("待安排 1 项")).toBeVisible();
  });

  it("focuses the requested date when opened from a calendar search result", async () => {
    const targetDate = addLocalDays(date, 2);
    render(<TimelinePage {...props({ focusDate: targetDate })} />);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: `${targetDate} 的时间线` })).toBeVisible();
    });
  });

  it("shows the live clock line and offers a jump-to-now action", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 19, 10, 17));
    try {
      render(<TimelinePage {...props()} />);
      expect(screen.getByRole("status", { name: "现在 10:17" })).toBeVisible();
      expect(screen.getByRole("button", { name: "滚动到现在 10:17" })).toBeVisible();
      expect(document.querySelector('[data-now-indicator="true"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows read-only calendar events and offers a follow-up draft", () => {
    const onCreateFollowUp = vi.fn();
    const event = {
      id: "calendar-1",
      summary: "产品同步会",
      startAt: localIsoAt(date, 10 * 60),
      endAt: localIsoAt(date, 11 * 60),
      allDay: false,
      sourceName: "工作日历",
    };
    render(
      <TimelinePage
        {...props({
          calendarEvents: [event],
          onCreateFollowUp,
        })}
      />,
    );
    const agenda = screen.getByRole("region", { name: "今日议程" });
    expect(within(agenda).getByText("产品同步会")).toBeVisible();
    expect(within(agenda).getByRole("button", { name: "工作日历" })).toBeVisible();
    expect(within(agenda).getByText("1 个事件")).toBeVisible();
    fireEvent.click(within(agenda).getByRole("button", { name: "为“产品同步会”创建跟进任务" }));
    expect(onCreateFollowUp).toHaveBeenCalledWith(event);
  });

  it("filters multiple calendar sources without changing stored events", () => {
    const workEvent = {
      id: "calendar-work",
      summary: "工作评审",
      startAt: localIsoAt(date, 10 * 60),
      endAt: localIsoAt(date, 11 * 60),
      allDay: false,
      sourceName: "工作日历",
    };
    const personalEvent = {
      id: "calendar-personal",
      summary: "个人安排",
      startAt: localIsoAt(date, 13 * 60),
      endAt: localIsoAt(date, 14 * 60),
      allDay: false,
      sourceName: "个人日历",
    };
    render(<TimelinePage {...props({ calendarEvents: [workEvent, personalEvent] })} />);
    const agenda = screen.getByRole("region", { name: "今日议程" });
    expect(within(agenda).getByText("工作评审")).toBeVisible();
    expect(within(agenda).getByText("个人安排")).toBeVisible();
    fireEvent.click(within(agenda).getByRole("button", { name: "工作日历" }));
    expect(within(agenda).queryByText("工作评审")).toBeNull();
    expect(within(agenda).getByText("个人安排")).toBeVisible();
    fireEvent.click(within(agenda).getByRole("button", { name: "全部" }));
    expect(within(agenda).getByText("工作评审")).toBeVisible();
  });

  it("lets each calendar source choose a local color used by its event cards", () => {
    const event = {
      id: "calendar-work",
      summary: "工作评审",
      startAt: localIsoAt(date, 10 * 60),
      endAt: localIsoAt(date, 11 * 60),
      allDay: false,
      sourceName: "工作日历",
    };
    render(<TimelinePage {...props({ calendarEvents: [event] })} />);
    const agenda = screen.getByRole("region", { name: "今日议程" });
    const colorInput = within(agenda).getByLabelText("设置日历来源颜色：工作日历");
    fireEvent.change(colorInput, { target: { value: "#123456" } });
    expect(colorInput).toHaveValue("#123456");
    expect(within(agenda).getByText("工作评审").closest(".timeline-calendar-event")).toHaveAttribute(
      "data-calendar-source-color",
      "#123456",
    );
    expect(within(agenda).getByRole("button", { name: "恢复日历来源默认颜色：工作日历" })).toBeVisible();
    fireEvent.click(within(agenda).getByRole("button", { name: "恢复日历来源默认颜色：工作日历" }));
    expect(colorInput).toHaveValue(calendarSourceColor("工作日历"));
  });

  it("can clear one calendar source with an undo action", () => {
    const notify = vi.fn();
    const onCalendarEventsChange = vi.fn();
    const workEvent = {
      id: "calendar-work",
      summary: "工作评审",
      startAt: localIsoAt(date, 10 * 60),
      endAt: localIsoAt(date, 11 * 60),
      allDay: false,
      sourceName: "工作日历",
    };
    const personalEvent = {
      id: "calendar-personal",
      summary: "个人安排",
      startAt: localIsoAt(date, 13 * 60),
      endAt: localIsoAt(date, 14 * 60),
      allDay: false,
      sourceName: "个人日历",
    };
    render(
      <TimelinePage
        {...props({ calendarEvents: [workEvent, personalEvent], onCalendarEventsChange, notify })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "清除日历来源：工作日历" }));
    expect(onCalendarEventsChange).toHaveBeenCalledWith([personalEvent]);
    expect(notify).toHaveBeenCalledWith(
      "已清除“工作日历”的本地日历事件",
      "info",
      expect.objectContaining({ label: "撤销" }),
    );
  });

  it("offers action-item extraction when an event has notes", () => {
    const onExtractActionItems = vi.fn();
    const event = {
      id: "calendar-actions",
      summary: "产品同步会",
      description: "行动项：联系客户；更新方案",
      startAt: localIsoAt(date, 10 * 60),
      endAt: localIsoAt(date, 11 * 60),
      allDay: false,
      sourceName: "工作日历",
    };
    render(
      <TimelinePage
        {...props({ calendarEvents: [event], onExtractActionItems })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "从“产品同步会”提取行动项" }));
    expect(onExtractActionItems).toHaveBeenCalledWith(event);
  });

  it("projects calendar busy blocks onto the half-hour timeline", () => {
    const event = {
      id: "calendar-busy",
      summary: "评审会议",
      startAt: localIsoAt(date, 10 * 60),
      endAt: localIsoAt(date, 11 * 60),
      allDay: false,
      sourceName: "工作日历",
    };
    render(<TimelinePage {...props({ calendarEvents: [event] })} />);
    expect(screen.getByLabelText("日历占用：评审会议")).toBeVisible();
    expect(document.querySelectorAll('[data-calendar-busy="calendar-busy"]').length).toBe(2);
  });

  it("moves a task to a time slot with a local time block and offers undo", async () => {
    const onMove = vi.fn(async () => "operation-2");
    const notify = vi.fn();
    const task = makeTask("准备演示", { plannedDate: date, estimatedMinutes: 60 });
    render(<TimelinePage {...props({ tasks: [task], onMove, notify })} />);

    const card = screen.getByRole("button", { name: /准备演示/u });
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => task.id),
    };
    fireEvent.dragStart(card, { dataTransfer });
    const slot = document.querySelector<HTMLDivElement>('[data-slot-minute="600"]');
    expect(slot).not.toBeNull();
    fireEvent.dragOver(slot!, { dataTransfer });
    fireEvent.drop(slot!, { dataTransfer });

    await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
    expect(onMove).toHaveBeenCalledWith(task.id, {
      plannedDate: date,
      timeBlock: {
        startAt: localIsoAt(date, 600),
        endAt: localIsoAt(date, 660),
      },
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("准备演示"),
      "success",
      expect.objectContaining({ label: "撤销" }),
    );
  });

  it("keeps date navigation explicit and supports returning to today", async () => {
    render(<TimelinePage {...props()} />);
    const before = screen.getByText(date);
    expect(before).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "后一天" }));
    expect(screen.getByText(addLocalDays(date, 1))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /今天/u }));
    await waitFor(() => expect(screen.getByText(date)).toBeVisible());
  });

  it("shows a week overview and opens the selected day", () => {
    const onSelect = vi.fn();
    render(
      <TimelinePage
        {...props({
          onSelect,
          tasks: [
            makeTask("本周任务", { plannedDate: date }),
            makeTask("已完成", { status: "completed", completedAt: `${date}T10:00:00.000Z` }),
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByRole("heading", { name: "时间线" })).toBeVisible();
    expect(screen.getByText("本周回顾")).toBeVisible();
    expect(screen.getByText("完成任务")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`${date.slice(5).replace("-", "/")}`) }));
    expect(screen.getByText(date)).toBeVisible();
  });

  it("opens the read-only Gantt route and keeps task selection connected", () => {
    const onSelect = vi.fn();
    const task = makeTask("甘特任务", { projectId: "发布", plannedDate: date });
    render(<TimelinePage {...props({ tasks: [task], onSelect })} />);

    fireEvent.click(screen.getByRole("button", { name: "甘特" }));
    expect(screen.getByRole("region", { name: "甘特视图" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /甘特任务，/u }));
    expect(onSelect).toHaveBeenCalledWith(task.id);
  });

  it("shows estimated-versus-actual review and links back to a task", () => {
    const onSelect = vi.fn();
    render(
      <TimelinePage
        {...props({
          onSelect,
          tasks: [
            makeTask("准备演示", {
              plannedDate: date,
              estimatedMinutes: 30,
              focusSessions: [{
                id: "focus-review",
                startedAt: localIsoAt(date, 9 * 60),
                endedAt: localIsoAt(date, 9 * 60 + 45),
                elapsedSeconds: 2_700,
              }],
            }),
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByRole("heading", { name: "估时复盘" })).toBeVisible();
    expect(screen.getByText("预计分钟")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /准备演示，预计 30 分钟，实际 45 分钟/u }));
    expect(onSelect).toHaveBeenCalledWith("准备演示");
  });

  it("surfaces calendar load in the week overview", () => {
    render(
      <TimelinePage
        {...props({
          calendarEvents: [{
            id: "calendar-week-1",
            summary: "周会",
            startAt: localIsoAt(date, 9 * 60),
            endAt: localIsoAt(date, 10 * 60 + 30),
            allDay: false,
            sourceName: "工作日历",
          }],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByText("会议 1 个 · 1 小时 30 分钟")).toBeVisible();
    expect(screen.getByText("1 个会议 · 1 小时 30 分钟")).toBeVisible();
  });

  it("shows focus rhythm and lets the user return to a focused task", () => {
    const onSelect = vi.fn();
    render(
      <TimelinePage
        {...props({
          onSelect,
          tasks: [
            makeTask("研究方案", {
              focusSessions: [
                {
                  id: "focus-1",
                  startedAt: `${date}T10:00:00.000Z`,
                  endedAt: `${date}T10:25:00.000Z`,
                  elapsedSeconds: 1_500,
                },
              ],
            }),
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByText("专注节奏")).toBeVisible();
    const insights = screen.getByRole("region", { name: "专注节奏" });
    expect(within(insights).getByText("专注分钟")).toBeVisible();
    expect(within(insights).getByText("25 分钟 · 1 段")).toBeVisible();
    fireEvent.click(within(insights).getByRole("button", { name: /研究方案/ }));
    expect(onSelect).toHaveBeenCalledWith("研究方案");
  });
});
