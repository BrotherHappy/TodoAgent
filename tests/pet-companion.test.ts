import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/shared/settings";
import {
  buildPetProactiveSuggestion,
  shouldSuppressPetProactive,
} from "../src/renderer/pet-companion";

describe("pet companion proactive behavior", () => {
  it("respects focus, meeting, mute, fullscreen and overnight quiet hours", () => {
    const settings = structuredClone(defaultSettings);
    settings.notifications.quietHoursEnabled = true;
    settings.notifications.quietHoursStart = "22:00";
    settings.notifications.quietHoursEnd = "08:00";
    expect(
      shouldSuppressPetProactive({
        settings,
        now: new Date("2026-08-15T23:30:00"),
        focusActive: false,
      }),
    ).toBe(true);
    expect(
      shouldSuppressPetProactive({
        settings: defaultSettings,
        now: new Date("2026-08-15T12:00:00"),
        focusActive: true,
      }),
    ).toBe(true);
  });

  it("prioritizes sync and weather warnings, then offers a gentle morning brief", () => {
    const now = new Date("2026-08-15T08:00:00");
    expect(
      buildPetProactiveSuggestion({
        now,
        tasks: [],
        petName: "小序",
        syncProblem: true,
      }).kind,
    ).toBe("sync");
    expect(
      buildPetProactiveSuggestion({ now, tasks: [], petName: "小序" }).kind,
    ).toBe("morning");
  });
});
