// Screen selection workflow adapted from DesktopBuddy, MIT (DCDingCong).
// No content leaves this process until a one-use, owner-bound preview token
// is submitted by its chat window. Context turns have no write tools.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, desktopCapturer, dialog, ipcMain, screen } from 'electron';
import { z } from 'zod';
import { AGENT_CONTEXT_CHANNELS, type AgentContextMaterial, type AgentContextPreview, type ScreenRegion } from '../../src/shared/agent-context';
import { rendererUrlIsTrusted } from '../trusted-renderer';
import type { AgentCapabilitySettings } from '../../src/shared/settings';

const regionSchema = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0), width: z.number().finite().min(24), height: z.number().finite().min(24) }).strict();
const textExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log', '.yaml', '.yml', '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.c', '.cpp', '.h', '.html', '.css', '.xml', '.toml']);
export function cropScreenRegion(rect: ScreenRegion, displaySize: { width: number; height: number }, imageSize: { width: number; height: number }): ScreenRegion {
  regionSchema.parse(rect);
  if (![displaySize.width, displaySize.height, imageSize.width, imageSize.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('屏幕尺寸无效');
  if (rect.x + rect.width > displaySize.width + 1 || rect.y + rect.height > displaySize.height + 1) throw new Error('选区超出当前屏幕');
  const x = Math.floor(rect.x / displaySize.width * imageSize.width);
  const y = Math.floor(rect.y / displaySize.height * imageSize.height);
  return { x, y, width: Math.min(imageSize.width - x, Math.ceil(rect.width / displaySize.width * imageSize.width)), height: Math.min(imageSize.height - y, Math.ceil(rect.height / displaySize.height * imageSize.height)) };
}

export class AgentContextService {
  #contexts = new Map<string, { owner: number; expires: number; material: AgentContextMaterial }>();
  #selection?: { window: BrowserWindow; resolve: (region: ScreenRegion | null) => void };
  constructor(readonly options: { rendererPath: string; preloadPath: string; devServerUrl?: string; capabilities: () => AgentCapabilitySettings }) {}
  #assertAllowed(kind: 'file' | 'image'): void {
    if (!(kind === 'file' ? this.options.capabilities().filesAndTerminal : this.options.capabilities().clipboardAndScreen)) throw new Error(kind === 'file' ? '文件能力已关闭，请先在 Agent 设置中开启' : '屏幕能力已关闭，请先在 Agent 设置中开启');
  }
  #remember(owner: number, material: AgentContextMaterial): AgentContextPreview {
    const now = Date.now();
    for (const [token, item] of this.#contexts) if (item.expires < now) this.#contexts.delete(token);
    if (this.#contexts.size >= 12) this.#contexts.delete(this.#contexts.keys().next().value!);
    const token = randomUUID(), expires = now + 10 * 60_000;
    this.#contexts.set(token, { owner, expires, material });
    return { token, kind: material.kind, title: material.title, preview: material.kind === 'file' ? material.text.slice(0, 2400) : '仅所选区域，不包含屏幕其他位置', characters: material.kind === 'file' ? material.text.length : undefined, imageDataUrl: material.kind === 'image' ? material.imageDataUrl : undefined, expiresAt: new Date(expires).toISOString() };
  }
  consume(tokens: string[], owner: number): AgentContextMaterial[] {
    if (tokens.length > 3 || new Set(tokens).size !== tokens.length) throw new Error('一次最多发送 3 份不同资料');
    const selected = tokens.map(token => {
      const item = this.#contexts.get(token);
      if (!item || item.owner !== owner || item.expires < Date.now()) throw new Error('资料预览已过期或不属于此窗口，请重新选择');
      this.#assertAllowed(item.material.kind);
      return item.material;
    });
    tokens.forEach(token => this.#contexts.delete(token));
    return selected;
  }
  discard(token: string, owner: number): void { if (this.#contexts.get(token)?.owner === owner) this.#contexts.delete(token); }
  async readSelectedFile(file: string, owner: number): Promise<AgentContextPreview> {
    this.#assertAllowed('file');
    if (!textExtensions.has(path.extname(file).toLowerCase())) throw new Error('当前支持文本、Markdown、CSV、JSON、日志和代码；不把二进制文件当作文本发送');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('请选择 1MB 以内的文本文件');
    const bytes = await fs.readFile(file);
    if (bytes.length > 1024 * 1024) throw new Error('文件在读取时变大，请选择 1MB 以内的文本文件');
    if (bytes.includes(0)) throw new Error('此文件不是支持的 UTF-8 文本');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const limited = text.slice(0, 24_000);
    return this.#remember(owner, { kind: 'file', title: path.basename(file), text: text.length > limited.length ? `${limited}\n[文件较长，本次仅包含前 24000 字符]` : limited });
  }
  async selectScreen(owner: number): Promise<AgentContextPreview | null> {
    this.#assertAllowed('image');
    this.#selection?.resolve(null); this.#selection?.window.close(); this.#selection = undefined;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const overlay = new BrowserWindow({ ...display.bounds, transparent: true, frame: false, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, backgroundColor: '#00000000', show: false,
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    const selection = new Promise<ScreenRegion | null>(resolve => { this.#selection = { window: overlay, resolve }; });
    const timeout = setTimeout(() => { if (!overlay.isDestroyed()) overlay.close(); }, 120_000);
    overlay.on('closed', () => {
      clearTimeout(timeout);
      if (this.#selection?.window === overlay) { this.#selection.resolve(null); this.#selection = undefined; }
    });
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', event => event.preventDefault());
    try {
      if (this.options.devServerUrl) {
        const url = new URL(this.options.devServerUrl); url.searchParams.set('window', 'screen-region'); await overlay.loadURL(url.toString());
      } else await overlay.loadFile(this.options.rendererPath, { query: { window: 'screen-region' } });
    } catch {
      // A fast Esc / completed selection can close the renderer before the
      // native load Promise settles. Keep that result instead of reporting
      // a spurious load error or leaving the caller busy forever.
      if (!overlay.isDestroyed()) {
        overlay.close();
        throw new Error('选区窗口未能打开，未获取或发送截图');
      }
    }
    if (!overlay.isDestroyed() && process.env.TODO_AGENT_E2E_BACKGROUND !== '1') { overlay.show(); overlay.focus(); }
    const region = await selection;
    if (!overlay.isDestroyed()) overlay.close();
    if (!region) return null;
    this.#assertAllowed('image');
    // Capture only after the selection window has closed; do not photograph
    // the overlay itself. A bounded compositor beat avoids a visible flash.
    await new Promise(resolve => setTimeout(resolve, 100));
    const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false,
      thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) } });
    const source = sources.find(item => item.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('屏幕录制权限未就绪，未获取或发送截图');
    const crop = cropScreenRegion(region, display.bounds, source.thumbnail.getSize());
    let image = source.thumbnail.crop(crop);
    const size = image.getSize();
    if (Math.max(size.width, size.height) > 1600) image = image.resize({ width: Math.round(size.width * 1600 / Math.max(size.width, size.height)), height: Math.round(size.height * 1600 / Math.max(size.width, size.height)) });
    return this.#remember(owner, { kind: 'image', title: '本次屏幕选区', imageDataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}` });
  }
  register(): () => void {
    const handle = (channel: string, fn: (input: any, owner: number) => unknown) => ipcMain.handle(channel, (event, input) => {
      if (!rendererUrlIsTrusted({ url: event.senderFrame?.url, rendererPath: this.options.rendererPath, devServerUrl: this.options.devServerUrl })) throw new Error('UNTRUSTED_RENDERER');
      return fn(input, event.sender.id);
    });
    handle(AGENT_CONTEXT_CHANNELS.chooseFile, async (_input, owner) => {
      this.#assertAllowed('file');
      const result = await dialog.showOpenDialog({ title: '选择本次要总结的文本文件（先预览，后发送）', properties: ['openFile'], filters: [{ name: '文本与代码', extensions: [...textExtensions].map(ext => ext.slice(1)) }] });
      return result.canceled || !result.filePaths[0] ? null : this.readSelectedFile(result.filePaths[0], owner);
    });
    handle(AGENT_CONTEXT_CHANNELS.selectScreen, (_input, owner) => this.selectScreen(owner));
    handle(AGENT_CONTEXT_CHANNELS.finishScreen, (input, owner) => {
      const selection = this.#selection;
      if (!selection || selection.window.webContents.id !== owner) throw new Error('无效的选区窗口');
      const region = input === null ? null : regionSchema.parse(input);
      if (region) cropScreenRegion(region, selection.window.getBounds(), selection.window.getBounds());
      selection.resolve(region);
      this.#selection = undefined;
      selection.window.close();
    });
    handle(AGENT_CONTEXT_CHANNELS.discard, (token, owner) => this.discard(z.string().uuid().parse(token), owner));
    return () => { this.#selection?.window.close(); this.#contexts.clear(); Object.values(AGENT_CONTEXT_CHANNELS).forEach(channel => ipcMain.removeHandler(channel)); };
  }
}
