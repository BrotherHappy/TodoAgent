import { describe, expect, it } from "vitest";
import {
  buildDailySchedule,
  formatDailyScheduleTime,
} from "../src/shared/daily-schedule";

const date = "2026-08-15";
const at = (minutes: number): string => {
  const value = new Date(2026, 7, 15, 0, 0, 0, 0);
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

describe("daily schedule preview", () => {
  it("packs flexible tasks in order and leaves the requested buffer", () => {
    const result = buildDailySchedule(
      [input("one", "第一项", 60), input("two", "第二项", 45), input("three", "第三项", 30)],
      {
        date,
        availableStartMinutes: 9 * 60,
        availableEndMinutes: 12 * 60,
        bufferMinutes: 15,
      },
    );
    expect(result.slots.map((slot) => [slot.taskId, slot.startMinutes, slot.endMinutes])).toEqual([
      ["one", 540, 600],
      ["two", 615, 660],
      ["three", 675, 705],
    ]);
    expect(result.unscheduled).toEqual([]);
    expect(result.scheduledMinutes).toBe(135);
  });

  it("keeps an existing time block and finds the next available gap", () => {
    const result = buildDailySchedule(
      [
        input("fixed", "固定会议", 60, {
          timeBlock: { startAt: at(600), endAt: at(660) },
        }),
        input("task", "准备材料", 60),
      ],
      {
        date,
        availableStartMinutes: 9 * 60,
        availableEndMinutes: 13 * 60,
        bufferMinutes: 15,
      },
    );
    expect(result.slots.map((slot) => [slot.taskId, slot.startMinutes, slot.source])).toEqual([
      ["fixed", 600, "existing-block"],
      ["task", 675, "suggested"],
    ]);
  });

  it("reports overflow instead of silently dropping a selected task", () => {
    const result = buildDailySchedule(
      [input("one", "第一项", 60), input("two", "第二项", 60)],
      {
        date,
        availableStartMinutes: 9 * 60,
        availableEndMinutes: 10 * 60 + 30,
        bufferMinutes: 15,
      },
    );
    expect(result.slots).toHaveLength(1);
    expect(result.unscheduled).toEqual([
      { taskId: "two", taskTitle: "第二项", estimatedMinutes: 60, reason: "no-room" },
    ]);
  });

  it("marks fixed blocks outside the available window for explanation", () => {
    const result = buildDailySchedule(
      [input("fixed", "晚间会议", 60, { timeBlock: { startAt: at(1_200), endAt: at(1_260) } })],
      {
        date,
        availableStartMinutes: 9 * 60,
        availableEndMinutes: 18 * 60,
        bufferMinutes: 30,
      },
    );
    expect(result.slots[0]?.conflict).toBe("outside-window");
    expect(result.slots[0]?.source).toBe("existing-block");
  });

  it("formats preview times consistently", () => {
    expect(formatDailyScheduleTime(9 * 60 + 5)).toBe("09:05");
    expect(formatDailyScheduleTime(2_000)).toBe("23:59");
  });
});
