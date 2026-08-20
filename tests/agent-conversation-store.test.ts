import { afterEach, describe, expect, it } from "vitest";
import {
  agentConversationMarkdown,
  clearStoredAgentConversation,
  readStoredAgentConversation,
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
});
