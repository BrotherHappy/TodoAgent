import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import {
  Menu,
  Notification,
  app,
  clipboard,
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
  ActiveWindowContextView,
  DataDesktopApi,
  FeishuConfigureRequest,
  FeishuDesktopApi,
  FeishuStatusView,
  PetDesktopApi,
  SelectedTextContextView,
} from "../src/shared/desktop-api";
import type { TaskAttachment } from "../src/shared/models";
import { defaultSettings, type AppSettings } from "../src/shared/settings";
import { withBossMode } from "../src/shared/boss-mode";
import {
  buildClipboardContextPreview,
  buildSelectedTextContextPreview,
} from "../src/shared/context-capture";
import {
  buildActiveWindowContext,
  parseActiveWindowOutput,
} from "../src/shared/window-context";
import type { WeatherSnapshot } from "../src/shared/pet-types";
import { registerDesktopIpc } from "./ipc-router";
import { LocalStore } from "./services/local-store";
import { SettingsService } from "./services/settings-service";
import { TaskService } from "./services/task-service";
import { TaskAutomationService } from "./services/task-automation-service";
import { TrayManager, type TrayStatus } from "./tray-manager";
import { buildTrayTodaySummary } from "./tray-task-preview";
import { WindowManager } from "./window-manager";
import { AgentDesktopService } from "./agent/agent-desktop-service";
import { AuditLog } from "./agent/audit-log";
import { createBuiltinTools } from "./agent/builtin-tools";
import { createElectronToolAdapters } from "./agent/electron-tool-adapters";
import { FileAuditStore } from "./agent/file-audit-store";
import { createTaskTools } from "./agent/task-tools";
import { isAgentToolEnabled } from "../src/shared/agent-capabilities";
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
import { PetDataDesktopController } from "./services/pet-data-desktop-controller";
import { DesktopDataRepository } from "./services/desktop-data-repository";
import { NodeDataDesktopFilePort } from "./services/node-data-desktop-file-port";
import { PetService } from "./services/pet-service";
import { WeatherService } from "./services/weather-service";
import { TaskAttachmentService } from "./services/task-attachment-service";
import {
  PET_INPUT_ACTIVITY_POLL_MS,
  petInputActivityKind,
  shouldEmitPetInputActivity,
} from "./pet-input-activity";

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
let petService: PetService | undefined;
let weatherService: WeatherService | undefined;
let petTickTimer: ReturnType<typeof setInterval> | undefined;
let taskAutomationTimer: ReturnType<typeof setInterval> | undefined;
let petInputActivityTimer: ReturnType<typeof setInterval> | undefined;
let lastPetInputActivityAt = 0;
let weatherRefreshTimer: ReturnType<typeof setInterval> | undefined;
let pendingMainRoute: string | undefined;
let lastSevereWeatherNotificationKey: string | undefined;

const runBoundedCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs = 1_500,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("ACTIVE_WINDOW_TIMEOUT")));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 4_096) {
        child.kill();
        finish(() => reject(new Error("ACTIVE_WINDOW_OUTPUT_TOO_LARGE")));
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 4_096) stderr = stderr.slice(-4_096);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `ACTIVE_WINDOW_EXIT_${code ?? "unknown"}`));
      });
    });
  });

const readActiveWindowContext = async (): Promise<ActiveWindowContextView> => {
  const capturedAt = new Date();
  if (process.platform === "darwin") {
    const script = [
      'tell application "System Events"',
      "set frontProcess to first application process whose frontmost is true",
      "set appName to name of frontProcess",
      "set windowTitle to name of front window of frontProcess",
      "return appName & tab & windowTitle",
      "end tell",
    ].join("\n");
    try {
      return parseActiveWindowOutput(
        await runBoundedCommand("/usr/bin/osascript", ["-e", script]),
        capturedAt,
      );
    } catch {
      return {
        status: "unavailable",
        reason: "permission-denied",
        capturedAt: capturedAt.toISOString(),
      };
    }
  }
  if (process.platform === "win32") {
    const script = [
      "Add-Type @'",
      "using System; using System.Text; using System.Runtime.InteropServices;",
      "public static class TodoAgentWin32 { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }",
      "'@",
      "$handle = [TodoAgentWin32]::GetForegroundWindow()",
      "$title = New-Object System.Text.StringBuilder 1024",
      "[TodoAgentWin32]::GetWindowText($handle, $title, $title.Capacity) | Out-Null",
      "$processId = [uint32]0",
      "[TodoAgentWin32]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null",
      "$process = Get-Process -Id $processId -ErrorAction SilentlyContinue",
      "$appName = if ($null -eq $process) { '' } else { $process.ProcessName }",
      "Write-Output ($appName + [char]9 + $title.ToString())",
    ].join("; ");
    try {
      return parseActiveWindowOutput(
        await runBoundedCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]),
        capturedAt,
      );
    } catch {
      return {
        status: "unavailable",
        reason: "error",
        capturedAt: capturedAt.toISOString(),
      };
    }
  }
  return buildActiveWindowContext(undefined, undefined, capturedAt);
};

