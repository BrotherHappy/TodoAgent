import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TODO_PET_ATLAS_PAGE_COLUMNS,
  TODO_PET_ATLAS_PAGE_ROWS,
  TODO_PET_ATLAS_PAGE_SIZE,
  TODO_PET_INTERACTION_COLUMNS,
  TODO_PET_INTERACTION_PAGE_COUNT,
  TODO_PET_INTERACTION_ROWS,
  TODO_PET_INTERACTION_SOURCE_COLUMNS,
  TODO_PET_MOTION_COLUMNS,
  TODO_PET_MOTION_PAGE_COUNT,
  TODO_PET_MOTION_ROWS,
  TODO_PET_MOTION_SOURCE_COLUMNS,
  petAtlasAnimationForAction,
  petAtlasFrameForAction,
} from "../src/renderer/pet-atlas";
import { petActionLabels, type PetAction } from "../src/renderer/pet-behavior";

describe("Todo Pet generated action atlas", () => {
  const pngSize = (fileName: string) => {
    const png = readFileSync(resolve(process.cwd(), "src/assets", fileName));
    if (png.toString("ascii", 1, 4) !== "PNG") throw new Error(`Invalid PNG: ${fileName}`);
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  };

  it("keeps runtime grid metadata aligned with the PNG dimensions", () => {
    const motionPages = Array.from({ length: TODO_PET_MOTION_PAGE_COUNT }, (_, page) =>
      pngSize(`todo-pet-motion-atlas-v25-${String(page).padStart(2, "0")}.png`),
    );
    const interactionPages = Array.from({ length: TODO_PET_INTERACTION_PAGE_COUNT }, (_, page) =>
      pngSize(`todo-pet-interaction-atlas-v23-${String(page).padStart(2, "0")}.png`),
    );
    for (const page of motionPages) {
      expect(page.width).toBe(TODO_PET_MOTION_COLUMNS * 128);
      expect(page.height).toBe(TODO_PET_MOTION_ROWS * 128);
      expect(page.width).toBeLessThanOrEqual(4096);
      expect(page.height).toBeLessThanOrEqual(4096);
    }
    for (const page of interactionPages) {
      expect(page.width).toBe(TODO_PET_INTERACTION_COLUMNS * 128);
      expect(page.height).toBe(TODO_PET_INTERACTION_ROWS * 128);
      expect(page.width).toBeLessThanOrEqual(4096);
      expect(page.height).toBeLessThanOrEqual(4096);
    }
    expect(TODO_PET_MOTION_COLUMNS).toBe(TODO_PET_ATLAS_PAGE_COLUMNS);
    expect(TODO_PET_INTERACTION_COLUMNS).toBe(TODO_PET_ATLAS_PAGE_COLUMNS);
    expect(TODO_PET_MOTION_ROWS).toBe(TODO_PET_ATLAS_PAGE_ROWS);
    expect(TODO_PET_INTERACTION_ROWS).toBe(TODO_PET_ATLAS_PAGE_ROWS);
    expect(TODO_PET_ATLAS_PAGE_SIZE).toBe(
      TODO_PET_ATLAS_PAGE_COLUMNS * TODO_PET_ATLAS_PAGE_ROWS,
    );
    expect(TODO_PET_MOTION_PAGE_COUNT).toBe(10);
    expect(TODO_PET_INTERACTION_PAGE_COUNT).toBe(13);
    expect(TODO_PET_MOTION_SOURCE_COLUMNS).toBe(577);
    expect(TODO_PET_INTERACTION_SOURCE_COLUMNS).toBe(769);
  });

  it("provides a valid 4x4 frame for every supported action", () => {
    for (const action of Object.keys(petActionLabels) as PetAction[]) {
      const frame = petAtlasFrameForAction(action);
      expect(frame.index).toBeGreaterThanOrEqual(0);
      expect(frame.index).toBeLessThan(16);
      expect(frame.column).toBeGreaterThanOrEqual(0);
      expect(frame.column).toBeLessThan(4);
      expect(frame.row).toBeGreaterThanOrEqual(0);
      expect(frame.row).toBeLessThan(4);
      expect(frame.name).toBeTruthy();
    }
  });

  it("keeps high-signal workflow actions visually distinct", () => {
    expect(petAtlasFrameForAction("think").name).toBe("think");
    expect(petAtlasFrameForAction("work").name).toBe("type");
    expect(petAtlasFrameForAction("juggle").name).toBe("juggle");
    expect(petAtlasFrameForAction("task-complete").name).toBe("complete");
    expect(petAtlasFrameForAction("agent-error").name).toBe("error");
    expect(petAtlasFrameForAction("nap").name).toBe("sleep");
  });

  it("provides high-frame loops for the main companion states", () => {
    const expectedAnimations = [
      ["idle", "motion", 577, 2],
      ["wave", "motion", 577, 2],
      ["focus", "motion", 577, 2],
      ["celebrate", "motion", 65, 8],
      ["pet", "interaction", 385, 2],
      ["jump-rope", "interaction", 257, 2],
      ["task-carry", "interaction", 769, 2],
      ["nap", "interaction", 321, 34],
    ] as const;
    for (const [action, sheet, frameCount, frameDurationMs] of expectedAnimations) {
      const animation = petAtlasAnimationForAction(action);
      expect(animation.sheet).toBe(sheet);
      expect(animation.frames).toHaveLength(frameCount);
      expect(animation.columns).toBe(TODO_PET_ATLAS_PAGE_COLUMNS);
      expect(animation.rows).toBe(TODO_PET_ATLAS_PAGE_ROWS);
      expect(animation.loop).toBe(true);
      // Fast loops use a calibrated 2ms dense timeline. The renderer consumes
      // the measured display interval (several dense cells per refresh) while
      // still presenting one complete cell at a time.
      expect(animation.frameDurationMs).toBe(frameDurationMs);
    }
  });

  it("keeps logical frame order across vertical page boundaries", () => {
    const idle = petAtlasAnimationForAction("idle");
    const pet = petAtlasAnimationForAction("pet");
    // Motion page 1 starts after 16 columns × 4 source rows. Interaction
    // page 1 follows the same rule; the logical sequence must not reset at
    // the texture seam.
    expect(idle.frames[15]).toBe(15);
    expect(idle.frames[16]).toBe(64);
    expect(pet.frames[15]).toBe(15);
    expect(pet.frames[16]).toBe(64);
    expect(new Set(idle.frames).size).toBe(idle.frames.length);
    expect(new Set(pet.frames).size).toBe(pet.frames.length);
  });
});
