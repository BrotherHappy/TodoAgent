import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dialog, ipcMain, nativeImage, net, protocol, screen, type BrowserWindow } from 'electron';
import { BUDDY_CHANNELS, type BuddyGeneratedTheme } from '../src/shared/desktopbuddy-contract';
import { rendererUrlIsTrusted } from './trusted-renderer';
import { DesktopBuddyService } from './services/desktopbuddy-service';

export function registerBuddyAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'pet-asset', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
  } }]);
}

export function registerBuddyIpc(options: {
  service: DesktopBuddyService;
  rendererPath: string;
  devServerUrl?: string;
  floating: () => BrowserWindow | undefined;
}): () => void {
  const { service } = options;
  const channels: string[] = [];
  const handle = (channel: string, fn: (input: any) => unknown): void => {
    ipcMain.handle(channel, (event, input) => {
      if (!rendererUrlIsTrusted({ url: event.senderFrame?.url, rendererPath: options.rendererPath, devServerUrl: options.devServerUrl })) throw new Error('UNTRUSTED_RENDERER');
      return fn(input);
    });
    channels.push(channel);
  };
  handle(BUDDY_CHANNELS.snapshot, () => service.snapshot());
  handle(BUDDY_CHANNELS.assets, id => service.assets(id));
  handle(BUDDY_CHANNELS.preferences, patch => service.setPreferences(patch));
  handle(BUDDY_CHANNELS.generate, (input: BuddyGeneratedTheme) => service.generate(input));
  handle(BUDDY_CHANNELS.enabled, input => service.setEnabled(input?.themeId, input?.enabled));
  handle(BUDDY_CHANNELS.remove, id => service.remove(id));
  handle(BUDDY_CHANNELS.interaction, id => service.interact(id));
  handle(BUDDY_CHANNELS.import, async () => {
    const selection = await dialog.showOpenDialog({ title: '导入 DesktopBuddy 角色包', properties: ['openFile'], filters: [{ name: 'DesktopBuddy ZIP 角色', extensions: ['zip'] }] });
    return selection.canceled || !selection.filePaths[0] ? null : service.importZip(selection.filePaths[0]);
  });
  handle(BUDDY_CHANNELS.image, async () => {
    const selection = await dialog.showOpenDialog({ title: '选择角色图片（本地处理，不自动上传）', properties: ['openFile'], filters: [{ name: '角色图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    const file = selection.filePaths[0];
    if (selection.canceled || !file) return null;
    if ((await fs.stat(file)).size > 5 * 1024 * 1024) throw new Error('请选择 5MB 以内的图片');
    const bytes = await fs.readFile(file);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('请选择 5MB 以内的图片');
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('无法读取这张图片');
    const size = image.getSize();
    if (size.width > 8192 || size.height > 8192) throw new Error('图片尺寸过大，请先缩小到 8192px 以内');
    const mime = path.extname(file).toLowerCase() === '.webp' ? 'image/webp' : /\.jpe?g$/iu.test(file) ? 'image/jpeg' : 'image/png';
    return { imageDataUrl: `data:${mime};base64,${bytes.toString('base64')}`, name: path.basename(file, path.extname(file)).slice(0, 40) };
  });
  protocol.handle('pet-asset', async request => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const target = await service.resolveAsset(request.url);
      const response = await net.fetch(pathToFileURL(target).toString());
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      const ext = path.extname(target);
      if (ext === '.js') headers.set('Content-Type', 'application/javascript');
      if (ext === '.json') headers.set('Content-Type', 'application/json');
      if (ext === '.moc3') headers.set('Content-Type', 'application/octet-stream');
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    } catch { return new Response('Resource unavailable', { status: 404 }); }
  });
  let previous = screen.getCursorScreenPoint();
  let previousTime = Date.now();
  const cursorTimer = setInterval(() => {
    const window = options.floating();
    if (!window || window.isDestroyed() || !window.isVisible() || !service.preferences().cursorFollow) return;
    const cursor = screen.getCursorScreenPoint();
    const now = Date.now();
    const elapsed = Math.max(16, now - previousTime);
    const bounds = window.getBounds();
    window.webContents.send(BUDDY_CHANNELS.cursor, {
      x: cursor.x - bounds.x, y: cursor.y - bounds.y,
      velocityX: (cursor.x - previous.x) / elapsed, velocityY: (cursor.y - previous.y) / elapsed,
    });
    previous = cursor;
    previousTime = now;
  }, 40);
  cursorTimer.unref();
  return () => {
    clearInterval(cursorTimer);
    channels.forEach(channel => ipcMain.removeHandler(channel));
    protocol.unhandle('pet-asset');
  };
}
