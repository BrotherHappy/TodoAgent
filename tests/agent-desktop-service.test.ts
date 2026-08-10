import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentDesktopService,
  type AgentDesktopServiceOptions,
} from "../electron/agent/agent-desktop-service";
import { AuditLog, InMemoryAuditStore } from "../electron/agent/audit-log";
import { FileAuditStore } from "../electron/agent/file-audit-store";
import { ModelUsageBudgetService } from "../electron/agent/model-usage-budget";
import type { ModelGatewayLike } from "../electron/agent/agent-runtime";
import { createTaskTools } from "../electron/agent/task-tools";
import { ToolRegistry } from "../electron/agent/tool-registry";
import type { AgentTaskSourcePolicy } from "../electron/agent/task-source-policy";
import { LocalStore } from "../electron/services/local-store";
import {
  SettingsService,
  type EncryptionAdapter,
} from "../electron/services/settings-service";
import { TaskService } from "../electron/services/task-service";
import type {
  AgentJsonValue,
  AgentRunEvent,
  ModelCompletion,
  ModelCompletionRequest,
  ModelToolCall,
} from "../src/shared/agent-types";
import type { AgentApprovalView } from "../src/shared/desktop-api";

const temporaryDirectories: string[] = [];

const encryption: EncryptionAdapter = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (value) => value.toString("utf8"),
};

type GatewayStep =
  | ModelCompletion
  | ((
      request: ModelCompletionRequest,
      signal?: AbortSignal,
    ) => ModelCompletion | Promise<ModelCompletion>);

class ScriptedGateway implements ModelGatewayLike {
  readonly requests: ModelCompletionRequest[] = [];
  #index = 0;

  constructor(readonly steps: GatewayStep[]) {}

  async complete(
    request: ModelCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ModelCompletion> {
    this.requests.push(structuredClone(request));
    if (signal?.aborted) throw signal.reason;
    const step = this.steps[this.#index];
    this.#index += 1;
    if (!step) throw new Error("SCRIPTED_GATEWAY_EXHAUSTED");
    return typeof step === "function"
      ? step(request, signal)
      : structuredClone(step);
  }
}

const finalCompletion = (content = "完成"): ModelCompletion => ({
  id: "final",
  assistantMessage: { role: "assistant", content },
  toolCalls: [],
  finishReason: "stop",
  usage: { totalTokens: 1 },
});

const toolCompletion = (
  name: string,
  args: AgentJsonValue,
  id: string,
): ModelCompletion => {
  const argumentsJson = JSON.stringify(args);
  const toolCall: ModelToolCall = {
    id,
    type: "function",
    function: { name, arguments: argumentsJson },
  };
  return {
    id: `completion-${id}`,
    assistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
    },
    toolCalls: [{ id, name, arguments: structuredClone(args), argumentsJson }],
    finishReason: "tool_calls",
    usage: { totalTokens: 1 },
  };
};

const updateArgs = (id: string, title: string): AgentJsonValue => ({
  id,
  title,
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
});

interface HarnessOptions {
  gateways?: ModelGatewayLike[];
  gatewayFactory?: AgentDesktopServiceOptions["gatewayFactory"];
  approvals?: AgentApprovalView[];
  events?: AgentRunEvent[];
  fileAudit?: boolean;
  now?: () => Date;
  timeZone?: () => string;
  sourcePolicies?: AgentTaskSourcePolicy[];
  feishuAccountId?: string;
}

const createHarness = async (options: HarnessOptions = {}) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "todo-agent-desktop-service-"),
  );
  temporaryDirectories.push(directory);
  const settings = new SettingsService(
    path.join(directory, "settings"),
    encryption,
  );
  await settings.load();
  const tasks = new TaskService(new LocalStore(path.join(directory, "tasks")), {
    clock: options.now,
    timeZone: options.timeZone?.(),
  });
  await tasks.initialize();
  const fileAuditStore = options.fileAudit
    ? new FileAuditStore({ directory: path.join(directory, "audit") })
    : undefined;
  const auditLog = new AuditLog({
    store: fileAuditStore ?? new InMemoryAuditStore(),
  });
  const usageBudget = new ModelUsageBudgetService({
    filePath: path.join(directory, "private", "model-usage.v1.json"),
    timezone: options.timeZone ?? (() => "UTC"),
  });
  await usageBudget.initialize();
  const queuedGateways = [...(options.gateways ?? [])];
  const service = new AgentDesktopService({
    settings,
    auditLog,
    usageBudget,
    listMorningTasks: () => tasks.listTasks({ view: "today" }),
    getTaskForSyncReceipt: (id) => tasks.getTask(id, true),
    createToolRegistry: ({ sourcePolicy }) => {
      options.sourcePolicies?.push(structuredClone(sourcePolicy));
      return new ToolRegistry(
        createTaskTools({
          tasks,
          getModelDataScope: () => settings.get().modelDataScope,
          sourcePolicy,
          // Most service tests exercise the Agent lifecycle without a live
          // desktop sync controller. Only install the account resolver when
          // a test explicitly models that integration; the packaged main
          // always installs one.
          getFeishuAccountId:
            options.feishuAccountId === undefined
              ? undefined
              : () => options.feishuAccountId,
        }),
      );
    },
    gatewayFactory:
      options.gatewayFactory ??
      (() => {
        const gateway = queuedGateways.shift();
        if (!gateway) throw new Error("GATEWAY_FACTORY_EXHAUSTED");
        return gateway;
      }),
    onApproval: (approval) => options.approvals?.push(approval),
    onEvent: (event) => options.events?.push(event),
    now: options.now,
    timeZone: options.timeZone,
  });
  return {
    directory,
    settings,
    tasks,
    auditLog,
    fileAuditStore,
    usageBudget,
    service,
  };
};

