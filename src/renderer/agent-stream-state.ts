export interface MergedAgentDelta {
  text: string;
  turn: number;
}

/**
 * A tool call starts a new model turn. The UI replaces the planning text from
 * the prior turn, while deltas in the same turn are appended exactly once.
 */
export const mergeAgentDelta = (
  currentText: string,
  currentTurn: number,
  incomingTurn: number,
  delta: string,
): MergedAgentDelta | undefined => {
  if (!Number.isInteger(incomingTurn) || incomingTurn < currentTurn || !delta) {
    return undefined;
  }
  return {
    text: incomingTurn > currentTurn ? delta : currentText + delta,
    turn: incomingTurn,
  };
};
