// Isolated, hidden Electron screenshots: never reads the user's task profile.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'docs/screenshots');
const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-buddy-readme-'));
await mkdir(output, { recursive: true });
const app = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], cwd: root,
  env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
try {
  const main = app.windows().find(page => page.url().includes('window=main')) ?? await app.waitForEvent('window', { predicate: page => page.url().includes('window=main') });
  await main.waitForLoadState('domcontentloaded');
  await main.getByRole('button', { name: '跳过并使用本地任务' }).click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=main')).setContentSize(1280, 1000, false);
  });
  await main.evaluate(() => window.desktopApi.shell.showMain('settings'));
  await main.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: 'Todo Pet', exact: true }).click();
  const gallery = main.getByRole('region', { name: 'DesktopBuddy 伙伴与动画' });
  await gallery.locator('[data-buddy-status="ready"]').waitFor();
  await gallery.getByRole('heading', { name: '选择你的桌面伙伴' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
  await main.waitForTimeout(350);
  await main.screenshot({ path: path.join(output, 'desktopbuddy-gallery.png') });
  console.log('Saved docs/screenshots/desktopbuddy-gallery.png from an isolated background app.');
} finally {
  await app.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
}
