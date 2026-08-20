import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import {
  DESKTOP_CHANNELS,
  type AppInfo,
  type DataDesktopApi,
  type FeishuDesktopApi,
  type NotificationDesktopApi,
  type PetDesktopApi,
  type SelectedTextContextView,
} from "../src/shared/desktop-api";
import type { TaskAttachment } from "../src/shared/models";
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
const localAttachmentSchema = z
  .object({
    id: idSchema,
    localPath: z.string().trim().min(1).max(8_192),
  })
  .strict();

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
        dailyTaskReminderLimit: z.number().int().min(0).max(50),
        taskIgnoreBackoffEnabled: z.boolean(),
        taskReminderMinIntervalMinutes: z.number().int().min(0).max(1_440),
        taskReminderSourceMode: z
          .object({
            local: z.enum(["normal", "important-only", "off"]),
            feishu: z.enum(["normal", "important-only", "off"]),
          })
          .strict(),
        taskReminderProjectMode: z
          .record(
            z.string().trim().min(1).max(512),
            z.enum(["normal", "important-only", "off"]),
          )
          .refine((value) => Object.keys(value).length <= 100, "最多配置 100 个项目提醒策略"),
        mutedUntil: z.string().datetime().optional(),
      })
      .strict(),
    floating: z
      .object({
        enabled: z.boolean(),
        hoverExpandDelayMs: z
          .number()
          .int()
          .min(FLOATING_HOVER_EXPAND_DELAY_MIN_MS)
          .max(FLOATING_HOVER_EXPAND_DELAY_MAX_MS),
        topMode: z.enum(["always", "focus-only", "never"]),
        locked: z.boolean(),
        hideInFullscreen: z.boolean(),
        privacyMode: z.boolean(),
        selectedTab: z.enum(["all", "today", "focus", "chat", "home"]),
        scalePercent: z.number().int().min(75).max(125),
        lastDisplayId: z.string().trim().min(1).max(512).optional(),
        positions: z.record(
          z.string(),
          z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
        ),
        mousePassthrough: z.boolean(),
      })
      .strict(),
    focus: z
      .object({
        focusMinutes: z.number().int().min(1).max(240),
        shortBreakMinutes: z.number().int().min(1).max(60),
        longBreakMinutes: z.number().int().min(1).max(120),
        cycles: z.number().int().min(1).max(12),
        autoStartBreak: z.boolean(),
        autoStartNextRound: z.boolean(),
        environmentSound: z.enum([
          "off",
          "rain",
          "forest",
          "cafe",
          "white-noise",
        ]),
      })
      .strict(),
    planning: z
      .object({
        urgencyWeights: z
          .object({
            deadline: z.number().int().min(0).max(100),
            plannedToday: z.number().int().min(0).max(100),
            priority: z.number().int().min(0).max(100),
            quickWin: z.number().int().min(0).max(100),
          })
          .strict(),
      })
      .strict(),
    weather: z
      .object({
        enabled: z.boolean(),
        city: z.string().trim().max(160),
        latitude: z.number().finite().min(-90).max(90).optional(),
        longitude: z.number().finite().min(-180).max(180).optional(),
        resolvedName: z.string().trim().max(240).optional(),
        cacheMinutes: z.number().int().min(30).max(120),
      })
      .strict(),
    pet: z
      .object({
        interactionsEnabled: z.boolean(),
        proactiveMessages: z.boolean(),
        wellbeingReminders: z.boolean(),
        autoDiary: z.boolean(),
        relationshipMemory: z.boolean(),
        actionPack: z.enum(["balanced", "calm", "playful", "focused"]),
        animationIntensity: z.enum(["gentle", "lively"]),
        proactiveIntervalMinutes: z.number().int().min(15).max(240),
        proactiveDailyLimit: z.number().int().min(0).max(20),
        meetingMode: z.boolean(),
        seasonalEvents: z.boolean(),
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
        routing: z.enum(["primary-only", "fallback-on-error", "local-only"]).default("primary-only"),
        fallback: z
          .object({
            enabled: z.boolean(),
            endpoint: z.string().trim().url().max(2_048),
            model: z.string().trim().max(240),
            authMode: z.enum(["bearer", "none"]).default("none"),
            pricing: z
              .object({
                promptUsdPerMillionTokens: z.number().finite().min(0).max(100_000),
                completionUsdPerMillionTokens: z.number().finite().min(0).max(100_000),
              })
              .strict()
              .default({
                promptUsdPerMillionTokens: 0,
                completionUsdPerMillionTokens: 0,
              }),
            credentialId: z.string().trim().min(1).max(512).optional(),
          })
          .strict()
          .default({
            enabled: false,
            endpoint: "http://127.0.0.1:11434/v1",
            model: "llama3.2",
            authMode: "none",
            pricing: {
              promptUsdPerMillionTokens: 0,
              completionUsdPerMillionTokens: 0,
            },
          }),
        timeoutMs: z.number().int().min(1_000).max(300_000),
        retries: z.number().int().min(0).max(5),
        dailyTokenLimit: z.number().int().min(0).max(100_000_000),
        dailyCostLimit: z.number().finite().min(0).max(100_000),
        pricing: z
          .object({
            promptUsdPerMillionTokens: z.number().finite().min(0).max(100_000),
            completionUsdPerMillionTokens: z.number().finite().min(0).max(100_000),
          })
          .strict(),
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
        syncWithPet: z.boolean().optional(),
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
  taskAttachments?: {
    choose(): Promise<TaskAttachment[]>;
    open(attachment: Pick<TaskAttachment, "id" | "localPath">): Promise<void>;
    preview(attachment: Pick<TaskAttachment, "id" | "localPath">): Promise<import("../src/shared/models").TaskAttachmentPreview>;
    remove(attachment: Pick<TaskAttachment, "id" | "localPath">): Promise<void>;
  };
  settings: SettingsService;
  agent: AgentDesktopService;
  feishu: FeishuDesktopApi;
  notifications: NotificationDesktopApi;
  pet: PetDesktopApi;
  data: DataDesktopApi;
  devServerUrl?: string;
  rendererPath: string;
  getInfo: () => AppInfo;
  readClipboard: () => { text: string; characters: number; truncated: boolean; capturedAt: string };
  readActiveWindow: () => { status: "captured" | "unavailable"; appName?: string; title?: string; reason?: "unsupported" | "permission-denied" | "empty" | "error"; capturedAt: string } | Promise<{ status: "captured" | "unavailable"; appName?: string; title?: string; reason?: "unsupported" | "permission-denied" | "empty" | "error"; capturedAt: string }>;
  readSelectedText: () => SelectedTextContextView | Promise<SelectedTextContextView>;
  showMain: (route?: string) => void;
  showQuickCapture: () => void;
  setFloatingVisible: (visible: boolean) => Promise<AppSettings>;
  setFloatingExpanded: (expanded: boolean) => void;
  setFloatingPetOnly: (petOnly: boolean) => void;
  beginFloatingDrag: (screenX: number, screenY: number) => boolean;
  updateFloatingDrag: (screenX: number, screenY: number) => boolean;
  endFloatingDrag: () => void;
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
  handle(DESKTOP_CHANNELS.taskApplyTodayPlan, (_event, input) => {
    const request = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
        items: z
          .array(
            z
              .object({
                id: idSchema,
                estimatedMinutes: z.number().int().min(5).max(720).optional(),
              })
              .strict(),
          )
          .max(500),
        clearTaskIds: z.array(idSchema).max(500),
        baselines: z
          .array(
            z
              .object({
                id: idSchema,
                plannedDate: z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/u)
                  .optional(),
                privateOrder: z.number().finite(),
                estimatedMinutes: z.number().finite().nonnegative().optional(),
              })
              .strict(),
          )
          .max(500),
      })
      .strict()
      .refine(
        (value) => value.items.length + value.clearTaskIds.length <= 500,
        {
          message: "Today plan cannot change more than 500 tasks at once.",
          path: ["items"],
        },
      )
      .parse(input);
    return changed(() => dependencies.tasks.applyTodayPlan(request));
  });
  handle(DESKTOP_CHANNELS.taskApplyBulkAction, (_event, input) => {
    const request = z
      .object({
        ids: z.array(idSchema).min(1).max(500),
        action: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("complete"), completedAt: z.string().datetime().optional() }).strict(),
          z.object({ kind: z.literal("reopen") }).strict(),
          z.object({
            kind: z.literal("move-to-today"),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
          }).strict(),
          z.object({ kind: z.literal("trash") }).strict(),
          z.object({ kind: z.literal("restore") }).strict(),
        ]),
        baselines: z.array(
          z.object({ id: idSchema, updatedAt: z.string().datetime() }).strict(),
        ).max(500).optional(),
      })
      .strict()
      .refine((value) => new Set(value.ids).size === value.ids.length, {
        message: "Batch task ids must be unique.",
        path: ["ids"],
      })
      .refine(
        (value) =>
          value.baselines === undefined ||
          (value.baselines.length === value.ids.length &&
            new Set(value.baselines.map((baseline) => baseline.id)).size ===
              value.baselines.length &&
            value.ids.every((id) => value.baselines!.some((baseline) => baseline.id === id))),
        {
          message: "Batch baselines must include every selected task.",
          path: ["baselines"],
        },
      )
      .parse(input);
    return changed(() => dependencies.tasks.applyBulkTaskAction(request));
  });
  handle(DESKTOP_CHANNELS.taskTrash, (_event, input) =>
    changed(() => dependencies.tasks.moveToTrash(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskRestore, (_event, input) =>
    changed(() => dependencies.tasks.restoreTask(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.taskPurge, async (_event, input) => {
    const id = idSchema.parse(input);
    const existing = await dependencies.tasks.getTask(id, true);
    const result = await changed(() => dependencies.tasks.purgeTask(id));
    if (existing && dependencies.taskAttachments) {
      await Promise.all(
        existing.attachments
          .filter((attachment) => attachment.localPath)
          .map((attachment) => dependencies.taskAttachments!.remove(attachment).catch(() => undefined)),
      );
    }
    return result;
  });
  handle(DESKTOP_CHANNELS.taskHistory, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(input);
    return dependencies.tasks.getTaskHistory(request.id, request.limit);
  });
  handle(DESKTOP_CHANNELS.taskUndo, (_event, input) =>
    changed(() =>
      dependencies.tasks.undo(
        input === undefined ? undefined : idSchema.parse(input),
      ),
    ),
  );
  handle(DESKTOP_CHANNELS.taskChooseAttachments, () => {
    if (!dependencies.taskAttachments) throw new Error("TASK_ATTACHMENTS_UNAVAILABLE");
    return dependencies.taskAttachments.choose();
  });
  handle(DESKTOP_CHANNELS.taskOpenAttachment, (_event, input) => {
    if (!dependencies.taskAttachments) throw new Error("TASK_ATTACHMENTS_UNAVAILABLE");
    return dependencies.taskAttachments.open(localAttachmentSchema.parse(input));
  });
  handle(DESKTOP_CHANNELS.taskPreviewAttachment, (_event, input) => {
    if (!dependencies.taskAttachments) throw new Error("TASK_ATTACHMENTS_UNAVAILABLE");
    return dependencies.taskAttachments.preview(localAttachmentSchema.parse(input));
  });
  handle(DESKTOP_CHANNELS.taskDeleteAttachment, (_event, input) => {
    if (!dependencies.taskAttachments) throw new Error("TASK_ATTACHMENTS_UNAVAILABLE");
    return dependencies.taskAttachments.remove(localAttachmentSchema.parse(input));
  });
  handle(DESKTOP_CHANNELS.projectList, (_event, input) =>
    dependencies.tasks.listProjects(z.boolean().optional().parse(input) ?? false),
  );
  handle(DESKTOP_CHANNELS.projectCreate, (_event, input) => {
    const request = z
      .object({
        name: z.string().trim().min(1).max(80),
        color: z.enum(["violet", "blue", "green", "amber", "rose", "slate"]).optional(),
      })
      .strict()
      .parse(input);
    return changed(() => dependencies.tasks.createProject(request));
  });
  handle(DESKTOP_CHANNELS.projectUpdate, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        patch: z
          .object({
            name: z.string().trim().min(1).max(80).optional(),
            color: z.enum(["violet", "blue", "green", "amber", "rose", "slate"]).optional(),
            archived: z.boolean().optional(),
            privateOrder: z.number().finite().nonnegative().optional(),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    return changed(() => dependencies.tasks.updateProject(request.id, request.patch));
  });
  handle(DESKTOP_CHANNELS.projectDelete, (_event, input) =>
    changed(() => dependencies.tasks.deleteProject(idSchema.parse(input))),
  );
  handle(DESKTOP_CHANNELS.listList, (_event, input) =>
    dependencies.tasks.listLists(z.boolean().optional().parse(input) ?? false),
  );
  handle(DESKTOP_CHANNELS.listCreate, (_event, input) => {
    const request = z
      .object({
        name: z.string().trim().min(1).max(80),
        color: z.enum(["violet", "blue", "green", "amber", "rose", "slate"]).optional(),
      })
      .strict()
      .parse(input);
    return changed(() => dependencies.tasks.createList(request));
  });
  handle(DESKTOP_CHANNELS.listUpdate, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        patch: z
          .object({
            name: z.string().trim().min(1).max(80).optional(),
            color: z.enum(["violet", "blue", "green", "amber", "rose", "slate"]).optional(),
            archived: z.boolean().optional(),
            privateOrder: z.number().finite().nonnegative().optional(),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    return changed(() => dependencies.tasks.updateList(request.id, request.patch));
  });
  handle(DESKTOP_CHANNELS.listDelete, (_event, input) =>
    changed(() => dependencies.tasks.deleteList(idSchema.parse(input))),
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
  handle(DESKTOP_CHANNELS.shellReadClipboard, () => dependencies.readClipboard());
  handle(DESKTOP_CHANNELS.shellReadActiveWindow, () => dependencies.readActiveWindow());
  handle(DESKTOP_CHANNELS.shellReadSelectedText, () => dependencies.readSelectedText());
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
  handle(DESKTOP_CHANNELS.shellSetFloatingPetOnly, (_event, input) =>
    dependencies.setFloatingPetOnly(z.boolean().parse(input)),
  );
  const floatingPointerSchema = z
    .object({
      screenX: z.number().finite().min(-100_000).max(100_000),
      screenY: z.number().finite().min(-100_000).max(100_000),
    })
    .strict();
  handle(DESKTOP_CHANNELS.shellBeginFloatingDrag, (_event, input) => {
    const pointer = floatingPointerSchema.parse(input);
    return dependencies.beginFloatingDrag(pointer.screenX, pointer.screenY);
  });
  handle(DESKTOP_CHANNELS.shellUpdateFloatingDrag, (_event, input) => {
    const pointer = floatingPointerSchema.parse(input);
    return dependencies.updateFloatingDrag(pointer.screenX, pointer.screenY);
  });
  handle(DESKTOP_CHANNELS.shellEndFloatingDrag, () =>
    dependencies.endFloatingDrag(),
  );
  handle(DESKTOP_CHANNELS.shellSetLaunchAtLogin, (_event, input) =>
    dependencies.setLaunchAtLogin(z.boolean().parse(input)),
  );
  handle(DESKTOP_CHANNELS.shellOpenExternal, (_event, input) => {
    const value = z.string().trim().min(1).max(2_048).parse(input);
    const parsed = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol))
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
  handle(DESKTOP_CHANNELS.petSnapshot, () => dependencies.pet.snapshot());
  handle(DESKTOP_CHANNELS.petRename, (_event, input) =>
    dependencies.pet.rename(z.string().trim().min(1).max(80).parse(input)),
  );
  handle(DESKTOP_CHANNELS.petCustomize, (_event, input) => {
    const request = z
      .object({
        palette: z.enum(["lavender", "mint", "sunset", "midnight"]).optional(),
        outfit: z.enum(["none", "scarf", "explorer", "starlight"]).optional(),
        roomTheme: z
          .enum(["cloud-room", "forest-nook", "night-library"])
          .optional(),
        atmosphere: z.enum(["daylight", "cozy", "moonlit"]).optional(),
        decorations: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
        decorationPositions: z
          .record(
            z.string().trim().min(1).max(80),
            z
              .object({
                x: z.number().finite(),
                y: z.number().finite(),
                scale: z.number().finite().optional(),
              })
              .strict()
              .or(z.null()),
          )
          .optional(),
        personality: z.enum(["gentle", "energetic", "calm", "playful", "witty", "quiet"]).optional(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.customize(request);
  });
  handle(DESKTOP_CHANNELS.petCompanionAdd, (_event, input) => {
    const request = z
      .object({
        kind: z.enum(["paper-bird", "cloudlet", "moss-mouse", "moon-moth"]),
        name: z.string().trim().min(1).max(40).optional(),
        personality: z.enum(["gentle", "energetic", "calm", "playful", "witty", "quiet"]).optional(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.addCompanion(request);
  });
  handle(DESKTOP_CHANNELS.petCompanionUpdate, (_event, input) => {
    const request = z
      .object({
        id: z.string().trim().min(1).max(80),
        patch: z
          .object({
            name: z.string().trim().min(1).max(40).optional(),
            personality: z.enum(["gentle", "energetic", "calm", "playful", "witty", "quiet"]).optional(),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.updateCompanion(request.id, request.patch);
  });
  handle(DESKTOP_CHANNELS.petCompanionDelete, (_event, input) =>
    dependencies.pet.deleteCompanion(z.string().trim().min(1).max(80).parse(input)),
  );
  handle(DESKTOP_CHANNELS.petInteract, (_event, input) =>
    dependencies.pet.interact(
      input === undefined
        ? undefined
        : z.string().trim().min(1).max(80).parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.petAdventureDaily, (_event, input) =>
    dependencies.pet.dailyAdventure(
      input === undefined
        ? undefined
        : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.petAdventureComplete, (_event, input) => {
    const request = z
      .object({
        adventureId: z.string().trim().min(1).max(120),
        choiceId: z.string().trim().min(1).max(80),
      })
      .strict()
      .parse(input);
    return dependencies.pet.completeAdventure(
      request.adventureId,
      request.choiceId,
    );
  });
  handle(DESKTOP_CHANNELS.petMiniGameRecord, (_event, input) => {
    const request = z
      .object({
        game: z.enum([
          "breathing",
          "star-catch",
          "jump-rope",
          "stretch-mirror",
        ]),
        score: z.number().finite().min(0).max(99_999),
        durationSeconds: z.number().finite().min(1).max(3_600),
      })
      .strict()
      .parse(input);
    return dependencies.pet.recordMiniGame(request);
  });
  handle(DESKTOP_CHANNELS.petProactiveRecord, (_event, input) => {
    const request = z
      .object({
        kind: z.enum([
          "companion",
          "planning",
          "deadline",
          "wellbeing",
          "weather",
          "sync",
          "morning",
          "evening",
        ]),
        reason: z.string().trim().min(1).max(500),
        dismissed: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.recordProactiveMessage(request);
  });
  const focusPresetSchema = z
    .object({
      focusMinutes: z.number().int().min(1).max(240),
      shortBreakMinutes: z.number().int().min(1).max(60),
      longBreakMinutes: z.number().int().min(1).max(120),
      cycles: z.number().int().min(1).max(12),
    })
    .strict();
  handle(DESKTOP_CHANNELS.petFocusStart, (_event, input) => {
    const request = z
      .object({
        mode: z.enum(["pomodoro", "count-up"]),
        taskId: idSchema.optional(),
        taskTitle: z.string().trim().max(500).optional(),
        preset: focusPresetSchema.optional(),
        autoStartBreak: z.boolean().optional(),
        autoStartNextRound: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.startFocus(request);
  });
  handle(DESKTOP_CHANNELS.petFocusPause, (_event, input) =>
    dependencies.pet.pauseFocus(
      input === undefined
        ? undefined
        : z.string().trim().max(240).parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.petFocusResume, () =>
    dependencies.pet.resumeFocus(),
  );
  handle(DESKTOP_CHANNELS.petFocusAdvance, () =>
    dependencies.pet.advanceFocus(),
  );
  handle(DESKTOP_CHANNELS.petFocusFinish, (_event, input) =>
    dependencies.pet.finishFocus(
      z.enum(["completed", "abandoned"]).parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.petWeatherGet, () => dependencies.pet.weather());
  handle(DESKTOP_CHANNELS.petWeatherRefresh, (_event, input) =>
    dependencies.pet.refreshWeather(
      input === undefined ? undefined : z.boolean().parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.petDiaryGenerate, (_event, input) =>
    dependencies.pet.generateDiary(
      input === undefined
        ? undefined
        : z.string().trim().max(10_000).parse(input),
    ),
  );
  handle(DESKTOP_CHANNELS.petDiaryFromTask, (_event, input) => {
    const request = z
      .object({
        taskId: idSchema,
        userNote: z.string().trim().max(2_000).optional(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.createDiaryFromTask(request.taskId, request.userNote);
  });
  handle(DESKTOP_CHANNELS.petDiaryFromCapture, (_event, input) => {
    const request = z
      .object({
        title: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(50_000),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
        captureId: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.createDiaryFromCapture(request);
  });
  handle(DESKTOP_CHANNELS.petDiaryUpdate, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        patch: z
          .object({
            title: z.string().trim().min(1).max(200),
            content: z.string().trim().max(50_000),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.updateDiary(request.id, request.patch);
  });
  handle(DESKTOP_CHANNELS.petDiaryDelete, (_event, input) =>
    dependencies.pet.deleteDiary(idSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.petMemoryAdd, (_event, input) => {
    const request = z
      .object({
        kind: z.enum(["preference", "relationship", "shared-experience"]),
        content: z.string().trim().min(1).max(2_000),
      })
      .strict()
      .parse(input);
    return dependencies.pet.addMemory(request);
  });
  handle(DESKTOP_CHANNELS.petMemoryUpdate, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        patch: z
          .object({
            content: z.string().trim().min(1).max(2_000).optional(),
            enabled: z.boolean().optional(),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.updateMemory(request.id, request.patch);
  });
  handle(DESKTOP_CHANNELS.petMemoryDelete, (_event, input) =>
    dependencies.pet.deleteMemory(idSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.petHabitAdd, (_event, input) => {
    const request = z
      .object({
        label: z.string().trim().min(1).max(80),
        hint: z.string().trim().max(240),
        cadenceMinutes: z.number().finite().min(15).max(1_440),
      })
      .strict()
      .parse(input);
    return dependencies.pet.addHabit(request);
  });
  handle(DESKTOP_CHANNELS.petHabitUpdate, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        patch: z
          .object({
            label: z.string().trim().min(1).max(80).optional(),
            hint: z.string().trim().max(240).optional(),
            cadenceMinutes: z.number().finite().min(15).max(1_440).optional(),
            enabled: z.boolean().optional(),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.updateHabit(request.id, request.patch);
  });
  handle(DESKTOP_CHANNELS.petHabitComplete, (_event, input) =>
    dependencies.pet.completeHabit(idSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.petHabitSnooze, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        minutes: z.number().finite().min(5).max(1_440).optional(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.snoozeHabit(request.id, request.minutes);
  });
  handle(DESKTOP_CHANNELS.petHabitDelete, (_event, input) =>
    dependencies.pet.deleteHabit(idSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.petGoalAdd, (_event, input) => {
    const request = z
      .object({
        title: z.string().trim().min(1).max(80),
        metric: z.enum(["tasks-completed", "focus-minutes", "habit-checkins"]),
        target: z.number().int().min(1).max(9_999),
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      })
      .strict()
      .parse(input);
    return dependencies.pet.addGoal(request);
  });
  handle(DESKTOP_CHANNELS.petGoalUpdate, (_event, input) => {
    const request = z
      .object({
        id: idSchema,
        patch: z
          .object({
            title: z.string().trim().min(1).max(80).optional(),
            metric: z.enum(["tasks-completed", "focus-minutes", "habit-checkins"]).optional(),
            target: z.number().int().min(1).max(9_999).optional(),
            periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
            periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
            enabled: z.boolean().optional(),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    return dependencies.pet.updateGoal(request.id, request.patch);
  });
  handle(DESKTOP_CHANNELS.petGoalDelete, (_event, input) =>
    dependencies.pet.deleteGoal(idSchema.parse(input)),
  );
  handle(DESKTOP_CHANNELS.petDataExport, () => dependencies.pet.exportData());
  handle(DESKTOP_CHANNELS.petDataPreviewImport, () =>
    dependencies.pet.previewDataImport(),
  );
  handle(DESKTOP_CHANNELS.petDataCommitImport, (_event, input) => {
    const request = z
      .object({
        previewToken: idSchema,
        strategy: z.enum(["skip", "overwrite"]),
      })
      .strict()
      .parse(input);
    return dependencies.pet.commitDataImport(request.previewToken, request.strategy);
  });
  handle(DESKTOP_CHANNELS.petDataCancelImport, (_event, input) =>
    dependencies.pet.cancelDataImport(idSchema.parse(input)),
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
            projects: z.boolean().optional(),
            lists: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input ?? {});
    return dependencies.data.exportToFile(request);
  });
  handle(DESKTOP_CHANNELS.dataMarkdownExport, (_event, input) => {
    const request = z
      .object({
        redaction: z.enum(["none", "private", "strict"]).optional(),
        include: z
          .object({
            tasks: z.boolean().optional(),
            projects: z.boolean().optional(),
            lists: z.boolean().optional(),
            operations: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input ?? {});
    return dependencies.data.exportMarkdownToFile(request);
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
