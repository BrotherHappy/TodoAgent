import type { PetSeason } from "./PetCharacter";

export interface PetRoomSeasonalDecoration {
  id: string;
  glyph: string;
  label: string;
  x: number;
  y: number;
  size: number;
}

const DECORATIONS: Record<PetSeason, readonly PetRoomSeasonalDecoration[]> = {
  spring: [
    { id: "spring-flower-left", glyph: "✿", label: "春日花朵", x: 13, y: 24, size: 22 },
    { id: "spring-flower-right", glyph: "❀", label: "春日花朵", x: 86, y: 30, size: 18 },
    { id: "spring-sprout", glyph: "♧", label: "春日新芽", x: 24, y: 77, size: 23 },
  ],
  summer: [
    { id: "summer-sun", glyph: "☀", label: "夏日阳光", x: 86, y: 19, size: 25 },
    { id: "summer-breeze", glyph: "≈", label: "夏日微风", x: 16, y: 40, size: 26 },
    { id: "summer-spark", glyph: "·", label: "夏日光点", x: 73, y: 23, size: 19 },
  ],
  autumn: [
    { id: "autumn-leaf-left", glyph: "❧", label: "秋日落叶", x: 13, y: 29, size: 25 },
    { id: "autumn-leaf-right", glyph: "❧", label: "秋日落叶", x: 87, y: 46, size: 20 },
    { id: "autumn-leaf-floor", glyph: "•", label: "秋日叶片", x: 23, y: 84, size: 22 },
  ],
  winter: [
    { id: "winter-snow-left", glyph: "✦", label: "冬日雪花", x: 15, y: 22, size: 23 },
    { id: "winter-snow-right", glyph: "❄", label: "冬日雪花", x: 86, y: 36, size: 21 },
    { id: "winter-snow-floor", glyph: "·", label: "冬日雪点", x: 74, y: 81, size: 26 },
  ],
};

/**
 * Returns a deterministic, decorative-only seasonal layer for the room.
 * Coordinates are percentages so the layer remains safe across window sizes.
 */
export function petRoomSeasonalDecorations(
  season: PetSeason,
): readonly PetRoomSeasonalDecoration[] {
  return DECORATIONS[season];
}
