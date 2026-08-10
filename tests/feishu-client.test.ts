// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  FeishuAuthenticationError,
  FeishuClient,
  FeishuConflictError,
  FeishuNetworkError,
  FeishuNotFoundError,
  FeishuPermissionError,
  FeishuRateLimitError,
  FeishuTasklistPermissionError,
} from "../electron/feishu/feishu-client";
import {
  createOAuthSession,
  exchangeAuthorizationCode,
  validateOAuthCallback,
} from "../electron/feishu/oauth-flow";
import type {
  FeishuAuthConfig,
  FeishuFetch,
  FeishuTokenSet,
  FeishuTokenStore,
} from "../src/shared/feishu-types";

const NOW = 1_800_000_000_000;

const developmentAuth: FeishuAuthConfig = {
  mode: "local-development",
  clientId: "cli_test",
  clientSecret: "development-only-secret",
  redirectUri: "http://127.0.0.1:4567/oauth/callback",
  acknowledgeInsecureLocalCredentials: true,
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function token(overrides: Partial<FeishuTokenSet> = {}): FeishuTokenSet {
  return {
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    tokenType: "Bearer",
    scope: ["task:task"],
    expiresAt: NOW + 3_600_000,
    refreshTokenExpiresAt: NOW + 86_400_000,
    ...overrides,
  };
}

class MemoryTokenStore implements FeishuTokenStore {
  value: FeishuTokenSet | undefined;
  swaps = 0;

  constructor(value: FeishuTokenSet | undefined = token()) {
    this.value = value;
  }

  async read(): Promise<FeishuTokenSet | undefined> {
    return this.value
      ? { ...this.value, scope: [...this.value.scope] }
      : undefined;
  }

  async compareAndSwap(
    expectedRefreshToken: string | undefined,
    next: FeishuTokenSet,
  ): Promise<boolean> {
    this.swaps += 1;
    if (this.value?.refreshToken !== expectedRefreshToken) return false;
    this.value = { ...next, scope: [...next.scope] };
    return true;
  }
}

describe("FeishuClient Task v2 transport", () => {
  it("continues pagination when an empty page still has has_more=true", async () => {
    const requestedUrls: string[] = [];
    const fetchMock: FeishuFetch = vi.fn(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const pageToken = new URL(url).searchParams.get("page_token");
      if (!pageToken) {
        return jsonResponse({
          code: 0,
          data: { items: [], has_more: true, page_token: "empty-next" },
        });
      }
      return jsonResponse({
        code: 0,
        data: {
          items: [{ guid: "task-2", summary: "second page" }],
          has_more: false,
        },
      });
    });
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: fetchMock,
      now: () => NOW,
    });

    await expect(client.listAllTasks()).resolves.toEqual([
      { guid: "task-2", summary: "second page" },
    ]);
    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[1]).searchParams.get("page_token")).toBe(
      "empty-next",
    );
  });

  it("requires and forwards a stable client_token on create", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock: FeishuFetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        code: 0,
        data: { task: { guid: "created-guid", summary: "Ship it" } },
      });
    });
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: fetchMock,
      now: () => NOW,
    });

    await client.createTask({ summary: "Ship it" }, "stable-create-token");
    expect(requestBody).toEqual({
      summary: "Ship it",
      client_token: "stable-create-token",
    });
    await expect(client.createTask({ summary: "x" }, "")).rejects.toThrow(
      /client_token/i,
    );
  });

  it("uses Task v2 add/remove member actions instead of a member PATCH", async () => {
    const requests: Array<{ url: URL; method: string | undefined; body: unknown }> = [];
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: async (input, init) => {
        requests.push({
          url: new URL(String(input)),
          method: init?.method,
          body: JSON.parse(String(init?.body)),
        });
        return jsonResponse({
          code: 0,
          data: { task: { guid: "member-guid", summary: "Members" } },
        });
      },
      now: () => NOW,
    });

    const members = [
      { id: "ou_owner", type: "user" as const, role: "assignee" as const },
      { id: "ou_watcher", type: "user" as const, role: "follower" as const },
    ];
    await client.addTaskMembers("member-guid", members);
    await client.removeTaskMembers("member-guid", members);

    expect(requests).toEqual([
      {
        url: expect.objectContaining({
          pathname: "/open-apis/task/v2/tasks/member-guid/add_members",
        }),
        method: "POST",
        body: { members },
      },
      {
        url: expect.objectContaining({
          pathname: "/open-apis/task/v2/tasks/member-guid/remove_members",
        }),
        method: "POST",
        body: { members },
      },
    ]);
    expect(requests.every(({ url }) => url.searchParams.get("user_id_type") === "open_id")).toBe(true);
    await expect(client.addTaskMembers("member-guid", [])).rejects.toThrow(
      /at least one member/i,
    );
  });

  it("uses the dedicated Task v2 tasklist endpoints with explicit GUIDs", async () => {
    const requests: Array<{
      url: URL;
      method: string | undefined;
      body: unknown;
    }> = [];
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          url,
          method: init?.method,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        if (url.pathname.endsWith("/tasklists")) {
          return jsonResponse({
            code: 0,
            data: {
              tasklists: [
                { tasklist_guid: "tasklist-1", section_guid: "section-1" },
              ],
            },
          });
        }
        return jsonResponse({
          code: 0,
          data: { task: { guid: "task-guid", summary: "Tasklist task" } },
        });
      },
      now: () => NOW,
    });

    await expect(client.listTasklists("task/with-slash")).resolves.toEqual([
      { tasklist_guid: "tasklist-1", section_guid: "section-1" },
    ]);
    await client.addTaskToTasklist("task/with-slash", {
      tasklist_guid: " tasklist-2 ",
      section_guid: " section-2 ",
    });
    await client.removeTaskFromTasklist("task/with-slash", " tasklist-2 ");

    expect(requests.map(({ url, method, body }) => ({
      pathname: url.pathname,
      userIdType: url.searchParams.get("user_id_type"),
      method,
      body,
    }))).toEqual([
      {
        pathname: "/open-apis/task/v2/tasks/task%2Fwith-slash/tasklists",
        userIdType: "open_id",
        method: "GET",
        body: undefined,
      },
      {
        pathname: "/open-apis/task/v2/tasks/task%2Fwith-slash/add_tasklist",
        userIdType: "open_id",
        method: "POST",
        body: { tasklist_guid: "tasklist-2", section_guid: "section-2" },
      },
      {
        pathname: "/open-apis/task/v2/tasks/task%2Fwith-slash/remove_tasklist",
        userIdType: "open_id",
        method: "POST",
        body: { tasklist_guid: "tasklist-2" },
      },
    ]);
  });

  it("turns Task v2 tasklist 403s into a scoped reauthorization error", async () => {
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: async () => jsonResponse({ code: 403, msg: "provider detail" }, 403),
      now: () => NOW,
    });

    const readError = await client.listTasklists("task-guid").catch(
      (error: unknown) => error,
    );
    expect(readError).toBeInstanceOf(FeishuTasklistPermissionError);
    expect(readError).toMatchObject({ requiredScope: "task:tasklist:read" });

    const writeError = await client
      .addTaskToTasklist("task-guid", { tasklist_guid: "tasklist-guid" })
      .catch((error: unknown) => error);
    expect(writeError).toBeInstanceOf(FeishuTasklistPermissionError);
    expect(writeError).toMatchObject({ requiredScope: "task:tasklist:write" });
  });

  it("completes and reopens Task v2 by patching completed_at", async () => {
    const requests: Array<{
      url: URL;
      method: string | undefined;
      body: unknown;
    }> = [];
    const fetchMock: FeishuFetch = vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        task: { completed_at: string };
      };
      requests.push({
        url: new URL(String(input)),
        method: init?.method,
        body,
      });
      return jsonResponse({
        code: 0,
        data: {
          task: {
            guid: "task/with-slash",
            summary: "Completion transport",
            completed_at: body.task.completed_at,
          },
        },
      });
    });
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: fetchMock,
      now: () => NOW,
    });

    await expect(
      client.completeTask("task/with-slash"),
    ).resolves.toMatchObject({ completed_at: String(NOW) });
    await expect(client.reopenTask("task/with-slash")).resolves.toMatchObject({
      completed_at: "0",
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.method)).toEqual([
      "PATCH",
      "PATCH",
    ]);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/open-apis/task/v2/tasks/task%2Fwith-slash",
      "/open-apis/task/v2/tasks/task%2Fwith-slash",
    ]);
    expect(
      requests.map((request) =>
        request.url.searchParams.get("user_id_type"),
      ),
    ).toEqual(["open_id", "open_id"]);
    expect(requests.map((request) => request.body)).toEqual([
      {
        task: { completed_at: String(NOW) },
        update_fields: ["completed_at"],
      },
      {
        task: { completed_at: "0" },
        update_fields: ["completed_at"],
      },
    ]);
  });

  it("refreshes a user token once after HTTP 401 and retries with it", async () => {
    const store = new MemoryTokenStore(token({ openId: "ou_authorized" }));
    const authorizations: string[] = [];
    let tokenRequests = 0;
    const fetchMock: FeishuFetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("/authen/v2/oauth/token")) {
        tokenRequests += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        expect(body).toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "old-refresh-token",
          client_id: "cli_test",
          client_secret: "development-only-secret",
        });
        return jsonResponse({
          code: 0,
          access_token: "new-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 7_200,
          refresh_token_expires_in: 2_592_000,
          scope: "task:task",
        });
      }

      const authorization =
        new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      if (authorization.includes("old-access-token")) {
        return jsonResponse({ code: 99991663, msg: "expired" }, 401);
      }
      return jsonResponse({
        code: 0,
        data: { items: [], has_more: false },
      });
    });
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: store,
      fetch: fetchMock,
      now: () => NOW,
    });

    await expect(client.listAllTasks()).resolves.toEqual([]);
    expect(authorizations).toEqual([
      "Bearer old-access-token",
      "Bearer new-access-token",
    ]);
    expect(tokenRequests).toBe(1);
    expect(store.swaps).toBe(1);
    expect(store.value?.refreshToken).toBe("rotated-refresh-token");
    expect(store.value?.openId).toBe("ou_authorized");
  });

  it("uses one atomic refresh for concurrent requests", async () => {
    const store = new MemoryTokenStore(token({ expiresAt: NOW - 1 }));
    let refreshRequests = 0;
    let apiRequests = 0;
    const fetchMock: FeishuFetch = vi.fn(async (input) => {
      if (String(input).includes("/authen/v2/oauth/token")) {
        refreshRequests += 1;
        await Promise.resolve();
        return jsonResponse({
          code: 0,
          access_token: "one-new-token",
          refresh_token: "one-new-refresh-token",
          token_type: "Bearer",
          expires_in: 7_200,
        });
      }
      apiRequests += 1;
      return jsonResponse({
        code: 0,
        data: { items: [], has_more: false },
      });
    });
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: store,
      fetch: fetchMock,
      now: () => NOW,
    });

    await Promise.all([client.listAllTasks(), client.listAllTasks()]);
    expect(refreshRequests).toBe(1);
    expect(store.swaps).toBe(1);
    expect(apiRequests).toBe(2);
  });

  it("requires reauthorization only when an expired token's refresh is rejected", async () => {
    const store = new MemoryTokenStore(token({ expiresAt: NOW - 1 }));
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: store,
      fetch: async (input) => {
        expect(String(input)).toContain("/authen/v2/oauth/token");
        return jsonResponse(
          { code: 20029, msg: "provider detail must stay internal" },
          400,
        );
      },
      now: () => NOW,
    });

    const error = await client.listAllTasks().catch((caught) => caught);
    expect(error).toBeInstanceOf(FeishuAuthenticationError);
    expect(error).toMatchObject({
      message: "The Feishu refresh token was rejected.",
      status: 400,
      code: 20029,
    });
    expect(String(error)).not.toContain("provider detail");
    expect(store.swaps).toBe(0);
  });

  it("keeps the connection retryable when refresh fails because the network is unavailable", async () => {
    const store = new MemoryTokenStore(token({ expiresAt: NOW - 1 }));
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: store,
      fetch: async () => {
        throw new Error("temporary DNS failure with provider detail");
      },
      now: () => NOW,
    });

    const error = await client.listAllTasks().catch((caught) => caught);
    expect(error).toBeInstanceOf(FeishuNetworkError);
    expect(error).not.toBeInstanceOf(FeishuAuthenticationError);
    expect(error).toMatchObject({
      message: "Feishu token refresh is temporarily unavailable.",
      retryable: true,
    });
    expect(String(error)).not.toContain("provider detail");
    expect(store.swaps).toBe(0);
  });

  it.each([
    [403, FeishuPermissionError],
    [404, FeishuNotFoundError],
    [409, FeishuConflictError],
  ] as const)("maps HTTP %s to a typed error", async (status, ErrorType) => {
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: async () => jsonResponse({ code: status, msg: "denied" }, status),
      now: () => NOW,
    });
    await expect(client.getTask("missing")).rejects.toBeInstanceOf(ErrorType);
  });

  it("honours Retry-After on 429 and throws a typed error when exhausted", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: new MemoryTokenStore(),
      fetch: async () => {
        calls += 1;
        return jsonResponse({ code: 429, msg: "slow down" }, 429, {
          "retry-after": "0.025",
        });
      },
      now: () => NOW,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      maxRateLimitRetries: 1,
    });

    const error = await client
      .listAllTasks()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FeishuRateLimitError);
    expect(calls).toBe(2);
    expect(waits).toEqual([25]);
  });

  it("fails clearly when no user token is available", async () => {
    const emptyStore = new MemoryTokenStore();
    emptyStore.value = undefined;
    const client = new FeishuClient({
      auth: developmentAuth,
      tokenStore: emptyStore,
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    await expect(client.listAllTasks()).rejects.toBeInstanceOf(
      FeishuAuthenticationError,
    );
  });
});

