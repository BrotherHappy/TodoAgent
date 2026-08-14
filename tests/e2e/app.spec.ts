import { mkdtemp, rm } from "node:fs/promises";
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
      ELECTRON_DISABLE_SECURITY_WARNINGS: "false",
      TODO_AGENT_E2E: "1",
    },
  });
}

async function windowFor(
  app: ElectronApplication,
  kind: "main" | "quick" | "floating",
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

async function expectSingleMainShell(page: Page): Promise<void> {
  await expect(page.locator(".app-background")).toHaveCount(1);
  await expect(page.locator(".app-window")).toHaveCount(1);
  await expect(page.locator(".app-background .app-background")).toHaveCount(0);
  await expect(page.locator(".app-window .app-window")).toHaveCount(0);
  await expect(page.locator(".app-window > .app-titlebar")).toHaveCount(1);
  await expect(page.locator(".traffic-lights span")).toHaveCount(0);

  const frame = await page.evaluate(() => {
    const background = document.querySelector<HTMLElement>(".app-background");
    const windowFrame = document.querySelector<HTMLElement>(".app-window");
    if (!background || !windowFrame) throw new Error("Main shell is missing");
    const backgroundRect = background.getBoundingClientRect();
    const windowRect = windowFrame.getBoundingClientRect();
    const backgroundStyle = getComputedStyle(background);
    const windowStyle = getComputedStyle(windowFrame);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      backgroundRect: {
        x: backgroundRect.x,
        y: backgroundRect.y,
        width: backgroundRect.width,
        height: backgroundRect.height,
      },
      gaps: {
        top: windowRect.top - backgroundRect.top,
        right: backgroundRect.right - windowRect.right,
        bottom: backgroundRect.bottom - windowRect.bottom,
        left: windowRect.left - backgroundRect.left,
      },
      padding: [
        backgroundStyle.paddingTop,
        backgroundStyle.paddingRight,
        backgroundStyle.paddingBottom,
        backgroundStyle.paddingLeft,
      ],
      radius: windowStyle.borderTopLeftRadius,
      borders: [
        windowStyle.borderTopWidth,
        windowStyle.borderRightWidth,
        windowStyle.borderBottomWidth,
        windowStyle.borderLeftWidth,
      ],
    };
  });
  expect(frame.backgroundRect).toEqual({
    x: 0,
    y: 0,
    width: frame.viewport.width,
    height: frame.viewport.height,
  });
  expect(frame.padding).toEqual(["0px", "0px", "0px", "0px"]);
  expect(frame.radius).toBe("0px");
  expect(frame.borders).toEqual(["0px", "0px", "0px", "0px"]);
  for (const gap of Object.values(frame.gaps)) expect(Math.abs(gap)).toBeLessThan(1);
}

async function floatingWindowState(app: ElectronApplication): Promise<{
  alwaysOnTop: boolean;
  movable: boolean;
  bounds: { width: number; height: number };
  position: { x: number; y: number };
}> {
  return app.evaluate(({ BrowserWindow }) => {
    const floating = BrowserWindow.getAllWindows().find((window) => {
      try {
        return new URL(window.webContents.getURL()).searchParams.get("window") === "floating";
      } catch {
        return false;
      }
    });
    if (!floating) throw new Error("Floating window is missing");
    const bounds = floating.getBounds();
    return {
      alwaysOnTop: floating.isAlwaysOnTop(),
      movable: floating.isMovable(),
      bounds: { width: bounds.width, height: bounds.height },
      position: { x: bounds.x, y: bounds.y },
    };
  });
}

async function resizeMainWindow(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<{ width: number; height: number }> {
  return app.evaluate(
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
      const bounds = main.getBounds();
      return { width: bounds.width, height: bounds.height };
    },
    { width, height },
  );
}

async function layoutOverflow(page: Page): Promise<{
  viewportWidth: number;
  documentWidth: number;
  titlebarRight: number;
  searchRight?: number;
  searchWidth?: number;
  contentScrollWidth?: number;
  contentClientWidth?: number;
  inspectorLeft?: number;
  sidebarRight?: number;
}> {
  return page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const titlebar = rect(".app-titlebar");
    const search = rect(".title-search");
    const content = document.querySelector<HTMLElement>(".content-column");
    const inspector = rect(".inspector:not(.inspector-empty)");
    const sidebar = rect(".sidebar");
    if (!titlebar) throw new Error("Title bar is missing");
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      titlebarRight: titlebar.right,
      searchRight: search?.right,
      searchWidth: search?.width,
      contentScrollWidth: content?.scrollWidth,
      contentClientWidth: content?.clientWidth,
      inspectorLeft: inspector?.left,
      sidebarRight: sidebar?.right,
    };
  });
}

function cssAlpha(color: string): number {
  const rgba = color.match(/^rgba?\(([^)]+)\)$/u)?.[1];
  if (!rgba) return 1;
  if (rgba.includes("/")) {
    return Number(rgba.split("/").at(-1)?.trim() ?? 1);
  }
  const channels = rgba.split(",").map((part) => part.trim());
  return channels.length === 4 ? Number(channels[3]) : 1;
}

