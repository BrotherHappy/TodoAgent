import { describe, expect, it } from "vitest";
import { petCompanionGreeting } from "../src/renderer/pet-companion-interactions";

describe("pet companion interactions", () => {
  it("creates a short kind and personality-specific greeting without task data", () => {
    expect(petCompanionGreeting({
      kind: "paper-bird",
      name: "小纸",
      personality: "playful",
    })).toContain("小纸眨眨眼说");
    expect(petCompanionGreeting({
      kind: "moon-moth",
      name: "",
      personality: "quiet",
    })).toContain("小伙伴小声说");
    expect(petCompanionGreeting({
      kind: "moss-mouse",
      name: "苔苔",
      personality: "calm",
    })).not.toMatch(/任务|飞书|id/u);
  });
});
