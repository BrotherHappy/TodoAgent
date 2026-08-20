import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentApprovalView,
  AgentFeishuSyncReceipt,
  AgentStatus,
} from "../shared/desktop-api";
import type { ApprovalChoice } from "../shared/agent-types";
import { mergeAgentDelta } from "./agent-stream-state";
import {
  AGENT_CONVERSATIONS_STORAGE_KEY,
  AGENT_CONVERSATION_STORAGE_KEY,
  agentConversationMarkdown,
  clearStoredAgentConversation,
  conversationTitle,
  readStoredAgentConversationCollection,
  removeStoredAgentConversation,
  updateStoredAgentConversationMetadata,
  type StoredAgentConversation,
  writeStoredAgentConversation,
  writeStoredAgentConversationCollection,
  upsertStoredAgentConversation,
  type StoredAgentMessage,
} from "./agent-conversation-store";

export interface AgentUiMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  /** Trusted Feishu state, kept separate from model-generated prose. */
  feishuSyncReceipts?: AgentFeishuSyncReceipt[];
  /** Stable service text used when a background sync refresh changes a receipt. */
  syncBaseText?: string;
}

interface ActiveAgentStream {
  runId: string;
  messageId: string;
  turn: number;
}

export interface UseAgentChatOptions {
  initialMessage: string;
  onFallback?: (message: string) => Promise<string | undefined>;
  onApproval?: (approval: AgentApprovalView) => void;
  /** Keep the short-term session only on this device; it is separate from model data scope. */
  persistConversation?: boolean;
  conversationStorageKey?: string;
}

const runStateLabel = (state?: string): string =>
  state === "model-streaming"
    ? "思考中"
    : state === "tool-running"
      ? "执行工具"
      : state === "awaiting-approval"
        ? "等待确认"
        : state === "stopping"
          ? "正在停止"
          : (state ?? "运行中");

const knownAgentErrorMessages: Record<string, string> = {
  AI_DAILY_TOKEN_LIMIT_REACHED:
    "已达到今日模型 Token 使用上限。请在设置中调整上限，或明天再试。",
  AI_PROVIDER_USAGE_UNAVAILABLE:
    "模型服务没有返回用量信息，无法安全执行这次请求。请检查模型服务配置后重试。",
  AI_DAILY_COST_LIMIT_REACHED:
    "已达到今日模型费用预算。请在设置中调整上限，或明天再试。",
  AI_PROVIDER_COST_UNAVAILABLE:
    "模型服务没有返回可计费的输入/输出 token，无法安全执行这次请求。请检查用量回报后重试。",
  AI_USAGE_STATE_UNAVAILABLE:
    "本地用量记录暂不可用。为保护你的模型额度，已暂停这次请求，请稍后重试。",
  AI_MODEL_NOT_CONFIGURED: "尚未配置可用模型，请先前往设置完成配置。",
  AI_NOT_CONFIGURED: "尚未配置可用模型，请先前往设置完成配置。",
  AI_CREDENTIAL_NOT_CONFIGURED:
    "尚未配置模型 API Key。请前往设置补充，或选择可信自托管的无需 API Key 模式。",
  AI_CREDENTIAL_UNAVAILABLE:
    "模型凭据当前不可用。请在设置中重新保存配置后再试。",
  AGENT_FEISHU_UNAVAILABLE:
    "当前没有可用的飞书连接，因此没有执行飞书写入。请在设置中重新连接飞书后重试。",
  AGENT_FEISHU_ACCOUNT_MISMATCH:
    "这项任务绑定的飞书账号与当前连接账号不一致。为避免留下无法同步的改动，Agent 没有执行写入。",
  AGENT_TASK_SOURCE_MISMATCH:
    "这次请求的任务来源与已明确选择不一致，因此没有创建任务。请明确选择本地或飞书后重试。",
  AGENT_TASK_SOURCE_CLARIFICATION_REQUIRED:
    "需要先明确新任务保存到本地还是飞书，因此尚未创建任务。",
};

/** Keep whitespace-only provider output from becoming an invisible Markdown reply. */
const visibleAssistantText = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/\0/gu, "");
  return sanitized.trim().length > 0 ? sanitized : undefined;
};

