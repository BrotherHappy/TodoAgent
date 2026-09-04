import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskTools } from "../electron/agent/task-tools";
import type { ToolExecutionContext } from "../electron/agent/tool-registry";
import { LocalStore } from "../electron/services/local-store";
import { TaskService } from "../electron/services/task-service";
import type { ExecutionGrant, ToolInvocation } from "../src/shared/agent-types";
import { defaultSettings, type ModelDataScope } from "../src/shared/settings";

const contextFor = (toolName: string): ToolExecutionContext => ({
  runId: "scope-run",
  invocation: {
    invocationId: `scope-${toolName}`,
    runId: "scope-run",
    providerCallId: `scope-${toolName}-call`,
    toolName,
    toolVersion: 1,
    arguments: {},
    argumentsHash: "scope-hash",
    createdAt: new Date().toISOString(),
  } as ToolInvocation,
  grant: { grantId: "scope-grant" } as ExecutionGrant,
  signal: new AbortController().signal,
});

describe("Agent task model-data boundary", () => {
  let directory: string;
  let tasks: TaskService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "todo-agent-data-scope-"));
    tasks = new TaskService(new LocalStore(directory));
    await tasks.initialize();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns only an opaque task ID when task titles and times are not authorized", async () => {
    const task = (
      await tasks.createTask({
        title: "secret-title-8d39",
        notes: "secret-notes-17ab",
        source: {
          type: "feishu",
          accountId: "secret-feishu-account",
          externalId: "secret-external-id",
        },
        priority: "urgent",
        tags: ["secret-tag-62fc"],
        plannedDate: "2026-08-10",
        dueAt: "2026-08-10T09:30:00+08:00",
        attachments: [
          {
            id: "attachment-private",
            name: "secret-attachment-name.pdf",
            url: "https://example.com/secret-attachment-url",
          },
        ],
        sync: { status: "failed", error: "secret-sync-error" },
      })
    ).task;
    const scope: ModelDataScope = {
      ...defaultSettings.modelDataScope,
      taskTitlesAndTimes: false,
      notes: true,
      feishuContent: true,
      attachmentText: true,
    };
    const taskGet = createTaskTools({
      tasks,
      getModelDataScope: () => scope,
    }).find((tool) => tool.name === "task_get")!;

    const output = await taskGet.execute(
      { id: task.id },
      contextFor("task_get"),
    );

    expect(output.data).toEqual({ id: task.id, redacted: true });
    const serialized = JSON.stringify(output.data);
    for (const forbidden of [
      "secret-title-8d39",
      "secret-notes-17ab",
      "urgent",
      "feishu",
      "secret-tag-62fc",
      "failed",
      "2026-08-10",
      "secret-attachment-name.pdf",
      "secret-attachment-url",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("never returns attachment metadata or text, regardless of the attachmentText toggle", async () => {
    const task = (
      await tasks.createTask({
        title: "Attachment boundary task",
        source: { type: "local" },
        attachments: [
          {
            id: "attachment-private",
            name: "private-source-document.txt",
            localPath: "/private/path/source-document.txt",
            url: "https://example.com/private-source-document",
          },
        ],
      })
    ).task;
    const readWith = async (attachmentText: boolean) => {
      const scope: ModelDataScope = {
        ...defaultSettings.modelDataScope,
        attachmentText,
      };
      const taskGet = createTaskTools({
        tasks,
        getModelDataScope: () => scope,
      }).find((tool) => tool.name === "task_get")!;
      return (await taskGet.execute({ id: task.id }, contextFor("task_get")))
        .data;
    };

    const disabled = await readWith(false);
    const enabled = await readWith(true);

    expect(enabled).toEqual(disabled);
    const serialized = JSON.stringify(enabled);
    expect(serialized).not.toContain("attachments");
    expect(serialized).not.toContain("private-source-document");
    expect(serialized).not.toContain("/private/path");
  });

  it("gates local discussion bodies behind the existing notes scope", async () => {
    const task = (
      await tasks.createTask({
        title: "讨论范围任务",
        comments: [{
          id: "comment-scope",
          body: "discussion-secret-42",
          author: "user",
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
        }],
      })
    ).task;
    const read = async (notes: boolean) => {
      const scope: ModelDataScope = {
        ...defaultSettings.modelDataScope,
        notes,
      };
      const tool = createTaskTools({
        tasks,
        getModelDataScope: () => scope,
      }).find((candidate) => candidate.name === "task_get")!;
      return (await tool.execute({ id: task.id }, contextFor("task_get-comments"))).data;
    };

    const hidden = JSON.stringify(await read(false));
    expect(hidden).not.toContain("discussion-secret-42");
    expect(await read(true)).toMatchObject({
      comments: [{ body: "discussion-secret-42", author: "user" }],
    });
  });
});
