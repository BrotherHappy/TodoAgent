import { describe, expect, it } from "vitest";
import {
  JUMP_ROPE_CYCLE_MS,
  JUMP_ROPE_DURATION_MS,
  JUMP_ROPE_WINDOW_END,
  JUMP_ROPE_WINDOW_START,
  emptyJumpRopeScore,
  jumpRopeFrame,
  scoreJumpRopeAttempt,
} from "../src/renderer/pet-jump-rope";

describe("cooperative jump-rope timing", () => {
  it("opens a deterministic inclusive timing window and finishes at 20 seconds", () => {
    const before = jumpRopeFrame(
      Math.floor(JUMP_ROPE_CYCLE_MS * JUMP_ROPE_WINDOW_START) - 1,
    );
    const start = jumpRopeFrame(
      Math.ceil(JUMP_ROPE_CYCLE_MS * JUMP_ROPE_WINDOW_START),
    );
    const end = jumpRopeFrame(
      Math.floor(JUMP_ROPE_CYCLE_MS * JUMP_ROPE_WINDOW_END),
    );
    expect(before.windowOpen).toBe(false);
    expect(start.windowOpen).toBe(true);
    expect(end.windowOpen).toBe(true);
    expect(jumpRopeFrame(JUMP_ROPE_DURATION_MS)).toMatchObject({
      finished: true,
      windowOpen: false,
      remainingSeconds: 0,
    });
  });

  it("counts one success per rope cycle without punishing repeated clicks", () => {
    const frame = jumpRopeFrame(600);
    const first = scoreJumpRopeAttempt(emptyJumpRopeScore(), frame);
    expect(first).toMatchObject({
      outcome: "success",
      score: { score: 1, combo: 1, bestCombo: 1, misses: 0 },
    });
    const repeated = scoreJumpRopeAttempt(first.score, frame);
    expect(repeated.outcome).toBe("too-soon");
    expect(repeated.score).toEqual(first.score);
  });

  it("resets only the live combo after a miss and keeps the best combo", () => {
    const first = scoreJumpRopeAttempt(
      emptyJumpRopeScore(),
      jumpRopeFrame(600),
    );
    const second = scoreJumpRopeAttempt(
      first.score,
      jumpRopeFrame(JUMP_ROPE_CYCLE_MS + 600),
    );
    const miss = scoreJumpRopeAttempt(
      second.score,
      jumpRopeFrame(JUMP_ROPE_CYCLE_MS * 2 + 100),
    );
    expect(miss).toMatchObject({
      outcome: "miss",
      score: { score: 2, combo: 0, bestCombo: 2, misses: 1 },
    });
  });
});
