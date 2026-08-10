import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_CHANNELS, type DesktopApi } from "../src/shared/desktop-api";
import type { AppSettings } from "../src/shared/settings";
import type { AgentRunEvent } from "../src/shared/agent-types";
import type { AgentApprovalView } from "../src/shared/desktop-api";
import type { FeishuStatusView } from "../src/shared/desktop-api";
import type { InAppNotificationView } from "../src/shared/desktop-api";

function subscribe<Payload>(
  channel: string,
  listener: (payload: Payload) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: Payload): void =>
    listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/**
 * A route can be requested while the main renderer is still booting. Electron
 * has loaded this preload script by `did-finish-load`, but React installs its
 * `onNavigation` effect a moment later. Keeping the latest request here avoids
 * dropping a user action from the floating panel (or quick capture) during
 * that small interval. Routes are commands rather than an event log, so the
 * newest request is the only one that should survive startup.
 */
const navigationListeners = new Set<(route: string) => void>();
let pendingNavigationRoute: string | undefined;

ipcRenderer.on(
  DESKTOP_CHANNELS.eventNavigation,
  (_event: Electron.IpcRendererEvent, route: string) => {
    if (navigationListeners.size === 0) {
      pendingNavigationRoute = route;
      return;
    }
    for (const listener of navigationListeners) listener(route);
  },
);

function subscribeNavigation(listener: (route: string) => void): () => void {
  navigationListeners.add(listener);
  if (pendingNavigationRoute !== undefined) {
    const route = pendingNavigationRoute;
    pendingNavigationRoute = undefined;
    listener(route);
  }
  return () => navigationListeners.delete(listener);
}

const desktopApi: DesktopApi = {
  tasks: {
    create: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskCreate, input),
    get: (id, includeDeleted) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.taskGet, { id, includeDeleted }),
    list: (filter) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskList, filter),
    sections: (filter) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.taskSections, filter),
    update: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.taskUpdate, request),
    complete: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.taskComplete, request),
    reopen: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskReopen, id),
    moveToToday: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.taskMoveToToday, request),
    startFocus: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskStartFocus, id),
    pauseFocus: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskPauseFocus, id),
    resetFocus: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskResetFocus, id),
    reorderToday: (taskIds) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.taskReorderToday, taskIds),
    moveToTrash: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskTrash, id),
    restore: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskRestore, id),
    purge: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.taskPurge, id),
    undo: (operationId) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.taskUndo, operationId),
    saveDraft: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.draftSave, input),
    getDraft: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.draftGet, id),
    listDrafts: () => ipcRenderer.invoke(DESKTOP_CHANNELS.draftList),
    deleteDraft: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.draftDelete, id),
  },
  settings: {
    get: () => ipcRenderer.invoke(DESKTOP_CHANNELS.settingsGet),
    replace: (settings) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.settingsReplace, settings),
    listCredentials: () => ipcRenderer.invoke(DESKTOP_CHANNELS.credentialList),
    setCredential: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.credentialSet, request),
    deleteCredential: (id) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.credentialDelete, id),
  },
  shell: {
    getInfo: () => ipcRenderer.invoke(DESKTOP_CHANNELS.shellGetInfo),
    showMain: (route) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.shellShowMain, route),
    showQuickCapture: () => ipcRenderer.invoke(DESKTOP_CHANNELS.shellShowQuick),
    hideCurrentWindow: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.shellHideCurrent),
    setFloatingVisible: (visible) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.shellSetFloatingVisible, visible),
    setFloatingExpanded: (expanded) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.shellSetFloatingExpanded, expanded),
    setLaunchAtLogin: (enabled) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.shellSetLaunchAtLogin, enabled),
    openExternal: (url) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.shellOpenExternal, url),
  },
  capture: {
    parse: (text) => ipcRenderer.invoke(DESKTOP_CHANNELS.captureParse, text),
  },
  agent: {
    status: () => ipcRenderer.invoke(DESKTOP_CHANNELS.agentStatus),
    modelUsage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.agentModelUsage),
    testModelConnection: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.agentModelConnectionTest),
    send: (request) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentSend, request),
    morningBrief: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.agentMorningBrief, request),
    respondToApproval: (response) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.agentApprovalRespond, response),
    stop: (runId) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentStop, runId),
    audit: (limit) => ipcRenderer.invoke(DESKTOP_CHANNELS.agentAudit, limit),
    createFullAccessLease: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.agentFullAccessCreate, request),
    revokeFullAccess: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.agentFullAccessRevoke),
  },
  feishu: {
    status: () => ipcRenderer.invoke(DESKTOP_CHANNELS.feishuStatus),
    configure: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.feishuConfigure, request),
    beginPersonalConnect: () =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.feishuBeginPersonalConnect),
    beginOAuth: () => ipcRenderer.invoke(DESKTOP_CHANNELS.feishuBeginOAuth),
    cancelOAuth: () => ipcRenderer.invoke(DESKTOP_CHANNELS.feishuCancelOAuth),
    disconnect: () => ipcRenderer.invoke(DESKTOP_CHANNELS.feishuDisconnect),
    syncNow: (forceFull) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.feishuSyncNow, forceFull),
    listConflicts: () => ipcRenderer.invoke(DESKTOP_CHANNELS.feishuConflicts),
    resolveConflict: (localId, decision) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.feishuResolveConflict, {
        localId,
        decision,
      }),
  },
  notifications: {
    handleAction: (event) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.notificationAction, event),
    snoozeUntil: (reminderId, snoozeUntil) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.notificationSnoozeUntil, {
        reminderId,
        snoozeUntil,
      }),
    refresh: () => ipcRenderer.invoke(DESKTOP_CHANNELS.notificationRefresh),
  },
  data: {
    exportToFile: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.dataExport, request),
    previewImport: () => ipcRenderer.invoke(DESKTOP_CHANNELS.dataPreviewImport),
    commitImport: (previewToken, strategy) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.dataCommitImport, {
        previewToken,
        strategy,
      }),
    cancelPreview: (previewToken) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.dataCancelPreview, previewToken),
    clearLocalData: (request) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.dataClearLocal, request),
  },
  events: {
    onTasksChanged: (listener) =>
      subscribe<void>(DESKTOP_CHANNELS.eventTasksChanged, listener),
    onSettingsChanged: (listener) =>
      subscribe<AppSettings>(DESKTOP_CHANNELS.eventSettingsChanged, listener),
    onNavigation: (listener) => subscribeNavigation(listener),
    onQuickCaptureFocus: (listener) =>
      subscribe<void>(DESKTOP_CHANNELS.eventQuickCaptureFocus, listener),
    onShortcutError: (listener) =>
      subscribe<string>(DESKTOP_CHANNELS.eventShortcutError, listener),
    onAgentEvent: (listener) =>
      subscribe<AgentRunEvent>(DESKTOP_CHANNELS.eventAgentRun, listener),
    onAgentApproval: (listener) =>
      subscribe<AgentApprovalView>(
        DESKTOP_CHANNELS.eventAgentApproval,
        listener,
      ),
    onFeishuStatus: (listener) =>
      subscribe<FeishuStatusView>(DESKTOP_CHANNELS.eventFeishuStatus, listener),
    onNotification: (listener) =>
      subscribe<InAppNotificationView>(
        DESKTOP_CHANNELS.eventNotification,
        listener,
      ),
  },
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
