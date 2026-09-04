import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron, expect, test, type ElectronApplication } from 'playwright/test';

import { waitForElectronWindow } from '../helpers/electron-window';
async function buddyMainWindow(app: ElectronApplication) {
  return waitForElectronWindow(app, 'main');
}

test('DesktopBuddy all five original characters render and animate without remounting on touch', async () => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-e2e-'));
  const root = path.resolve(import.meta.dirname, '../..');
  const app = await electron.launch({ executablePath: electronPath as unknown as string, args: [root, `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
  try {
    const main = await buddyMainWindow(app);
    await main.waitForFunction(() => !!window.desktopApi?.buddy);
    const snapshot = await main.evaluate(() => window.desktopApi!.buddy!.snapshot());
    expect(snapshot.themes).toHaveLength(5);
    expect(snapshot.themes.filter(theme => !theme.ready).map(theme => ({ id: theme.manifest.id, issue: theme.issue }))).toEqual([]);
    await main.evaluate(() => window.desktopApi!.shell.setFloatingVisible(true));
    const floating = await waitForElectronWindow(app, 'floating');
    const failures: string[] = [];
    floating.on('pageerror', error => failures.push(error.message));
    for (const theme of snapshot.themes) {
      await main.evaluate(id => window.desktopApi!.buddy!.setPreferences({ themeId: id, gravity: false, inertia: false }), theme.manifest.id);
      const surface = floating.locator(`[data-buddy-theme="${theme.manifest.id}"] canvas`).first();
      await expect(surface).toHaveAttribute('data-buddy-status', 'ready', { timeout: 20_000 });
      const before = Number(await surface.getAttribute('data-buddy-frame'));
      await expect.poll(async () => Number(await surface.getAttribute('data-buddy-frame'))).toBeGreaterThan(before + 10);
      await surface.evaluate(element => element.setAttribute('data-identity-probe', 'original'));
      await main.evaluate(id => window.desktopApi!.buddy!.interact(id), theme.manifest.interactions[0].id);
      await expect(surface).toHaveAttribute('data-identity-probe', 'original');
      // Ignore whole-character CSS floating; compare the model's own pixels.
      await floating.addStyleTag({ content: '.buddy-character-body { transform: none !important; } .buddy-theme-layer { transition: none !important; }' });
      const pictures = new Set<string>();
      for (let sample = 0; sample < 4; sample++) {
        await floating.waitForTimeout(150);
        const picture = await surface.screenshot();
        pictures.add(createHash('sha256').update(picture).digest('hex'));
        if (theme.manifest.id === 'wanko-live2d') await writeFile(test.info().outputPath(`desktopbuddy-wanko-motion-${sample}.png`), picture);
      }
      expect(pictures.size, `${theme.manifest.id} changes its actual model pixels`).toBeGreaterThan(1);
    }
    expect(failures).toEqual([]);
    await floating.screenshot({ path: test.info().outputPath('desktopbuddy-original-characters.png') });
    // Rapid A → B → A must keep at least one painted layer, not a blank stage.
    for (const id of ['wanko-live2d', 'mark-live2d', 'wanko-live2d']) await main.evaluate(themeId => window.desktopApi!.buddy!.setPreferences({ themeId }), id);
    await expect(floating.locator('[data-buddy-active="wanko-live2d"]').first()).toBeVisible();
    await expect(floating.locator('.buddy-theme-layer')).toHaveCount(1, { timeout: 10_000 });
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
});

test('image generation UI produces original 33 frames plus three 33-frame actions, persists and restores Live2D', async () => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-generation-'));
  const root = path.resolve(import.meta.dirname, '../..');
  const app = await electron.launch({ executablePath: electronPath as unknown as string, args: [root, `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
  try {
    const main = await buddyMainWindow(app);
    await main.waitForFunction(() => !!window.desktopApi?.buddy);
    const skip = main.getByRole('button', { name: '跳过并使用本地任务' });
    await skip.click();
    const data = await main.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 180;
      const c = canvas.getContext('2d')!; c.fillStyle = '#437a99'; c.beginPath(); c.ellipse(60, 98, 35, 66, 0, 0, 2 * Math.PI); c.fill();
      c.fillStyle = '#fff'; c.fillRect(45, 64, 7, 8); c.fillRect(70, 64, 7, 8);
      return canvas.toDataURL('image/png');
    });
    const imageFile = path.join(profile, 'generation-fixture.png'); await writeFile(imageFile, Buffer.from(data.split(',')[1], 'base64'));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, imageFile);
    await main.evaluate(() => window.desktopApi!.shell.showMain('settings'));
    await main.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: 'Todo Pet', exact: true }).click();
    const gallery = main.getByRole('region', { name: 'DesktopBuddy 伙伴与动画' });
    await expect(gallery).toBeVisible();
    await gallery.getByLabel('陪伴人格').selectOption('efficient');
    const memory = gallery.getByLabel('对话记忆轮数'); await memory.fill('50'); await memory.press('Tab');
    await expect.poll(async () => main.evaluate(async () => (await window.desktopApi!.buddy!.snapshot()).preferences.memoryRounds)).toBe(50);
    await gallery.getByRole('button', { name: '用一张图片生成动画', exact: true }).click();
    await gallery.getByLabel('新角色名字').fill('本地生成测试伙伴');
    await gallery.getByRole('button', { name: '生成并切换', exact: true }).click();
    await expect(gallery.getByText('新伙伴已生成并切换。')).toBeVisible({ timeout: 60_000 });
    const snapshot = await main.evaluate(() => window.desktopApi!.buddy!.snapshot());
    const created = snapshot.themes.find(theme => theme.origin === 'user')!;
    expect(created.ready).toBe(true);
    expect(Object.keys(created.manifest.model?.staticImages ?? {})).toHaveLength(133);
    expect(Object.keys(created.manifest.animationClips ?? {})).toEqual(['pet', 'jump-rope', 'task-carry']);
    const canvas = gallery.locator('[data-render-path="double-buffer"]');
    await expect(canvas).toHaveCount(1);
    await expect.poll(async () => Number(await canvas.getAttribute('data-buddy-frame'))).toBeGreaterThan(5);
    await gallery.screenshot({ path: test.info().outputPath('desktopbuddy-generation-gallery.png') });
    await main.reload();
    await main.waitForFunction(() => !!window.desktopApi?.buddy);
    expect((await main.evaluate(() => window.desktopApi!.buddy!.snapshot())).preferences).toMatchObject({ themeId: created.manifest.id, persona: 'efficient', memoryRounds: 50 });
    await main.evaluate(id => window.desktopApi!.buddy!.setEnabled(id, false), created.manifest.id);
    expect((await main.evaluate(() => window.desktopApi!.buddy!.snapshot())).preferences.themeId).toBe('wanko-live2d');
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
});

