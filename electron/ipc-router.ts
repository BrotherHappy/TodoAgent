import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import {
  DESKTOP_CHANNELS,
  type AppInfo,
  type DataDesktopApi,
  type FeishuDesktopApi,
  type NotificationDesktopApi,
} from "../src/shared/desktop-api";
import {
  FLOATING_HOVER_EXPAND_DELAY_MAX_MS,
  FLOATING_HOVER_EXPAND_DELAY_MIN_MS,
  type AppSettings,
} from "../src/shared/settings";
import type { AgentDesktopService } from "./agent/agent-desktop-service";
import type { SettingsService } from "./services/settings-service";
import type { TaskService } from "./services/task-service";
import { parseQuickCapture } from "./services/quick-capture-parser";
import {
  parseCustomSnoozeInput,
  parseReminderActionInput,
} from "./services/reminder-action-input";
import { rendererUrlIsTrusted } from "./trusted-renderer";

const idSchema = z.string().trim().min(1).max(512);
const routeSchema = z.string().trim().min(1).max(80).optional();

const settingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    theme: z.enum(["system", "light", "dark"]),
    launchAtLogin: z.boolean(),
    closeToTray: z.boolean(),
    quickCaptureShortcut: z.string().trim().min(1).max(80),
    notifications: z
      .object({
        enabled: z.boolean(),
        sound: z.boolean(),
        banners: z.boolean(),
        badge: z.boolean(),
        morningBrief: z.boolean(),
        morningBriefTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
        quietHoursEnabled: z.boolean(),
        quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
        quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
        mutedUntil: z.string().datetime().optional(),
      })
      .strict(),
    floating: z
      .object({
        enabled: z.boolean(),
        shape: z.enum(["capsule", "orb"]),
        hoverExpandDelayMs: z
          .number()
          .int()
          .min(FLOATING_HOVER_EXPAND_DELAY_MIN_MS)
          .max(FLOATING_HOVER_EXPAND_DELAY_MAX_MS),
        topMode: z.enum(["always", "focus-only", "never"]),
        locked: z.boolean(),
        hideInFullscreen: z.boolean(),
        privacyMode: z.boolean(),
        lastDisplayId: z.string().trim().min(1).max(512).optional(),
        positions: z.record(
          z.string(),
          z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
        ),
      })
      .strict(),
    ai: z
      .object({
        enabled: z.boolean(),
        endpoint: z.string().trim().url().max(2_048),
        model: z.string().trim().max(240),
        // A renderer from the immediately preceding build may not have this
        // field yet; preserving Bearer as the default never weakens auth.
        authMode: z.enum(["bearer", "none"]).default("bearer"),
        timeoutMs: z.number().int().min(1_000).max(300_000),
        retries: z.number().int().min(0).max(5),
        dailyTokenLimit: z.number().int().min(0).max(100_000_000),
        dailyCostLimit: z.number().finite().min(0).max(100_000),
        credentialId: z.string().trim().min(1).max(512).optional(),
      })
      .strict(),
    feishu: z
      .object({
        configured: z.boolean(),
        mode: z.enum([
          "personal-direct",
          "existing-direct",
          "relay",
          "local-development",
        ]),
        accountId: z.string().trim().min(1).max(256),
        tokenCredentialId: z.string().trim().min(1).max(512).optional(),
        relayBaseUrl: z.union([
          z.literal(""),
          z.string().trim().url().max(2_048),
        ]),
        clientId: z.string().trim().max(512),
        appSecretCredentialId: z.string().trim().min(1).max(512).optional(),
        acknowledgeInsecureLocalCredentials: z.boolean(),
        autoSync: z.boolean(),
        pollingMinutes: z.number().int().min(1).max(1_440),
      })
      .strict(),
    modelDataScope: z
      .object({
        taskTitlesAndTimes: z.boolean(),
        notes: z.boolean(),
        feishuContent: z.boolean(),
        attachmentText: z.boolean(),
        chatHistory: z.boolean(),
      })
      .strict(),
    persona: z
      .object({
        preset: z.enum(["minimal", "warm", "calm", "strict"]),
        name: z.string().max(80),
        userName: z.string().max(80),
        responseLength: z.enum(["short", "balanced", "detailed"]),
        proactiveLevel: z.enum(["quiet", "balanced", "active"]),
        reminderStrength: z.enum(["gentle", "normal", "firm"]),
      })
      .strict(),
    permissionMode: z.enum(["read-only", "standard", "full-access"]),
    onboardingComplete: z.boolean(),
  })
  .strict();

