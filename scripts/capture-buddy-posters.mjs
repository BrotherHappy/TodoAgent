// Capture real bundled model pixels for an offline, no-WebGL loading fallback.
// No account, model API, user profile, or external assets are used.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'src/assets/desktopbuddy-posters');
const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-posters-'));
await mkdir(output, { recursive: true });
const app = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root,
  env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
const findWindow = async kind => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const page = app.windows().find(page => page.url().includes(`window=${kind}`));
    if (page) { await page.waitForLoadState('domcontentloaded'); return page; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Missing ${kind} window`);
};
try {
  const main = await findWindow('main');
  await main.waitForFunction(() => !!window.desktopApi?.buddy);
  await main.evaluate(async () => {
    await window.desktopApi.buddy.setPreferences({ gravity: false, inertia: false, breathing: false, cursorFollow: false });
    await window.desktopApi.shell.setFloatingVisible(true);
  });
  const floating = await findWindow('floating');
  await floating.addStyleTag({ content: '.pet-avatar-button, .pet-character { width: 256px !important; height: 256px !important; } .buddy-character-body { transform: none !important; }' });
  for (const themeId of ['wanko-live2d', 'hiyori-live2d', 'rice-live2d', 'mark-live2d', 'haru-live2d']) {
    await main.evaluate(themeId => window.desktopApi.buddy.setPreferences({ themeId }), themeId);
    const canvas = floating.locator(`[data-buddy-theme="${themeId}"] [data-buddy-renderer="live2d"]`).first();
    await canvas.waitFor({ state: 'visible' });
    await floating.waitForFunction(id => document.querySelector(`[data-buddy-active="${id}"] canvas`)?.dataset.buddyStatus === 'ready', themeId);
    await floating.waitForFunction(() => document.querySelectorAll('.buddy-theme-layer').length === 1);
    // Read the complete committed frame, not the portion clipped by the
    // native floating window's small bounds. This is a capture of the actual
    // renderer, with its original model colors and transparent background.
    await floating.waitForFunction(id => Number(document.querySelector(`[data-buddy-theme="${id}"] canvas`)?.dataset.buddyFrame) > 3, themeId, { timeout: 15_000 });
    const dataUrl = await canvas.evaluate(canvas => canvas.toDataURL('image/png'));
    await writeFile(path.join(output, `${themeId}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  console.log('Captured five bundled Live2D posters using an isolated background profile.');
} finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
