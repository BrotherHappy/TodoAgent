import { describe, expect, it } from "vitest";
import {
  PET_INPUT_ACTIVITY_COOLDOWN_MS,
  petInputActivityKind,
  shouldEmitPetInputActivity,
} from "../electron/pet-input-activity";

describe("pet input activity", () => {
  it("maps only a coarse recent-input window to typing or reading", () => {
    expect(petInputActivityKind(-1)).toBeUndefined();
    expect(petInputActivityKind(Number.NaN)).toBeUndefined();
    expect(petInputActivityKind(0)).toBe("typing");
    expect(petInputActivityKind(2)).toBe("typing");
    expect(petInputActivityKind(3)).toBe("reading");
    expect(petInputActivityKind(8)).toBe("reading");
    expect(petInputActivityKind(9)).toBeUndefined();
  });

  it("throttles posture cues so activity never becomes a high-frequency stream", () => {
    expect(shouldEmitPetInputActivity(0, 0, "typing")).toBe(false);
    expect(
      shouldEmitPetInputActivity(PET_INPUT_ACTIVITY_COOLDOWN_MS - 1, 0, "typing"),
    ).toBe(false);
    expect(
      shouldEmitPetInputActivity(PET_INPUT_ACTIVITY_COOLDOWN_MS, 0, "typing"),
    ).toBe(true);
    expect(shouldEmitPetInputActivity(PET_INPUT_ACTIVITY_COOLDOWN_MS, 0, undefined)).toBe(false);
  });
});
