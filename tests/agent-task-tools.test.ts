import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskTools } from "../electron/agent/task-tools";
import { PermissionEngine } from "../electron/agent/permission-engine";
import { ToolRegistry } from "../electron/agent/tool-registry";
import { LocalStore } from "../electron/services/local-store";
import { TaskService } from "../electron/services/task-service";
import type { ToolExecutionContext } from "../electron/agent/tool-registry";
import type { ExecutionGrant, ToolInvocation } from "../src/shared/agent-types";
import { defaultSettings } from "../src/shared/settings";

const executionContext = (
  toolName: string,
  signal: AbortSignal = new AbortController().signal,
): ToolExecutionContext => ({
  runId: "run",
  invocation: {
    invocationId: `inv-${toolName}`,
    runId: "run",
    providerCallId: `call-${toolName}`,
    toolName,
    toolVersion: 1,
    arguments: {},
    argumentsHash: "hash",
    createdAt: new Date().toISOString(),
  } as ToolInvocation,
  grant: { grantId: "grant" } as ExecutionGrant,
  signal,
});

describe("task Agent tools", () => {
  let directory: string;
  let tasks: TaskService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "todo-agent-task-tools-"));
    tasks = new TaskService(new LocalStore(directory));
    await tasks.initialize();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("isolates Feishu tasks when the Feishu capability is disabled", async () => {
    const localTask = (
      await tasks.createTask({
        title: "本地任务",
        source: { type: "local" },
        sync: { status: "local" },
      })
    ).task;
    const feishuTask = (
      await tasks.createTask({
        title: "飞书任务",
        source: { type: "feishu", accountId: "primary" },
        sync: { status: "synced" },
      })
    ).task;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      getAgentCapabilities: () => ({
        ...defaultSettings.agentCapabilities,
        feishuSync: false,
      }),
    });
    const get = tools.find((tool) => tool.name === "task_get")!;
    await expect(
      get.execute({ id: feishuTask.id }, executionContext("task_get")),
    ).rejects.toThrow("AGENT_FEISHU_CAPABILITY_DISABLED");
    await expect(
      get.execute({ id: localTask.id }, executionContext("task_get")),
    ).resolves.toMatchObject({ status: "ok" });

    const create = tools.find((tool) => tool.name === "task_create")!;
    expect(() =>
      create.analyze(
        {
          title: "远端任务",
          notes: "",
          source: "feishu",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "none",
          tags: [],
          contexts: [],
        },
        { runId: "run" },
      ),
    ).toThrow("AGENT_FEISHU_CAPABILITY_DISABLED");
  });

  it("classifies private Feishu planning as local and remote fields as external", async () => {
    const task = (
      await tasks.createTask({
        title: "飞书任务",
        source: { type: "feishu" },
        sync: { status: "synced" },
      })
    ).task;
    const update = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    }).find((tool) => tool.name === "task_update")!;
    const signal = new AbortController().signal;
    const privateEffects = await update.analyze(
      {
        id: task.id,
        title: null,
        notes: null,
        privateNotes: null,
        plannedDate: "2026-08-10",
        dueAt: null,
        priority: null,
        tags: null,
        contexts: null,
        clearFields: [],
      },
      { runId: "run", signal },
    );
    const remoteEffects = await update.analyze(
      {
        id: task.id,
        title: "新标题",
        notes: null,
        privateNotes: null,
        plannedDate: null,
        dueAt: null,
        priority: null,
        tags: null,
        contexts: null,
        clearFields: [],
      },
      { runId: "run", signal },
    );
    expect(privateEffects.risk).toBe("R1");
    expect(privateEffects.network).toEqual([]);
    expect(remoteEffects.risk).toBe("R2");
    expect(remoteEffects.network).toContain("Feishu Task v2 on next sync");
    expect(remoteEffects.preview).toMatchObject({
      action: "update-task",
      changes: [{ field: "title", before: "飞书任务", after: "新标题" }],
    });
  });

  it("fails closed when an Agent remote write targets a task from another Feishu account", async () => {
    const task = (
      await tasks.createTask({
        title: "跨账号飞书任务",
        source: {
          type: "feishu",
          accountId: "account-a",
          externalId: "remote-account-a",
        },
        sync: { status: "synced" },
      })
    ).task;
    const update = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      getFeishuAccountId: () => "account-b",
    }).find((tool) => tool.name === "task_update")!;
    const args = {
      id: task.id,
      title: "不应写入",
      notes: null,
      privateNotes: null,
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: null,
      dueAt: null,
      priority: null,
      tags: null,
      contexts: null,
      clearFields: [],
    };

    await expect(
      update.analyze(args, {
        runId: "cross-account",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "AGENT_FEISHU_ACCOUNT_MISMATCH" });
    expect(await tasks.getTask(task.id)).toMatchObject({
      title: "跨账号飞书任务",
      sync: { status: "synced" },
    });
  });

  it("emits trusted Feishu receipts for bulk trash and restore", async () => {
    const task = (
      await tasks.createTask({
        title: "批量回执飞书任务",
        source: {
          type: "feishu",
          accountId: "account-primary",
          externalId: "remote-bulk-receipt",
        },
        sync: { status: "synced" },
      })
    ).task;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      getFeishuAccountId: () => "account-primary",
    });
    const moveToTrash = tools.find(
      (tool) => tool.name === "task_bulk_move_to_trash",
    )!;
    const restore = tools.find((tool) => tool.name === "task_bulk_restore")!;

    const trashed = await moveToTrash.execute(
      { taskIds: [task.id] },
      executionContext("task_bulk_move_to_trash"),
    );
    expect(trashed.data).toMatchObject({
      syncReceipts: [{ taskId: task.id, action: "deleted", status: "pending" }],
    });

    const restored = await restore.execute(
      { taskIds: [task.id] },
      executionContext("task_bulk_restore"),
    );
    expect(restored.data).toMatchObject({
      syncReceipts: [{ taskId: task.id, action: "restored", status: "pending" }],
    });
  });

  it("treats no-op mutations as reads and rejects completion by a non-assignee", async () => {
    const local = (await tasks.createTask({ title: "保持不变" })).task;
    const follower = (
      await tasks.createTask({
        title: "仅关注者",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-follower",
        },
        currentUserRole: "follower",
        sync: { status: "synced" },
      })
    ).task;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    const update = tools.find((tool) => tool.name === "task_update")!;
    const updateArgs = {
      id: local.id,
      title: local.title,
      notes: null,
      privateNotes: null,
      plannedDate: null,
      dueAt: null,
      priority: null,
      tags: null,
      contexts: null,
      clearFields: [] as Array<
        "notes" | "privateNotes" | "plannedDate" | "dueAt" | "tags"
      >,
    };
    await expect(
      update.analyze(updateArgs, {
        runId: "noop",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ risk: "R0", writes: [] });
    const noOp = await update.execute(
      updateArgs,
      executionContext("task_update"),
    );
    expect(noOp.data).toMatchObject({ changed: false, undoOperationId: null });

    const complete = tools.find(
      (tool) => tool.name === "task_set_completed",
    )!;
    await expect(
      complete.analyze(
        { id: follower.id, completed: true },
        { runId: "blocked", signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      risk: "R4",
      writes: [],
      preview: {
        permitted: false,
        blockedCode: "FEISHU_CURRENT_MEMBER_CANNOT_COMPLETE",
      },
    });
  });

  it("executes a validated local creation and returns an undo operation", async () => {
    const definition = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    }).find((tool) => tool.name === "task_create")!;
    const invocation = {
      invocationId: "inv",
      runId: "run",
      providerCallId: "call",
      toolName: "task_create",
      toolVersion: 1,
      arguments: {},
      argumentsHash: "hash",
      createdAt: new Date().toISOString(),
    } as ToolInvocation;
    const grant = { grantId: "grant" } as ExecutionGrant;
    const context = {
      runId: "run",
      invocation,
      grant,
      signal: new AbortController().signal,
    } satisfies ToolExecutionContext;
    const output = await definition.execute(
      {
        title: "由 Agent 创建",
        notes: "",
        source: "local",
        plannedDate: null,
        dueAt: null,
        priority: "medium",
        tags: [],
      },
      context,
    );
    expect(output.status).toBe("ok");
    expect(
      (output.data as { undoOperationId: string }).undoOperationId,
    ).toBeTruthy();
    expect(await tasks.listTasks({ text: "由 Agent 创建" })).toHaveLength(1);
  });

  it("creates, reads, updates, and clears start/project/list task fields", async () => {
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    const create = tools.find((tool) => tool.name === "task_create")!;
    const update = tools.find((tool) => tool.name === "task_update")!;
    const get = tools.find((tool) => tool.name === "task_get")!;
    const createArgs = {
      title: "Agent 时间与归属验收",
      notes: "",
      source: "local" as const,
      projectId: "project-agent",
      listId: "list-today",
      plannedDate: "2026-08-10",
      startAt: "2026-08-10T09:00:00+08:00",
      dueAt: "2026-08-10T10:00:00+08:00",
      priority: "high" as const,
      tags: ["agent"],
      contexts: null,
    };
    expect(create.argumentsSchema.safeParse(createArgs).success).toBe(true);
    const created = await create.execute(
      createArgs,
      executionContext("task_create-fields"),
    );
    const taskId = (created.data as { task: { id: string } }).task.id;
    const read = await get.execute(
      { id: taskId },
      executionContext("task_get-fields"),
    );
    expect(read.data).toMatchObject({
      projectId: "project-agent",
      listId: "list-today",
      startAt: "2026-08-10T09:00:00+08:00",
      dueAt: "2026-08-10T10:00:00+08:00",
    });

    const changeArgs = {
      id: taskId,
      title: null,
      notes: null,
      privateNotes: null,
      projectId: "project-updated",
      listId: "list-updated",
      plannedDate: null,
      startAt: "2026-08-10T09:15:00+08:00",
      dueAt: null,
      priority: null,
      tags: null,
      contexts: null,
      clearFields: [],
    };
    expect(update.argumentsSchema.safeParse(changeArgs).success).toBe(true);
    await update.execute(changeArgs, executionContext("task_update-fields"));
    expect(await tasks.getTask(taskId)).toMatchObject({
      projectId: "project-updated",
      listId: "list-updated",
      startAt: "2026-08-10T09:15:00+08:00",
    });

    const clearArgs = {
      id: taskId,
      title: null,
      notes: null,
      privateNotes: null,
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: null,
      dueAt: null,
      priority: null,
      tags: null,
      contexts: null,
      clearFields: ["projectId", "listId", "startAt"] as Array<
        "projectId" | "listId" | "startAt"
      >,
    };
    expect(update.argumentsSchema.safeParse(clearArgs).success).toBe(true);
    const cleared = await update.execute(
      clearArgs,
      executionContext("task_update-fields"),
    );
    expect(cleared.data).toMatchObject({ changed: true });
    const afterClear = await tasks.getTask(taskId);
    expect(afterClear?.projectId).toBeUndefined();
    expect(afterClear?.listId).toBeUndefined();
    expect(afterClear?.startAt).toBeUndefined();
    expect(afterClear?.dueAt).toBe("2026-08-10T10:00:00+08:00");
    expect(
      update.argumentsSchema.safeParse({
        ...clearArgs,
        projectId: "project-agent",
      }).success,
    ).toBe(false);
  });

  it("lets Agent attach a private research card without a Feishu write", async () => {
    const task = (await tasks.createTask({ title: "Agent 研究上下文" })).task;
    const tool = createTaskTools({
      tasks,
      getModelDataScope: () => ({
        ...defaultSettings.modelDataScope,
        notes: true,
      }),
    }).find((candidate) => candidate.name === "task_add_research_card")!;
    const args = {
      id: task.id,
      title: "官方定价页",
      url: "https://example.com/pricing",
      summary: "提炼免费版和团队版的差异",
      actionItems: ["补充席位数对比"],
    };
    expect(tool.argumentsSchema.safeParse(args).success).toBe(true);
    const analysis = await tool.analyze(args, {
      runId: "run",
      signal: new AbortController().signal,
    });
    expect(analysis).toMatchObject({
      risk: "R1",
      network: [],
      externalEffects: [],
      preview: { remoteWrite: false },
    });
    const result = await tool.execute(args, executionContext("task_add_research_card"));
    expect(result.data).toMatchObject({
      task: {
        researchCards: [{
          title: "官方定价页",
          summary: "提炼免费版和团队版的差异",
          actionItems: ["补充席位数对比"],
        }],
      },
    });
    expect((await tasks.getTask(task.id))?.sync.status).toBe("local");
  });

  it("splits a task into reviewed local subtasks without writing the Feishu parent", async () => {
    let changedEvents = 0;
    const parent = (
      await tasks.createTask({
        title: "准备发布",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-parent",
        },
        projectId: "发布项目",
        plannedDate: "2026-08-20",
        priority: "high",
        sync: { status: "synced" },
      })
    ).task;
    const tool = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      onTasksChanged: () => {
        changedEvents += 1;
      },
    }).find((candidate) => candidate.name === "task_split")!;
    const args = {
      id: parent.id,
      subtasks: [
        { title: "整理素材", notes: "", priority: "high", estimatedMinutes: 30 },
        { title: "撰写说明", notes: "", priority: "medium", estimatedMinutes: 45 },
        { title: "发布检查", notes: "", priority: "low", estimatedMinutes: null },
      ],
    };
    expect(tool.argumentsSchema.safeParse(args).success).toBe(true);
    expect(tool.argumentsSchema.safeParse({
      ...args,
      subtasks: [args.subtasks[0], args.subtasks[0]],
    }).success).toBe(false);
    await expect(tool.analyze(args, {
      runId: "split",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      risk: "R2",
      network: [],
      externalEffects: [],
      preview: { action: "split-task", count: 3, remoteWrite: false },
    });

    const result = await tool.execute(args, executionContext("task_split"));
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({
      parentTaskId: parent.id,
      createdCount: 3,
      failedCount: 0,
    });
    const children = await tasks.listTasks({ includeDeleted: false });
    const createdChildren = children.filter((task) => task.parentId === parent.id);
    expect(createdChildren).toHaveLength(3);
    expect(createdChildren.every((task) => task.source.type === "local")).toBe(true);
    expect(createdChildren.map((task) => task.plannedDate)).toEqual([
      "2026-08-20",
      "2026-08-20",
      "2026-08-20",
    ]);
    expect((await tasks.getTask(parent.id))?.sync.status).toBe("synced");
    expect(changedEvents).toBe(1);
  });

  it("treats a Feishu start-time update as a reviewed remote mutation", async () => {
    const task = (
      await tasks.createTask({
        title: "飞书开始时间",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "start-time-remote",
        },
        startAt: "2026-08-10T09:00:00+08:00",
        dueAt: "2026-08-10T10:00:00+08:00",
        sync: { status: "synced" },
      })
    ).task;
    const update = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    }).find((tool) => tool.name === "task_update")!;
    const args = {
      id: task.id,
      title: null,
      notes: null,
      privateNotes: null,
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: "2026-08-10T09:30:00+08:00",
      dueAt: null,
      priority: null,
      tags: null,
      clearFields: [],
    };
    await expect(
      update.analyze(args, {
        runId: "remote-start",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      risk: "R2",
      network: ["Feishu Task v2 on next sync"],
      externalEffects: [`update Feishu fields: startAt`],
    });
  });

  it("rejects an unavailable explicitly requested Feishu creation without an orphan or local fallback", async () => {
    const definition = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      sourcePolicy: { kind: "explicit", source: "feishu" },
    }).find((tool) => tool.name === "task_create")!;
    const args = {
      title: "孤儿飞书任务",
      notes: "",
      source: "feishu",
      plannedDate: null,
      dueAt: null,
      priority: "none",
      tags: [],
      contexts: null,
    };
    expect(() =>
      definition.analyze(args, {
        runId: "run",
        signal: new AbortController().signal,
      }),
    ).toThrow("no Feishu account is connected");

    const invocation = {
      invocationId: "inv",
      runId: "run",
      providerCallId: "call",
      toolName: "task_create",
      toolVersion: 1,
      arguments: args,
      argumentsHash: "hash",
      createdAt: new Date().toISOString(),
    } as ToolInvocation;
    const context = {
      runId: "run",
      invocation,
      grant: { grantId: "grant" } as ExecutionGrant,
      signal: new AbortController().signal,
    } satisfies ToolExecutionContext;
    await expect(definition.execute(args, context)).rejects.toMatchObject({
      code: "AGENT_FEISHU_UNAVAILABLE",
    });
    expect(
      await tasks.listTasks({ text: "孤儿飞书任务", includeDeleted: true }),
    ).toHaveLength(0);
  });

  it("creates a pending Feishu task only for the exact connected account and requires confirmation", async () => {
    let accountId: string | undefined = "account-primary";
    const definition = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      sourcePolicy: { kind: "explicit", source: "feishu" },
      getFeishuAccountId: () => accountId,
    }).find((tool) => tool.name === "task_create")!;
    const args = {
      title: "由 Agent 创建到飞书",
      notes: "",
      source: "feishu" as const,
      plannedDate: null,
      dueAt: null,
      priority: "high" as const,
      tags: ["agent"],
    };
    const effects = await definition.analyze(args, {
      runId: "run",
      signal: new AbortController().signal,
    });
    expect(effects).toMatchObject({
      risk: "R2",
      targets: [{ kind: "account", value: "account-primary" }],
      network: ["Feishu Task v2 on next sync"],
      preview: { permitted: true, accountId: "account-primary" },
    });

    const output = await definition.execute(
      args,
      executionContext("task_create"),
    );
    const created = await tasks.getTask(
      (output.data as { task: { id: string } }).task.id,
    );
    expect(created).toMatchObject({
      source: { type: "feishu", accountId: "account-primary" },
      sync: { status: "pending" },
    });
    expect(output.data).toMatchObject({
      syncReceipts: [
        { taskId: created?.id, action: "created", status: "pending" },
      ],
    });

    accountId = undefined;
    await expect(
      definition.execute(args, executionContext("task_create")),
    ).rejects.toMatchObject({ code: "AGENT_FEISHU_UNAVAILABLE" });
  });

  it("emits trusted pending receipts for Feishu updates and completion", async () => {
    const task = (
      await tasks.createTask({
        title: "飞书同步回执",
        source: {
          type: "feishu",
          accountId: "account-primary",
          externalId: "remote-receipt",
        },
        sync: { status: "synced" },
      })
    ).task;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    const update = tools.find((tool) => tool.name === "task_update")!;
    const completion = tools.find(
      (tool) => tool.name === "task_set_completed",
    )!;

    const updated = await update.execute(
      {
        id: task.id,
        title: "飞书同步回执-已更新",
        notes: null,
        privateNotes: null,
        projectId: null,
        listId: null,
        plannedDate: null,
        startAt: null,
        dueAt: null,
        priority: null,
        tags: null,
        clearFields: [],
      },
      executionContext("task_update"),
    );
    expect(updated.data).toMatchObject({
      changed: true,
      syncReceipts: [
        { taskId: task.id, action: "updated", status: "pending" },
      ],
    });

    const completed = await completion.execute(
      { id: task.id, completed: true },
      executionContext("task_set_completed"),
    );
    expect(completed.data).toMatchObject({
      changed: true,
      syncReceipts: [
        { taskId: task.id, action: "completed", status: "pending" },
      ],
    });
  });

  it("enforces trusted source policy for both single and batch creation", async () => {
    const explicitLocal = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      sourcePolicy: { kind: "explicit", source: "local" },
    });
    const single = explicitLocal.find((tool) => tool.name === "task_create")!;
    expect(() =>
      single.analyze(
        {
          title: "不应创建到飞书",
          notes: "",
          source: "feishu",
          plannedDate: null,
          dueAt: null,
          priority: "none",
          tags: [],
        },
        { runId: "source-policy", signal: new AbortController().signal },
      ),
    ).toThrow("explicitly requested a local task");

    const clarificationRequired = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      sourcePolicy: {
        kind: "clarification-required",
        reason: "conflicting-explicit-sources",
      },
    }).find((tool) => tool.name === "task_bulk_create")!;
    expect(() =>
      clarificationRequired.analyze(
        {
          tasks: [
            {
              title: "不应批量创建",
              notes: "",
              plannedDate: null,
              dueAt: null,
              priority: "none",
              tags: [],
            },
          ],
        },
        { runId: "source-policy", signal: new AbortController().signal },
      ),
    ).toThrow("conflicting or ambiguous");
    expect(
      await tasks.listTasks({ text: "不应", includeDeleted: true }),
    ).toHaveLength(0);
  });

  it("fails closed when a reviewed task version changes before execution", async () => {
    const task = (
      await tasks.createTask({
        title: "审批时标题",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "stale-remote",
        },
        sync: { status: "synced" },
      })
    ).task;
    const registry = new ToolRegistry(
      createTaskTools({
        tasks,
        getModelDataScope: () => defaultSettings.modelDataScope,
      }),
    );
    const args = {
      id: task.id,
      title: "Agent 提议标题",
      notes: null,
      privateNotes: null,
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: null,
      dueAt: null,
      priority: null,
      tags: null,
      contexts: null,
      clearFields: [],
    };
    const prepared = await registry.prepare("stale-run", {
      id: "stale-call",
      name: "task_update",
      arguments: args,
      argumentsJson: JSON.stringify(args),
    });
    const engine = new PermissionEngine();
    let decision = engine.evaluate(prepared.invocation, prepared.effects, {
      mode: "standard",
    });
    if (decision.kind !== "confirm")
      throw new Error("Expected an R2 confirmation.");
    decision = engine.resolveApproval(decision.request.approvalId, "once");
    if (decision.kind !== "allow")
      throw new Error("Expected an execution grant.");
    engine.consumeGrant(decision.grant, prepared.invocation, prepared.effects, {
      mode: "standard",
    });

    await tasks.updateTask(task.id, { title: "审批后由其他运行修改" });

    await expect(
      registry.execute(
        prepared.invocation,
        decision.grant,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "EFFECT_PLAN_CHANGED" });
    expect(await tasks.getTask(task.id)).toMatchObject({
      title: "审批后由其他运行修改",
    });
  });

  it("rejects no-op, contradictory, and duplicate bulk mutation arguments", () => {
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    const update = tools.find((tool) => tool.name === "task_update")!;
    const bulk = tools.find((tool) => tool.name === "task_bulk_plan")!;
    const base = {
      id: "task-1",
      title: null,
      notes: null,
      privateNotes: null,
      plannedDate: null,
      dueAt: null,
      priority: null,
      tags: null,
      clearFields: [],
    };

    expect(update.argumentsSchema.safeParse(base).success).toBe(false);
    expect(
      update.argumentsSchema.safeParse({
        ...base,
        notes: "new notes",
        clearFields: ["notes"],
      }).success,
    ).toBe(false);
    expect(
      bulk.argumentsSchema.safeParse({
        taskIds: ["task-1", "task-1"],
        plannedDate: "2026-08-10",
      }).success,
    ).toBe(false);
    expect(update.sensitiveArgumentPaths).toEqual(["notes", "privateNotes"]);
    expect(
      tools.find((tool) => tool.name === "task_create")?.sensitiveArgumentPaths,
    ).toEqual(["notes"]);
  });

  it("registers strict bounded batch tools and never exposes permanent deletion", () => {
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    expect(() => new ToolRegistry(tools)).not.toThrow();

    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "task_bulk_create",
        "task_bulk_update",
        "task_bulk_set_completed",
        "task_bulk_move_to_trash",
        "task_restore",
        "task_bulk_restore",
        "move_to_today",
        "set_reminder",
        "undo_task_operation",
      ]),
    );
    expect(
      names.some(
        (name) => name.includes("purge") || name.includes("permanent_delete"),
      ),
    ).toBe(false);

    const bulkCreate = tools.find((tool) => tool.name === "task_bulk_create")!;
    const validItem = {
      title: "任务",
      notes: "",
      plannedDate: null,
      dueAt: null,
      priority: "none",
      tags: [],
      contexts: null,
    };
    expect(
      bulkCreate.argumentsSchema.safeParse({
        tasks: [{ ...validItem, unknown: true }],
      }).success,
    ).toBe(false);
    expect(
      bulkCreate.argumentsSchema.safeParse({
        tasks: Array.from({ length: 26 }, () => validItem),
      }).success,
    ).toBe(false);

    const bulkComplete = tools.find(
      (tool) => tool.name === "task_bulk_set_completed",
    )!;
    expect(
      bulkComplete.argumentsSchema.safeParse({
        taskIds: Array.from({ length: 51 }, (_, index) => `task-${index}`),
        completed: true,
      }).success,
    ).toBe(false);
    expect(
      bulkComplete.argumentsSchema.safeParse({
        taskIds: ["task-1", "task-1"],
        completed: true,
      }).success,
    ).toBe(false);
    expect(
      bulkCreate.argumentsSchema.safeParse({
        tasks: [{ ...validItem, plannedDate: "2026-02-31" }],
      }).success,
    ).toBe(false);
  });

  it("classifies every batch as R2 and reports only real Feishu external fields", async () => {
    const local = (await tasks.createTask({ title: "本地" })).task;
    const feishu = (
      await tasks.createTask({
        title: "飞书",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-1",
        },
        sync: { status: "synced" },
      })
    ).task;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    const signal = new AbortController().signal;
    const update = tools.find((tool) => tool.name === "task_bulk_update")!;
    const updateEffects = await update.analyze(
      {
        updates: [
          {
            id: local.id,
            title: null,
            notes: null,
            privateNotes: null,
            plannedDate: null,
            dueAt: null,
            priority: "high",
            tags: null,
            clearFields: [],
          },
          {
            id: feishu.id,
            title: "飞书新标题",
            notes: null,
            privateNotes: null,
            plannedDate: null,
            dueAt: null,
            priority: null,
            tags: ["不会同步到飞书"],
            clearFields: [],
          },
        ],
      },
      { runId: "run", signal },
    );
    expect(updateEffects).toMatchObject({
      risk: "R2",
      network: ["Feishu Task v2 on next sync"],
      reversible: true,
      baseVersions: {
        [local.id]: local.updatedAt,
        [feishu.id]: feishu.updatedAt,
      },
    });
    expect(updateEffects.externalEffects).toEqual([
      `update Feishu task ${feishu.id} fields: title`,
    ]);

    const complete = tools.find(
      (tool) => tool.name === "task_bulk_set_completed",
    )!;
    const completionEffects = await complete.analyze(
      {
        taskIds: [local.id, feishu.id],
        completed: true,
      },
      { runId: "run", signal },
    );
    expect(completionEffects.risk).toBe("R2");
    expect(completionEffects.externalEffects).toEqual([
      `complete Feishu task ${feishu.id} as a whole`,
    ]);

    const trash = tools.find(
      (tool) => tool.name === "task_bulk_move_to_trash",
    )!;
    const trashEffects = await trash.analyze(
      { taskIds: [local.id, feishu.id] },
      { runId: "run", signal },
    );
    expect(trashEffects).toMatchObject({ risk: "R2", reversible: true });
    expect(trashEffects.externalEffects).toEqual([
      `delete Feishu task ${feishu.id} on next sync`,
    ]);

    const create = tools.find((tool) => tool.name === "task_bulk_create")!;
    const createEffects = await create.analyze(
      {
        tasks: [
          {
            title: "新增",
            notes: "",
            plannedDate: null,
            dueAt: null,
            priority: "none",
            tags: [],
          },
        ],
      },
      { runId: "run", signal },
    );
    expect(createEffects).toMatchObject({
      risk: "R2",
      network: [],
      externalEffects: [],
      reversible: true,
    });
  });

  it("requires confirmation for every delete and restores an exact local task", async () => {
    const task = (await tasks.createTask({ title: "可恢复删除" })).task;
    const registry = new ToolRegistry(
      createTaskTools({
        tasks,
        getModelDataScope: () => defaultSettings.modelDataScope,
      }),
    );
    const engine = new PermissionEngine();
    const prepared = await registry.prepare("trash-run", {
      id: "trash-call",
      name: "task_move_to_trash",
      arguments: { id: task.id },
      argumentsJson: JSON.stringify({ id: task.id }),
    });
    expect(prepared.effects).toMatchObject({
      risk: "R2",
      reversible: true,
      preview: { action: "trash-task", taskId: task.id },
    });
    let permission = engine.evaluate(prepared.invocation, prepared.effects, {
      mode: "standard",
    });
    expect(permission.kind).toBe("confirm");
    expect(await tasks.getTask(task.id)).toBeTruthy();
    if (permission.kind !== "confirm") throw new Error("Expected confirmation");
    permission = engine.resolveApproval(permission.request.approvalId, "once");
    if (permission.kind !== "allow") throw new Error("Expected grant");
    engine.consumeGrant(permission.grant, prepared.invocation, prepared.effects, {
      mode: "standard",
    });
    await registry.execute(
      prepared.invocation,
      permission.grant,
      new AbortController().signal,
    );
    expect(await tasks.getTask(task.id)).toBeUndefined();

    const restore = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    }).find((tool) => tool.name === "task_restore")!;
    const restoreEffects = await restore.analyze(
      { id: task.id },
      { runId: "restore-run", signal: new AbortController().signal },
    );
    expect(restoreEffects).toMatchObject({
      risk: "R1",
      preview: { action: "restore-task-from-trash", permitted: true },
    });
    const restored = await restore.execute(
      { id: task.id },
      executionContext("task_restore"),
    );
    expect(restored.status).toBe("ok");
    expect(restored.data).toHaveProperty("undoOperationId");
    expect(await tasks.getTask(task.id)).toMatchObject({ title: "可恢复删除" });
  });

  it("executes batch creation, completion, reopening, trash, and restore with operation IDs", async () => {
    let changedEvents = 0;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      onTasksChanged: () => {
        changedEvents += 1;
      },
    });
    const bulkCreate = tools.find((tool) => tool.name === "task_bulk_create")!;
    const created = await bulkCreate.execute(
      {
        tasks: [
          {
            title: "批量一",
            notes: "",
            plannedDate: null,
            dueAt: null,
            priority: "high",
            tags: [],
          },
          {
            title: "批量二",
            notes: "",
            plannedDate: null,
            dueAt: null,
            priority: "low",
            tags: [],
          },
        ],
      },
      executionContext("task_bulk_create"),
    );
    expect(created.status).toBe("ok");
    expect(created.data).toMatchObject({ createdCount: 2, aborted: false });
    const createdData = created.data as {
      createdTasks: Array<{ id: string }>;
      operationIds: string[];
    };
    expect(createdData.operationIds).toHaveLength(2);
    const taskIds = createdData.createdTasks.map((task) => task.id);

    const bulkCompleted = tools.find(
      (tool) => tool.name === "task_bulk_set_completed",
    )!;
    const completed = await bulkCompleted.execute(
      { taskIds, completed: true },
      executionContext("task_bulk_set_completed"),
    );
    expect(completed.data).toMatchObject({
      changedCount: 2,
      skippedTaskIds: [],
      aborted: false,
    });
    expect(
      (completed.data as { operationIds: string[] }).operationIds,
    ).toHaveLength(2);

    const reopened = await bulkCompleted.execute(
      { taskIds, completed: false },
      executionContext("task_bulk_set_completed"),
    );
    expect(reopened.data).toMatchObject({
      changedCount: 2,
      skippedTaskIds: [],
      aborted: false,
    });

    const bulkTrash = tools.find(
      (tool) => tool.name === "task_bulk_move_to_trash",
    )!;
    const trashed = await bulkTrash.execute(
      { taskIds },
      executionContext("task_bulk_move_to_trash"),
    );
    expect(trashed.data).toMatchObject({
      movedCount: 2,
      movedTaskIds: taskIds,
      permanentDeletion: false,
      aborted: false,
    });
    expect(
      (trashed.data as { operationIds: string[] }).operationIds,
    ).toHaveLength(2);
    expect(await tasks.getTask(taskIds[0], true)).toHaveProperty("deletedAt");

    const bulkRestore = tools.find(
      (tool) => tool.name === "task_bulk_restore",
    )!;
    const restored = await bulkRestore.execute(
      { taskIds },
      executionContext("task_bulk_restore"),
    );
    expect(restored).toMatchObject({
      status: "ok",
      data: {
        restoredCount: 2,
        restoredTaskIds: taskIds,
        unsupported: [],
        failedTasks: [],
        aborted: false,
      },
    });
    expect(
      (restored.data as { operationIds: string[] }).operationIds,
    ).toHaveLength(2);
    expect(await tasks.getTask(taskIds[0])).not.toHaveProperty("deletedAt");
    expect(changedEvents).toBe(5);
  });

  it("reports each failed batch item without hiding successful mutations", async () => {
    const first = (await tasks.createTask({ title: "可恢复一" })).task;
    const second = (await tasks.createTask({ title: "可恢复二" })).task;
    await tasks.moveToTrash(first.id);
    await tasks.moveToTrash(second.id);
    const originalRestore = tasks.restoreTask.bind(tasks);
    vi.spyOn(tasks, "restoreTask").mockImplementation(async (id) => {
      if (id === second.id) throw new Error("SIMULATED_RESTORE_FAILURE");
      return originalRestore(id);
    });
    let changedEvents = 0;
    const restore = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      onTasksChanged: () => {
        changedEvents += 1;
      },
    }).find((tool) => tool.name === "task_bulk_restore")!;

    const output = await restore.execute(
      { taskIds: [first.id, second.id] },
      executionContext("task_bulk_restore"),
    );
    expect(output).toMatchObject({
      status: "partial",
      data: {
        processedTaskIds: [first.id, second.id],
        restoredCount: 1,
        restoredTaskIds: [first.id],
        failedTasks: [{ taskId: second.id, code: "Error" }],
      },
    });
    expect(await tasks.getTask(first.id)).toBeTruthy();
    expect(await tasks.getTask(second.id)).toBeUndefined();
    expect(changedEvents).toBe(1);
  });

  it("returns an explicit partial result and completed operation IDs when a batch is aborted", async () => {
    const first = (await tasks.createTask({ title: "第一项" })).task;
    const second = (await tasks.createTask({ title: "第二项" })).task;
    const abortController = new AbortController();
    const originalUpdate = tasks.updateTask.bind(tasks);
    let updateCalls = 0;
    vi.spyOn(tasks, "updateTask").mockImplementation(async (...args) => {
      const mutation = await originalUpdate(...args);
      updateCalls += 1;
      if (updateCalls === 1) abortController.abort();
      return mutation;
    });
    let changedEvents = 0;
    const update = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      onTasksChanged: () => {
        changedEvents += 1;
      },
    }).find((tool) => tool.name === "task_bulk_update")!;
    const unchanged = {
      title: null,
      notes: null,
      privateNotes: null,
      plannedDate: null,
      dueAt: null,
      priority: "urgent" as const,
      tags: null,
      clearFields: [] as Array<
        "notes" | "privateNotes" | "plannedDate" | "dueAt" | "tags"
      >,
    };
    const output = await update.execute(
      {
        updates: [
          { id: first.id, ...unchanged },
          { id: second.id, ...unchanged },
        ],
      },
      executionContext("task_bulk_update", abortController.signal),
    );
    expect(output.status).toBe("partial");
    expect(output.data).toMatchObject({
      aborted: true,
      processedCount: 1,
      remainingCount: 1,
      updatedTaskIds: [first.id],
    });
    expect(
      (output.data as { operationIds: string[] }).operationIds,
    ).toHaveLength(1);
    expect((await tasks.getTask(first.id))?.priority).toBe("urgent");
    expect((await tasks.getTask(second.id))?.priority).toBe("none");
    expect(changedEvents).toBe(1);
  });

  it("moves a task to Today, creates and edits a local reminder, then undoes an exact operation", async () => {
    const created = await tasks.createTask({ title: "安排今天" });
    let changedEvents = 0;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
      onTasksChanged: () => {
        changedEvents += 1;
      },
    });
    const move = tools.find((tool) => tool.name === "move_to_today")!;
    const moveEffects = await move.analyze(
      { id: created.task.id },
      {
        runId: "run",
        signal: new AbortController().signal,
      },
    );
    expect(moveEffects).toMatchObject({
      risk: "R1",
      network: [],
      externalEffects: [],
      reversible: true,
    });
    const moved = await move.execute(
      { id: created.task.id },
      executionContext("move_to_today"),
    );
    expect(
      (moved.data as { undoOperationId: string }).undoOperationId,
    ).toBeTruthy();
    expect((await tasks.getTask(created.task.id))?.plannedDate).toMatch(
      /^\d{4}-\d{2}-\d{2}$/u,
    );

    const reminderTool = tools.find((tool) => tool.name === "set_reminder")!;
    const reminderAt = "2030-08-09T09:00:00.000+08:00";
    const reminderEffects = await reminderTool.analyze(
      {
        id: created.task.id,
        reminderId: null,
        at: reminderAt,
        label: "开始处理",
        enabled: true,
      },
      { runId: "run", signal: new AbortController().signal },
    );
    expect(reminderEffects).toMatchObject({
      risk: "R1",
      network: [],
      externalEffects: [],
      reversible: true,
    });
    const reminderResult = await reminderTool.execute(
      {
        id: created.task.id,
        reminderId: null,
        at: reminderAt,
        label: "开始处理",
        enabled: true,
      },
      executionContext("set_reminder"),
    );
    const reminderData = reminderResult.data as {
      reminder: { id: string; at: string };
      undoOperationId: string;
    };
    expect(reminderData.reminder.at).toBe(reminderAt);
    expect((await tasks.getTask(created.task.id))?.reminders).toEqual([
      expect.objectContaining({
        id: reminderData.reminder.id,
        at: reminderAt,
        source: "local",
      }),
    ]);

    const editedAt = "2030-08-09T10:00:00.000+08:00";
    const edited = await reminderTool.execute(
      {
        id: created.task.id,
        reminderId: reminderData.reminder.id,
        at: editedAt,
        label: null,
        enabled: false,
      },
      executionContext("set_reminder"),
    );
    expect(
      (edited.data as { undoOperationId: string }).undoOperationId,
    ).toBeTruthy();
    expect((await tasks.getTask(created.task.id))?.reminders).toEqual([
      expect.objectContaining({
        id: reminderData.reminder.id,
        at: editedAt,
        enabled: false,
      }),
    ]);

    const undo = tools.find((tool) => tool.name === "undo_task_operation")!;
    const editedOperationId = (edited.data as { undoOperationId: string })
      .undoOperationId;
    const undoEffects = await undo.analyze(
      {
        operationId: editedOperationId,
      },
      { runId: "run", signal: new AbortController().signal },
    );
    expect(undoEffects).toMatchObject({
      risk: "R2",
      reversible: false,
      network: [],
      externalEffects: [],
    });
    const undoneEdit = await undo.execute(
      { operationId: editedOperationId },
      executionContext("undo_task_operation"),
    );
    expect(undoneEdit.data).toMatchObject({
      undoneOperationId: editedOperationId,
      reversible: false,
    });
    expect((await tasks.getTask(created.task.id))?.reminders).toEqual([
      expect.objectContaining({
        id: reminderData.reminder.id,
        at: reminderAt,
        enabled: true,
      }),
    ]);
    const undoneCreate = await undo.execute(
      { operationId: reminderData.undoOperationId },
      executionContext("undo_task_operation"),
    );
    expect(undoneCreate.data).toMatchObject({
      undoneOperationId: reminderData.undoOperationId,
      reversible: false,
    });
    expect((await tasks.getTask(created.task.id))?.reminders).toEqual([]);
    expect(changedEvents).toBe(5);
  });

  it("refuses to edit Feishu-owned reminders through the local reminder tool", async () => {
    const task = (
      await tasks.createTask({
        title: "飞书提醒",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-reminder",
        },
        sync: { status: "synced" },
        reminders: [
          {
            id: "feishu-reminder",
            at: "2030-08-09T09:00:00.000+08:00",
            enabled: true,
            source: "feishu",
          },
        ],
      })
    ).task;
    const reminderTool = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    }).find((tool) => tool.name === "set_reminder")!;
    await expect(
      reminderTool.analyze(
        {
          id: task.id,
          reminderId: "feishu-reminder",
          at: "2030-08-09T10:00:00.000+08:00",
          label: null,
          enabled: true,
        },
        { runId: "run", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("AGENT_CANNOT_EDIT_FEISHU_REMINDER");

    const localReminderArgs = {
      id: task.id,
      reminderId: null,
      at: "2030-08-09T11:00:00.000+08:00",
      label: "仅本机",
      enabled: true,
    };
    const localEffects = await reminderTool.analyze(localReminderArgs, {
      runId: "run",
      signal: new AbortController().signal,
    });
    expect(localEffects).toMatchObject({
      risk: "R1",
      network: [],
      externalEffects: [],
    });
    await reminderTool.execute(
      localReminderArgs,
      executionContext("set_reminder"),
    );
    const saved = await tasks.getTask(task.id);
    expect(saved?.sync.status).toBe("synced");
    expect(saved?.reminders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          at: localReminderArgs.at,
          source: "local",
        }),
      ]),
    );
  });

  it("reports Feishu all-assignees completion as unsupported without mutating it", async () => {
    const local = (await tasks.createTask({ title: "可完成本地任务" })).task;
    const allAssignees = (
      await tasks.createTask({
        title: "飞书会签任务",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-joint",
        },
        sync: { status: "synced" },
        completionMode: "all-assignees",
        currentUserRole: "assignee",
      })
    ).task;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    const single = tools.find((tool) => tool.name === "task_set_completed")!;
    const singleEffects = await single.analyze(
      { id: allAssignees.id, completed: true },
      {
        runId: "run",
        signal: new AbortController().signal,
      },
    );
    expect(singleEffects).toMatchObject({
      risk: "R4",
      writes: [],
      network: [],
      preview: { permitted: false },
    });
    await expect(
      single.execute(
        { id: allAssignees.id, completed: true },
        executionContext("task_set_completed"),
      ),
    ).rejects.toThrow("FEISHU_ALL_ASSIGNEES_PERSONAL_COMPLETION_UNSUPPORTED");

    const bulk = tools.find((tool) => tool.name === "task_bulk_set_completed")!;
    const effects = await bulk.analyze(
      {
        taskIds: [local.id, allAssignees.id],
        completed: true,
      },
      { runId: "run", signal: new AbortController().signal },
    );
    expect(effects).toMatchObject({
      risk: "R2",
      network: [],
      externalEffects: [],
    });
    expect(effects.preview).toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id: allAssignees.id,
          willChange: false,
          unsupported: "FEISHU_ALL_ASSIGNEES_PERSONAL_COMPLETION_UNSUPPORTED",
        }),
      ]),
    });

    const output = await bulk.execute(
      {
        taskIds: [local.id, allAssignees.id],
        completed: true,
      },
      executionContext("task_bulk_set_completed"),
    );
    expect(output.status).toBe("partial");
    expect(output.data).toMatchObject({
      changedCount: 1,
      unsupported: [
        {
          taskId: allAssignees.id,
          code: "FEISHU_ALL_ASSIGNEES_PERSONAL_COMPLETION_UNSUPPORTED",
        },
      ],
    });
    expect((await tasks.getTask(local.id))?.status).toBe("completed");
    expect((await tasks.getTask(allAssignees.id))?.status).toBe("open");
  });

  it("previews and executes local recurring skip without creating a second task", async () => {
    const recurring = (
      await tasks.createTask({
        title: "Agent 跳过本次",
        source: { type: "local" },
        plannedDate: "2026-08-10",
        recurrence: { frequency: "daily", interval: 1 },
      })
    ).task;
    const tools = createTaskTools({
      tasks,
      getModelDataScope: () => defaultSettings.modelDataScope,
    });
    const skip = tools.find((tool) => tool.name === "task_skip_recurring")!;
    const effects = await skip.analyze(
      { id: recurring.id },
      { runId: "run", signal: new AbortController().signal },
    );
    expect(effects).toMatchObject({
      risk: "R1",
      network: [],
      externalEffects: [],
      preview: {
        action: "skip-recurring-task",
        from: "2026-08-10",
        to: "2026-08-11",
        keepTaskId: true,
        remoteWrite: false,
      },
    });
    const output = await skip.execute(
      { id: recurring.id },
      executionContext("task_skip_recurring"),
    );
    expect(output.status).toBe("ok");
    expect(output.data).toMatchObject({
      changed: true,
      undoOperationId: expect.any(String),
      task: {
        id: recurring.id,
        plannedDate: "2026-08-11",
      },
      syncReceipts: [],
    });
    expect((await tasks.getTask(recurring.id))?.recurrenceIndex).toBe(1);
    expect((await tasks.listTasks({ includeDeleted: true })).map((task) => task.id)).toEqual([
      recurring.id,
    ]);

    const remote = (
      await tasks.createTask({
        title: "飞书循环不可跳过",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-skip",
        },
        dueAt: "2026-08-10T09:00:00.000Z",
        recurrence: { frequency: "daily", interval: 1 },
        sync: { status: "synced" },
      })
    ).task;
    await expect(
      skip.analyze(
        { id: remote.id },
        { runId: "run", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("TASK_RECURRING_SKIP_LOCAL_ONLY");
  });
});
