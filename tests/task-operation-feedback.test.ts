import { describe, expect, it, vi } from "vitest";
import {
  taskUndoFailureMessage,
  undoTaskOperationWithFeedback,
} from "../src/renderer/task-operation-feedback";

describe("task operation feedback", () => {
  it("turns a snapshot conflict into a user-facing undo message", async () => {
    const notify = vi.fn();
    const controller = {
      undo: vi.fn(async () => {
        throw new Error(
          "Operation op-1 cannot be undone because task task-1 changed afterwards.",
        );
      }),
    };

    await undoTaskOperationWithFeedback(controller, "op-1", notify);

    expect(controller.undo).toHaveBeenCalledWith("op-1");
    expect(notify).toHaveBeenCalledWith(
      "这项变更已被后续修改，无法安全撤销",
      "error",
    );
  });

  it("keeps unexpected errors readable and does not rethrow from a toast action", async () => {
    const notify = vi.fn();
    const controller = {
      undo: vi.fn(async () => {
        throw new Error("STORE_UNAVAILABLE");
      }),
    };

    await expect(
      undoTaskOperationWithFeedback(
        controller,
        "op-2",
        notify,
        "暂时无法撤销这项安排",
      ),
    ).resolves.toBeUndefined();
    expect(taskUndoFailureMessage("not-an-error", "备用提示")).toBe("备用提示");
    expect(notify).toHaveBeenCalledWith("STORE_UNAVAILABLE", "error");
  });
});
