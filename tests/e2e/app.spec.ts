import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      TODO_AGENT_E2E_BACKGROUND: "1",
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
  if (await skip.isVisible().catch(() => false)) await skip.click({ force: true });
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
      { label: "文档中心", heading: "Todo Agent 项目文档" },
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

  test("exposes a local task reminder budget and ignore backoff in Settings", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    await main.getByRole("button", { name: "设置", exact: true }).click();
    const settingsNavigation = main.getByRole("navigation", { name: "设置导航" });
    await settingsNavigation.getByRole("button", { name: "提醒", exact: true }).click();
    await expect(main.getByRole("heading", { name: "提醒", exact: true })).toBeVisible();

    const budget = main.getByLabel("每日任务提醒预算");
    await expect(budget).toHaveValue("8");
    await budget.fill("5");
    await budget.press("Enter");
    await expect(budget).toHaveValue("5");
    await expect(main.getByText("同一任务连续关闭两次提醒后不再重复打扰", { exact: false })).toBeVisible();
    const interval = main.getByLabel("同类任务提醒间隔");
    await expect(interval).toHaveValue("120");
    await interval.fill("60");
    await interval.press("Enter");
    await expect(interval).toHaveValue("60");
    await main.getByLabel("本地任务提醒策略").selectOption("important-only");
    const persisted = await main.evaluate(async () => window.desktopApi!.settings.get());
    expect(persisted.notifications.dailyTaskReminderLimit).toBe(5);
    expect(persisted.notifications.taskIgnoreBackoffEnabled).toBe(true);
    expect(persisted.notifications.taskReminderMinIntervalMinutes).toBe(60);
    expect(persisted.notifications.taskReminderSourceMode.local).toBe("important-only");

    await settingsNavigation.getByRole("button", { name: "Todo Pet", exact: true }).click();
    const companionBudget = main.getByLabel("每日主动陪伴预算");
    await expect(companionBudget).toHaveValue("2");
    await companionBudget.fill("3");
    await companionBudget.press("Enter");
    await expect(companionBudget).toHaveValue("3");
    const petPersisted = await main.evaluate(async () => window.desktopApi!.settings.get());
    expect(petPersisted.pet.proactiveDailyLimit).toBe(3);
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

  test("keeps task discussions local and supports add, edit, and remove", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const title = "验收-任务讨论-本地";
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(title);
    await main.getByRole("button", { name: "保存到本地" }).click();
    const row = main.locator(".task-row", { hasText: title });
    await expect(row).toBeVisible();
    await row.locator(".task-body").click();

    const inspector = main.getByRole("complementary", { name: "任务详情" });
    const composer = inspector.getByLabel("新增任务讨论");
    await composer.fill("先确认接口契约，再开始实现。\n这是本机上下文。");
    await inspector.getByRole("button", { name: "添加讨论" }).click();
    await expect(inspector.getByText("先确认接口契约，再开始实现。", { exact: false })).toBeVisible();
    await expect(inspector.getByText("仅保存在本机；不会写回飞书", { exact: false })).toBeVisible();

    const comment = inspector.locator(".task-comment").first();
    await comment.getByRole("button", { name: "编辑" }).click();
    const edit = comment.getByLabel("编辑讨论");
    await edit.fill("已确认接口契约，继续实现。");
    await comment.getByRole("button", { name: "保存" }).click();
    await expect(comment.getByText("已确认接口契约，继续实现。", { exact: true })).toBeVisible();

    await comment.getByRole("button", { name: "删除" }).click();
    await expect(comment).toHaveCount(0);
    await expect(inspector.getByText("给未来的自己留一句上下文", { exact: false })).toBeVisible();
  });

  test("captures a collapsible private research card with source and action items", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const title = "验收-研究卡-本机上下文";
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(title);
    await main.getByRole("button", { name: "保存到本地" }).click();
    const row = main.locator(".task-row", { hasText: title });
    await expect(row).toBeVisible();
    await row.locator(".task-body").click();
    const inspector = main.getByRole("complementary", { name: "任务详情" });
    const researchTitle = inspector.getByLabel("研究卡标题");
    await researchTitle.scrollIntoViewIfNeeded();
    await researchTitle.fill("竞品定价摘要");
    const researchUrl = inspector.getByLabel("研究卡来源链接");
    await researchUrl.scrollIntoViewIfNeeded();
    await researchUrl.fill("https://example.com/pricing");
    const researchSummary = inspector.getByLabel("研究卡摘要");
    await researchSummary.scrollIntoViewIfNeeded();
    await researchSummary.fill("按团队规模分层收费，个人版强调快速上手。");
    const researchActions = inspector.getByLabel("研究卡行动项");
    await researchActions.scrollIntoViewIfNeeded();
    await researchActions.fill("验证个人版限制\n整理对比表");
    const addResearch = inspector.getByRole("button", { name: "添加研究卡", exact: true });
    await addResearch.scrollIntoViewIfNeeded();
    await addResearch.click();

    const card = inspector.locator(".research-card", { hasText: "竞品定价摘要" });
    await expect(card).toBeVisible();
    await expect(inspector).toContainText("不会写回飞书");
    await card.locator("summary").click();
    await expect(card).toHaveAttribute("open", "");
    await expect(card).toContainText("个人版限制");
    await card.locator("summary").click();
    await expect(card).not.toHaveAttribute("open", "");
    await card.locator("summary").click();
    await card.getByRole("button", { name: "移除研究卡竞品定价摘要" }).click();
    await expect(card).toHaveCount(0);
  });

  test("previews an atomic batch action and undoes it from the task list", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const titles = ["验收-批量操作-一", "验收-批量操作-二"];
    for (const title of titles) {
      await main.getByRole("button", { name: "新建", exact: true }).click();
      await main.locator("#new-title").fill(title);
      await main.getByRole("button", { name: "保存到本地" }).click();
      await expect(main.locator(".task-row", { hasText: title })).toBeVisible();
    }

    await main.getByRole("button", { name: "批量选择", exact: true }).click();
    for (const title of titles) {
      await main
        .locator(".task-row", { hasText: title })
        .locator(".bulk-select-checkbox")
        .check();
    }
    await expect(main.getByText("已选择 2 项", { exact: true })).toBeVisible();
    await main.getByRole("button", { name: "完成", exact: true }).click();
    await expect(main.getByRole("dialog", { name: "批量操作预览" })).toContainText(
      "将对 2 项任务执行“完成任务”",
    );
    await main.getByRole("button", { name: "确认执行", exact: true }).click();
    await expect(
      main.locator(".task-row.completed", { hasText: titles[0] }),
    ).toBeVisible();
    await expect(
      main.locator(".task-row.completed", { hasText: titles[1] }),
    ).toBeVisible();

    await main.getByRole("button", { name: "撤销", exact: true }).last().click();
    await expect(
      main.locator(".task-row", { hasText: titles[0] }).locator(
        `.task-checkbox[aria-label="完成${titles[0]}"]`,
      ),
    ).toBeVisible();
    await expect(
      main.locator(".task-row", { hasText: titles[1] }).locator(
        `.task-checkbox[aria-label="完成${titles[1]}"]`,
      ),
    ).toBeVisible();
  });

  test("saves and reapplies tag and date-range task filters", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const yesterday = await main.evaluate(() => {
      const date = new Date();
      date.setDate(date.getDate() - 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    });
    const highTitle = "验收-保存视图-高优先级";
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(highTitle);
    await main.locator("#new-tags").fill("研究");
    await main.locator("#new-priority").selectOption("high");
    await main.locator("#new-due").fill(`${yesterday}T08:00`);
    await main.getByRole("button", { name: "保存到本地" }).click();
    const title = "验收-保存视图-标签日期";
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(title);
    await main.locator("#new-tags").fill("研究, 发布");
    await main.locator("#new-priority").selectOption("low");
    await main.locator("#new-due").fill(`${yesterday}T09:00`);
    await main.getByRole("button", { name: "保存到本地" }).click();
    await main.getByRole("button", { name: /全部任务/u }).click();
    await main.getByRole("button", { name: "筛选", exact: true }).click();
    const filter = main.getByRole("dialog", { name: "任务筛选" });
    await expect(filter.getByLabel("标签")).toHaveValue("all");
    await filter.getByLabel("标签").selectOption("研究");
    await filter.getByLabel("日期").selectOption("overdue");
    await expect(filter.getByLabel("排序")).toHaveValue("manual");
    await filter.getByLabel("排序").selectOption("priority");
    await expect(main.locator(".task-list .task-row").first()).toContainText(highTitle);
    await expect(main.locator(".task-row", { hasText: title })).toBeVisible();
    await filter.locator("#smart-view-name").fill("逾期研究优先级");
    await filter.getByRole("button", { name: "保存", exact: true }).click();
    await expect(main.locator(".saved-view-strip").getByRole("button", { name: "逾期研究优先级", exact: true })).toBeVisible();
    await filter.getByRole("button", { name: "完成", exact: true }).click();
    await main.locator(".saved-view-strip").getByRole("button", { name: "逾期研究优先级", exact: true }).click();
    await expect(main.locator(".task-list .task-row").first()).toContainText(highTitle);
    await main.getByRole("button", { name: "筛选", exact: true }).click();
    const reopenedFilter = main.getByRole("dialog", { name: "任务筛选" });
    await reopenedFilter.getByRole("button", { name: "清除", exact: true }).click();
    await expect(reopenedFilter.getByLabel("排序")).toHaveValue("manual");
    await expect(main.locator(".task-row", { hasText: title })).toBeVisible();
  });

  test("shows subtask progress without auto-completing the parent", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    const parentTitle = "验收-子任务进度-父任务";
    const childTitle = "验收-子任务进度-子任务";
    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill(parentTitle);
    await main.getByRole("button", { name: "保存到本地" }).click();
    const row = main.locator(".task-row", { hasText: parentTitle });
    await expect(row).toBeVisible();
    await row.locator(".task-body").click();
    const inspector = main.getByRole("complementary", { name: "任务详情" });
    await expect(inspector.getByRole("textbox", { name: "任务标题", exact: true })).toHaveValue(parentTitle);
    await inspector.getByLabel("新子任务标题").fill(childTitle);
    await inspector.getByRole("button", { name: "添加子任务", exact: true }).click();
    const childCheckbox = inspector.getByLabel(`完成${childTitle}`);
    await expect(childCheckbox).toBeVisible();
    await expect(inspector.getByRole("progressbar", { name: "子任务完成进度" })).toHaveAttribute("aria-valuenow", "0");
    await childCheckbox.click();
    await expect(inspector.getByRole("progressbar", { name: "子任务完成进度" })).toHaveAttribute("aria-valuenow", "1");
    await expect(row).toContainText("子任务 1/1");
    await expect(row.locator('.task-checkbox[aria-label="完成验收-子任务进度-父任务"]')).toBeVisible();
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
      .locator(".pet-task-bubble")
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
    expect(cssAlpha(petVisual.background)).toBe(0);
    expect(petVisual.borderWidth).toBe("0px");
    expect(petVisual.boxShadow).toBe("none");
    expect(petVisual.height).toBeGreaterThanOrEqual(100);
    await expect(floating.locator(".pet-character")).toBeVisible();
    await expect(floating.locator(".floating-drag-handle")).toBeVisible();
    await expect(floating.locator(".pet-task-bubble")).toBeVisible();
    await floating
      .getByRole("button", { name: "折叠任务气泡" })
      .click();
    await expect(floating.locator(".pet-task-bubble")).toHaveClass(
      /is-collapsed/u,
    );
    await expect(floating.locator(".floating-carousel")).toBeHidden();
    await floating
      .getByRole("button", { name: "展开任务气泡" })
      .click();
    await expect(floating.locator(".floating-carousel")).toBeVisible();
    expect(
      await pet.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    expect(
      await floating.locator(".floating-drag-handle").evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    expect((await floatingWindowState(app)).movable).toBe(true);

    const beforeDrag = (await floatingWindowState(app)).position;
    const dragHandle = floating.locator(".floating-drag-handle");
    const dragBounds = await dragHandle.boundingBox();
    if (!dragBounds) throw new Error("Floating drag handle has no bounds");
    await floating.mouse.move(
      dragBounds.x + dragBounds.width / 2,
      dragBounds.y + dragBounds.height / 2,
    );
    await floating.mouse.down();
    await floating.mouse.move(
      dragBounds.x + dragBounds.width / 2 - 64,
      dragBounds.y + dragBounds.height / 2 + 42,
      { steps: 6 },
    );
    await floating.mouse.up();
    await expect
      .poll(async () => (await floatingWindowState(app!)).position)
      .not.toEqual(beforeDrag);

    const beforeBodyDrag = (await floatingWindowState(app)).position;
    const petButton = floating.locator(".pet-avatar-button");
    const petBounds = await petButton.boundingBox();
    if (!petBounds) throw new Error("Pet body has no drag bounds");
    await floating.mouse.move(
      petBounds.x + petBounds.width / 2,
      petBounds.y + petBounds.height / 2,
    );
    await floating.mouse.down();
    await floating.mouse.move(
      petBounds.x + petBounds.width / 2 + 52,
      petBounds.y + petBounds.height / 2 - 34,
      { steps: 6 },
    );
    await floating.mouse.up();
    await expect
      .poll(async () => (await floatingWindowState(app!)).position)
      .not.toEqual(beforeBodyDrag);

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
      .toEqual({ width: 329, height: 184 });

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
    expect(cssAlpha(scaledVisual.background)).toBe(0);
    expect(scaledVisual.borderWidth).toBe("0px");
    expect(scaledVisual.boxShadow).toBe("none");
    expect(scaledVisual.width).toBeGreaterThanOrEqual(315);
    expect(scaledVisual.height).toBeGreaterThanOrEqual(170);
  });

  test("collapses the complete task rail into a persistent pet-only surface", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    const before = await floatingWindowState(app);
    expect(before.bounds).toEqual({ width: 438, height: 184 });
    await floating.getByRole("button", { name: "收起宠物任务栏" }).click();

    await expect(floating.locator(".floating-shell")).toHaveClass(/is-pet-only/u);
    await expect(floating.locator(".pet-character")).toBeVisible();
    await expect(floating.locator(".pet-bubble-stack")).toBeHidden();
    await expect(floating.locator(".mini-panel")).toBeHidden();
    await expect
      .poll(async () => (await floatingWindowState(app!)).bounds)
      .toEqual({ width: 148, height: 148 });
    expect((await floatingWindowState(app)).position).toEqual(before.position);

    // A normal pet interaction must not reopen the task rail. The message is
    // retained by the behavior state but its bubble stays hidden in pet-only mode.
    await floating.locator(".pet-avatar-button").click({ position: { x: 47, y: 18 } });
    await floating.waitForTimeout(320);
    await expect(floating.locator(".floating-shell")).toHaveClass(/is-pet-only/u);
    await expect(floating.locator(".pet-reaction-bubble")).toBeHidden();

    await floating.getByRole("button", { name: "展开宠物任务栏" }).click();
    await expect(floating.locator(".floating-shell")).not.toHaveClass(/is-pet-only/u);
    await expect(floating.locator(".pet-task-bubble")).toBeVisible();
    await expect
      .poll(async () => (await floatingWindowState(app!)).bounds)
      .toEqual({ width: 438, height: 184 });

    await floating.getByRole("button", { name: "收起宠物任务栏" }).click();
    await floating.reload();
    await floating.waitForLoadState("domcontentloaded");
    await expect(floating.locator(".floating-shell")).toHaveClass(/is-pet-only/u);
    await expect(floating.getByRole("button", { name: "展开宠物任务栏" })).toBeVisible();
    await expect
      .poll(async () => (await floatingWindowState(app!)).bounds)
      .toEqual({ width: 148, height: 148 });

    // Pet-only mode still offers the radial interactions, then returns to the
    // exact pet-only footprint after that temporary surface closes.
    await floating.locator(".pet-compact").hover();
    await floating.getByRole("button", { name: "和小序互动" }).click();
    await expect(floating.getByRole("menu", { name: "宠物互动轮盘" })).toBeVisible();
    await floating.keyboard.press("Escape");
    await expect(floating.locator(".floating-shell")).toHaveClass(/is-pet-only/u);
    await expect
      .poll(async () => (await floatingWindowState(app!)).bounds)
      .toEqual({ width: 148, height: 148 });
  });

  test("opens a radial interaction wheel and runs cooperative pet games", async ({}, testInfo) => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    await floating.locator(".pet-compact").hover();
    await floating.getByRole("button", { name: "和小序互动" }).click();
    const wheel = floating.getByRole("menu", { name: "宠物互动轮盘" });
    await expect(wheel).toBeVisible();
    await expect(wheel.getByRole("menuitem")).toHaveCount(9);
    await expect(floating.locator(".floating-shell")).toHaveClass(/has-interaction-wheel/u);
    await expect(floating.locator(".pet-season-mark")).toHaveCount(0);
    await floating.screenshot({ path: testInfo.outputPath("pet-interaction-wheel.png") });

    await wheel.getByRole("menuitem", { name: "摸摸头" }).click();
    const pattedPet = floating.locator('.pet-character[data-pet-action="pet"]');
    await expect(pattedPet).toBeVisible();
    await expect(pattedPet).toHaveAttribute("data-pet-atlas-animation", "head-pat");
    const patStep = Number(await pattedPet.getAttribute("data-pet-atlas-step"));
    await expect
      .poll(async () => Number(await pattedPet.getAttribute("data-pet-atlas-step")))
      .not.toBe(patStep);
    expect(
      await pattedPet.locator(".pet-pat-hand").evaluate((element) =>
        getComputedStyle(element).animationName,
      ),
    ).toBe("pet-hand-pat");
    await floating.waitForTimeout(260);
    await floating.screenshot({ path: testInfo.outputPath("pet-head-pat-motion.png") });

    const interactionChecks = [
      { menu: "挠痒痒", action: "tickle", effect: ".pet-tickle-feather", animation: "pet-feather-tickle" },
      { menu: "击掌", action: "high-five", effect: ".pet-high-five-hand", animation: "pet-user-high-five" },
      { menu: "玩毛线球", action: "play", effect: ".pet-prop-ball", animation: "pet-ball-play" },
      { menu: "喂零食", action: "snack", effect: ".pet-prop-snack", animation: "pet-snack-bite" },
      { menu: "轻戳肚子", action: "poke", effect: ".pet-poke-finger", animation: "pet-finger-poke" },
      { menu: "一起休息", action: "drink", effect: ".pet-prop-cup", animation: "pet-sip" },
    ] as const;
    for (const check of interactionChecks) {
      await floating.locator(".pet-compact").hover();
      await floating.getByRole("button", { name: "和小序互动" }).click();
      await floating.getByRole("menuitem", { name: check.menu }).click();
      const activePet = floating.locator(`.pet-character[data-pet-action="${check.action}"]`);
      await expect(activePet).toBeVisible();
      expect(
        await activePet.locator(check.effect).evaluate((element) =>
          getComputedStyle(element).animationName,
        ),
      ).toBe(check.animation);
      await floating.waitForTimeout(180);
      await floating.screenshot({ path: testInfo.outputPath(`pet-${check.action}-motion.png`) });
    }

    await floating.locator(".pet-compact").hover();
    await floating.getByRole("button", { name: "和小序互动" }).click();

    await floating.getByRole("menuitem", { name: "开始镜像伸展" }).click();
    const stretch = floating.getByRole("region", { name: "镜像伸展小游戏" });
    await expect(stretch).toBeVisible();
    await expect(stretch.locator(".pet-game-character .pet-character")).toBeVisible();
    await floating.screenshot({ path: testInfo.outputPath("pet-stretch-mirror.png") });
    await stretch.getByRole("button", { name: "我跟上了" }).click();
    await stretch.getByRole("button", { name: "我跟上了" }).click();
    await stretch.getByRole("button", { name: "我跟上了" }).click();
    await stretch.getByRole("button", { name: "一起完成" }).click();
    await expect(stretch).toBeHidden();
    await expect
      .poll(async () =>
        main.evaluate(async () =>
          (await window.desktopApi!.pet.snapshot()).miniGames[0]?.game,
        ),
      )
      .toBe("stretch-mirror");

    await floating.locator(".pet-compact").hover();
    await floating.getByRole("button", { name: "和小序互动" }).click();
    await floating.getByRole("menuitem", { name: "开始协作跳绳" }).click();
    const rope = floating.getByRole("region", { name: "协作跳绳小游戏" });
    await expect(rope).toBeVisible();
    const jumpButton = rope.getByRole("button", { name: "让宠物跳起来" });
    await expect(jumpButton).toBeVisible();
    const ropePet = rope.locator('.pet-character[data-pet-action="jump-rope-ready"]');
    await expect(ropePet).toBeVisible();
    await expect(ropePet.locator(".pet-jump-rope-back")).toHaveCount(1);
    await expect(ropePet.locator(".pet-jump-rope-front")).toHaveCount(1);
    await expect(jumpButton).toHaveClass(/is-ready/u);
    await floating.screenshot({ path: testInfo.outputPath("pet-jump-rope-ready.png") });
    const jumpingPet = rope.locator('.pet-character[data-pet-action="jump-rope"]');
    // The game intentionally has a timing window. Retry only the test click
    // until it lands in the visible cue so a slow CI paint cannot turn this
    // visual regression check into a random miss.
    for (let attempt = 0; attempt < 30 && (await jumpingPet.count()) === 0; attempt += 1) {
      await jumpButton.click();
      if ((await jumpingPet.count()) > 0) break;
      await floating.waitForTimeout(80);
    }
    await expect(jumpingPet).toBeVisible();
    expect(
      await jumpingPet.locator(".pet-rig").evaluate((element) =>
        getComputedStyle(element).animationName,
      ),
    ).toBe("pet-rope-jump");
    await floating.waitForTimeout(120);
    await floating.screenshot({ path: testInfo.outputPath("pet-jump-rope-motion.png") });
    await floating.waitForTimeout(350);
    await floating.screenshot({ path: testInfo.outputPath("pet-jump-rope-overhead.png") });
    await rope.getByRole("button", { name: "退出小游戏" }).click();
    await expect(rope).toBeHidden();
  });

  test("runs the native Todo Pet focus loop and exposes the shared growth home", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const navigation = main.getByRole("navigation", { name: "主导航" });
    await navigation.getByRole("button", { name: "小窝", exact: true }).click();
    await expect(main.getByRole("heading", { name: "小序的小窝" })).toBeVisible();
    await expect(main.getByRole("button", { name: "成长" })).toHaveClass(/active/u);
    await expect(main.getByText(/亲密度 0/u)).toBeVisible();
    await expect(main.getByRole("region", { name: "弹性习惯" })).toBeVisible();
    await expect(main.getByRole("region", { name: /今日进展|今晚回顾/u })).toBeVisible();
    await main.getByRole("region", { name: "弹性习惯" }).getByRole("button", { name: "完成一次" }).first().click();
    await expect(main.getByRole("region", { name: "弹性习惯" }).getByRole("button", { name: "已记下" }).first()).toBeVisible();
    const weeklyCheckin = main.getByRole("region", { name: "每周 Check-in" });
    await expect(weeklyCheckin).toBeVisible();
    await weeklyCheckin.getByRole("button", { name: "集中火力" }).click();
    await weeklyCheckin.getByLabel("想留一句话吗（可选）").fill("这周先守住一个重要节奏");
    await weeklyCheckin.getByRole("button", { name: "记下本周节奏" }).click();
    await expect(weeklyCheckin).toContainText("本周已记下");
    await expect(weeklyCheckin).toContainText("这周先守住一个重要节奏");
    await expect(main.getByRole("region", { name: "宠物回顾" })).toBeVisible();
    await expect(main.getByRole("region", { name: "宠物回顾" })).toContainText("暂时没有逾期");

    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");
    await floating.getByRole("button", { name: "展开 小序" }).click();
    await floating.getByRole("button", { name: "专注", exact: true }).click();
    await expect(floating.locator(".pet-focus-timer")).toHaveText("25:00");
    await floating
      .getByRole("button", { name: /25.*轻专注/u })
      .click();
    await expect(floating.getByText(/专注 · 第 1\/4 轮/u)).toBeVisible();
    const compactFocusBubble = floating.locator(".pet-focus-bubble");
    await expect(compactFocusBubble).toBeVisible();
    await expect(
      compactFocusBubble.getByRole("button", { name: "暂停专注计时" }),
    ).toBeVisible();
    await compactFocusBubble
      .getByRole("button", { name: "折叠专注气泡" })
      .click();
    await expect(compactFocusBubble).toHaveClass(/is-collapsed/u);
    await compactFocusBubble
      .getByRole("button", { name: "展开专注气泡" })
      .click();
    await expect(
      floating.getByRole("button", { name: "暂停", exact: true }),
    ).toBeVisible();
    await floating
      .getByRole("button", { name: "暂停", exact: true })
      .click();
    await expect(
      floating.getByRole("button", { name: "继续", exact: true }),
    ).toBeVisible();
    await floating
      .getByRole("button", { name: "继续", exact: true })
      .click();
    await expect(
      floating.getByRole("button", { name: "暂停", exact: true }),
    ).toBeVisible();
    await floating
      .getByRole("button", { name: "结束", exact: true })
      .click();
    await expect(floating.locator(".pet-focus-timer")).toHaveText("25:00");
  });

  test("makes the pet itself react and keeps room, adventure, and play features operable", async ({}, testInfo) => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const floating = await windowFor(app, "floating");
    await floating.waitForLoadState("domcontentloaded");

    const avatar = floating.locator(".pet-avatar-button");
    await avatar.click({ position: { x: 47, y: 18 } });
    await expect(floating.locator(".floating-shell")).toHaveAttribute(
      "data-pet-action",
      "pet",
    );
    await expect(floating.getByText("嗯，再摸一下也可以。", { exact: true })).toBeVisible();
    await expect(floating.locator(".pet-quick-replies")).toBeVisible();
    await expect(floating.locator(".floating-shell")).toHaveClass(/is-expanded/u);
    await expect(floating.locator(".floating-shell")).toHaveClass(/has-pet-reaction/u);
    const reactionLayout = await floating.evaluate(() => {
      const reaction = document.querySelector<HTMLElement>(".pet-reaction-bubble");
      const taskBubble = document.querySelector<HTMLElement>(".pet-task-bubble");
      if (!reaction || !taskBubble) throw new Error("Pet bubbles are missing");
      const reactionRect = reaction.getBoundingClientRect();
      const taskRect = taskBubble.getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        reactionTop: reactionRect.top,
        reactionBottom: reactionRect.bottom,
        taskTop: taskRect.top,
      };
    });
    expect(reactionLayout.reactionTop).toBeGreaterThanOrEqual(0);
    expect(reactionLayout.reactionBottom).toBeLessThanOrEqual(reactionLayout.taskTop - 4);
    expect(reactionLayout.reactionBottom).toBeLessThanOrEqual(reactionLayout.viewportHeight);
    await floating.getByRole("button", { name: "折叠宠物消息气泡" }).click();
    await expect(floating.locator(".pet-reaction-bubble")).toHaveClass(/is-collapsed/u);
    await expect(floating.locator(".pet-reaction-bubble-body")).toBeHidden();
    await expect(floating.locator(".floating-shell")).toHaveClass(/pet-reaction-collapsed/u);
    await floating.getByRole("button", { name: "展开宠物消息气泡" }).click();
    await expect(floating.getByText("嗯，再摸一下也可以。", { exact: true })).toBeVisible();
    await avatar.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", "https://example.com/research");
      element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer }));
      element.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
    });
    await expect(floating.getByRole("region", { name: "宠物收到的拖入内容" })).toBeVisible();
    await floating.getByRole("button", { name: "带入聊聊" }).click();
    await expect(floating.getByRole("button", { name: "聊聊", exact: true })).toHaveClass(/active/u);
    await floating.screenshot({
      path: testInfo.outputPath("pet-expanded-reaction-safe-area.png"),
    });

    const navigation = main.getByRole("navigation", { name: "主导航" });
    await navigation.getByRole("button", { name: "小窝", exact: true }).click();
    await main.getByRole("button", { name: "小房间" }).click();
    await expect(main.locator(".pet-room-stage")).toBeVisible();
    await main.getByLabel("身体配色").selectOption("mint");
    await expect(main.locator(".pet-room-stage .pet-palette-mint")).toBeVisible();

    await main.getByRole("button", { name: "今日冒险" }).click();
    await expect(main.locator(".pet-adventure-card")).toBeVisible();
    await main.getByRole("button", { name: "先整理线索" }).click();
    await expect(main.getByText(/你和小序把线索铺成一排/u)).toBeVisible();

    await main.getByRole("button", { name: "一起玩" }).click();
    await main.getByRole("button", { name: "开始接星星" }).click();
    await main.getByRole("button", { name: "接住星星" }).click();
    await expect(main.getByText(/20s · 1 颗/u)).toBeVisible();
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

    // Lightweight pet interactions stay on the desktop surface, expose a
    // distinct body action, and use the existing idempotent relationship
    // reward path instead of opening a distracting game window.
    const intimacyBefore = await main.evaluate(async () =>
      (await window.desktopApi!.pet.snapshot()).profile.intimacy
    );
    await openPetMenu();
    await menu.getByRole("menuitem", { name: /摸摸小序/u }).click();
    await expect(menu).toBeHidden();
    await expect(floating.locator(".floating-shell")).toHaveAttribute(
      "data-pet-action",
      "pet",
    );
    await expect(floating.getByRole("status").filter({ hasText: "再摸一下也可以" })).toBeVisible();
    await expect
      .poll(() =>
        main.evaluate(async () =>
          (await window.desktopApi!.pet.snapshot()).profile.intimacy
        ),
      )
      .toBe(intimacyBefore + 1);

    await openPetMenu();
    await menu.getByRole("menuitem", { name: /玩一会儿/u }).click();
    await expect(floating.locator(".floating-shell")).toHaveAttribute(
      "data-pet-action",
      "play",
    );
    await expect(floating.getByText("接住毛线球！")).toBeVisible();

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
      "agentActivity",
      "capture",
      "data",
      "events",
      "feishu",
      "notifications",
      "pet",
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

  test("manages a local project entity without duplicating task data", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const navigation = main.getByRole("navigation", { name: "主导航" });
    await navigation.getByRole("button", { name: "项目", exact: true }).click();
    await expect(main.getByRole("main", { name: "项目总览" })).toBeVisible();

    await main.getByLabel("新项目名称").fill("研究空间");
    await main.getByRole("button", { name: "新建项目", exact: true }).click();
    const card = main.locator(".project-card", { hasText: "研究空间" });
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "重命名研究空间" }).click();
    await main.getByLabel("重命名项目").fill("研究空间 2");
    await main.getByRole("button", { name: "保存项目名称" }).click();
    await expect(card).toContainText("研究空间 2");

    await card.getByRole("button", { name: "归档研究空间 2" }).click();
    await expect(card).toContainText("已归档");
    await card.getByRole("button", { name: "恢复研究空间 2" }).click();
    await expect(card).not.toContainText("已归档");

    await card.getByRole("button", { name: "删除研究空间 2" }).click();
    await card.getByRole("button", { name: "确认删除研究空间 2" }).click();
    await expect(card).toHaveCount(0);
  });

  test("manages a local list entity and associates a task", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const navigation = main.getByRole("navigation", { name: "主导航" });
    await navigation.getByRole("button", { name: "清单", exact: true }).click();
    await expect(main.getByRole("main", { name: "清单管理" })).toBeVisible();

    await main.getByLabel("新清单名称").fill("周末安排");
    await main.getByRole("button", { name: "新建清单", exact: true }).click();
    const card = main.locator(".project-card", { hasText: "周末安排" });
    await expect(card).toBeVisible();

    await main.getByRole("button", { name: "新建", exact: true }).click();
    await main.locator("#new-title").fill("清单关联任务");
    await main.locator("#new-list").fill("周末安排");
    await main.getByRole("button", { name: "保存到本地" }).click();
    await expect(card).toContainText("清单关联任务");

    await card.getByRole("button", { name: "重命名周末安排" }).click();
    await main.getByLabel("重命名清单").fill("周末安排 2");
    await main.getByRole("button", { name: "保存清单名称" }).click();
    await expect(card).toContainText("周末安排 2");
    await card.getByRole("button", { name: "删除周末安排 2" }).click();
    await card.getByRole("button", { name: "确认删除周末安排 2" }).click();
    await expect(card).toHaveCount(0);
  });

  test("previews a private local text attachment without opening a system window", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);
    const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    const attachmentId = "e2e-preview-text";
    const attachmentPath = path.join(userDataPath, "attachments", `${attachmentId}-notes.md`);
    await mkdir(path.dirname(attachmentPath), { recursive: true });
    await writeFile(attachmentPath, "# 私人预览\n\n这段内容只在任务详情中显示。", "utf8");
    const taskId = await main.evaluate(async ({ attachmentId: id, localPath }) => {
      const api = window.desktopApi;
      if (!api) throw new Error("Desktop API is unavailable");
      const created = await api.tasks.create({ title: "附件预览验收", source: { type: "local" } });
      await api.tasks.update({
        id: created.task.id,
        patch: {
          attachments: [{ id, name: "notes.md", mimeType: "text/markdown", localPath }],
        },
      });
      return created.task.id;
    }, { attachmentId, localPath: attachmentPath });
    const windowCountBeforePreview = app.windows().length;

    await main.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /全部任务/u }).click();
    const row = main.locator(".task-row", { hasText: "附件预览验收" });
    await expect(row).toBeVisible();
    await main.getByLabel("搜索任务").fill("notes.md");
    await expect(main.locator(".task-row", { hasText: "附件预览验收" })).toBeVisible();
    await main.getByLabel("搜索任务").fill("");
    await row.locator(".task-body").click();
    await expect(main.getByLabel("预览附件notes.md")).toBeVisible();
    await main.getByLabel("预览附件notes.md").click();
    const preview = main.getByRole("dialog", { name: "notes.md" });
    await expect(preview).toBeVisible();
    await expect(preview.locator(".attachment-preview-text")).toContainText("私人预览");
    await preview.getByRole("button", { name: "关闭附件预览" }).click();
    await expect(preview).toBeHidden();
    expect(app.windows().length).toBe(windowCountBeforePreview);
    expect(taskId).toBeTruthy();
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

    const dependencyId = await main.evaluate(async () => {
      const api = window.desktopApi;
      if (!api) throw new Error("Desktop API is unavailable");
      const result = await api.tasks.create({
        title: "验收前置依赖",
        source: { type: "local" },
      });
      return result.task.id;
    });

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
    await expect(
      main.locator("#task-dependencies option", { hasText: "验收前置依赖" }),
    ).toBeVisible();
    await expect(main.getByText("创建任务", { exact: true })).toBeVisible();
    await main.locator("#task-dependencies").selectOption(dependencyId);
    await expect(main.locator("#task-dependencies")).toHaveValues([dependencyId]);
    await expect(
      main.getByText("还有 1 项前置任务未完成", { exact: true }),
    ).toBeVisible();
    await main.locator("#task-link-url").fill("file:///tmp/private.txt");
    await main.getByRole("button", { name: "添加链接", exact: true }).click();
    await expect(
      main.getByText("链接只支持 http 或 https 地址", { exact: true }),
    ).toBeVisible();
    await main.locator("#task-link-url").fill("https://example.com/验收");
    await main.locator("#task-link-label").fill("验收资料");
    await main.getByRole("button", { name: "添加链接", exact: true }).click();
    await expect(
      main.locator(".task-link-open", { hasText: "验收资料" }),
    ).toBeVisible();
    await main.locator("#custom-field-key").fill("客户");
    await main.locator("#custom-field-value").fill("Todo Agent");
    await main.getByRole("button", { name: "添加字段", exact: true }).click();
    await expect(
      main.locator(".custom-field-row", { hasText: "客户" }),
    ).toContainText("Todo Agent");
    await main.getByRole("button", { name: "移除自定义字段客户", exact: true }).click();
    await expect(main.locator(".custom-field-row", { hasText: "客户" })).toHaveCount(0);
    await main.locator("#custom-field-key").fill("预计人数");
    await main.locator("#custom-field-type").selectOption("number");
    await main.locator("#custom-field-value").fill("3.5");
    await main.getByRole("button", { name: "添加字段", exact: true }).click();
    await expect(main.locator(".custom-field-row", { hasText: "预计人数" })).toContainText("3.5");
    await main.getByRole("button", { name: "移除自定义字段预计人数", exact: true }).click();
    await main.locator("#custom-field-key").fill("需要回访");
    await main.locator("#custom-field-type").selectOption("checkbox");
    await main.locator("#custom-field-value").selectOption("true");
    await main.getByRole("button", { name: "添加字段", exact: true }).click();
    await expect(main.locator(".custom-field-row", { hasText: "需要回访" })).toContainText("已勾选");
    await main.getByRole("button", { name: "移除自定义字段需要回访", exact: true }).click();
    await main.locator("#task-attachment-url").fill("file:///tmp/private.pdf");
    await main.getByRole("button", { name: "添加附件", exact: true }).click();
    await expect(
      main.getByText("附件只支持 http 或 https 地址", { exact: true }),
    ).toBeVisible();
    await main.locator("#task-attachment-name").fill("验收文档");
    await main.locator("#task-attachment-url").fill("https://example.com/验收.pdf");
    await main.getByRole("button", { name: "添加附件", exact: true }).click();
    await expect(
      main.locator(".task-attachment-open", { hasText: "验收文档" }),
    ).toBeVisible();
    await main.getByRole("button", { name: "移除附件验收文档", exact: true }).click();
    await expect(main.locator(".task-attachment-row", { hasText: "验收文档" })).toHaveCount(0);

    await main.getByLabel("任务标题", { exact: true }).fill(editedTitle);
    await main.getByLabel("任务标题", { exact: true }).press("Tab");
    await expect(main.locator(".task-row", { hasText: editedTitle })).toBeVisible();
    await expect(main.getByText("标题", { exact: true })).toBeVisible();
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

    await navigation.getByRole("button", { name: "项目", exact: true }).click();
    await expect(main.getByRole("heading", { name: "项目", exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: "更新后的项目", exact: true })).toBeVisible();
    await main.locator(".project-task-row", { hasText: editedTitle }).click();
    await expect(main.getByLabel("任务标题", { exact: true })).toHaveValue(editedTitle);

    await main.getByLabel(`完成${editedTitle}`).click();
    await expect(
      navigation.getByRole("button", { name: /已完成.*1/u }),
    ).toBeVisible();
    await navigation.getByRole("button", { name: /已完成/u }).click();
    await expect(main.getByText(editedTitle, { exact: true }).first()).toBeVisible();
    await main.getByLabel(`恢复${editedTitle}`).click();
    await expect(main.getByText(editedTitle, { exact: true })).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: /全部任务.*2/u }),
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
    await app.evaluate(({ clipboard }) => clipboard.writeText("来自剪贴板的上下文"));
    await quick.getByRole("button", { name: "剪贴板", exact: true }).click();
    await expect(quick.getByRole("region", { name: "剪贴板上下文预览" })).toBeVisible();
    await quick.getByRole("button", { name: "带入输入框" }).click();
    await expect(input).toHaveValue("来自剪贴板的上下文");
    await quick.getByRole("button", { name: "关闭剪贴板预览" }).click();
    await quick.getByRole("button", { name: "当前窗口", exact: true }).click();
    await expect(quick.getByRole("region", { name: "当前窗口上下文预览" })).toBeVisible();
    await quick.getByRole("button", { name: "关闭当前窗口预览" }).click();
    await quick.getByRole("button", { name: "选中文本", exact: true }).click();
    await expect(quick.getByRole("region", { name: "选中文本上下文预览" })).toBeVisible();
    await quick.getByRole("button", { name: "关闭选中文本预览" }).click();
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
    await floating.locator(".mini-content").hover();
    await floating.waitForTimeout(320);
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
    await expect.poll(async () => floating.locator(".floating-shell").evaluate((element) =>
      element.classList.contains("privacy-mode"),
    )).toBe(false);
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
    // The isolated profile may restore the last main-app route from an earlier
    // scenario; bring the shared task surface back to Today before asserting
    // the cross-window fallback copy.
    await main
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: /^今天(?: \d+)?$/u })
      .click();
    await expect(main.getByRole("heading", { name: /今天有/u })).toBeVisible();
    await expect(main.getByLabel("给 Agent 发消息")).toBeHidden();

    await main.screenshot({
      path: path.join(projectRoot, "test-results", "main-window.png"),
    });
  });

  test("previews and creates a built-in workflow template from quick capture", async () => {
    app = await launch(profilePath);
    const main = await windowFor(app, "main");
    await main.waitForLoadState("domcontentloaded");
    await finishOnboarding(main);

    await main.evaluate(() => window.desktopApi?.shell.showQuickCapture());
    const quick = await windowFor(app, "quick");
    await quick.waitForLoadState("domcontentloaded");
    const input = quick.getByRole("textbox", { name: "快速录入" });
    await input.fill("Todo Pet 发布说明");
    await quick.getByLabel("工作流模板选择").selectOption("publish-article");
    const preview = quick.getByRole("region", { name: "工作流模板预览" });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("发布文章");
    await expect(preview).toContainText("确认后会创建 3 项任务");
    await expect(preview).toContainText("列出提纲：Todo Pet 发布说明");
    await quick.getByRole("button", { name: "保存到本地" }).click();

    await main.evaluate(() => window.desktopApi?.shell.showMain("all"));
    await expect(main.getByRole("button", { name: /^列出提纲：Todo Pet 发布说明/u })).toBeVisible();
    await expect(main.getByRole("button", { name: /^完成初稿：Todo Pet 发布说明/u })).toBeVisible();
    await expect(main.getByRole("button", { name: /^校对并发布：Todo Pet 发布说明/u })).toBeVisible();
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
      expect.stringContaining("停留 0.3 秒或单击展开"),
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
      expect.stringContaining("停留 1.6 秒或单击展开"),
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
    // The previous test may leave the OS pointer over the same screen area
    // where the new floating window appears. Move it to the transparent
    // corner so this assertion exercises automatic rotation, not hover pause.
    await main.mouse.move(1, 1);
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
        .toEqual({ width: 480, height: 640 });
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
