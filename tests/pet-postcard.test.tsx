import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/models";
import { PetPostcardCard } from "../src/renderer/PetPostcardCard";

const task: Task = {
  id: "task-1",
  source: { type: "local" },
  title: "完成简报",
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
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
  plannedDate: "2026-08-21",
};

describe("PetPostcardCard", () => {
  it("shows factual metrics and opens Today without creating a task", () => {
    const onOpenToday = vi.fn();
    render(
      <PetPostcardCard
        name="小满"
        personality="calm"
        tasks={[task]}
        focusHistory={[]}
        onOpenToday={onOpenToday}
      />,
    );
    expect(screen.getByRole("region", { name: /今日待办 1 项/u })).toBeInTheDocument();
    expect(screen.getByText("小满给你留了一张小卡片")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看今天" }));
    expect(onOpenToday).toHaveBeenCalledTimes(1);
  });
});
