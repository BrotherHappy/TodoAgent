import { afterEach, describe, expect, it } from "vitest";
import {
  agentConversationMarkdown,
  AGENT_CONVERSATIONS_STORAGE_KEY,
  clearStoredAgentConversation,
  conversationTitle,
  filterStoredAgentConversations,
  readStoredAgentConversationCollection,
  readStoredAgentConversation,
  updateStoredAgentConversationMetadata,
  upsertStoredAgentConversation,
  writeStoredAgentConversationCollection,
  writeStoredAgentConversation,
} from "../src/renderer/agent-conversation-store";

const conversationId = "123e4567-e89b-12d3-a456-426614174000";

afterEach(() => {
  window.localStorage.clear();
});

describe("agent conversation store", () => {
  it("round-trips a bounded local session and keeps trusted Feishu receipts", () => {
    expect(
      writeStoredAgentConversation({
        schemaVersion: 1,
        conversationId,
        updatedAt: "2026-08-21T08:00:00.000Z",
        messages: [
          { role: "assistant", text: "你好" },
          {
            role: "user",
            text: "完成飞书任务",
          },
          {
            role: "assistant",
            text: "已提交同步",
            syncBaseText: "已提交同步",
            feishuSyncReceipts: [
              { taskId: "task-1", action: "completed", status: "pending" },
            ],
          },
        ],
      }),
    ).toBe(true);

    expect(readStoredAgentConversation()).toEqual({
      schemaVersion: 1,
      conversationId,
      updatedAt: "2026-08-21T08:00:00.000Z",
      messages: [
        { role: "assistant", text: "你好" },
        { role: "user", text: "完成飞书任务" },
        {
          role: "assistant",
          text: "已提交同步",
          syncBaseText: "已提交同步",
          feishuSyncReceipts: [
            { taskId: "task-1", action: "completed", status: "pending" },
          ],
        },
      ],
    });
  });

  it("rejects malformed or oversized sessions instead of restoring arbitrary data", () => {
    window.localStorage.setItem(
      "todo-agent:agent-conversation:v1",
      JSON.stringify({
        schemaVersion: 1,
        conversationId: "not-a-uuid",
        messages: [
          { role: "assistant", text: "正常" },
          { role: "system", text: "不应恢复" },
          { role: "user", text: "\u0000" },
        ],
      }),
    );
    expect(readStoredAgentConversation()).toBeUndefined();

    expect(
      writeStoredAgentConversation({
        schemaVersion: 1,
        conversationId,
        updatedAt: new Date().toISOString(),
        messages: [{ role: "assistant", text: "x".repeat(240_001) }],
      }),
    ).toBe(false);
  });

  it("exports a readable Markdown transcript and can clear the local copy", () => {
    const conversation = {
      schemaVersion: 1 as const,
      conversationId,
      updatedAt: "2026-08-21T08:00:00.000Z",
      messages: [
        { role: "assistant" as const, text: "欢迎回来" },
        { role: "user" as const, text: "列出今天的任务" },
      ],
    };
    expect(writeStoredAgentConversation(conversation)).toBe(true);
    const markdown = agentConversationMarkdown(conversation);
    expect(markdown).toContain("# Todo Agent 对话");
    expect(markdown).toContain("## 我\n\n列出今天的任务");
    expect(markdown).not.toContain("api-key");
    clearStoredAgentConversation();
    expect(readStoredAgentConversation()).toBeUndefined();
  });

  it("keeps a bounded local session archive and honors the active session", () => {
    const older = {
      schemaVersion: 1 as const,
      conversationId,
      updatedAt: "2026-08-21T08:00:00.000Z",
      messages: [
        { role: "assistant" as const, text: "你好" },
        { role: "user" as const, text: "旧会话" },
      ],
    };
    const newer = {
      ...older,
      conversationId: "123e4567-e89b-12d3-a456-426614174001",
      updatedAt: "2026-08-21T09:00:00.000Z",
      messages: [
        { role: "assistant" as const, text: "你好" },
        { role: "user" as const, text: "新会话" },
      ],
    };
    expect(
      writeStoredAgentConversationCollection({
        schemaVersion: 1,
        activeConversationId: older.conversationId,
        conversations: [older, newer],
      }),
    ).toBe(true);
    expect(readStoredAgentConversationCollection().activeConversationId).toBe(
      older.conversationId,
    );
    expect(readStoredAgentConversationCollection().conversations.map(conversationTitle)).toEqual([
      "新会话",
      "旧会话",
    ]);
    expect(window.localStorage.getItem(AGENT_CONVERSATIONS_STORAGE_KEY)).not.toBeNull();
  });

  it("limits the archive to eight valid sessions", () => {
    const conversations = Array.from({ length: 12 }, (_, index) => ({
      schemaVersion: 1 as const,
      conversationId: `123e4567-e89b-12d3-a456-4266141740${String(index).padStart(2, "0")}`,
      updatedAt: `2026-08-21T${String(index).padStart(2, "0")}:00:00.000Z`,
      messages: [{ role: "user" as const, text: `会话 ${index}` }],
    }));
    expect(
      writeStoredAgentConversationCollection({ schemaVersion: 1, conversations }),
    ).toBe(true);
    expect(readStoredAgentConversationCollection().conversations).toHaveLength(8);
  });

  it("searches session titles and message text locally", () => {
    const sessions = [
      {
        schemaVersion: 1 as const,
        conversationId,
        updatedAt: "2026-08-21T08:00:00.000Z",
        messages: [{ role: "user" as const, text: "整理飞书项目" }],
      },
      {
        schemaVersion: 1 as const,
        conversationId: "123e4567-e89b-12d3-a456-426614174001",
        updatedAt: "2026-08-21T09:00:00.000Z",
        messages: [{ role: "user" as const, text: "写一个发布说明" }],
      },
    ];
    expect(filterStoredAgentConversations(sessions, "飞书")).toHaveLength(1);
    expect(filterStoredAgentConversations(sessions, "发布说明")[0]?.conversationId).toBe(
      sessions[1].conversationId,
    );
    expect(filterStoredAgentConversations(sessions, "  ")).toHaveLength(2);
  });

  it("keeps local session titles and pinned sessions stable across message updates", () => {
    const sessions = [
      {
        schemaVersion: 1 as const,
        conversationId,
        updatedAt: "2026-08-21T08:00:00.000Z",
        messages: [{ role: "user" as const, text: "整理飞书项目" }],
      },
      {
        schemaVersion: 1 as const,
        conversationId: "123e4567-e89b-12d3-a456-426614174001",
        updatedAt: "2026-08-21T09:00:00.000Z",
        messages: [{ role: "user" as const, text: "写发布说明" }],
      },
    ];
    expect(writeStoredAgentConversationCollection({ schemaVersion: 1, conversations: sessions })).toBe(true);
    expect(updateStoredAgentConversationMetadata(conversationId, { title: "本周发布" })).toBe(true);
    expect(updateStoredAgentConversationMetadata(conversationId, { pinned: true })).toBe(true);
    expect(readStoredAgentConversationCollection().conversations[0]).toMatchObject({
      conversationId,
      title: "本周发布",
      pinnedAt: expect.any(String),
    });
    expect(upsertStoredAgentConversation({
      schemaVersion: 1,
      conversationId,
      updatedAt: "2026-08-21T10:00:00.000Z",
      messages: [{ role: "user", text: "追加一个发布检查" }],
    })).toBe(true);
    expect(readStoredAgentConversationCollection().conversations[0]).toMatchObject({
      conversationId,
      title: "本周发布",
      pinnedAt: expect.any(String),
    });
  });
});