const SELECTED_TEXT_CAPTURE_TIMEOUT_MS = 900;
const SELECTED_TEXT_SETTLE_MS = 90;

const selectedTextUnavailable = (
  reason: SelectedTextContextView["reason"],
  capturedAt = new Date(),
): SelectedTextContextView => ({
  status: "unavailable",
  reason,
  capturedAt: capturedAt.toISOString(),
});

const waitForSelectedTextClipboard = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, SELECTED_TEXT_SETTLE_MS));

/**
 * Capture the current external selection only after an explicit user action.
 * The platform bridge sends a copy keystroke to the foreground app, reads a
 * bounded plain-text clipboard value, then restores the previous text value.
 * No selection is sent to a model or saved as a task automatically.
 */
const captureSelectedTextFromActiveApp = async (): Promise<SelectedTextContextView> => {
  const capturedAt = new Date();
  const previousClipboard = clipboard.readText();
  const previousClipboardFormats = clipboard.availableFormats();
  const previousClipboardBuffers = previousClipboardFormats.map((format) => ({
    format,
    data: clipboard.readBuffer(format),
  }));
  const restoreClipboard = () => {
    try {
      clipboard.clear();
      for (const { format, data } of previousClipboardBuffers) {
        clipboard.writeBuffer(format, data);
      }
      if (!previousClipboardFormats.length && previousClipboard) {
        clipboard.writeText(previousClipboard);
      }
    } catch {
      // Fall back to the previous plain-text value if a platform-specific
      // format cannot be restored. Clipboard cleanup must never block the
      // quick-capture window.
      try {
        clipboard.writeText(previousClipboard);
      } catch {
        // Ignore cleanup failures; the selection itself is still explicit and
        // bounded, and no content is sent to a model automatically.
      }
    }
  };
  try {
    if (process.platform === "darwin") {
      const script = [
        'tell application "System Events"',
        "set frontProcess to first application process whose frontmost is true",
        "set processName to name of frontProcess",
        'if processName contains "Todo Agent" then return "__TODO_AGENT__"',
        'keystroke "c" using {command down}',
        "return processName",
        "end tell",
      ].join("\n");
      const processName = (await runBoundedCommand(
        "/usr/bin/osascript",
        ["-e", script],
        SELECTED_TEXT_CAPTURE_TIMEOUT_MS,
      )).trim();
      if (processName === "__TODO_AGENT__") return selectedTextUnavailable("unsupported", capturedAt);
    } else if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type @'",
        "using System; using System.Runtime.InteropServices;",
        "public static class TodoAgentSelection { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }",
        "'@",
        "$handle = [TodoAgentSelection]::GetForegroundWindow()",
        "$processId = [uint32]0",
        "[TodoAgentSelection]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null",
        "$process = Get-Process -Id $processId -ErrorAction SilentlyContinue",
        "$name = if ($null -eq $process) { '' } else { $process.ProcessName }",
        "if ($name -match 'Todo Agent|electron') { Write-Output '__TODO_AGENT__'; exit 0 }",
        "[System.Windows.Forms.SendKeys]::SendWait('^c')",
        "Write-Output $name",
      ].join("; ");
      const processName = (await runBoundedCommand(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        SELECTED_TEXT_CAPTURE_TIMEOUT_MS,
      )).trim();
      if (processName === "__TODO_AGENT__") return selectedTextUnavailable("unsupported", capturedAt);
    } else {
      return selectedTextUnavailable("unsupported", capturedAt);
    }
    await waitForSelectedTextClipboard();
    const selected = clipboard.readText();
    if (!selected.trim() || selected === previousClipboard) {
      return selectedTextUnavailable("empty", capturedAt);
    }
    return {
      status: "captured",
      ...buildSelectedTextContextPreview(selected, capturedAt),
    };
  } catch {
    return selectedTextUnavailable(
      process.platform === "darwin" ? "permission-denied" : "error",
      capturedAt,
    );
  } finally {
    restoreClipboard();
  }
};

