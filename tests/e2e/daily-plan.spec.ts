import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

const projectRoot = path.resolve(import.meta.dirname, "../..");

import { waitForElectronWindow } from '../helpers/electron-window';
async function windowFor(
  app: ElectronApplication,
  kind: "main" | "floating",
): Promise<Page> {
  return waitForElectronWindow(app, kind);
}

async function resizeMain(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows().find((window) => {
        try {
          return new URL(window.webContents.getURL()).searchParams.get("window") === "main";
        } catch {
          return false;
        }
      });
      if (!main) throw new Error("Main window is missing");
      main.setSize(size.width, size.height);
    },
    { width, height },
  );
}

test("plans Today atomically from the main page and Todo Pet entry", async ({}, testInfo) => {
  const profilePath = await mkdtemp(path.join(os.tmpdir(), "todo-agent-daily-plan-"));
  const imageDir = testInfo.outputPath("screens");
  await mkdir(imageDir, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [projectRoot, `--user-data-dir=${profilePath}`],
      cwd: projectRoot,
      env: {
        ...process.env,
        TODO_AGENT_E2E: "1",
        TODO_AGENT_E2E_BACKGROUND: "1",
      },
    });
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    const skip = main.getByRole("button", { name: "跳过并使用本地任务" });
    if (await skip.isVisible().catch(() => false)) await skip.click();

    const fixture = await main.evaluate(async () => {
      const api = window.desktopApi;
      if (!api) throw new Error("Desktop API is unavailable");
      const key = (date: Date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const now = new Date();
      const today = key(now);
      const yesterdayDate = new Date(now);
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterday = key(yesterdayDate);
      const tomorrowDate = new Date(now);
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrow = key(tomorrowDate);
      const atNoon = (date: string) => new Date(`${date}T12:00:00`).toISOString();

      const completedDependency = await api.tasks.create({
        title: "已经完成的前置工作",
        source: { type: "local" },
      });
      await api.tasks.complete({ id: completedDependency.task.id });
      const overdue = await api.tasks.create({
        title: "整理逾期的版本说明",
        dueAt: atNoon(yesterday),
        estimatedMinutes: 30,
        source: { type: "local" },
      });
      const dueToday = await api.tasks.create({
        title: "提交今天的设计复核",
        dueAt: atNoon(today),
        estimatedMinutes: 30,
        source: { type: "feishu", accountId: "e2e-plan" },
        sync: { status: "synced" },
      });
      const retained = await api.tasks.create({
        title: "继续昨天的交互打磨",
        plannedDate: yesterday,
        estimatedMinutes: 45,
        source: { type: "local" },
      });
      const candidate = await api.tasks.create({
        title: "实现今日规划的验收测试",
        plannedDate: tomorrow,
        priority: "urgent",
        estimatedMinutes: 60,
        dependencyIds: [completedDependency.task.id],
        source: { type: "local" },
      });
      await api.tasks.create({
        title: "整理低优先级文档",
        priority: "low",
        estimatedMinutes: 90,
        source: { type: "local" },
      });
      return {
        today,
        retainedId: retained.task.id,
        retainedBefore: retained.task.plannedDate,
        candidateId: candidate.task.id,
        candidateBefore: candidate.task.plannedDate,
        fixedIds: [overdue.task.id, dueToday.task.id],
      };
    });

    await resizeMain(app, 1180, 760);
    const brief = main.locator(".morning-brief");
    await expect(brief.getByRole("button", { name: "帮我选今天" })).toBeVisible();
    await brief.getByRole("button", { name: "帮我选今天" }).click();
    const dialog = main.getByRole("dialog", { name: "一起排今天" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("仍有前置任务未完成")).toHaveCount(0);
    await main.keyboard.press("Meta+k");
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
    await main.keyboard.press("Meta+n");
    await expect(main.getByRole("dialog")).toHaveCount(1);
    await main.screenshot({
      path: path.join(imageDir, "daily-plan-light.png"),
      animations: "disabled",
    });

    const desktopGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(desktopGeometry.left).toBeGreaterThanOrEqual(0);
    expect(desktopGeometry.right).toBeLessThanOrEqual(desktopGeometry.viewportWidth);
    expect(desktopGeometry.top).toBeGreaterThanOrEqual(0);
    expect(desktopGeometry.bottom).toBeLessThanOrEqual(desktopGeometry.viewportHeight);
    expect(desktopGeometry.documentWidth).toBeLessThanOrEqual(desktopGeometry.viewportWidth + 1);

    await dialog.getByRole("button", { name: "1 小时" }).click();
    await dialog.getByRole("button", { name: "移出继续昨天的交互打磨" }).click();
    await dialog.getByRole("button", { name: "加入实现今日规划的验收测试" }).click();
    await dialog.getByRole("button", { name: /安排 3 项到今天/u }).click();
    await expect(
      main.getByRole("heading", { name: "今天先守住这 3 件事" }),
    ).toBeVisible();

    const afterApply = await main.evaluate(
      async ({ retainedId, candidateId }) => ({
        retained: await window.desktopApi!.tasks.get(retainedId, true),
        candidate: await window.desktopApi!.tasks.get(candidateId, true),
      }),
      fixture,
    );
    expect(afterApply.retained?.plannedDate).toBeUndefined();
    expect(afterApply.candidate?.plannedDate).toBe(fixture.today);

    await main.getByRole("button", { name: "撤销计划" }).click();
    await expect(main.getByRole("dialog", { name: "一起排今天" })).toBeVisible();
    const afterUndo = await main.evaluate(
      async ({ retainedId, candidateId }) => ({
        retained: await window.desktopApi!.tasks.get(retainedId, true),
        candidate: await window.desktopApi!.tasks.get(candidateId, true),
      }),
      fixture,
    );
    expect(afterUndo.retained?.plannedDate).toBe(fixture.retainedBefore);
    expect(afterUndo.candidate?.plannedDate).toBe(fixture.candidateBefore);
    await main.getByRole("button", { name: "关闭今日规划" }).click();

    await resizeMain(app, 760, 600);
    await brief.getByRole("button", { name: "帮我选今天" }).click();
    await expect(dialog).toBeVisible();
    await main.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const narrowGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>(".daily-plan-body");
      const primary = element.querySelector<HTMLElement>(".daily-plan-actions .primary-button");
      return {
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        bodyHorizontalOverflow: body ? body.scrollWidth - body.clientWidth : 0,
        primaryVisible: Boolean(primary && primary.getBoundingClientRect().height > 0),
      };
    });
    expect(narrowGeometry.right).toBeLessThanOrEqual(narrowGeometry.viewportWidth);
    expect(narrowGeometry.bottom).toBeLessThanOrEqual(narrowGeometry.viewportHeight);
    expect(narrowGeometry.documentWidth).toBeLessThanOrEqual(narrowGeometry.viewportWidth + 1);
    expect(narrowGeometry.bodyHorizontalOverflow).toBeLessThanOrEqual(1);
    expect(narrowGeometry.primaryVisible).toBe(true);
    await main.screenshot({
      path: path.join(imageDir, "daily-plan-narrow-dark.png"),
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "关闭今日规划" }).click();

    const floating = await windowFor(app, "floating");
    await floating.getByRole("button", { name: /展开/u }).click();
    await floating.getByRole("button", { name: "今天", exact: true }).click();
    const compactEntry = floating.locator(".mini-daily-plan-entry");
    await expect(compactEntry).toContainText("今天先做什么？");
    await compactEntry.getByRole("button", { name: "安排" }).click();
    await expect(main.getByRole("dialog", { name: "一起排今天" })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(profilePath, { recursive: true, force: true });
  }
});
