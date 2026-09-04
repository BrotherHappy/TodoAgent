import { describe, expect, it } from "vitest";
import type { Task, TaskList, TaskProject } from "../src/shared/models";
import { searchGlobalWorkspace } from "../src/shared/global-search";
import type { CalendarEvent } from "../src/shared/calendar-events";

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  source: { type: "local" },
  title: id,
  notes: "",
  privateNotes: "",
  status: "open",
  priority: "none",
  tags: [],
  dependencyIds: [],
  assigneeIds: [],
  followerIds: [],
  attachments: [],
  links: [],
  customFields: {},
  reminders: [],
  focusElapsedSeconds: 0,
  privateOrder: 0,
  sync: { status: "local" },
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
  ...patch,
});

const project = (id: string, name: string): TaskProject => ({
  id,
  name,
  color: "violet",
  archived: false,
  privateOrder: 0,
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
});

const list = (id: string, name: string): TaskList => ({
  id,
  name,
  color: "blue",
  archived: false,
  privateOrder: 0,
  createdAt: "2026-08-21T08:00:00.000Z",
  updatedAt: "2026-08-21T08:00:00.000Z",
});

const calendarEvent: CalendarEvent = {
  id: "calendar-1",
  summary: "产品同步会",
  description: "讨论发布窗口和行动项",
  startAt: "2026-08-22T10:00:00+08:00",
  endAt: "2026-08-22T11:00:00+08:00",
  allDay: false,
  sourceName: "工作日历",
};

describe("global workspace search", () => {
  it("ranks an exact task title ahead of metadata matches", () => {
    const results = searchGlobalWorkspace({
      tasks: [
        task("metadata", { title: "周报", notes: "下周重构搜索入口" }),
        task("exact", { title: "重构搜索入口" }),
      ],
      projects: [],
      lists: [],
      query: "重构搜索入口",
    });
    expect(results[0]?.id).toBe("exact");
    expect(results[0]?.kind).toBe("task");
  });

  it("searches private notes, comments, research cards and custom fields", () => {
    const results = searchGlobalWorkspace({
      tasks: [
        task("private", { privateNotes: "等待架构师评审" }),
        task("comment", { comments: [{
          id: "comment-1",
          body: "请在周五前完成接口评审",
          author: "user",
          createdAt: "2026-08-21T08:00:00.000Z",
          updatedAt: "2026-08-21T08:00:00.000Z",
        }] }),
        task("research", { researchCards: [{
          id: "card-1",
          title: "可重构计算资料",
          summary: "整理 FPGA 的可重构架构",
          actionItems: ["补齐评审清单"],
          capturedAt: "2026-08-21T08:00:00.000Z",
        }] }),
        task("custom", { customFields: { owner: "平台组", milestone: "评审" } }),
      ],
      projects: [],
      lists: [],
      query: "评审",
      limit: 10,
    });
    expect(results.map((result) => result.id)).toEqual(
      expect.arrayContaining(["private", "comment", "research", "custom"]),
    );
    expect(results[0]?.snippet).toContain("评审");
  });

  it("returns project, list and Agent conversation results", () => {
    const results = searchGlobalWorkspace({
      tasks: [task("task-1", { projectId: "project-1", listId: "list-1" })],
      projects: [project("project-1", "客户端重构")],
      lists: [list("list-1", "本周评审")],
      conversations: [{
        id: "conversation-1",
        title: "早间规划",
        updatedAt: "2026-08-21T09:00:00.000Z",
        messages: ["帮我安排本周评审"],
      }],
      query: "评审",
    });
    expect(results.map((result) => result.kind)).toEqual(
      expect.arrayContaining(["list", "conversation"]),
    );
    expect(results.find((result) => result.kind === "list")?.title).toBe("本周评审");
    expect(results.find((result) => result.kind === "conversation")?.conversationId).toBe("conversation-1");
  });

  it("searches local calendar events and keeps the event for navigation", () => {
    const results = searchGlobalWorkspace({
      tasks: [],
      projects: [],
      lists: [],
      calendarEvents: [calendarEvent],
      query: "发布窗口",
    });
    expect(results[0]?.kind).toBe("calendar");
    expect(results[0]?.calendarEvent).toEqual(calendarEvent);
    expect(results[0]?.subtitle).toContain("工作日历");
  });

  it("requires every query token, is case-insensitive and respects the limit", () => {
    const results = searchGlobalWorkspace({
      tasks: [
        task("one", { title: "Release Checklist" }),
        task("two", { title: "Release Notes" }),
        task("three", { title: "Checklist" }),
      ],
      projects: [],
      lists: [],
      query: "release CHECKLIST",
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("one");
    expect(searchGlobalWorkspace({ tasks: [], projects: [], lists: [], query: "   " })).toEqual([]);
  });
});
