import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const endpoint =
  process.env.TODO_AGENT_LIVE_MODEL_ENDPOINT ?? "http://10.30.0.21:8005";
const model =
  process.env.TODO_AGENT_LIVE_MODEL_NAME ?? "DeepSeek-V4-Flash-0731";

test.skip(
  process.env.TODO_AGENT_LIVE_MODEL !== "1",
  "Run only when an explicitly authorized live model endpoint is available.",
);
test.setTimeout(180_000);

async function mainWindow(app: ElectronApplication): Promise<Page> {
  const existing = app
    .windows()
    .find((page) => new URL(page.url()).searchParams.get("window") === "main");
  return (
    existing ??
    app.waitForEvent("window", {
      predicate: (page) => {
        try {
          return new URL(page.url()).searchParams.get("window") === "main";
        } catch {
          return false;
        }
      },
    })
  );
}

test("authorized live model supports connection, task CRUD approval, and morning brief", async () => {
  const profilePath = await mkdtemp(
    path.join(os.tmpdir(), "todo-agent-live-model-"),
  );
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [projectRoot, `--user-data-dir=${profilePath}`],
      cwd: projectRoot,
      env: {
        ...process.env,
        NO_PROXY: "10.30.0.21,127.0.0.1,localhost",
        no_proxy: "10.30.0.21,127.0.0.1,localhost",
        TODO_AGENT_E2E: "1",
        TODO_AGENT_E2E_BACKGROUND: "1",
      },
    });
    const main = await mainWindow(app);
    await main.waitForLoadState("domcontentloaded");

    const result = await main.evaluate(
      async ({ endpoint: configuredEndpoint, model: configuredModel }) => {
        const api = window.desktopApi!;
        const current = await api.settings.get();
        await api.settings.replace({
          ...current,
          onboardingComplete: true,
          ai: {
            ...current.ai,
            enabled: true,
            endpoint: configuredEndpoint,
            model: configuredModel,
            // The authorized lab endpoint is self-hosted and intentionally
            // accepts requests without an Authorization header. This exercises
            // the explicit no-key mode rather than silently relying on a dummy
            // credential in the isolated test profile.
            authMode: "none",
            credentialId: undefined,
            timeoutMs: 60_000,
            retries: 0,
            dailyTokenLimit: 100_000_000,
          },
          modelDataScope: {
            ...current.modelDataScope,
            taskTitlesAndTimes: true,
            notes: false,
            feishuContent: false,
          },
        });
        const now = new Date();
        const plannedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        await api.tasks.create({
          title: "Codex验收-真实模型只读联调任务",
          plannedDate,
          source: { type: "local" },
        });

        const connection = await api.agent.testModelConnection();
        const chat = await api.agent.send({
          message:
            '请调用 task_list 查询今天的任务，参数为 view="today"、text=null、source=null、limit=50，然后用一句中文告诉我是否看到了“Codex验收-真实模型只读联调任务”。只读，不要修改任何任务。',
        });
        const naturalChat = await api.agent.send({
          message:
            "请查看我今天有哪些任务，并用一句中文告诉我是否有 Codex验收-真实模型只读联调任务。只查询，不要修改。",
        });
        const createChat = await api.agent.send({
          message:
            "请创建一个本地任务，标题是“Codex验收-真实模型自然语言创建验收”。不设置日期、备注、标签或提醒，优先级为普通。",
        });
        const approvalIds: string[] = [];
        const approvalResponses: Array<Promise<boolean>> = [];
        const batchEvents: unknown[] = [];
        const unsubscribeEvents = api.events.onAgentEvent((event) => {
          batchEvents.push(event);
        });
        const unsubscribeApproval = api.events.onAgentApproval((approval) => {
          approvalIds.push(approval.approvalId);
          approvalResponses.push(
            api.agent.respondToApproval({
              approvalId: approval.approvalId,
              choice: "once",
            }),
          );
        });
        const batchChat = await api.agent.send({
          message:
            "请先查询标题包含“Codex验收-真实模型”的所有本地任务，然后批量把它们的优先级改为 low。不要修改其他字段。请使用批量更新，并在需要时等待我确认。",
        });
        const createdTasks = await api.tasks.list({
          text: "Codex验收-真实模型自然语言创建验收",
          includeDeleted: false,
        });
        if (createdTasks.length !== 1) {
          throw new Error(
            `LIVE_AGENT_CREATE_COUNT:${createdTasks.length}; ${JSON.stringify({
              state: createChat.state,
              errorCode: createChat.errorCode ?? null,
              assistantText: createChat.assistantText,
            })}`,
          );
        }
        const batchTasks = await api.tasks.list({
          text: "Codex验收-真实模型",
          includeDeleted: false,
        });
        const lifecycleTaskId = createdTasks[0].id;
        const updateChat = await api.agent.send({
          message: `请调用 task_update，把任务 ID ${lifecycleTaskId} 的标题改为“Codex验收-真实模型 CRUD 已修改”，优先级改为 high；其余字段保持不变。`,
        });
        const readChat = await api.agent.send({
          message: `请调用 task_get 只读取任务 ID ${lifecycleTaskId}，告诉我它现在的标题、状态和优先级，不要修改。`,
        });
        const completeChat = await api.agent.send({
          message: `请调用 task_set_completed，将任务 ID ${lifecycleTaskId} 标记为已完成。`,
        });
        const completedSnapshot = await api.tasks.get(lifecycleTaskId, true);
        const reopenChat = await api.agent.send({
          message: `请调用 task_set_completed，将任务 ID ${lifecycleTaskId} 重新打开为未完成。`,
        });
        const reopenedSnapshot = await api.tasks.get(lifecycleTaskId, true);
        const trashChat = await api.agent.send({
          message: `请调用 task_move_to_trash，把任务 ID ${lifecycleTaskId} 移入可恢复的回收站，不要永久删除；需要审批时等待我确认。`,
        });
        const trashedSnapshot = await api.tasks.get(lifecycleTaskId, true);
        const restoreChat = await api.agent.send({
          message: `请调用 task_restore，从回收站恢复任务 ID ${lifecycleTaskId}。`,
        });
        const restoredSnapshot = await api.tasks.get(lifecycleTaskId, true);
        unsubscribeApproval();
        unsubscribeEvents();
        await Promise.all(approvalResponses);
        const brief = await api.agent.morningBrief({ trigger: "manual" });
        const relevantRuns = new Set([
          chat.runId,
          naturalChat.runId,
          createChat.runId,
          batchChat.runId,
          updateChat.runId,
          readChat.runId,
          completeChat.runId,
          reopenChat.runId,
          trashChat.runId,
          restoreChat.runId,
        ]);
        const audit = (await api.agent.audit(100)).filter((record) =>
          relevantRuns.has(record.runId),
        );
        return {
          connection,
          chat,
          naturalChat,
          createChat,
          batchChat,
          batchEvents: batchEvents.filter(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "runId" in event &&
              event.runId === batchChat.runId,
          ),
          approvalIds,
          createdTasks,
          batchTasks,
          updateChat,
          readChat,
          completeChat,
          completedSnapshot,
          reopenChat,
          reopenedSnapshot,
          trashChat,
          trashedSnapshot,
          restoreChat,
          restoredSnapshot,
          brief,
          audit,
        };
      },
      { endpoint, model },
    );

    expect(result.connection).toMatchObject({
      ok: true,
      model,
      endpointOrigin: "http://10.30.0.21:8005",
    });
    expect(result.connection.reportedTotalTokens).toBeGreaterThan(0);
    expect(result.chat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.chat.assistantText).toContain("Codex验收-真实模型只读联调任务");
    expect(result.naturalChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.naturalChat.assistantText).toContain("Codex验收-真实模型只读联调任务");
    expect(result.createChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.createdTasks).toHaveLength(1);
    expect(result.batchChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.approvalIds.length).toBeGreaterThan(0);
    expect(result.batchTasks.length).toBeGreaterThanOrEqual(2);
    expect(result.batchTasks.every((task) => task.priority === "low")).toBe(
      true,
    );
    expect(result.updateChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.readChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.readChat.assistantText).toContain("Codex验收-真实模型 CRUD 已修改");
    expect(result.completeChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.completedSnapshot?.status).toBe("completed");
    expect(result.reopenChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.reopenedSnapshot?.status).toBe("open");
    expect(result.trashChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.trashedSnapshot?.deletedAt).toBeTruthy();
    expect(result.restoreChat, JSON.stringify(result, null, 2)).toMatchObject({
      state: "completed",
    });
    expect(result.restoredSnapshot).toMatchObject({
      status: "open",
      title: "Codex验收-真实模型 CRUD 已修改",
      priority: "high",
    });
    expect(result.restoredSnapshot?.deletedAt).toBeUndefined();
    expect(result.approvalIds.length).toBeGreaterThanOrEqual(2);
    expect(result.brief).toMatchObject({ source: "ai", code: "GENERATED" });
    expect(result.brief.summary?.length).toBeGreaterThan(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(profilePath, { recursive: true, force: true });
  }
});
