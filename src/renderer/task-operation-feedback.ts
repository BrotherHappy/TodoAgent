import type { TaskController } from "./task-controller";

export type TaskOperationFeedbackKind = "success" | "error" | "info";

export type TaskOperationNotifier = (
  message: string,
  kind?: TaskOperationFeedbackKind,
) => void;

export function taskUndoFailureMessage(
  reason: unknown,
  fallback = "最近一次任务变更暂时无法撤销",
): string {
  if (reason instanceof Error) {
    if (reason.message.includes("changed afterwards")) {
      return "这项变更已被后续修改，无法安全撤销";
    }
    return reason.message;
  }
  return fallback;
}

/**
 * Toast actions are intentionally fire-and-forget. Keep their promise
 * rejection inside the interaction boundary so an expected snapshot conflict
 * never becomes an unhandled renderer error or a silent no-op.
 */
export async function undoTaskOperationWithFeedback(
  controller: Pick<TaskController, "undo">,
  operationId: string,
  notify: TaskOperationNotifier,
  fallback?: string,
): Promise<void> {
  try {
    await controller.undo(operationId);
  } catch (reason) {
    notify(taskUndoFailureMessage(reason, fallback), "error");
  }
}
