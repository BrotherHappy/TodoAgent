import { describe, expect, it } from "vitest";
import {
  checkinCopy,
  normalizeWeeklyCheckin,
  weekStartFor,
  weeklyCheckinPaceLabel,
} from "../src/renderer/weekly-checkin";

describe("weekly check-in", () => {
  it("uses a Monday-first week and does not carry a prior week forward", () => {
    expect(weekStartFor("2026-08-19")).toBe("2026-08-17");
    expect(normalizeWeeklyCheckin({
      weekStart: "2026-08-10",
      energy: 4,
      pace: "steady",
      note: "old",
      completedAt: "2026-08-10T08:00:00.000Z",
    }, "2026-08-17")).toBeUndefined();
  });

  it("normalizes a valid record and trims the optional note", () => {
    const result = normalizeWeeklyCheckin({
      weekStart: "2026-08-17",
      energy: 2,
      pace: "gentle",
      note: "  先照顾睡眠  ",
      completedAt: "2026-08-19T08:00:00.000Z",
    }, "2026-08-17");
    expect(result).toMatchObject({ energy: 2, pace: "gentle", note: "先照顾睡眠" });
    expect(normalizeWeeklyCheckin({ ...result, energy: 6 }, "2026-08-17")).toBeUndefined();
    expect(weeklyCheckinPaceLabel("steady")).toBe("稳稳推进");
  });

  it("keeps the copy supportive at both low and high energy", () => {
    const low = checkinCopy({ energy: 1, pace: "gentle", completedCount: 0, openCount: 4 });
    const high = checkinCopy({ energy: 5, pace: "full", completedCount: 3, openCount: 2 });
    expect(low.headline).toContain("照顾好自己");
    expect(low.detail).toContain("给自己留一点余地");
    expect(high.headline).toContain("真正重要");
    expect(high.detail).toContain("已完成 3 项");
  });
});
