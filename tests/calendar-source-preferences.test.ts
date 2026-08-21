import { afterEach, describe, expect, it } from "vitest";
import {
  CALENDAR_SOURCE_COLOR_PALETTE,
  calendarSourceColor,
  clearCalendarSourceColor,
  defaultCalendarSourceColor,
  hasCalendarSourceColorOverride,
  readCalendarSourceColors,
  setCalendarSourceColor,
  writeCalendarSourceColors,
} from "../src/renderer/calendar-source-preferences";

const key = "test:calendar-source-colors";

afterEach(() => {
  writeCalendarSourceColors({}, key);
});

describe("calendar source colors", () => {
  it("assigns a stable palette color to each source", () => {
    const workColor = defaultCalendarSourceColor("工作日历");
    expect(workColor).toBe(defaultCalendarSourceColor(" 工作日历 "));
    expect(CALENDAR_SOURCE_COLOR_PALETTE).toContain(workColor);
    expect(calendarSourceColor("工作日历")).toBe(workColor);
  });

  it("normalizes persisted colors and ignores malformed values", () => {
    expect(writeCalendarSourceColors({ " 工作日历 ": "#ABC", "个人日历": "#123456", 无效: "red" }, key)).toEqual({
      "工作日历": "#aabbcc",
      "个人日历": "#123456",
    });
    expect(readCalendarSourceColors(key)).toEqual({
      "工作日历": "#aabbcc",
      "个人日历": "#123456",
    });
    localStorage.setItem(key, "not-json");
    expect(readCalendarSourceColors(key)).toEqual({});
  });

  it("sets, detects, and clears one local override", () => {
    const withOverride = setCalendarSourceColor({}, "工作日历", "#123");
    expect(withOverride).toEqual({ "工作日历": "#112233" });
    expect(hasCalendarSourceColorOverride(" 工作日历 ", withOverride)).toBe(true);
    expect(calendarSourceColor("工作日历", withOverride)).toBe("#112233");
    expect(clearCalendarSourceColor(withOverride, "工作日历")).toEqual({});
    expect(setCalendarSourceColor({}, "工作日历", "not-a-color")).toEqual({});
  });
});
