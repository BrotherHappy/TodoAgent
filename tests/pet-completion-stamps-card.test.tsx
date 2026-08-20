import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/models";
import { PetCompletionStampsCard } from "../src/renderer/PetCompletionStampsCard";

afterEach(cleanup);

const task = (patch: Partial<Task>): Task => ({
  id: patch.id ?? "task-1",
  source: { type: "local" },
  title: patch.title ?? "整理下一步",
  notes: "",
  privateNotes: "",
  status: patch.status ?? "completed",
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
  completedAt: patch.completedAt ?? "2026-08-21T03:00:00.000Z",
  sync: { status: "local" },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-21T03:00:00.000Z",
  ...patch,
});

describe("PetCompletionStampsCard", () => {
  it("shows stamps and opens the original task", () => {
    const onOpenTask = vi.fn();
    const completed = task({ id: "task-1", title: "写完发布说明" });
    render(
      <PetCompletionStampsCard
        tasks={[completed]}
        rewards={[]}
        onOpenTask={onOpenTask}
      />,
    );

    expect(screen.getByRole("region", { name: "共同完成印章" })).toBeVisible();
    expect(screen.getByText("写完发布说明")).toBeVisible();
    screen.getByRole("button", { name: "今日盖章：写完发布说明" }).click();
    expect(onOpenTask).toHaveBeenCalledWith(completed);
  });

  it("keeps a calm empty state when no completed task exists", () => {
    render(
      <PetCompletionStampsCard
        tasks={[task({ id: "open", status: "open", completedAt: undefined })]}
        rewards={[]}
        onOpenTask={() => undefined}
      />,
    );
    expect(screen.getByText("完成第一件任务后，宠物会为你盖下一枚小印章。")).toBeVisible();
  });
});

