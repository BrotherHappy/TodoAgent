import { describe, expect, it } from "vitest";
import { projectPetCollection } from "../src/renderer/pet-collection";

describe("pet collection projection", () => {
  it("projects existing inventory without creating task data", () => {
    const result = projectPetCollection([
      { id: "outfit-scarf", quantity: 1, unlockedAt: "2026-08-21T00:00:00.000Z" },
      { id: "toy-ball", quantity: 2, unlockedAt: "2026-08-21T00:00:00.000Z" },
      { id: "unknown-item", quantity: 9, unlockedAt: "2026-08-21T00:00:00.000Z" },
    ]);

    expect(result.unlockedCount).toBe(2);
    expect(result.items.find((item) => item.id === "outfit-scarf")).toMatchObject({
      unlocked: true,
      quantity: 1,
    });
    expect(result.items.find((item) => item.id === "toy-ball")).toMatchObject({
      unlocked: true,
      quantity: 2,
    });
    expect(result.items.find((item) => item.id === "outfit-explorer")).toMatchObject({
      unlocked: false,
      quantity: 0,
    });
    expect(result.items.some((item) => item.id === "unknown-item")).toBe(false);
  });

  it("normalizes duplicate and invalid quantities deterministically", () => {
    const result = projectPetCollection([
      { id: "adventure-star", quantity: 1.4, unlockedAt: "2026-08-21T00:00:00.000Z" },
      { id: "adventure-star", quantity: 2.2, unlockedAt: "2026-08-21T00:00:00.000Z" },
      { id: "outfit-scarf", quantity: -3, unlockedAt: "2026-08-21T00:00:00.000Z" },
      { id: "toy-ball", quantity: Number.NaN, unlockedAt: "2026-08-21T00:00:00.000Z" },
    ]);

    expect(result.items.find((item) => item.id === "adventure-star")?.quantity).toBe(3);
    expect(result.items.find((item) => item.id === "outfit-scarf")?.unlocked).toBe(false);
    expect(result.items.find((item) => item.id === "toy-ball")?.unlocked).toBe(false);
  });
});
