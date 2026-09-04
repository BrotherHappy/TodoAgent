import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "playwright/test";

const projectRoot = path.resolve(import.meta.dirname, "../..");

import { waitForElectronWindow } from '../helpers/electron-window';
async function mainWindow(app: ElectronApplication): Promise<Page> {
  return waitForElectronWindow(app, 'main');
}

test("plans a task on the local timeline without changing its Feishu due date", async () => {
  const profilePath = await mkdtemp(path.join(os.tmpdir(), "todo-agent-timeline-"));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [projectRoot, `--user-data-dir=${profilePath}`],
      cwd: projectRoot,
      env: { ...process.env, TODO_AGENT_E2E: "1", TODO_AGENT_E2E_BACKGROUND: "1" },
    });
    const main = await mainWindow(app);
    await main.waitForLoadState("domcontentloaded");
    const skip = main.getByRole("button", { name: "跳过并使用本地任务" });
    if (await skip.isVisible().catch(() => false)) await skip.click();

    const fixture = await main.evaluate(async () => {
      const api = window.desktopApi;
      if (!api) throw new Error("Desktop API is unavailable");
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const dueAt = new Date(now.getTime() + 6 * 60 * 60_000).toISOString();
      const created = await api.tasks.create({
        title: "时间线拖放验收",
        source: { type: "feishu", accountId: "timeline-e2e" },
        projectId: "时间线验收项目",
        plannedDate: day,
        dueAt,
        estimatedMinutes: 60,
      });
      return { id: created.task.id, day, dueAt };
    });

    await main.getByRole("button", { name: "时间线", exact: true }).click();
    await expect(main.getByRole("heading", { name: "时间线" })).toBeVisible();
    const card = main.getByRole("button", { name: /时间线拖放验收/u });
    await expect(card).toBeVisible();
    const slot = main.locator('[data-slot-minute="600"]');
    // Playwright's native drag helper can scroll the source tray out from
    // under the target in a long timeline. Dispatch the same browser events
    // explicitly so the test verifies React's real drag/drop handlers.
    await card.evaluate((element, minute) => {
      const target = document.querySelector<HTMLElement>(`[data-slot-minute="${minute}"]`);
      if (!target) throw new Error("Timeline target slot is missing");
      const dataTransfer = new DataTransfer();
      element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
      element.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    }, 600);
    await expect(main.getByText(/已安排 1 项/u)).toBeVisible();

    const updated = await main.evaluate(async (taskId) => window.desktopApi!.tasks.get(taskId, true), fixture.id);
    expect(updated?.plannedDate).toBe(fixture.day);
    expect(updated?.dueAt).toBe(fixture.dueAt);
    expect(updated?.timeBlock?.startAt).toBeTruthy();
    expect(new Date(updated!.timeBlock!.startAt).getHours()).toBe(10);

    await main.getByRole("button", { name: "周", exact: true }).click();
    await expect(main.getByRole("heading", { name: "工作周期" })).toBeVisible();
    await expect(main.getByText(/只读容量预测/u)).toBeVisible();
    await expect(main.getByText(/已安排容量/u)).toBeVisible();
    await expect(main.getByText(/有时间/u)).toBeVisible();
    await expect(main.getByText("本周回顾")).toBeVisible();
    await expect(main.getByText("完成任务")).toBeVisible();
    await expect(main.getByText("项目健康")).toBeVisible();
    await expect(main.getByText("时间线验收项目", { exact: true })).toBeVisible();
    await expect(main.getByText(/本周计划负载/u)).toBeVisible();
    await main.getByLabel("时间线视图").getByRole("button", { name: "项目", exact: true }).click();
    await expect(main.getByText("项目看板", { exact: true })).toBeVisible();
    await expect(main.getByRole("combobox", { name: "看板项目" })).toHaveValue("all");
    await expect(
      main.getByRole("button", { name: "完成时间线拖放验收", exact: true }),
    ).toBeVisible();
    await main.getByRole("button", { name: "完成时间线拖放验收", exact: true }).click();
    await expect(
      main.getByRole("button", { name: "重新打开时间线拖放验收", exact: true }),
    ).toBeVisible();
    await main.getByRole("button", { name: "重新打开时间线拖放验收", exact: true }).click();
    await main.getByRole("button", { name: "日", exact: true }).click();

    await main.getByRole("button", { name: /^全部任务/u }).click();
    await main.getByRole("button", { name: "筛选" }).click();
    const filterDialog = main.getByRole("dialog", { name: "任务筛选" });
    await filterDialog.locator("#smart-view-name").fill("本地验收视图");
    await filterDialog.getByRole("button", { name: "保存", exact: true }).click();
    const savedViewButton = main.locator(".saved-view-strip button", { hasText: "本地验收视图" });
    await expect(savedViewButton).toBeVisible();
    await savedViewButton.click();
    await main.getByRole("button", { name: "筛选" }).click();
    await expect(main.getByRole("button", { name: "删除视图本地验收视图" })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(profilePath, { recursive: true, force: true });
  }
});
