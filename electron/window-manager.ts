import { BrowserWindow, screen, shell, type Rectangle } from "electron";
import path from "node:path";
import type { AppSettings } from "../src/shared/settings";

export type WindowKind = "main" | "quick" | "floating";

interface WindowManagerOptions {
  preloadPath: string;
  rendererPath: string;
  devServerUrl?: string;
  settings: () => AppSettings;
  onFloatingPosition: (
    displayId: string,
    position: { x: number; y: number },
  ) => void;
  onMainCloseRequested: () => boolean;
}

// HTTP links are intentionally allowed alongside HTTPS because task context
// and attachment references accept both schemes. The URL is still parsed and
// restricted to these protocols before leaving the app; file/javascript/data
// URLs never reach the system browser.
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const e2eBackgroundWindows =
  process.env.TODO_AGENT_E2E_BACKGROUND === "1";

export const floatingWindowSize = (
  expanded: boolean,
  scalePercent = 100,
  petOnly = false,
): { width: number; height: number } => {
  if (petOnly) {
    const scale = Math.max(0.75, Math.min(1.25, scalePercent / 100));
    return {
      width: Math.max(112, Math.round(148 * scale)),
      height: Math.max(112, Math.round(148 * scale)),
    };
  }
  if (expanded) return { width: 480, height: 640 };
  const scale = Math.max(0.75, Math.min(1.25, scalePercent / 100));
  return {
    width: Math.round(438 * scale),
    // Keep enough vertical room for the independent task and focus speech
    // bubbles at the smallest pet scale. Empty pixels remain transparent.
    height: Math.max(184, Math.round(184 * scale)),
  };
};

function clampWindowToWorkArea(
  bounds: Rectangle,
  workArea: Rectangle,
): Rectangle {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    width,
    height,
    x: Math.max(
      workArea.x,
      Math.min(bounds.x, workArea.x + workArea.width - width),
    ),
    y: Math.max(
      workArea.y,
      Math.min(bounds.y, workArea.y + workArea.height - height),
    ),
  };
}

export function snapToWorkArea(
  bounds: Rectangle,
  workArea: Rectangle,
  threshold = 18,
): Rectangle {
  const next = clampWindowToWorkArea(bounds, workArea);
  const left = workArea.x;
  const right = workArea.x + workArea.width - next.width;
  const top = workArea.y;
  const bottom = workArea.y + workArea.height - next.height;
  if (Math.abs(next.x - left) <= threshold) next.x = left;
  if (Math.abs(next.x - right) <= threshold) next.x = right;
  if (Math.abs(next.y - top) <= threshold) next.y = top;
  if (Math.abs(next.y - bottom) <= threshold) next.y = bottom;
  return next;
}

/**
 * The floating surface is intentionally shown without taking keyboard focus.
 * On macOS, an inactive frameless window normally consumes the first pointer
 * press just to activate itself, which made Todo Pet's expand control feel
 * like it needed two clicks. `acceptFirstMouse` forwards that first press to
 * the renderer while keeping the regular `showInactive()` lifecycle intact.
 * Electron only supports this option on macOS, so omit it elsewhere.
 */
export function floatingWindowInteractionOptions(
  platform = process.platform,
): Pick<Electron.BrowserWindowConstructorOptions, "acceptFirstMouse"> {
  return platform === "darwin" ? { acceptFirstMouse: true } : {};
}

export function floatingMousePassthroughOptions(enabled: boolean): {
  ignore: boolean;
  forward: boolean;
} {
  return { ignore: enabled, forward: true };
}

