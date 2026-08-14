import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  Menu,
  app,
  dialog,
  globalShortcut,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  systemPreferences,
} from "electron";
import { DESKTOP_CHANNELS } from "../src/shared/desktop-api";
import type {
  DataDesktopApi,
  FeishuConfigureRequest,
  FeishuDesktopApi,
  FeishuStatusView,
} from "../src/shared/desktop-api";
import { defaultSettings, type AppSettings } from "../src/shared/settings";
import { registerDesktopIpc } from "./ipc-router";
import { LocalStore } from "./services/local-store";
import { SettingsService } from "./services/settings-service";
import { TaskService } from "./services/task-service";
import { TrayManager, type TrayStatus } from "./tray-manager";
import { WindowManager } from "./window-manager";
import { AgentDesktopService } from "./agent/agent-desktop-service";
import { AuditLog } from "./agent/audit-log";
import { createBuiltinTools } from "./agent/builtin-tools";
import { createElectronToolAdapters } from "./agent/electron-tool-adapters";
import { FileAuditStore } from "./agent/file-audit-store";
import { createTaskTools } from "./agent/task-tools";
import { BuiltinToolExecutors } from "./agent/tool-executors";
import { ToolRegistry } from "./agent/tool-registry";
import { ModelUsageBudgetService } from "./agent/model-usage-budget";
import {
  FeishuDesktopController,
  type FeishuDesktopConfiguration,
} from "./feishu/feishu-desktop-controller";
import {
  createFeishuLocalPorts,
  enqueuePendingFeishuTaskChanges,
  flushPendingFeishuTaskChanges,
} from "./feishu/feishu-local-ports";
import { FeishuAutoSyncCoordinator } from "./feishu/feishu-auto-sync-coordinator";
import { FeishuMutationSyncCoordinator } from "./feishu/feishu-mutation-sync-coordinator";
import {
  createElectronNotificationRuntime,
  type ElectronNotificationRuntime,
} from "./services/electron-notification-runtime";
import { DataDesktopController } from "./services/data-desktop-controller";
import { DesktopDataRepository } from "./services/desktop-data-repository";
import { NodeDataDesktopFilePort } from "./services/node-data-desktop-file-port";

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

let quitting = false;
let windows: WindowManager | undefined;
let tray: TrayManager | undefined;
let unregisterIpc: (() => void) | undefined;
let settingsService: SettingsService | undefined;
let agentService: AgentDesktopService | undefined;
let feishuController: FeishuDesktopController | undefined;
let feishuAutoSync: FeishuAutoSyncCoordinator | undefined;
let feishuMutationSync: FeishuMutationSyncCoordinator | undefined;
let notificationRuntime: ElectronNotificationRuntime | undefined;
let pendingMainRoute: string | undefined;

/**
 * Dock/Finder activation and a second launch can arrive while the main
 * process is still constructing its windows. Keep the user's intent instead
 * of silently dropping it, then let WindowManager restore/show/focus the
 * primary window as soon as it is available.
 */
function requestMainWindow(route?: string): void {
  if (!windows) {
    pendingMainRoute = route ?? pendingMainRoute ?? "today";
    return;
  }
  // Dock activation and a second launch should make the full application the
  // active macOS app even while the always-on-top Todo Pet remains visible.
  if (process.platform === "darwin") app.focus({ steal: true });
  windows.showMain(route);
}

function openTodoAgentHome(): void {
  requestMainWindow("today");
}

const broadcastSettings = (settings: AppSettings): void => {
  nativeTheme.themeSource = settings.theme;
  windows?.broadcast(DESKTOP_CHANNELS.eventSettingsChanged, settings);
  windows?.syncFloatingSettings();
  tray?.refresh();
};

function applyLoginItemSetting(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    path: process.execPath,
  });
}

