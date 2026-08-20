import { describe, expect, it } from "vitest";

import {
  getPetTaskDropTarget,
  petTaskDropTargets,
} from "../src/renderer/pet-task-drop-zones";

describe("pet task drop zones", () => {
  it("keeps the task hand-off vocabulary stable and ordered", () => {
    expect(petTaskDropTargets.map((target) => target.id)).toEqual([
      "focus",
      "complete",
      "later",
    ]);
    expect(petTaskDropTargets.map((target) => target.label)).toEqual([
      "专注",
      "完成",
      "稍后",
    ]);
  });

  it("resolves only the three supported drop targets", () => {
    expect(getPetTaskDropTarget("focus")).toMatchObject({ label: "专注" });
    expect(getPetTaskDropTarget("complete")).toMatchObject({ label: "完成" });
    expect(getPetTaskDropTarget("later")).toMatchObject({ label: "稍后" });
    expect(getPetTaskDropTarget("delete")).toBeUndefined();
    expect(getPetTaskDropTarget(undefined)).toBeUndefined();
  });
});
