import type { PetInputActivityKind } from "../src/shared/desktop-api";

/** Polling is intentionally coarse: this is a presence cue, not a keylogger. */
export const PET_INPUT_ACTIVITY_POLL_MS = 4_000;
export const PET_INPUT_ACTIVITY_COOLDOWN_MS = 14_000;

/**
 * Convert the operating system's idle duration into a low-detail posture.
 * The exact key, pointer position and application are never inspected.
 */
export function petInputActivityKind(
  idleSeconds: number,
): PetInputActivityKind | undefined {
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return undefined;
  if (idleSeconds <= 2) return "typing";
  if (idleSeconds <= 8) return "reading";
  return undefined;
}

export function shouldEmitPetInputActivity(
  now: number,
  lastEmittedAt: number,
  kind: PetInputActivityKind | undefined,
): boolean {
  return (
    kind !== undefined &&
    Number.isFinite(now) &&
    now - lastEmittedAt >= PET_INPUT_ACTIVITY_COOLDOWN_MS
  );
}
