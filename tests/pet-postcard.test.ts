import { describe, expect, it } from "vitest";
import type { Task } from "../src/shared/models";
import type { FocusHistoryRecord } from "../src/shared/pet-types";
import { buildPetPostcard } from "../src/renderer/pet-postcard";

const task = (id: string, patch: Partial<Task> = {}): Task => ({
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
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
  ...patch,
});

const focus = (id: string, patch: Partial<FocusHistoryRecord> = {}): FocusHistoryRecord => ({
  id,
  sessionId: `session-${id}`,
  phase: "focus",
  cycle: 1,
  actualSeconds: 0,
  outcome: "completed",
  completedAt: "2026-08-21T10:00:00.000Z",
  ...patch,
});

describe("pet postcard", () => {
  it("projects today's completed work, focus and weather into a proud card", () => {
    const postcard = buildPetPostcard({
      name: "小满",
      personality: "gentle",
      now: new Date("2026-08-21T12:00:00.000Z"),
      tasks: [
        task("one", { status: "completed", completedAt: "2026-08-21T08:00:00.000Z" }),
        task("two", { status: "completed", completedAt: "2026-08-21T09:00:00.000Z" }),
        task("three", { status: "completed", completedAt: "2026-08-21T10:00:00.000Z" }),
        task("today", { plannedDate: "2026-08-21" }),
        task("overdue", { dueAt: "2026-08-20T18:00:00.000Z" }),
      ],
      focusHistory: [focus("a", { actualSeconds: 1_500 })],
      weather: {
        city: "杭州",
        latitude: 30,
        longitude: 120,
        conditionCode: 1,
        conditionLabel: "晴",
        temperatureC: 28.4,
        precipitationProbability: 20,
        severe: false,
        fetchedAt: "2026-08-21T11:00:00.000Z",
        expiresAt: "2026-08-21T12:30:00.000Z",
        stale: false,
      },
    });
    expect(postcard.tone).toBe("proud");
    expect(postcard.icon).toBe("✦");
    expect(postcard.metrics).toEqual([
      { label: "今日完成", value: "3" },
      { label: "专注分钟", value: "25" },
      { label: "今日待办", value: "2" },
    ]);
    expect(postcard.weatherLine).toBe("晴 · 28℃");
    expect(postcard.ariaLabel).toContain("今日完成 3 项");
  });

  it("stays gentle and does not count deleted, old or abandoned facts", () => {
    const postcard = buildPetPostcard({
      name: "小满",
      personality: "quiet",
      now: new Date("2026-08-21T12:00:00.000Z"),
      tasks: [
        task("old", { status: "completed", completedAt: "2026-08-20T10:00:00.000Z" }),
        task("deleted", { status: "completed", completedAt: "2026-08-21T10:00:00.000Z", deletedAt: "2026-08-21T11:00:00.000Z" }),
      ],
      focusHistory: [focus("abandoned", { outcome: "abandoned", actualSeconds: 3_600 })],
    });
    expect(postcard.tone).toBe("quiet");
    expect(postcard.metrics).toEqual([
      { label: "今日完成", value: "0" },
      { label: "专注分钟", value: "0" },
      { label: "今日待办", value: "0" },
    ]);
    expect(postcard.body).toContain("不用急");
  });
});
