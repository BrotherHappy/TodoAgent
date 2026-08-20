import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultElasticHabits,
  formatHabitWait,
  habitAvailableAt,
  habitState,
  readElasticHabits,
  writeElasticHabits,
} from "../src/renderer/elastic-habits";

describe("elastic habits", () => {
  beforeEach(() => localStorage.clear());

  it("keeps habits local and returns gentle defaults", () => {
    expect(readElasticHabits().map((habit) => habit.id)).toEqual(defaultElasticHabits.map((habit) => habit.id));
    const completedAt = "2026-08-19T08:00:00.000Z";
    writeElasticHabits([{ ...defaultElasticHabits[0]!, lastCompletedAt: completedAt }]);
    const saved = readElasticHabits()[0]!;
    expect(habitAvailableAt(saved)).toBe(Date.parse(completedAt) + 90 * 60_000);
    expect(habitState(saved, Date.parse("2026-08-19T08:30:00.000Z"))).toBe("resting");
    expect(formatHabitWait(saved, Date.parse("2026-08-19T08:30:00.000Z"))).toBe("1 小时后再问你");
  });

  it("treats a snooze as a movable window, not a missed streak", () => {
    const habit = { ...defaultElasticHabits[1]!, snoozedUntil: "2026-08-19T10:30:00.000Z" };
    expect(habitState(habit, Date.parse("2026-08-19T10:00:00.000Z"))).toBe("resting");
    expect(habitState(habit, Date.parse("2026-08-19T11:00:00.000Z"))).toBe("ready");
  });
});