const storedMessagesFromUi = (
  messages: readonly AgentUiMessage[],
): StoredAgentMessage[] =>
  messages
    .filter((message) => !message.streaming && message.text.trim().length > 0)
    .slice(-50)
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      feishuSyncReceipts: message.feishuSyncReceipts,
      syncBaseText: message.syncBaseText,
    }));

const storedConversationFromUi = (
  messages: readonly AgentUiMessage[],
  conversationId: string,
): StoredAgentConversation | undefined => {
  const storedMessages = storedMessagesFromUi(messages);
  if (storedMessages.length === 0) return undefined;
  return {
    schemaVersion: 1,
    conversationId,
    updatedAt: new Date().toISOString(),
    messages: storedMessages,
  };
};

const uiMessagesFromStored = (
  conversation: StoredAgentConversation,
): AgentUiMessage[] =>
  conversation.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    feishuSyncReceipts: message.feishuSyncReceipts,
    syncBaseText: message.syncBaseText,
  }));

const feishuActionLabel: Record<AgentFeishuSyncReceipt["action"], string> = {
  created: "已创建",
  updated: "已更新",
  completed: "已标记完成",
  reopened: "已重新打开",
  deleted: "已移入回收站",
  restored: "已恢复",
};

const feishuSyncStatusLabel: Record<AgentFeishuSyncReceipt["status"], string> = {
  local: "当前不是飞书同步任务",
  pending: "正在同步到飞书",
  syncing: "正在同步到飞书",
  synced: "已同步到飞书",
  offline: "等待网络恢复后同步",
  failed: "同步失败，尚未确认已写入飞书",
  conflict: "发现同步冲突，尚未确认已写入飞书",
  "read-only": "当前只读，尚未确认已写入飞书",
  "permission-denied": "飞书权限不足，尚未确认已写入飞书",
  "remote-deleted": "飞书端已删除，尚未确认已写入飞书",
};

const withFeishuSyncReceipts = (
  baseText: string,
  receipts: AgentFeishuSyncReceipt[],
): string => {
  if (receipts.length === 0) return baseText;
  const rows = receipts.map(
    (receipt, index) =>
      `- 任务 ${index + 1}：${feishuActionLabel[receipt.action]}，${feishuSyncStatusLabel[receipt.status]}。`,
  );
  return `${baseText}\n\n---\n\n### 系统同步回执（以此为准）\n\n${rows.join("\n")}`;
};

function agentErrorTextForUser(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : "";
  for (const [code, friendlyMessage] of Object.entries(knownAgentErrorMessages)) {
    if (message.includes(code)) return friendlyMessage;
  }
  if (message.includes("Error invoking remote method")) {
    return "模型请求失败，请稍后重试。";
  }
  return message || "模型请求失败。";
}

