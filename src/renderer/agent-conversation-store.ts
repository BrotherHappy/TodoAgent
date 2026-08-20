import type { AgentFeishuSyncReceipt } from "../shared/desktop-api";

const DEFAULT_STORAGE_KEY = "todo-agent:agent-conversation:v1";
const SCHEMA_VERSION = 1;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 30_000;
const MAX_TOTAL_LENGTH = 240_000;

export interface StoredAgentMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  feishuSyncReceipts?: AgentFeishuSyncReceipt[];
  syncBaseText?: string;
}

export interface StoredAgentConversation {
  schemaVersion: 1;
  conversationId: string;
  updatedAt: string;
  messages: StoredAgentMessage[];
}

const syncActions = new Set<AgentFeishuSyncReceipt["action"]>([
  "created",
  "updated",
  "completed",
  "reopened",
  "deleted",
  "restored",
]);
const syncStatuses = new Set<AgentFeishuSyncReceipt["status"]>([
  "local",
  "pending",
  "syncing",
  "synced",
  "offline",
  "failed",
  "conflict",
  "read-only",
  "permission-denied",
  "remote-deleted",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

const safeText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/\0/gu, "");
  if (sanitized.length === 0 || sanitized.length > MAX_MESSAGE_LENGTH) return undefined;
  return sanitized;
};

const parseReceipt = (value: unknown): AgentFeishuSyncReceipt | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.taskId !== "string" ||
    !syncActions.has(value.action as AgentFeishuSyncReceipt["action"]) ||
    !syncStatuses.has(value.status as AgentFeishuSyncReceipt["status"])
  ) return undefined;
  return {
    taskId: value.taskId,
    action: value.action as AgentFeishuSyncReceipt["action"],
    status: value.status as AgentFeishuSyncReceipt["status"],
  };
};

const parseMessage = (value: unknown): StoredAgentMessage | undefined => {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) {
    return undefined;
  }
  const text = safeText(value.text);
  if (!text) return undefined;
  const message: StoredAgentMessage = { role: value.role, text };
  if (typeof value.id === "string" && value.id.length <= 160) message.id = value.id;
  if (typeof value.syncBaseText === "string" && value.syncBaseText.length <= MAX_MESSAGE_LENGTH) {
    message.syncBaseText = value.syncBaseText.replace(/\0/gu, "");
  }
  if (Array.isArray(value.feishuSyncReceipts)) {
    const receipts = value.feishuSyncReceipts
      .slice(0, 50)
      .map(parseReceipt)
      .filter((receipt): receipt is AgentFeishuSyncReceipt => receipt !== undefined);
    if (receipts.length > 0) message.feishuSyncReceipts = receipts;
  }
  return message;
};

export function readStoredAgentConversation(
  storageKey = DEFAULT_STORAGE_KEY,
): StoredAgentConversation | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > MAX_TOTAL_LENGTH * 2) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      !isUuid(parsed.conversationId) ||
      !Array.isArray(parsed.messages)
    ) return undefined;
    const messages = parsed.messages
      .slice(-MAX_MESSAGES)
      .map(parseMessage)
      .filter((message): message is StoredAgentMessage => message !== undefined);
    if (messages.length === 0) return undefined;
    const totalLength = messages.reduce((sum, message) => sum + message.text.length, 0);
    if (totalLength > MAX_TOTAL_LENGTH) return undefined;
    return {
      schemaVersion: SCHEMA_VERSION,
      conversationId: parsed.conversationId,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      messages,
    };
  } catch {
    return undefined;
  }
}

export function writeStoredAgentConversation(
  conversation: StoredAgentConversation,
  storageKey = DEFAULT_STORAGE_KEY,
): boolean {
  try {
    const messages = conversation.messages
      .filter((message) => safeText(message.text) !== undefined)
      .slice(-MAX_MESSAGES)
      .map((message) => ({
        ...message,
        text: message.text.replace(/\0/gu, "").slice(0, MAX_MESSAGE_LENGTH),
      }));
    const totalLength = messages.reduce((sum, message) => sum + message.text.length, 0);
    if (!isUuid(conversation.conversationId) || messages.length === 0 || totalLength > MAX_TOTAL_LENGTH) {
      return false;
    }
    localStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      conversationId: conversation.conversationId,
      updatedAt: conversation.updatedAt,
      messages,
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredAgentConversation(storageKey = DEFAULT_STORAGE_KEY): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // A locked storage area must not prevent the Agent from continuing in memory.
  }
}

export function agentConversationMarkdown(
  conversation: StoredAgentConversation,
): string {
  const lines = [
    "# Todo Agent 对话",
    "",
    `- 会话：${conversation.conversationId}`,
    `- 更新时间：${conversation.updatedAt}`,
    "- 范围：仅本机导出；不会包含 API Key、飞书 Token 或本地文件路径。",
    "",
  ];
  for (const message of conversation.messages) {
    lines.push(message.role === "user" ? "## 我" : "## Todo Agent", "", message.text, "");
  }
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

export const AGENT_CONVERSATION_STORAGE_KEY = DEFAULT_STORAGE_KEY;
export const AGENT_CONVERSATION_LIMITS = {
  maxMessages: MAX_MESSAGES,
  maxMessageLength: MAX_MESSAGE_LENGTH,
};
