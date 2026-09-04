import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron, expect, test, type ElectronApplication, type Locator } from 'playwright/test';
import { waitForElectronWindow } from '../helpers/electron-window';

async function visiblePixels(app: ElectronApplication, surface: Locator) {
  // A live focus/breathing animation is intentionally never geometrically
  // "stable". Capture the on-screen rectangle without stopping the pet or
  // waiting for Playwright's element-screenshot stability heuristic.
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('Pet surface is not visible');
  const png = await surface.page().screenshot({ clip: bounds, omitBackground: true });
  const onScreen = await app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const pixels = image.toBitmap();
    let opaque = 0, colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 48) opaque++;
      if (pixels[i + 3] > 48 && Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 28) colored++;
    }
    return { opaque, colored, pixels: pixels.length / 4 };
  }, png.toString('base64'));
  // A colored Home card or speech bubble must not masquerade as model
  // pixels. Check the transparent committed canvas itself as well.
  const committed = await surface.evaluate(element => {
    if (!(element instanceof HTMLCanvasElement)) return null;
    const context = element.getContext('2d');
    if (!context) return null;
    const data = context.getImageData(0, 0, element.width, element.height).data;
    let opaque = 0, colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 48) opaque++;
      if (data[i + 3] > 48 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 28) colored++;
    }
    return { opaque, colored, pixels: data.length / 4 };
  });
  expect(onScreen.opaque).toBeGreaterThan(100);
  return committed ?? onScreen;
}

