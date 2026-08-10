import {
  FEISHU_OPEN_API_BASE_URL,
  type FeishuApiEnvelope,
  type FeishuAuthConfig,
  type FeishuCreateTaskPayload,
  type FeishuFetch,
  type FeishuListTasksOptions,
  type FeishuPatchTaskPayload,
  type FeishuTaskApi,
  type FeishuTaskListPage,
  type FeishuTaskMember,
  type FeishuTasklistMembership,
  type FeishuTaskV2,
  type FeishuTokenSet,
  type FeishuTokenStore,
} from "../../src/shared/feishu-types";
import { FeishuOAuthError, refreshUserToken } from "./oauth-flow";

export interface FeishuClientOptions {
  auth: FeishuAuthConfig;
  tokenStore: FeishuTokenStore;
  fetch?: FeishuFetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Number of retries after an HTTP 429. Defaults to 2. */
  maxRateLimitRetries?: number;
  /** Refresh this far ahead of access-token expiry. Defaults to one minute. */
  refreshSkewMs?: number;
  /** Primarily useful for a local mock server in tests. */
  apiBaseUrl?: string;
}

interface ErrorDetails {
  status?: number;
  code?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class FeishuApiError extends Error {
  readonly status?: number;
  readonly code?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(message: string, details: ErrorDetails = {}) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "FeishuApiError";
    this.status = details.status;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
    this.retryable =
      details.status === 429 ||
      details.status === undefined ||
      (details.status >= 500 && details.status <= 599);
  }
}

export class FeishuAuthenticationError extends FeishuApiError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "FeishuAuthenticationError";
  }
}

export class FeishuPermissionError extends FeishuApiError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "FeishuPermissionError";
  }
}

/**
 * A scoped, actionable permission failure for Task v2 tasklist operations.
 * It never triggers OAuth itself—the desktop controller can tell the user to
 * enable the required scope and explicitly reauthorize instead.
 */
export class FeishuTasklistPermissionError extends FeishuPermissionError {
  readonly requiredScope: "task:tasklist:read" | "task:tasklist:write";

  constructor(
    access: "read" | "write",
    details: ErrorDetails = {},
  ) {
    const requiredScope =
      access === "write" ? "task:tasklist:write" : "task:tasklist:read";
    super(
      `Feishu tasklist access requires ${requiredScope}; enable it for the app and reauthorize the user.`,
      details,
    );
    this.name = "FeishuTasklistPermissionError";
    this.requiredScope = requiredScope;
  }
}

export class FeishuNotFoundError extends FeishuApiError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "FeishuNotFoundError";
  }
}

export class FeishuConflictError extends FeishuApiError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "FeishuConflictError";
  }
}

export class FeishuRateLimitError extends FeishuApiError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "FeishuRateLimitError";
  }
}

export class FeishuNetworkError extends FeishuApiError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details);
    this.name = "FeishuNetworkError";
  }
}

