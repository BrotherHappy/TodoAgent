import { describe, expect, it } from "vitest";
import { petSeasonForDate, petSeasonalEventForDate } from "../src/renderer/pet-season";

describe("pet seasonal events", () => {
  it("uses local calendar seasons without timezone drift for date keys", () => {
    expect(petSeasonForDate("2026-01-01")).toBe("winter");
    expect(petSeasonForDate("2026-03-01")).toBe("spring");
    expect(petSeasonForDate("2026-06-01")).toBe("summer");
    expect(petSeasonForDate("2026-09-01")).toBe("autumn");
    expect(petSeasonForDate("2026-12-31")).toBe("winter");
  });

  it("returns a gentle, non-task-mutating event payload", () => {
    expect(petSeasonalEventForDate("2026-10-05")).toMatchObject({
      season: "autumn",
      label: "秋日拾叶",
      icon: "❧",
    });
    expect(petSeasonalEventForDate("2026-10-05").message).not.toContain("任务已修改");
  });
});
