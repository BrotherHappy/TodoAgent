import { afterEach, describe, expect, it } from "vitest";
import {
  readHiddenCalendarSources,
  setCalendarSourceHidden,
  writeHiddenCalendarSources,
} from "../src/renderer/calendar-view-preferences";

const key = "test:calendar-hidden-sources";

afterEach(() => {
  writeHiddenCalendarSources([], key);
});

describe("calendar source visibility preferences", () => {
  it("normalizes and de-duplicates hidden sources in local storage", () => {
    expect(writeHiddenCalendarSources([" 工作日历 ", "工作日历", "个人"], key)).toEqual([
      "工作日历",
      "个人",
    ]);
    expect(readHiddenCalendarSources(key)).toEqual(["工作日历", "个人"]);
  });

  it("hides or reveals one source without affecting other sources", () => {
    expect(setCalendarSourceHidden(["工作日历"], "个人日历", true)).toEqual([
      "工作日历",
      "个人日历",
    ]);
    expect(setCalendarSourceHidden(["工作日历", "个人日历"], "工作日历", false)).toEqual([
      "个人日历",
    ]);
  });

  it("fails closed on malformed storage and removes empty preferences", () => {
    localStorage.setItem(key, JSON.stringify({ hidden: "工作日历" }));
    expect(readHiddenCalendarSources(key)).toEqual([]);
    localStorage.setItem(key, "not-json");
    expect(readHiddenCalendarSources(key)).toEqual([]);
    writeHiddenCalendarSources(["工作日历"], key);
    writeHiddenCalendarSources([], key);
    expect(localStorage.getItem(key)).toBeNull();
  });
});
