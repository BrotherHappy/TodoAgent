import type { AgentFeishuSyncReceipt } from "../shared/desktop-api";

const DEFAULT_STORAGE_KEY = "todo-agent:agent-conversation:v1";
const DEFAULT_SESSIONS_STORAGE_KEY = "todo-agent:agent-conversations:v1";
const SCHEMA_VERSION = 1;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 30_000;
const MAX_TOTAL_LENGTH = 240_000;
const MAX_SESSIONS = 8;
const MAX_COLLECTION_LENGTH = 2_000_000;

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
  /** Optional local label; never sent to the model or exported as task data. */
  title?: string;
  /** Local pin marker used to keep important sessions at the top. */
  pinnedAt?: string;
  messages: StoredAgentMessage[];
}

export interface StoredAgentConversationCollection {
  schemaVersion: 1;
  activeConversationId?: string;
  conversations: StoredAgentConversation[];
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

const safeConversationTitle = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\0\r\n]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80);
  return sanitized || undefined;
};

const safePinnedAt = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
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

const parseConversation = (value: unknown): StoredAgentConversation | undefined => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !isUuid(value.conversationId) ||
    !Array.isArray(value.messages)
  ) return undefined;
  const messages = value.messages
    .slice(-MAX_MESSAGES)
    .map(parseMessage)
    .filter((message): message is StoredAgentMessage => message !== undefined);
  if (messages.length === 0) return undefined;
  const totalLength = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (totalLength > MAX_TOTAL_LENGTH) return undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    conversationId: value.conversationId,
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date(0).toISOString(),
    title: safeConversationTitle(value.title),
    pinnedAt: safePinnedAt(value.pinnedAt),
    messages,
  };
};

export function readStoredAgentConversation(
  storageKey = DEFAULT_STORAGE_KEY,
): StoredAgentConversation | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > MAX_TOTAL_LENGTH * 2) return undefined;
    return parseConversation(JSON.parse(raw));
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
      title: safeConversationTitle(conversation.title),
      pinnedAt: safePinnedAt(conversation.pinnedAt),
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

const sortConversations = (
  conversations: readonly StoredAgentConversation[],
): StoredAgentConversation[] =>
  [...conversations]
    .sort((left, right) => {
      const leftPinned = left.pinnedAt ? 1 : 0;
      const rightPinned = right.pinnedAt ? 1 : 0;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      if (left.pinnedAt && right.pinnedAt && left.pinnedAt !== right.pinnedAt) {
        return right.pinnedAt.localeCompare(left.pinnedAt);
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, MAX_SESSIONS);

export function conversationTitle(
  conversation: Pick<StoredAgentConversation, "messages"> & { title?: string },
): string {
  const customTitle = safeConversationTitle(conversation.title);
  if (customTitle) return customTitle;
  const firstUserMessage = conversation.messages.find((message) => message.role === "user");
  const source = firstUserMessage?.text ?? conversation.messages[0]?.text ?? "新对话";
  const title = source.replace(/\s+/gu, " ").trim().slice(0, 56);
  return title || "新对话";
}

export function filterStoredAgentConversations(
  conversations: readonly StoredAgentConversation[],
  query: string,
): StoredAgentConversation[] {
  const normalizedQuery = query.replace(/\0/gu, "").trim().slice(0, 200).toLocaleLowerCase();
  if (!normalizedQuery) return [...conversations];
  return conversations.filter((conversation) => {
    const haystack = [
      conversationTitle(conversation),
      ...conversation.messages.map((message) => message.text),
    ]
      .join("\n")
      .toLocaleLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function readStoredAgentConversationCollection(
  storageKey = DEFAULT_SESSIONS_STORAGE_KEY,
  legacyStorageKey = DEFAULT_STORAGE_KEY,
): StoredAgentConversationCollection {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw && raw.length <= MAX_COLLECTION_LENGTH) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.conversations)) {
        const conversations = sortConversations(
          parsed.conversations
            .map(parseConversation)
            .filter((conversation): conversation is StoredAgentConversation => conversation !== undefined),
        );
        const activeConversationId =
          typeof parsed.activeConversationId === "string" && isUuid(parsed.activeConversationId)
            ? parsed.activeConversationId
            : undefined;
        return { schemaVersion: SCHEMA_VERSION, activeConversationId, conversations };
      }
    }
  } catch {
    // Fall through to the pre-v1.81 single-session key.
  }
  const legacy = readStoredAgentConversation(legacyStorageKey);
  return {
    schemaVersion: SCHEMA_VERSION,
    activeConversationId: legacy?.conversationId,
    conversations: legacy ? [legacy] : [],
  };
}

