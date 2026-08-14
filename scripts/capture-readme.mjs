import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "..");
const output = path.join(projectRoot, "docs", "screenshots");
const profile = await mkdtemp(path.join(os.tmpdir(), "todo-agent-capture-"));
await mkdir(output, { recursive: true });

const app = await electron.launch({
  executablePath: electronPath,
  args: [projectRoot, `--user-data-dir=${profile}`],
  cwd: projectRoot,
  env: {
    ...process.env,
    TODO_AGENT_E2E: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "false",
  },
});

async function windowFor(kind) {
  const existing = app.windows().find((page) => {
    try {
      return new URL(page.url()).searchParams.get("window") === kind;
    } catch {
      return false;
    }
  });
  if (existing) return existing;
  return app.waitForEvent("window", {
    predicate: (page) => {
      try {
        return new URL(page.url()).searchParams.get("window") === kind;
      } catch {
        return false;
      }
    },
  });
}

try {
  const main = await windowFor("main");
  await main.waitForLoadState("domcontentloaded");
  const skip = main.getByRole("button", { name: "跳过并使用本地任务" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await main.evaluate(async () => {
    const localDate = new Date();
    const date = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`;
    const completed = await window.desktopApi.tasks.create({
      title: "完成 Todo Pet 的第一轮视觉打磨",
      plannedDate: date,
      priority: "high",
      source: { type: "local" },
    });
    await window.desktopApi.tasks.complete({ id: completed.task.id });
    await window.desktopApi.tasks.create({
      title: "整理今天最重要的三个行动",
      plannedDate: date,
      priority: "urgent",
      source: { type: "local" },
    });
    await window.desktopApi.tasks.create({
      title: "和小序一起专注 25 分钟",
      plannedDate: date,
      priority: "medium",
      source: { type: "local" },
    });
  });

  await main.getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "小窝", exact: true })
    .click();
  await main.getByRole("heading", { name: "小序的小窝" }).waitFor();
  await main.screenshot({
    path: path.join(output, "todo-pet-home.png"),
    animations: "disabled",
  });

  const floating = await windowFor("floating");
  await floating.waitForLoadState("domcontentloaded");
  await floating.getByRole("button", { name: "展开 小序" }).click();
  await floating.getByRole("button", { name: "专注", exact: true }).click();
  await floating.locator(".pet-focus-view").waitFor();
  await floating.screenshot({
    path: path.join(output, "todo-pet-focus.png"),
    animations: "disabled",
  });
  await floating.getByRole("button", { name: "小窝", exact: true }).click();
  await floating.locator(".pet-home-view").waitFor();
  await floating.screenshot({
    path: path.join(output, "todo-pet-companion.png"),
    animations: "disabled",
  });
} finally {
  await app.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
}