const configureAi = async (
  settings: SettingsService,
  options: {
    secret?: string;
    credentialId?: string;
    permissionMode?: "standard" | "full-access";
  } = {},
): Promise<string> => {
  const credentialId = options.credentialId ?? "test-ai-key";
  await settings.setCredential(
    "ai-api-key",
    options.secret ?? "test-secret",
    credentialId,
  );
  const current = settings.get();
  await settings.replace({
    ...current,
    permissionMode: options.permissionMode ?? current.permissionMode,
    ai: {
      ...current.ai,
      enabled: true,
      endpoint: "https://model.test/v1",
      model: "test-model",
      credentialId,
    },
  });
  return credentialId;
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AgentDesktopService", () => {
  it("generates a tool-free automatic morning brief once and records provider usage", async () => {
    const gateway = new ScriptedGateway([
      {
        ...finalCompletion("今天先处理逾期事项，再专注完成最重要的一项。"),
        usage: { totalTokens: 12 },
      },
    ]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const today = new Date();
    const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await harness.tasks.createTask({
      title: "完成晨间重点",
      notes: "只属于本地的备注",
      privateNotes: "绝不能发送的私人计划",
      plannedDate: localDate,
    });

    const first = await harness.service.morningBrief({
      trigger: "automatic",
    });
    const second = await harness.service.morningBrief({
      trigger: "automatic",
    });

    expect(first).toMatchObject({
      source: "ai",
      code: "GENERATED",
      localDate,
      summary: "今天先处理逾期事项，再专注完成最重要的一项。",
    });
    expect(second).toEqual(first);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({
      tools: [],
      toolChoice: "none",
    });
    const serializedRequest = JSON.stringify(gateway.requests[0]);
    expect(serializedRequest).toContain("完成晨间重点");
    expect(serializedRequest).not.toContain("只属于本地的备注");
    expect(serializedRequest).not.toContain("绝不能发送的私人计划");
    expect(await harness.service.modelUsage()).toMatchObject({
      usedTokens: 12,
      reportedRequestCount: 1,
    });
    expect(
      (await harness.service.audit()).filter(
        (record) => record.event === "morning-brief.automatic-attempted",
      ),
    ).toHaveLength(1);
  });

  it("does not contact the model when task titles and times are outside the data scope", async () => {
    const gateway = new ScriptedGateway([finalCompletion("不应生成")]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      modelDataScope: {
        ...current.modelDataScope,
        taskTitlesAndTimes: false,
      },
    });

    await expect(
      harness.service.morningBrief({ trigger: "automatic" }),
    ).resolves.toMatchObject({
      source: "local-fallback",
      code: "MODEL_DATA_SCOPE_DISABLED",
    });
    expect(gateway.requests).toHaveLength(0);
  });

  it("includes notes only within the local and Feishu content scopes", async () => {
    const gateway = new ScriptedGateway([finalCompletion("范围正确。")]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      modelDataScope: {
        ...current.modelDataScope,
        taskTitlesAndTimes: true,
        notes: true,
        feishuContent: false,
      },
    });
    const today = new Date();
    const plannedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await harness.tasks.createTask({
      title: "本地任务",
      notes: "LOCAL_NOTE_ALLOWED_71C",
      privateNotes: "PRIVATE_NOTE_NEVER_4B2",
      plannedDate,
    });
    await harness.tasks.createTask({
      title: "飞书任务",
      notes: "FEISHU_NOTE_BLOCKED_9D8",
      plannedDate,
      source: { type: "feishu", accountId: "primary", externalId: "remote-1" },
    });

    await harness.service.morningBrief({ trigger: "manual" });

    const serializedRequest = JSON.stringify(gateway.requests[0]);
    expect(serializedRequest).toContain("LOCAL_NOTE_ALLOWED_71C");
    expect(serializedRequest).not.toContain("FEISHU_NOTE_BLOCKED_9D8");
    expect(serializedRequest).not.toContain("PRIVATE_NOTE_NEVER_4B2");
  });

  it("does not repeat a failed automatic attempt but permits an explicit manual refresh", async () => {
    const failed = new ScriptedGateway([
      () => Promise.reject(new Error("provider unavailable")),
    ]);
    const manual = new ScriptedGateway([finalCompletion("手动刷新成功。")]);
    const harness = await createHarness({ gateways: [failed, manual] });
    await configureAi(harness.settings);
    const today = new Date();
    await harness.tasks.createTask({
      title: "今日任务",
      plannedDate: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
    });

    await expect(
      harness.service.morningBrief({ trigger: "automatic" }),
    ).resolves.toMatchObject({
      source: "local-fallback",
      code: "MODEL_REQUEST_FAILED",
    });
    await expect(
      harness.service.morningBrief({ trigger: "automatic" }),
    ).resolves.toMatchObject({
      source: "local-fallback",
      code: "ALREADY_GENERATED_TODAY",
    });
    await expect(
      harness.service.morningBrief({ trigger: "manual" }),
    ).resolves.toMatchObject({
      source: "ai",
      summary: "手动刷新成功。",
    });
    expect(failed.requests).toHaveLength(1);
    expect(manual.requests).toHaveLength(1);
  });

  it("tests the configured model connection and accounts its provider-reported total_tokens", async () => {
    const gateway = new ScriptedGateway([
      {
        ...finalCompletion("OK"),
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      },
    ]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);

    const result = await harness.service.testModelConnection();

    expect(result).toMatchObject({
      ok: true,
      code: "CONNECTED",
      endpointOrigin: "https://model.test",
      model: "test-model",
      reportedTotalTokens: 7,
      usage: {
        usedTokens: 7,
        reportedRequestCount: 1,
        unreportedRequestCount: 0,
        blocked: false,
        cost: { mode: "not-enforced", reason: "MODEL_PRICING_NOT_CONFIGURED" },
      },
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      tools: [],
      toolChoice: "none",
    });
  });

  it("treats explicit no-auth self-hosted model settings as configured without a credential", async () => {
    const connectionGateway = new ScriptedGateway([finalCompletion("OK")]);
    const chatGateway = new ScriptedGateway([finalCompletion("已处理")]);
    let captured:
      | Parameters<NonNullable<AgentDesktopServiceOptions["gatewayFactory"]>>[0]
      | undefined;
    const harness = await createHarness({
      gateways: [connectionGateway, chatGateway],
      gatewayFactory: (input) => {
        captured = input;
        const next = connectionGateway.requests.length === 0
          ? connectionGateway
          : chatGateway;
        return next;
      },
    });
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      ai: {
        ...current.ai,
        enabled: true,
        endpoint: "http://10.30.0.21:8005",
        model: "DeepSeek-V4-Flash-0731",
        authMode: "none",
      },
    });

    expect(harness.service.status()).toMatchObject({
      enabled: true,
      configured: true,
    });
    await expect(harness.service.testModelConnection()).resolves.toMatchObject({
      ok: true,
    });
    await expect(harness.service.send({ message: "你好" })).resolves.toMatchObject({
      state: "completed",
      assistantText: "已处理",
    });
    expect(captured).toMatchObject({
      endpoint: "http://10.30.0.21:8005",
      model: "DeepSeek-V4-Flash-0731",
      authMode: "none",
      credentialId: undefined,
    });
  });

  it("passes the persisted timeout and retry settings to every model gateway", async () => {
    const gateway = new ScriptedGateway([finalCompletion("OK")]);
    let captured:
      | Parameters<NonNullable<AgentDesktopServiceOptions["gatewayFactory"]>>[0]
      | undefined;
    const harness = await createHarness({
      gatewayFactory: (input) => {
        captured = input;
        return gateway;
      },
    });
    await configureAi(harness.settings);
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      ai: { ...current.ai, timeoutMs: 12_345, retries: 4 },
    });

    await expect(harness.service.testModelConnection()).resolves.toMatchObject({
      ok: true,
    });
    expect(captured).toMatchObject({
      endpoint: "https://model.test/v1",
      model: "test-model",
      timeoutMs: 12_345,
      retries: 4,
    });
  });

  it("rejects a new Agent run before contacting the provider after the daily token limit is reached", async () => {
    const firstGateway = new ScriptedGateway([
      {
        ...finalCompletion("第一次完成"),
        usage: { totalTokens: 5 },
      },
    ]);
    const blockedGateway = new ScriptedGateway([finalCompletion("不应调用")]);
    const harness = await createHarness({
      gateways: [firstGateway, blockedGateway],
    });
    await configureAi(harness.settings);
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      ai: { ...current.ai, dailyTokenLimit: 5 },
    });

    await expect(
      harness.service.send({ message: "第一次" }),
    ).resolves.toMatchObject({
      state: "completed",
    });
    expect(await harness.service.modelUsage()).toMatchObject({
      usedTokens: 5,
      remainingTokens: 0,
      blockedReason: "daily-token-limit-reached",
    });
    await expect(
      harness.service.send({ message: "第二次" }),
    ).rejects.toMatchObject({
      code: "AI_DAILY_TOKEN_LIMIT_REACHED",
    });
    expect(blockedGateway.requests).toHaveLength(0);
  });

  it("surfaces successful connectivity without pretending usage exists when a provider omits it", async () => {
    const gateway = new ScriptedGateway([
      {
        id: "no-usage",
        assistantMessage: { role: "assistant", content: "OK" },
        toolCalls: [],
        finishReason: "stop",
      },
    ]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);

    const result = await harness.service.testModelConnection();

    expect(result).toMatchObject({
      ok: true,
      code: "CONNECTED_USAGE_NOT_REPORTED",
      reportedTotalTokens: undefined,
      usage: {
        accounting: "unavailable",
        blocked: true,
        blockedReason: "provider-usage-unavailable",
        unreportedRequestCount: 1,
      },
    });
    await expect(
      harness.service.send({ message: "预算无法核算时不再运行" }),
    ).rejects.toMatchObject({
      code: "AI_PROVIDER_USAGE_UNAVAILABLE",
    });
  });

  it("injects the configured companion identity and conversation style into the system prompt", async () => {
    const gateway = new ScriptedGateway([finalCompletion("你好")]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      persona: {
        ...current.persona,
        name: "阿序",
        userName: "小海",
        preset: "warm",
        responseLength: "short",
        proactiveLevel: "active",
        reminderStrength: "gentle",
      },
    });

    await harness.service.send({ message: "今天先做什么？" });

    const systemPrompt = gateway.requests[0].messages.find(
      (message) => message.role === "system",
    )?.content;
    expect(systemPrompt).toContain("身份名：阿序");
    expect(systemPrompt).toContain("称呼用户为“小海”");
    expect(systemPrompt).toContain("温暖、鼓励");
    expect(systemPrompt).toContain("主动指出遗漏");
    expect(systemPrompt).toContain("回答长度：short");
  });

  it("injects fresh device-local date, time, timezone, UTC offset, weekday, and default source policy on every Agent turn", async () => {
    let now = new Date("2026-01-01T07:59:59.000Z");
    const firstGateway = new ScriptedGateway([finalCompletion("第一轮")]);
    const secondGateway = new ScriptedGateway([finalCompletion("第二轮")]);
    const harness = await createHarness({
      gateways: [firstGateway, secondGateway],
      now: () => new Date(now),
      timeZone: () => "America/Los_Angeles",
    });
    await configureAi(harness.settings);

    await harness.service.send({ message: "创建一个任务，标题是跨日验收" });
    now = new Date("2026-01-01T08:00:00.000Z");
    await harness.service.send({ message: "创建一个任务，标题是跨日后的验收" });

    const firstPrompt = firstGateway.requests[0].messages.find(
      (message) => message.role === "system",
    )?.content;
    const secondPrompt = secondGateway.requests[0].messages.find(
      (message) => message.role === "system",
    )?.content;
    expect(firstPrompt).toContain("时区=America/Los_Angeles");
    expect(firstPrompt).toContain("本地日期=2025-12-31");
    expect(firstPrompt).toContain("本地时间=23:59:59");
    expect(firstPrompt).toContain("UTC offset=-08:00");
    expect(firstPrompt).toContain("星期=星期三");
    expect(firstPrompt).toContain("默认且只能创建本地任务");
    expect(secondPrompt).toContain("本地日期=2026-01-01");
    expect(secondPrompt).toContain("本地时间=00:00:00");
    expect(secondPrompt).toContain("星期=星期四");
  });

  it("rebuilds an Agent service with fresh local date context after an app restart", async () => {
    const beforeRestart = new Date("2027-01-01T07:59:59.000Z");
    const afterRestart = new Date("2027-01-01T08:00:01.000Z");
    const firstGateway = new ScriptedGateway([finalCompletion("重启前")]);
    const secondGateway = new ScriptedGateway([finalCompletion("重启后")]);
    const harness = await createHarness({
      gateways: [firstGateway],
      now: () => new Date(beforeRestart),
      timeZone: () => "America/Los_Angeles",
    });
    await configureAi(harness.settings);

    await harness.service.send({ message: "今天有哪些任务？" });
    const restartedService = new AgentDesktopService({
      settings: harness.settings,
      auditLog: harness.auditLog,
      usageBudget: harness.usageBudget,
      listMorningTasks: () => harness.tasks.listTasks({ view: "today" }),
      createToolRegistry: ({ sourcePolicy }) =>
        new ToolRegistry(
          createTaskTools({
            tasks: harness.tasks,
            getModelDataScope: () => harness.settings.get().modelDataScope,
            sourcePolicy,
          }),
        ),
      gatewayFactory: () => secondGateway,
      now: () => new Date(afterRestart),
      timeZone: () => "America/Los_Angeles",
    });

    await restartedService.send({ message: "新的一天先做什么？" });
    const firstPrompt = firstGateway.requests[0].messages.find(
      (message) => message.role === "system",
    )?.content;
    const restartedPrompt = secondGateway.requests[0].messages.find(
      (message) => message.role === "system",
    )?.content;
    expect(firstPrompt).toContain("本地日期=2026-12-31");
    expect(firstPrompt).toContain("本地时间=23:59:59");
    expect(restartedPrompt).toContain("本地日期=2027-01-01");
    expect(restartedPrompt).toContain("本地时间=00:00:01");
  });

  it("enforces the trusted default-local policy when a model tries to create a Feishu task", async () => {
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const common = {
      title: "默认来源验收",
      notes: "",
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: null,
      dueAt: null,
      priority: "medium" as const,
      tags: [],
    };
    gateway.steps.push(
      toolCompletion(
        "task_create",
        { ...common, source: "feishu" },
        "wrong-external-source",
      ),
      (request) => {
        const sourceError = request.messages.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "wrong-external-source",
        );
        expect(sourceError?.content).toContain("AGENT_TASK_SOURCE_MISMATCH");
        return toolCompletion(
          "task_create",
          { ...common, source: "local" },
          "correct-local-source",
        );
      },
      finalCompletion("已创建到本地"),
    );

    await expect(
      harness.service.send({ message: "创建一个任务，标题是默认来源验收" }),
    ).resolves.toMatchObject({
      state: "partial",
      errorCode: "AGENT_TASK_SOURCE_MISMATCH",
    });
    const created = await harness.tasks.listTasks({ text: "默认来源验收" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ source: { type: "local" } });
  });

  it("continues a session-scoped ambiguous creation when the next reply is simply 本地", async () => {
    const sourcePolicies: AgentTaskSourcePolicy[] = [];
    const firstGateway = new ScriptedGateway([
      finalCompletion("请确认要创建到本地还是飞书。"),
    ]);
    const secondGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [firstGateway, secondGateway],
      sourcePolicies,
    });
    await configureAi(harness.settings);
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      modelDataScope: { ...current.modelDataScope, chatHistory: true },
    });

    const original =
      "创建一个本地任务并同步到飞书，标题是“Codex验收-来源澄清续写”";
    const conversationId = "b29ee329-fbf1-4a2c-b779-0b3f7adf92f7";
    await harness.service.send({ conversationId, message: original });

    secondGateway.steps.push(
      toolCompletion(
        "task_create",
        {
          title: "Codex验收-来源澄清续写",
          notes: "",
          source: "local",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "medium",
          tags: [],
        },
        "continued-local-create",
      ),
      finalCompletion("已创建到本地。"),
    );
    await expect(
      harness.service.send({ conversationId, message: "本地", history: [] }),
    ).resolves.toMatchObject({ state: "completed" });

    expect(sourcePolicies).toEqual([
      {
        kind: "clarification-required",
        reason: "conflicting-explicit-sources",
      },
      { kind: "explicit", source: "local" },
    ]);
    expect(JSON.stringify(secondGateway.requests[0].messages)).toContain(
      original,
    );
    await expect(
      harness.tasks.listTasks({ text: "Codex验收-来源澄清续写" }),
    ).resolves.toMatchObject([
      { source: { type: "local" } },
    ]);
  });

  it("treats a bare 飞书 selection as explicit Feishu rather than default-local", async () => {
    const sourcePolicies: AgentTaskSourcePolicy[] = [];
    const firstGateway = new ScriptedGateway([
      finalCompletion("请确认要创建到本地还是飞书。"),
    ]);
    const secondGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [firstGateway, secondGateway],
      sourcePolicies,
    });
    await configureAi(harness.settings);
    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      modelDataScope: { ...current.modelDataScope, chatHistory: true },
    });
    const conversationId = "5dd6c524-ac93-4ad8-8a7b-0b12e98266c1";
    await harness.service.send({
      conversationId,
      message: "创建一个本地任务并同步到飞书，标题是来源选择验收",
    });

    secondGateway.steps.push(
      toolCompletion(
        "task_create",
        {
          title: "来源选择验收",
          notes: "",
          // The model must not be allowed to turn the trusted choice into a
          // local write. The registry should reject this attempted fallback.
          source: "local",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "medium",
          tags: [],
        },
        "forbidden-local-fallback",
      ),
      finalCompletion("需要连接飞书。"),
    );
    const result = await harness.service.send({
      conversationId,
      message: "飞书",
      history: [],
    });

    expect(sourcePolicies.at(-1)).toEqual({
      kind: "explicit",
      source: "feishu",
    });
    expect(result).toMatchObject({
      state: "partial",
      errorCode: "AGENT_TASK_SOURCE_MISMATCH",
    });
    expect(await harness.tasks.listTasks({ text: "来源选择验收" })).toHaveLength(
      0,
    );
  });

  it("does not forward or guess pending task details when chat history is disabled", async () => {
    const sourcePolicies: AgentTaskSourcePolicy[] = [];
    const firstGateway = new ScriptedGateway([
      finalCompletion("请确认要创建到本地还是飞书。"),
    ]);
    const secondGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [firstGateway, secondGateway],
      sourcePolicies,
    });
    await configureAi(harness.settings);
    const original =
      "创建一个本地任务并同步到飞书，标题是隐私来源澄清不得外发";
    const conversationId = "a3f22d4c-652f-4d9f-9d5d-78d8f541e7b4";
    await harness.service.send({ conversationId, message: original });

    secondGateway.steps.push(
      toolCompletion(
        "task_create",
        {
          title: "模型不得猜测",
          notes: "",
          source: "local",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "medium",
          tags: [],
        },
        "details-unavailable-create",
      ),
      finalCompletion("请重新说明任务详情。"),
    );
    const result = await harness.service.send({
      conversationId,
      message: "本地",
      history: [{ role: "user", content: original }],
    });

    expect(sourcePolicies.at(-1)).toEqual({
      kind: "details-required",
      source: "local",
      reason: "chat-history-disabled",
    });
    expect(JSON.stringify(secondGateway.requests[0].messages)).not.toContain(
      original,
    );
    expect(result).toMatchObject({
      state: "partial",
      errorCode: "AGENT_TASK_SOURCE_CLARIFICATION_REQUIRED",
    });
    expect(await harness.tasks.listTasks({ text: "模型不得猜测" })).toHaveLength(0);
  });

  it("keeps an explicit Feishu request unavailable instead of silently creating a local fallback", async () => {
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    gateway.steps.push(
      toolCompletion(
        "task_create",
        {
          title: "不可用飞书验收",
          notes: "",
          source: "feishu",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "none",
          tags: [],
        },
        "unavailable-feishu-source",
      ),
      // A provider may make an unsupported success claim after a tool failure.
      // The trusted service result must preserve it only as unverified text.
      finalCompletion("已成功在飞书创建不可用飞书验收。"),
    );

    const output = await harness.service.send({
      message: "创建一个飞书任务，标题是不可用飞书验收",
    });
    expect(output).toMatchObject({
      state: "partial",
      errorCode: "AGENT_FEISHU_UNAVAILABLE",
      assistantText: expect.stringContaining("模型回复（未验证）"),
    });
    expect(output.assistantText).toContain("⚠️");
    expect(output.assistantText).toContain("未完全完成");
    expect(output.assistantText).toContain("AGENT_FEISHU_UNAVAILABLE");
    expect(output.assistantText).toContain("已成功在飞书创建不可用飞书验收。");

    expect(
      await harness.tasks.listTasks({
        text: "不可用飞书验收",
        includeDeleted: true,
      }),
    ).toHaveLength(0);
    const unavailable = gateway.requests[1].messages.find(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "unavailable-feishu-source",
    );
    expect(unavailable?.content).toContain("AGENT_FEISHU_UNAVAILABLE");
    expect(unavailable?.content).toContain("Do not create a local fallback task");
  });

  it("always returns a visible trusted next step when a Feishu tool-error turn ends blank", async () => {
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    gateway.steps.push(
      toolCompletion(
        "task_create",
        {
          title: "空白飞书错误回执",
          notes: "",
          source: "feishu",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "none",
          tags: [],
        },
        "blank-unavailable-feishu",
      ),
      // Some compatible providers end a failed tool turn with whitespace.
      // The service must not let that become an invisible Markdown message.
      finalCompletion(" \n\t "),
    );

    const output = await harness.service.send({
      message: "创建一个飞书任务，标题是空白飞书错误回执",
    });
    expect(output).toMatchObject({
      state: "partial",
      errorCode: "AGENT_FEISHU_UNAVAILABLE",
    });
    expect(output.assistantText).toContain("飞书任务尚未执行");
    expect(output.assistantText).toContain("重新连接飞书");
    expect(output.assistantText.trim()).not.toBe("");
  });

  it("does not queue a remote Agent mutation for a different connected Feishu account", async () => {
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [gateway],
      feishuAccountId: "account-current",
    });
    await configureAi(harness.settings);
    const task = (
      await harness.tasks.createTask({
        title: "跨账号 Agent 飞书更新",
        source: {
          type: "feishu",
          accountId: "account-other",
          externalId: "remote-cross-account",
        },
        sync: { status: "synced" },
      })
    ).task;
    gateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(task.id, "不应写入的跨账号标题"),
        "cross-account-update",
      ),
      finalCompletion("  "),
    );

    const output = await harness.service.send({ message: "更新这项飞书任务" });
    expect(output).toMatchObject({
      state: "partial",
      errorCode: "AGENT_FEISHU_ACCOUNT_MISMATCH",
    });
    expect(output.assistantText).toContain("账号不一致");
    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      title: "跨账号 Agent 飞书更新",
      sync: { status: "synced" },
    });
  });

  it("replaces a model's Feishu success claim with the trusted pending create receipt", async () => {
    const approvals: AgentApprovalView[] = [];
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [gateway],
      approvals,
      feishuAccountId: "account-primary",
    });
    await configureAi(harness.settings);
    gateway.steps.push(
      toolCompletion(
        "task_create",
        {
          title: "Codex验收-Agent 飞书同步回执",
          notes: "",
          source: "feishu",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "medium",
          tags: [],
        },
        "feishu-create-receipt",
      ),
      finalCompletion("已同步到飞书，任务已经可见。"),
    );

    const pending = harness.service.send({
      message: "创建一个飞书任务，标题是 Codex验收-Agent 飞书同步回执",
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(harness.service.respondToApproval(approvals[0].approvalId, "once")).toBe(
      true,
    );
    const output = await pending;
    expect(output).toMatchObject({
      state: "completed",
      assistantText: expect.stringContaining("同步状态仅以系统回执为准"),
      feishuSyncReceipts: [{ action: "created", status: "pending" }],
    });
    expect(output.assistantText).not.toContain("已同步到飞书，任务已经可见");
    expect(
      await harness.tasks.listTasks({
        text: "Codex验收-Agent 飞书同步回执",
        sourceTypes: ["feishu"],
      }),
    ).toMatchObject([{ sync: { status: "pending" } }]);
  });

  it("uses the trusted pending receipt when completing a Feishu task", async () => {
    const approvals: AgentApprovalView[] = [];
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway], approvals });
    await configureAi(harness.settings);
    const task = (
      await harness.tasks.createTask({
        title: "Codex验收-Agent 飞书完成回执",
        source: {
          type: "feishu",
          accountId: "account-primary",
          externalId: "remote-complete-receipt",
        },
        sync: { status: "synced" },
      })
    ).task;
    gateway.steps.push(
      toolCompletion(
        "task_set_completed",
        { id: task.id, completed: true },
        "feishu-complete-receipt",
      ),
      finalCompletion("飞书任务已完成并同步成功。"),
    );

    const pending = harness.service.send({ message: "完成飞书任务" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    harness.service.respondToApproval(approvals[0].approvalId, "once");
    const output = await pending;
    expect(output).toMatchObject({
      state: "completed",
      feishuSyncReceipts: [
        { taskId: task.id, action: "completed", status: "pending" },
      ],
    });
    expect(output.assistantText).not.toContain("同步成功");
    expect(output.assistantText).toContain("同步状态仅以系统回执为准");
  });

  it("discloses and reports the inverse Feishu sync when Agent undoes a remote update", async () => {
    const approvals: AgentApprovalView[] = [];
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway], approvals });
    await configureAi(harness.settings);
    const task = (
      await harness.tasks.createTask({
        title: "Codex验收-Agent 撤销飞书更新原值",
        source: {
          type: "feishu",
          accountId: "account-primary",
          externalId: "remote-undo-update-receipt",
        },
        sync: { status: "synced" },
      })
    ).task;
    const mutation = await harness.tasks.updateTask(task.id, {
      title: "Codex验收-Agent 撤销飞书更新临时值",
    });
    gateway.steps.push(
      toolCompletion(
        "undo_task_operation",
        { operationId: mutation.operationId },
        "feishu-undo-update-receipt",
      ),
      finalCompletion("已恢复原值且已同步到飞书。"),
    );

    const pending = harness.service.send({ message: "撤销刚才的飞书任务修改" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({
      toolName: "undo_task_operation",
      effects: {
        risk: "R2",
        network: ["Feishu Task v2 on next sync"],
        externalEffects: [
          `update Feishu task ${task.id} on next sync`,
        ],
        preview: {
          willSyncFeishu: true,
          feishuSync: [{ taskId: task.id, action: "updated" }],
        },
      },
    });
    expect(harness.service.respondToApproval(approvals[0].approvalId, "once")).toBe(
      true,
    );
    const output = await pending;

    expect(output).toMatchObject({
      state: "completed",
      feishuSyncReceipts: [
        { taskId: task.id, action: "updated", status: "pending" },
      ],
    });
    expect(output.assistantText).toContain("同步状态仅以系统回执为准");
    expect(output.assistantText).not.toContain("已恢复原值且已同步到飞书");
    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      title: "Codex验收-Agent 撤销飞书更新原值",
      sync: { status: "pending" },
    });
  });

  it("returns a pending Feishu delete receipt when Agent undoes a Feishu create", async () => {
    const approvals: AgentApprovalView[] = [];
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway], approvals });
    await configureAi(harness.settings);
    const created = await harness.tasks.createTask({
      title: "Codex验收-Agent 撤销飞书创建",
      source: {
        type: "feishu",
        accountId: "account-primary",
        externalId: "remote-undo-create-receipt",
      },
      sync: { status: "pending" },
    });
    gateway.steps.push(
      toolCompletion(
        "undo_task_operation",
        { operationId: created.operationId },
        "feishu-undo-create-receipt",
      ),
      finalCompletion("已删除飞书任务。"),
    );

    const pending = harness.service.send({ message: "撤销刚才创建的飞书任务" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({
      toolName: "undo_task_operation",
      effects: {
        network: ["Feishu Task v2 on next sync"],
        externalEffects: [
          `delete Feishu task ${created.task.id} on next sync`,
        ],
        preview: {
          willSyncFeishu: true,
          feishuSync: [{ taskId: created.task.id, action: "deleted" }],
        },
      },
    });
    expect(harness.service.respondToApproval(approvals[0].approvalId, "once")).toBe(
      true,
    );
    const output = await pending;

    expect(output).toMatchObject({
      state: "completed",
      feishuSyncReceipts: [
        { taskId: created.task.id, action: "deleted", status: "pending" },
      ],
    });
    expect(output.assistantText).not.toContain("已删除飞书任务");
    expect(await harness.tasks.getTask(created.task.id, true)).toMatchObject({
      deletedAt: expect.any(String),
      sync: { status: "pending" },
    });
  });

  it("forwards correlated model deltas and records usage for a streamed Agent reply", async () => {
    const events: AgentRunEvent[] = [];
    const gateway: ModelGatewayLike = {
      complete: async (_request, _signal, onTextDelta) => {
        onTextDelta?.("## 实时");
        onTextDelta?.("回答\n\n- 完成");
        return {
          ...finalCompletion("## 实时回答\n\n- 完成"),
          usage: { totalTokens: 17 },
        };
      },
    };
    const harness = await createHarness({ gateways: [gateway], events });
    await configureAi(harness.settings);

    const output = await harness.service.send({
      runId: "ad597710-e052-4ee4-881c-412f3416c224",
      message: "请流式回答",
    });

    expect(output).toMatchObject({
      runId: "ad597710-e052-4ee4-881c-412f3416c224",
      state: "completed",
      assistantText: "## 实时回答\n\n- 完成",
    });
    expect(
      events
        .filter((event) => event.type === "model-delta")
        .map((event) => event.payload),
    ).toEqual([
      { turn: 0, delta: "## 实时" },
      { turn: 0, delta: "回答\n\n- 完成" },
    ]);
    expect(events.every((event) => event.runId === output.runId)).toBe(true);
    await expect(harness.service.modelUsage()).resolves.toMatchObject({
      usedTokens: 17,
      reportedRequestCount: 1,
      unreportedRequestCount: 0,
      blocked: false,
    });
  });

  it("does not poison the daily budget when a custom streaming provider omits usage", async () => {
    const gateway: ModelGatewayLike = {
      complete: async (_request, _signal, onTextDelta) => {
        onTextDelta?.("部分回答");
        return {
          id: "missing-stream-usage",
          assistantMessage: { role: "assistant", content: "部分回答" },
          toolCalls: [],
          finishReason: "stop",
        };
      },
    };
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);

    await expect(
      harness.service.send({ message: "用量缺失测试" }),
    ).resolves.toMatchObject({
      state: "failed",
      errorCode: "STREAM_USAGE_UNAVAILABLE",
    });
    await expect(harness.service.modelUsage()).resolves.toMatchObject({
      accounting: "none",
      reportedRequestCount: 0,
      unreportedRequestCount: 0,
      blocked: false,
    });
  });

  it("reports stable errors for every incomplete AI configuration state", async () => {
    const { service, settings } = await createHarness();

    expect(service.status()).toMatchObject({
      enabled: false,
      configured: false,
    });
    await expect(service.send({ message: "hello" })).rejects.toMatchObject({
      name: "AI_DISABLED",
      message: "AI_DISABLED",
    });

    let current = settings.get();
    await settings.replace({
      ...current,
      ai: { ...current.ai, enabled: true },
    });
    await expect(service.send({ message: "hello" })).rejects.toMatchObject({
      name: "AI_MODEL_NOT_CONFIGURED",
    });

    current = settings.get();
    await settings.replace({
      ...current,
      ai: { ...current.ai, model: "test-model" },
    });
    await expect(service.send({ message: "hello" })).rejects.toMatchObject({
      name: "AI_CREDENTIAL_NOT_CONFIGURED",
    });

    current = settings.get();
    await settings.replace({
      ...current,
      ai: { ...current.ai, credentialId: "missing-credential" },
    });
    expect(service.status().configured).toBe(false);
    await expect(service.send({ message: "hello" })).rejects.toMatchObject({
      name: "AI_CREDENTIAL_UNAVAILABLE",
      message: "AI_CREDENTIAL_UNAVAILABLE",
    });
  });

  it("executes native tool_calls across task CRUD and preserves provider call IDs", async () => {
    const gateway = new ScriptedGateway([]);
    const approvals: AgentApprovalView[] = [];
    const harness = await createHarness({ gateways: [gateway], approvals });
    await configureAi(harness.settings);
    const existing = (await harness.tasks.createTask({ title: "旧标题" })).task;

    gateway.steps.push(
      toolCompletion("task_get", { id: existing.id }, "call-get"),
      toolCompletion(
        "task_update",
        updateArgs(existing.id, "新标题"),
        "call-update",
      ),
      toolCompletion(
        "task_set_completed",
        { id: existing.id, completed: true },
        "call-complete",
      ),
      toolCompletion("task_move_to_trash", { id: existing.id }, "call-trash"),
      toolCompletion("task_restore", { id: existing.id }, "call-restore"),
      toolCompletion(
        "task_create",
        {
          title: "新建任务",
          notes: "",
          source: "local",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "high",
          tags: ["agent"],
        },
        "call-create",
      ),
      toolCompletion(
        "task_list",
        {
          view: null,
          text: "新建任务",
          source: null,
          limit: 20,
        },
        "call-list",
      ),
      finalCompletion("CRUD 已完成"),
    );

    const pendingResponse = harness.service.send({
      message: "完成一组任务修改",
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({
      toolName: "task_move_to_trash",
      effects: { risk: "R2" },
    });
    harness.service.respondToApproval(approvals[0].approvalId, "once");
    const response = await pendingResponse;

    expect(response).toMatchObject({
      state: "completed",
      assistantText: "CRUD 已完成",
    });
    const changed = await harness.tasks.getTask(existing.id, true);
    expect(changed).toMatchObject({ title: "新标题", status: "completed" });
    expect(changed?.deletedAt).toBeUndefined();
    const created = await harness.tasks.listTasks({ text: "新建任务" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      source: { type: "local" },
      sync: { status: "local" },
    });

    const lastRequest = gateway.requests.at(-1)!;
    const toolMessageIds = lastRequest.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id);
    expect(toolMessageIds).toEqual([
      "call-get",
      "call-update",
      "call-complete",
      "call-trash",
      "call-restore",
      "call-create",
      "call-list",
    ]);
    const assistantCallIds = lastRequest.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []);
    expect(assistantCallIds).toEqual(toolMessageIds);
  });

  it("drives a natural-language local task through create, query, update, complete, and reopen without UTC or duplicate-task drift", async () => {
    const title = "Codex验收-自然语言本地生命周期";
    const createdTitle = `${title}-已更新`;
    const now = new Date("2026-01-01T16:00:00.000Z");
    const createGateway = new ScriptedGateway([]);
    const queryGateway = new ScriptedGateway([]);
    const updateGateway = new ScriptedGateway([]);
    const completeGateway = new ScriptedGateway([]);
    const reopenGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [
        createGateway,
        queryGateway,
        updateGateway,
        completeGateway,
        reopenGateway,
      ],
      now: () => new Date(now),
      timeZone: () => "America/Los_Angeles",
    });
    await configureAi(harness.settings);

    createGateway.steps.push(
      (request) => {
        const system = request.messages.find(
          (message) => message.role === "system",
        )?.content;
        expect(system).toContain("本地日期=2026-01-01");
        expect(system).toContain("时区=America/Los_Angeles");
        expect(system).toContain("明确要求创建本地任务");
        expect(system).toContain("不得把“周末”擅自设为周六或周日");
        expect(request.messages.at(-1)).toEqual({
          role: "user",
          content:
            `创建一个本地任务，标题是“${title}”，今天安排处理，明天下午六点截止，` +
            "备注是“提交前检查格式和附件”，优先级设为高，标签是“验收”和“产品”，项目是“Todo Agent”。",
        });
        return toolCompletion(
          "task_create",
          {
            title,
            notes: "提交前检查格式和附件",
            source: "local",
            projectId: "Todo Agent",
            listId: null,
            plannedDate: "2026-01-01",
            startAt: "2026-01-01T09:00:00-08:00",
            dueAt: "2026-01-02T18:00:00-08:00",
            priority: "high",
            tags: ["验收", "产品"],
          },
          "natural-local-create",
        );
      },
      finalCompletion("已创建到本地：今天处理，截止时间为 2026-01-02 18:00（America/Los_Angeles）。"),
    );

    const createdRun = await harness.service.send({
      message:
        `创建一个本地任务，标题是“${title}”，今天安排处理，明天下午六点截止，` +
        "备注是“提交前检查格式和附件”，优先级设为高，标签是“验收”和“产品”，项目是“Todo Agent”。",
    });
    expect(createdRun).toMatchObject({
      state: "completed",
      assistantText: expect.stringContaining("已创建到本地"),
    });
    const [created] = await harness.tasks.listTasks({ text: title });
    if (!created) throw new Error("Expected the Agent-created local task.");
    expect(created).toMatchObject({
      source: { type: "local" },
      notes: "提交前检查格式和附件",
      projectId: "Todo Agent",
      plannedDate: "2026-01-01",
      startAt: "2026-01-01T09:00:00-08:00",
      dueAt: "2026-01-02T18:00:00-08:00",
      priority: "high",
      tags: ["验收", "产品"],
    });
    expect(
      await harness.tasks.listTasks({ text: title, sourceTypes: ["feishu"] }),
    ).toHaveLength(0);

    queryGateway.steps.push(
      (request) => {
        expect(request.messages.at(-1)).toEqual({
          role: "user",
          content: `请查询我刚创建的 ${title}，告诉我它的来源、备注、计划时间、开始时间、截止时间和优先级。`,
        });
        return toolCompletion(
          "task_list",
          { view: null, text: title, source: "local", limit: 20 },
          "natural-local-query",
        );
      },
      finalCompletion(
        "## 查询结果\n\n| 来源 | 优先级 |\n| --- | --- |\n| 本地 | 高 |",
      ),
    );
    const queriedRun = await harness.service.send({
      message: `请查询我刚创建的 ${title}，告诉我它的来源、备注、计划时间、开始时间、截止时间和优先级。`,
    });
    expect(queriedRun).toMatchObject({
      state: "completed",
      assistantText: expect.stringContaining("| 来源 |"),
    });
    expect(
      queryGateway.requests.at(-1)?.messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "natural-local-query" &&
          message.content.includes(title),
      ),
    ).toBe(true);

    updateGateway.steps.push(
      toolCompletion(
        "task_update",
        {
          id: created.id,
          title: createdTitle,
          notes: "提交前检查格式和附件；需要完成 UI、交互和功能评审。",
          privateNotes: null,
          projectId: null,
          listId: null,
          plannedDate: "2026-01-02",
          startAt: null,
          dueAt: null,
          priority: "urgent",
          tags: null,
          clearFields: [],
        },
        "natural-local-update",
      ),
      finalCompletion("已更新：优先级为紧急，并安排到明天。"),
    );
    const updatedRun = await harness.service.send({
      message:
        `把 ${title} 的标题改成“${createdTitle}”，优先级改成紧急，安排到明天，` +
        "并在备注中补充：需要完成 UI、交互和功能评审。",
    });
    expect(updatedRun).toMatchObject({ state: "completed" });
    expect(await harness.tasks.getTask(created.id)).toMatchObject({
      title: createdTitle,
      notes: "提交前检查格式和附件；需要完成 UI、交互和功能评审。",
      plannedDate: "2026-01-02",
      priority: "urgent",
      startAt: "2026-01-01T09:00:00-08:00",
      dueAt: "2026-01-02T18:00:00-08:00",
    });

    completeGateway.steps.push(
      toolCompletion(
        "task_set_completed",
        { id: created.id, completed: true },
        "natural-local-complete",
      ),
      finalCompletion("已完成这项本地任务。"),
    );
    await expect(
      harness.service.send({ message: `完成 ${createdTitle}。` }),
    ).resolves.toMatchObject({ state: "completed" });
    expect(await harness.tasks.getTask(created.id)).toMatchObject({
      status: "completed",
    });

    reopenGateway.steps.push(
      toolCompletion(
        "task_set_completed",
        { id: created.id, completed: false },
        "natural-local-reopen",
      ),
      finalCompletion("已重新打开这项本地任务。"),
    );
    await expect(
      harness.service.send({ message: `重新打开 ${createdTitle}。` }),
    ).resolves.toMatchObject({ state: "completed" });
    expect(await harness.tasks.getTask(created.id)).toMatchObject({
      status: "open",
      title: createdTitle,
      sync: { status: "local" },
    });
    expect(await harness.tasks.listTasks({ text: title })).toHaveLength(1);
  });

  it("replays a provider-retried natural-language task creation as one local task", async () => {
    const title = "Codex验收-重试不重复创建";
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const args = {
      title,
      notes: "",
      source: "local" as const,
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: null,
      dueAt: null,
      priority: "medium" as const,
      tags: [],
    };
    gateway.steps.push(
      toolCompletion("task_create", args, "replayed-local-create"),
      toolCompletion("task_create", args, "replayed-local-create"),
      finalCompletion("已在本地创建一项任务。"),
    );

    await expect(
      harness.service.send({
        message: `创建一个本地任务，标题是“${title}”。`,
      }),
    ).resolves.toMatchObject({ state: "completed" });
    const matches = await harness.tasks.listTasks({ text: title });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ source: { type: "local" } });
    const replayedToolMessage = gateway.requests[2].messages.find(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "replayed-local-create",
    );
    expect(replayedToolMessage?.content).toContain("\"ok\":true");
    expect(
      (await harness.auditLog.records()).some(
        (record) => record.event === "tool.execution.replayed",
      ),
    ).toBe(true);
  });

  it("does not duplicate a natural-language task when a streamed tool loop repeats create with a fresh provider call ID", async () => {
    const title = "Codex验收-流式循环创建不重复";
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const args = {
      title,
      notes: "",
      source: "local" as const,
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: null,
      dueAt: null,
      priority: "medium" as const,
      tags: [],
    };
    gateway.steps.push(
      toolCompletion("task_create", args, "stream-create-first"),
      toolCompletion("task_create", args, "stream-create-repeat"),
      finalCompletion("已在本地创建一项任务。"),
    );

    await expect(
      harness.service.send({
        message: `创建一个本地任务，标题是“${title}”。`,
      }),
    ).resolves.toMatchObject({ state: "completed" });

    const matches = await harness.tasks.listTasks({ text: title });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ source: { type: "local" } });
    const replayedToolMessage = gateway.requests[2].messages.find(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "stream-create-repeat",
    );
    expect(replayedToolMessage?.content).toContain("\"ok\":true");
  });

  it("does not duplicate a natural-language batch when a streamed loop repeats it with a fresh provider call ID", async () => {
    const prefix = "Codex验收-流式批量创建不重复";
    const approvals: AgentApprovalView[] = [];
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway], approvals });
    await configureAi(harness.settings);
    const args = {
      tasks: [
        {
          title: `${prefix}-一`,
          notes: "",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "high" as const,
          tags: ["验收"],
        },
        {
          title: `${prefix}-二`,
          notes: "",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "medium" as const,
          tags: ["验收"],
        },
      ],
    };
    gateway.steps.push(
      toolCompletion("task_bulk_create", args, "stream-bulk-first"),
      toolCompletion("task_bulk_create", args, "stream-bulk-repeat"),
      finalCompletion("已在本地创建两项任务。"),
    );

    const run = harness.service.send({
      message: "请批量创建两个本地任务，用于流式重试验收。",
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0].toolName).toBe("task_bulk_create");
    expect(harness.service.respondToApproval(approvals[0].approvalId, "once")).toBe(
      true,
    );
    await expect(run).resolves.toMatchObject({ state: "completed" });

    const matches = await harness.tasks.listTasks({ text: prefix });
    expect(matches.map((task) => task.title).sort()).toEqual([
      `${prefix}-一`,
      `${prefix}-二`,
    ]);
    // The retried call uses a new provider call ID, but must reuse the trusted
    // first receipt rather than request another approval or create another batch.
    expect(approvals).toHaveLength(1);
    const replayedToolMessage = gateway.requests[2].messages.find(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "stream-bulk-repeat",
    );
    expect(replayedToolMessage?.content).toContain("\"ok\":true");
  });

  it("lets the model correct malformed batch arguments instead of failing the run", async () => {
    const approvals: AgentApprovalView[] = [];
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway], approvals });
    await configureAi(harness.settings);
    const one = (await harness.tasks.createTask({ title: "批量修正一" })).task;
    const two = (await harness.tasks.createTask({ title: "批量修正二" })).task;
    const validUpdate = (id: string): AgentJsonValue => ({
      id,
      title: null,
      notes: null,
      privateNotes: null,
      projectId: null,
      listId: null,
      plannedDate: null,
      startAt: null,
      dueAt: null,
      priority: "low",
      tags: null,
      clearFields: [],
    });
    gateway.steps.push(
      toolCompletion(
        "task_bulk_update",
        {
          // DeepSeek-compatible endpoints sometimes omit required nullable
          // fields on their first attempt. The runtime must return a tool error
          // so the model can repair the call.
          updates: [{ id: one.id, priority: "low" }],
        },
        "call-malformed-batch",
      ),
      (request) => {
        const errorOutput = request.messages.find(
          (message) =>
            message.role === "tool" &&
            message.tool_call_id === "call-malformed-batch",
        );
        expect(errorOutput?.content).toContain("INVALID_TOOL_ARGUMENTS");
        return toolCompletion(
          "task_bulk_update",
          { updates: [validUpdate(one.id), validUpdate(two.id)] },
          "call-corrected-batch",
        );
      },
      finalCompletion("已批量修正"),
    );

    const run = harness.service.send({ message: "把这两项优先级批量改低" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0].toolName).toBe("task_bulk_update");
    harness.service.respondToApproval(approvals[0].approvalId, "once");
    await expect(run).resolves.toMatchObject({
      state: "partial",
      errorCode: "INVALID_TOOL_ARGUMENTS",
      assistantText: expect.stringContaining("模型回复（未验证）"),
    });
    expect(await harness.tasks.getTask(one.id)).toMatchObject({ priority: "low" });
    expect(await harness.tasks.getTask(two.id)).toMatchObject({ priority: "low" });
    expect(
      (await harness.auditLog.records()).some(
        (record) =>
          record.event === "tool.preparation.failed" &&
          record.toolName === "task_bulk_update" &&
          record.policyReason === "INVALID_TOOL_ARGUMENTS",
      ),
    ).toBe(true);
  });

  it("keeps R2 actions pending until an explicit allow or reject decision", async () => {
    const approvals: AgentApprovalView[] = [];
    const allowGateway = new ScriptedGateway([]);
    const denyGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [allowGateway, denyGateway],
      approvals,
    });
    await configureAi(harness.settings);
    const task = (
      await harness.tasks.createTask({
        title: "飞书原标题",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-1",
        },
        sync: { status: "synced" },
      })
    ).task;
    allowGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(task.id, "允许后的标题"),
        "call-allow",
      ),
      finalCompletion("已允许"),
    );
    denyGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(task.id, "不应写入的标题"),
        "call-deny",
      ),
      finalCompletion("已拒绝"),
    );

    const allowing = harness.service.send({ message: "更新飞书任务" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(harness.service.status()).toMatchObject({
      activeRunIds: [approvals[0].runId],
      pendingApprovals: [
        expect.objectContaining({ approvalId: approvals[0].approvalId }),
      ],
    });
    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      title: "飞书原标题",
    });
    expect(
      harness.service.respondToApproval(approvals[0].approvalId, "once"),
    ).toBe(true);
    const allowingResult = await allowing;
    expect(allowingResult).toMatchObject({
      state: "completed",
      assistantText: expect.stringContaining("同步状态仅以系统回执为准"),
      feishuSyncReceipts: [
        { taskId: task.id, action: "updated", status: "pending" },
      ],
    });
    expect(allowingResult.assistantText).not.toContain("已允许");
    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      title: "允许后的标题",
    });

    const denying = harness.service.send({ message: "再次更新飞书任务" });
    await vi.waitFor(() => expect(approvals).toHaveLength(2));
    expect(
      harness.service.respondToApproval(approvals[1].approvalId, "deny"),
    ).toBe(true);
    expect(await denying).toMatchObject({
      state: "partial",
      errorCode: "USER_DENIED",
      assistantText: expect.stringContaining("模型回复（未验证）"),
    });
    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      title: "允许后的标题",
    });
    const denialToolMessage = denyGateway.requests[1].messages.find(
      (message) => message.role === "tool",
    );
    expect(denialToolMessage?.content).toContain("USER_DENIED");
    expect(
      (await harness.auditLog.records()).some(
        (record) =>
          record.event === "tool.denied" &&
          record.policyReason === "USER_DENIED",
      ),
    ).toBe(true);
  });

  it("cancels an in-flight model request by exact run ID", async () => {
    let requestStarted = false;
    const blockingGateway: ModelGatewayLike = {
      complete: async (_request, signal) => {
        requestStarted = true;
        return new Promise<ModelCompletion>((_resolve, reject) => {
          const abort = () => reject(signal?.reason ?? new Error("ABORTED"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const harness = await createHarness({ gateways: [blockingGateway] });
    await configureAi(harness.settings);

    const running = harness.service.send({ message: "等待模型" });
    await vi.waitFor(() => expect(requestStarted).toBe(true));
    const [runId] = harness.service.status().activeRunIds;
    expect(runId).toBeTruthy();
    expect(harness.service.stop(runId)).toBe(1);
    expect(await running).toMatchObject({
      runId,
      state: "cancelled",
      errorCode: "AGENT_STOPPED",
    });
    expect(harness.service.status()).toMatchObject({
      activeRunIds: [],
      pendingApprovals: [],
    });
  });

  it("cancels a pending approval without executing the reviewed mutation", async () => {
    const approvals: AgentApprovalView[] = [];
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway], approvals });
    await configureAi(harness.settings);
    const task = (
      await harness.tasks.createTask({
        title: "停止前标题",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "stop-approval",
        },
        sync: { status: "synced" },
      })
    ).task;
    gateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(task.id, "不应执行"),
        "call-stop-approval",
      ),
      finalCompletion(),
    );

    const running = harness.service.send({ message: "等待审批时停止" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(harness.service.stop(approvals[0].runId)).toBe(1);
    expect(await running).toMatchObject({
      state: "cancelled",
      errorCode: "AGENT_STOPPED",
    });
    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      title: "停止前标题",
    });
    expect(
      harness.service.respondToApproval(approvals[0].approvalId, "once"),
    ).toBe(false);
    expect(harness.service.status()).toMatchObject({
      activeRunIds: [],
      pendingApprovals: [],
    });
  });

  it("uses a credential only in the HTTP authorization header, never model messages or audit", async () => {
    const secret = "credential-UNIQUE-7YQwVmZx2L";
    let requestBody = "";
    let authorization = "";
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            id: "response-1",
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "安全完成" },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness({
      fileAudit: true,
      gatewayFactory: undefined,
    });
    await configureAi(harness.settings, { secret });

    // Recreate with the default gateway rather than the harness queue factory.
    const service = new AgentDesktopService({
      settings: harness.settings,
      auditLog: harness.auditLog,
      usageBudget: harness.usageBudget,
      listMorningTasks: () => harness.tasks.listTasks({ view: "today" }),
      createToolRegistry: () => new ToolRegistry(),
    });
    expect(service.status().configured).toBe(true);
    expect(
      await service.send({
        message: "不要泄露凭据",
        history: [{ role: "assistant", content: "历史消息" }],
      }),
    ).toMatchObject({ state: "completed", assistantText: "安全完成" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(requestBody).not.toContain(secret);
    expect(requestBody).not.toContain("历史消息");
    expect(JSON.stringify(await service.audit())).not.toContain(secret);
    expect(
      await readFile(harness.fileAuditStore!.filePath, "utf8"),
    ).not.toContain(secret);
    expect(await harness.auditLog.verify()).toEqual({ valid: true });
  });

  it("sends prior chat history only when its model data scope is enabled", async () => {
    const hiddenGateway = new ScriptedGateway([finalCompletion()]);
    const allowedGateway = new ScriptedGateway([finalCompletion()]);
    const harness = await createHarness({
      gateways: [hiddenGateway, allowedGateway],
    });
    await configureAi(harness.settings);

    await harness.service.send({
      message: "当前问题",
      history: [{ role: "user", content: "默认不得发送的历史" }],
    });
    expect(JSON.stringify(hiddenGateway.requests[0].messages)).not.toContain(
      "默认不得发送的历史",
    );

    const current = harness.settings.get();
    await harness.settings.replace({
      ...current,
      modelDataScope: { ...current.modelDataScope, chatHistory: true },
    });
    await harness.service.send({
      message: "当前问题",
      history: [{ role: "user", content: "明确允许发送的历史" }],
    });
    expect(JSON.stringify(allowedGateway.requests[0].messages)).toContain(
      "明确允许发送的历史",
    );
  });

  it("redacts task notes from the audit chain while applying the local mutation", async () => {
    const privateNote = "private-note-UNIQUE-P8vL3sQ";
    const gateway = new ScriptedGateway([]);
    const harness = await createHarness({ gateways: [gateway] });
    await configureAi(harness.settings);
    const task = (await harness.tasks.createTask({ title: "私密任务" })).task;
    gateway.steps.push(
      toolCompletion(
        "task_update",
        {
          id: task.id,
          title: null,
          notes: null,
          privateNotes: privateNote,
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: null,
          tags: null,
          clearFields: [],
        },
        "call-private-note",
      ),
      finalCompletion(),
    );

    await harness.service.send({ message: "保存私人备注" });

    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      privateNotes: privateNote,
    });
    const audit = JSON.stringify(await harness.auditLog.records());
    expect(audit).not.toContain(privateNote);
    expect(audit).toContain("[REDACTED]");
  });

  it("honors only exact Full Access scopes and reports unavailable Feishu creation without a local fallback", async () => {
    const approvals: AgentApprovalView[] = [];
    const scopedGateway = new ScriptedGateway([]);
    const outOfScopeGateway = new ScriptedGateway([]);
    const forbiddenGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [scopedGateway, outOfScopeGateway, forbiddenGateway],
      approvals,
    });
    await configureAi(harness.settings, { permissionMode: "full-access" });
    const first = (
      await harness.tasks.createTask({
        title: "范围内",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-a",
        },
        sync: { status: "synced" },
      })
    ).task;
    const second = (
      await harness.tasks.createTask({
        title: "范围外",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "remote-b",
        },
        sync: { status: "synced" },
      })
    ).task;
    const authenticatedAt = new Date().toISOString();
    harness.service.createFullAccessLease(
      {
        durationMinutes: 5,
        scopes: [
          {
            toolName: "task_update",
            risks: ["R2"],
            targets: [{ kind: "task", value: first.id }],
          },
        ],
      },
      authenticatedAt,
    );

    scopedGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(first.id, "范围内已更新"),
        "call-scoped",
      ),
      finalCompletion(),
    );
    outOfScopeGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(second.id, "范围外不应更新"),
        "call-outside",
      ),
      finalCompletion(),
    );
    forbiddenGateway.steps.push(
      toolCompletion(
        "task_create",
        {
          title: "无账户飞书孤儿任务",
          notes: "",
          source: "feishu",
          projectId: null,
          listId: null,
          plannedDate: null,
          startAt: null,
          dueAt: null,
          priority: "none",
          tags: [],
        },
        "call-unavailable-feishu",
      ),
      finalCompletion(),
    );

    expect(
      await harness.service.send({ message: "更新范围内任务" }),
    ).toMatchObject({ state: "completed" });
    expect(approvals).toHaveLength(0);
    expect(await harness.tasks.getTask(first.id)).toMatchObject({
      title: "范围内已更新",
    });

    const outsideRun = harness.service.send({ message: "更新范围外任务" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0].effects.targets).toEqual([
      { kind: "task", value: second.id },
    ]);
    harness.service.respondToApproval(approvals[0].approvalId, "deny");
    await outsideRun;
    expect(await harness.tasks.getTask(second.id)).toMatchObject({
      title: "范围外",
    });

    expect(
      await harness.service.send({ message: "创建飞书任务" }),
    ).toMatchObject({
      state: "partial",
      errorCode: "AGENT_FEISHU_UNAVAILABLE",
    });
    expect(approvals).toHaveLength(1);
    expect(
      await harness.tasks.listTasks({
        text: "无账户飞书孤儿任务",
        includeDeleted: true,
      }),
    ).toHaveLength(0);
    const forbiddenMessage = forbiddenGateway.requests[1].messages.find(
      (message) => message.role === "tool",
    );
    expect(forbiddenMessage?.content).toContain("AGENT_FEISHU_UNAVAILABLE");
    expect(
      (await harness.auditLog.records()).some(
        (record) =>
          record.toolName === "task_create" &&
          record.event === "tool.preparation.failed" &&
          record.policyReason === "AGENT_FEISHU_UNAVAILABLE",
      ),
    ).toBe(true);
  });

  it("isolates approvals, cancellation state, and mutations between parallel runs", async () => {
    const approvals: AgentApprovalView[] = [];
    const firstGateway = new ScriptedGateway([]);
    const secondGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [firstGateway, secondGateway],
      approvals,
    });
    await configureAi(harness.settings);
    const first = (
      await harness.tasks.createTask({
        title: "并行 A",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "parallel-a",
        },
        sync: { status: "synced" },
      })
    ).task;
    const second = (
      await harness.tasks.createTask({
        title: "并行 B",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "parallel-b",
        },
        sync: { status: "synced" },
      })
    ).task;
    firstGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(first.id, "并行 A 已允许"),
        "parallel-call-a",
      ),
      finalCompletion("A 完成"),
    );
    secondGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(second.id, "并行 B 不应写入"),
        "parallel-call-b",
      ),
      finalCompletion("B 拒绝"),
    );

    const firstRun = harness.service.send({ message: "并行更新 A" });
    const secondRun = harness.service.send({ message: "并行更新 B" });
    await vi.waitFor(() => expect(approvals).toHaveLength(2));
    const firstApproval = approvals.find((approval) =>
      approval.effects.targets.some(
        (target) => target.kind === "task" && target.value === first.id,
      ),
    )!;
    const secondApproval = approvals.find((approval) =>
      approval.effects.targets.some(
        (target) => target.kind === "task" && target.value === second.id,
      ),
    )!;
    expect(firstApproval.runId).not.toBe(secondApproval.runId);

    expect(
      harness.service.respondToApproval(firstApproval.approvalId, "once"),
    ).toBe(true);
    const firstResult = await firstRun;
    expect(firstResult).toMatchObject({
      runId: firstApproval.runId,
      state: "completed",
    });
    expect(harness.service.status()).toMatchObject({
      activeRunIds: [secondApproval.runId],
      pendingApprovals: [
        expect.objectContaining({ approvalId: secondApproval.approvalId }),
      ],
    });
    expect(await harness.tasks.getTask(first.id)).toMatchObject({
      title: "并行 A 已允许",
    });
    expect(await harness.tasks.getTask(second.id)).toMatchObject({
      title: "并行 B",
    });

    expect(
      harness.service.respondToApproval(secondApproval.approvalId, "deny"),
    ).toBe(true);
    const secondResult = await secondRun;
    expect(secondResult).toMatchObject({
      runId: secondApproval.runId,
      state: "partial",
      errorCode: "USER_DENIED",
    });
    expect(await harness.tasks.getTask(second.id)).toMatchObject({
      title: "并行 B",
    });
    expect(harness.service.status()).toMatchObject({
      activeRunIds: [],
      pendingApprovals: [],
    });

    const records = await harness.auditLog.records();
    for (const runId of [firstResult.runId, secondResult.runId]) {
      expect(
        records
          .filter((record) => record.runId === runId)
          .map((record) => record.event),
      ).toEqual(
        expect.arrayContaining([
          "run.started",
          "tool.proposed",
          "approval.requested",
          "approval.decided",
          "run.finished",
        ]),
      );
    }
  });

  it("prevents a later parallel run from executing a stale approved preview", async () => {
    const approvals: AgentApprovalView[] = [];
    const firstGateway = new ScriptedGateway([]);
    const secondGateway = new ScriptedGateway([]);
    const harness = await createHarness({
      gateways: [firstGateway, secondGateway],
      approvals,
    });
    await configureAi(harness.settings);
    const task = (
      await harness.tasks.createTask({
        title: "共享初始标题",
        source: {
          type: "feishu",
          accountId: "primary",
          externalId: "parallel-shared",
        },
        sync: { status: "synced" },
      })
    ).task;
    firstGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(task.id, "第一个运行获准"),
        "shared-call-a",
      ),
      finalCompletion("A 完成"),
    );
    secondGateway.steps.push(
      toolCompletion(
        "task_update",
        updateArgs(task.id, "第二个运行的过期提议"),
        "shared-call-b",
      ),
      finalCompletion("B 已处理失败"),
    );

    const firstRun = harness.service.send({ message: "共享任务更新 A" });
    const secondRun = harness.service.send({ message: "共享任务更新 B" });
    await vi.waitFor(() =>
      expect(harness.service.status().activeRunIds).toHaveLength(2),
    );
    const [firstRunId] = harness.service.status().activeRunIds;
    const secondRunId = harness.service
      .status()
      .activeRunIds.find((runId) => runId !== firstRunId)!;
    await vi.waitFor(() => expect(approvals).toHaveLength(2));
    const firstApproval = approvals.find(
      (approval) => approval.runId === firstRunId,
    )!;
    const secondApproval = approvals.find(
      (approval) => approval.runId === secondRunId,
    )!;

    harness.service.respondToApproval(firstApproval.approvalId, "once");
    await firstRun;
    harness.service.respondToApproval(secondApproval.approvalId, "once");
    await secondRun;

    expect(await harness.tasks.getTask(task.id)).toMatchObject({
      title: "第一个运行获准",
    });
    const staleToolMessage = secondGateway.requests[1].messages.find(
      (message) => message.role === "tool",
    );
    expect(staleToolMessage?.content).toContain("EFFECT_PLAN_CHANGED");
    expect(
      (await harness.auditLog.records()).some(
        (record) =>
          record.runId === secondRunId &&
          record.event === "tool.execution.finished" &&
          record.outcome === "failed" &&
          JSON.stringify(record.details).includes("EFFECT_PLAN_CHANGED"),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "创建一个任务，标题是无效日期，截止日期是 2026-02-30。",
      "AGENT_INVALID_DATE",
      "不是有效日期",
    ],
    ["创建一个任务，周末处理。", "AGENT_AMBIGUOUS_TIME", "不够具体"],
    [
      "过几天提醒我提交报告。",
      "AGENT_AMBIGUOUS_TIME",
      "不够具体",
    ],
    [
      "明天提醒我提交报告。",
      "AGENT_REMINDER_TIME_REQUIRED",
      "明确的具体时刻",
    ],
  ] as const)(
    "returns a trusted time clarification for %s without contacting the model or writing a task",
    async (message, expectedCode, expectedText) => {
      const gateway = new ScriptedGateway([finalCompletion("不应调用模型")]);
      const harness = await createHarness({ gateways: [gateway] });
      await configureAi(harness.settings);

      const output = await harness.service.send({ message });

      expect(output).toMatchObject({
        state: "completed",
        errorCode: expectedCode,
        assistantText: expect.stringContaining(expectedText),
      });
      expect(gateway.requests).toHaveLength(0);
      expect(
        await harness.tasks.listTasks({ includeDeleted: true }),
      ).toHaveLength(0);
      expect(harness.service.status().activeRunIds).toEqual([]);
      expect(
        (await harness.auditLog.records()).some(
          (record) =>
            record.event === "agent.time.clarification-required" &&
            record.policyReason === expectedCode,
        ),
      ).toBe(true);
    },
  );
});
