import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
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

async function launch(profilePath: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath as unknown as string,
    args: [projectRoot, `--user-data-dir=${profilePath}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      TODO_AGENT_E2E: "1",
      TODO_AGENT_E2E_BACKGROUND: "1",
    },
  });
}

async function windowFor(
  app: ElectronApplication,
  kind: "main" | "floating",
): Promise<Page> {
  const existing = app
    .windows()
    .find((page) => new URL(page.url()).searchParams.get("window") === kind);
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

async function finishOnboarding(page: Page): Promise<void> {
  const skip = page.getByRole("button", { name: "跳过并使用本地任务" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
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

async function startLongMarkdownServer(): Promise<{
  endpoint: string;
  close(): Promise<void>;
}> {
  const responseText = [
    "## 任务视觉验收结果",
    "",
    "下面是一段用于验证窄窗口、长内容和 Markdown 横向滚动的隔离模拟回答：",
    "",
    ...Array.from({ length: 26 }, (_, index) => `- 可滚动建议 ${index + 1}：保持一项可执行的下一步。`),
    "",
    "| 字段 | 说明 |",
    "| --- | --- |",
    `| 很长字段 | ${"unbroken-markdown-value-".repeat(12)} |`,
    "",
    "```text",
    "very-long-code-line-without-breaks-abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789",
    "```",
  ].join("\n");
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the OpenAI-compatible request before emitting the stream.
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(
      `data: ${JSON.stringify({
        id: "visual-audit-stream",
        choices: [{ delta: { role: "assistant", content: responseText }, finish_reason: "stop" }],
      })}\n\n`,
    );
    // The desktop runtime requires a final usage event before it accepts a
    // streamed run as successful; match an OpenAI-compatible provider here.
    response.write(
      `data: ${JSON.stringify({
        id: "visual-audit-stream",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 180, total_tokens: 192 },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Visual audit model server did not bind a port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("keeps isolated desktop surfaces navigable, scrollable and unobstructed", async ({}, testInfo) => {
  const profilePath = await mkdtemp(path.join(os.tmpdir(), "todo-agent-visual-audit-"));
  const imageDir = testInfo.outputPath("screens");
  await mkdir(imageDir, { recursive: true });
  const model = await startLongMarkdownServer();
  let app: ElectronApplication | undefined;
  try {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    await resizeMain(app, 1180, 760);

    const nav = main.getByRole("navigation", { name: "主导航" });
    await expect(nav).toBeVisible();
    await main.getByRole("button", { name: "新建", exact: true }).click();
    const title = `隔离视觉验收-${"中英混排 Long title ".repeat(8)}`;
    await main.locator("#new-title").fill(title);
    await main.locator("#new-notes").fill("这是一段用于检查详情区滚动与长备注折行的隔离数据。\n".repeat(10));
    await main.getByRole("button", { name: "保存到本地" }).click();
    const row = main.locator(".task-row", { hasText: title });
    await expect(row).toBeVisible();
    await main.screenshot({ path: path.join(imageDir, "main-light.png") });

    await row.locator(".task-body").click();
    const inspector = main.getByRole("complementary", { name: "任务详情" });
    await expect(inspector).toBeVisible();
    await inspector.screenshot({ path: path.join(imageDir, "inspector-light.png") });

    // An inspector save leaves a toast on screen. Its wrapper must not capture
    // pointer input, including when it visually overlaps the lower detail area.
    const taskTitle = main.getByLabel("任务标题", { exact: true });
    await taskTitle.fill(`${title} 已编辑`);
    await taskTitle.press("Tab");
    const toast = main.locator(".toast").last();
    await expect(toast).toContainText("更改已保存");
    const toastGeometry = await main.evaluate(() => {
      const stack = document.querySelector<HTMLElement>(".toast-stack");
      const item = document.querySelector<HTMLElement>(".toast:last-child");
      if (!stack || !item) throw new Error("Toast is missing");
      const overlap = (first: DOMRect, second: DOMRect) =>
        Math.max(first.left, second.left) < Math.min(first.right, second.right) &&
        Math.max(first.top, second.top) < Math.min(first.bottom, second.bottom);
      const toastRect = item.getBoundingClientRect();
      const coveredControls = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".inspector input, .inspector textarea, .inspector select, .inspector button",
        ),
      )
        .filter((control) => overlap(toastRect, control.getBoundingClientRect()))
        .map(
          (control) =>
            control.getAttribute("aria-label") ||
            control.getAttribute("id") ||
            control.textContent?.trim() ||
            control.tagName,
        );
      return {
        stackPointerEvents: getComputedStyle(stack).pointerEvents,
        toastPointerEvents: getComputedStyle(item).pointerEvents,
        coveredControls,
      };
    });
    expect(toastGeometry.stackPointerEvents).toBe("none");
    // The body of a non-action toast inherits the stack's transparent hit testing.
    expect(toastGeometry.toastPointerEvents).toBe("none");
    expect(toastGeometry.coveredControls).toEqual([]);
    await main.screenshot({ path: path.join(imageDir, "toast-inspector.png") });

    await resizeMain(app, 980, 700);
    await expect(inspector).toBeVisible();
    const compactLayout = await main.evaluate(() => {
      const navRect = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
      const inspectorRect = document.querySelector<HTMLElement>(".inspector")?.getBoundingClientRect();
      if (!navRect || !inspectorRect) throw new Error("Compact layout missing navigation or inspector");
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        navRight: navRect.right,
        inspectorLeft: inspectorRect.left,
      };
    });
    expect(compactLayout.documentWidth).toBeLessThanOrEqual(compactLayout.viewportWidth + 1);
    expect(compactLayout.inspectorLeft).toBeGreaterThanOrEqual(compactLayout.navRight - 1);
    await main.screenshot({ path: path.join(imageDir, "main-compact-inspector.png") });

    await resizeMain(app, 760, 600);
    await main.getByLabel("关闭任务详情").click();
    const narrowLayout = await main.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      navOverflow: (() => {
        const navigation = document.querySelector<HTMLElement>(".sidebar");
        return Boolean(navigation && navigation.scrollWidth > navigation.clientWidth);
      })(),
      titleSearchVisible: Boolean(document.querySelector<HTMLElement>(".title-search")),
      titlebar: (() => {
        const bar = document.querySelector<HTMLElement>(".app-titlebar");
        const brand = document.querySelector<HTMLElement>(".app-brand");
        if (!bar || !brand) return { visible: false, brandInside: false };
        const barRect = bar.getBoundingClientRect();
        const brandRect = brand.getBoundingClientRect();
        return {
          visible: barRect.top >= -1 && barRect.bottom > 0 && brandRect.width > 0,
          brandInside:
            brandRect.top >= barRect.top - 1 &&
            brandRect.bottom <= barRect.bottom + 1 &&
            brandRect.right > 0 &&
            brandRect.left < innerWidth,
        };
      })(),
    }));
    expect(narrowLayout.documentWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth + 1);
    expect(narrowLayout.navOverflow).toBe(false);
    expect(narrowLayout.titleSearchVisible).toBe(true);
    expect(narrowLayout.titlebar.visible).toBe(true);
    expect(narrowLayout.titlebar.brandInside).toBe(true);
    await main.screenshot({ path: path.join(imageDir, "main-narrow-760.png") });

    // Main navigation must remain usable while switching between Agent and Settings.
    await nav.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(main.getByRole("heading", { name: "任务助理" })).toBeVisible();
    // A confirmation produced in task details must not follow the user into
    // another workspace and cover a live Agent/Settings control.
    await expect(main.locator(".toast")).toHaveCount(0);
    await main.evaluate(async (endpoint) => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        ai: {
          ...settings.ai,
          enabled: true,
          endpoint,
          model: "visual-audit-model",
          authMode: "none",
        },
      });
    }, model.endpoint);
    await main.getByLabel("给 Agent 发消息").fill("请用 Markdown 给出长一些的验收建议");
    await main.getByRole("button", { name: "发送", exact: true }).click();
    await expect(main.getByText("任务视觉验收结果", { exact: true })).toBeVisible();
    const agentOverflow = await main.locator(".agent-layout").evaluate((element) => {
      const layout = element as HTMLElement;
      const thread = layout.querySelector<HTMLElement>(".agent-thread");
      const markdown = layout.querySelector<HTMLElement>(".agent-markdown");
      const table = layout.querySelector<HTMLElement>(".agent-markdown table");
      const pre = layout.querySelector<HTMLElement>(".agent-markdown pre");
      return {
        layoutOverflow: layout.scrollWidth > layout.clientWidth,
        layoutScrollable: layout.scrollHeight > layout.clientHeight,
        threadScrollable: Boolean(thread && thread.scrollHeight > thread.clientHeight),
        markdownOverflow: Boolean(markdown && markdown.scrollWidth > markdown.clientWidth),
        tableScrollable: Boolean(table && table.scrollWidth > table.clientWidth),
        preScrollable: Boolean(pre && pre.scrollWidth > pre.clientWidth),
      };
    });
    expect(agentOverflow.layoutOverflow).toBe(false);
    expect(agentOverflow.threadScrollable || agentOverflow.layoutScrollable).toBe(true);
    expect(agentOverflow.markdownOverflow).toBe(false);
    expect(agentOverflow.preScrollable).toBe(true);
    await main.screenshot({ path: path.join(imageDir, "agent-long-markdown.png") });

    await nav.getByRole("button", { name: "设置", exact: true }).click();
    await expect(main.getByRole("heading", { name: "通用" })).toBeVisible();
    await expect(main.locator(".toast")).toHaveCount(0);
    await main.getByRole("navigation", { name: "设置导航" }).getByRole("button", { name: "Todo Pet", exact: true }).click();
    await main.screenshot({ path: path.join(imageDir, "settings-floating.png") });

    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");
    await floating.getByRole("button", { name: "展开 小序" }).click();
    await expect(floating.locator(".mini-panel")).toBeVisible();
    await floating.getByRole("button", { name: "聊聊", exact: true }).click();
    const miniText = floating.getByLabel("给 Agent 发消息");
    await miniText.fill("请同样用 Markdown 总结");
    await miniText.press("Enter");
    await expect(floating.getByText("任务视觉验收结果", { exact: true })).toBeVisible();
    const miniOverflow = await floating.locator(".mini-content").evaluate((element) => {
      const content = element as HTMLElement;
      const markdown = content.querySelector<HTMLElement>(".agent-markdown");
      const pre = content.querySelector<HTMLElement>(".agent-markdown pre");
      const tableScroll = content.querySelector<HTMLElement>(
        ".agent-markdown-table-scroll",
      );
      const firstDataCell = content.querySelector<HTMLElement>(
        ".agent-markdown-table-scroll tbody td:first-child",
      );
      return {
        scrollable: content.scrollHeight > content.clientHeight,
        contentOverflowX: content.scrollWidth > content.clientWidth,
        markdownOverflowX: Boolean(markdown && markdown.scrollWidth > markdown.clientWidth),
        preScrollable: Boolean(pre && pre.scrollWidth > pre.clientWidth),
        tableScrollable: Boolean(
          tableScroll && tableScroll.scrollWidth > tableScroll.clientWidth,
        ),
        firstDataCellHeight: firstDataCell?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(miniOverflow.scrollable).toBe(true);
    expect(miniOverflow.contentOverflowX).toBe(false);
    expect(miniOverflow.markdownOverflowX).toBe(false);
    expect(miniOverflow.preScrollable).toBe(true);
    expect(miniOverflow.tableScrollable).toBe(true);
    expect(miniOverflow.firstDataCellHeight).toBeLessThan(60);
    await floating.screenshot({ path: path.join(imageDir, "floating-agent-long-markdown.png") });

    const media = {
      media: "",
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-transparency", value: "reduce" },
      ],
    };
    await (await main.context().newCDPSession(main)).send("Emulation.setEmulatedMedia", media);
    await (await floating.context().newCDPSession(floating)).send("Emulation.setEmulatedMedia", media);
    await main.screenshot({ path: path.join(imageDir, "settings-dark-reduced-transparency.png") });
    await floating.screenshot({ path: path.join(imageDir, "floating-dark-reduced-transparency.png") });
  } finally {
    await app?.close().catch(() => undefined);
    await model.close().catch(() => undefined);
    await rm(profilePath, { recursive: true, force: true });
  }
});
