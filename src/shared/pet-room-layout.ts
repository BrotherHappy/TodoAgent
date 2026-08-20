import type { PetDecorationPlacement } from "./pet-types";

/** Decorations that currently have a visual slot in the room stage. */
export const PET_ROOM_DECORATION_IDS = ["cloud-lamp", "plant", "books"] as const;
export type PetRoomDecorationId = (typeof PET_ROOM_DECORATION_IDS)[number];

export const PET_ROOM_DECORATION_LABELS: Record<PetRoomDecorationId, string> = {
  "cloud-lamp": "云灯",
  plant: "小植物",
  books: "任务书架",
};

/** Calm defaults keep the room balanced around the pet and the window. */
export const PET_ROOM_DECORATION_DEFAULTS: Record<
  PetRoomDecorationId,
  Required<PetDecorationPlacement>
> = {
  "cloud-lamp": { x: 82, y: 18, scale: 1 },
  plant: { x: 76, y: 72, scale: 1 },
  books: { x: 23, y: 76, scale: 1 },
};

export const PET_ROOM_PLACEMENT_LIMITS = {
  x: { min: 8, max: 92 },
  y: { min: 10, max: 88 },
  scale: { min: 0.75, max: 1.3 },
} as const;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalize one placement at the shared service/renderer boundary. */
export function clampPetDecorationPlacement(
  value: unknown,
  fallback: Required<PetDecorationPlacement>,
): Required<PetDecorationPlacement> {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    x: clamp(finiteNumber(candidate.x, fallback.x), PET_ROOM_PLACEMENT_LIMITS.x.min, PET_ROOM_PLACEMENT_LIMITS.x.max),
    y: clamp(finiteNumber(candidate.y, fallback.y), PET_ROOM_PLACEMENT_LIMITS.y.min, PET_ROOM_PLACEMENT_LIMITS.y.max),
    scale: clamp(finiteNumber(candidate.scale, fallback.scale), PET_ROOM_PLACEMENT_LIMITS.scale.min, PET_ROOM_PLACEMENT_LIMITS.scale.max),
  };
}

/** Project an archived map onto the known visual slots. Unknown IDs are ignored. */
export function projectPetRoomPlacements(
  positions?: Record<string, PetDecorationPlacement>,
): Record<PetRoomDecorationId, Required<PetDecorationPlacement>> {
  return Object.fromEntries(
    PET_ROOM_DECORATION_IDS.map((id) => [
      id,
      clampPetDecorationPlacement(positions?.[id], PET_ROOM_DECORATION_DEFAULTS[id]),
    ]),
  ) as Record<PetRoomDecorationId, Required<PetDecorationPlacement>>;
}

export function isPetRoomDecorationId(value: string): value is PetRoomDecorationId {
  return (PET_ROOM_DECORATION_IDS as readonly string[]).includes(value);
}