export function useAgentChat({
  initialMessage,
  onFallback,
  onApproval,
  persistConversation = false,
  conversationStorageKey = AGENT_CONVERSATION_STORAGE_KEY,
}: UseAgentChatOptions) {
  const conversationSessionsStorageKey =
    conversationStorageKey === AGENT_CONVERSATION_STORAGE_KEY
      ? AGENT_CONVERSATIONS_STORAGE_KEY
      : `${conversationStorageKey}:sessions`;
  const storedCollectionRef = useRef(
    persistConversation
      ? readStoredAgentConversationCollection(
          conversationSessionsStorageKey,
          conversationStorageKey,
        )
      : { schemaVersion: 1 as const, conversations: [] },
  );
  const storedConversationRef = useRef(
    persistConversation
      ? storedCollectionRef.current.activeConversationId
        ? storedCollectionRef.current.conversations.find(
            (conversation) =>
              conversation.conversationId ===
              storedCollectionRef.current.activeConversationId,
          )
        : storedCollectionRef.current.conversations[0]
      : undefined,
  );
  const [messages, setMessages] = useState<AgentUiMessage[]>(() =>
    storedConversationRef.current
      ? uiMessagesFromStored(storedConversationRef.current)
      : [{ role: "assistant", text: initialMessage }],
  );
  const [input, setInput] = useState("");
  const [approval, setApproval] = useState<AgentApprovalView>();
  const [agentStatus, setAgentStatus] = useState<AgentStatus>();
  const [runState, setRunState] = useState("就绪");
  const [isSending, setIsSending] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [hasStoredConversation, setHasStoredConversation] = useState(
    storedConversationRef.current !== undefined,
  );
  const [conversationSessions, setConversationSessions] = useState<StoredAgentConversation[]>(
    storedCollectionRef.current.conversations,
  );
  const messagesRef = useRef(messages);
  const activeStreamRef = useRef<ActiveAgentStream | undefined>(undefined);
  const conversationIdRef = useRef(
    storedConversationRef.current?.conversationId ?? crypto.randomUUID(),
  );
  const sendingRef = useRef(false);
  const fallbackRef = useRef(onFallback);
  const approvalCallbackRef = useRef(onApproval);
  const syncReceiptRefreshEpochRef = useRef(0);

  messagesRef.current = messages;
  fallbackRef.current = onFallback;
  approvalCallbackRef.current = onApproval;

  useEffect(() => {
    if (!persistConversation || messages.length === 0) return undefined;
    const timer = window.setTimeout(() => {
      const conversation = storedConversationFromUi(
        messages,
        conversationIdRef.current,
      );
      if (!conversation) return;
      const persisted = upsertStoredAgentConversation(
        conversation,
        conversationIdRef.current,
        conversationSessionsStorageKey,
        conversationStorageKey,
      );
      if (!persisted) return;
      // Keep the legacy single-session key readable for older renderer builds.
      writeStoredAgentConversation(conversation, conversationStorageKey);
      setConversationSessions((current) => {
        const next = [
          conversation,
          ...current.filter(
            (item) => item.conversationId !== conversation.conversationId,
          ),
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8);
        const unchanged =
          current.length === next.length &&
          current.every(
            (item, index) =>
              item.conversationId === next[index]?.conversationId &&
              item.updatedAt === next[index]?.updatedAt &&
              item.messages.length === next[index]?.messages.length,
          );
        return unchanged ? current : next;
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [conversationSessionsStorageKey, conversationStorageKey, messages, persistConversation]);

  const refreshStatus = useCallback(async () => {
    if (!window.desktopApi) return undefined;
    const status = await window.desktopApi.agent.status();
    setAgentStatus(status);
    return status;
  }, []);

  const refreshFeishuSyncReceipts = useCallback(async () => {
    const api = window.desktopApi;
    if (!api) return;
    const refreshEpoch = syncReceiptRefreshEpochRef.current + 1;
    syncReceiptRefreshEpochRef.current = refreshEpoch;
    const taskIds = [
      ...new Set(
        messagesRef.current.flatMap(
          (message) =>
            message.feishuSyncReceipts?.map((receipt) => receipt.taskId) ?? [],
        ),
      ),
    ];
    if (taskIds.length === 0) return;
    const currentTasks = await Promise.all(
      taskIds.map(async (id) => {
        try {
          return [id, await api.tasks.get(id, true)] as const;
        } catch {
          return [id, undefined] as const;
        }
      }),
    );
    if (refreshEpoch !== syncReceiptRefreshEpochRef.current) return;
    const statusById = new Map(
      currentTasks.flatMap(([id, task]) =>
        task?.source.type === "feishu" ? [[id, task.sync.status] as const] : [],
      ),
    );
    if (statusById.size === 0) return;
    setMessages((current) =>
      current.map((message) => {
        if (!message.feishuSyncReceipts || !message.syncBaseText) return message;
        const receipts = message.feishuSyncReceipts.map((receipt) => {
          const status = statusById.get(receipt.taskId);
          return status ? { ...receipt, status } : receipt;
        });
        const changed = receipts.some(
          (receipt, index) =>
            receipt.status !== message.feishuSyncReceipts?.[index]?.status,
        );
        return changed
          ? {
              ...message,
              text: withFeishuSyncReceipts(message.syncBaseText, receipts),
              feishuSyncReceipts: receipts,
            }
          : message;
      }),
    );
  }, []);

  useEffect(() => {
    if (!window.desktopApi) return undefined;
    void refreshStatus().catch(() => undefined);
    const offApproval = window.desktopApi.events.onAgentApproval((next) => {
      const stream = activeStreamRef.current;
      if (!stream || next.runId !== stream.runId) return;
      setApproval(next);
      setRunState("等待确认");
      approvalCallbackRef.current?.(next);
    });
    const offEvent = window.desktopApi.events.onAgentEvent((event) => {
      const stream = activeStreamRef.current;
      if (!stream || stream.runId !== event.runId) return;
      if (event.type === "model-delta") {
        const payload = event.payload as { turn?: number; delta?: string };
        if (
          typeof payload.turn !== "number" ||
          typeof payload.delta !== "string" ||
          payload.turn < stream.turn
        ) {
          return;
        }
        const previousTurn = stream.turn;
        stream.turn = payload.turn;
        setMessages((current) =>
          current.map((message) => {
            if (message.id !== stream.messageId) return message;
            const merged = mergeAgentDelta(
              message.text,
              previousTurn,
              payload.turn!,
              payload.delta!,
            );
            return merged ? { ...message, text: merged.text } : message;
          }),
        );
        return;
      }
      if (event.type === "run-state") {
        setRunState(
          runStateLabel((event.payload as { state?: string }).state),
        );
      }
      if (event.type === "approval-decided") {
        const approvalId = (event.payload as { approvalId?: string }).approvalId;
        setApproval((current) =>
          current?.approvalId === approvalId ? undefined : current,
        );
      }
      if (event.type === "run-terminal") {
        setApproval(undefined);
        setRunState("就绪");
      }
    });
    const offTasksChanged = window.desktopApi.events.onTasksChanged?.(() => {
      void refreshFeishuSyncReceipts();
    });
    // A foreground sync can change a receipt to failed/read-only before (or
    // without) a separate task-change broadcast. Refresh from the trusted
    // local task state on either signal; never infer success from model text.
    const offFeishuStatus = window.desktopApi.events.onFeishuStatus?.(() => {
      void refreshFeishuSyncReceipts();
    });
    return () => {
      offApproval();
      offEvent();
      offTasksChanged?.();
      offFeishuStatus?.();
    };
  }, [refreshFeishuSyncReceipts, refreshStatus]);

  const appendAssistant = useCallback((text: string) => {
    setMessages((current) => [...current, { role: "assistant", text }]);
  }, []);

  const rotateConversation = useCallback(
    (archiveCurrent: boolean) => {
      const previousConversationId = conversationIdRef.current;
      const nextConversationId = crypto.randomUUID();
      if (persistConversation) {
        const current = storedConversationFromUi(
          messagesRef.current,
          previousConversationId,
        );
        const collection = readStoredAgentConversationCollection(
          conversationSessionsStorageKey,
          conversationStorageKey,
        );
        const shouldArchive =
          archiveCurrent && current?.messages.some((message) => message.role === "user");
        const conversations = shouldArchive && current
          ? [
              current,
              ...collection.conversations.filter(
                (conversation) => conversation.conversationId !== previousConversationId,
              ),
            ]
          : collection.conversations.filter(
              (conversation) => conversation.conversationId !== previousConversationId,
            );
        writeStoredAgentConversationCollection(
          {
            schemaVersion: 1,
            activeConversationId: nextConversationId,
            conversations,
          },
          conversationSessionsStorageKey,
        );
        // The legacy key is only a compatibility fallback; the active marker
        // in the collection is authoritative for current renderer builds.
        clearStoredAgentConversation(conversationStorageKey);
        setConversationSessions(
          readStoredAgentConversationCollection(
            conversationSessionsStorageKey,
            conversationStorageKey,
          ).conversations,
        );
      }
      conversationIdRef.current = nextConversationId;
      setHasStoredConversation(false);
      setApproval(undefined);
      setInput("");
      setRunState("就绪");
      setMessages([{ role: "assistant", text: initialMessage }]);
    },
    [
      conversationSessionsStorageKey,
      conversationStorageKey,
      initialMessage,
      persistConversation,
    ],
  );

  const newConversation = useCallback(() => {
    rotateConversation(true);
  }, [rotateConversation]);

  const clearConversation = useCallback(() => {
    rotateConversation(false);
  }, [rotateConversation]);

  const switchConversation = useCallback(
    (targetConversationId: string): boolean => {
      if (!persistConversation || sendingRef.current) return false;
      const current = storedConversationFromUi(
        messagesRef.current,
        conversationIdRef.current,
      );
      if (current && current.conversationId !== targetConversationId) {
        upsertStoredAgentConversation(
          current,
          conversationIdRef.current,
          conversationSessionsStorageKey,
          conversationStorageKey,
        );
      }
      const collection = readStoredAgentConversationCollection(
        conversationSessionsStorageKey,
        conversationStorageKey,
      );
      const target = collection.conversations.find(
        (conversation) => conversation.conversationId === targetConversationId,
      );
      if (!target) return false;
      writeStoredAgentConversationCollection(
        { ...collection, activeConversationId: targetConversationId },
        conversationSessionsStorageKey,
      );
      writeStoredAgentConversation(target, conversationStorageKey);
      conversationIdRef.current = targetConversationId;
      setMessages(uiMessagesFromStored(target));
      setConversationSessions(collection.conversations);
      setHasStoredConversation(true);
      setApproval(undefined);
      setInput("");
      setRunState("就绪");
      return true;
    },
    [conversationSessionsStorageKey, conversationStorageKey, persistConversation],
  );

  const removeConversation = useCallback(
    (targetConversationId: string): boolean => {
      if (!persistConversation || sendingRef.current) return false;
      if (targetConversationId === conversationIdRef.current) {
        rotateConversation(false);
        return true;
      }
      const collection = readStoredAgentConversationCollection(
        conversationSessionsStorageKey,
        conversationStorageKey,
      );
      const removed = removeStoredAgentConversation(
        targetConversationId,
        collection.activeConversationId,
        conversationSessionsStorageKey,
        conversationStorageKey,
      );
      if (removed) {
        setConversationSessions(
          readStoredAgentConversationCollection(
            conversationSessionsStorageKey,
            conversationStorageKey,
          ).conversations,
        );
      }
      return removed;
    },
    [
      conversationSessionsStorageKey,
      conversationStorageKey,
      persistConversation,
      rotateConversation,
    ],
  );

  const renameConversation = useCallback(
    (targetConversationId: string, title: string): boolean => {
      if (!persistConversation || sendingRef.current) return false;
      const updated = updateStoredAgentConversationMetadata(
        targetConversationId,
        { title },
        conversationSessionsStorageKey,
        conversationStorageKey,
      );
      if (updated) {
        setConversationSessions(
          readStoredAgentConversationCollection(
            conversationSessionsStorageKey,
            conversationStorageKey,
          ).conversations,
        );
      }
      return updated;
    },
    [conversationSessionsStorageKey, conversationStorageKey, persistConversation],
  );

  const toggleConversationPinned = useCallback(
    (targetConversationId: string): boolean => {
      if (!persistConversation || sendingRef.current) return false;
      const current = readStoredAgentConversationCollection(
        conversationSessionsStorageKey,
        conversationStorageKey,
      );
      const target = current.conversations.find(
        (conversation) => conversation.conversationId === targetConversationId,
      );
      if (!target) return false;
      const updated = updateStoredAgentConversationMetadata(
        targetConversationId,
        { pinned: !target.pinnedAt },
        conversationSessionsStorageKey,
        conversationStorageKey,
      );
      if (updated) {
        setConversationSessions(
          readStoredAgentConversationCollection(
            conversationSessionsStorageKey,
            conversationStorageKey,
          ).conversations,
        );
      }
      return updated;
    },
    [conversationSessionsStorageKey, conversationStorageKey, persistConversation],
  );

  const exportConversation = useCallback((): string => {
    const storedMessages = storedMessagesFromUi(messages);
    return agentConversationMarkdown({
      schemaVersion: 1,
      conversationId: conversationIdRef.current,
      updatedAt: new Date().toISOString(),
      messages: storedMessages,
    });
  }, [messages]);

  const send = useCallback(async (suggestion?: string): Promise<boolean> => {
    const text = (suggestion ?? input).trim();
    if (!text || sendingRef.current) return false;
    sendingRef.current = true;
    setIsSending(true);
    setApproval(undefined);
    const history = messagesRef.current.slice(-50).map((message) => ({
      role: message.role,
      content: message.text,
    }));
    setMessages((current) => [...current, { role: "user", text }]);
    setInput("");

    let startedStream: ActiveAgentStream | undefined;
    try {
      if (window.desktopApi) {
        const status = await refreshStatus();
        if (status?.enabled && status.configured) {
          const runId = crypto.randomUUID();
          const messageId = `agent-response-${runId}`;
          startedStream = { runId, messageId, turn: -1 };
          activeStreamRef.current = startedStream;
          setActiveRunId(runId);
          setMessages((current) => [
            ...current,
            { id: messageId, role: "assistant", text: "", streaming: true },
          ]);
          setRunState("思考中");
          const output = await window.desktopApi.agent.send({
            runId,
            conversationId: conversationIdRef.current,
            message: text,
            history,
          });
          setMessages((current) =>
            current.map((message) => {
              if (message.id !== messageId) return message;
              const streamedText = visibleAssistantText(message.text);
              const fallback =
                output.state === "cancelled"
                  ? streamedText
                    ? `${streamedText}\n\n_已停止生成。_`
                    : "已停止这次操作。"
                  : streamedText ||
                    (output.state === "completed"
                      ? "这次处理已结束，但模型没有返回可显示的回答。未确认任何任务变更；请重试，或以系统同步回执为准。"
                      : `这次运行未完成（${output.errorCode ?? output.state}）。`);
              const baseText = visibleAssistantText(output.assistantText) ?? fallback;
              const feishuSyncReceipts = output.feishuSyncReceipts;
              return {
                ...message,
                text: feishuSyncReceipts
                  ? withFeishuSyncReceipts(baseText, feishuSyncReceipts)
                  : baseText,
                ...(feishuSyncReceipts
                  ? { feishuSyncReceipts, syncBaseText: baseText }
                  : {}),
                streaming: false,
              };
            }),
          );
          if (output.feishuSyncReceipts?.length) {
            void refreshFeishuSyncReceipts();
          }
          setRunState(output.state === "completed" ? "就绪" : output.state);
          await refreshStatus();
          return true;
        }
      }

      const fallback = await fallbackRef.current?.(text);
      appendAssistant(
        fallback ??
          "Agent 尚未配置模型；你可以先在这里管理本地任务，配置模型后即可直接对话。",
      );
      return true;
    } catch (reason) {
      const errorText = agentErrorTextForUser(reason);
      const stream = startedStream ?? activeStreamRef.current;
      if (stream) {
        setMessages((current) =>
          current.map((message) =>
            message.id === stream.messageId
              ? {
                  ...message,
                  text: visibleAssistantText(message.text)
                    ? `${visibleAssistantText(message.text)}\n\n_生成失败：${errorText}_`
                    : errorText,
                  streaming: false,
                }
              : message,
          ),
        );
      } else {
        appendAssistant(errorText);
      }
      setRunState("错误");
      return false;
    } finally {
      if (
        !startedStream ||
        activeStreamRef.current?.runId === startedStream.runId
      ) {
        activeStreamRef.current = undefined;
        setActiveRunId(undefined);
      }
      setApproval(undefined);
      sendingRef.current = false;
      setIsSending(false);
    }
  }, [appendAssistant, input, refreshFeishuSyncReceipts, refreshStatus]);

  const respondToApproval = useCallback(
    async (choice: ApprovalChoice): Promise<boolean> => {
      if (!window.desktopApi || !approval) return false;
      const accepted = await window.desktopApi.agent.respondToApproval({
        approvalId: approval.approvalId,
        choice,
      });
      if (accepted) {
        setApproval(undefined);
        setRunState(choice === "deny" ? "已拒绝，继续处理" : "执行工具");
      }
      return accepted;
    },
    [approval],
  );

  const stop = useCallback(async (): Promise<number> => {
    const runId = activeStreamRef.current?.runId;
    if (!window.desktopApi || !runId) return 0;
    setRunState("正在停止");
    return window.desktopApi.agent.stop(runId);
  }, []);

  return {
    messages,
    input,
    setInput,
    isSending,
    runState,
    agentStatus,
    approval,
    activeRunId,
    send,
    stop,
    respondToApproval,
    appendAssistant,
    refreshStatus,
    conversationId: conversationIdRef.current,
    conversationSessions,
    hasStoredConversation,
    newConversation,
    clearConversation,
    switchConversation,
    removeConversation,
    renameConversation,
    toggleConversationPinned,
    exportConversation,
  };
}
