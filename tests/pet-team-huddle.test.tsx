import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/shared/models";
import type { PetCompanion } from "../src/shared/pet-types";
import { PetTeamHuddleCard } from "../src/renderer/PetTeamHuddleCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const task: Task = {
  id: "task-1",
  source: { type: "local" },
  title: "整理研究资料",
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
};

const companions: PetCompanion[] = [
  { id: "bird", kind: "paper-bird", name: "小纸", personality: "energetic", unlockedAt: "2026-08-21T08:00:00.000Z" },
  { id: "cloud", kind: "cloudlet", name: "云团", personality: "calm", unlockedAt: "2026-08-21T08:00:00.000Z" },
];

describe("PetTeamHuddleCard", () => {
  it("prepares the group, then starts focus for the selected task", async () => {
    vi.useFakeTimers();
    const onStartFocus = vi.fn().mockResolvedValue(undefined);
    render(
      <PetTeamHuddleCard
        companions={companions}
        tasks={[task]}
        onStartFocus={onStartFocus}
        onOpenTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "小队准备" }));
    expect(screen.getByText(/小队正在碰头/u)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(900));
    expect(screen.getByRole("button", { name: "开始专注" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始专注" }));
    expect(onStartFocus).toHaveBeenCalledWith(task);
  });

  it("allows a companion to lead the briefing before preparation", () => {
    render(
      <PetTeamHuddleCard
        companions={companions}
        tasks={[task]}
        onStartFocus={vi.fn().mockResolvedValue(undefined)}
        onOpenTask={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "让云团担任领队，稳住节奏" }));
    expect(screen.getByText("领队：云团")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "让云团担任领队，稳住节奏" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the empty state honest when every task is closed", () => {
    render(
      <PetTeamHuddleCard
        companions={companions}
        tasks={[{ ...task, status: "completed" }]}
        onStartFocus={vi.fn().mockResolvedValue(undefined)}
        onOpenTask={vi.fn()}
      />,
    );
    expect(screen.getByText(/今天没有开放任务/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "小队准备" })).not.toBeInTheDocument();
  });
});