let pendingSelectedText: SelectedTextContextView | undefined;
let selectedTextCaptureInFlight: Promise<void> | undefined;

const captureSelectionBeforeQuickCapture = async (): Promise<void> => {
  if (selectedTextCaptureInFlight) return selectedTextCaptureInFlight;
  selectedTextCaptureInFlight = captureSelectedTextFromActiveApp()
    .then((result) => {
      pendingSelectedText = result.status === "captured" ? result : undefined;
    })
    .catch(() => {
      pendingSelectedText = undefined;
    })
    .finally(() => {
      selectedTextCaptureInFlight = undefined;
    });
  return selectedTextCaptureInFlight;
};

const showQuickCaptureWithSelection = (): void => {
  void captureSelectionBeforeQuickCapture().finally(() => windows?.showQuick());
};

function minuteOfDay(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

function systemNotificationAllowed(
  settings: AppSettings,
  now = new Date(),
): boolean {
  if (!settings.notifications.enabled || !settings.notifications.banners) {
    return false;
  }
  if (
    settings.notifications.mutedUntil &&
    new Date(settings.notifications.mutedUntil).getTime() > now.getTime()
  ) {
    return false;
  }
  if (!settings.notifications.quietHoursEnabled) return true;
  const start = minuteOfDay(settings.notifications.quietHoursStart);
  const end = minuteOfDay(settings.notifications.quietHoursEnd);
  if (start === undefined || end === undefined || start === end) return true;
  const current = now.getHours() * 60 + now.getMinutes();
  const quiet =
    start < end
      ? current >= start && current < end
      : current >= start || current < end;
  return !quiet;
}

function notifySevereWeather(weather?: WeatherSnapshot): void {
  if (
    !weather?.severe ||
    !settingsService ||
    !settingsService.get().pet.proactiveMessages ||
    !systemNotificationAllowed(settingsService.get()) ||
    !Notification.isSupported() ||
    process.env.TODO_AGENT_E2E === "1"
  ) {
    return;
  }
  const key = `${localDateKey()}:${weather.city}:${weather.conditionCode}`;
  if (key === lastSevereWeatherNotificationKey) return;
  lastSevereWeatherNotificationKey = key;
  new Notification({
    title: `${settingsService.get().persona.name}的天气提醒`,
    body: `${weather.city}当前为${weather.conditionLabel}，外出前请留意官方预警。`,
    silent: !settingsService.get().notifications.sound,
  }).show();
}

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
    showQuickCaptureWithSelection,
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
            click: showQuickCaptureWithSelection,
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

function traySyncStateForReport(
  controller: FeishuDesktopController,
  report: { conflicts: unknown[] },
): TrayStatus["sync"] {
  const state = traySyncState(controller.status());
  // Preserve terminal/offline states; a conflict is only a warning when the
  // connection itself is healthy.
  if (state === "error" || state === "offline" || state === "pending") {
    return state;
  }
  return report.conflicts.length > 0 ? "conflict" : state;
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function startApplication(): Promise<void> {
  const userDataPath = app.getPath("userData");
  const store = new LocalStore(path.join(userDataPath, "data"));
  const taskAttachmentService = new TaskAttachmentService(userDataPath);
  const tasks = new TaskService(store);
  await tasks.initialize();
  // Reconcile once before any renderer can select a new file. Running this
  // during every task-change event would race the short window between a
  // picker copy and the subsequent task update.
  void tasks
    .listTasks({ includeDeleted: true })
    .then((items) =>
      taskAttachmentService.removeUnreferenced(
        new Set(
          items.flatMap((task) =>
            task.attachments
              .map((attachment) => attachment.localPath)
              .filter((value): value is string => Boolean(value)),
          ),
        ),
      ),
    )
    .catch((error: unknown) => {
      console.error(
        "Failed to reconcile task attachments",
        error instanceof Error ? error.message : error,
      );
    });

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
  // Keep one settled task snapshot for deterministic local automation edges.
  // Rules are evaluated only after the settings file is loaded, so a malformed
  // older settings file cannot execute anything during startup.
  const taskAutomationService = new TaskAutomationService(
    tasks,
    () => settingsService?.get().automations ?? [],
  );
  let taskAutomationSnapshot = await tasks.listTasks({ includeDeleted: true });
  let taskChangeQueue: Promise<void> = Promise.resolve();
  nativeTheme.themeSource = settingsService.get().theme;
  applyLoginItemSetting(settingsService.get().launchAtLogin);

  petService = new PetService({
    userDataPath,
    initialName: settingsService.get().persona.name,
    onEvent: (event) => {
      windows?.broadcast(DESKTOP_CHANNELS.eventPet, event);
      if (event.type === "state-changed") {
        const focus = petService?.snapshot().focus;
        windows?.setFocusActive(
          focus?.phase === "focus" && focus.status === "running",
        );
      }
      if (
        event.type === "focus-phase-completed" &&
        event.focus?.phase === "focus" &&
        event.focus.taskId
      ) {
        void tasks.pauseFocus(event.focus.taskId).then(() => {
          windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
        }).catch(() => undefined);
      }
      if (
        event.type === "focus-phase-started" &&
        event.focus?.phase === "focus" &&
        event.focus.taskId
      ) {
        void tasks.startFocus(event.focus.taskId).then(() => {
          windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
        }).catch(() => undefined);
      }
      if (
        event.type === "focus-phase-completed" &&
        settingsService &&
        systemNotificationAllowed(settingsService.get()) &&
        Notification.isSupported() &&
        process.env.TODO_AGENT_E2E !== "1"
      ) {
        const phase = event.focus?.phase;
        new Notification({
          title: phase === "focus" ? "专注完成" : "休息结束",
          body:
            phase === "focus"
              ? `${settingsService.get().persona.name}陪你完成了这一轮，休息一下吧。`
              : "准备好后，可以开始下一轮。",
          silent: !settingsService.get().notifications.sound,
        }).show();
      }
    },
  });
  await petService.initialize();
  weatherService = new WeatherService({
    userDataPath,
    settings: () => settingsService!.get().weather,
  });
  await weatherService.initialize();

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
    mousePassthrough: settingsService.get().floating.mousePassthrough,
    meetingMode: settingsService.get().pet.meetingMode,
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
    onConfigurationChange: async (configuration) => {
      const current = settingsService!.get();
      const next = await settingsService!.replace({
        ...current,
        feishu: {
          ...current.feishu,
          configured: true,
          mode: configuration.mode,
          accountId: configuration.accountId,
          tokenCredentialId: configuration.tokenCredentialId,
          relayBaseUrl:
            configuration.mode === "relay"
              ? configuration.relayBaseUrl
              : "",
          clientId: configuration.clientId ?? "",
          appSecretCredentialId:
            configuration.mode === "relay"
              ? undefined
              : configuration.appSecretCredentialId,
          acknowledgeInsecureLocalCredentials:
            configuration.mode === "local-development",
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
  const restoreInitialFeishuConfiguration = (): void => {
    if (!initialFeishuConfiguration) return;
    void feishuController!
      .configure(initialFeishuConfiguration)
      .then(() => {
        // Configuration can restore an already-connected token without a
        // fresh status edge. Reconcile explicitly so startup and OAuth
        // completion use the same automatic first-sync path.
        feishuAutoSync?.reconcile();
      })
      .catch((error: unknown) => {
        console.error(
          "Failed to restore Feishu integration",
          error instanceof Error ? error.message : error,
        );
      });
  };

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
    // The controller status is the source of truth. A successful write can
    // still carry a permission/error issue, so report.offline/conflicts alone
    // must never overwrite an error with a green tray state.
    status.sync = traySyncStateForReport(controller, report);
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
  const processTasksChanged = async (): Promise<void> => {
    const previous = taskAutomationSnapshot;
    const current = await tasks.listTasks({ includeDeleted: true });
    const automation = await taskAutomationService.applyTransition(previous, current);
    if (automation.failures.length > 0) {
      console.warn("Some local task automations could not be applied", automation.failures);
    }
    taskAutomationSnapshot = automation.applied > 0
      ? await tasks.listTasks({ includeDeleted: true })
      : current;

    windows?.broadcast(DESKTOP_CHANNELS.eventTasksChanged);
    tray?.refresh();
    refreshFloatingFocusMode();
    schedulePendingFeishuChanges();
    void tasks
      .listTasks({ statuses: ["completed"], includeDeleted: false })
      .then((items) => petService?.reconcileCompletedTasks(items))
      .catch((error: unknown) => {
        console.error(
          "Failed to reconcile Todo Pet task rewards",
          error instanceof Error ? error.message : error,
        );
      });
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
  const handleTasksChanged = (): void => {
    taskChangeQueue = taskChangeQueue
      .then(processTasksChanged)
      .catch((error: unknown) => {
        console.error(
          "Failed to process task change",
          error instanceof Error ? error.message : error,
        );
      });
  };
  let scheduledAutomationQueue: Promise<void> = Promise.resolve();
  const processScheduledAutomations = (): void => {
    scheduledAutomationQueue = scheduledAutomationQueue
      .then(async () => {
        const now = new Date();
        const current = await tasks.listTasks({ includeDeleted: true });
        const result = await taskAutomationService.applyScheduled(current, now);
        if (result.failures.length > 0) {
          console.warn(
            "Some scheduled local task automations could not be applied",
            result.failures,
          );
        }
        if (result.scheduledRuleIds.length === 0) return;
        const consumed = new Set(result.scheduledRuleIds);
        const checkpoint = now.toISOString();
        const settings = settingsService!.get();
        const next = await settingsService!.replace({
          ...settings,
          automations: settings.automations.map((rule) =>
            consumed.has(rule.id) && rule.schedule
              ? {
                  ...rule,
                  schedule: { ...rule.schedule, lastRunAt: checkpoint },
                  updatedAt: checkpoint,
                }
              : rule,
          ),
        });
        broadcastSettings(next);
        if (result.applied > 0) handleTasksChanged();
      })
      .catch((error: unknown) => {
        console.error(
          "Failed to process scheduled task automations",
          error instanceof Error ? error.message : error,
        );
      });
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
    getPetPersonality: () => petService?.snapshot().profile.personality,
    listMorningTasks: () => tasks.listTasks({ view: "today" }),
    getTaskForSyncReceipt: (id) => tasks.getTask(id, true),
    createToolRegistry: ({ sourcePolicy }) => {
      const executors = new BuiltinToolExecutors({
        allowedRoots: [agentWorkspace],
        adapters: toolAdapters,
      });
      const capabilities = settingsService!.get().agentCapabilities;
      const definitions = [
        ...createTaskTools({
          tasks,
          getModelDataScope: () => settingsService!.get().modelDataScope,
          getAgentCapabilities: () => settingsService!.get().agentCapabilities,
          sourcePolicy,
          getFeishuAccountId: () => {
            const connection = feishuController?.status();
            return connection?.connected ? connection.accountId : undefined;
          },
          onTasksChanged: handleTasksChanged,
        }),
        ...createBuiltinTools(executors),
      ].filter((definition) =>
        isAgentToolEnabled(definition.name, capabilities),
      );
      return new ToolRegistry(definitions, {
        isToolEnabled: (toolName) =>
          isAgentToolEnabled(toolName, settingsService!.get().agentCapabilities),
      });
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
      mousePassthrough: settingsService?.get().floating.mousePassthrough ?? false,
      meetingMode: settingsService?.get().pet.meetingMode ?? false,
      launchAtLogin: settingsService?.get().launchAtLogin ?? false,
    }),
    showMain: (route) => requestMainWindow(route),
    showQuick: showQuickCaptureWithSelection,
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
    toggleMousePassthrough: (enabled) => {
      if (!settingsService) return;
      const current = settingsService.get();
      void settingsService
        .replace({
          ...current,
          floating: { ...current.floating, mousePassthrough: enabled },
        })
        .then(broadcastSettings);
    },
    toggleBossMode: (enabled) => {
      if (!settingsService) return;
      void settingsService
        .replace(withBossMode(settingsService.get(), enabled))
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
    getTodaySummary: async () => {
      const todayTasks = await tasks.listTasks({
        view: "today",
        statuses: ["open"],
        includeDeleted: false,
      });
      return buildTrayTodaySummary(todayTasks, {
        privacyMode: settingsService?.get().floating.privacyMode === true,
      });
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
  const petDataController = new PetDataDesktopController({
    repository: {
      readPetSnapshot: async () => petService!.portableSnapshot(),
      replacePetSnapshot: async (state) => {
        await petService!.replacePortableSnapshot(state);
      },
    },
    files: new NodeDataDesktopFilePort(),
    dialogs: {
      chooseExportPath: async ({ defaultFileName }) => {
        const result = await dialog.showSaveDialog({
          title: "导出 Todo Pet 档案",
          defaultPath: path.join(app.getPath("documents"), defaultFileName),
          filters: [{ name: "Todo Pet 档案", extensions: ["json"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        return result.canceled ? undefined : result.filePath;
      },
      chooseImportPath: async () => {
        const result = await dialog.showOpenDialog({
          title: "导入 Todo Pet 档案",
          defaultPath: app.getPath("documents"),
          filters: [{ name: "Todo Pet 档案", extensions: ["json"] }],
          properties: ["openFile"],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
    },
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
          status.sync = traySyncStateForReport(feishuController!, report);
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
      status.sync = traySyncStateForReport(feishuController!, report);
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
    exportMarkdownToFile: (request) => dataController.exportMarkdownToFile(request),
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
        if (request.tasks) {
          draft.taskState.projects = {};
          draft.taskState.lists = {};
        }
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
      if (request.tasks) {
        feishuController?.stopPolling();
        await taskAttachmentService.clearAll();
      }
      broadcastSettings(settingsService!.get());
      handleTasksChanged();
      return { status: "cleared", ...counts };
    },
  };

  const petApi: PetDesktopApi = {
    snapshot: async () => petService!.snapshot(),
    rename: async (name) => {
      const snapshot = await petService!.rename(name);
      const current = settingsService!.get();
      const settings = await settingsService!.replace({
        ...current,
        persona: { ...current.persona, name: snapshot.profile.name },
      });
      broadcastSettings(settings);
      return snapshot;
    },
    customize: (patch) => petService!.customize(patch),
    addCompanion: (input) => petService!.addCompanion(input),
    updateCompanion: (id, patch) => petService!.updateCompanion(id, patch),
    deleteCompanion: (id) => petService!.deleteCompanion(id),
    interact: (kind) => petService!.recordInteraction(kind),
    dailyAdventure: (localDate) => petService!.dailyAdventure(localDate),
    completeAdventure: (adventureId, choiceId) =>
      petService!.completeAdventure(adventureId, choiceId),
    recordMiniGame: (input) => petService!.recordMiniGame(input),
    recordProactiveMessage: (input) =>
      settingsService!.get().pet.vacationMode
        ? Promise.resolve(petService!.snapshot())
        : petService!.recordProactiveMessage(input, {
            dailyLimit: settingsService!.get().pet.proactiveDailyLimit,
            localDate: localDateKey(),
          }),
    startFocus: async (request) => {
      const task = request.taskId
        ? await tasks.getTask(request.taskId, false)
        : undefined;
      if (request.taskId && !task) throw new Error("FOCUS_TASK_NOT_FOUND");
      const snapshot = await petService!.startFocus({
        ...request,
        taskTitle: task?.title ?? request.taskTitle,
      });
      if (task) {
        await tasks.startFocus(task.id);
        handleTasksChanged();
      }
      windows?.setFocusActive(true);
      return snapshot;
    },
    pauseFocus: async (reason) => {
      const before = petService!.snapshot().focus;
      const snapshot = await petService!.pauseFocus(reason);
      if (before?.taskId) {
        await tasks.pauseFocus(before.taskId);
        handleTasksChanged();
      }
      return snapshot;
    },
    resumeFocus: async () => {
      const before = petService!.snapshot().focus;
      const snapshot = await petService!.resumeFocus();
      if (before?.taskId) {
        await tasks.startFocus(before.taskId);
        handleTasksChanged();
      }
      windows?.setFocusActive(true);
      return snapshot;
    },
    advanceFocus: () => petService!.advanceFocus(),
    finishFocus: async (outcome) => {
      const before = petService!.snapshot().focus;
      const snapshot = await petService!.finishFocus(outcome);
      if (before?.taskId) {
        await tasks.pauseFocus(before.taskId).catch(() => undefined);
        handleTasksChanged();
      }
      windows?.setFocusActive(false);
      return snapshot;
    },
    weather: async () => weatherService!.get(),
    refreshWeather: async (force) => {
      const weather = await weatherService!.refresh(force);
      if (weather) {
        windows?.broadcast(DESKTOP_CHANNELS.eventPet, {
          type: "weather-updated",
          at: new Date().toISOString(),
          weather,
        });
        notifySevereWeather(weather);
      }
      return weather;
    },
    generateDiary: async (userNote) => {
      const localDate = localDateKey();
      const completedTasks = (
        await tasks.listTasks({
          statuses: ["completed"],
          includeDeleted: false,
        })
      ).filter((task) => task.completedAt?.slice(0, 10) === localDate);
      const weather = weatherService!.get();
      return petService!.generateDiary({
        localDate,
        completedTasks,
        weatherSummary: weather
          ? `${weather.city} ${weather.conditionLabel} ${Math.round(weather.temperatureC)}℃`
          : undefined,
        userNote,
      });
    },
    createDiaryFromTask: async (taskId, userNote) => {
      const task = await tasks.getTask(taskId, false);
      if (!task || task.deletedAt) throw new Error("TASK_NOT_FOUND");
      return petService!.createDiaryFromTask({
        localDate: localDateKey(),
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
        },
        userNote,
      });
    },
    createDiaryFromCapture: (input) => petService!.createDiaryFromCapture(input),
    updateDiary: (id, patch) => petService!.updateDiary(id, patch),
    deleteDiary: (id) => petService!.deleteDiary(id),
    addMemory: (input) => petService!.addMemory(input),
    updateMemory: (id, patch) => petService!.updateMemory(id, patch),
    deleteMemory: (id) => petService!.deleteMemory(id),
    addHabit: (input) => petService!.addHabit(input),
    updateHabit: (id, patch) => petService!.updateHabit(id, patch),
    completeHabit: (id) => petService!.completeHabit(id),
    snoozeHabit: (id, minutes) => petService!.snoozeHabit(id, minutes),
    deleteHabit: (id) => petService!.deleteHabit(id),
    addGoal: (input) => petService!.addGoal(input),
    updateGoal: (id, patch) => petService!.updateGoal(id, patch),
    deleteGoal: (id) => petService!.deleteGoal(id),
    exportData: () => petDataController.exportToFile(),
    previewDataImport: () => petDataController.previewImport(),
    commitDataImport: async (previewToken, strategy) => {
      const result = await petDataController.commitImport(previewToken, strategy);
      windows?.broadcast(DESKTOP_CHANNELS.eventPet, {
        type: "state-changed",
        at: new Date().toISOString(),
      });
      return result;
    },
    cancelDataImport: async (previewToken) => petDataController.cancelPreview(previewToken),
  };
  let weatherSettingsKey = JSON.stringify(settingsService.get().weather);

  unregisterIpc = registerDesktopIpc({
    tasks,
    taskAttachments: {
      choose: async (): Promise<TaskAttachment[]> => {
        const result = await dialog.showOpenDialog({
          title: "添加本地附件",
          defaultPath: app.getPath("documents"),
          properties: ["openFile", "multiSelections"],
        });
        if (result.canceled || result.filePaths.length === 0) return [];
        return taskAttachmentService.copySelectedFiles(result.filePaths);
      },
      open: async (attachment) => {
        const filePath = await taskAttachmentService.open(attachment);
        const error = await shell.openPath(filePath);
        if (error) throw new Error(error);
      },
      preview: (attachment) => taskAttachmentService.preview(attachment),
      remove: (attachment) => taskAttachmentService.remove(attachment),
    },
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
    pet: petApi,
    data: dataApi,
    devServerUrl,
    rendererPath,
    getInfo: () => ({
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      // `safeStorage.isEncryptionAvailable()` can synchronously wait for an
      // interactive Keychain response in an unsigned packaged macOS app. An
      // IPC health check must never hold the main process open on that prompt.
      // Todo Agent targets macOS and Windows, where Electron provides the
      // native credential backend once the app is ready; actual credential
      // reads/writes still go through the adapter above and surface a concrete
      // error if the OS backend cannot be used.
      secureStorageAvailable:
        process.platform === "darwin" || process.platform === "win32",
    }),
    readClipboard: () => buildClipboardContextPreview(clipboard.readText()),
    readActiveWindow: () => readActiveWindowContext(),
    readSelectedText: async () => {
      const pending = pendingSelectedText;
      pendingSelectedText = undefined;
      return pending ?? captureSelectedTextFromActiveApp();
    },
    showMain: (route) => requestMainWindow(route),
    showQuickCapture: showQuickCaptureWithSelection,
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
    setFloatingPetOnly: (petOnly) => windows?.setFloatingPetOnly(petOnly),
    beginFloatingDrag: (screenX, screenY) =>
      windows?.beginFloatingDrag(screenX, screenY) ?? false,
    updateFloatingDrag: (screenX, screenY) =>
      windows?.updateFloatingDrag(screenX, screenY) ?? false,
    endFloatingDrag: () => windows?.endFloatingDrag(),
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
      if (petService?.snapshot().profile.name !== settings.persona.name) {
        void petService?.rename(settings.persona.name).catch(() => undefined);
      }
      const nextWeatherSettingsKey = JSON.stringify(settings.weather);
      if (nextWeatherSettingsKey !== weatherSettingsKey) {
        weatherSettingsKey = nextWeatherSettingsKey;
        void weatherService?.refresh(true).catch(() => undefined);
      }
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
  // Never block first paint on Keychain access or Feishu networking. This is
  // especially important after a local development build is re-signed: the
  // OS may need to re-authorize secure storage, while the task UI and pet
  // should remain available immediately.
  setTimeout(restoreInitialFeishuConfiguration, 500);
  const ensureFloatingVisible = (): void => windows?.ensureFloatingVisible();
  screen.on("display-added", ensureFloatingVisible);
  screen.on("display-removed", ensureFloatingVisible);
  screen.on("display-metrics-changed", ensureFloatingVisible);
  registerQuickCaptureShortcut(settingsService.get());
  processScheduledAutomations();
  taskAutomationTimer = setInterval(processScheduledAutomations, 30_000);
  await notificationRuntime.start();
  petTickTimer = setInterval(() => {
    void petService?.tick().catch((error: unknown) => {
      console.error(
        "Failed to advance Todo Pet focus timer",
        error instanceof Error ? error.message : error,
      );
    });
  }, 1_000);
  const pollPetInputActivity = (): void => {
    const settings = settingsService?.get();
    if (
      !settings?.pet.inputReactionsEnabled ||
      settings.pet.vacationMode ||
      !settings.floating.enabled ||
      settings.floating.privacyMode ||
      settings.pet.meetingMode
    ) {
      lastPetInputActivityAt = 0;
      return;
    }
    let idleSeconds: number;
    try {
      idleSeconds = powerMonitor.getSystemIdleTime();
    } catch {
      return;
    }
    const kind = petInputActivityKind(idleSeconds);
    const now = Date.now();
    if (!kind || !shouldEmitPetInputActivity(now, lastPetInputActivityAt, kind)) return;
    lastPetInputActivityAt = now;
    windows?.broadcast(DESKTOP_CHANNELS.eventPetInputActivity, {
      kind,
      at: new Date(now).toISOString(),
      idleSeconds,
    });
  };
  petInputActivityTimer = setInterval(
    pollPetInputActivity,
    PET_INPUT_ACTIVITY_POLL_MS,
  );
  weatherRefreshTimer = setInterval(() => {
    void weatherService?.refresh(false).then((weather) => {
      if (!weather) return;
      windows?.broadcast(DESKTOP_CHANNELS.eventPet, {
        type: "weather-updated",
        at: new Date().toISOString(),
        weather,
      });
      notifySevereWeather(weather);
    }).catch(() => undefined);
  }, 30 * 60_000);
  void tasks
    .listTasks({ statuses: ["completed"], includeDeleted: false })
    .then(async (items) => {
      await petService?.reconcileCompletedTasks(items);
      if (
        !settingsService?.get().pet.autoDiary ||
        settingsService.get().pet.vacationMode
      ) return;
      const localDate = localDateKey();
      const weather = weatherService?.get();
      await petService?.generateDiary({
        localDate,
        completedTasks: items.filter(
          (task) => task.completedAt?.slice(0, 10) === localDate,
        ),
        weatherSummary: weather
          ? `${weather.city} ${weather.conditionLabel} ${Math.round(weather.temperatureC)}℃`
          : undefined,
      });
    })
    .catch(() => undefined);
  void weatherService
    ?.refresh(false)
    .then(notifySevereWeather)
    .catch(() => undefined);
  const revokeFullAccessForSystemState = (): void => {
    agentService?.revokeFullAccess();
  };
  powerMonitor.on("lock-screen", revokeFullAccessForSystemState);
  powerMonitor.on("suspend", revokeFullAccessForSystemState);
  powerMonitor.on("resume", () => {
    windows?.ensureFloatingVisible();
    void petService?.tick().catch(() => undefined);
    void weatherService
      ?.refresh(false)
      .then(notifySevereWeather)
      .catch(() => undefined);
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
  if (petTickTimer) clearInterval(petTickTimer);
  if (taskAutomationTimer) clearInterval(taskAutomationTimer);
  if (petInputActivityTimer) clearInterval(petInputActivityTimer);
  if (weatherRefreshTimer) clearInterval(weatherRefreshTimer);
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
