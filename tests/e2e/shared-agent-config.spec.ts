import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron, expect, test } from 'playwright/test';
import { waitForElectronWindow } from '../helpers/electron-window';

test('pet and main LLM features share Agent base URL, credentials and live fallback settings', async () => {
  test.setTimeout(120_000);
  const requests: Array<{ url: string; authorization?: string; body: Record<string, any> }> = [];
  let primaryOffline = false;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: request.url!, authorization: request.headers.authorization, body });
    if (primaryOffline && request.url!.startsWith('/updated/')) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'isolated primary offline' } }));
      return;
    }
    const content = `## 共用连接已验证\n\n${body.model}`;
    const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'shared-config', choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'shared-config', choices: [], usage })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'shared-config', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated test endpoint');
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'todo-shared-agent-'));
  const root = path.resolve(import.meta.dirname, '../..');
  const file = path.join(profile, 'shared-config-fixture.md');
  await writeFile(file, '# 测试资料\n只在隔离测试服务中使用这段文字。');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath: electronPath as unknown as string, args: [root, `--user-data-dir=${profile}`], cwd: root,
      env: { ...process.env, TODO_AGENT_E2E: '1', TODO_AGENT_E2E_BACKGROUND: '1' } });
    const main = await waitForElectronWindow(app, 'main');
    await main.getByRole('button', { name: '跳过并使用本地任务' }).click();
    await main.evaluate(async origin => {
      const api = window.desktopApi!;
      const credential = await api.settings.setCredential({ id: 'shared-primary', kind: 'ai-api-key', value: 'synthetic-primary-key' });
      const settings = await api.settings.get();
      await api.settings.replace({ ...settings,
        ai: { ...settings.ai, enabled: true, protocol: 'openai-compatible', endpoint: `${origin}/shared/v1`, model: 'shared-model', authMode: 'bearer', credentialId: credential.id, routing: 'primary-only', retries: 0, dailyTokenLimit: 0, dailyCostLimit: 0 },
        notifications: { ...settings.notifications, morningBrief: false },
      });
      await api.buddy!.setPreferences({ gravity: false, inertia: false });
      await api.shell.showMain('settings');
    }, origin);
    await main.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: 'Todo Pet', exact: true }).click();
    const shared = main.getByRole('region', { name: '共用 Agent 模型配置' });
    await expect(shared).toContainText(`shared-model · ${origin}/shared/v1`);
    await expect(shared.locator('input')).toHaveCount(0);
    await shared.screenshot({ path: test.info().outputPath('shared-agent-settings.png') });
    await shared.getByRole('button', { name: '管理 Agent 模型配置' }).click();
    await expect(main.getByRole('heading', { name: '模型与 Agent', exact: true })).toBeVisible();

    await main.evaluate(() => window.desktopApi!.shell.showMain('agent'));
    await main.getByLabel('给 Agent 发消息').fill('介绍你的能力');
    await main.getByRole('button', { name: '发送', exact: true }).click();
    await expect(main.getByRole('heading', { name: '共用连接已验证', exact: true })).toBeVisible();
    expect(requests.at(-1)).toMatchObject({ url: '/shared/v1/chat/completions', authorization: 'Bearer synthetic-primary-key', body: { model: 'shared-model' } });

    await main.evaluate(() => window.desktopApi!.shell.setFloatingVisible(true));
    const floating = await waitForElectronWindow(app, 'floating');
    await floating.getByRole('button', { name: '展开 小序' }).click();
    await floating.getByRole('button', { name: '聊聊', exact: true }).click();
    await floating.getByLabel('给 Agent 发消息').fill('陪我聊聊');
    await floating.getByRole('button', { name: '发送给 Agent' }).click();
    await expect(floating.getByRole('heading', { name: '共用连接已验证', exact: true }).last()).toBeVisible();
    expect(requests.at(-1)).toMatchObject({ url: '/shared/v1/chat/completions', authorization: 'Bearer synthetic-primary-key', body: { model: 'shared-model' } });

    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await floating.getByRole('button', { name: '文件摘要', exact: true }).click();
    await expect(floating.locator('.buddy-context-preview')).toContainText('shared-config-fixture.md');
    const beforeConfirm = requests.length;
    // Save only the existing Agent settings in the other window. The open pet
    // preview must update its destination and must not send anything yet.
    await main.evaluate(async origin => {
      const api = window.desktopApi!;
      const credential = await api.settings.setCredential({ id: 'shared-updated', kind: 'ai-api-key', value: 'synthetic-updated-key' });
      const settings = await api.settings.get();
      await api.settings.replace({ ...settings, ai: { ...settings.ai, endpoint: `${origin}/updated/v1`, model: 'updated-model', credentialId: credential.id, routing: 'fallback-on-error',
        fallback: { ...settings.ai.fallback, enabled: true, endpoint: `${origin}/backup/v1`, model: 'shared-backup', authMode: 'none' },
      } });
    }, origin);
    await expect(floating.locator('.buddy-context-confirm')).toContainText(`updated-model · ${origin}/updated/v1`);
    await expect(floating.locator('.buddy-context-confirm')).toContainText(`备用模型：shared-backup · ${origin}/backup/v1`);
    expect(requests).toHaveLength(beforeConfirm);
    await floating.getByRole('button', { name: '确认发送资料并提问' }).click();
    await expect(floating.locator('.buddy-context-preview')).toHaveCount(0);
    await expect(floating.getByRole('heading', { name: '共用连接已验证', exact: true })).toHaveCount(2);
    expect(requests.at(-1)).toMatchObject({ url: '/updated/v1/chat/completions', authorization: 'Bearer synthetic-updated-key', body: { model: 'updated-model' } });
    expect(JSON.stringify(requests.at(-1)!.body.messages)).toContain('只在隔离测试服务中使用这段文字');
    expect(requests.at(-1)!.body.tools).toBeUndefined();

    primaryOffline = true;
    const beforeFallback = requests.length;
    await floating.getByLabel('给 Agent 发消息').fill('继续介绍你的能力');
    await floating.getByRole('button', { name: '发送给 Agent' }).click();
    await expect(floating.getByRole('heading', { name: '共用连接已验证', exact: true })).toHaveCount(3);
    expect(requests.slice(beforeFallback).map(request => request.url)).toEqual(['/updated/v1/chat/completions', '/backup/v1/chat/completions']);
    expect(requests.at(-1)).toMatchObject({ authorization: undefined, body: { model: 'shared-backup' } });

    // Connection tests and morning summaries are also served by the same route.
    const connection = await main.evaluate(() => window.desktopApi!.agent.testModelConnection());
    expect(connection.ok).toBe(true);
    expect(requests.at(-1)!.body.model).toBe('shared-backup');
    const brief = await main.evaluate(async () => {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      await window.desktopApi!.tasks.create({ title: '隔离简报任务', plannedDate: date });
      return window.desktopApi!.agent.morningBrief({ trigger: 'manual' });
    });
    expect(brief.source).toBe('ai');
    expect(requests.at(-1)!.body.model).toBe('shared-backup');
    expect(requests.every(request => request.url.endsWith('/chat/completions'))).toBe(true);
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await rm(profile, { recursive: true, force: true });
  }
});
