import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TODO_PET_ATLAS_PAGE_COLUMNS,
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
    const motion = pngSize("todo-pet-motion-atlas-v20.png");
    const interaction = pngSize("todo-pet-interaction-atlas-v18.png");
    expect(motion.width).toBe(TODO_PET_MOTION_COLUMNS * 128);
    expect(motion.height).toBe(TODO_PET_MOTION_ROWS * 128);
    expect(interaction.width).toBe(TODO_PET_INTERACTION_COLUMNS * 128);
    expect(interaction.height).toBe(TODO_PET_INTERACTION_ROWS * 128);
    expect(motion.width).toBeLessThanOrEqual(4096);
    expect(interaction.width).toBeLessThanOrEqual(4096);
    expect(TODO_PET_MOTION_COLUMNS).toBe(TODO_PET_ATLAS_PAGE_COLUMNS);
    expect(TODO_PET_INTERACTION_COLUMNS).toBe(TODO_PET_ATLAS_PAGE_COLUMNS);
    expect(TODO_PET_MOTION_ROWS).toBe(4 * TODO_PET_MOTION_PAGE_COUNT);
    expect(TODO_PET_INTERACTION_ROWS).toBe(4 * TODO_PET_INTERACTION_PAGE_COUNT);
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
      ["idle", "motion", 577],
      ["wave", "motion", 577],
      ["focus", "motion", 577],
      ["celebrate", "motion", 321],
      ["pet", "interaction", 385],
      ["jump-rope", "interaction", 321],
      ["task-carry", "interaction", 769],
      ["nap", "interaction", 321],
    ] as const;
    for (const [action, sheet, frameCount] of expectedAnimations) {
      const animation = petAtlasAnimationForAction(action);
      expect(animation.sheet).toBe(sheet);
      expect(animation.frames).toHaveLength(frameCount);
      expect(animation.columns).toBe(TODO_PET_ATLAS_PAGE_COLUMNS);
      expect(animation.rows).toBe(sheet === "motion" ? TODO_PET_MOTION_ROWS : TODO_PET_INTERACTION_ROWS);
      expect(animation.loop).toBe(true);
      expect(animation.frameDurationMs).toBeGreaterThanOrEqual(8);
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
