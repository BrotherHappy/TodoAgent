// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  FEISHU_DEVICE_AUTHORIZATION_URL,
  FEISHU_DEVICE_CODE_GRANT_TYPE,
  FEISHU_DEVICE_TOKEN_URL,
  FeishuDeviceOAuthError,
  parseFeishuDeviceTokenResponse,
  pollFeishuDeviceToken,
  requestFeishuDeviceAuthorization,
  type FeishuDeviceAuthorization,
  type FeishuDeviceOAuthStatus,
} from "../electron/feishu/device-oauth-flow";
import type { FeishuFetch } from "../src/shared/feishu-types";

const NOW = 1_800_000_000_000;
const config = {
  clientId: "cli_device_test",
  clientSecret: "device-test-secret",
  scopes: ["task:task:read", "task:task:write"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorization(
  overrides: Partial<FeishuDeviceAuthorization> = {},
): FeishuDeviceAuthorization {
  return {
    deviceCode: "device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://accounts.feishu.cn/device",
    verificationUriComplete:
      "https://accounts.feishu.cn/device?user_code=ABCD-EFGH",
    expiresInSeconds: 240,
    expiresAt: NOW + 240_000,
    intervalMs: 5_000,
    ...overrides,
  };
}

describe("Feishu user device OAuth flow", () => {
  it("uses the current official Feishu endpoints", () => {
    expect(FEISHU_DEVICE_AUTHORIZATION_URL).toBe(
      "https://accounts.feishu.cn/oauth/v1/device_authorization",
    );
    expect(FEISHU_DEVICE_TOKEN_URL).toBe(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    );
  });

  it("starts device authorization with Basic credentials and offline access", async () => {
    let requestedUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchMock: FeishuFetch = vi.fn(async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return jsonResponse({
        device_code: "device-from-feishu",
        user_code: "TODO-2026",
        verification_uri: "https://accounts.feishu.cn/device",
        verification_uri_complete:
          "https://accounts.feishu.cn/device?user_code=TODO-2026",
        expires_in: 240,
        interval: 5,
      });
    });

    const result = await requestFeishuDeviceAuthorization(config, {
      fetch: fetchMock,
      now: () => NOW,
    });

    expect(requestedUrl).toBe(FEISHU_DEVICE_AUTHORIZATION_URL);
    expect(requestInit?.method).toBe("POST");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from(
        "cli_device_test:device-test-secret",
      ).toString("base64")}`,
    );
    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get("client_id")).toBe("cli_device_test");
    expect(body.get("scope")?.split(" ")).toEqual([
      "task:task:read",
      "task:task:write",
      "offline_access",
    ]);
    expect(result).toEqual({
      deviceCode: "device-from-feishu",
      userCode: "TODO-2026",
      verificationUri: "https://accounts.feishu.cn/device",
      verificationUriComplete:
        "https://accounts.feishu.cn/device?user_code=TODO-2026",
      expiresInSeconds: 240,
      expiresAt: NOW + 240_000,
      intervalMs: 5_000,
    });
  });

  it("polls through authorization_pending and parses the token response", async () => {
    let clock = NOW;
    const sleeps: number[] = [];
    const statuses: FeishuDeviceOAuthStatus[] = [];
    const requests: RequestInit[] = [];
    let call = 0;
    const fetchMock: FeishuFetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(FEISHU_DEVICE_TOKEN_URL);
      requests.push(init ?? {});
      call += 1;
      if (call === 1) {
        return jsonResponse(
          {
            error: "authorization_pending",
            error_description: "Waiting for the user",
          },
          400,
        );
      }
      return jsonResponse({
        access_token: "user-access-token",
        refresh_token: "user-refresh-token",
        open_id: "ou_device_user",
        tenant_key: "tenant_device",
        token_type: "Bearer",
        scope: "task:task:read task:task:write offline_access",
        expires_in: 7_200,
        refresh_token_expires_in: 2_592_000,
      });
    });

    const token = await pollFeishuDeviceToken(config, authorization(), {
      fetch: fetchMock,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      onStatusChange: (status) => statuses.push(status),
    });

    expect(sleeps).toEqual([5_000, 5_000]);
    expect(statuses).toEqual([
      { status: "polling", attempt: 1, intervalMs: 5_000 },
      {
        status: "authorization_pending",
        attempt: 1,
        intervalMs: 5_000,
      },
      { status: "polling", attempt: 2, intervalMs: 5_000 },
    ]);
    expect(requests).toHaveLength(2);
    const requestBody = new URLSearchParams(String(requests[0].body));
    expect(requestBody.get("grant_type")).toBe(
      FEISHU_DEVICE_CODE_GRANT_TYPE,
    );
    expect(requestBody.get("device_code")).toBe("device-code");
    expect(requestBody.get("client_id")).toBe("cli_device_test");
    expect(requestBody.get("client_secret")).toBe("device-test-secret");
    expect(token).toEqual({
      accessToken: "user-access-token",
      refreshToken: "user-refresh-token",
      openId: "ou_device_user",
      tenantKey: "tenant_device",
      tokenType: "Bearer",
      scope: ["task:task:read", "task:task:write", "offline_access"],
      expiresAt: clock + 7_200_000,
      refreshTokenExpiresAt: clock + 2_592_000_000,
    });
  });

  it("adds five seconds after slow_down for every later poll", async () => {
    let clock = NOW;
    const sleeps: number[] = [];
    const statuses: FeishuDeviceOAuthStatus[] = [];
    let call = 0;
    const fetchMock: FeishuFetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({ error: "slow_down" }, 400);
      }
      return jsonResponse({
        access_token: "after-slow-down",
        token_type: "Bearer",
        expires_in: 3_600,
      });
    });

    const token = await pollFeishuDeviceToken(config, authorization(), {
      fetch: fetchMock,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      onStatusChange: (status) => statuses.push(status),
    });

    expect(sleeps).toEqual([5_000, 10_000]);
    expect(statuses).toContainEqual({
      status: "slow_down",
      attempt: 1,
      intervalMs: 10_000,
    });
    expect(token.scope).toEqual([
      "task:task:read",
      "task:task:write",
      "offline_access",
    ]);
  });

  it.each([undefined, "", []] as const)(
    "backfills an absent or empty token scope from requested scopes (%s)",
    async (scope) => {
      let clock = NOW;
      const token = await pollFeishuDeviceToken(config, authorization(), {
        fetch: async () =>
          jsonResponse({
            access_token: "scope-backfill-token",
            token_type: "Bearer",
            scope,
            expires_in: 3_600,
          }),
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      });

      expect(token.scope).toEqual([
        "task:task:read",
        "task:task:write",
        "offline_access",
      ]);
    },
  );

  it("supports cancellation before and during polling", async () => {
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    const fetchMock = vi.fn<FeishuFetch>();

    await expect(
      pollFeishuDeviceToken(config, authorization(), {
        fetch: fetchMock,
        signal: alreadyCancelled.signal,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      name: "FeishuDeviceOAuthError",
      code: "cancelled",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const controller = new AbortController();
    let releaseSleep: (() => void) | undefined;
    const polling = pollFeishuDeviceToken(config, authorization(), {
      fetch: fetchMock,
      signal: controller.signal,
      now: () => NOW,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });
    controller.abort();
    await expect(polling).rejects.toMatchObject({ code: "cancelled" });
    releaseSleep?.();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out at the earlier caller deadline without sending a late poll", async () => {
    let clock = NOW;
    const sleeps: number[] = [];
    const fetchMock = vi.fn<FeishuFetch>();

    await expect(
      pollFeishuDeviceToken(config, authorization(), {
        fetch: fetchMock,
        now: () => clock,
        timeoutMs: 2_000,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
      }),
    ).rejects.toMatchObject({ code: "timeout" });

    expect(sleeps).toEqual([2_000]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["access_denied", "access_denied"],
    ["expired_token", "expired_token"],
    ["invalid_grant", "expired_token"],
  ] as const)("maps provider error %s to %s", async (providerError, code) => {
    let clock = NOW;
    const fetchMock: FeishuFetch = vi.fn(async () =>
      jsonResponse(
        { error: providerError, error_description: "provider stopped flow" },
        400,
      ),
    );

    const error = await pollFeishuDeviceToken(config, authorization(), {
      fetch: fetchMock,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeishuDeviceOAuthError);
    expect(error).toMatchObject({ code, providerError });
  });

  it("parses nested token payloads and rejects malformed tokens", () => {
    expect(
      parseFeishuDeviceTokenResponse(
        {
          code: 0,
          data: {
            access_token: "nested-access",
            refresh_token: "nested-refresh",
            token_type: "Bearer",
            scope: [
              "task:task:read",
              "task:task:write",
              "offline_access",
            ],
            expires_in: 90,
          },
        },
        () => NOW,
      ),
    ).toEqual({
      accessToken: "nested-access",
      refreshToken: "nested-refresh",
      openId: undefined,
      tokenType: "Bearer",
      scope: ["task:task:read", "task:task:write", "offline_access"],
      expiresAt: NOW + 90_000,
      refreshTokenExpiresAt: undefined,
    });

    expect(() =>
      parseFeishuDeviceTokenResponse({ access_token: "missing-expiry" }),
    ).toThrow(/expires_in/i);
    expect(() =>
      parseFeishuDeviceTokenResponse({ expires_in: 90 }),
    ).toThrow(/access_token/i);
  });

  it.each([
    ["task:task:read offline_access", "task:task:write"],
    ["task:task:read task:task:write", "offline_access"],
  ])(
    "rejects an explicit insufficient scope without exposing the client secret",
    async (scope, missingScope) => {
      let clock = NOW;
      const error = await pollFeishuDeviceToken(config, authorization(), {
        fetch: async () =>
          jsonResponse({
            access_token: "insufficient-token",
            token_type: "Bearer",
            scope,
            expires_in: 3_600,
          }),
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FeishuDeviceOAuthError);
      expect(error).toMatchObject({
        code: "oauth_error",
        providerError: "insufficient_scope",
      });
      expect(String((error as Error).message)).toContain(missingScope);
      expect(String((error as Error).message)).not.toContain(
        config.clientSecret,
      );
    },
  );

  it("rejects invalid start responses and network failures with typed errors", async () => {
    await expect(
      requestFeishuDeviceAuthorization(config, {
        fetch: async () => jsonResponse({ verification_uri: "https://x" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });

    await expect(
      requestFeishuDeviceAuthorization(config, {
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toMatchObject({ code: "network_error" });
  });

  it("rejects device verification URLs outside Feishu or Lark", async () => {
    await expect(
      requestFeishuDeviceAuthorization(config, {
        fetch: async () =>
          jsonResponse({
            device_code: "untrusted-device-code",
            verification_uri: "https://accounts.feishu.cn/device",
            verification_uri_complete:
              "https://accounts.feishu.example/device?user_code=FAKE",
            expires_in: 240,
          }),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
