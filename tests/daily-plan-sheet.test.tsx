import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DailyPlanSheet,
  type DailyPlanSheetProps,
} from "../src/renderer/DailyPlanSheet";
import type { Task } from "../src/shared/models";

const planDate = "2026-08-19";

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title: id,
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
  focusSessions: [],
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const fixed = makeTask("fixed", {
  title: "今天截止的固定任务",
  dueAt: "2026-08-19T12:00:00.000Z",
  estimatedMinutes: 30,
  privateOrder: 0,
});
const retained = makeTask("retained", {
  title: "昨天留下的 Today 任务",
  plannedDate: "2026-08-18",
  estimatedMinutes: 30,
  privateOrder: 1,
});
const highCandidate = makeTask("high-candidate", {
  title: "高优先级候选任务",
  priority: "urgent",
  estimatedMinutes: 90,
  privateOrder: 2,
});
const lowCandidate = makeTask("low-candidate", {
  title: "短时候选任务",
  priority: "low",
  estimatedMinutes: 60,
  privateOrder: 3,
});
const tasks = [fixed, retained, highCandidate, lowCandidate];

function makeProps(
  overrides: Partial<DailyPlanSheetProps> = {},
): DailyPlanSheetProps {
  return {
    tasks,
    date: planDate,
    loading: false,
    onRetry: vi.fn(async () => undefined),
    onClose: vi.fn(),
    onApply: vi.fn(async () => "operation-plan"),
    onUndo: vi.fn(async () => undefined),
    onStartFirst: vi.fn(async () => undefined),
    onAskAgent: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DailyPlanSheet", () => {
  it("renders the initial suggestion and never offers to remove a fixed item", async () => {
    render(<DailyPlanSheet {...makeProps()} />);

    expect(
      screen.getByRole("heading", { name: "一起排今天" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "安排 4 项到今天" }),
    ).toBeEnabled();
    expect(screen.getByText("今天截止")).toBeVisible();
    expect(screen.getByText(/从 2026-08-18 延续/u)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: `移出${fixed.title}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTitle("到期或今天开始的事项会固定保留"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: `移出${retained.title}` }),
    ).toBeEnabled();
  });

  it("keeps fixed and retained work while seeding priorities from morning kickoff", async () => {
    render(
      <DailyPlanSheet
        {...makeProps({
          initialCapacityMinutes: 240,
          initialTaskIds: [highCandidate.id],
        })}
      />,
    );

    const selectedSection = screen
      .getByRole("heading", { name: "今天的顺序" })
      .closest("section");
    expect(selectedSection).not.toBeNull();
    expect(
      within(selectedSection!)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("strong")?.textContent),
    ).toEqual([fixed.title, retained.title, highCandidate.title]);
    expect(
      screen.queryByRole("button", { name: `移出${highCandidate.title}` }),
    ).toBeEnabled();
  });

  it("can reuse the same sheet for tomorrow without changing the Today labels", async () => {
    render(
      <DailyPlanSheet
        {...makeProps({ targetLabel: "明天", date: "2026-08-20" })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "安排明天" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "关闭明天规划" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "安排 4 项到明天" }),
    ).toBeEnabled();
  });

  it("recomputes automatic selections when capacity changes while retaining required work", async () => {
    const user = userEvent.setup();
    render(<DailyPlanSheet {...makeProps()} />);

    expect(
      await screen.findByRole("button", { name: "安排 4 项到今天" }),
    ).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "1 小时" }));

    expect(
      await screen.findByRole("button", { name: "安排 2 项到今天" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: `加入${highCandidate.title}` }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: `加入${lowCandidate.title}` }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: `加入${fixed.title}` }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/还剩约 0 分钟/u)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "4 小时" }));
    expect(
      await screen.findByRole("button", { name: "安排 4 项到今天" }),
    ).toBeEnabled();
  });

  it("shows a read-only weekday carry-over preview when the day window is full", async () => {
    const user = userEvent.setup();
    render(<DailyPlanSheet {...makeProps()} />);

    await user.clear(screen.getByLabelText("可用时段结束"));
    await user.type(screen.getByLabelText("可用时段结束"), "10:00");

    expect(
      await screen.findByRole("heading", { name: "后续工作日预览" }),
    ).toBeVisible();
    expect(screen.getByText(/只读建议：今天放不下的任务/u)).toBeVisible();
    const carryoverSection = screen
      .getByRole("heading", { name: "后续工作日预览" })
      .closest("section");
    expect(carryoverSection).not.toBeNull();
    expect(within(carryoverSection!).getByText(retained.title)).toBeVisible();
    expect(screen.getByText(/不会自动改日期或写入飞书/u)).toBeVisible();
  });

  it("offers conservative, balanced and sprint planning scenarios", async () => {
    const user = userEvent.setup();
    render(<DailyPlanSheet {...makeProps()} />);

    const conservative = screen.getByRole("button", { name: "保守计划" });
    const balanced = screen.getByRole("button", { name: "平衡计划" });
    const sprint = screen.getByRole("button", { name: "冲刺计划" });
    expect(balanced).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("按可用时间安排");

    await user.click(conservative);
    expect(conservative).toHaveAttribute("aria-pressed", "true");
    expect(balanced).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("留出约 25% 缓冲");
    expect(
      await screen.findByRole("button", { name: "安排 3 项到今天" }),
    ).toBeEnabled();

    await user.click(sprint);
    expect(sprint).toHaveAttribute("aria-pressed", "true");
    expect(
      await screen.findByRole("button", { name: "安排 4 项到今天" }),
    ).toBeEnabled();
  });

  it("submits the edited order, estimates and cleared Today task, then exposes success actions", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<DailyPlanSheet {...props} />);

    await user.click(screen.getByRole("button", { name: "1 小时" }));
    await screen.findByRole("button", { name: "安排 2 项到今天" });
    await user.click(
      screen.getByRole("button", { name: `移出${retained.title}` }),
    );
    await user.click(
      screen.getByRole("button", { name: `加入${highCandidate.title}` }),
    );
    await user.click(
      screen.getByRole("button", { name: `加入${lowCandidate.title}` }),
    );

    await user.selectOptions(
      screen.getByLabelText(`${highCandidate.title}的预计时长`),
      "60",
    );
    await user.selectOptions(
      screen.getByLabelText(`${lowCandidate.title}的预计时长`),
      "45",
    );
    await user.click(
      screen.getByRole("button", { name: `上移${lowCandidate.title}` }),
    );
    await user.click(
      screen.getByRole("button", { name: `下移${fixed.title}` }),
    );

    const selectedSection = screen
      .getByRole("heading", { name: "今天的顺序" })
      .closest("section");
    expect(selectedSection).not.toBeNull();
    const selectedList = within(selectedSection!).getByRole("list");
    expect(
      within(selectedList)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("strong")?.textContent),
    ).toEqual([lowCandidate.title, fixed.title, highCandidate.title]);

    await user.click(
      screen.getByRole("button", { name: "安排 3 项到今天" }),
    );

    await waitFor(() =>
      expect(props.onApply).toHaveBeenCalledWith({
        date: planDate,
        items: [
          { id: lowCandidate.id, estimatedMinutes: 45 },
          { id: fixed.id, estimatedMinutes: 30 },
          { id: highCandidate.id, estimatedMinutes: 60 },
        ],
        clearTaskIds: [retained.id],
        baselines: [
          {
            id: lowCandidate.id,
            plannedDate: undefined,
            privateOrder: 3,
            estimatedMinutes: 60,
          },
          {
            id: fixed.id,
            plannedDate: undefined,
            privateOrder: 0,
            estimatedMinutes: 30,
          },
          {
            id: highCandidate.id,
            plannedDate: undefined,
            privateOrder: 2,
            estimatedMinutes: 90,
          },
          {
            id: retained.id,
            plannedDate: "2026-08-18",
            privateOrder: 1,
            estimatedMinutes: 30,
          },
        ],
      }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "今天先守住这 3 件事",
      }),
    ).toBeVisible();
    expect(screen.getByText(lowCandidate.title)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "开始第一项" }));
    expect(props.onStartFirst).toHaveBeenCalledTimes(1);
    expect(props.onStartFirst).toHaveBeenCalledWith(lowCandidate);

    await user.click(
      screen.getByRole("button", { name: "让 Agent 排时间" }),
    );
    expect(props.onAskAgent).toHaveBeenCalledTimes(1);
    expect(props.onAskAgent).toHaveBeenCalledWith(
      expect.stringMatching(
        /可用时间约 1 小时[\s\S]*1\. 短时候选任务[\s\S]*2\. 今天截止的固定任务[\s\S]*3\. 高优先级候选任务/u,
      ),
    );

    await user.click(screen.getByRole("button", { name: "撤销计划" }));
    await waitFor(() => {
      expect(props.onUndo).toHaveBeenCalledTimes(1);
      expect(props.onUndo).toHaveBeenCalledWith("operation-plan");
    });
    expect(
      await screen.findByRole("heading", { name: "一起排今天" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "关闭今日规划" }),
    ).toHaveFocus();
  });

  it("renders loading, retryable error and empty states and closes on Escape", async () => {
    const user = userEvent.setup();
    const props = makeProps({ loading: true });
    const { rerender } = render(<DailyPlanSheet {...props} />);

    expect(screen.getByText("正在整理全部任务")).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    rerender(
      <DailyPlanSheet
        {...props}
        loading={false}
        error="任务读取失败"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("任务读取失败");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <DailyPlanSheet
        {...props}
        tasks={[]}
        loading={false}
        error={undefined}
      />,
    );
    expect(screen.getByText("今天没有待安排任务")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "好的" }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("can intentionally clear the last retained Today item and undo once", async () => {
    const user = userEvent.setup();
    const props = makeProps({ tasks: [retained] });
    render(<DailyPlanSheet {...props} />);

    await user.click(
      screen.getByRole("button", { name: `移出${retained.title}` }),
    );
    expect(
      screen.getByRole("button", { name: "清空今日计划" }),
    ).toBeEnabled();
    expect(screen.getByText("今天先留白")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "清空今日计划" }));

    expect(props.onApply).toHaveBeenCalledWith({
      date: planDate,
      items: [],
      clearTaskIds: [retained.id],
      baselines: [
        {
          id: retained.id,
          plannedDate: "2026-08-18",
          privateOrder: 1,
          estimatedMinutes: 30,
        },
      ],
    });
    expect(
      await screen.findByRole("heading", { name: "今天已经留白" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "让 Agent 排时间" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "撤销计划" }));
    await waitFor(() => expect(props.onUndo).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("heading", { name: "一起排今天" }),
    ).toBeVisible();
  });

  it("locks the editor while an atomic apply is pending", async () => {
    const user = userEvent.setup();
    let resolveApply: ((operationId: string) => void) | undefined;
    const props = makeProps({
      onApply: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveApply = resolve;
          }),
      ),
    });
    const view = render(<DailyPlanSheet {...props} />);

    const apply = await screen.findByRole("button", {
      name: "安排 4 项到今天",
    });
    await user.click(apply);
    expect(document.querySelector(".daily-plan-editor")).toHaveAttribute(
      "inert",
    );
    expect(apply).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "关闭今日规划" }),
    ).toBeDisabled();

    view.rerender(<DailyPlanSheet {...props} loading />);
    await waitFor(() => {
      const dialog = screen.getByRole("dialog", { name: "一起排今天" });
      expect(dialog).toHaveFocus();
    });
    view.rerender(<DailyPlanSheet {...props} loading={false} />);

    await act(async () => {
      resolveApply?.("operation-plan");
    });
    expect(
      await screen.findByRole("heading", {
        name: "今天先守住这 4 件事",
      }),
    ).toBeVisible();
  });

  it("keeps focus inside the dialog and reports a failed start without duplicate calls", async () => {
    const user = userEvent.setup();
    let rejectStart: ((reason: Error) => void) | undefined;
    const props = makeProps({
      onStartFirst: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStart = reject;
          }),
      ),
    });
    render(<DailyPlanSheet {...props} />);

    const close = screen.getByRole("button", { name: "关闭今日规划" });
    const apply = await screen.findByRole("button", {
      name: "安排 4 项到今天",
    });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(apply).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();

    await user.click(apply);
    const start = await screen.findByRole("button", { name: "开始第一项" });
    expect(start).toHaveFocus();
    await user.click(start);
    fireEvent.click(start);
    expect(props.onStartFirst).toHaveBeenCalledTimes(1);
    expect(start).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "关闭今日规划" }),
    ).toBeDisabled();

    await act(async () => {
      rejectStart?.(new Error("专注启动失败"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("专注启动失败");
    expect(start).toBeEnabled();
  });
});