export class WindowManager {
  readonly #options: WindowManagerOptions;
  #main?: BrowserWindow;
  #quick?: BrowserWindow;
  #floating?: BrowserWindow;
  #floatingExpanded = false;
  #floatingPetOnly = false;
  #floatingPositionSaveTimer?: ReturnType<typeof setTimeout>;
  #floatingPointerDrag?: {
    screenX: number;
    screenY: number;
    bounds: Rectangle;
    lastScreenX: number;
    lastScreenY: number;
    startedAt: number;
    lastMovementAt: number;
    hasMoved: boolean;
  };
  #floatingPointerDragTimer?: ReturnType<typeof setInterval>;

  constructor(options: WindowManagerOptions) {
    this.#options = options;
  }

  get main(): BrowserWindow | undefined {
    return this.#main;
  }
  get quick(): BrowserWindow | undefined {
    return this.#quick;
  }
  get floating(): BrowserWindow | undefined {
    return this.#floating;
  }

  createMain(): BrowserWindow {
    if (this.#main && !this.#main.isDestroyed()) return this.#main;
    const isMac = process.platform === "darwin";
    this.#main = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 760,
      minHeight: 600,
      show: false,
      opacity: e2eBackgroundWindows ? 0 : 1,
      title: "Todo Agent",
      backgroundColor: "#00000000",
      vibrancy: isMac ? "under-window" : undefined,
      visualEffectState: isMac ? "active" : undefined,
      backgroundMaterial: process.platform === "win32" ? "mica" : undefined,
      titleBarStyle: isMac ? "hiddenInset" : "hidden",
      titleBarOverlay: isMac
        ? false
        : { color: "#00000000", symbolColor: "#707482", height: 52 },
      webPreferences: this.#webPreferences(),
    });
    this.#secureWebContents(this.#main);
    this.#load(this.#main, "main");
    this.#main.once("ready-to-show", () => {
      if (e2eBackgroundWindows) this.#main?.showInactive();
      else this.#main?.show();
    });
    this.#main.on("close", (event) => {
      if (!this.#options.onMainCloseRequested()) {
        event.preventDefault();
        this.#main?.hide();
      }
    });
    this.#main.on("closed", () => {
      this.#main = undefined;
    });
    this.#main.on("enter-full-screen", () => {
      if (this.#options.settings().floating.hideInFullscreen)
        this.#floating?.hide();
    });
    this.#main.on("leave-full-screen", () => {
      if (this.#options.settings().floating.enabled)
        this.#floating?.showInactive();
    });
    return this.#main;
  }

  showMain(route?: string): void {
    const window = this.createMain();
    if (route) this.#sendWhenReady(window, "navigation:route", route);
    if (window.isMinimized()) window.restore();
    if (e2eBackgroundWindows) window.showInactive();
    else {
      window.show();
      window.focus();
    }
  }

  createQuick(): BrowserWindow {
    if (this.#quick && !this.#quick.isDestroyed()) return this.#quick;
    this.#quick = new BrowserWindow({
      width: 680,
      height: 360,
      minWidth: 360,
      minHeight: 220,
      show: false,
      opacity: e2eBackgroundWindows ? 0 : 1,
      frame: false,
      transparent: true,
      resizable: true,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      webPreferences: this.#webPreferences(),
    });
    this.#secureWebContents(this.#quick);
    this.#load(this.#quick, "quick");
    this.#quick.on("blur", () => {
      if (!this.#quick?.webContents.isDevToolsOpened()) this.#quick?.hide();
    });
    this.#quick.on("closed", () => {
      this.#quick = undefined;
    });
    return this.#quick;
  }

  showQuick(): void {
    const window = this.createQuick();
    const cursorDisplay = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const bounds = window.getBounds();
    window.setBounds({
      ...bounds,
      x: Math.round(
        cursorDisplay.workArea.x +
          (cursorDisplay.workArea.width - bounds.width) / 2,
      ),
      y: Math.round(
        cursorDisplay.workArea.y + cursorDisplay.workArea.height * 0.18,
      ),
    });
    if (e2eBackgroundWindows) window.showInactive();
    else {
      window.show();
      window.focus();
    }
    this.#sendWhenReady(window, "quick-capture:focus");
  }

  hideQuick(): void {
    this.#quick?.hide();
  }

  createFloating(): BrowserWindow {
    if (this.#floating && !this.#floating.isDestroyed()) return this.#floating;
    const settings = this.#options.settings().floating;
    const size = floatingWindowSize(
      this.#floatingExpanded,
      settings.scalePercent,
      this.#floatingPetOnly,
    );
    const display =
      (settings.lastDisplayId
        ? screen
            .getAllDisplays()
            .find((candidate) => String(candidate.id) === settings.lastDisplayId)
        : undefined) ?? screen.getPrimaryDisplay();
    const remembered = settings.positions[String(display.id)];
    const initial = clampWindowToWorkArea(
      {
        ...size,
        x:
          remembered?.x ??
          display.workArea.x + display.workArea.width - size.width - 24,
        y: remembered?.y ?? display.workArea.y + 72,
      },
      display.workArea,
    );
    this.#floating = new BrowserWindow({
      ...initial,
      show: false,
      opacity: e2eBackgroundWindows ? 0 : 1,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: !settings.locked,
      focusable: this.#floatingExpanded && !settings.mousePassthrough,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      ...floatingWindowInteractionOptions(),
      webPreferences: this.#webPreferences(),
    });
    this.#applyFloatingMousePassthrough(this.#floating, settings.mousePassthrough);
    this.#keepFloatingOnTop(this.#floating);
    this.#floating.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: !settings.hideInFullscreen,
    });
    this.#secureWebContents(this.#floating);
    this.#load(this.#floating, "floating");
    this.#floating.on("will-move", (event) => {
      if (this.#options.settings().floating.locked) {
        event.preventDefault();
        return;
      }
      this.#scheduleFloatingPositionSave();
    });
    this.#floating.on("move", () => {
      if (this.#options.settings().floating.locked || !this.#floating) return;
      const bounds = this.#floating.getBounds();
      const displayForWindow = screen.getDisplayMatching(bounds);
      const snapped = snapToWorkArea(bounds, displayForWindow.workArea);
      if (snapped.x !== bounds.x || snapped.y !== bounds.y)
        this.#floating.setBounds(snapped, false);
      // `will-move` fires only once at the start of a native drag. Debounce
      // every actual move too, so we persist the final drop point rather than
      // an early point from a long drag.
      this.#scheduleFloatingPositionSave();
    });
    this.#floating.on("close", () => this.#flushFloatingPositionSave());
    this.#floating.on("closed", () => {
      if (this.#floatingPositionSaveTimer) {
        clearTimeout(this.#floatingPositionSaveTimer);
        this.#floatingPositionSaveTimer = undefined;
      }
      if (this.#floatingPointerDragTimer) {
        clearInterval(this.#floatingPointerDragTimer);
        this.#floatingPointerDragTimer = undefined;
      }
      this.#floatingPointerDrag = undefined;
      this.#floating = undefined;
    });
    if (settings.enabled)
      this.#floating.once("ready-to-show", () =>
        this.#floating?.showInactive(),
      );
    return this.#floating;
  }

  syncFloatingSettings(): void {
    const settings = this.#options.settings().floating;
    if (!settings.enabled) {
      this.#floating?.hide();
      return;
    }
    const window = this.createFloating();
    this.#keepFloatingOnTop(window);
    this.#applyFloatingMousePassthrough(window, settings.mousePassthrough);
    window.setMovable(!settings.locked);
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: !settings.hideInFullscreen,
    });
    window.webContents.send("floating:settings", settings);
    this.setFloatingExpanded(this.#floatingExpanded);
    window.showInactive();
  }

  setFloatingExpanded(expanded: boolean): void {
    this.#floatingExpanded = expanded;
    if (expanded) this.#floatingPetOnly = false;
    const window = this.createFloating();
    const settings = this.#options.settings().floating;
    const current = window.getBounds();
    // A compact desktop pet must not keep keyboard focus away from the main
    // application. The expanded panel becomes focusable again for chat,
    // approvals and task input.
    window.setFocusable(expanded && !this.#floatingPetOnly && !settings.mousePassthrough);
    const display = screen.getDisplayMatching(current);
    const size = floatingWindowSize(
      expanded,
      settings.scalePercent,
      this.#floatingPetOnly,
    );
    const anchoredRight =
      current.x + current.width >
      display.workArea.x + display.workArea.width / 2;
    const next = clampWindowToWorkArea(
      {
        ...size,
        x: anchoredRight ? current.x + current.width - size.width : current.x,
        y: current.y,
      },
      display.workArea,
    );
    window.setBounds(next, true);
    this.#keepFloatingOnTop(window);
  }

  setFloatingPetOnly(petOnly: boolean): void {
    this.#floatingPetOnly = petOnly;
    if (petOnly) this.#floatingExpanded = false;
    const window = this.createFloating();
    const settings = this.#options.settings().floating;
    const current = window.getBounds();
    window.setFocusable(false);
    const display = screen.getDisplayMatching(current);
    const size = floatingWindowSize(
      this.#floatingExpanded,
      settings.scalePercent,
      petOnly,
    );
    // The task rail grows to the pet's right, so preserve the pet's own
    // screen position while the rail is hidden or restored. Clamp only when
    // the restored rail would otherwise leave the active display.
    const next = clampWindowToWorkArea(
      { ...size, x: current.x, y: current.y },
      display.workArea,
    );
    window.setBounds(next, true);
    this.#keepFloatingOnTop(window);
  }

  #applyFloatingMousePassthrough(window: BrowserWindow, enabled: boolean): void {
    // `forward` keeps hover telemetry flowing to the renderer while clicks
    // pass to the window underneath. The mode is opt-in and can be disabled
    // from Settings or the system tray, so the pet never becomes unrecoverable.
    const options = floatingMousePassthroughOptions(enabled);
    window.setIgnoreMouseEvents(options.ignore, { forward: options.forward });
  }

  /**
   * Renderer-driven dragging powers the visible six-dot handle. Native
   * `app-region: drag` cannot reliably be interactive at the same time, so a
   * handle that listened for pointer feedback could appear draggable without
   * moving the BrowserWindow on macOS.
   */
  beginFloatingDrag(screenX: number, screenY: number): boolean {
    if (this.#options.settings().floating.locked) return false;
    const window = this.createFloating();
    this.endFloatingDrag();
    const pointer =
      process.env.TODO_AGENT_E2E === "1"
        ? { x: screenX, y: screenY }
        : screen.getCursorScreenPoint();
    const now = Date.now();
    this.#floatingPointerDrag = {
      screenX: pointer.x,
      screenY: pointer.y,
      bounds: window.getBounds(),
      lastScreenX: pointer.x,
      lastScreenY: pointer.y,
      startedAt: now,
      lastMovementAt: now,
      hasMoved: false,
    };
    // Real transparent macOS windows can lose renderer pointer capture as
    // soon as the BrowserWindow begins moving. Poll the OS cursor in
    // production so dragging keeps working even after that handoff. E2E uses
    // explicit renderer coordinates to remain deterministic.
    if (process.env.TODO_AGENT_E2E !== "1") {
      this.#floatingPointerDragTimer = setInterval(() => {
        const drag = this.#floatingPointerDrag;
        if (!drag) return;
        const cursor = screen.getCursorScreenPoint();
        if (
          cursor.x !== drag.lastScreenX ||
          cursor.y !== drag.lastScreenY
        ) {
          this.updateFloatingDrag(cursor.x, cursor.y);
          return;
        }
        const idleFor = Date.now() - drag.lastMovementAt;
        const totalFor = Date.now() - drag.startedAt;
        if ((drag.hasMoved && idleFor > 1_200) || totalFor > 8_000) {
          this.endFloatingDrag();
        }
      }, 16);
    }
    return true;
  }

  updateFloatingDrag(screenX: number, screenY: number): boolean {
    const drag = this.#floatingPointerDrag;
    const window = this.#floating;
    if (
      !drag ||
      !window ||
      window.isDestroyed() ||
      this.#options.settings().floating.locked
    ) {
      this.#floatingPointerDrag = undefined;
      return false;
    }
    const candidate = {
      ...drag.bounds,
      x: Math.round(drag.bounds.x + screenX - drag.screenX),
      y: Math.round(drag.bounds.y + screenY - drag.screenY),
    };
    const display = screen.getDisplayNearestPoint({
      x: Math.round(screenX),
      y: Math.round(screenY),
    });
    const next = clampWindowToWorkArea(candidate, display.workArea);
    if (screenX !== drag.lastScreenX || screenY !== drag.lastScreenY) {
      drag.lastScreenX = screenX;
      drag.lastScreenY = screenY;
      drag.lastMovementAt = Date.now();
      drag.hasMoved = true;
    }
    window.setPosition(next.x, next.y, false);
    return true;
  }

  endFloatingDrag(): void {
    if (this.#floatingPointerDragTimer) {
      clearInterval(this.#floatingPointerDragTimer);
      this.#floatingPointerDragTimer = undefined;
    }
    if (!this.#floatingPointerDrag) return;
    this.#floatingPointerDrag = undefined;
    this.#scheduleFloatingPositionSave();
  }

  setFocusActive(_active: boolean): void {
    if (this.#floating) this.#keepFloatingOnTop(this.#floating);
  }

  ensureFloatingVisible(): void {
    if (!this.#floating || this.#floating.isDestroyed()) return;
    this.#keepFloatingOnTop(this.#floating);
    const current = this.#floating.getBounds();
    const display = screen.getDisplayMatching(current);
    const next = clampWindowToWorkArea(current, display.workArea);
    if (
      next.x !== current.x ||
      next.y !== current.y ||
      next.width !== current.width ||
      next.height !== current.height
    ) {
      this.#floating.setBounds(next, false);
    }
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const window of [this.#main, this.#quick, this.#floating]) {
      if (window && !window.isDestroyed())
        window.webContents.send(channel, payload);
    }
  }

  #webPreferences(): Electron.WebPreferences {
    return {
      preload: this.#options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    };
  }

  #keepFloatingOnTop(window: BrowserWindow): void {
    window.setAlwaysOnTop(true, "floating");
  }

  #secureWebContents(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol))
          void shell.openExternal(parsed.toString());
      } catch {
        // Invalid URLs are ignored.
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      const allowed = this.#options.devServerUrl
        ? url.startsWith(this.#options.devServerUrl)
        : url.startsWith("file:");
      if (!allowed) event.preventDefault();
    });
  }

  #load(window: BrowserWindow, kind: WindowKind): void {
    if (this.#options.devServerUrl) {
      const url = new URL(this.#options.devServerUrl);
      url.searchParams.set("window", kind);
      void window.loadURL(url.toString());
      return;
    }
    void window.loadFile(this.#options.rendererPath, {
      query: { window: kind },
    });
  }

  #sendWhenReady(
    window: BrowserWindow,
    channel: string,
    payload?: unknown,
  ): void {
    if (window.webContents.isLoadingMainFrame()) {
      window.webContents.once("did-finish-load", () =>
        window.webContents.send(channel, payload),
      );
      return;
    }
    window.webContents.send(channel, payload);
  }

  #saveFloatingPosition(): void {
    if (!this.#floating || this.#floating.isDestroyed()) return;
    const bounds = this.#floating.getBounds();
    const display = screen.getDisplayMatching(bounds);
    this.#options.onFloatingPosition(String(display.id), {
      x: bounds.x,
      y: bounds.y,
    });
  }

  #scheduleFloatingPositionSave(): void {
    if (this.#floatingPositionSaveTimer)
      clearTimeout(this.#floatingPositionSaveTimer);
    this.#floatingPositionSaveTimer = setTimeout(() => {
      this.#floatingPositionSaveTimer = undefined;
      this.#saveFloatingPosition();
    }, 200);
  }

  #flushFloatingPositionSave(): void {
    if (!this.#floatingPositionSaveTimer) return;
    clearTimeout(this.#floatingPositionSaveTimer);
    this.#floatingPositionSaveTimer = undefined;
    this.#saveFloatingPosition();
  }
}