function typedRefreshFailure(error: unknown): Error {
  if (!(error instanceof FeishuOAuthError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const details: ErrorDetails = {
    status: error.status,
    code: error.code,
    cause: error,
  };
  if (error.status === 429) {
    return new FeishuRateLimitError(
      "Feishu token refresh was rate limited.",
      details,
    );
  }
  if (error.status === undefined || error.status >= 500) {
    return new FeishuNetworkError(
      "Feishu token refresh is temporarily unavailable.",
      details,
    );
  }
  return new FeishuAuthenticationError(
    "The Feishu refresh token was rejected.",
    details,
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function responseMessage(value: unknown, fallback: string): string {
  if (isRecord(value)) {
    if (typeof value.msg === "string" && value.msg) return value.msg;
    if (typeof value.message === "string" && value.message)
      return value.message;
  }
  return fallback;
}

function responseCode(value: unknown): number | undefined {
  return isRecord(value) && typeof value.code === "number"
    ? value.code
    : undefined;
}

function retryAfterMilliseconds(response: Response, now: () => number): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 1_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now()) : 1_000;
}

function errorForResponse(
  response: Response,
  body: unknown,
  now: () => number,
): FeishuApiError {
  const details: ErrorDetails = {
    status: response.status,
    code: responseCode(body),
  };
  const message = responseMessage(
    body,
    `Feishu API request failed with HTTP ${response.status}.`,
  );
  if (response.status === 401)
    return new FeishuAuthenticationError(message, details);
  if (response.status === 403)
    return new FeishuPermissionError(message, details);
  if (response.status === 404) return new FeishuNotFoundError(message, details);
  if (response.status === 409) return new FeishuConflictError(message, details);
  if (response.status === 429) {
    details.retryAfterMs = retryAfterMilliseconds(response, now);
    return new FeishuRateLimitError(message, details);
  }
  return new FeishuApiError(message, details);
}

function asTask(value: unknown): FeishuTaskV2 {
  const candidate =
    isRecord(value) && isRecord(value.task) ? value.task : value;
  if (!isRecord(candidate) || typeof candidate.guid !== "string") {
    throw new FeishuApiError("Feishu Task v2 response did not contain a task.");
  }
  return candidate as unknown as FeishuTaskV2;
}

export class FeishuClient implements FeishuTaskApi {
  private readonly auth: FeishuAuthConfig;
  private readonly tokenStore: FeishuTokenStore;
  private readonly fetchImpl: FeishuFetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly refreshSkewMs: number;
  private readonly apiBaseUrl: string;
  private refreshInFlight?: Promise<FeishuTokenSet>;

  constructor(options: FeishuClientOptions) {
    this.auth = options.auth;
    this.tokenStore = options.tokenStore;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRateLimitRetries = Math.max(0, options.maxRateLimitRetries ?? 2);
    this.refreshSkewMs = Math.max(0, options.refreshSkewMs ?? 60_000);
    this.apiBaseUrl = stripTrailingSlash(
      options.apiBaseUrl ??
        (options.auth.mode === "relay"
          ? `${stripTrailingSlash(options.auth.relayBaseUrl)}/feishu/open-apis`
          : FEISHU_OPEN_API_BASE_URL),
    );
  }

  private async currentToken(): Promise<FeishuTokenSet> {
    const token = await this.tokenStore.read();
    if (!token) {
      throw new FeishuAuthenticationError(
        "No Feishu user token is available.",
        {
          status: 401,
        },
      );
    }
    if (token.expiresAt <= this.now() + this.refreshSkewMs) {
      return this.refreshToken(token);
    }
    return token;
  }

  private async refreshToken(
    staleToken: FeishuTokenSet,
  ): Promise<FeishuTokenSet> {
    const latest = await this.tokenStore.read();
    if (
      latest &&
      latest.accessToken !== staleToken.accessToken &&
      latest.expiresAt > this.now() + this.refreshSkewMs
    ) {
      return latest;
    }

    if (this.refreshInFlight) return this.refreshInFlight;
    if (!staleToken.refreshToken) {
      throw new FeishuAuthenticationError(
        "The Feishu user token cannot be refreshed.",
        {
          status: 401,
        },
      );
    }
    if (
      staleToken.refreshTokenExpiresAt !== undefined &&
      staleToken.refreshTokenExpiresAt <= this.now()
    ) {
      throw new FeishuAuthenticationError(
        "The Feishu refresh token has expired.",
        {
          status: 401,
        },
      );
    }

    const expectedRefreshToken = staleToken.refreshToken;
    const refresh = (async (): Promise<FeishuTokenSet> => {
      let refreshed: FeishuTokenSet;
      try {
        refreshed = await refreshUserToken(
          this.auth,
          expectedRefreshToken,
          {
            fetch: this.fetchImpl,
            now: this.now,
          },
        );
      } catch (error) {
        throw typedRefreshFailure(error);
      }
      const next: FeishuTokenSet = {
        ...refreshed,
        openId: refreshed.openId ?? staleToken.openId,
      };
      const committed = await this.tokenStore.compareAndSwap(
        expectedRefreshToken,
        next,
      );
      if (committed) return next;

      // Another process/window won the refresh-token rotation. Use its token
      // instead of trying the now-invalid single-use refresh token again.
      const winner = await this.tokenStore.read();
      if (winner && winner.accessToken !== staleToken.accessToken)
        return winner;
      throw new FeishuAuthenticationError(
        "The refreshed token could not be committed atomically.",
        { status: 401 },
      );
    })();

    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    }
  }

  private url(path: string, query?: URLSearchParams): string {
    const url = new URL(`${this.apiBaseUrl}/${path.replace(/^\/+/, "")}`);
    if (query) url.search = query.toString();
    return url.toString();
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    query?: URLSearchParams,
  ): Promise<T> {
    let token = await this.currentToken();
    let refreshedAfterUnauthorized = false;
    let rateLimitRetries = 0;

    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(path, query), {
          ...init,
          headers: {
            accept: "application/json",
            ...(init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...init.headers,
            authorization: `${token.tokenType || "Bearer"} ${token.accessToken}`,
          },
        });
      } catch (error) {
        throw new FeishuNetworkError(
          `Feishu is unreachable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        token = await this.refreshToken(token);
        continue;
      }

      if (
        response.status === 429 &&
        rateLimitRetries < this.maxRateLimitRetries
      ) {
        rateLimitRetries += 1;
        await this.sleep(retryAfterMilliseconds(response, this.now));
        continue;
      }

      const body = await responseJson(response);
      if (!response.ok) throw errorForResponse(response, body, this.now);
      if (body === undefined) return undefined as T;

      if (isRecord(body) && typeof body.code === "number") {
        const envelope = body as unknown as FeishuApiEnvelope<T>;
        if (envelope.code !== 0) {
          throw new FeishuApiError(
            envelope.msg || `Feishu API returned code ${envelope.code}.`,
            { status: response.status, code: envelope.code },
          );
        }
        return envelope.data as T;
      }
      // A relay may already unwrap the official envelope.
      return body as T;
    }
  }

  async listTasksPage(
    pageToken?: string,
    options: FeishuListTasksOptions = {},
  ): Promise<FeishuTaskListPage> {
    const query = new URLSearchParams({
      page_size: String(Math.min(100, Math.max(1, options.pageSize ?? 100))),
      type: "my_tasks",
      user_id_type: "open_id",
    });
    if (options.completed !== undefined) {
      query.set("completed", String(options.completed));
    }
    if (pageToken) query.set("page_token", pageToken);

    const page = await this.request<FeishuTaskListPage>(
      "/task/v2/tasks",
      { method: "GET" },
      query,
    );
    return {
      items: Array.isArray(page?.items) ? page.items : [],
      page_token: page?.page_token,
      has_more: page?.has_more === true,
    };
  }

  async listAllTasks(
    options: FeishuListTasksOptions = {},
  ): Promise<FeishuTaskV2[]> {
    const tasks: FeishuTaskV2[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;

    for (;;) {
      const page = await this.listTasksPage(pageToken, options);
      tasks.push(...page.items);
      if (!page.has_more) return tasks;

      // `items` is intentionally not considered here: Task v2 can return an
      // empty filtered page while still advertising another page.
      if (!page.page_token || seenTokens.has(page.page_token)) {
        throw new FeishuApiError(
          "Feishu pagination reported has_more without a new page_token.",
        );
      }
      seenTokens.add(page.page_token);
      pageToken = page.page_token;
    }
  }

  async getTask(taskGuid: string): Promise<FeishuTaskV2> {
    const data = await this.request<unknown>(
      `/task/v2/tasks/${encodeURIComponent(taskGuid)}`,
      { method: "GET" },
      new URLSearchParams({ user_id_type: "open_id" }),
    );
    return asTask(data);
  }

  async createTask(
    task: FeishuCreateTaskPayload,
    clientToken: string,
  ): Promise<FeishuTaskV2> {
    if (!clientToken) {
      throw new FeishuApiError(
        "client_token is required for idempotent creation.",
      );
    }
    const data = await this.request<unknown>(
      "/task/v2/tasks",
      {
        method: "POST",
        body: JSON.stringify({ ...task, client_token: clientToken }),
      },
      new URLSearchParams({ user_id_type: "open_id" }),
    );
    return asTask(data);
  }

  async updateTask(
    taskGuid: string,
    patch: FeishuPatchTaskPayload,
  ): Promise<FeishuTaskV2> {
    const data = await this.request<unknown>(
      `/task/v2/tasks/${encodeURIComponent(taskGuid)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
      new URLSearchParams({ user_id_type: "open_id" }),
    );
    return asTask(data);
  }

  async addTaskMembers(
    taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2> {
    return this.mutateTaskMembers(taskGuid, "add_members", members, 50);
  }

  async removeTaskMembers(
    taskGuid: string,
    members: FeishuTaskMember[],
  ): Promise<FeishuTaskV2> {
    return this.mutateTaskMembers(taskGuid, "remove_members", members, 500);
  }

  private async mutateTaskMembers(
    taskGuid: string,
    action: "add_members" | "remove_members",
    members: FeishuTaskMember[],
    maximumMembers: number,
  ): Promise<FeishuTaskV2> {
    if (members.length === 0) {
      throw new FeishuApiError(
        `Task v2 ${action} requires at least one member.`,
      );
    }
    if (members.length > maximumMembers) {
      throw new FeishuApiError(
        `Task v2 ${action} accepts at most ${maximumMembers} members per request.`,
      );
    }
    const data = await this.request<unknown>(
      `/task/v2/tasks/${encodeURIComponent(taskGuid)}/${action}`,
      { method: "POST", body: JSON.stringify({ members }) },
      new URLSearchParams({ user_id_type: "open_id" }),
    );
    return asTask(data);
  }

  async listTasklists(
    taskGuid: string,
  ): Promise<FeishuTasklistMembership[]> {
    try {
      const data = await this.request<unknown>(
        `/task/v2/tasks/${encodeURIComponent(taskGuid)}/tasklists`,
        { method: "GET" },
        new URLSearchParams({ user_id_type: "open_id" }),
      );
      if (!isRecord(data) || !Array.isArray(data.tasklists)) return [];
      return data.tasklists.filter(
        (item): item is FeishuTasklistMembership =>
          isRecord(item) && typeof item.tasklist_guid === "string",
      );
    } catch (error) {
      if (error instanceof FeishuPermissionError) {
        throw new FeishuTasklistPermissionError("read", {
          status: error.status,
          code: error.code,
          cause: error,
        });
      }
      throw error;
    }
  }

  async addTaskToTasklist(
    taskGuid: string,
    tasklist: FeishuTasklistMembership,
  ): Promise<FeishuTaskV2> {
    const tasklistGuid = tasklist.tasklist_guid?.trim();
    if (!tasklistGuid) {
      throw new FeishuApiError("tasklist_guid is required for add_tasklist.");
    }
    try {
      const data = await this.request<unknown>(
        `/task/v2/tasks/${encodeURIComponent(taskGuid)}/add_tasklist`,
        {
          method: "POST",
          body: JSON.stringify({
            tasklist_guid: tasklistGuid,
            ...(tasklist.section_guid?.trim()
              ? { section_guid: tasklist.section_guid.trim() }
              : {}),
          }),
        },
        new URLSearchParams({ user_id_type: "open_id" }),
      );
      return asTask(data);
    } catch (error) {
      if (error instanceof FeishuPermissionError) {
        throw new FeishuTasklistPermissionError("write", {
          status: error.status,
          code: error.code,
          cause: error,
        });
      }
      throw error;
    }
  }

  async removeTaskFromTasklist(
    taskGuid: string,
    tasklistGuid: string,
  ): Promise<FeishuTaskV2> {
    const normalizedGuid = tasklistGuid.trim();
    if (!normalizedGuid) {
      throw new FeishuApiError(
        "tasklist_guid is required for remove_tasklist.",
      );
    }
    try {
      const data = await this.request<unknown>(
        `/task/v2/tasks/${encodeURIComponent(taskGuid)}/remove_tasklist`,
        {
          method: "POST",
          body: JSON.stringify({ tasklist_guid: normalizedGuid }),
        },
        new URLSearchParams({ user_id_type: "open_id" }),
      );
      return asTask(data);
    } catch (error) {
      if (error instanceof FeishuPermissionError) {
        throw new FeishuTasklistPermissionError("write", {
          status: error.status,
          code: error.code,
          cause: error,
        });
      }
      throw error;
    }
  }

  async deleteTask(taskGuid: string): Promise<void> {
    await this.request<void>(
      `/task/v2/tasks/${encodeURIComponent(taskGuid)}`,
      { method: "DELETE" },
      new URLSearchParams({ user_id_type: "open_id" }),
    );
  }

  async completeTask(taskGuid: string): Promise<FeishuTaskV2> {
    return this.patchCompletion(taskGuid, String(this.now()));
  }

  async reopenTask(taskGuid: string): Promise<FeishuTaskV2> {
    return this.patchCompletion(taskGuid, "0");
  }

  private async patchCompletion(
    taskGuid: string,
    completedAt: string,
  ): Promise<FeishuTaskV2> {
    // Task v2 has no /complete or /uncomplete actions. Completion is a
    // whole-task PATCH of completed_at; "0" restores the task to incomplete.
    // This differs from the similarly named Task v1 action endpoints.
    const data = await this.request<unknown>(
      `/task/v2/tasks/${encodeURIComponent(taskGuid)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          task: { completed_at: completedAt },
          update_fields: ["completed_at"],
        }),
      },
      new URLSearchParams({ user_id_type: "open_id" }),
    );
    return asTask(data);
  }
}
