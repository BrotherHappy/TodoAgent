import { describe, expect, it } from "vitest";
import { buildMultiDaySchedule } from "../src/shared/multi-day-schedule";

const at = (date: string, minutes: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(year, month - 1, day, 0, 0, 0, 0);
  value.setMinutes(minutes);
  return value.toISOString();
};

const input = (
  id: string,
  title: string,
  estimatedMinutes: number,
  task: Record<string, unknown> = {},
) => ({
  task: { id, title, ...task },
  estimatedMinutes,
});
const options = (overrides: Record<string, unknown> = {}) => ({
  startDate: "2026-08-14", // Friday
  availableStartMinutes: 9 * 60,
  availableEndMinutes: 10 * 60,
  bufferMinutes: 0,
  maxWorkdays: 2,
  ...overrides,
});

describe("multi-day schedule preview", () => {
  it("moves overflow to the next weekday without touching the task order", () => {
    const result = buildMultiDaySchedule(
      [input("one", "第一项", 60), input("two", "第二项", 60)],
      options(),
    );

    expect(result.days.map((day) => day.date)).toEqual([
      "2026-08-14",
      "2026-08-17",
    ]);
    expect(result.days.map((day) => day.slots.map((slot) => slot.taskId))).toEqual([
      ["one"],
      ["two"],
    ]);
    expect(result.unscheduled).toEqual([]);
    expect(result.scheduledTaskCount).toBe(2);
  });

  it("keeps a fixed future block in place and reserves its interval", () => {
    const result = buildMultiDaySchedule(
      [
        input("first", "先做的任务", 60),
        input("meeting", "周一会议", 60, {
          timeBlock: {
            startAt: at("2026-08-17", 9 * 60),
            endAt: at("2026-08-17", 10 * 60),
          },
        }),
        input("third", "排不下的任务", 60),
      ],
      options(),
    );

    expect(result.days[1]?.slots.map((slot) => [slot.taskId, slot.source])).toEqual([
      ["meeting", "fixed"],
    ]);
    expect(result.unscheduled).toEqual([
      {
        taskId: "third",
        taskTitle: "排不下的任务",
        estimatedMinutes: 60,
        reason: "no-capacity",
      },
    ]);
  });

  it("skips weekend capacity windows by default", () => {
    const result = buildMultiDaySchedule(
      [input("one", "周末后的任务", 30)],
      options({ startDate: "2026-08-15" }),
    );
    expect(result.days.map((day) => day.date)).toEqual([
      "2026-08-17",
      "2026-08-18",
    ]);
    expect(result.days[0]?.slots[0]?.date).toBe("2026-08-17");
  });

  it("does not move a task beyond its deadline", () => {
    const result = buildMultiDaySchedule(
      [
        input("first", "今天先做", 60),
        input("due", "今天截止", 60, { dueAt: at("2026-08-14", 18 * 60) }),
      ],
      options(),
    );
    expect(result.unscheduled).toEqual([
      {
        taskId: "due",
        taskTitle: "今天截止",
        estimatedMinutes: 60,
        reason: "past-deadline",
      },
    ]);
  });

  it("explains a fixed block outside the preview horizon", () => {
    const result = buildMultiDaySchedule(
      [
        input("future", "下周固定块", 60, {
          timeBlock: {
            startAt: at("2026-08-17", 9 * 60),
            endAt: at("2026-08-17", 10 * 60),
          },
        }),
      ],
      options({ maxWorkdays: 1 }),
    );
    expect(result.unscheduled).toEqual([
      {
        taskId: "future",
        taskTitle: "下周固定块",
        estimatedMinutes: 60,
        reason: "horizon",
      },
    ]);
  });

  it("never mutates the task input", () => {
    const tasks = [input("one", "保留原样", 60)];
    const before = JSON.parse(JSON.stringify(tasks));
    buildMultiDaySchedule(tasks, options());
    expect(tasks).toEqual(before);
  });
});