describe("Feishu OAuth flow", () => {
  it("builds a state-bound S256 PKCE authorization request", () => {
    let fill = 1;
    const session = createOAuthSession(
      developmentAuth,
      ["task:task", "offline_access"],
      {
        randomBytes: (size) => new Uint8Array(size).fill(fill++),
      },
    );
    const url = new URL(session.authorizationUrl);

    expect(url.origin + url.pathname).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(url.searchParams.get("state")).toBe(session.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256")
        .update(session.codeVerifier, "ascii")
        .digest("base64url"),
    );
    expect(session.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(() =>
      validateOAuthCallback({ code: "code", state: "attacker-state" }, session),
    ).toThrow(/state mismatch/i);
  });

  it("uses the relay for authorization/token exchange and never sends a secret", async () => {
    const relayAuth: FeishuAuthConfig = {
      mode: "relay",
      relayBaseUrl: "https://relay.example.test/",
      redirectUri: "todoagent://oauth/feishu",
    };
    const session = createOAuthSession(relayAuth);
    expect(session.authorizationUrl).toMatch(
      /^https:\/\/relay\.example\.test\/feishu\/oauth\/authorize/,
    );

    let posted: Record<string, string> | undefined;
    const result = await exchangeAuthorizationCode(
      relayAuth,
      { code: "relay-code", state: session.state },
      session,
      {
        now: () => NOW,
        fetch: async (input, init) => {
          expect(String(input)).toBe(
            "https://relay.example.test/feishu/oauth/token",
          );
          posted = JSON.parse(String(init?.body)) as Record<string, string>;
          return jsonResponse({
            access_token: "relay-access",
            refresh_token: "relay-refresh",
            open_id: "ou_relay_user",
            expires_in: 3_600,
          });
        },
      },
    );

    expect(posted).toMatchObject({
      grant_type: "authorization_code",
      code: "relay-code",
      code_verifier: session.codeVerifier,
    });
    expect(posted).not.toHaveProperty("client_secret");
    expect(result.accessToken).toBe("relay-access");
    expect(result.openId).toBe("ou_relay_user");
  });

  it("rejects unacknowledged local credentials at runtime", () => {
    const unsafe = {
      ...developmentAuth,
      acknowledgeInsecureLocalCredentials: false,
    } as unknown as FeishuAuthConfig;
    expect(() => createOAuthSession(unsafe)).toThrow(/development-only/i);
  });
});
