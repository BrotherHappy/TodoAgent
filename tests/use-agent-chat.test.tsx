import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentApprovalView,
  AgentSendRequest,
  AgentSendResult,
  DesktopApi,
  FeishuStatusView,
} from "../src/shared/desktop-api";
import type { AgentRunEvent } from "../src/shared/agent-types";
import type { Task } from "../src/shared/models";
import { useAgentChat } from "../src/renderer/use-agent-chat";

interface AgentHarness {
  send: ReturnType<typeof vi.fn<(request: AgentSendRequest) => Promise<AgentSendResult>>>;
  respond: ReturnType<typeof vi.fn>;
  emitEvent(event: AgentRunEvent): void;
  emitApproval(approval: AgentApprovalView): void;
  emitTasksChanged(): void;
  emitFeishuStatus(status: FeishuStatusView): void;
  tasksById: Map<string, Task>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function installAgentApi(
  sendImplementation: (request: AgentSendRequest) => Promise<AgentSendResult>,
): AgentHarness {
  const eventListeners = new Set<(event: AgentRunEvent) => void>();
  const approvalListeners = new Set<(approval: AgentApprovalView) => void>();
  const taskListeners = new Set<() => void>();
  const feishuStatusListeners = new Set<
    (status: FeishuStatusView) => void
  >();
  const tasksById = new Map<string, Task>();
  const send = vi.fn(sendImplementation);
  const respond = vi.fn(async () => true);
  window.desktopApi = {
    tasks: {
      get: vi.fn(async (id: string) => tasksById.get(id)),
    },
    agent: {
      status: vi.fn(async () => ({
        enabled: true,
        configured: true,
        activeRunIds: [],
        pendingApprovals: [],
      })),
      send,
      respondToApproval: respond,
      stop: vi.fn(async () => 1),
    },
    events: {
      onTasksChanged: (listener: () => void) => {
        taskListeners.add(listener);
        return () => taskListeners.delete(listener);
      },
      onAgentEvent: (listener: (event: AgentRunEvent) => void) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onAgentApproval: (listener: (approval: AgentApprovalView) => void) => {
        approvalListeners.add(listener);
        return () => approvalListeners.delete(listener);
      },
      onFeishuStatus: (listener: (status: FeishuStatusView) => void) => {
        feishuStatusListeners.add(listener);
        return () => feishuStatusListeners.delete(listener);
      },
    },
  } as unknown as DesktopApi;
  return {
    send,
    respond,
    emitEvent: (event) => eventListeners.forEach((listener) => listener(event)),
    emitApproval: (approval) =>
      approvalListeners.forEach((listener) => listener(approval)),
    emitTasksChanged: () => taskListeners.forEach((listener) => listener()),
    emitFeishuStatus: (status) =>
      feishuStatusListeners.forEach((listener) => listener(status)),
    tasksById,
  };
}

afterEach(() => {
  delete window.desktopApi;
});

describe("useAgentChat", () => {
  it("streams only the correlated run and converges on the final reply", async () => {
    const completion = deferred<AgentSendResult>();
    const harness = installAgentApi(async () => completion.promise);
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好" }),
    );

    let sending!: Promise<boolean>;
    act(() => {
      sending = result.current.send("请规划今天");
    });
    await waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
    const runId = harness.send.mock.calls[0][0].runId!;

    act(() => {
      harness.emitEvent({
        version: 1,
        runId: "another-run",
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: "model-delta",
        payload: { turn: 0, delta: "错误串流" },
      });
      harness.emitEvent({
        version: 1,
        runId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: "model-delta",
        payload: { turn: 0, delta: "## 实时" },
      });
      harness.emitEvent({
        version: 1,
        runId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: "model-delta",
        payload: { turn: 0, delta: "\n\n- 第一项" },
      });
    });
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.text).toBe(
        "## 实时\n\n- 第一项",
      ),
    );
    expect(result.current.messages.at(-1)?.text).not.toContain("错误串流");

    completion.resolve({
      runId,
      state: "completed",
      assistantText: "## 实时\n\n- 第一项",
    });
    await act(async () => {
      await sending;
    });
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "## 实时\n\n- 第一项",
      streaming: false,
    });
    expect(result.current.isSending).toBe(false);
  });

  it("replaces pre-tool planning text with the later streamed Markdown answer and ignores a stale turn", async () => {
    const completion = deferred<AgentSendResult>();
    const harness = installAgentApi(async () => completion.promise);
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好" }),
    );
    let sending!: Promise<boolean>;
    act(() => {
      sending = result.current.send("查询后用 Markdown 表格总结任务");
    });
    await waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
    const runId = harness.send.mock.calls[0][0].runId!;

    act(() => {
      harness.emitEvent({
        version: 1,
        runId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: "model-delta",
        payload: { turn: 0, delta: "我先查询任务…" },
      });
      harness.emitEvent({
        version: 1,
        runId,
        sequence: 2,
        timestamp: new Date().toISOString(),
        type: "model-delta",
        payload: { turn: 1, delta: "## 查询结果\n\n| 标题 | 状态 |" },
      });
      harness.emitEvent({
        version: 1,
        runId,
        sequence: 3,
        timestamp: new Date().toISOString(),
        type: "model-delta",
        payload: { turn: 1, delta: "\n| --- | --- |\n| 验收 | 待办 |" },
      });
      harness.emitEvent({
        version: 1,
        runId,
        sequence: 4,
        timestamp: new Date().toISOString(),
        type: "model-delta",
        payload: { turn: 0, delta: "不应回写旧计划" },
      });
    });

    const markdown = "## 查询结果\n\n| 标题 | 状态 |\n| --- | --- |\n| 验收 | 待办 |";
    await waitFor(() =>
      expect(result.current.messages.at(-1)).toMatchObject({
        text: markdown,
        streaming: true,
      }),
    );
    expect(result.current.messages.at(-1)?.text).not.toContain("我先查询任务");
    expect(result.current.messages.at(-1)?.text).not.toContain("不应回写");

    completion.resolve({
      runId,
      state: "completed",
      assistantText: markdown,
    });
    await act(async () => {
      await sending;
    });
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: markdown,
      streaming: false,
    });
  });

  it("keeps the service's trusted incomplete-run warning visible instead of treating a model success claim as final", async () => {
    const completion = deferred<AgentSendResult>();
    const harness = installAgentApi(async () => completion.promise);
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好" }),
    );
    let sending!: Promise<boolean>;
    act(() => {
      sending = result.current.send("创建一个飞书任务");
    });
    await waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
    const runId = harness.send.mock.calls[0][0].runId!;
    const trustedWarning =
      "> ⚠️ **这次运行未完全完成（状态：AGENT_FEISHU_UNAVAILABLE）。** 请以此状态为准；下面的模型回复不代表操作已成功。\n\n模型回复（未验证）：\n\n已成功创建飞书任务。";

    completion.resolve({
      runId,
      state: "partial",
      errorCode: "AGENT_FEISHU_UNAVAILABLE",
      assistantText: trustedWarning,
    });
    await act(async () => {
      await sending;
    });
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: trustedWarning,
      streaming: false,
    });
    expect(result.current.messages.at(-1)?.text).toContain("⚠️");
    expect(result.current.messages.at(-1)?.text).toContain("未验证");
    expect(result.current.runState).toBe("partial");
  });

  it("renders only the trusted Feishu receipt and refreshes it when sync status changes", async () => {
    const completion = deferred<AgentSendResult>();
    const harness = installAgentApi(async () => completion.promise);
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好" }),
    );
    let sending!: Promise<boolean>;
    act(() => {
      sending = result.current.send("创建一个飞书任务");
    });
    await waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
    const runId = harness.send.mock.calls[0][0].runId!;

    completion.resolve({
      runId,
      state: "completed",
      assistantText:
        "### 飞书任务操作\n\n飞书任务变更已保存到本地同步队列。\n\n> **同步状态仅以系统回执为准。** 模型生成的文字不会用于判断任务是否已写入飞书。",
      feishuSyncReceipts: [
        { taskId: "task-feishu-receipt", action: "created", status: "pending" },
      ],
    });
    await act(async () => {
      await sending;
    });
    expect(result.current.messages.at(-1)?.text).toContain(
      "已创建，正在同步到飞书",
    );

    harness.tasksById.set("task-feishu-receipt", {
      id: "task-feishu-receipt",
      source: { type: "feishu", externalId: "remote-receipt" },
      sync: { status: "synced" },
    } as Task);
    act(() => harness.emitTasksChanged());
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.text).toContain(
        "已创建，已同步到飞书",
      ),
    );

    harness.tasksById.set("task-feishu-receipt", {
      id: "task-feishu-receipt",
      source: { type: "feishu", externalId: "remote-receipt" },
      sync: { status: "failed" },
    } as Task);
    // A foreground sync may report its terminal Feishu status before an
    // additional task-list refresh reaches the renderer. The chat receipt
    // must still re-read trusted local sync state.
    act(() =>
      harness.emitFeishuStatus({
        state: "error",
        configured: true,
        connected: true,
        polling: false,
        lastError: {
          code: "PERMISSION_DENIED",
          message: "权限不足",
          retryable: false,
        },
      }),
    );
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.text).toContain(
        "同步失败，尚未确认已写入飞书",
      ),
    );
  });

  it("never renders whitespace-only terminal output as an invisible Agent reply", async () => {
    const harness = installAgentApi(async (request) => ({
      runId: request.runId!,
      state: "completed",
      assistantText: " \n\t ",
    }));
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好" }),
    );

    await act(async () => {
      await result.current.send("检查一个空白终态");
    });
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      streaming: false,
    });
    expect(result.current.messages.at(-1)?.text).toContain(
      "模型没有返回可显示的回答",
    );
    expect(result.current.messages.at(-1)?.text.trim()).not.toBe("");
    expect(harness.send).toHaveBeenCalledOnce();
  });

  it("filters approvals by run and resolves the matching approval in place", async () => {
    const completion = deferred<AgentSendResult>();
    const harness = installAgentApi(async () => completion.promise);
    const onApproval = vi.fn();
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好", onApproval }),
    );
    let sending!: Promise<boolean>;
    act(() => {
      sending = result.current.send("删除任务");
    });
    await waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
    const runId = harness.send.mock.calls[0][0].runId!;
    const approval = (approvalRunId: string): AgentApprovalView => ({
      approvalId: `approval-${approvalRunId}`,
      runId: approvalRunId,
      toolName: "task_move_to_trash",
      effects: {
        risk: "R2",
        targets: [{ kind: "task", value: "task-1" }],
        reads: [],
        writes: ["task.deletedAt"],
        network: [],
        externalEffects: [],
        reversible: true,
        preview: { action: "move-to-trash", taskId: "task-1" },
        previewHash: "preview-hash",
        baseVersions: { "task-1": "version-1" },
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    act(() => {
      harness.emitApproval(approval("another-run"));
      harness.emitApproval(approval(runId));
    });
    await waitFor(() =>
      expect(result.current.approval?.runId).toBe(runId),
    );
    expect(onApproval).toHaveBeenCalledOnce();
    await act(async () => {
      await result.current.respondToApproval("once");
    });
    expect(harness.respond).toHaveBeenCalledWith({
      approvalId: `approval-${runId}`,
      choice: "once",
    });
    expect(result.current.approval).toBeUndefined();

    completion.resolve({
      runId,
      state: "completed",
      assistantText: "已移到回收站",
    });
    await act(async () => {
      await sending;
    });
  });

  it("synchronously prevents duplicate sends", async () => {
    const completion = deferred<AgentSendResult>();
    const harness = installAgentApi(async () => completion.promise);
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好" }),
    );
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.send("只执行一次");
      second = result.current.send("只执行一次");
    });
    await waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
    await expect(second).resolves.toBe(false);
    const runId = harness.send.mock.calls[0][0].runId!;
    completion.resolve({
      runId,
      state: "completed",
      assistantText: "完成",
    });
    await act(async () => {
      await first;
    });
  });

  it("turns a daily token-limit IPC error into a friendly message", async () => {
    installAgentApi(async () => {
      throw new Error(
        "Error invoking remote method 'agent:send': AI_DAILY_TOKEN_LIMIT_REACHED: AI_DAILY_TOKEN_LIMIT_REACHED",
      );
    });
    const { result } = renderHook(() =>
      useAgentChat({ initialMessage: "你好" }),
    );

    let sent!: boolean;
    await act(async () => {
      sent = await result.current.send("请创建一个任务");
    });

    expect(sent).toBe(false);
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "已达到今日模型 Token 使用上限。请在设置中调整上限，或明天再试。",
      streaming: false,
    });
    expect(result.current.messages.at(-1)?.text).not.toContain(
      "Error invoking remote method",
    );
  });
});