export function writeStoredAgentConversationCollection(
  collection: StoredAgentConversationCollection,
  storageKey = DEFAULT_SESSIONS_STORAGE_KEY,
): boolean {
  try {
    const conversations = sortConversations(
      collection.conversations
        .map((conversation) => parseConversation(conversation))
        .filter((conversation): conversation is StoredAgentConversation => conversation !== undefined),
    );
    const activeConversationId =
      collection.activeConversationId && isUuid(collection.activeConversationId)
        ? collection.activeConversationId
        : undefined;
    const serialized = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      activeConversationId,
      conversations,
    });
    if (serialized.length > MAX_COLLECTION_LENGTH) return false;
    localStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}

export function upsertStoredAgentConversation(
  conversation: StoredAgentConversation,
  activeConversationId = conversation.conversationId,
  storageKey = DEFAULT_SESSIONS_STORAGE_KEY,
  legacyStorageKey = DEFAULT_STORAGE_KEY,
): boolean {
  const current = readStoredAgentConversationCollection(storageKey, legacyStorageKey);
  const existing = current.conversations.find(
    (item) => item.conversationId === conversation.conversationId,
  );
  const mergedConversation: StoredAgentConversation = {
    ...conversation,
    title: conversation.title ?? existing?.title,
    pinnedAt: conversation.pinnedAt ?? existing?.pinnedAt,
  };
  const conversations = [
    mergedConversation,
    ...current.conversations.filter((item) => item.conversationId !== conversation.conversationId),
  ];
  return writeStoredAgentConversationCollection(
    { schemaVersion: SCHEMA_VERSION, activeConversationId, conversations },
    storageKey,
  );
}

export function updateStoredAgentConversationMetadata(
  conversationId: string,
  patch: { title?: string; pinned?: boolean },
  storageKey = DEFAULT_SESSIONS_STORAGE_KEY,
  legacyStorageKey = DEFAULT_STORAGE_KEY,
): boolean {
  const collection = readStoredAgentConversationCollection(storageKey, legacyStorageKey);
  const target = collection.conversations.find((item) => item.conversationId === conversationId);
  if (!target) return false;
  const title = patch.title === undefined ? target.title : safeConversationTitle(patch.title);
  const pinnedAt =
    patch.pinned === undefined
      ? target.pinnedAt
      : patch.pinned
        ? target.pinnedAt ?? new Date().toISOString()
        : undefined;
  return writeStoredAgentConversationCollection(
    {
      ...collection,
      conversations: collection.conversations.map((conversation) =>
        conversation.conversationId === conversationId
          ? { ...conversation, title, pinnedAt }
          : conversation,
      ),
    },
    storageKey,
  );
}

export function removeStoredAgentConversation(
  conversationId: string,
  activeConversationId: string | undefined,
  storageKey = DEFAULT_SESSIONS_STORAGE_KEY,
  legacyStorageKey = DEFAULT_STORAGE_KEY,
): boolean {
  const current = readStoredAgentConversationCollection(storageKey, legacyStorageKey);
  return writeStoredAgentConversationCollection(
    {
      schemaVersion: SCHEMA_VERSION,
      activeConversationId,
      conversations: current.conversations.filter((item) => item.conversationId !== conversationId),
    },
    storageKey,
  );
}

export const AGENT_CONVERSATIONS_STORAGE_KEY = DEFAULT_SESSIONS_STORAGE_KEY;
export const AGENT_CONVERSATION_LIMITS = {
  maxMessages: MAX_MESSAGES,
  maxMessageLength: MAX_MESSAGE_LENGTH,
  maxSessions: MAX_SESSIONS,
};

export function agentConversationMarkdown(
  conversation: StoredAgentConversation,
): string {
  const lines = [
    "# Todo Agent 对话",
    "",
    `- 标题：${conversationTitle(conversation)}`,
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
