import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/models";
import { ProjectPage } from "../src/renderer/ProjectPage";

const task = (patch: Partial<Task> = {}): Task => ({
  id: patch.id ?? `task-${Math.random()}`,
  source: { type: "local" },
  title: patch.title ?? "任务",
  notes: "",
  privateNotes: "",
  status: patch.status ?? "open",
  priority: "medium",
  projectId: patch.projectId,
  tags: [],
  dependencyIds: patch.dependencyIds ?? [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  ...patch,
});

describe("ProjectPage", () => {
  it("groups open and completed tasks and surfaces project signals", () => {
    render(
      <ProjectPage
        tasks={[
          task({ id: "a", title: "设计首页", projectId: "发布", dueAt: "2020-01-01T00:00:00.000Z" }),
          task({ id: "b", title: "完成文案", projectId: "发布", status: "completed" }),
          task({ id: "c", title: "等待依赖", projectId: "发布", dependencyIds: ["missing"] }),
        ]}
        loading={false}
        onRetry={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "发布" })).toBeInTheDocument();
    expect(screen.getByText("逾期 1")).toBeInTheDocument();
    expect(screen.getByText("阻塞 1")).toBeInTheDocument();
    expect(screen.getByText("2 项待办 · 完成 33%")).toBeInTheDocument();
  });

  it("returns the original task when a project task is selected", () => {
    const onSelect = vi.fn();
    const selected = task({ id: "select-me", title: "打开详情", projectId: "研究" });
    render(<ProjectPage tasks={[selected]} loading={false} onRetry={vi.fn()} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /打开详情/u }));
    expect(onSelect).toHaveBeenCalledWith(selected);
  });

  it("shows retry and empty states", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ProjectPage tasks={[]} loading={false} error="读取失败" onRetry={onRetry} onSelect={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重试/u }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ProjectPage tasks={[]} loading={false} onRetry={onRetry} onSelect={vi.fn()} />);
    expect(screen.getByText("还没有项目上下文")).toBeInTheDocument();
  });
});
