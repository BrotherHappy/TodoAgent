import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/models";
import { buildGanttPlan } from "../src/renderer/timeline-gantt";
import { GanttView } from "../src/renderer/GanttView";

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

afterEach(cleanup);

describe("GanttView", () => {
  it("renders a readable project route and sends bar clicks to the canonical task", () => {
    const onSelect = vi.fn();
    const task = makeTask("准备发布", { projectId: "发布", plannedDate: "2026-08-19" });
    const plan = buildGanttPlan([task], "2026-08-19", "all", "2026-08-19");
    render(
      <GanttView
        plan={plan}
        projectId="all"
        projectIds={["发布"]}
        onProjectChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("region", { name: "甘特视图" })).toBeVisible();
    expect(screen.getByText("项目路线")).toBeVisible();
    expect(screen.getByText("发布", { selector: ".timeline-gantt-group-label span" })).toBeVisible();
    expect(screen.getByRole("button", { name: /准备发布，2026-08-19 至 2026-08-19/u })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /准备发布，2026-08-19 至 2026-08-19/u }));
    expect(onSelect).toHaveBeenCalledWith("准备发布");
  });

  it("keeps undated tasks discoverable and allows changing the project filter", () => {
    const onProjectChange = vi.fn();
    const plan = buildGanttPlan([makeTask("还没排")], "2026-08-19", "all", "2026-08-19");
    render(
      <GanttView
        plan={plan}
        projectId="all"
        projectIds={["发布"]}
        onProjectChange={onProjectChange}
        onSelect={vi.fn()}
      />,
    );

    const unplanned = screen.getByRole("region", { name: "尚未安排时间的任务" });
    expect(within(unplanned).getByText("还没排")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "甘特项目" }), { target: { value: "发布" } });
    expect(onProjectChange).toHaveBeenCalledWith("发布");
  });

  it("explains the critical route without turning it into a second task state", () => {
    const start = makeTask("路线起点", { projectId: "发布", plannedDate: "2026-08-19" });
    const finish = makeTask("路线终点", { projectId: "发布", plannedDate: "2026-08-20", dependencyIds: [start.id] });
    const plan = buildGanttPlan([start, finish], "2026-08-19", "all", "2026-08-19");
    const onSelect = vi.fn();
    render(
      <GanttView
        plan={plan}
        projectId="all"
        projectIds={["发布"]}
        onProjectChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText("关键路线 2 项")).toBeVisible();
    const routes = screen.getByRole("region", { name: "关键路线" });
    expect(within(routes).getByRole("button", { name: "路线起点" })).toBeVisible();
    expect(within(routes).getByText("→")).toBeVisible();
    fireEvent.click(within(routes).getByRole("button", { name: "路线终点" }));
    expect(onSelect).toHaveBeenCalledWith("路线终点");
    expect(screen.getByRole("button", { name: /路线终点，2026-08-20 至 2026-08-20，进行中，关键路线/u })).toBeVisible();
  });
});
