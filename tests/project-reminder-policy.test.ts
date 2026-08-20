import { describe, expect, it } from "vitest";
import { updateProjectReminderModes } from "../src/renderer/project-reminder-policy";

describe("updateProjectReminderModes", () => {
  it("applies one policy to selected projects without touching other overrides", () => {
    expect(updateProjectReminderModes(
      { alpha: "off", keep: "important-only" },
      ["alpha", " beta ", "alpha"],
      "normal",
    )).toEqual({ alpha: "normal", beta: "normal", keep: "important-only" });
  });

  it("removes selected overrides when they follow the source policy", () => {
    expect(updateProjectReminderModes(
      { alpha: "off", beta: "normal", keep: "important-only" },
      ["alpha", "beta"],
      "inherit",
    )).toEqual({ keep: "important-only" });
  });

  it("ignores empty IDs and caps the batch at one hundred projects", () => {
    const projectIds = Array.from({ length: 101 }, (_, index) => `p-${index}`);
    const result = updateProjectReminderModes({}, projectIds, "off");
    expect(result["p-0"]).toBe("off");
    expect(result["p-99"]).toBe("off");
    expect(result["p-100"]).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(100);
    expect(updateProjectReminderModes({}, ["", "  ", "valid"], "off")).toEqual({ valid: "off" });
  });
});
