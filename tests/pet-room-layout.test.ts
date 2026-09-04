import { describe, expect, it } from "vitest";
import {
  PET_ROOM_DECORATION_DEFAULTS,
  clampPetDecorationPlacement,
  placementForPetRoomPoint,
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

  it("turns a room pointer position into a bounded percentage placement", () => {
    expect(placementForPetRoomPoint(
      { clientX: 150, clientY: 80 },
      { left: 50, top: 20, width: 200, height: 100 },
      { x: 30, y: 40, scale: 1 },
      PET_ROOM_DECORATION_DEFAULTS.plant,
    )).toEqual({ x: 50, y: 60, scale: 1 });
    expect(placementForPetRoomPoint(
      { clientX: -100, clientY: 500 },
      { left: 0, top: 0, width: 100, height: 100 },
      { x: 30, y: 40, scale: 1 },
      PET_ROOM_DECORATION_DEFAULTS.plant,
    )).toEqual({ x: 8, y: 88, scale: 1 });
  });
});
