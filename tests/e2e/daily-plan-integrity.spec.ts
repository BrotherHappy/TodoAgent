import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron, expect, test, type ElectronApplication } from 'playwright/test';
import { LocalStore } from '../../electron/services/local-store';
import type { Task } from '../../src/shared/models';
import { waitForElectronWindow } from '../helpers/electron-window';

const root = path.resolve(import.meta.dirname, '../..');
function nonPlanningData(task: Task) {
  const { plannedDate, privateOrder, estimatedMinutes, updatedAt, ...rest } = task;
  return rest;
}

test('eight-task daily planning tolerates a legacy empty Feishu title, undoes atomically, and recovers from a stale preview in readable UI', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-daily-plan-integrity-'));
  const installed = process.env.TODO_AGENT_INSTALLED_EXECUTABLE;
  const launch = () => electron.launch({
    executablePath: installed ?? electronPath as unknown as string,
    args: [...(installed ? [] : [root]), `--user-data-dir=${profile}`], cwd: root,
    env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' },
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    let main = await waitForElectronWindow(app, 'main');
    await main.getByRole('button', { name: '跳过并使用本地任务' }).click();
    const fixture = await main.evaluate(async () => {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const api = window.desktopApi!;
      const settings = await api.settings.get();
      await api.settings.replace({ ...settings, theme: 'dark' });
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const { task } = await api.tasks.create({
          title: `验收任务 ${i + 1}`, dueAt: new Date(`${date}T12:00:00`).toISOString(),
          source: { type: 'feishu', accountId: 'isolated-test', externalId: `isolated-${i}` },
          sync: { status: 'synced' },
        });
        ids.push(task.id);
      }
      return { date, ids };
    });
    await app.close();
    app = undefined;
    const store = new LocalStore(path.join(profile, 'data'));
    await store.transact(state => { state.tasks[fixture.ids[2]].title = ''; });
    const before = (await store.load()).tasks;

    app = await launch();
    main = await waitForElectronWindow(app, 'main');
    await main.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await main.evaluate(async () => {
      const api = window.desktopApi!;
      await api.settings.replace({ ...await api.settings.get(), theme: 'dark' });
    });
    const pageErrors: string[] = [];
    main.on('pageerror', error => pageErrors.push(error.message));
    await main.locator('.morning-brief').getByRole('button', { name: '帮我选今天', exact: true }).click();
    const dialog = main.getByRole('dialog', { name: '一起排今天' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('note')).toContainText('有 1 项任务暂缺标题');
    await expect(dialog.getByText('待补全标题的飞书任务').first()).toBeVisible();
    await dialog.getByRole('button', { name: '安排 8 项到今天' }).click();
    await expect(main.getByRole('heading', { name: '今天先守住这 8 件事' })).toBeVisible();
    await expect(main.locator('.daily-plan-inline-error')).toHaveCount(0);
    const after = (await store.load()).tasks;
    expect(fixture.ids.map(id => after[id].privateOrder).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const id of fixture.ids) {
      expect(after[id]).toMatchObject({ plannedDate: fixture.date });
      expect(nonPlanningData(after[id])).toEqual(nonPlanningData(before[id]));
    }
    await main.getByRole('button', { name: '撤销计划', exact: true }).click();
    await expect(dialog).toBeVisible();
    const undone = await store.load();
    expect(undone.operations.filter(operation => operation.kind === 'plan-today')).toHaveLength(1);
    expect(undone.operations.find(operation => operation.kind === 'plan-today')?.undoneAt).toBeDefined();
    for (const id of fixture.ids) {
      expect(undone.tasks[id].plannedDate).toBe(before[id].plannedDate);
      expect(undone.tasks[id].privateOrder).toBe(before[id].privateOrder);
      expect(nonPlanningData(undone.tasks[id])).toEqual(nonPlanningData(before[id]));
    }

    // Simulate a concurrent writer after the preview, only in this temporary
    // profile. No renderer event is emitted, so the preview is truly stale.
    await store.transact(state => { state.tasks[fixture.ids[7]].privateOrder += 20; });
    await dialog.getByRole('button', { name: '安排 8 项到今天' }).click();
    const error = dialog.getByRole('alert');
    await expect(error).toContainText('计划已在别处发生变化');
    await expect(error).not.toContainText('Error invoking');
    await expect(error).not.toContainText('TaskValidationError');
    expect((await store.load()).operations.filter(operation => operation.kind === 'plan-today')).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=main'))?.setSize(760, 600);
    });
    const geometry = await dialog.evaluate(element => {
      const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const alert = box('.daily-plan-inline-error'), footer = box('.daily-plan-actions'), editor = box('.daily-plan-editor');
      const editorElement = element.querySelector<HTMLElement>('.daily-plan-editor')!;
      return { alertTop: alert.top, alertBottom: alert.bottom, footerTop: footer.top, editorBottom: editor.bottom, overflow: getComputedStyle(editorElement).overflowY, scrollable: editorElement.scrollHeight > editorElement.clientHeight, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    expect(geometry.editorBottom).toBeLessThanOrEqual(geometry.alertTop + 1);
    expect(geometry.alertBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.overflow).toBe('auto');
    expect(geometry.scrollable).toBe(true);
    await main.screenshot({ path: test.info().outputPath('daily-plan-recoverable-error.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '刷新并重新预览' }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: '安排 8 项到今天' }).click();
    await expect(main.getByRole('heading', { name: '今天先守住这 8 件事' })).toBeVisible();
    expect(pageErrors).toEqual([]);
    await main.screenshot({ path: test.info().outputPath('daily-plan-eight-tasks-saved.png'), animations: 'disabled' });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});
