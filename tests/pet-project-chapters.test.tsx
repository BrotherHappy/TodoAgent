import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskProject } from "../src/shared/models";
import { PetProjectChapters } from "../src/renderer/PetProjectChapters";

afterEach(cleanup);

const task = (patch: Partial<Task>): Task => ({
  id: patch.id ?? "task-1",
  source: { type: "local" },
  title: patch.title ?? "整理下一步",
  notes: "",
  privateNotes: "",
  status: patch.status ?? "open",
  priority: patch.priority ?? "medium",
  projectId: patch.projectId,
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
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
  ...patch,
});

const project: TaskProject = {
  id: "project-1",
  name: "Todo Pet 发布",
  color: "violet",
  archived: false,
  privateOrder: 0,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};

describe("PetProjectChapters", () => {
  it("shows progress and opens the projected next task", () => {
    const onOpenTask = vi.fn();
    const onOpenProjects = vi.fn();
    render(
      <PetProjectChapters
        tasks={[task({ id: "task-1", projectId: "project-1" })]}
        projects={[project]}
        onOpenTask={onOpenTask}
        onOpenProjects={onOpenProjects}
      />,
    );

    expect(screen.getByRole("region", { name: "共同旅程章节" })).toBeVisible();
    expect(screen.getByText("Todo Pet 发布")).toBeVisible();
    expect(screen.getByText("下一步：整理下一步")).toBeVisible();
    screen.getByRole("button", { name: "打开下一步" }).click();
    screen.getByRole("button", { name: "查看项目" }).click();
    expect(onOpenTask).toHaveBeenCalledWith("task-1");
    expect(onOpenProjects).toHaveBeenCalledTimes(1);
  });

  it("explains the empty state when no task belongs to a project", () => {
    render(
      <PetProjectChapters
        tasks={[task({ id: "task-1" })]}
        projects={[project]}
        onOpenTask={() => undefined}
        onOpenProjects={() => undefined}
      />,
    );
    expect(screen.getByText("给任务选一个项目，这里就会出现你们的下一章。")).toBeVisible();
  });
});
