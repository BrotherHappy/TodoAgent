import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineTaskComposer } from "../src/renderer/InlineTaskComposer";
import type { TaskController } from "../src/renderer/task-controller";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const controllerWith = (create: TaskController["create"]) =>
  ({ create } as unknown as TaskController);

describe("InlineTaskComposer", () => {
  it("adds a trimmed local task to Today and keeps the input ready for another capture", async () => {
    const user = userEvent.setup();
    const create = vi.fn<TaskController["create"]>().mockResolvedValue({
      task: {} as never,
      operationId: "operation-inline-create",
    });
    const notify = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    render(
      <InlineTaskComposer
        route="today"
        controller={controllerWith(create)}
        notify={notify}
      />,
    );

    const input = screen.getByRole("textbox", { name: "快速添加任务" });
    await user.type(input, "  整理发布清单  ");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "整理发布清单",
        source: { type: "local" },
        plannedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
        sync: { status: "local" },
      }),
      { selectCreated: false },
    );
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(notify).toHaveBeenCalledWith("已添加到今天", "success");
  });

  it("keeps inbox captures unscheduled so they remain in the current collection", async () => {
    const user = userEvent.setup();
    const create = vi.fn<TaskController["create"]>().mockResolvedValue({
      task: {} as never,
      operationId: "operation-inbox-create",
    });
    render(
      <InlineTaskComposer
        route="inbox"
        controller={controllerWith(create)}
        notify={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "快速添加任务" }), "稍后整理");
    fireEvent.submit(screen.getByRole("form", { name: "快速添加到暂存" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const [input] = create.mock.calls[0];
    expect(input).toMatchObject({
      title: "稍后整理",
      source: { type: "local" },
      sync: { status: "local" },
    });
    expect(input).not.toHaveProperty("plannedDate");
  });

  it("does not submit empty text and preserves the draft when creation fails", async () => {
    const user = userEvent.setup();
    const create = vi
      .fn<TaskController["create"]>()
      .mockRejectedValue(new Error("本地存储暂时不可用"));
    const notify = vi.fn();
    render(
      <InlineTaskComposer
        route="all"
        controller={controllerWith(create)}
        notify={notify}
      />,
    );

    const input = screen.getByRole("textbox", { name: "快速添加任务" });
    const submit = screen.getByRole("button", { name: "添加" });
    expect(submit).toBeDisabled();
    await user.type(input, "  ");
    fireEvent.submit(screen.getByRole("form", { name: "快速添加到本地任务" }));
    expect(create).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "保留这条草稿");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(input).toHaveValue("保留这条草稿");
    expect(notify).toHaveBeenCalledWith("本地存储暂时不可用", "error");
    expect(submit).toBeEnabled();
  });

  it("supports a contextual Today capture with focus, cancel, and parent-owned feedback", async () => {
    const user = userEvent.setup();
    const result = {
      task: { id: "task-contextual" } as never,
      operationId: "operation-contextual-create",
    };
    const create = vi.fn<TaskController["create"]>().mockResolvedValue(result);
    const notify = vi.fn();
    const onCancel = vi.fn();
    const onCreated = vi.fn().mockResolvedValue(true);
    render(
      <InlineTaskComposer
        route="today"
        controller={controllerWith(create)}
        notify={notify}
        placement="after"
        afterTaskTitle="准备发布"
        autoFocus
        onCancel={onCancel}
        onCreated={onCreated}
      />,
    );

    const form = screen.getByRole("form", {
      name: "在“准备发布”后快速添加到今天",
    });
    const input = within(form).getByRole("textbox", { name: "快速添加任务" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();

    await user.type(input, "发布前检查");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(onCreated).toHaveBeenCalledWith(result);
    expect(notify).not.toHaveBeenCalled();
  });
});
