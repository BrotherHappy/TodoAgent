import { describe, expect, it } from "vitest";

import { defaultSettings } from "../src/shared/settings";
import {
  applyCompanionStrategy,
  detectCompanionStrategy,
} from "../src/renderer/companion-presets";

describe("companion strategy presets", () => {
  it("applies a focused template without changing unrelated settings", () => {
    const settings = structuredClone(defaultSettings);
    settings.persona.name = "小序";
    settings.focus.focusMinutes = 50;
    settings.notifications.quietHoursStart = "23:00";

    const next = applyCompanionStrategy(settings, "focused");

    expect(next.pet.actionPack).toBe("focused");
    expect(next.pet.animationIntensity).toBe("gentle");
    expect(next.persona.proactiveLevel).toBe("quiet");
    expect(next.persona.reminderStrength).toBe("normal");
    expect(next.focus.autoStartBreak).toBe(true);
    expect(next.focus.autoStartNextRound).toBe(true);
    expect(next.focus.focusMinutes).toBe(50);
    expect(next.notifications.quietHoursStart).toBe("23:00");
  });

  it("recognizes presets and returns custom after an individual change", () => {
    const balanced = applyCompanionStrategy(defaultSettings, "balanced");
    expect(detectCompanionStrategy(balanced)).toBe("balanced");

    const custom = {
      ...balanced,
      persona: { ...balanced.persona, reminderStrength: "firm" as const },
    };
    expect(detectCompanionStrategy(custom)).toBe("custom");
  });
});
