export const JUMP_ROPE_DURATION_MS = 20_000;
export const JUMP_ROPE_CYCLE_MS = 900;
export const JUMP_ROPE_WINDOW_START = 0.58;
export const JUMP_ROPE_WINDOW_END = 0.84;

export interface JumpRopeFrame {
  elapsedMs: number;
  remainingSeconds: number;
  cycle: number;
  phase: number;
  windowOpen: boolean;
  finished: boolean;
}
export interface JumpRopeScore {
  score: number;
  combo: number;
  bestCombo: number;
  misses: number;
  lastScoredCycle: number;
}

export type JumpRopeAttempt = "success" | "too-soon" | "miss" | "finished";

export interface JumpRopeAttemptResult {
  outcome: JumpRopeAttempt;
  score: JumpRopeScore;
}

export const emptyJumpRopeScore = (): JumpRopeScore => ({
  score: 0,
  combo: 0,
  bestCombo: 0,
  misses: 0,
  lastScoredCycle: -1,
});

export function jumpRopeFrame(elapsedMs: number): JumpRopeFrame {
  const safeElapsed = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.floor(elapsedMs))
    : 0;
  const finished = safeElapsed >= JUMP_ROPE_DURATION_MS;
  const boundedElapsed = Math.min(safeElapsed, JUMP_ROPE_DURATION_MS);
  const cycle = Math.floor(boundedElapsed / JUMP_ROPE_CYCLE_MS);
  const phase = (boundedElapsed % JUMP_ROPE_CYCLE_MS) / JUMP_ROPE_CYCLE_MS;
  return {
    elapsedMs: boundedElapsed,
    remainingSeconds: Math.max(
      0,
      Math.ceil((JUMP_ROPE_DURATION_MS - boundedElapsed) / 1_000),
    ),
    cycle,
    phase,
    windowOpen:
      !finished &&
      phase >= JUMP_ROPE_WINDOW_START &&
      phase <= JUMP_ROPE_WINDOW_END,
    finished,
  };
}

export function scoreJumpRopeAttempt(
  current: JumpRopeScore,
  frame: JumpRopeFrame,
): JumpRopeAttemptResult {
  if (frame.finished) return { outcome: "finished", score: current };
  if (frame.windowOpen && current.lastScoredCycle === frame.cycle) {
    // Repeated clicks inside the same visible timing window are ignored rather
    // than punished. This keeps energetic play accessible to more users.
    return { outcome: "too-soon", score: current };
  }
  if (frame.windowOpen) {
    const combo = current.combo + 1;
    return {
      outcome: "success",
      score: {
        ...current,
        score: current.score + 1,
        combo,
        bestCombo: Math.max(current.bestCombo, combo),
        lastScoredCycle: frame.cycle,
      },
    };
  }
  return {
    outcome: "miss",
    score: {
      ...current,
      combo: 0,
      misses: current.misses + 1,
    },
  };
}