async function startStreamingModelServer(): Promise<{
  endpoint: string;
  firstChunk: Promise<void>;
  releaseFinal(): void;
  close(): Promise<void>;
}> {
  let firstChunkResolved = false;
  let resolveFirstChunk!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirstChunk = resolve;
  });
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  let requestNumber = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before responding, matching an OpenAI-compatible API.
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    requestNumber += 1;
    if (requestNumber === 1) {
      const argumentsJson = JSON.stringify({
        title: "浮窗 Agent 创建的任务",
        notes: "",
        source: "local",
        projectId: null,
        listId: null,
        plannedDate: new Date().toLocaleDateString("en-CA"),
        startAt: null,
        dueAt: null,
        priority: "medium",
        tags: ["浮窗验收"],
      });
      response.write(
        `data: ${JSON.stringify({
          id: "floating-tool-stream",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "floating-create-call",
                    type: "function",
                    function: {
                      name: "task_create",
                      arguments: argumentsJson,
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "floating-tool-stream",
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(
      `data: ${JSON.stringify({
        id: "floating-stream",
        choices: [
          { delta: { role: "assistant", content: "## 浮窗实时回答" } },
        ],
      })}\n\n`,
    );
    if (!firstChunkResolved) {
      firstChunkResolved = true;
      resolveFirstChunk();
    }
    await finalGate;
    const longList = Array.from(
      { length: 36 },
      (_, index) => `- 可滚动任务建议 ${index + 1}`,
    ).join("\n");
    const wideMarkdown = [
      "| 任务字段 | 当前值 | 说明 |",
      "| --- | --- | --- |",
      `| 长中英文内容 | ${"unbroken-long-markdown-value-".repeat(8)} | 仅表格内部横向滚动 |`,
      "",
      "```text",
      "very-long-code-line-without-breaks-abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789",
      "```",
    ].join("\n");
    response.write(
      `data: ${JSON.stringify({
        id: "floating-stream",
        choices: [
          {
            delta: { content: `\n\n${longList}\n\n${wideMarkdown}` },
            finish_reason: "stop",
          },
        ],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "floating-stream",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 80, total_tokens: 84 },
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
    throw new Error("Streaming model server did not bind a TCP port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    firstChunk,
    releaseFinal,
    close: async () => {
      releaseFinal();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.describe("Todo Agent desktop shell", () => {
  let profilePath: string;
  let app: ElectronApplication | undefined;

  test.beforeEach(async () => {
    profilePath = await mkdtemp(path.join(os.tmpdir(), "todo-agent-e2e-"));
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
    await rm(profilePath, { recursive: true, force: true });
  });

  test("keeps navigation available across Agent and Settings without a nested window shell", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const navigation = main.getByRole("navigation", { name: "主导航" });
    const today = navigation.getByRole("button", { name: /今天/u });
    const agent = navigation.getByRole("button", { name: "Agent", exact: true });
    const settings = navigation.getByRole("button", {
      name: "设置",
      exact: true,
    });

    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
    await expect(today).toHaveClass(/active/u);
    await expectSingleMainShell(main);

    await agent.click();
    await expect(main.getByRole("heading", { name: "任务助理" })).toBeVisible();
    await expect(agent).toHaveClass(/active/u);
    const agentInput = main.getByLabel("给 Agent 发消息");
    await agentInput.fill("跨页面保留的草稿");
    await expectSingleMainShell(main);

    await settings.click();
    await expect(
      main.getByRole("navigation", { name: "设置导航" }),
    ).toBeVisible();
    await expect(main.getByRole("heading", { name: "通用" })).toBeVisible();
    await expect(settings).toHaveClass(/active/u);
    await expectSingleMainShell(main);

    await main.getByRole("button", { name: "返回上一页" }).click();
    await expect(main.getByRole("heading", { name: "任务助理" })).toBeVisible();
    await expect(agentInput).toHaveValue("跨页面保留的草稿");

    await today.click();
    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
    await expect(today).toHaveClass(/active/u);

    await settings.click();
    await expect(main.getByRole("heading", { name: "通用" })).toBeVisible();
    await main.getByRole("button", { name: "返回上一页" }).click();
    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
  });

  test("keeps every primary destination reachable from the persistent main navigation", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const navigation = main.getByRole("navigation", { name: "主导航" });
    const destinations: Array<{
      label: string;
      heading: string | RegExp;
    }> = [
      { label: "暂存", heading: "暂存" },
      { label: "今天", heading: /今天有/u },
      { label: "即将到来", heading: "即将到来" },
      { label: "全部任务", heading: "全部任务" },
      { label: "已完成", heading: "已完成" },
      { label: "回收站", heading: "回收站" },
      { label: "同步问题", heading: "飞书连接与同步" },
      { label: "Agent", heading: "任务助理" },
      { label: "动态", heading: "动态与审计" },
      { label: "设置", heading: "通用" },
    ];

    for (const destination of destinations) {
      const button = navigation.getByRole("button", {
        name: destination.label,
        exact: true,
      });
      await button.click();
      const heading =
        typeof destination.heading === "string"
          ? main.getByRole("heading", {
              name: destination.heading,
              exact: true,
            })
          : main.getByRole("heading", { name: destination.heading });
      await expect(
        heading,
      ).toBeVisible();
      await expect(button).toHaveClass(/active/u);
      await expectSingleMainShell(main);
    }

    for (const source of ["本地", "飞书"] as const) {
      const button = navigation.getByRole("button", { name: source, exact: true });
      await button.click();
      await expect(main.getByRole("heading", { name: "全部任务" })).toBeVisible();
      await expect(button).toHaveClass(/active/u);
      await expectSingleMainShell(main);
    }
  });

  test("clears a stale task search when explicit navigation opens a task collection", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const navigation = main.getByRole("navigation", { name: "主导航" });
    const openTitle = "验收-导航搜索清理-待办";
    const completedTitle = "验收-导航搜索清理-已完成";
    const unmatchedSearch = "绝无命中-导航搜索清理";
    const createLocal = async (title: string) => {
      await main.getByRole("button", { name: "新建", exact: true }).click();
      await main.locator("#new-title").fill(title);
      await main.getByRole("button", { name: "保存到本地" }).click();
      await expect(main.locator(".task-row", { hasText: title })).toBeVisible();
    };

    await createLocal(openTitle);
    await createLocal(completedTitle);
    await main.getByLabel(`完成${completedTitle}`).click();
    await expect(
      navigation.getByRole("button", { name: /已完成.*1/u }),
    ).toBeVisible();

    await navigation.getByRole("button", { name: /全部任务/u }).click();
    const search = main.getByLabel("搜索任务");
    const searchSummary = main.locator(".page-heading p");
    await expect(main.locator(".task-row", { hasText: openTitle })).toBeVisible();
    await search.fill(unmatchedSearch);
    await expect(searchSummary).toHaveText(`“${unmatchedSearch}”的搜索结果`);
    await expect(main.locator(".task-row")).toHaveCount(0);

    // Navigating to a collection is an explicit request to see that collection,
    // so an old search must not leave its sidebar count visible but its rows
    // hidden. The expected completed task proves the filter was cleared.
    const completedNav = navigation.getByRole("button", { name: /已完成/u });
    await completedNav.click();
    await expect(search).toHaveValue("");
    await expect(searchSummary).toHaveText("你的任务保持本地优先");
    await expect(
      main.locator(".task-row", { hasText: completedTitle }),
    ).toBeVisible();

    // Re-selecting the current collection must also clear the query. This
    // catches the navigation fast-path that otherwise treats it as a no-op.
    await search.fill(unmatchedSearch);
    await expect(searchSummary).toHaveText(`“${unmatchedSearch}”的搜索结果`);
    await expect(main.locator(".task-row")).toHaveCount(0);
    await completedNav.click();
    await expect(search).toHaveValue("");
    await expect(searchSummary).toHaveText("你的任务保持本地优先");
    await expect(
      main.locator(".task-row", { hasText: completedTitle }),
    ).toBeVisible();

    // Source navigation is another explicit collection entry point. It must
    // clear the same stale query before showing the local open-task list.
    await navigation.getByRole("button", { name: /全部任务/u }).click();
    await search.fill(unmatchedSearch);
    await expect(searchSummary).toHaveText(`“${unmatchedSearch}”的搜索结果`);
    await navigation.getByRole("button", { name: /本地/u }).click();
    await expect(main.getByRole("heading", { name: "全部任务" })).toBeVisible();
    await expect(search).toHaveValue("");
    await expect(searchSummary).toHaveText("你的任务保持本地优先");
    await expect(main.locator(".task-row", { hasText: openTitle })).toBeVisible();
  });

  test("keeps search, task details, and direct navigation usable at every supported desktop size", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const longTitle = `验收-响应式中英文任务-${"中文 English mixed title ".repeat(12)}`;
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(longTitle);
    await main.getByRole("button", { name: "保存到本地" }).click();
    const row = main.locator(".task-row", { hasText: longTitle });
    await expect(row).toBeVisible();

    for (const size of [
      { width: 1180, height: 760 },
      { width: 980, height: 700 },
      { width: 760, height: 600 },
    ]) {
      expect(await resizeMainWindow(app, size.width, size.height)).toEqual(size);
      await expect.poll(() => main.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(
        size.width - 2,
      );
      const search = main.getByLabel("搜索任务");
      await expect(search).toBeVisible();
      const layout = await layoutOverflow(main);
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
      expect(layout.searchRight).toBeLessThanOrEqual(layout.titlebarRight + 1);
      expect(layout.searchWidth).toBeGreaterThanOrEqual(120);
      expect(layout.contentScrollWidth).toBeLessThanOrEqual(
        (layout.contentClientWidth ?? 0) + 1,
      );
    }

    // At the two compact desktop widths, details are a closeable overlay rather
    // than a second half-height pane. It must not cover the persistent nav.
    await resizeMainWindow(app, 980, 700);
    await row.locator(".task-body").click();
    const inspector = main.getByRole("complementary", { name: "任务详情" });
    await expect(inspector).toBeVisible();
    const desktopOverlay = await layoutOverflow(main);
    expect(desktopOverlay.inspectorLeft).toBeGreaterThanOrEqual(
      (desktopOverlay.sidebarRight ?? 0) - 1,
    );

    await resizeMainWindow(app, 760, 600);
    const closeDetails = main.getByLabel("关闭任务详情");
    await expect(closeDetails).toBeVisible();
    await closeDetails.click();
    await expect(main.locator(".inspector:not(.inspector-empty)")).toHaveCount(0);
    await main.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await expect(main.getByLabel("搜索任务")).toBeFocused();

    const navigation = main.getByRole("navigation", { name: "主导航" });
    await navigation.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(main.getByRole("heading", { name: "任务助理" })).toBeVisible();
    const agentLayout = await main.locator(".agent-layout").evaluate((element) => {
      const layout = element as HTMLElement;
      return { scrollWidth: layout.scrollWidth, clientWidth: layout.clientWidth };
    });
    expect(agentLayout.scrollWidth).toBeLessThanOrEqual(agentLayout.clientWidth + 1);

    await navigation.getByRole("button", { name: "设置", exact: true }).click();
    await expect(main.getByRole("heading", { name: "通用" })).toBeVisible();
    const settingsLayout = await main.locator(".settings-layout").evaluate((element) => {
      const layout = element as HTMLElement;
      return { scrollWidth: layout.scrollWidth, clientWidth: layout.clientWidth };
    });
    expect(settingsLayout.scrollWidth).toBeLessThanOrEqual(
      settingsLayout.clientWidth + 1,
    );
  });

  test("keeps main and floating surfaces readable in dark reduced-transparency mode", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    const media = {
      media: "",
      features: [
        { name: "prefers-color-scheme", value: "dark" },
        { name: "prefers-reduced-transparency", value: "reduce" },
      ],
    };
    await (await main.context().newCDPSession(main)).send(
      "Emulation.setEmulatedMedia",
      media,
    );
    // Electron creates a separate renderer for the floating window. The
    // operating-system preference reaches both in production, so emulate it
    // in both isolated renderers here as well.
    await (await floating.context().newCDPSession(floating)).send(
      "Emulation.setEmulatedMedia",
      media,
    );
    await expect
      .poll(() =>
        main.evaluate(() => ({
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
          reducedTransparency: matchMedia(
            "(prefers-reduced-transparency: reduce)",
          ).matches,
        })),
      )
      .toEqual({ dark: true, reducedTransparency: true });
    await expect
      .poll(() =>
        floating.evaluate(() => ({
          dark: matchMedia("(prefers-color-scheme: dark)").matches,
          reducedTransparency: matchMedia(
            "(prefers-reduced-transparency: reduce)",
          ).matches,
        })),
      )
      .toEqual({ dark: true, reducedTransparency: true });

    const mainVisual = await main.locator(".app-window").evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, backdrop: style.backdropFilter };
    });
    const capsuleVisual = await floating
      .locator(".pet-compact")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, backdrop: style.backdropFilter };
      });
    expect(cssAlpha(mainVisual.background)).toBeGreaterThanOrEqual(0.99);
    expect(mainVisual.backdrop).toBe("none");
    // Transparent Electron windows may quantize a fully opaque CSS surface
    // to 0.996 in computed style. 0.99 still catches the normal 0.985
    // floating glass while allowing that platform compositing detail.
    expect(cssAlpha(capsuleVisual.background)).toBeGreaterThanOrEqual(0.99);
    expect(capsuleVisual.backdrop).toBe("none");
  });

  test("keeps Todo Pet always on top, readable, and scalable", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    await expect.poll(async () => (await floatingWindowState(app!)).alwaysOnTop).toBe(true);
    const pet = floating.locator(".pet-compact");
    const petVisual = await pet.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        width: bounds.width,
        height: bounds.height,
      };
    });
    expect(cssAlpha(petVisual.background)).toBeGreaterThanOrEqual(0.98);
    expect(petVisual.borderWidth).toBe("1px");
    expect(petVisual.boxShadow).not.toBe("none");
    expect(petVisual.height).toBeGreaterThanOrEqual(100);
    await expect(floating.locator(".pet-character")).toBeVisible();
    await expect(floating.locator(".floating-drag-handle")).toBeVisible();
    expect(
      await pet.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("drag");
    expect(
      await floating.locator(".floating-drag-handle").evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("drag");
    expect((await floatingWindowState(app)).movable).toBe(true);

    await floating
      .getByRole("button", { name: "展开 小序" })
      .click();
    const panel = floating.locator(".mini-panel");
    await expect(panel).toBeVisible();
    const panelBackground = await panel.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(cssAlpha(panelBackground)).toBeGreaterThanOrEqual(0.95);
    await expect.poll(async () => (await floatingWindowState(app!)).alwaysOnTop).toBe(true);

    await floating
      .getByRole("button", { name: "收起 小序" })
      .click();
    const normalized = await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      return window.desktopApi!.settings.replace({
        ...settings,
        floating: {
          ...settings.floating,
          scalePercent: 75,
          topMode: "never",
        },
      });
    });
    expect(normalized.floating.topMode).toBe("always");
    await expect(floating.locator(".floating-shell.is-compact")).toBeVisible();
    await expect.poll(async () => (await floatingWindowState(app!)).alwaysOnTop).toBe(true);
    await expect
      .poll(async () => (await floatingWindowState(app!)).bounds)
      .toEqual({ width: 308, height: 87 });

    const scaledVisual = await pet.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        width: bounds.width,
        height: bounds.height,
      };
    });
    expect(cssAlpha(scaledVisual.background)).toBeGreaterThanOrEqual(0.98);
    expect(scaledVisual.borderWidth).toBe("1px");
    expect(scaledVisual.boxShadow).not.toBe("none");
    expect(scaledVisual.width).toBeGreaterThanOrEqual(290);
    expect(scaledVisual.height).toBeGreaterThanOrEqual(70);
  });

  test("keeps Todo Pet available after the main window closes and reopens the remembered task page", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    // This is the same BrowserWindow close path as the native close control.
    // The default close-to-tray policy should hide only the main window, not
    // remove the persistent floating entry.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        try {
          return (
            new URL(candidate.webContents.getURL()).searchParams.get("window") ===
            "main"
          );
        } catch {
          return false;
        }
      });
      if (!window) throw new Error("Main window is missing");
      window.close();
    });
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main" && candidate.isVisible()
              );
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(false);
    await expect.poll(async () => (await floatingWindowState(app!)).alwaysOnTop).toBe(true);

    await floating
      .getByRole("button", { name: "展开 小序" })
      .click();
    await floating.getByRole("button", { name: "打开主窗口" }).click();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main" && candidate.isVisible()
              );
            } catch {
              return false;
            }
          }),
        ),
      )
      .toBe(true);
    await expect(main.getByRole("heading", { name: "全部任务" })).toBeVisible();
  });

  test("opens the floating panel on all tasks and remembers the chosen tab", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    // A future task belongs to the all-task overview but not Today. This
    // proves the new initial tab is backed by the main `all` view rather than
    // merely a renamed Today list.
    const futureTitle = "悬浮全部任务验收-未来任务";
    await main.evaluate(async (title) => {
      await window.desktopApi!.tasks.create({
        title,
        plannedDate: "2099-01-01",
        source: { type: "local" },
      });
    }, futureTitle);

    await floating
      .getByRole("button", { name: "展开 小序" })
      .click();
    const allTasks = floating.getByRole("button", {
      name: "全部",
      exact: true,
    });
    const todayTasks = floating.getByRole("button", {
      name: "今天",
      exact: true,
    });
    const chat = floating.getByRole("button", { name: "聊聊", exact: true });
    await expect(allTasks).toHaveClass(/active/u);
    await expect(
      floating.locator(".mini-content").getByText(futureTitle, { exact: true }),
    ).toBeVisible();

    await todayTasks.click();
    await expect(todayTasks).toHaveClass(/active/u);
    await expect(
      floating.locator(".mini-content").getByText(futureTitle, { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        floating.evaluate(() => localStorage.getItem("todoAgentFloatingTab")),
      )
      .toBe("today");

    // Folding the panel keeps the user on the last selected task scope.
    await floating
      .getByRole("button", { name: "收起 小序" })
      .click();
    await floating
      .getByRole("button", { name: "展开 小序" })
      .click();
    await expect(todayTasks).toHaveClass(/active/u);

    // The same guarantee applies to non-task tabs and survives a real app
    // restart, not only a React re-render.
    await chat.click();
    await expect(chat).toHaveClass(/active/u);
    await expect
      .poll(() =>
        floating.evaluate(() => localStorage.getItem("todoAgentFloatingTab")),
      )
      .toBe("chat");
    await app.close();
    app = undefined;

    app = await launch(profilePath);
    const reopenedMain = await windowFor(app, "main");
    await reopenedMain.waitForLoadState("domcontentloaded");
    await finishOnboarding(reopenedMain);
    const reopenedFloating = await windowFor(app, "floating");
    await reopenedFloating.waitForLoadState("domcontentloaded");
    await reopenedFloating
      .getByRole("button", { name: "展开 小序" })
      .click();
    await expect(
      reopenedFloating.getByRole("button", { name: "聊聊", exact: true }),
    ).toHaveClass(/active/u);
  });

  test("opens the remembered main task page when Todo Pet is double-clicked", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    // Start from a non-task route so Todo Pet must both restore the hidden
    // main window and route to its remembered task scope.
    await main
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "Agent", exact: true })
      .click();
    await expect(main.getByRole("heading", { name: "任务助理" })).toBeVisible();

    await expect(floating.locator(".floating-shell.is-compact")).toBeVisible();
    const compactTrigger = floating.getByRole("button", {
      name: "展开 小序",
    });
    await expect(compactTrigger).toHaveClass(/no-drag/u);

    // Match the native close control's close-to-tray behavior: only the main
    // BrowserWindow hides, while the compact floating entry stays available.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        try {
          return (
            new URL(candidate.webContents.getURL()).searchParams.get("window") ===
            "main"
          );
        } catch {
          return false;
        }
      });
      if (!window) throw new Error("Main window is missing");
      window.close();
    });
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main"
              );
            } catch {
              return false;
            }
          });
          return window?.isVisible() ?? false;
        }),
      )
      .toBe(false);

    // A double-click on the non-drag compact affordance is the direct-entry
    // gesture. It must not merely expand the mini panel.
    await compactTrigger.dblclick();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main"
              );
            } catch {
              return false;
            }
          });
          return window?.isVisible() ?? false;
        }),
      )
      .toBe(true);
    await expect(main.getByRole("heading", { name: "全部任务" })).toBeVisible();
    await expect(floating.locator(".floating-shell.is-compact")).toBeVisible();
    await expect(floating.locator(".mini-panel")).toBeHidden();
  });

  test("offers non-drag shortcut actions from Todo Pet", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    const menu = floating.getByRole("menu", { name: "Todo Pet 快捷菜单" });
    const openPetMenu = async () => {
      await floating
        .getByRole("button", { name: "展开 小序" })
        .click({ button: "right" });
      await expect(menu).toBeVisible();
    };

    // Todo Pet supports a concise, safe right-click menu. It is
    // rendered inside an explicitly non-drag surface, so choosing an action
    // cannot accidentally start a native move of the frameless window.
    await openPetMenu();
    expect(
      await menu.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    await expect(
      menu.getByRole("menuitem", { name: /打开 Today/u }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /快速录入/u }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /在此处对话/u }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitemcheckbox", { name: /开启隐私模式/u }),
    ).toHaveAttribute("aria-checked", "false");
    await expect(
      menu.getByRole("menuitemcheckbox", { name: /锁定位置/u }),
    ).toHaveAttribute("aria-checked", "false");

    // Escape dismisses a compact-entry menu back to its compact state.
    await menu.getByRole("menuitem", { name: /打开 Today/u }).focus();
    await floating.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(floating.locator(".mini-panel")).toBeHidden();

    await openPetMenu();
    await menu.getByRole("menuitem", { name: /在此处对话/u }).click();
    await expect(menu).toBeHidden();
    await expect(floating.locator(".mini-panel")).toBeVisible();
    await expect(
      floating.getByRole("button", { name: "聊聊", exact: true }),
    ).toHaveClass(/active/u);
    await floating
      .getByRole("button", { name: "收起 小序" })
      .click();

    // Preference toggles are local display choices and immediately persist
    // through the existing settings API; no task content is inspected.
    await openPetMenu();
    await menu
      .getByRole("menuitemcheckbox", { name: /开启隐私模式/u })
      .click();
    await expect(menu).toBeHidden();
    await expect
      .poll(() =>
        main.evaluate(async () => {
          const settings = await window.desktopApi!.settings.get();
          return settings.floating.privacyMode;
        }),
      )
      .toBe(true);

    // Scaling Todo Pet never removes its right-click entry.
    await main
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "Agent", exact: true })
      .click();
    await expect(main.getByRole("heading", { name: "任务助理" })).toBeVisible();
    await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        floating: {
          ...settings.floating,
          scalePercent: 75,
          privacyMode: false,
        },
      });
    });
    await expect(floating.locator(".floating-shell.is-compact")).toBeVisible();
    const compactPet = floating.getByRole("button", {
      name: "展开 小序",
    });
    await compactPet.click({ button: "right" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: /打开 Today/u }).click();
    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(floating.locator(".floating-shell.is-compact")).toBeVisible();
  });

  test("restores and focuses the main window when the app icon activates a hidden Todo Agent", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    // This follows the same native close-to-tray path users take before
    // double-clicking the application/Dock icon. It must hide rather than
    // destroy the main BrowserWindow, so macOS `activate` can restore it.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        try {
          return (
            new URL(candidate.webContents.getURL()).searchParams.get("window") ===
            "main"
          );
        } catch {
          return false;
        }
      });
      if (!window) throw new Error("Main window is missing");
      window.close();
    });
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main"
              );
            } catch {
              return false;
            }
          });
          return window?.isVisible() ?? false;
        }),
      )
      .toBe(false);

    // Electron dispatches `activate` when users click the macOS application
    // icon while the process remains alive. The registered handler must both
    // reveal and focus the existing main window, not merely recreate a page.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit("activate");
    });
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main"
              );
            } catch {
              return false;
            }
          });
          if (!window) return { visible: false, minimized: true };
          return {
            visible: window.isVisible(),
            minimized: window.isMinimized(),
          };
        }),
      )
      .toEqual({ visible: true, minimized: false });
    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
  });

  test("restores and focuses a minimized main window when a second launch reaches the running app", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        try {
          return (
            new URL(candidate.webContents.getURL()).searchParams.get("window") ===
            "main"
          );
        } catch {
          return false;
        }
      });
      if (!window) throw new Error("Main window is missing");
      window.minimize();
    });
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main"
              );
            } catch {
              return false;
            }
          });
          return window?.isMinimized() ?? false;
        }),
      )
      .toBe(true);

    // Windows/Linux route a second executable launch to the single-instance
    // owner. The same recovery contract applies: restore the existing window
    // and put its UI in front instead of silently leaving it minimized.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit("second-instance");
    });
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => {
            try {
              return (
                new URL(candidate.webContents.getURL()).searchParams.get(
                  "window",
                ) === "main"
              );
            } catch {
              return false;
            }
          });
          if (!window) return { visible: false, minimized: true };
          return {
            visible: window.isVisible(),
            minimized: window.isMinimized(),
          };
        }),
      )
      .toEqual({ visible: true, minimized: false });
    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
  });

  test("reliably routes from an expanded floating panel while the main renderer reloads", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const navigation = main.getByRole("navigation", { name: "主导航" });
    await navigation.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(main.getByRole("heading", { name: "任务助理" })).toBeVisible();

    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");
    await floating.getByRole("button", { name: "展开 小序" }).click();
    await expect(floating.getByRole("button", { name: "打开主窗口" })).toBeVisible();

    // A reload recreates React before its navigation effect has subscribed.
    // The visible floating action must still replace the previous Agent route
    // with its remembered task scope instead of silently leaving the user on
    // the stale page.
    await main.reload({ waitUntil: "commit" });
    await floating.getByRole("button", { name: "打开主窗口" }).click();
    await expect(main.getByRole("heading", { name: "全部任务" })).toBeVisible();
  });

  test("persists a local task across a real Electron restart", async () => {
    app = await launch(profilePath);
    let main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main
      .getByLabel("任务标题")
      .or(main.locator("#new-title"))
      .last()
      .fill("验收本地持久化");
    await main.getByRole("button", { name: "保存到本地" }).click();
    await expect(
      main.getByText("验收本地持久化", { exact: true }).first(),
    ).toBeVisible();

    const security = await main.evaluate(() => ({
      requireType: typeof (globalThis as Record<string, unknown>).require,
      processType: typeof (globalThis as Record<string, unknown>).process,
      exposedNamespaces: Object.keys(window.desktopApi ?? {}).sort(),
      notificationMethods: Object.keys(
        window.desktopApi?.notifications ?? {},
      ).sort(),
    }));
    expect(security.requireType).toBe("undefined");
    expect(security.processType).toBe("undefined");
    expect(security.exposedNamespaces).toEqual([
      "agent",
      "capture",
      "data",
      "events",
      "feishu",
      "notifications",
      "settings",
      "shell",
      "tasks",
    ]);
    expect(security.notificationMethods).toEqual([
      "handleAction",
      "refresh",
      "snoozeUntil",
    ]);

    await app.close();
    app = await launch(profilePath);
    main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await expect(
      main.getByText("验收本地持久化", { exact: true }).first(),
    ).toBeVisible();
  });

  test("does not silently create a local task when Feishu is unavailable", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const title = "验收-未连接飞书不得降级";
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(title);
    await main.locator("#new-source").selectOption("feishu");
    await main.getByRole("button", { name: "创建到飞书" }).click();

    await expect(
      main.getByText("请先在设置中配置飞书，现有本地任务不会被上传", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(main.getByText(title, { exact: true })).toHaveCount(0);
    await expect(main.getByRole("form", { name: "新建任务" })).toBeVisible();
  });

  test("completes the visible local task lifecycle without losing edits", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const navigation = main.getByRole("navigation", { name: "主导航" });

    const title = "验收-本地完整生命周期";
    const editedTitle = `${title}-已更新`;
    const planKeys = await main.evaluate(() => {
      // Do not rely on the browser's locale implementation for a native date
      // input value: some Chromium builds render en-CA as M/D/YYYY instead of
      // the required YYYY-MM-DD control value.
      const key = (date: Date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return { today: key(today), tomorrow: key(tomorrow) };
    });
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(title);
    await main.locator("#new-notes").fill("第一版备注");
    await main.locator("#new-project").fill("验收项目");
    await main.locator("#new-tags").fill("验收, 本地");
    await main.locator("#new-priority").selectOption("high");
    await main.locator("#new-start").fill("2026-08-10T09:00");
    await main.locator("#new-due").fill("2026-08-10T10:00");
    await main.locator("#new-reminder").fill("2026-08-10T08:00");
    await main.getByRole("button", { name: "保存到本地" }).click();

    const row = main.locator(".task-row", { hasText: title });
    await expect(row).toBeVisible();
    await expect(
      navigation.getByRole("button", { name: /今天.*1/u }),
    ).toBeVisible();
    await row.locator(".task-body").click();
    await expect(main.getByLabel("任务标题", { exact: true })).toHaveValue(title);
    await expect(main.getByLabel("任务备注", { exact: true })).toHaveValue("第一版备注");
    await expect(main.locator("#project-id")).toHaveValue("验收项目");
    await expect(main.locator("#task-tags")).toHaveValue("验收, 本地");
    await expect(main.locator("#priority")).toHaveValue("high");
    await expect(main.locator("#start-at")).toHaveValue("2026-08-10T09:00");
    await expect(main.locator("#due-at")).toHaveValue("2026-08-10T10:00");
    await expect(main.locator("#local-reminder")).toHaveValue(
      "2026-08-10T08:00",
    );

    await main.getByLabel("任务标题", { exact: true }).fill(editedTitle);
    await main.getByLabel("任务标题", { exact: true }).press("Tab");
    await expect(main.locator(".task-row", { hasText: editedTitle })).toBeVisible();
    await main.getByLabel("任务备注", { exact: true }).fill("第二版备注");
    await main.getByLabel("任务备注", { exact: true }).press("Tab");
    await expect(main.getByLabel("任务备注", { exact: true })).toHaveValue("第二版备注");
    await main.locator("#project-id").fill("更新后的项目");
    await main.locator("#project-id").press("Tab");
    await expect(main.locator("#project-id")).toHaveValue("更新后的项目");
    await main.locator("#task-tags").fill("验收, 更新");
    await main.locator("#task-tags").press("Tab");
    await expect(main.locator("#task-tags")).toHaveValue("验收, 更新");

    // Date and reminder controls keep a local draft while the native control
    // is being edited, then commit the final value on blur. This avoids a
    // stale intermediate segment overwriting a fast user edit.
    await main.locator("#planned-date").fill(planKeys.tomorrow);
    await main.locator("#planned-date").blur();
    await expect(main.locator("#planned-date")).toHaveValue(planKeys.tomorrow);
    // Return it to Today so the rest of this end-to-end journey continues
    // through the same everyday view after proving a plan-date edit.
    await main.locator("#planned-date").fill(planKeys.today);
    await main.locator("#planned-date").blur();
    await expect(main.locator("#planned-date")).toHaveValue(planKeys.today);
    // Move the deadline first so the later start-time edit remains a valid
    // interval throughout the visible form workflow.
    await main.locator("#due-at").fill("2026-08-11T10:30");
    await main.locator("#due-at").blur();
    await expect(main.locator("#due-at")).toHaveValue("2026-08-11T10:30");
    await main.locator("#start-at").fill("2026-08-11T09:15");
    await main.locator("#start-at").blur();
    await expect(main.locator("#start-at")).toHaveValue("2026-08-11T09:15");
    // A visible all-day toggle must preserve the date while deliberately
    // changing the field type, then allow an explicit return to a timed slot.
    await main.getByLabel("开始时间为全天").check();
    await expect(main.locator("#start-at")).toHaveValue("2026-08-11");
    await main.getByLabel("开始时间为全天").uncheck();
    await expect(main.locator("#start-at")).toHaveValue("2026-08-11T00:00");
    await main.locator("#start-at").fill("2026-08-11T09:15");
    await main.locator("#start-at").blur();
    await expect(main.locator("#start-at")).toHaveValue("2026-08-11T09:15");
    await main.locator("#local-reminder").fill("2026-08-11T08:00");
    await main.locator("#local-reminder").blur();
    await expect(main.locator("#local-reminder")).toHaveValue(
      "2026-08-11T08:00",
    );

    // An invalid temporal edit must be rejected atomically, then a corrected
    // edit remains possible through the same visible inspector.
    await main.locator("#due-at").fill("2026-08-11T08:30");
    await main.locator("#due-at").blur();
    await expect(
      main.getByText("截止时间不能早于开始时间", { exact: true }).first(),
    ).toBeVisible();
    await main.locator("#due-at").fill("2026-08-11T10:30");
    await main.locator("#due-at").blur();
    await expect(main.locator("#due-at")).toHaveValue("2026-08-11T10:30");
    // The rapid “tomorrow → today” plan edit must persist its final value,
    // not merely keep it in the native input draft. Today is the visible
    // proof: start/due are tomorrow, so this row is present only when the
    // final private plan date has reached the task store.
    await expect(
      main.locator(".task-row", { hasText: editedTitle }),
    ).toBeVisible();
    const [previousDueLabel, updatedDueLabel] = await main.evaluate(() => {
      const formatter = new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return [
        formatter.format(new Date("2026-08-10T10:00")),
        formatter.format(new Date("2026-08-11T10:30")),
      ];
    });
    // The edited start/due time now belongs to tomorrow. Switch to the
    // complete task collection to verify the compact row while the inspector
    // remains selected across this filter boundary.
    await navigation.getByRole("button", { name: /全部任务/u }).click();
    const editedRow = main.locator(".task-row", { hasText: editedTitle });
    await expect(editedRow).toContainText(updatedDueLabel);
    await expect(editedRow).not.toContainText(previousDueLabel);

    await main.getByLabel(`完成${editedTitle}`).click();
    await expect(
      navigation.getByRole("button", { name: /已完成.*1/u }),
    ).toBeVisible();
    await navigation.getByRole("button", { name: /已完成/u }).click();
    await expect(main.getByText(editedTitle, { exact: true }).first()).toBeVisible();
    await main.getByLabel(`恢复${editedTitle}`).click();
    await expect(main.getByText(editedTitle, { exact: true })).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: /全部任务.*1/u }),
    ).toBeVisible();

    await navigation.getByRole("button", { name: /全部任务/u }).click();
    const reopened = main.locator(".task-row", { hasText: editedTitle });
    await expect(reopened).toBeVisible();
    await reopened.locator(".task-body").click();
    main.once("dialog", (dialog) => dialog.accept());
    await main.getByRole("button", { name: "移到回收站" }).click();
    await expect(main.getByText("已移到回收站", { exact: true })).toBeVisible();
    await expect(
      navigation.getByRole("button", { name: /回收站.*1/u }),
    ).toBeVisible();
    await navigation.getByRole("button", { name: /^回收站/u }).click();
    const trashed = main.locator(".task-row", { hasText: editedTitle });
    await expect(trashed).toBeVisible();
    const restore = main.getByRole("button", { name: "恢复任务" });
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(main.getByText(editedTitle, { exact: true })).toHaveCount(0);
    await navigation.getByRole("button", { name: /全部任务/u }).click();
    await expect(main.getByText(editedTitle, { exact: true }).first()).toBeVisible();
  });

  test("persists a freely moved floating window and honors position locking", async () => {
    app = await launch(profilePath);
    let main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");
    const before = await floatingWindowState(app);
    expect(before.movable).toBe(true);
    const staleSettings = await main.evaluate(() =>
      window.desktopApi!.settings.get(),
    );
    await main
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await main
      .getByRole("navigation", { name: "设置导航" })
      .getByRole("button", { name: "Todo Pet", exact: true })
      .click();
    const lockPosition = main.getByLabel("锁定 Todo Pet 位置");
    await expect(lockPosition).not.toBeChecked();

    const moved = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        try {
          return (
            new URL(candidate.webContents.getURL()).searchParams.get("window") ===
            "floating"
          );
        } catch {
          return false;
        }
      });
      if (!window) throw new Error("Floating window is missing");
      const bounds = window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const { workArea } = display;
      const x =
        bounds.x - 120 >= workArea.x + 24 ? bounds.x - 120 : bounds.x + 120;
      const y =
        bounds.y + 96 + bounds.height <=
        workArea.y + workArea.height - 24
          ? bounds.y + 96
          : bounds.y - 96;
      const next = { ...bounds, x, y };
      window.emit("will-move", {} as never, next, { source: "mouse" } as never);
      window.setBounds(next, false);
      return {
        displayId: String(display.id),
        position: { x, y },
      };
    });
    await expect
      .poll(async () =>
        main.evaluate(async ({ displayId }) => {
          const settings = await window.desktopApi!.settings.get();
          return settings.floating.positions[displayId];
        }, moved),
      )
      .toEqual(moved.position);
    // Native dragging emits `will-move` only when it starts, then several
    // `move` events. A later point must win even without another will-move.
    const finalMoved = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => {
        try {
          return (
            new URL(candidate.webContents.getURL()).searchParams.get("window") ===
            "floating"
          );
        } catch {
          return false;
        }
      });
      if (!window) throw new Error("Floating window is missing");
      const bounds = window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const { workArea } = display;
      const next = {
        ...bounds,
        x: Math.max(
          workArea.x + 32,
          Math.min(bounds.x + 42, workArea.x + workArea.width - bounds.width - 32),
        ),
        y: Math.max(
          workArea.y + 32,
          Math.min(bounds.y + 36, workArea.y + workArea.height - bounds.height - 32),
        ),
      };
      window.setBounds(next, false);
      return {
        displayId: String(display.id),
        position: { x: next.x, y: next.y },
      };
    });
    await expect
      .poll(async () =>
        main.evaluate(async ({ displayId }) => {
          const settings = await window.desktopApi!.settings.get();
          return settings.floating.positions[displayId];
        }, finalMoved),
      )
      .toEqual(finalMoved.position);
    await expect
      .poll(async () =>
        main.evaluate(() => window.desktopApi!.settings.get()),
      )
      .toMatchObject({ floating: { lastDisplayId: finalMoved.displayId } });

    await main.locator("label.switch").filter({ has: lockPosition }).click();
    await expect(lockPosition).toBeChecked();
    await expect
      .poll(async () => (await floatingWindowState(app!)).movable)
      .toBe(false);
    await expect
      .poll(async () =>
        floating.locator(".floating-drag-handle").evaluate((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        ),
      )
      .toBe("no-drag");
    await expect
      .poll(async () =>
        floating.locator(".pet-compact").evaluate((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region"),
        ),
      )
      .toBe("no-drag");

    // Reproduce a renderer submitting the full settings snapshot it held
    // before the drag. The main process must retain its newer coordinates.
    await main.evaluate(async (stale) => {
      await window.desktopApi!.settings.replace({
        ...stale,
        floating: { ...stale.floating, locked: true },
      });
    }, staleSettings);
    await expect
      .poll(async () =>
        main.evaluate(async ({ displayId }) => {
          const settings = await window.desktopApi!.settings.get();
          return settings.floating.positions[displayId];
        }, finalMoved),
      )
      .toEqual(finalMoved.position);

    await app.close();
    app = await launch(profilePath);
    main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await expect
      .poll(async () => (await floatingWindowState(app!)).position)
      .toEqual(finalMoved.position);
    await expect
      .poll(async () => (await floatingWindowState(app!)).movable)
      .toBe(false);
    await expect
      .poll(async () => (await floatingWindowState(app!)).alwaysOnTop)
      .toBe(true);
  });

  test("uses quick capture parsing and keeps all windows in sync", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    await main.evaluate(() => window.desktopApi?.shell.showQuickCapture());
    const quick = await windowFor(app, "quick");
    await quick.waitForLoadState("domcontentloaded");
    const input = quick.getByLabel("快速录入");
    const captureText = "今天23:59完成周报，提前1小时提醒 #工作";
    await input.fill(captureText);
    const parsed = await quick.evaluate(
      (text) => window.desktopApi!.capture.parse(text),
      captureText,
    );
    expect(parsed.privatePlanAt?.slice(0, 10)).toBe(
      new Date().toLocaleDateString("en-CA"),
    );
    await expect(quick.getByText("#工作", { exact: true })).toBeVisible();
    await expect(quick.getByText(/提醒/u).first()).toBeVisible();
    await quick.getByRole("button", { name: "保存到本地" }).click();

    await expect(
      main.getByText(parsed.title, { exact: true }).first(),
    ).toBeVisible();
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");
    await expect(floating.locator(".pet-compact")).toBeVisible();
    await expect(
      floating.getByText(parsed.title, { exact: true }).first(),
    ).toBeVisible();

    await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        floating: {
          ...settings.floating,
          privacyMode: true,
          hoverExpandDelayMs: 300,
        },
      });
    });
    await expect(floating.getByText(parsed.title, { exact: true })).toHaveCount(
      0,
    );
    await expect(
      floating.getByText("私人任务", { exact: true }).first(),
    ).toBeVisible();
    await floating.screenshot({
      path: path.join(projectRoot, "test-results", "floating-privacy.png"),
    });

    const chatTab = floating.getByRole("button", { name: "聊聊", exact: true });
    const capsule = floating.locator(".pet-compact");
    await capsule.hover();
    await floating.waitForTimeout(120);
    await floating.mouse.move(1, 1);
    await floating.waitForTimeout(260);
    await expect(chatTab).toBeHidden();
    await capsule.hover();
    await expect(chatTab).toBeVisible({ timeout: 1_000 });
    await expect(floating.locator(".floating-stack")).toHaveAttribute(
      "data-expand-trigger",
      "hover",
    );
    await chatTab.hover();
    await expect(chatTab).toBeVisible();
    await floating.locator(".floating-stack").evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }),
      );
    });
    await expect(chatTab).toBeHidden();
    await floating
      .getByRole("button", { name: "展开 小序" })
      .click();
    await expect(chatTab).toBeVisible();
    await floating.locator(".floating-stack").evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }),
      );
    });
    await expect(chatTab).toBeVisible();
    // Privacy mode intentionally hides and disables the mini-chat. Turn it
    // off explicitly before testing normal inline Agent interaction.
    await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        floating: { ...settings.floating, privacyMode: false },
      });
    });
    await chatTab.click();
    const agentPrompt = "请给我一个简短的下午规划";
    await floating.getByLabel("给 Agent 发消息").fill(agentPrompt);
    await floating.getByRole("button", { name: "发送给 Agent" }).click();
    await expect(
      floating.getByText(agentPrompt, { exact: true }),
    ).toBeVisible();
    await expect(
      floating.getByText(/模型未启用。今天有/u).last(),
    ).toBeVisible();
    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
    await expect(main.getByLabel("给 Agent 发消息")).toBeHidden();

    await main.screenshot({
      path: path.join(projectRoot, "test-results", "main-window.png"),
    });
  });

  test("uses the latest hover delay when settings change under the floating entry", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        floating: { ...settings.floating, hoverExpandDelayMs: 300 },
      });
    });
    const expand = floating.getByRole("button", { name: "展开 小序" });
    await expect(expand).toHaveAttribute(
      "title",
      "停留 0.3 秒或单击展开 · 双击打开主窗口",
    );

    await floating.locator(".pet-compact").hover();
    await floating.waitForTimeout(80);
    await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        floating: { ...settings.floating, hoverExpandDelayMs: 1_600 },
      });
    });
    await expect(expand).toHaveAttribute(
      "title",
      "停留 1.6 秒或单击展开 · 双击打开主窗口",
    );

    // The original 300ms timer would have opened by now. The panel remains
    // closed until the newly configured delay has elapsed.
    await floating.waitForTimeout(700);
    await expect(floating.locator(".mini-panel")).toBeHidden();
    await floating.waitForTimeout(1_000);
    await expect(floating.locator(".mini-panel")).toBeVisible();
    await expect(floating.locator(".floating-stack")).toHaveAttribute(
      "data-expand-trigger",
      "hover",
    );
  });

  test("keeps a long floating Today title compact and aligned", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const longTitle = `Codex验收-悬浮长标题-${"中英文 Mixed task title ".repeat(16)}`;
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(longTitle);
    await main.getByRole("button", { name: "保存到本地" }).click();
    await expect(main.getByText(longTitle, { exact: true }).first()).toBeVisible();

    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");
    await floating
      .getByRole("button", { name: "展开 小序" })
      .click();
    const row = floating.locator(".mini-task").filter({ hasText: longTitle });
    const title = row.locator(":scope > span");
    const source = row.locator(":scope > small");
    await expect(row).toBeVisible();

    const layout = await row.evaluate((element) => {
      const title = element.querySelector<HTMLElement>(":scope > span");
      const source = element.querySelector<HTMLElement>(":scope > small");
      if (!title || !source) throw new Error("Floating task row is incomplete");
      const rowBounds = element.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      const sourceBounds = source.getBoundingClientRect();
      const titleStyle = getComputedStyle(title);
      return {
        lineClamp: titleStyle.webkitLineClamp,
        overflow: titleStyle.overflow,
        titleHeight: titleBounds.height,
        lineHeight: Number.parseFloat(titleStyle.lineHeight),
        rowHeight: rowBounds.height,
        sourceCenter: sourceBounds.top + sourceBounds.height / 2,
        rowCenter: rowBounds.top + rowBounds.height / 2,
      };
    });
    expect(layout.lineClamp).toBe("2");
    expect(layout.overflow).toBe("hidden");
    expect(layout.titleHeight).toBeLessThanOrEqual(layout.lineHeight * 2 + 1);
    expect(layout.rowHeight).toBeLessThanOrEqual(64);
    expect(Math.abs(layout.sourceCenter - layout.rowCenter)).toBeLessThanOrEqual(1);
  });

  test("rotates compact Today tasks vertically, pauses on hover, and keeps its action aligned", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const titles = [
      "Codex验收-悬浮轮播任务一",
      "Codex验收-悬浮轮播任务二",
    ];
    const focusedTaskId = await main.evaluate(async (nextTitles) => {
      const api = window.desktopApi!;
      const now = new Date();
      const plannedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const first = await api.tasks.create({
        title: nextTitles[0],
        plannedDate,
        source: { type: "local" },
      });
      await api.tasks.create({
        title: nextTitles[1],
        plannedDate,
        source: { type: "local" },
      });
      return first.task.id;
    }, titles);

    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");
    const carousel = floating.locator(".floating-carousel");
    const carouselTitle = carousel.locator(".floating-carousel-item");
    await expect(carousel).toHaveAttribute("data-carousel-mode", "rotating");
    await expect
      .poll(async () => carouselTitle.textContent())
      .toMatch(new RegExp(titles.join("|"), "u"));

    const beforeRotation = await carouselTitle.textContent();
    expect(beforeRotation).toBeTruthy();
    await expect(
      floating.getByRole("button", { name: `完成${beforeRotation}` }),
    ).toBeVisible();
    await expect
      .poll(async () => carouselTitle.textContent(), { timeout: 5_500 })
      .not.toBe(beforeRotation);
    const afterRotation = await carouselTitle.textContent();
    await expect(
      floating.getByRole("button", { name: `完成${afterRotation}` }),
    ).toBeVisible();

    // Hovering anywhere in the floating stack pauses the automatic rotation.
    await floating.locator(".floating-stack").hover();
    await expect(carousel).toHaveAttribute("data-carousel-paused", "true");
    const whileHovered = await carouselTitle.textContent();
    await floating.waitForTimeout(4_100);
    await expect(carouselTitle).toHaveText(whileHovered!);

    await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        floating: { ...settings.floating, privacyMode: true },
      });
    });
    await expect(carousel).toHaveAttribute("data-carousel-mode", "private");
    await expect(carouselTitle).toHaveText("私人任务");

    await main.evaluate(async () => {
      const settings = await window.desktopApi!.settings.get();
      await window.desktopApi!.settings.replace({
        ...settings,
        floating: { ...settings.floating, privacyMode: false },
      });
    });
    await floating.locator(".floating-stack").evaluate((element) => {
      element.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }),
      );
    });
    await main.evaluate(
      (taskId) => window.desktopApi!.tasks.startFocus(taskId),
      focusedTaskId,
    );
    await expect(carousel).toHaveAttribute("data-carousel-mode", "static");
    await expect(carouselTitle).toHaveText(titles[0]);
  });

  test("streams Markdown and scrolls long Agent replies inside the floating window", async () => {
    const modelServer = await startStreamingModelServer();
    try {
      app = await launch(profilePath);
      const main = await windowFor(app, "main");
      await main.waitForLoadState("domcontentloaded");
      await finishOnboarding(main);
      const credentialId = await main.evaluate(async () => {
        const credential = await window.desktopApi!.settings.setCredential({
          id: "floating-e2e-model",
          kind: "ai-api-key",
          value: "local-test-key",
        });
        return credential.id;
      });
      await main.evaluate(async ({ endpoint, credentialId }) => {
        const settings = await window.desktopApi!.settings.get();
        await window.desktopApi!.settings.replace({
          ...settings,
          ai: {
            ...settings.ai,
            enabled: true,
            endpoint,
            model: "floating-e2e-model",
            credentialId,
            retries: 0,
          },
          modelDataScope: {
            ...settings.modelDataScope,
            chatHistory: true,
          },
        });
      }, { endpoint: modelServer.endpoint, credentialId });

      const floating = await windowFor(app, "floating");
      await floating.waitForLoadState("domcontentloaded");
      await floating
        .getByRole("button", { name: "展开 小序" })
        .click();
      const miniTabLayout = await floating.locator(".mini-tabs").evaluate((element) => {
        const header = element as HTMLElement;
        const controls = [...header.querySelectorAll<HTMLElement>("button")];
        if (controls.length !== 6)
          throw new Error("Expected five Todo Pet tabs and an open-main control");
        const tops = controls.map((control) => control.getBoundingClientRect().top);
        return {
          height: header.getBoundingClientRect().height,
          rowSpread: Math.max(...tops) - Math.min(...tops),
        };
      });
      expect(miniTabLayout.height).toBeLessThanOrEqual(56);
      expect(miniTabLayout.rowSpread).toBeLessThanOrEqual(1);
      await floating.getByRole("button", { name: "聊聊", exact: true }).click();
      await floating
        .getByLabel("给 Agent 发消息")
        .fill("请创建一条测试任务并给出详细计划");
      await floating.getByRole("button", { name: "发送给 Agent" }).click();

      await modelServer.firstChunk;
      await expect(
        floating.getByRole("heading", { name: "浮窗实时回答" }),
      ).toBeVisible();
      await expect(floating.locator(".mini-message.streaming")).toBeVisible();
      await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
      await expect(main.getByLabel("给 Agent 发消息")).toBeHidden();

      modelServer.releaseFinal();
      await expect(
        floating.getByText("可滚动任务建议 36", { exact: true }),
      ).toBeVisible();
      await expect(floating.locator(".mini-message.streaming")).toHaveCount(0);
      const markdownLayout = await floating
        .locator(".mini-message .agent-markdown")
        .last()
        .evaluate((element) => {
          const markdown = element as HTMLElement;
          const table = markdown.querySelector<HTMLElement>("table");
          const tableScroll = markdown.querySelector<HTMLElement>(
            ".agent-markdown-table-scroll",
          );
          const pre = markdown.querySelector<HTMLElement>("pre");
          if (!table || !tableScroll || !pre)
            throw new Error("Expected table scroll area and code block");
          return {
            markdownScrollWidth: markdown.scrollWidth,
            markdownClientWidth: markdown.clientWidth,
            tableScrollOverflowX: getComputedStyle(tableScroll).overflowX,
            tableScrollWidth: tableScroll.scrollWidth,
            tableScrollClientWidth: tableScroll.clientWidth,
            preOverflowX: getComputedStyle(pre).overflowX,
            preScrollWidth: pre.scrollWidth,
            preClientWidth: pre.clientWidth,
          };
        });
      expect(markdownLayout.markdownScrollWidth).toBeLessThanOrEqual(
        markdownLayout.markdownClientWidth + 1,
      );
      expect(markdownLayout.tableScrollOverflowX).toBe("auto");
      expect(markdownLayout.tableScrollWidth).toBeGreaterThan(
        markdownLayout.tableScrollClientWidth,
      );
      expect(markdownLayout.preOverflowX).toBe("auto");
      expect(markdownLayout.preScrollWidth).toBeGreaterThan(
        markdownLayout.preClientWidth,
      );
      const scrollState = await floating.locator(".mini-content").evaluate(
        (element) => {
          const content = element as HTMLElement;
          content.scrollTop = 60;
          return {
            overflowY: getComputedStyle(content).overflowY,
            scrollHeight: content.scrollHeight,
            clientHeight: content.clientHeight,
            scrollTop: content.scrollTop,
          };
        },
      );
      expect(scrollState.overflowY).toBe("auto");
      expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
      expect(scrollState.scrollTop).toBeGreaterThan(0);
      await expect(floating.getByLabel("给 Agent 发消息")).toBeVisible();
      await expect
        .poll(async () => (await floatingWindowState(app!)).bounds)
        .toEqual({ width: 480, height: 600 });
      await floating
        .getByRole("button", { name: "今天", exact: true })
        .click();
      await expect(
        floating
          .locator(".mini-task")
          .getByText("浮窗 Agent 创建的任务", { exact: true }),
      ).toBeVisible();
    } finally {
      await modelServer.close();
    }
  });

  test("keeps long Markdown contained in the 760px main Agent workspace", async () => {
    const modelServer = await startStreamingModelServer();
    try {
      app = await launch(profilePath);
      const main = await windowFor(app, "main");
      await main.waitForLoadState("domcontentloaded");
      await finishOnboarding(main);
      await main.evaluate(async (endpoint) => {
        const credential = await window.desktopApi!.settings.setCredential({
          id: "narrow-main-e2e-model",
          kind: "ai-api-key",
          value: "local-test-key",
        });
        const settings = await window.desktopApi!.settings.get();
        await window.desktopApi!.settings.replace({
          ...settings,
          ai: {
            ...settings.ai,
            enabled: true,
            endpoint,
            model: "narrow-main-e2e-model",
            credentialId: credential.id,
            retries: 0,
          },
          modelDataScope: {
            ...settings.modelDataScope,
            chatHistory: true,
          },
        });
      }, modelServer.endpoint);
      expect(await resizeMainWindow(app, 760, 600)).toEqual({
        width: 760,
        height: 600,
      });
      const navigation = main.getByRole("navigation", { name: "主导航" });
      await navigation.getByRole("button", { name: "Agent", exact: true }).click();
      await main
        .getByLabel("给 Agent 发消息")
        .fill("请创建一条测试任务并给出详细计划");
      await main.getByRole("button", { name: "发送", exact: true }).click();

      await modelServer.firstChunk;
      await expect(
        main.getByRole("heading", { name: "浮窗实时回答" }),
      ).toBeVisible();
      modelServer.releaseFinal();
      await expect(
        main.getByText("可滚动任务建议 36", { exact: true }),
      ).toBeVisible();

      const markdownLayout = await main
        .locator(".agent-thread .agent-markdown")
        .last()
        .evaluate((element) => {
          const markdown = element as HTMLElement;
          const table = markdown.querySelector<HTMLElement>("table");
          const tableScroll = markdown.querySelector<HTMLElement>(
            ".agent-markdown-table-scroll",
          );
          const pre = markdown.querySelector<HTMLElement>("pre");
          const layout = document.querySelector<HTMLElement>(".agent-layout");
          if (!table || !tableScroll || !pre || !layout)
            throw new Error("Expected contained Agent Markdown layout");
          return {
            layoutScrollWidth: layout.scrollWidth,
            layoutClientWidth: layout.clientWidth,
            markdownScrollWidth: markdown.scrollWidth,
            markdownClientWidth: markdown.clientWidth,
            tableScrollOverflowX: getComputedStyle(tableScroll).overflowX,
            tableScrollWidth: tableScroll.scrollWidth,
            tableScrollClientWidth: tableScroll.clientWidth,
            preOverflowX: getComputedStyle(pre).overflowX,
            preScrollWidth: pre.scrollWidth,
            preClientWidth: pre.clientWidth,
          };
        });
      expect(markdownLayout.layoutScrollWidth).toBeLessThanOrEqual(
        markdownLayout.layoutClientWidth + 1,
      );
      expect(markdownLayout.markdownScrollWidth).toBeLessThanOrEqual(
        markdownLayout.markdownClientWidth + 1,
      );
      expect(markdownLayout.tableScrollOverflowX).toBe("auto");
      expect(markdownLayout.tableScrollWidth).toBeGreaterThan(
        markdownLayout.tableScrollClientWidth,
      );
      expect(markdownLayout.preOverflowX).toBe("auto");
      expect(markdownLayout.preScrollWidth).toBeGreaterThan(
        markdownLayout.preClientWidth,
      );
    } finally {
      await modelServer.close();
    }
  });

  test("defaults to the zero-server Feishu connection flow", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    await main.getByRole("button", { name: "设置", exact: true }).click();
    const settingsNavigation = main.getByRole("navigation", {
      name: "设置导航",
    });
    await settingsNavigation
      .getByRole("button", { name: "飞书", exact: true })
      .click();

    await expect(main.getByRole("heading", { name: "飞书" })).toBeVisible();
    await expect(
      main.getByText(
        "零服务器本地直连；每个用户拥有独立的飞书连接应用与凭据。",
        { exact: true },
      ),
    ).toBeVisible();
    const connectionMode = main
      .locator(".settings-row")
      .filter({ hasText: "连接方式" })
      .locator("select");
    await expect(connectionMode).toHaveValue("personal-direct");
    await expect(connectionMode.locator('option[value="personal-direct"]')).toHaveText(
      "一键连接（推荐 · 零服务器）",
    );
    await expect(connectionMode.locator('option[value="existing-direct"]')).toHaveText(
      "使用已有飞书应用（零服务器）",
    );
    await expect(
      main.getByRole("button", { name: "一键连接飞书", exact: true }),
    ).toBeVisible();
    await expect(main.getByText("零服务器", { exact: true })).toBeVisible();
    await expect(
      main.getByText(
        "App Secret 与 Token 只保存在系统凭据库；任务直接连接飞书",
        { exact: true },
      ),
    ).toBeVisible();

    await connectionMode.selectOption("existing-direct");
    await expect(connectionMode).toHaveValue("existing-direct");
    await expect(
      main.getByText("填写已审核或已发布应用的 App ID", { exact: true }),
    ).toBeVisible();
    await expect(
      main.getByText(
        "跳过应用创建，使用 Device OAuth 在浏览器授权任务权限",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: "连接已有应用", exact: true }),
    ).toBeVisible();
    await expect(
      main.getByText("确认开发者模式风险", { exact: true }),
    ).toHaveCount(0);
  });
});
