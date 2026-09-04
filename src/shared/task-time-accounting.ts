import type { Task } from "./models";

/**
 * Returns the local work time shown to a user for a task.
 *
 * `actualMinutes` is the canonical aggregate for newer data. Older task
 * snapshots only have `focusSessions` (or, further back, the original
 * `focusElapsedSeconds` counter), so all surfaces must use the same fallback
 * instead of silently displaying zero.
 */
export const actualMinutesForTask = (
  task: Pick<Task, "actualMinutes" | "focusElapsedSeconds" | "focusSessions">,
): number => {
  if (
    typeof task.actualMinutes === "number" &&
    Number.isFinite(task.actualMinutes) &&
    task.actualMinutes >= 0
  ) {
    return Math.round(task.actualMinutes);
  }

  const sessions = task.focusSessions ?? [];
  let sessionSeconds = 0;
  let hasValidSession = false;
  for (const session of sessions) {
    if (
      typeof session.elapsedSeconds === "number" &&
      Number.isFinite(session.elapsedSeconds) &&
      session.elapsedSeconds >= 0
    ) {
      hasValidSession = true;
      sessionSeconds += session.elapsedSeconds;
    }
  }
  if (hasValidSession) return Math.round(sessionSeconds / 60);

  const legacySeconds = task.focusElapsedSeconds;
  if (
    typeof legacySeconds === "number" &&
    Number.isFinite(legacySeconds) &&
    legacySeconds >= 0
  ) {
    return Math.round(legacySeconds / 60);
  }
  return 0;
};
