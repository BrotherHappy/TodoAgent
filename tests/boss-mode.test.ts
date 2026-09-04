import { describe, expect, it } from "vitest";

import { withBossMode } from "../src/shared/boss-mode";
import { defaultSettings } from "../src/shared/settings";

describe("withBossMode", () => {
  it("hides the pet and enables meeting suppression as one projection", () => {
    const next = withBossMode(defaultSettings, true);

    expect(next.floating.enabled).toBe(false);
    expect(next.pet.meetingMode).toBe(true);
    expect(next.notifications).toEqual(defaultSettings.notifications);
    expect(next.floating.positions).toEqual(defaultSettings.floating.positions);
  });

  it("restores the pet and keeps unrelated settings unchanged", () => {
    const boss = withBossMode(defaultSettings, true);
    const next = withBossMode(boss, false);

    expect(next.floating.enabled).toBe(true);
    expect(next.pet.meetingMode).toBe(false);
    expect(next.persona).toEqual(defaultSettings.persona);
    expect(next.floating.positions).toEqual(defaultSettings.floating.positions);
  });
});
