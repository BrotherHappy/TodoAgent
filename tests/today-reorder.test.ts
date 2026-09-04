import { describe, expect, it } from "vitest";

import { moveTaskBefore } from "../src/renderer/today-reorder";

describe("Today drag reorder", () => {
  it("moves a task before the drop target and preserves the other IDs", () => {
    const source = ["a", "b", "c", "d"];
    expect(moveTaskBefore(source, "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(source).toEqual(["a", "b", "c", "d"]);
  });

  it("handles dragging down as an insertion rather than a swap", () => {
    expect(moveTaskBefore(["a", "b", "c", "d"], "b", "d")).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("returns a safe copy for unknown or identical targets", () => {
    const source = ["a", "b"];
    expect(moveTaskBefore(source, "x", "b")).toEqual(source);
    expect(moveTaskBefore(source, "a", "a")).toEqual(source);
    expect(moveTaskBefore(source, "a", "b")).not.toBe(source);
  });
});

