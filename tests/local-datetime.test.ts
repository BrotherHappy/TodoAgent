import { describe, expect, it } from "vitest";
import {
  localDateTimeInputToIso,
  toLocalDateTimeInput,
} from "../src/renderer/local-datetime";

describe("local datetime controls", () => {
  it("round-trips a local wall-clock value without treating UTC as local", () => {
    const local = "2026-08-10T18:05";
    const iso = localDateTimeInputToIso(local);
    expect(iso).toBeDefined();
    expect(toLocalDateTimeInput(iso)).toBe(local);
  });

  it("does not render invalid instants into editable date controls", () => {
    expect(toLocalDateTimeInput("not-a-date")).toBe("");
    expect(localDateTimeInputToIso("")).toBeUndefined();
  });
});
