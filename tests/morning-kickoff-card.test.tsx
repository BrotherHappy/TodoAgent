import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MorningKickoffCard } from "../src/renderer/MorningKickoffCard";
import type { Task } from "../src/shared/models";

const makeTask = (id: string, privateOrder: number): Task => ({
  id,
  source: { type: "local" },
  title: `任务-${id}`,
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
  privateOrder,
  sync: { status: "local" },
  createdAt: `2026-08-01T00:0${privateOrder}:00.000Z`,
  updatedAt: `2026-08-01T00:0${privateOrder}:00.000Z`,
});

afterEach(cleanup);

describe("MorningKickoffCard", () => {
  it("collects three priorities, capacity, and a plan-first choice", async () => {
    const user = userEvent.setup();
    const onOpenPlan = vi.fn();
    const tasks = [makeTask("1", 1), makeTask("2", 2), makeTask("3", 3)];
    render(
      <MorningKickoffCard
        tasks={tasks}
        onOpenPlan={onOpenPlan}
        onStartFocus={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /任务-1/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /2 小时/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /先看计划/ }));
    await user.click(screen.getByRole("button", { name: "打开今日规划" }));

    expect(onOpenPlan).toHaveBeenCalledWith({
      capacityMinutes: 120,
      taskIds: ["1", "2", "3"],
      focusFirst: false,
    });
  });

  it("limits priorities to three and can start the first selected task", async () => {
    const user = userEvent.setup();
    const onStartFocus = vi.fn();
    const tasks = [
      makeTask("1", 1),
      makeTask("2", 2),
      makeTask("3", 3),
      makeTask("4", 4),
    ];
    render(
      <MorningKickoffCard
        tasks={tasks}
        onOpenPlan={vi.fn()}
        onStartFocus={onStartFocus}
      />,
    );

    const fourth = screen.getByRole("button", { name: /任务-4/ });
    expect(fourth).toHaveAttribute("aria-pressed", "false");
    await user.click(fourth);
    expect(fourth).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "开始第一项" }));

    expect(onStartFocus).toHaveBeenCalledWith(tasks[0]);
  });

  it("allows an empty morning to continue into an unseeded plan", async () => {
    const user = userEvent.setup();
    const onOpenPlan = vi.fn();
    render(
      <MorningKickoffCard
        tasks={[]}
        onOpenPlan={onOpenPlan}
        onStartFocus={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "打开今日规划" }));

    expect(onOpenPlan).toHaveBeenCalledWith({
      capacityMinutes: 240,
      taskIds: [],
      focusFirst: true,
    });
  });
});
