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

async function mainWindow(app: ElectronApplication): Promise<Page> {
  const existing = app
    .windows()
    .find((page) => new URL(page.url()).searchParams.get("window") === "main");
  return (
    existing ??
    app.waitForEvent("window", {
      predicate: (page) => {
        try {
          return new URL(page.url()).searchParams.get("window") === "main";
        } catch {
          return false;
        }
      },
    })
  );
}

test("installed macOS bundle starts securely and persists a local task", async () => {
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
    if (await skip.isVisible().catch(() => false)) await skip.click();

    const appInfo = await main.evaluate(() =>
      window.desktopApi!.shell.getInfo(),
    );
    expect(appInfo).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      isPackaged: true,
    });

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
