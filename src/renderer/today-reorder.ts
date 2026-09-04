/**
 * Move one Today task before another without mutating the source array.
 *
 * Today order is a private projection, so drag-and-drop should only produce
 * a new ordered list of stable task IDs. The caller remains responsible for
 * persisting it through the normal reorder operation (and its undo path).
 */
export function moveTaskBefore(
  taskIds: readonly string[],
  draggedId: string,
  targetId: string,
): string[] {
  const draggedIndex = taskIds.indexOf(draggedId);
  const targetIndex = taskIds.indexOf(targetId);
  if (
    draggedIndex < 0 ||
    targetIndex < 0 ||
    draggedId === targetId ||
    taskIds.length < 2
  ) {
    return [...taskIds];
  }

  const next = [...taskIds];
  next.splice(draggedIndex, 1);
  const nextTargetIndex = next.indexOf(targetId);
  if (nextTargetIndex < 0) return [...taskIds];
  next.splice(nextTargetIndex, 0, draggedId);
  return next;
}

