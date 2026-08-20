/**
 * The three places a task card can be handed to Todo Pet while it is being
 * dragged. Keeping the vocabulary in a tiny pure module makes the visual
 * drop targets and future keyboard/voice affordances share one contract.
 */
export type PetTaskDropTargetId = "focus" | "complete" | "later";

export interface PetTaskDropTarget {
  id: PetTaskDropTargetId;
  label: string;
  hint: string;
}
export const petTaskDropTargets: readonly PetTaskDropTarget[] = [
  { id: "focus", label: "专注", hint: "现在一起做" },
  { id: "complete", label: "完成", hint: "做完啦" },
  { id: "later", label: "稍后", hint: "先放在手边" },
];

export function getPetTaskDropTarget(
  value: unknown,
): PetTaskDropTarget | undefined {
  return petTaskDropTargets.find((target) => target.id === value);
}