const credentialSchema = z
  .object({
    kind: z.enum(["ai-api-key", "feishu-app-secret", "feishu-token"]),
    value: z.string().min(1).max(65_536),
    id: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export interface DesktopIpcDependencies {
  tasks: TaskService;
  settings: SettingsService;
  agent: AgentDesktopService;
  feishu: FeishuDesktopApi;
  notifications: NotificationDesktopApi;
  data: DataDesktopApi;
  devServerUrl?: string;
  rendererPath: string;
  getInfo: () => AppInfo;
  showMain: (route?: string) => void;
  showQuickCapture: () => void;
  setFloatingVisible: (visible: boolean) => Promise<AppSettings>;
  setFloatingExpanded: (expanded: boolean) => void;
  setLaunchAtLogin: (enabled: boolean) => Promise<AppSettings>;
  openExternal: (url: string) => Promise<void>;
  onTasksChanged: () => void;
  onSettingsChanged: (settings: AppSettings) => void;
  authenticateFullAccess: () => Promise<string>;
}

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  input: unknown,
) => unknown | Promise<unknown>;

function senderIsTrusted(
  event: IpcMainInvokeEvent,
  dependencies: DesktopIpcDependencies,
): boolean {
  return rendererUrlIsTrusted({
    url: event.senderFrame?.url,
    rendererPath: dependencies.rendererPath,
    devServerUrl: dependencies.devServerUrl,
  });
}

export function registerDesktopIpc(
  dependencies: DesktopIpcDependencies,
): () => void {
  const registered: string[] = [];
  const handle = (channel: string, handler: InvokeHandler): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, input) => {
      if (!senderIsTrusted(event, dependencies))
        throw new Error("UNTRUSTED_RENDERER");
      return handler(event, input);
    });
    registered.push(channel);
  };
  const changed = async <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = await operation();
    dependencies.onTasksChanged();
    return result;
  };

  handle(DESKTOP_CHANNELS.taskCreate, (_event, input) =>
    changed(() => dependencies.tasks.createTask(input as never)),
  );
  handle(DESKTOP_CHANNELS.taskGet, (_event, input) => {
    const request = z
      .object({ id: idSchema, includeDeleted: z.boolean().optional() })
      .strict()
      .parse(input);
    return dependencies.tasks.getTask(request.id, request.includeDeleted);
  });
  handle(DESKTOP_CHANNELS.taskList, (_event, input) =>
    dependencies.tasks.listTasks((input ?? {}) as never),
  );
  handle(DESKTOP_CHANNELS.taskSections, (_event, input) =>
    dependencies.tasks.getViewSections((input ?? {}) as never),
  );
  handle(DESKTOP_CHANNELS.taskUpdate, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        patch: z.record(z.string(), z.unknown()),
        recurrenceScope: z.enum(["this", "future", "series"]).optional(),
      })
      .strict()
      .parse(input);
    return changed(() =>
      dependencies.tasks.updateTask(
        request.id,
        request.patch as never,
        request.recurrenceScope,
      ),
    );
  });
  handle(DESKTOP_CHANNELS.taskComplete, (_event, input) => {
    const request = z
      .object({ id: idSchema, completedAt: z.string().datetime().optional() })
      .strict()
      .parse(input);
    return changed(() =>
      dependencies.tasks.completeTask(request.id, request.completedAt),
    );
  });
  handle(DESKTOP_CHANNELS.taskReopen, (_event, input) =>
    changed(() => dependencies.tasks.reopenTask(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskMoveToToday, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/u)
          .optional(),
      })
      .strict()
      .parse(input);
    return changed(() =>
      dependencies.tasks.moveToToday(request.id, request.date),
    );
  });
  handle(DESKTOP_CHANNELS.taskStartFocus, (_event, input) =>
    changed(() => dependencies.tasks.startFocus(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskPauseFocus, (_event, input) =>
    changed(() => dependencies.tasks.pauseFocus(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskResetFocus, (_event, input) =>
    changed(() => dependencies.tasks.resetFocus(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskReorderToday, (_event, input) =>
    changed(() =>
      dependencies.tasks.reorderToday(z.array(idSchema).max(500).parse(input)),
    ),
  );
  handle(DESKTOP_CHANNELS.taskTrash, (_event, input) =>
    changed(() => dependencies.tasks.moveToTrash(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskRestore, (_event, input) =>
    changed(() => dependencies.tasks.restoreTask(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskPurge, (_event, input) =>
    changed(() => dependencies.tasks.purgeTask(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskUndo, (_event, input) =>
    changed(() =>
      dependencies.tasks.undo(
        input === undefined ? undefined : idSchema.parse(input),
      ),
    ),
  );
  handle(DESKTOP_CHANNELS.draftSave, (_event, input) =>
    dependencies.tasks.saveDraft(input as never),
  );
  handle(DESKTOP_CHANNELS.draftGet, (_event, input) =>
    dependencies.tasks.getDraft(idSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.draftList, () => dependencies.tasks.listDrafts());
  handle(DESKTOP_CHANNELS.draftDelete, (_event, input) =>
    dependencies.tasks.deleteDraft(idSchema.parse(input)),
  );

  handle(DESKTOP_CHANNELS.settingsGet, () => dependencies.settings.get());
  handle(DESKTOP_CHANNELS.settingsReplace, async (_event, input) => {
    const requested = settingsSchema.parse(input) as AppSettings;
    const current = dependencies.settings.get();
    // Window coordinates are owned by the main process. A renderer can hold a
    // stale settings snapshot while the user drags the floating window; never
    // let a later UI toggle overwrite the freshly persisted position.
    const settings = await dependencies.settings.replace({
      ...requested,
      floating: {
        ...requested.floating,
        lastDisplayId: current.floating.lastDisplayId,
        positions: current.floating.positions,
      },
    });
    dependencies.onSettingsChanged(settings);
    return settings;
  });
  handle(DESKTOP_CHANNELS.credentialList, () =>
    dependencies.settings.listCredentials(),
  );
  handle(DESKTOP_CHANNELS.credentialSet, (_event, input) => {
    const request = credentialSchema.parse(input);
    return dependencies.settings.setCredential(
      request.kind,
      request.value,
      request.id,
    );
  });
  handle(DESKTOP_CHANNELS.credentialDelete, (_event, input) =>
    dependencies.settings.deleteCredential(idSchema.parse(input)),
  );

  handle(DESKTOP_CHANNELS.shellGetInfo, () => dependencies.getInfo());
  handle(DESKTOP_CHANNELS.shellShowMain, (_event, input) =>
    dependencies.showMain(routeSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.shellShowQuick, () =>
    dependencies.showQuickCapture(),
  );
  handle(DESKTOP_CHANNELS.shellHideCurrent, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.hide(),
  );
  handle(DESKTOP_CHANNELS.shellSetFloatingVisible, (_event, input) =>
    dependencies.setFloatingVisible(z.boolean().parse(input)),
  );
  handle(DESKTOP_CHANNELS.shellSetFloatingExpanded, (_event, input) =>
    dependencies.setFloatingExpanded(z.boolean().parse(input)),
  );
  handle(DESKTOP_CHANNELS.shellSetLaunchAtLogin, (_event, input) =>
    dependencies.setLaunchAtLogin(z.boolean().parse(input)),
  );
  handle(DESKTOP_CHANNELS.shellOpenExternal, (_event, input) => {
    const value = z.string().trim().min(1).max(2_048).parse(input);
    const parsed = new URL(value);
    if (!["https:", "mailto:"].includes(parsed.protocol))
      throw new Error("UNSAFE_EXTERNAL_URL");
    return dependencies.openExternal(parsed.toString());
  });
  handle(DESKTOP_CHANNELS.captureParse, (_event, input) =>
    parseQuickCapture(z.string().max(10_000).parse(input)),
  );

  const agentMessageSchema = z
    .object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(50_000),
    })
    .strict();
  handle(DESKTOP_CHANNELS.agentStatus, () => dependencies.agent.status());
  handle(DESKTOP_CHANNELS.agentModelUsage, () =>
    dependencies.agent.modelUsage(),
  );
  handle(DESKTOP_CHANNELS.agentModelConnectionTest, () =>
    dependencies.agent.testModelConnection(),
  );
  handle(DESKTOP_CHANNELS.agentSend, (_event, input) => {
    const request = z
      .object({
        runId: z.string().uuid().optional(),
        conversationId: z.string().uuid().optional(),
        message: z.string().trim().min(1).max(50_000),
        history: z.array(agentMessageSchema).max(50).optional(),
      })
      .strict()
      .parse(input);
    return dependencies.agent.send(request);
  });
  handle(DESKTOP_CHANNELS.agentMorningBrief, (_event, input) => {
    const request = z
      .object({
        trigger: z.enum(["automatic", "manual"]),
      })
      .strict()
      .parse(input);
    return dependencies.agent.morningBrief(request);
  });
  handle(DESKTOP_CHANNELS.agentApprovalRespond, (_event, input) => {
    const response = z
      .object({ approvalId: idSchema, choice: z.enum(["deny", "once"]) })
      .strict()
      .parse(input);
    return dependencies.agent.respondToApproval(
      response.approvalId,
      response.choice,
    );
  });
  handle(DESKTOP_CHANNELS.agentStop, (_event, input) =>
    dependencies.agent.stop(
      input === undefined ? undefined : idSchema.parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.agentAudit, (_event, input) =>
    dependencies.agent.audit(
      input === undefined
        ? undefined
        : z.number().int().min(1).max(5_000).parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.agentFullAccessCreate, async (_event, input) => {
    const request = z
      .object({
        durationMinutes: z.number().int().min(5).max(60),
        scopes: z
          .array(
            z
              .object({
                toolName: z.string().trim().min(1).max(64),
                risks: z
                  .array(z.enum(["R2", "R3"]))
                  .min(1)
                  .max(2),
                targets: z
                  .array(
                    z
                      .object({
                        kind: z.enum([
                          "task",
                          "account",
                          "project",
                          "origin",
                          "path",
                          "command",
                          "app",
                          "network",
                        ]),
                        value: z.string().trim().min(1).max(4_096),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(200),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .parse(input);
    const authenticatedAt = await dependencies.authenticateFullAccess();
    return dependencies.agent.createFullAccessLease(request, authenticatedAt);
  });
  handle(DESKTOP_CHANNELS.agentFullAccessRevoke, () =>
    dependencies.agent.revokeFullAccess(),
  );

  const feishuRelaySchema = z
    .object({
      mode: z.literal("relay"),
      accountId: z.string().trim().min(1).max(256),
      tokenCredentialId: z.string().trim().min(1).max(512),
      relayBaseUrl: z
        .string()
        .trim()
        .url()
        .max(2_048)
        .refine(
          (value) => value.startsWith("https://"),
          "Relay must use HTTPS",
        ),
      clientId: z.string().trim().max(512).optional(),
    })
    .strict();
  const feishuPersonalDirectSchema = z
    .object({
      mode: z.literal("personal-direct"),
      accountId: z.string().trim().min(1).max(256),
      tokenCredentialId: z.string().trim().min(1).max(512),
      clientId: z.string().trim().min(1).max(512),
      appSecretCredentialId: z.string().trim().min(1).max(512),
    })
    .strict();
  const feishuExistingDirectSchema = z
    .object({
      mode: z.literal("existing-direct"),
      accountId: z.string().trim().min(1).max(256),
      tokenCredentialId: z.string().trim().min(1).max(512),
      clientId: z.string().trim().min(1).max(512),
      appSecretCredentialId: z.string().trim().min(1).max(512),
    })
    .strict();
  const feishuDeveloperSchema = z
    .object({
      mode: z.literal("local-development"),
      accountId: z.string().trim().min(1).max(256),
      tokenCredentialId: z.string().trim().min(1).max(512),
      clientId: z.string().trim().min(1).max(512),
      appSecretCredentialId: z.string().trim().min(1).max(512),
      acknowledgeInsecureLocalCredentials: z.literal(true),
    })
    .strict();
  handle(DESKTOP_CHANNELS.feishuStatus, () => dependencies.feishu.status());
  handle(DESKTOP_CHANNELS.feishuConfigure, (_event, input) =>
    dependencies.feishu.configure(
      z
        .discriminatedUnion("mode", [
          feishuPersonalDirectSchema,
          feishuExistingDirectSchema,
          feishuRelaySchema,
          feishuDeveloperSchema,
        ])
        .parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.feishuBeginPersonalConnect, () =>
    dependencies.feishu.beginPersonalConnect(),
  );
  handle(DESKTOP_CHANNELS.feishuBeginOAuth, () =>
    dependencies.feishu.beginOAuth(),
  );
  handle(DESKTOP_CHANNELS.feishuCancelOAuth, () =>
    dependencies.feishu.cancelOAuth(),
  );
  handle(DESKTOP_CHANNELS.feishuDisconnect, () =>
    dependencies.feishu.disconnect(),
  );
  handle(DESKTOP_CHANNELS.feishuSyncNow, (_event, input) =>
    dependencies.feishu.syncNow(
      input === undefined ? undefined : z.boolean().parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.feishuConflicts, () =>
    dependencies.feishu.listConflicts(),
  );
  handle(DESKTOP_CHANNELS.feishuResolveConflict, (_event, input) => {
    const request = z
      .object({
        localId: idSchema,
        decision: z.enum(["keep-local", "use-feishu", "duplicate"]),
      })
      .strict()
      .parse(input);
    return dependencies.feishu.resolveConflict(
      request.localId,
      request.decision,
    );
  });
  handle(DESKTOP_CHANNELS.notificationAction, (_event, input) => {
    return dependencies.notifications.handleAction(
      parseReminderActionInput(input),
    );
  });
  handle(DESKTOP_CHANNELS.notificationSnoozeUntil, (_event, input) => {
    const request = parseCustomSnoozeInput(input);
    return dependencies.notifications.snoozeUntil(
      request.reminderId,
      request.snoozeUntil,
    );
  });
  handle(DESKTOP_CHANNELS.notificationRefresh, () =>
    dependencies.notifications.refresh(),
  );
  handle(DESKTOP_CHANNELS.dataExport, (_event, input) => {
    const request = z
      .object({
        redaction: z.enum(["none", "private", "strict"]).optional(),
        include: z
          .object({
            tasks: z.boolean().optional(),
            drafts: z.boolean().optional(),
            operations: z.boolean().optional(),
            settings: z.boolean().optional(),
            permissionAudit: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input ?? {});
    return dependencies.data.exportToFile(request);
  });
  handle(DESKTOP_CHANNELS.dataPreviewImport, () =>
    dependencies.data.previewImport(),
  );
  handle(DESKTOP_CHANNELS.dataCommitImport, (_event, input) => {
    const request = z
      .object({
        previewToken: idSchema,
        strategy: z.enum(["skip", "overwrite", "copy"]),
      })
      .strict()
      .parse(input);
    return dependencies.data.commitImport(
      request.previewToken,
      request.strategy,
    );
  });
  handle(DESKTOP_CHANNELS.dataCancelPreview, (_event, input) =>
    dependencies.data.cancelPreview(idSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.dataClearLocal, (_event, input) => {
    const request = z
      .object({
        tasks: z.boolean(),
        drafts: z.boolean(),
        operations: z.boolean(),
        resetSettings: z.boolean(),
      })
      .strict()
      .refine(
        (value) => Object.values(value).some(Boolean),
        "Select at least one data category",
      )
      .parse(input);
    return dependencies.data.clearLocalData(request);
  });

  return () => registered.forEach((channel) => ipcMain.removeHandler(channel));
}
