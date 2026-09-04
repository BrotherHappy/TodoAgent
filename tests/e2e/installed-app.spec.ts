import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

const executablePath =
  process.env.TODO_AGENT_INSTALLED_EXECUTABLE ??
  "/Users/hx/Applications/Todo Agent.app/Contents/MacOS/Todo Agent";
const projectRoot = path.resolve(import.meta.dirname, "../..");

test.skip(
  process.env.TODO_AGENT_INSTALLED_SMOKE !== "1",
  "Run only after installing the packaged macOS app.",
);

import { waitForElectronWindow } from '../helpers/electron-window';
async function mainWindow(app: ElectronApplication): Promise<Page> {
  return waitForElectronWindow(app, 'main');
}

test("installed macOS bundle loads original Live2D assets and persists its character and local task", async () => {
  test.setTimeout(90_000);
  await access(executablePath);
  const profilePath = await mkdtemp(
    path.join(os.tmpdir(), "todo-agent-installed-smoke-"),
  );
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${profilePath}`],
      env: {
        ...process.env,
        TODO_AGENT_E2E: "1",
        TODO_AGENT_E2E_BACKGROUND: "1",
      },
    });
    let main = await mainWindow(app);
    await main.waitForLoadState("domcontentloaded");
    const skip = main.getByRole("button", {
      name: "跳过并使用本地任务",
    });
    await skip.click();

    const appInfo = await main.evaluate(() =>
      window.desktopApi!.shell.getInfo(),
    );
    expect(appInfo).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      isPackaged: true,
    });

    const buddy = await main.evaluate(() => window.desktopApi!.buddy!.snapshot());
    expect(buddy.themes).toHaveLength(5);
    expect(buddy.themes.every(theme => theme.ready && theme.enabled)).toBe(true);
    expect(buddy.preferences.themeId).toBe("wanko-live2d");
    await main.evaluate(() => window.desktopApi!.shell.setFloatingVisible(true));
    const floating = await waitForElectronWindow(app, 'floating');
    await expect(floating.locator('[data-buddy-renderer="live2d"]').first()).toHaveAttribute("data-buddy-status", "ready", { timeout: 20_000 });
    const frame = Number(await floating.locator('[data-buddy-renderer="live2d"]').first().getAttribute("data-buddy-frame"));
    await expect.poll(async () => Number(await floating.locator('[data-buddy-renderer="live2d"]').first().getAttribute("data-buddy-frame"))).toBeGreaterThan(frame + 10);
    await main.evaluate(() => window.desktopApi!.buddy!.setPreferences({ themeId: "haru-live2d" }));
    await expect(floating.locator('[data-buddy-active="haru-live2d"]').first()).toBeVisible();
    await expect(floating.locator('.buddy-theme-layer')).toHaveCount(1, { timeout: 20_000 });

    const title = "Codex验收-安装包本地任务";
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main
      .getByLabel("任务标题")
      .or(main.locator("#new-title"))
      .last()
      .fill(title);
    await main.getByRole("button", { name: "保存到本地" }).click();
    await expect(
      main.getByText(title, { exact: true }).first(),
    ).toBeVisible();

    await app.close();
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${profilePath}`],
      env: {
        ...process.env,
        TODO_AGENT_E2E: "1",
        TODO_AGENT_E2E_BACKGROUND: "1",
      },
    });
    main = await mainWindow(app);
    await main.waitForLoadState("domcontentloaded");
    await main.waitForFunction(() => !!window.desktopApi?.buddy);
    expect((await main.evaluate(() => window.desktopApi!.buddy!.snapshot())).preferences.themeId).toBe("haru-live2d");
    await expect(
      main.getByText(title, { exact: true }).first(),
    ).toBeVisible();
    await main.screenshot({
      path: path.join(projectRoot, "test-results", "installed-app.png"),
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(profilePath, { recursive: true, force: true });
  }
});