function registerQuickCaptureShortcut(settings: AppSettings): void {
  globalShortcut.unregisterAll();
  const registered = globalShortcut.register(
    settings.quickCaptureShortcut,
    () => windows?.showQuick(),
  );
  if (!registered)
    windows?.broadcast(
      DESKTOP_CHANNELS.eventShortcutError,
      settings.quickCaptureShortcut,
    );
}

function buildApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      {
        label: "任务",
        submenu: [
          {
            label: "快速录入",
            accelerator: "CommandOrControl+Shift+Space",
            click: () => windows?.showQuick(),
          },
          {
            label: "打开 Today",
            accelerator: "CommandOrControl+1",
            click: openTodoAgentHome,
          },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function feishuConfigurationFromSettings(
  settings: AppSettings,
): FeishuDesktopConfiguration | undefined {
  if (!settings.feishu.configured) return undefined;
  const tokenCredentialId =
    settings.feishu.tokenCredentialId ??
    defaultSettings.feishu.tokenCredentialId!;
  if (settings.feishu.mode === "relay") {
    if (!settings.feishu.relayBaseUrl) return undefined;
    return {
      mode: "relay",
      accountId: settings.feishu.accountId,
      tokenCredentialId,
      relayBaseUrl: settings.feishu.relayBaseUrl,
      clientId: settings.feishu.clientId || undefined,
    };
  }
  if (settings.feishu.mode === "personal-direct") {
    if (!settings.feishu.clientId || !settings.feishu.appSecretCredentialId) {
      return undefined;
    }
    return {
      mode: "personal-direct",
      accountId: settings.feishu.accountId,
      tokenCredentialId,
      clientId: settings.feishu.clientId,
      appSecretCredentialId: settings.feishu.appSecretCredentialId,
    };
  }
  if (settings.feishu.mode === "existing-direct") {
    if (!settings.feishu.clientId || !settings.feishu.appSecretCredentialId) {
      return undefined;
    }
    return {
      mode: "existing-direct",
      accountId: settings.feishu.accountId,
      tokenCredentialId,
      clientId: settings.feishu.clientId,
      appSecretCredentialId: settings.feishu.appSecretCredentialId,
    };
  }
  if (!settings.feishu.clientId || !settings.feishu.appSecretCredentialId)
    return undefined;
  return {
    mode: "local-development",
    accountId: settings.feishu.accountId,
    tokenCredentialId,
    clientId: settings.feishu.clientId,
    appSecretCredentialId: settings.feishu.appSecretCredentialId,
    acknowledgeInsecureLocalCredentials: true,
  };
}

function traySyncState(status: FeishuStatusView): TrayStatus["sync"] {
  if (!status.configured) return "local";
  if (status.state === "syncing") return "pending";
  if (status.state === "error") return "error";
  if (status.lastError?.code === "NETWORK_UNAVAILABLE") return "offline";
  if (status.lastError?.retryable) return "pending";
  return status.connected ? "synced" : "local";
}

async function startApplication(): Promise<void> {
  const userDataPath = app.getPath("userData");
  const store = new LocalStore(path.join(userDataPath, "data"));
  const tasks = new TaskService(store);
  await tasks.initialize();

  // End-to-end profiles are disposable and must never block on a developer
  // machine's interactive Keychain prompt. Production builds always keep the
  // OS-backed safeStorage adapter; the deterministic adapter exists only in
  // explicitly marked test processes and writes only inside their temp profile.
  const settingsEncryption =
    process.env.TODO_AGENT_E2E === "1"
      ? {
          isAvailable: () => true,
          encryptString: (value: string) =>
            Buffer.from(`todo-agent-e2e:${value}`, "utf8"),
          decryptString: (value: Buffer) =>
            value.toString("utf8").replace(/^todo-agent-e2e:/u, ""),
        }
      : {
          isAvailable: () => safeStorage.isEncryptionAvailable(),
          encryptString: (value: string) => safeStorage.encryptString(value),
          decryptString: (value: Buffer) => safeStorage.decryptString(value),
        };
  settingsService = new SettingsService(userDataPath, settingsEncryption);
  await settingsService.load();
  nativeTheme.themeSource = settingsService.get().theme;
  applyLoginItemSetting(settingsService.get().launchAtLogin);

  const preloadPath = path.join(__dirname, "preload.cjs");
  const rendererPath = path.join(app.getAppPath(), "dist", "index.html");
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  windows = new WindowManager({
    preloadPath,
    rendererPath,
    devServerUrl,
    settings: () => settingsService?.get() ?? settingsService!.get(),
    onFloatingPosition: (displayId, position) => {
      if (!settingsService) return;
      const current = settingsService.get();
      void settingsService.replace({
        ...current,
        floating: {
          ...current.floating,
          lastDisplayId: displayId,
          positions: { ...current.floating.positions, [displayId]: position },
        },
      })
        .then(broadcastSettings)
        .catch((error: unknown) => {
          console.error(
            "Failed to save floating window position",
            error instanceof Error ? error.message : error,
          );
        });
    },
    onMainCloseRequested: () =>
      quitting || !(settingsService?.get().closeToTray ?? true),
  });
  if (pendingMainRoute) {
    const route = pendingMainRoute;
    pendingMainRoute = undefined;
    windows.showMain(route);
  }

  const status: TrayStatus = {
    sync: "local",
    agent: settingsService.get().ai.enabled ? "ready" : "disabled",
    floatingVisible: settingsService.get().floating.enabled,
    launchAtLogin: settingsService.get().launchAtLogin,
  };
  const localPorts = createFeishuLocalPorts({
    taskService: tasks,
    localStore: store,
  });
  feishuController = new FeishuDesktopController({
    ...localPorts,
    userDataPath,
    settings: settingsService,
    onStatusChange: (next) => {
      status.sync = traySyncState(next);
      windows?.broadcast(DESKTOP_CHANNELS.eventFeishuStatus, next);
      tray?.refresh();
      feishuAutoSync?.onStatus(next);
    },
    onSecurityWarning: (message) => {
      void dialog.showMessageBox({
        type: "warning",
        title: "飞书开发者模式",
        message: "开发者模式会在本机进程中使用飞书 App Secret。",
        detail: `${message}\n仅用于你自己的开发环境，不应分发给其他用户。`,
        buttons: ["我已了解"],
        noLink: true,
      });
    },
    onPersonalConfiguration: async (configuration) => {
      const current = settingsService!.get();
      const next = await settingsService!.replace({
        ...current,
        feishu: {
          ...current.feishu,
          configured: true,
          mode: "personal-direct",
          accountId: configuration.accountId,
          tokenCredentialId: configuration.tokenCredentialId,
          relayBaseUrl: "",
          clientId: configuration.clientId,
          appSecretCredentialId: configuration.appSecretCredentialId,
          acknowledgeInsecureLocalCredentials: false,
        },
      });
      broadcastSettings(next);
    },
    onOpenAuthorizationUrl: (url) => shell.openExternal(url),
  });
  feishuAutoSync = new FeishuAutoSyncCoordinator({
    getStatus: () => {
      const connection = feishuController?.status();
      return {
        connected: connection?.connected === true,
        polling: connection?.polling === true,
      };
    },
    getPolicy: () => ({
      enabled: settingsService?.get().feishu.autoSync === true,
      pollingIntervalMs:
        (settingsService?.get().feishu.pollingMinutes ?? 1) * 60_000,
    }),
    startPolling: (intervalMs) => feishuController!.startPolling(intervalMs),
    resumeAfterReconnect: () => feishuController!.resumeAfterReconnect(),
    onReport: () => {
      windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
      tray?.refresh();
    },
    onError: (error: unknown) => {
      console.error(
        "Failed to start automatic Feishu sync",
        error instanceof Error ? error.message : error,
      );
    },
  });
  const initialFeishuConfiguration = feishuConfigurationFromSettings(
    settingsService.get(),
  );
  if (initialFeishuConfiguration) {
    try {
      await feishuController.configure(initialFeishuConfiguration);
      // Configuration can restore an already-connected token without a fresh
      // status edge. Reconcile explicitly so startup and OAuth completion use
      // the same automatic first-sync path.
      feishuAutoSync.reconcile();
    } catch (error) {
      console.error(
        "Failed to restore Feishu integration",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const enqueuePendingFeishuChanges = async (): Promise<number> => {
    const controller = feishuController;
    if (!controller?.status().configured) return 0;
    return enqueuePendingFeishuTaskChanges(tasks, {
      accountId: controller.status().accountId,
      notifyLocalDelete: (localId) => controller.notifyLocalDelete(localId),
      notifyLocalComplete: (localId, completed) =>
        controller.notifyLocalComplete(localId, completed),
      notifyLocalUpsert: (localId) => controller.notifyLocalUpsert(localId),
    });
  };
  const flushPendingFeishuChanges = async (): Promise<void> => {
    const controller = feishuController;
    if (!controller?.status().configured) return;
    const connection = controller.status();
    const { syncResult: report } = await flushPendingFeishuTaskChanges(tasks, {
      accountId: connection.accountId,
      notifyLocalDelete: (localId) => controller.notifyLocalDelete(localId),
      notifyLocalComplete: (localId, completed) =>
        controller.notifyLocalComplete(localId, completed),
      notifyLocalUpsert: (localId) => controller.notifyLocalUpsert(localId),
      shouldSync:
        connection.connected === true &&
        settingsService?.get().feishu.autoSync === true,
      syncNow: () => controller.syncNow(),
    });
    if (!report) return;
    status.sync =
      report.conflicts.length > 0
        ? "conflict"
        : report.offline
          ? "offline"
          : "synced";
    windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
    tray?.refresh();
  };
  feishuMutationSync = new FeishuMutationSyncCoordinator({
    flush: flushPendingFeishuChanges,
    onError: (error: unknown) => {
      console.error(
        "Failed to queue Feishu task change",
        error instanceof Error ? error.message : error,
      );
    },
  });
  const schedulePendingFeishuChanges = (): void => {
    feishuMutationSync?.requestFlush();
  };
  const refreshFloatingFocusMode = (): void => {
    void tasks
      .listTasks({ statuses: ["open"], includeDeleted: false })
      .then((items) =>
        windows?.setFocusActive(
          items.some((task) => Boolean(task.focusStartedAt)),
        ),
      )
      .catch((error: unknown) => {
        console.error(
          "Failed to refresh floating focus state",
          error instanceof Error ? error.message : error,
        );
      });
  };
  const handleTasksChanged = (): void => {
    windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
    refreshFloatingFocusMode();
    schedulePendingFeishuChanges();
    if (notificationRuntime?.isStarted) {
      void notificationRuntime
        .refresh("task-change")
        .catch((error: unknown) => {
          console.error(
            "Failed to refresh reminders",
            error instanceof Error ? error.message : error,
          );
        });
    }
  };
  const agentWorkspace = path.join(userDataPath, "agent-workspace");
  await mkdir(agentWorkspace, { recursive: true });
  const toolAdapters = createElectronToolAdapters();
  const auditStore = new FileAuditStore({
    directory: path.join(userDataPath, "audit"),
  });
  const auditLog = new AuditLog({
    store: auditStore,
  });
  const modelUsageBudget = new ModelUsageBudgetService({
    filePath: path.join(userDataPath, "private", "model-usage.v1.json"),
  });
  await modelUsageBudget.initialize();
  agentService = new AgentDesktopService({
    settings: settingsService,
    auditLog,
    usageBudget: modelUsageBudget,
    listMorningTasks: () => tasks.listTasks({ view: "today" }),
    getTaskForSyncReceipt: (id) => tasks.getTask(id, true),
    createToolRegistry: ({ sourcePolicy }) => {
      const executors = new BuiltinToolExecutors({
        allowedRoots: [agentWorkspace],
        adapters: toolAdapters,
      });
      return new ToolRegistry([
        ...createTaskTools({
          tasks,
          getModelDataScope: () => settingsService!.get().modelDataScope,
          sourcePolicy,
          getFeishuAccountId: () => {
            const connection = feishuController?.status();
            return connection?.connected ? connection.accountId : undefined;
          },
          onTasksChanged: handleTasksChanged,
        }),
        ...createBuiltinTools(executors),
      ]);
    },
    onEvent: (event) => {
      const payload = event.payload as { state?: string };
      if (payload.state === "model-streaming") status.agent = "thinking";
      if (payload.state === "tool-running") status.agent = "running";
      if (
        [
          "completed",
          "failed",
          "cancelled",
          "partial",
          "external-effect",
        ].includes(payload.state ?? "")
      ) {
        status.agent = settingsService?.get().ai.enabled ? "ready" : "disabled";
      }
      windows?.broadcast(DESKTOP_CHANNELS.eventAgentRun, event);
      tray?.refresh();
    },
    onApproval: (approval) => {
      status.agent = "awaiting-approval";
      windows?.broadcast(DESKTOP_CHANNELS.eventAgentApproval, approval);
      tray?.refresh();
    },
  });
  tray = new TrayManager({
    iconPath: path.join(app.getAppPath(), "assets", "trayTemplate.svg"),
    getStatus: () => ({
      ...status,
      agent: settingsService?.get().ai.enabled
        ? status.agent === "disabled"
          ? "ready"
          : status.agent
        : "disabled",
      floatingVisible: settingsService?.get().floating.enabled ?? false,
      launchAtLogin: settingsService?.get().launchAtLogin ?? false,
    }),
    showMain: (route) => requestMainWindow(route),
    showQuick: () => windows?.showQuick(),
    toggleFloating: (visible) => {
      if (!settingsService) return;
      const current = settingsService.get();
      void settingsService
        .replace({
          ...current,
          floating: { ...current.floating, enabled: visible },
        })
        .then(broadcastSettings);
    },
    setLaunchAtLogin: (enabled) => {
      if (!settingsService) return;
      const current = settingsService.get();
      applyLoginItemSetting(enabled);
      void settingsService
        .replace({ ...current, launchAtLogin: enabled })
        .then(broadcastSettings);
    },
    stopAgent: () => {
      agentService?.stop();
      status.agent = "stopped";
      tray?.refresh();
    },
    quit: () => app.quit(),
  });

  notificationRuntime = await createElectronNotificationRuntime({
    userDataPath,
    taskService: tasks,
    settingsService,
    onInAppNotification: (event) => {
      windows?.broadcast(DESKTOP_CHANNELS.eventNotification, event);
    },
    onOpen: openTodoAgentHome,
    onTasksChanged: handleTasksChanged,
    onError: (error, operation) => {
      console.error(
        `Reminder operation failed: ${operation}`,
        error instanceof Error ? error.message : error,
      );
    },
  });
  const dataRepository = new DesktopDataRepository({
    localStore: store,
    settings: settingsService,
    auditLog,
  });
  const dataController = new DataDesktopController({
    dataRepository,
    files: new NodeDataDesktopFilePort(),
    dialogs: {
      chooseExportPath: async ({ defaultFileName }) => {
        const result = await dialog.showSaveDialog({
          title: "导出 Todo Agent 数据",
          defaultPath: path.join(app.getPath("documents"), defaultFileName),
          filters: [{ name: "Todo Agent 数据", extensions: ["json"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        return result.canceled ? undefined : result.filePath;
      },
      chooseImportPath: async () => {
        const result = await dialog.showOpenDialog({
          title: "导入 Todo Agent 数据",
          defaultPath: app.getPath("documents"),
          filters: [{ name: "Todo Agent 数据", extensions: ["json"] }],
          properties: ["openFile"],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
    },
  });

  const finishFeishuAuthorization = (): void => {
    void feishuController!
      .completeOAuth()
      .then(async (connected) => {
        if (connected.connected && settingsService?.get().feishu.autoSync) {
          await feishuController!.startPolling(
            settingsService.get().feishu.pollingMinutes * 60_000,
          );
          const report = await feishuController!.syncNow();
          status.sync =
            report.conflicts.length > 0
              ? "conflict"
              : report.offline
                ? "offline"
                : "synced";
          windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
          tray?.refresh();
        }
      })
      .catch((error: unknown) => {
        console.error(
          "Feishu OAuth did not complete",
          error instanceof Error ? error.message : error,
        );
      });
  };

  const feishuApi: FeishuDesktopApi = {
    status: async () => feishuController!.status(),
    configure: async (request: FeishuConfigureRequest) => {
      const nextStatus = await feishuController!.configure(request);
      const current = settingsService!.get();
      const nextSettings = await settingsService!.replace({
        ...current,
        feishu: {
          ...current.feishu,
          configured: true,
          mode: request.mode,
          accountId: request.accountId,
          tokenCredentialId: request.tokenCredentialId,
          relayBaseUrl: request.mode === "relay" ? request.relayBaseUrl : "",
          clientId: request.clientId ?? "",
          appSecretCredentialId:
            request.mode === "local-development" ||
            request.mode === "personal-direct" ||
            request.mode === "existing-direct"
              ? request.appSecretCredentialId
              : undefined,
          acknowledgeInsecureLocalCredentials:
            request.mode === "local-development",
        },
      });
      broadcastSettings(nextSettings);
      if (nextStatus.connected && nextSettings.feishu.autoSync) {
        await feishuController!.startPolling(
          nextSettings.feishu.pollingMinutes * 60_000,
        );
      }
      return feishuController!.status();
    },
    beginPersonalConnect: async () => {
      const current = settingsService!.get();
      const tokenCredentialId =
        current.feishu.tokenCredentialId ??
        defaultSettings.feishu.tokenCredentialId!;
      const appSecretCredentialId =
        current.feishu.appSecretCredentialId ??
        `feishu-${current.feishu.accountId.trim()}-app-secret`;
      const started = await feishuController!.beginPersonalConnect({
        accountId: current.feishu.accountId,
        tokenCredentialId,
        appSecretCredentialId,
      });
      try {
        await shell.openExternal(started.authorizeUrl);
      } catch (error) {
        await feishuController!.cancelOAuth().catch(() => undefined);
        throw error;
      }
      finishFeishuAuthorization();
      return started;
    },
    beginOAuth: async () => {
      const started = await feishuController!.beginOAuth();
      try {
        await shell.openExternal(started.authorizeUrl);
      } catch (error) {
        await feishuController!.cancelOAuth().catch(() => undefined);
        throw error;
      }
      finishFeishuAuthorization();
      return started;
    },
    cancelOAuth: () => feishuController!.cancelOAuth(),
    disconnect: () => feishuController!.disconnect(),
    syncNow: async (forceFull) => {
      const report = await feishuMutationSync!.runNow(async () => {
        await enqueuePendingFeishuChanges();
        return feishuController!.syncNow({ forceFull });
      });
      status.sync =
        report.conflicts.length > 0
          ? "conflict"
          : report.offline
            ? "offline"
            : "synced";
      windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
      tray?.refresh();
      return report;
    },
    listConflicts: () => feishuController!.listConflicts(),
    resolveConflict: async (localId, decision) => {
      const result = await feishuController!.resolveConflict(localId, decision);
      handleTasksChanged();
      return result;
    },
  };
  const dataApi: DataDesktopApi = {
    exportToFile: (request) => dataController.exportToFile(request),
    previewImport: () => dataController.previewImport(),
    commitImport: async (previewToken, strategy) => {
      const result = await dataController.commitImport(previewToken, strategy);
      broadcastSettings(settingsService!.get());
      handleTasksChanged();
      return result;
    },
    cancelPreview: async (previewToken) =>
      dataController.cancelPreview(previewToken),
    clearLocalData: async (request) => {
      const labels = [
        request.tasks ? "任务" : "",
        request.drafts ? "草稿" : "",
        request.operations ? "撤销历史" : "",
        request.resetSettings ? "应用设置" : "",
      ].filter(Boolean);
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "清除本地数据",
        message: `确认清除：${labels.join("、")}？`,
        detail:
          "此操作不可撤销。飞书远端任务不会被删除；若清除任务，自动同步会暂停，避免远端任务立即重新出现。系统安全存储中的 API Key 与飞书凭据不会被删除。",
        buttons: ["取消", "清除本地数据"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) {
        return {
          status: "cancelled",
          tasks: 0,
          drafts: 0,
          operations: 0,
          settingsReset: false,
        };
      }
      const counts = await dataRepository.transact((draft) => {
        const result = {
          tasks: request.tasks ? Object.keys(draft.taskState.tasks).length : 0,
          drafts: request.drafts
            ? Object.keys(draft.taskState.drafts).length
            : 0,
          operations: request.operations
            ? draft.taskState.operations.length
            : 0,
          settingsReset: request.resetSettings,
        };
        if (request.tasks) draft.taskState.tasks = {};
        if (request.drafts) draft.taskState.drafts = {};
        if (request.operations) draft.taskState.operations = [];
        if (request.resetSettings) {
          const current = draft.settings;
          draft.settings = structuredClone(defaultSettings);
          draft.settings.ai.credentialId = current.ai.credentialId;
          draft.settings.feishu.tokenCredentialId =
            current.feishu.tokenCredentialId;
          draft.settings.feishu.appSecretCredentialId =
            current.feishu.appSecretCredentialId;
        }
        if (request.tasks) draft.settings.feishu.autoSync = false;
        return result;
      });
      if (request.tasks) feishuController?.stopPolling();
      broadcastSettings(settingsService!.get());
      handleTasksChanged();
      return { status: "cleared", ...counts };
    },
  };

  unregisterIpc = registerDesktopIpc({
    tasks,
    settings: settingsService,
    agent: agentService,
    feishu: feishuApi,
    notifications: {
      handleAction: (event) => notificationRuntime!.handleAction(event),
      snoozeUntil: (reminderId, snoozeUntil) =>
        notificationRuntime!.snoozeUntil(reminderId, snoozeUntil),
      refresh: async () => {
        await notificationRuntime!.refresh("manual");
      },
    },
    data: dataApi,
    devServerUrl,
    rendererPath,
    getInfo: () => ({
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      secureStorageAvailable: safeStorage.isEncryptionAvailable(),
    }),
    showMain: (route) => requestMainWindow(route),
    showQuickCapture: () => windows?.showQuick(),
    setFloatingVisible: async (visible) => {
      const current = settingsService!.get();
      const next = await settingsService!.replace({
        ...current,
        floating: { ...current.floating, enabled: visible },
      });
      broadcastSettings(next);
      return next;
    },
    setFloatingExpanded: (expanded) => windows?.setFloatingExpanded(expanded),
    setLaunchAtLogin: async (enabled) => {
      applyLoginItemSetting(enabled);
      const next = await settingsService!.replace({
        ...settingsService!.get(),
        launchAtLogin: enabled,
      });
      broadcastSettings(next);
      return next;
    },
    openExternal: (url) => shell.openExternal(url),
    onTasksChanged: handleTasksChanged,
    onSettingsChanged: (settings) => {
      status.agent = settings.ai.enabled ? "ready" : "disabled";
      registerQuickCaptureShortcut(settings);
      if (!settings.feishu.configured) {
        feishuController?.stopPolling();
        const connection = feishuController?.status();
        if (
          connection?.connected ||
          connection?.state === "authorizing" ||
          connection?.state === "syncing"
        ) {
          void feishuController?.disconnect().catch((error: unknown) => {
            console.error(
              "Failed to suspend the previous Feishu connection",
              error instanceof Error ? error.message : error,
            );
          });
        }
      } else if (!settings.feishu.autoSync) {
        feishuController?.stopPolling();
        feishuAutoSync?.onSettingsChanged();
      } else if (feishuController?.status().connected) {
        feishuAutoSync?.onSettingsChanged();
      }
      if (notificationRuntime?.isStarted) {
        void notificationRuntime
          .refresh("settings-change")
          .catch((error: unknown) => {
            console.error(
              "Failed to apply reminder settings",
              error instanceof Error ? error.message : error,
            );
          });
      }
      broadcastSettings(settings);
    },
    authenticateFullAccess: async () => {
      if (
        process.platform === "darwin" &&
        systemPreferences.canPromptTouchID()
      ) {
        await systemPreferences.promptTouchID("开启 Todo Agent 临时全权限");
        return new Date().toISOString();
      }
      const confirmation = await dialog.showMessageBox({
        type: "warning",
        title: "开启临时全权限",
        message: "确认允许 Agent 在所列精确范围内执行高风险操作？",
        detail:
          "全权限仍不会开放永久删除系统目录、绕过权限、读取凭据或执行其他 R4 禁止项，并会在到期或退出应用时撤销。",
        buttons: ["取消", "确认开启"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1)
        throw new Error("FULL_ACCESS_AUTH_CANCELLED");
      return new Date().toISOString();
    },
  });

  buildApplicationMenu();
  tray.create();
  windows.createMain();
  refreshFloatingFocusMode();
  windows.createFloating();
  const ensureFloatingVisible = (): void => windows?.ensureFloatingVisible();
  screen.on("display-added", ensureFloatingVisible);
  screen.on("display-removed", ensureFloatingVisible);
  screen.on("display-metrics-changed", ensureFloatingVisible);
  registerQuickCaptureShortcut(settingsService.get());
  await notificationRuntime.start();
  const revokeFullAccessForSystemState = (): void => {
    agentService?.revokeFullAccess();
  };
  powerMonitor.on("lock-screen", revokeFullAccessForSystemState);
  powerMonitor.on("suspend", revokeFullAccessForSystemState);
  powerMonitor.on("resume", () => {
    windows?.ensureFloatingVisible();
    if (
      settingsService?.get().feishu.autoSync &&
      feishuController?.status().connected
    ) {
      // A wake commonly coincides with the network becoming available again.
      // The controller checks connectivity before touching the remote queue.
      void feishuController
        .resumeAfterReconnect()
        .then((report) => {
          if (!report) return;
          windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
          tray?.refresh();
        })
        .catch((error: unknown) => {
          console.error(
            "Failed to resume Feishu sync after system wake",
            error instanceof Error ? error.message : error,
          );
        });
    }
    if (!notificationRuntime?.isStarted) return;
    void notificationRuntime.refresh("system-wake").catch((error: unknown) => {
      console.error(
        "Failed to refresh reminders after wake",
        error instanceof Error ? error.message : error,
      );
    });
  });
}

app.on("second-instance", openTodoAgentHome);
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  feishuMutationSync?.dispose();
  feishuController?.stopPolling();
  void feishuController?.cancelOAuth().catch(() => undefined);
  void notificationRuntime?.stop();
  unregisterIpc?.();
  tray?.destroy();
});
app.on("activate", openTodoAgentHome);

void app
  .whenReady()
  .then(startApplication)
  .catch((error: unknown) => {
    console.error("Failed to start Todo Agent", error);
    app.exit(1);
  });
