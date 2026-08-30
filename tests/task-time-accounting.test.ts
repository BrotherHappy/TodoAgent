import { describe, expect, it } from "vitest";
import { actualMinutesForTask } from "../src/shared/task-time-accounting";

describe("actualMinutesForTask", () => {
  it("prefers the canonical aggregate when it is present", () => {
    expect(
      actualMinutesForTask({
        actualMinutes: 12.4,
        focusElapsedSeconds: 9_000,
        focusSessions: [
          {
            id: "session",
            startedAt: "2026-08-29T09:00:00.000Z",
            endedAt: "2026-08-29T09:25:00.000Z",
            elapsedSeconds: 1_500,
          },
        ],
      }),
    ).toBe(12);
  });

  it("derives the total for legacy tasks that only have sessions", () => {
    expect(
      actualMinutesForTask({
        focusElapsedSeconds: 0,
        focusSessions: [
          {
            id: "one",
            startedAt: "2026-08-29T09:00:00.000Z",
            endedAt: "2026-08-29T09:25:00.000Z",
            elapsedSeconds: 1_500,
          },
          {
            id: "two",
            startedAt: "2026-08-29T10:00:00.000Z",
            endedAt: "2026-08-29T10:15:00.000Z",
            elapsedSeconds: 900,
          },
        ],
      }),
    ).toBe(40);
  });

  it("falls back to the original elapsed counter and ignores malformed values", () => {
    expect(
      actualMinutesForTask({
        focusElapsedSeconds: 1_800,
        focusSessions: [
          {
            id: "bad",
            startedAt: "not-a-date",
            endedAt: "not-a-date",
            elapsedSeconds: Number.NaN,
          },
        ],
      }),
    ).toBe(30);
    expect(
      actualMinutesForTask({
        focusElapsedSeconds: Number.NaN,
        focusSessions: [],
      }),
    ).toBe(0);
  });
});
