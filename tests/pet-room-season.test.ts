import { describe, expect, it } from "vitest";
import { petRoomSeasonalDecorations } from "../src/renderer/pet-room-season";

describe("pet room seasonal decorations", () => {
  it("provides a small deterministic layer for each season", () => {
    const seasons = ["spring", "summer", "autumn", "winter"] as const;
    for (const season of seasons) {
      const first = petRoomSeasonalDecorations(season);
      const second = petRoomSeasonalDecorations(season);
      expect(first).toHaveLength(3);
      expect(first).toEqual(second);
      expect(first.every((item) => item.x >= 0 && item.x <= 100 && item.y >= 0 && item.y <= 100)).toBe(true);
      expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
    }
  });
});