test('native Ollama receives explicitly confirmed file/region context; cancelling never captures a screen', async () => {
  test.setTimeout(120_000);
  const requests: { url: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url!, body: JSON.parse(raw) });
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ message: { role: 'assistant', content: '## 所选资料摘要\n\n' }, done: false })}\n`);
    response.end(`${JSON.stringify({ message: { content: '只读取了本次确认的资料。' }, done: true, prompt_eval_count: 12, eval_count: 8 })}\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local test endpoint');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-context-'));
  const root = path.resolve(import.meta.dirname, '../..');
  const file = path.join(profile, 'explicit-summary.md'); await writeFile(file, '# 隔离测试资料\n本周只讨论两个测试功能。');
  const app = await electron.launch({ executablePath: electronPath as unknown as string, args: [root, `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
  try {
    const main = await buddyMainWindow(app); await main.waitForFunction(() => !!window.desktopApi?.agentContext);
    const skip = main.getByRole('button', { name: '跳过并使用本地任务' }); await skip.click();
    await main.evaluate(async url => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({ ...settings, ai: { ...settings.ai, enabled: true, protocol: 'ollama', endpoint: url, model: 'local-test-vision', authMode: 'none', dailyTokenLimit: 0, routing: 'primary-only' } });
      await window.desktopApi!.shell.showMain('agent');
    }, endpoint);
    await app.evaluate(({ dialog, desktopCapturer, screen, nativeImage }, selectedFile) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFile] });
      (globalThis as any).__buddyCaptureCount = 0;
      desktopCapturer.getSources = async () => {
        (globalThis as any).__buddyCaptureCount++;
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        return [{ id: 'screen:fixture', name: 'Isolated test image', display_id: String(display.id), appIcon: nativeImage.createEmpty(),
          thumbnail: nativeImage.createFromBitmap(Buffer.alloc(640 * 480 * 4, 128), { width: 640, height: 480 }) }];
      };
    }, file);
    await main.getByRole('button', { name: '文件摘要', exact: true }).click();
    await expect(main.locator('.buddy-context-preview')).toContainText('explicit-summary.md');
    expect(requests).toHaveLength(0);
    await main.getByRole('button', { name: '确认发送资料并提问', exact: true }).click();
    await expect(main.getByRole('heading', { name: '所选资料摘要', exact: true })).toBeVisible();
    expect(requests[0]).toMatchObject({ url: '/api/chat', body: { model: 'local-test-vision', stream: true } });
    expect(JSON.stringify(requests[0].body.messages)).toContain('本周只讨论两个测试功能');
    expect(requests[0].body.tools).toBeUndefined();
    await main.getByRole('button', { name: '选区问答', exact: true }).click();
    const selection = await waitForElectronWindow(app, 'screen-region');
    await selection.waitForFunction(() => !!window.desktopApi?.agentContext);
    await selection.getByRole('main').press('Escape').catch(error => { if (!selection.isClosed()) throw error; });
    await expect(main.getByRole('button', { name: '选区问答', exact: true })).toBeEnabled();
    expect(await app.evaluate(() => (globalThis as any).__buddyCaptureCount)).toBe(0);
    expect(requests).toHaveLength(1);
    await main.getByRole('button', { name: '选区问答', exact: true }).click();
    const second = await waitForElectronWindow(app, 'screen-region');
    await second.waitForFunction(() => !!window.desktopApi?.agentContext);
    await second.waitForLoadState('load');
    await expect(second.getByRole('main')).toBeVisible();
    await second.evaluate(() => { void window.desktopApi!.agentContext!.finishScreenRegion({ x: 50, y: 50, width: 200, height: 120 }); });
    await expect(main.getByAltText('即将发送的屏幕选区，未包含其他区域')).toBeVisible();
    expect(await app.evaluate(() => (globalThis as any).__buddyCaptureCount)).toBe(1);
    expect(requests).toHaveLength(1);
    await main.getByRole('button', { name: '确认发送资料并提问', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].body.messages.at(-1).images).toHaveLength(1);
    expect(requests[1].body.tools).toBeUndefined();
  } finally { await app.close(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await rm(profile, { recursive: true, force: true }); }
});

test('native drag release bounces inside the work area and expanding interrupts motion', async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-physics-'));
  const root = path.resolve(import.meta.dirname, '../..');
  const app = await electron.launch({ executablePath: electronPath as unknown as string, args: [root, `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
  try {
    const main = await buddyMainWindow(app); await main.waitForFunction(() => !!window.desktopApi?.buddy);
    await main.evaluate(async () => {
      await window.desktopApi!.buddy!.setPreferences({ gravity: true, inertia: true, edgeSnap: false, reducedMotion: false });
      await window.desktopApi!.shell.setFloatingVisible(true);
    });
    const floating = await waitForElectronWindow(app, 'floating');
    await floating.waitForFunction(() => !!document.querySelector('.pet-task-rail-toggle'));
    await floating.getByRole('button', { name: '收起宠物任务栏', exact: true }).click();
    const start = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('window=floating'))!;
      const area = screen.getDisplayMatching(window.getBounds()).workArea;
      window.setPosition(area.x + 200, area.y + 80, false);
      (globalThis as any).__buddyTestPointer = { x: area.x + 240, y: area.y + 120 };
      screen.getCursorScreenPoint = () => (globalThis as any).__buddyTestPointer;
      return { area, bounds: window.getBounds(), pointer: (globalThis as any).__buddyTestPointer };
    });
    await main.evaluate(point => window.desktopApi!.shell.beginFloatingDrag(point.x, point.y), start.pointer);
    const end = { x: start.pointer.x + 50, y: start.pointer.y + 20 };
    await app.evaluate((_electron, point) => { (globalThis as any).__buddyTestPointer = point; }, end);
    await main.evaluate(async point => { await window.desktopApi!.shell.updateFloatingDrag(point.x, point.y); await window.desktopApi!.shell.endFloatingDrag(); }, end);
    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('window=floating'))!.getBounds());
    const samples = [];
    for (let i = 0; i < 12; i++) { await floating.waitForTimeout(90); samples.push(await bounds()); }
    expect(new Set(samples.map(sample => `${sample.x},${sample.y}`)).size).toBeGreaterThan(4);
    for (const sample of samples) {
      expect(sample.x).toBeGreaterThanOrEqual(start.area.x);
      expect(sample.y).toBeGreaterThanOrEqual(start.area.y);
      expect(sample.x + sample.width).toBeLessThanOrEqual(start.area.x + start.area.width);
      expect(sample.y + sample.height).toBeLessThanOrEqual(start.area.y + start.area.height);
    }
    await main.evaluate(() => window.desktopApi!.shell.setFloatingExpanded(true));
    const held = await bounds(); await floating.waitForTimeout(300);
    expect(await bounds()).toEqual(held);
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
});
