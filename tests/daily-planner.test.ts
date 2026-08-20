import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_TASK_ESTIMATE_MINUTES,
  MAX_DAILY_SUGGESTED_ITEMS,
  suggestDailyPlan,
} from "../src/shared/daily-planner";
import type { Task } from "../src/shared/models";

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

const reasonCodes = (id: string, tasks: Task[]) => {
  const suggestion = suggestDailyPlan(tasks, {
    date: "2026-08-19",
    capacityMinutes: 480,
    timeZone: "Asia/Shanghai",
  });
  return suggestion.items.find((item) => item.task.id === id)!
    .recommendationReasons;
};

describe("suggestDailyPlan", () => {
  it("uses the requested local time zone for fixed items and filters non-actionable tasks", () => {
    const tasks = [
      makeTask("overdue", { dueAt: "2026-08-18T15:00:00.000Z" }),
      makeTask("due-today", { dueAt: "2026-08-19T15:00:00.000Z" }),
      makeTask("starts-today", { startAt: "2026-08-18T16:00:00.000Z" }),
      makeTask("completed", {
        status: "completed",
        dueAt: "2026-08-19T15:00:00.000Z",
      }),
      makeTask("cancelled", {
        status: "cancelled",
        dueAt: "2026-08-19T15:00:00.000Z",
      }),
      makeTask("deleted", {
        deletedAt: "2026-08-19T00:00:00.000Z",
        dueAt: "2026-08-19T15:00:00.000Z",
      }),
    ];

    const suggestion = suggestDailyPlan(tasks, {
      date: new Date("2026-08-19T00:30:00.000Z"),
      timeZone: "Asia/Shanghai",
      capacityMinutes: 0,
    });

    expect(suggestion.date).toBe("2026-08-19");
    expect(suggestion.items.map((item) => item.task.id)).toEqual([
      "overdue",
      "due-today",
      "starts-today",
    ]);
    expect(suggestion.fixedItems).toHaveLength(3);
    expect(suggestion.selectedItems).toHaveLength(3);
    expect(suggestion.totalMinutes).toBe(90);
    expect(suggestion.overloadMinutes).toBe(90);
    expect(
      suggestion.items.every(
        (item) =>
          item.isEstimateDefault &&
          item.estimatedMinutes === DEFAULT_DAILY_TASK_ESTIMATE_MINUTES,
      ),
    ).toBe(true);
    expect(suggestion.fixedItems[0]?.primaryReason).toContain("已逾期");
  });

  it("retains tasks planned for today or earlier without making them fixed", () => {
    const suggestion = suggestDailyPlan(
      [
        makeTask("carry-over", { plannedDate: "2026-08-18" }),
        makeTask("planned-today", { plannedDate: "2026-08-19" }),
        makeTask("future", { plannedDate: "2026-08-20" }),
      ],
      {
        date: "2026-08-19",
        timeZone: "Asia/Shanghai",
        capacityMinutes: 60,
      },
    );

    expect(suggestion.fixedItems).toEqual([]);
    expect(suggestion.selectedItems.map((item) => item.task.id)).toEqual([
      "planned-today",
      "carry-over",
    ]);
    expect(
      suggestion.selectedItems.every(
        (item) => item.isRetained && !item.isAutomatic,
      ),
    ).toBe(true);
    expect(suggestion.items.find((item) => item.task.id === "future")).toMatchObject({
      isSelected: false,
      isRetained: false,
    });
  });

  it("explains priority, deadline, duration, blockers and tasks that unlock other work", () => {
    const tasks = [
      makeTask("unlocker", {
        priority: "medium",
        estimatedMinutes: 20,
        privateOrder: 2,
      }),
      makeTask("dependent", {
        priority: "urgent",
        dueAt: "2026-08-20T08:00:00+08:00",
        estimatedMinutes: 20,
        dependencyIds: ["unlocker"],
        privateOrder: 0,
      }),
      makeTask("plain", {
        priority: "low",
        estimatedMinutes: 45,
        privateOrder: 1,
      }),
    ];
    const suggestion = suggestDailyPlan(tasks, {
      date: "2026-08-19",
      capacityMinutes: 40,
      timeZone: "Asia/Shanghai",
    });

    expect(suggestion.suggestedItems.map((item) => item.task.id)).toEqual([
      "unlocker",
      "dependent",
    ]);
    const unlocker = suggestion.items.find(
      (item) => item.task.id === "unlocker",
    )!;
    const dependent = suggestion.items.find(
      (item) => item.task.id === "dependent",
    )!;
    expect(unlocker.recommendationReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "priority" }),
        expect.objectContaining({ code: "unblocks-tasks" }),
        expect.objectContaining({ code: "estimated-duration" }),
      ]),
    );
    expect(dependent).toMatchObject({
      blocked: true,
      incompleteDependencyIds: ["unlocker"],
      isSelected: true,
      isAutomatic: true,
    });
    expect(dependent.recommendationReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "due-soon" }),
        expect.objectContaining({ code: "blocked" }),
      ]),
    );
  });

  it("ranks otherwise equal tasks by priority, approaching deadline and shorter duration", () => {
    const priorityPlan = suggestDailyPlan(
      [
        makeTask("low", { priority: "low", estimatedMinutes: 30 }),
        makeTask("high", { priority: "high", estimatedMinutes: 30 }),
      ],
      { date: "2026-08-19", capacityMinutes: 0, timeZone: "UTC" },
    );
    expect(priorityPlan.items.map((item) => item.task.id)).toEqual([
      "high",
      "low",
    ]);

    const deadlinePlan = suggestDailyPlan(
      [
        makeTask("later", {
          priority: "medium",
          dueAt: "2026-08-26T12:00:00.000Z",
          estimatedMinutes: 30,
        }),
        makeTask("sooner", {
          priority: "medium",
          dueAt: "2026-08-21T12:00:00.000Z",
          estimatedMinutes: 30,
        }),
      ],
      { date: "2026-08-19", capacityMinutes: 0, timeZone: "UTC" },
    );
    expect(deadlinePlan.items.map((item) => item.task.id)).toEqual([
      "sooner",
      "later",
    ]);

    const durationPlan = suggestDailyPlan(
      [
        makeTask("long", { priority: "medium", estimatedMinutes: 90 }),
        makeTask("short", { priority: "medium", estimatedMinutes: 15 }),
      ],
      { date: "2026-08-19", capacityMinutes: 0, timeZone: "UTC" },
    );
    expect(durationPlan.items.map((item) => item.task.id)).toEqual([
      "short",
      "long",
    ]);
  });

  it("greedily fits smaller work after a higher-ranked task exceeds capacity", () => {
    const suggestion = suggestDailyPlan(
      [
        makeTask("large-urgent", {
          priority: "urgent",
          estimatedMinutes: 90,
        }),
        makeTask("small-high", {
          priority: "high",
          estimatedMinutes: 30,
        }),
      ],
      { date: "2026-08-19", capacityMinutes: 30, timeZone: "UTC" },
    );

    expect(suggestion.suggestedItems.map((item) => item.task.id)).toEqual([
      "small-high",
    ]);
    expect(suggestion.totalMinutes).toBe(30);
    expect(suggestion.overloadMinutes).toBe(0);
  });

  it("never automatically adds more than seven items", () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      makeTask(`task-${index}`, {
        estimatedMinutes: 30,
        privateOrder: index,
      }),
    );
    const suggestion = suggestDailyPlan(tasks, {
      date: "2026-08-19",
      capacityMinutes: 600,
      maxSuggestedItems: 99,
      timeZone: "UTC",
    });

    expect(suggestion.maxSuggestedItems).toBe(MAX_DAILY_SUGGESTED_ITEMS);
    expect(suggestion.suggestedItems).toHaveLength(7);
    expect(suggestion.suggestedItems.map((item) => item.task.id)).toEqual(
      tasks.slice(0, 7).map((task) => task.id),
    );
  });

  it("uses deterministic tie breakers and does not mutate its input", () => {
    const tasks = [makeTask("b"), makeTask("a"), makeTask("c")];
    const before = structuredClone(tasks);
    const options = {
      date: "2026-08-19",
      capacityMinutes: 0,
      timeZone: "UTC",
    } as const;

    const first = suggestDailyPlan(tasks, options);
    const second = suggestDailyPlan([...tasks].reverse(), options);

    expect(first.items.map((item) => item.task.id)).toEqual(["a", "b", "c"]);
    expect(second.items.map((item) => item.task.id)).toEqual(["a", "b", "c"]);
    expect(tasks).toEqual(before);
    expect(reasonCodes("a", tasks)).toContainEqual({
      code: "default-estimate",
      label: "未填写时长，暂按 30 分钟",
    });
  });

  it("normalizes legacy estimates outside the supported whole-minute range", () => {
    const tasks = [
      makeTask("too-short", { estimatedMinutes: 1 }),
      makeTask("fractional", { estimatedMinutes: 22.5 }),
      makeTask("too-long", { estimatedMinutes: 800 }),
      makeTask("valid", { estimatedMinutes: 45 }),
    ];
    const suggestion = suggestDailyPlan(tasks, {
      date: "2026-08-19",
      capacityMinutes: 180,
      timeZone: "UTC",
    });

    expect(
      suggestion.items
        .filter((item) => item.task.id !== "valid")
        .every(
          (item) =>
            item.isEstimateDefault &&
            item.estimatedMinutes === DEFAULT_DAILY_TASK_ESTIMATE_MINUTES,
        ),
    ).toBe(true);
    expect(suggestion.items.find((item) => item.task.id === "valid")).toMatchObject({
      estimatedMinutes: 45,
      isEstimateDefault: false,
    });
    expect(() =>
      suggestDailyPlan(tasks, {
        date: "2026-08-19",
        capacityMinutes: 180,
        defaultEstimateMinutes: 2.5,
      }),
    ).toThrow(/whole minutes between 5 and 720/u);
  });

  it("caps suggestions to the local availability window and preserves a breathing buffer", () => {
    const suggestion = suggestDailyPlan(
      [
        makeTask("first", { estimatedMinutes: 60, priority: "high" }),
        makeTask("second", { estimatedMinutes: 60, priority: "medium" }),
        makeTask("third", { estimatedMinutes: 60, priority: "low" }),
      ],
      {
        date: "2026-08-19",
        capacityMinutes: 480,
        timeZone: "UTC",
        constraints: {
          availableStartMinutes: 9 * 60,
          availableEndMinutes: 12 * 60,
          bufferMinutes: 30,
          minimumBlockMinutes: 15,
        },
      },
    );

    expect(suggestion.availableWindowMinutes).toBe(180);
    expect(suggestion.effectiveCapacityMinutes).toBe(150);
    expect(suggestion.suggestedItems.map((item) => item.task.id)).toEqual([
      "first",
      "second",
    ]);
    expect(suggestion.totalMinutes).toBe(120);
    expect(suggestion.overloadMinutes).toBe(0);
  });

  it("leaves short unstructured tasks for manual selection and explains why", () => {
    const suggestion = suggestDailyPlan(
      [
        makeTask("short", { estimatedMinutes: 10, priority: "none" }),
        makeTask("long", { estimatedMinutes: 30, priority: "none" }),
      ],
      {
        date: "2026-08-19",
        capacityMinutes: 60,
        timeZone: "UTC",
        constraints: { minimumBlockMinutes: 15 },
      },
    );

    expect(suggestion.suggestedItems.map((item) => item.task.id)).toEqual([
      "long",
    ]);
    expect(suggestion.items.find((item) => item.task.id === "short")).toMatchObject({
      belowMinimumBlock: true,
      isSelected: false,
      recommendationReasons: expect.arrayContaining([
        expect.objectContaining({ code: "short-block" }),
      ]),
    });
  });
});
