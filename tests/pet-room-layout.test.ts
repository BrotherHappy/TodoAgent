import { describe, expect, it } from "vitest";
import {
  PET_ROOM_DECORATION_DEFAULTS,
  clampPetDecorationPlacement,
  projectPetRoomPlacements,
} from "../src/shared/pet-room-layout";

describe("pet room layout", () => {
  it("projects defaults for old archives and ignores unknown decorations", () => {
    const placements = projectPetRoomPlacements({
      plant: { x: 40, y: 50, scale: 1.2 },
      "not-a-decoration": { x: 99, y: 99 },
    });

    expect(placements.plant).toEqual({ x: 40, y: 50, scale: 1.2 });
    expect(placements["cloud-lamp"]).toEqual(PET_ROOM_DECORATION_DEFAULTS["cloud-lamp"]);
    expect(Object.keys(placements)).toEqual(["cloud-lamp", "plant", "books"]);
  });

  it("clamps unsafe or malformed values to a safe room boundary", () => {
    expect(clampPetDecorationPlacement(
      { x: -100, y: 200, scale: 99 },
      PET_ROOM_DECORATION_DEFAULTS.books,
    )).toEqual({ x: 8, y: 88, scale: 1.3 });
    expect(clampPetDecorationPlacement(
      { x: Number.NaN, y: "nope", scale: undefined },
      PET_ROOM_DECORATION_DEFAULTS.books,
    )).toEqual(PET_ROOM_DECORATION_DEFAULTS.books);
  });
});