test('opening and closing a second pet in Home/Focus never blanks the desktop pet', async () => {
  test.setTimeout(90_000);
  const root = path.resolve(import.meta.dirname, '../..');
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-rendering-'));
  const installed = process.env.TODO_AGENT_INSTALLED_EXECUTABLE;
  const app = await electron.launch({ executablePath: installed ?? electronPath as unknown as string, args: [...(installed ? [] : [root]), `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
  try {
    const main = await waitForElectronWindow(app, 'main');
    await main.waitForFunction(() => !!window.desktopApi?.buddy);
    await main.getByRole('button', { name: '跳过并使用本地任务' }).click();
    await main.evaluate(async () => {
      const api = window.desktopApi!;
      const settings = await api.settings.get();
      await api.settings.replace({ ...settings, theme: 'dark' });
      await api.buddy!.setPreferences({ gravity: false, inertia: false });
      await api.shell.setFloatingVisible(true);
    });
    const floating = await waitForElectronWindow(app, 'floating');
    const errors: string[] = [];
    floating.on('console', message => { if (/INVALID_OPERATION|different.*context|useProgram|uniform.*location/iu.test(message.text())) errors.push(message.text()); });
    const pet = floating.locator('.pet-avatar-button [data-buddy-renderer="live2d"]');
    await expect(pet).toHaveAttribute('data-buddy-status', 'ready');
    expect((await visiblePixels(app, pet)).colored).toBeGreaterThan(100);
    await floating.getByRole('button', { name: /^展开 小序/u }).click();
    await expect(floating.locator('.mini-tabs')).toBeVisible();
    for (const tab of ['小窝', '专注', '全部', '小窝', '全部']) {
      await floating.getByRole('button', { name: tab, exact: true }).click();
      if (tab !== '全部') {
        const preview = floating.locator('.mini-panel [data-buddy-renderer="live2d"]').first();
        await expect(preview).toHaveAttribute('data-buddy-status', 'ready');
        const frame = Number(await preview.getAttribute('data-buddy-frame'));
        await expect.poll(async () => Number(await preview.getAttribute('data-buddy-frame'))).toBeGreaterThan(frame + 4);
        expect((await visiblePixels(app, preview)).colored).toBeGreaterThan(100);
      }
      await expect.poll(async () => (await visiblePixels(app, pet)).colored, { message: `desktop pet remains painted while ${tab} is selected` }).toBeGreaterThan(100);
      await expect(floating.locator('canvas[data-buddy-engine]')).toHaveCount(1);
    }
    await pet.screenshot({ path: test.info().outputPath('pet-after-second-surface.png'), omitBackground: true });
    expect(errors).toEqual([]);
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
});

async function isolatedBuddy() {
  const root = path.resolve(import.meta.dirname, '../..');
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-rendering-'));
  const installed = process.env.TODO_AGENT_INSTALLED_EXECUTABLE;
  const app = await electron.launch({ executablePath: installed ?? electronPath as unknown as string, args: [...(installed ? [] : [root]), `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
  try {
    const main = await waitForElectronWindow(app, 'main');
    await main.waitForFunction(() => !!window.desktopApi?.buddy);
    await main.getByRole('button', { name: '跳过并使用本地任务' }).click();
    await main.evaluate(async () => {
      await window.desktopApi!.buddy!.setPreferences({ gravity: false, inertia: false });
      await window.desktopApi!.shell.setFloatingVisible(true);
    });
    const floating = await waitForElectronWindow(app, 'floating');
    const pet = floating.locator('.pet-avatar-button [data-buddy-renderer="live2d"]');
    await expect(pet).toHaveAttribute('data-buddy-status', 'ready');
    return { app, main, floating, pet, close: async () => { await app.close(); await rm(profile, { recursive: true, force: true }); } };
  } catch (error) { await app.close(); await rm(profile, { recursive: true, force: true }); throw error; }
}

test('a real lost WebGL context retains visible pixels and automatically restores both pet surfaces', async () => {
  test.setTimeout(60_000);
  const { app, floating, pet, close } = await isolatedBuddy();
  try {
    await floating.getByRole('button', { name: /^展开 小序/u }).click();
    await floating.getByRole('button', { name: '小窝', exact: true }).click();
    const preview = floating.locator('.mini-panel [data-buddy-renderer="live2d"]').first();
    await expect(preview).toHaveAttribute('data-buddy-status', 'ready');
    await pet.evaluate(canvas => canvas.setAttribute('data-identity-probe', 'same-visible-canvas'));
    const before = Number(await pet.getAttribute('data-buddy-frame'));
    const simulated = await floating.evaluate(() => {
      const gpu = document.querySelector<HTMLCanvasElement>('canvas[data-buddy-engine]')!;
      const gl = gpu.getContext('webgl2') ?? gpu.getContext('webgl');
      const extension = gl?.getExtension('WEBGL_lose_context');
      extension?.loseContext();
      return !!extension;
    });
    expect(simulated).toBe(true);
    await expect(pet).toHaveAttribute('data-buddy-status', 'recovering');
    expect((await visiblePixels(app, pet)).colored).toBeGreaterThan(100);
    await expect(pet).toHaveAttribute('data-buddy-status', 'ready', { timeout: 12_000 });
    await expect(preview).toHaveAttribute('data-buddy-status', 'ready');
    await expect.poll(async () => Number(await pet.getAttribute('data-buddy-frame'))).toBeGreaterThan(before + 8);
    await expect(pet).toHaveAttribute('data-identity-probe', 'same-visible-canvas');
    await expect(floating.locator('canvas[data-buddy-engine]')).toHaveCount(1);
    expect((await visiblePixels(app, pet)).colored).toBeGreaterThan(100);
    expect((await visiblePixels(app, preview)).colored).toBeGreaterThan(100);
    await floating.screenshot({ path: test.info().outputPath('both-pets-after-gpu-recovery.png'), omitBackground: true });
  } finally { await close(); }
});

test('missing model resources show a visible original-model fallback and clicking retries', async () => {
  test.setTimeout(60_000);
  const { app, floating, close } = await isolatedBuddy();
  try {
    let blocked = 0;
    await floating.route('**/*.moc3', route => { blocked++; return route.abort('failed'); });
    await floating.reload();
    const pet = floating.locator('.pet-avatar-button [data-buddy-renderer="live2d"]');
    await expect(pet).toHaveAttribute('data-buddy-status', 'error', { timeout: 15_000 });
    expect(blocked).toBeGreaterThan(0);
    const poster = floating.locator('.pet-avatar-button [data-buddy-fallback="poster"]');
    await expect(poster).toBeVisible();
    expect((await visiblePixels(app, poster)).colored).toBeGreaterThan(100);
    await floating.screenshot({ path: test.info().outputPath('visible-pet-while-model-unavailable.png'), omitBackground: true });
    await floating.unroute('**/*.moc3');
    await floating.locator('.pet-avatar-button .buddy-character').click();
    await expect(pet).toHaveAttribute('data-buddy-status', 'ready', { timeout: 15_000 });
    await expect(poster).toHaveCount(0);
    expect((await visiblePixels(app, pet)).colored).toBeGreaterThan(100);
  } finally { await close(); }
});

test('repeated head pats and different wheel actions animate the same real joint-driven model', async () => {
  test.setTimeout(90_000);
  const { app, floating, pet, close } = await isolatedBuddy();
  try {
    await floating.addStyleTag({ content: '.buddy-character-body { transform: none !important; } .buddy-theme-layer { transition: none !important; }' });
    await pet.evaluate(canvas => canvas.setAttribute('data-identity-probe', 'same-model'));
    const actions = [['摸摸头', 'pet'], ['摸摸头', 'pet'], ['击掌', 'high-five'], ['挠痒痒', 'tickle'], ['轻戳肚子', 'poke'], ['一起休息', 'drink']] as const;
    let previousKey = '';
    for (const [label, action] of actions) {
      await floating.locator('.pet-compact').hover();
      await floating.getByRole('button', { name: '和小序互动' }).click();
      await floating.getByRole('menuitem', { name: label }).click();
      await expect(pet).toHaveAttribute('data-buddy-action', action);
      const key = await pet.getAttribute('data-buddy-action-key');
      expect(key).not.toBe(previousKey); previousKey = key!;
      await expect(pet).toHaveAttribute('data-identity-probe', 'same-model');
      expect(Number(await pet.getAttribute('data-buddy-joint-count'))).toBeGreaterThan(8);
      const first = await pet.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
      const before = Number(await pet.getAttribute('data-buddy-frame'));
      await expect.poll(async () => Number(await pet.getAttribute('data-buddy-frame'))).toBeGreaterThan(before + 15);
      const next = await pet.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
      expect(next, `${action} must change joint-driven pixels, not just the CSS transform`).not.toBe(first);
      expect((await visiblePixels(app, pet)).colored).toBeGreaterThan(100);
      await pet.screenshot({ path: test.info().outputPath(`${action}-${key!.replace(/[^\w-]/gu, '')}.png`), omitBackground: true });
    }
  } finally { await close(); }
});
