import { describe, expect, it } from "vitest";

import type { Task } from "../src/shared/models";
import { buildFocusInsights } from "../src/renderer/focus-insights";

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
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
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  ...overrides,
});

describe("focus insights", () => {
  it("groups granular focus sessions by local week and task", () => {
    const result = buildFocusInsights(
      [
        task("写作", {
          focusSessions: [
            {
              id: "s1",
              startedAt: "2026-08-17T09:00:00.000Z",
              endedAt: "2026-08-17T09:25:00.000Z",
              elapsedSeconds: 1_500,
            },
            {
              id: "s2",
              startedAt: "2026-08-18T09:00:00.000Z",
              endedAt: "2026-08-18T09:15:00.000Z",
              elapsedSeconds: 900,
            },
          ],
        }),
        task("调研", {
          focusSessions: [
            {
              id: "s3",
              startedAt: "2026-08-19T09:00:00.000Z",
              endedAt: "2026-08-19T09:50:00.000Z",
              elapsedSeconds: 3_000,
            },
          ],
        }),
      ],
      "2026-08-19",
    );

    expect(result.weekStart).toBe("2026-08-17");
    expect(result.weekEnd).toBe("2026-08-23");
    expect(result.days.slice(0, 3).map((day) => [day.minutes, day.sessions])).toEqual([
      [25, 1],
      [15, 1],
      [50, 1],
    ]);
    expect(result.totalMinutes).toBe(90);
    expect(result.totalSessions).toBe(3);
    expect(result.averageSessionMinutes).toBe(30);
    expect(result.topTasks.map((item) => [item.title, item.minutes])).toEqual([
      ["调研", 50],
      ["写作", 40],
    ]);
  });

  it("uses legacy aggregate focus once and ignores invalid or deleted data", () => {
    const result = buildFocusInsights(
      [
        task("旧任务", {
          status: "completed",
          completedAt: "2026-08-18T10:00:00.000Z",
          actualMinutes: 20,
        }),
        task("坏数据", {
          focusSessions: [
            {
              id: "bad",
              startedAt: "not-a-date",
              endedAt: "not-a-date",
              elapsedSeconds: 3_000,
            },
          ],
        }),
        task("已删除", {
          deletedAt: "2026-08-18T10:00:00.000Z",
          focusElapsedSeconds: 9_000,
          completedAt: "2026-08-18T10:00:00.000Z",
        }),
      ],
      "2026-08-19",
    );

    expect(result.totalMinutes).toBe(20);
    expect(result.totalSessions).toBe(1);
    expect(result.topTasks.map((item) => item.title)).toEqual(["旧任务"]);
  });

  it("returns a calm empty report when no focus has been recorded", () => {
    const result = buildFocusInsights([task("无专注")], "2026-08-19");

    expect(result.totalMinutes).toBe(0);
    expect(result.totalSessions).toBe(0);
    expect(result.averageSessionMinutes).toBe(0);
    expect(result.topTasks).toEqual([]);
    expect(result.days).toHaveLength(7);
  });
});
