// @vitest-environment node

import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  CreateTaskInput,
  LocalAppState,
  Task,
  TaskFilter,
  TaskMutationResult,
} from "../src/shared/models";
import { createEmptyLocalAppState } from "../src/shared/models";
import {
  SettingsService,
  type EncryptionAdapter,
} from "../electron/services/settings-service";
import type {
  FeishuApplicationStateStore,
  FeishuApplicationSyncState,
} from "../electron/feishu/feishu-sync-service";
import type {
  FeishuLocalStorePort,
  FeishuTaskServicePort,
} from "../electron/feishu/feishu-task-adapter";
import {
  createFeishuRuntime,
  FeishuRuntimeConfigurationError,
  type FeishuSettingsPort,
} from "../electron/feishu/feishu-runtime-factory";
import { FeishuDesktopController } from "../electron/feishu/feishu-desktop-controller";

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const clone = <Value>(value: Value): Value => structuredClone(value);

class EmptyLocalStore implements FeishuLocalStorePort {
  state: LocalAppState = createEmptyLocalAppState();

  async transact<Result>(
    mutator: (draft: LocalAppState) => Result | Promise<Result>,
  ): Promise<Result> {
    const draft = clone(this.state);
    const result = await mutator(draft);
    this.state = draft;
    return result;
  }
}

class EmptyTaskService implements FeishuTaskServicePort {
  async getTask(
    _id: string,
    _includeDeleted?: boolean,
  ): Promise<Task | undefined> {
    return undefined;
  }

  async listTasks(_filter?: TaskFilter): Promise<Task[]> {
    return [];
  }

  async createTask(_input: CreateTaskInput): Promise<TaskMutationResult> {
    throw new Error("not used by this runtime test");
  }
}

class MemoryStateStore implements FeishuApplicationStateStore {
  value?: FeishuApplicationSyncState;

  async load(): Promise<FeishuApplicationSyncState | undefined> {
    return this.value && clone(this.value);
  }

  async save(value: FeishuApplicationSyncState): Promise<void> {
    this.value = clone(value);
  }
}

const encryption: EncryptionAdapter = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").slice("encrypted:".length),
};

function emptyPorts() {
  return {
    localStore: new EmptyLocalStore(),
    taskService: new EmptyTaskService(),
    stateStore: new MemoryStateStore(),
  };
}

describe("createFeishuRuntime", () => {
  it("completes personal-direct device authorization with per-user encrypted credentials", async () => {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "feishu-runtime-personal-"),
    );
    const settings = new SettingsService(userDataPath, encryption);
    await settings.load();
    await settings.setCredential(
      "feishu-app-secret",
      "ALICE_PERSONAL_APP_SECRET",
      "feishu-alice-secret",
    );
    await settings.setCredential(
      "feishu-app-secret",
      "BOB_PERSONAL_APP_SECRET",
      "feishu-bob-secret",
    );
    const aliceToken = JSON.stringify({
      accessToken: "ALICE_TOKEN_SENTINEL",
      tokenType: "Bearer",
      scope: ["task:task:read"],
      expiresAt: NOW + 60_000,
    });
    await settings.setCredential(
      "feishu-token",
      aliceToken,
      "feishu-alice-token",
    );
    const getCredential = vi.spyOn(settings, "getCredential");

    let clock = NOW;
    let authorizationInit: RequestInit | undefined;
    let pollingInit: RequestInit | undefined;
    const ports = emptyPorts();
    const runtime = await createFeishuRuntime({
      accountId: "bob-account",
      userDataPath,
      tokenCredentialId: "feishu-bob-token",
      mode: {
        mode: "personal-direct",
        clientId: "cli_bob_personal",
        appSecretCredentialId: "feishu-bob-secret",
      },
      settings,
      ...ports,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (
          url ===
          "https://accounts.feishu.cn/oauth/v1/device_authorization"
        ) {
          authorizationInit = init;
          return new Response(
            JSON.stringify({
              device_code: "bob-device-code",
              user_code: "BOB-2026",
              verification_uri: "https://accounts.feishu.cn/device",
              verification_uri_complete:
                "https://accounts.feishu.cn/device?user_code=BOB-2026",
              expires_in: 240,
              interval: 1,
            }),
            { status: 200 },
          );
        }
        if (
          url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
        ) {
          pollingInit = init;
          return new Response(
            JSON.stringify({
              access_token: "BOB_USER_ACCESS_TOKEN",
              refresh_token: "BOB_USER_REFRESH_TOKEN",
              open_id: "ou_bob",
              token_type: "Bearer",
              scope: "task:task:read task:task:write offline_access",
              expires_in: 7_200,
              refresh_token_expires_in: 2_592_000,
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected Feishu URL: ${url}`);
      },
    });

    await runtime.initialize();
    const authorization = await runtime.beginOAuth({ timeoutMs: 30_000 });
    expect(authorization).toMatchObject({
      authorizationUrl:
        "https://accounts.feishu.cn/device?user_code=BOB-2026",
      userCode: "BOB-2026",
      expiresAt: NOW + 240_000,
    });
    await expect(authorization.completion).resolves.toMatchObject({
      accessToken: "BOB_USER_ACCESS_TOKEN",
      refreshToken: "BOB_USER_REFRESH_TOKEN",
      openId: "ou_bob",
    });

    expect(getCredential).toHaveBeenCalledWith("feishu-bob-secret");
    expect(getCredential).not.toHaveBeenCalledWith("feishu-alice-secret");
    const authorizationHeaders = new Headers(authorizationInit?.headers);
    expect(authorizationHeaders.get("authorization")).toBe(
      `Basic ${Buffer.from(
        "cli_bob_personal:BOB_PERSONAL_APP_SECRET",
      ).toString("base64")}`,
    );
    const authorizationBody = new URLSearchParams(
      String(authorizationInit?.body),
    );
    expect(authorizationBody.get("client_id")).toBe("cli_bob_personal");
    expect(authorizationBody.get("scope")?.split(" ")).toEqual([
      "task:task:read",
      "task:task:write",
      "task:tasklist:read",
      "offline_access",
    ]);

    const pollingBody = new URLSearchParams(String(pollingInit?.body));
    expect(pollingBody.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(pollingBody.get("device_code")).toBe("bob-device-code");
    expect(pollingBody.get("client_id")).toBe("cli_bob_personal");
    expect(pollingBody.get("client_secret")).toBe(
      "BOB_PERSONAL_APP_SECRET",
    );

    const storedBobToken = JSON.parse(
      settings.getCredential("feishu-bob-token")!,
    ) as Record<string, unknown>;
    expect(storedBobToken).toMatchObject({
      accessToken: "BOB_USER_ACCESS_TOKEN",
      refreshToken: "BOB_USER_REFRESH_TOKEN",
      openId: "ou_bob",
      expiresAt: clock + 7_200_000,
      refreshTokenExpiresAt: clock + 2_592_000_000,
    });
    expect(settings.getCredential("feishu-alice-token")).toBe(aliceToken);

    const encryptedFile = await readFile(
      path.join(userDataPath, "private", "credentials.v1.json"),
      "utf8",
    );
    expect(encryptedFile).not.toContain("BOB_PERSONAL_APP_SECRET");
    expect(encryptedFile).not.toContain("BOB_USER_ACCESS_TOKEN");
    expect(encryptedFile).not.toContain("BOB_USER_REFRESH_TOKEN");
    expect(JSON.stringify(ports.stateStore.value ?? {})).not.toContain(
      "BOB_USER_ACCESS_TOKEN",
    );
    await runtime.close();
  });

  it("uses Device OAuth for an existing app without starting a loopback server", async () => {
    const credentials = new Map<string, string>([
      ["existing-secret", "EXISTING_APP_SECRET"],
    ]);
    const writes: Array<{ kind: string; value: string; id: string }> = [];
    const settings: FeishuSettingsPort = {
      getCredential: (id) => credentials.get(id),
      setCredential: async (kind, value, id) => {
        writes.push({ kind, value, id });
        credentials.set(id, value);
      },
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = await createFeishuRuntime({
      accountId: "existing-app-account",
      userDataPath: "/unused-because-state-store-is-injected",
      tokenCredentialId: "existing-token",
      mode: {
        mode: "existing-direct",
        clientId: "cli_reviewed_existing",
        appSecretCredentialId: "existing-secret",
      },
      settings,
      ...emptyPorts(),
      now: () => NOW,
      loopbackFactory: () => {
        throw new Error("existing-direct must not create a loopback server");
      },
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === "https://accounts.feishu.cn/oauth/v1/device_authorization") {
          return new Response(
            JSON.stringify({
              device_code: "existing-device-code",
              user_code: "EXISTING-2026",
              verification_uri: "https://accounts.feishu.cn/device",
              verification_uri_complete:
                "https://accounts.feishu.cn/device?user_code=EXISTING-2026",
              expires_in: 240,
              interval: 1,
            }),
            { status: 200 },
          );
        }
        if (url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token") {
          return new Response(
            JSON.stringify({
              access_token: "EXISTING_ACCESS_TOKEN",
              refresh_token: "EXISTING_REFRESH_TOKEN",
              open_id: "ou_existing_user",
              token_type: "Bearer",
              scope: "task:task:read task:task:write offline_access",
              expires_in: 7_200,
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected Feishu URL: ${url}`);
      },
    });

    await runtime.initialize();
    const authorization = await runtime.beginOAuth({ timeoutMs: 30_000 });
    expect(authorization).toMatchObject({
      authorizationUrl:
        "https://accounts.feishu.cn/device?user_code=EXISTING-2026",
      userCode: "EXISTING-2026",
    });
    expect(authorization.authorizationUrl).not.toContain("EXISTING_APP_SECRET");
    await expect(authorization.completion).resolves.toMatchObject({
      accessToken: "EXISTING_ACCESS_TOKEN",
      refreshToken: "EXISTING_REFRESH_TOKEN",
      openId: "ou_existing_user",
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://accounts.feishu.cn/oauth/v1/device_authorization",
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
    ]);
    expect(new Headers(requests[0].init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from(
        "cli_reviewed_existing:EXISTING_APP_SECRET",
      ).toString("base64")}`,
    );
    expect(writes).toEqual([
      expect.objectContaining({
        kind: "feishu-token",
        id: "existing-token",
      }),
    ]);
    expect(writes[0].value).not.toContain("EXISTING_APP_SECRET");
    await runtime.close();
  });

  it("restores an encrypted existing-direct session after restart and refreshes it without Device OAuth", async () => {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "feishu-runtime-existing-restart-"),
    );
    const appSecretCredentialId = "existing-restart-secret";
    const tokenCredentialId = "existing-restart-token";
    const firstProcess = new SettingsService(userDataPath, encryption);
    await firstProcess.load();
    await firstProcess.setCredential(
      "feishu-app-secret",
      "RESTART_APP_SECRET_SENTINEL",
      appSecretCredentialId,
    );
    await firstProcess.setCredential(
      "feishu-token",
      JSON.stringify({
        accessToken: "EXPIRED_ACCESS_SENTINEL",
        refreshToken: "PERSISTED_REFRESH_SENTINEL",
        openId: "ou_restart_user",
        tokenType: "Bearer",
        scope: ["task:task:read", "task:task:write", "offline_access"],
        expiresAt: NOW - 1,
        refreshTokenExpiresAt: NOW + 86_400_000,
      }),
      tokenCredentialId,
    );
    const firstSettings = firstProcess.get();
    await firstProcess.replace({
      ...firstSettings,
      feishu: {
        ...firstSettings.feishu,
        configured: true,
        mode: "existing-direct",
        accountId: "restart-account",
        clientId: "cli_existing_restart",
        appSecretCredentialId,
        tokenCredentialId,
      },
    });

    // A brand-new service/controller pair models a complete desktop-process
    // restart; it receives no in-memory state from the first process.
    const restartedSettings = new SettingsService(userDataPath, encryption);
    await restartedSettings.load();
    const persisted = restartedSettings.get().feishu;
    expect(persisted).toMatchObject({
      configured: true,
      mode: "existing-direct",
      accountId: "restart-account",
      clientId: "cli_existing_restart",
      appSecretCredentialId,
      tokenCredentialId,
    });

    let deviceAuthorizationRequests = 0;
    let refreshRequests = 0;
    let taskListRequests = 0;
    const ports = emptyPorts();
    const controller = new FeishuDesktopController({
      userDataPath,
      settings: restartedSettings,
      taskService: ports.taskService,
      localStore: ports.localStore,
      stateStore: ports.stateStore,
      now: () => NOW,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/oauth/v1/device_authorization")) {
          deviceAuthorizationRequests += 1;
          throw new Error("restart must not launch Device OAuth");
        }
        if (url.includes("/authen/v2/oauth/token")) {
          refreshRequests += 1;
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          expect(body).toMatchObject({
            grant_type: "refresh_token",
            refresh_token: "PERSISTED_REFRESH_SENTINEL",
            client_id: "cli_existing_restart",
            client_secret: "RESTART_APP_SECRET_SENTINEL",
          });
          return new Response(
            JSON.stringify({
              code: 0,
              access_token: "ROTATED_ACCESS_SENTINEL",
              refresh_token: "ROTATED_REFRESH_SENTINEL",
              open_id: "ou_restart_user",
              token_type: "Bearer",
              scope: "task:task:read task:task:write offline_access",
              expires_in: 7_200,
              refresh_token_expires_in: 2_592_000,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/task/v2/tasklists")) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: { items: [], has_more: false },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/task/v2/tasks")) {
          taskListRequests += 1;
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer ROTATED_ACCESS_SENTINEL",
          );
          return new Response(
            JSON.stringify({
              code: 0,
              data: { items: [], has_more: false },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected Feishu URL: ${url}`);
      },
    });

    await expect(
      controller.configure({
        mode: "existing-direct",
        accountId: persisted.accountId,
        tokenCredentialId: persisted.tokenCredentialId!,
        clientId: persisted.clientId,
        appSecretCredentialId: persisted.appSecretCredentialId!,
      }),
    ).resolves.toMatchObject({
      state: "connected",
      configured: true,
      connected: true,
      mode: "existing-direct",
    });
    expect(deviceAuthorizationRequests).toBe(0);

    await expect(controller.syncNow({ forceFull: true })).resolves.toMatchObject({
      offline: false,
      usedFullSync: true,
    });
    expect(refreshRequests).toBe(1);
    expect(taskListRequests).toBe(1);
    expect(deviceAuthorizationRequests).toBe(0);
    expect(controller.status()).toMatchObject({
      state: "connected",
      connected: true,
    });

    const thirdProcess = new SettingsService(userDataPath, encryption);
    await thirdProcess.load();
    expect(thirdProcess.getCredential(tokenCredentialId)).toContain(
      "ROTATED_REFRESH_SENTINEL",
    );
    const ordinarySettings = await readFile(
      path.join(userDataPath, "settings.v1.json"),
      "utf8",
    );
    const encryptedCredentials = await readFile(
      path.join(userDataPath, "private", "credentials.v1.json"),
      "utf8",
    );
    for (const secret of [
      "RESTART_APP_SECRET_SENTINEL",
      "EXPIRED_ACCESS_SENTINEL",
      "PERSISTED_REFRESH_SENTINEL",
      "ROTATED_ACCESS_SENTINEL",
      "ROTATED_REFRESH_SENTINEL",
    ]) {
      expect(ordinarySettings).not.toContain(secret);
      expect(encryptedCredentials).not.toContain(secret);
    }
  });

  it("cancels personal-direct polling explicitly and again when closing", async () => {
    const credentials = new Map<string, string>([
      ["personal-secret", "PER_USER_APP_SECRET"],
    ]);
    const writes: Array<{ kind: string; value: string; id: string }> = [];
    const settings: FeishuSettingsPort = {
      getCredential: (id) => credentials.get(id),
      setCredential: async (kind, value, id) => {
        writes.push({ kind, value, id });
        credentials.set(id, value);
      },
    };
    const pendingSleeps: Array<() => void> = [];
    let deviceStarts = 0;
    let tokenPolls = 0;
    const ports = emptyPorts();
    const runtime = await createFeishuRuntime({
      accountId: "personal-cancel-account",
      userDataPath: "/unused-because-state-store-is-injected",
      tokenCredentialId: "personal-token",
      mode: {
        mode: "personal-direct",
        clientId: "cli_personal_cancel",
        appSecretCredentialId: "personal-secret",
      },
      settings,
      ...ports,
      now: () => NOW,
      sleep: () =>
        new Promise<void>((resolve) => {
          pendingSleeps.push(resolve);
        }),
      fetch: async (input) => {
        const url = String(input);
        if (
          url ===
          "https://accounts.feishu.cn/oauth/v1/device_authorization"
        ) {
          deviceStarts += 1;
          return new Response(
            JSON.stringify({
              device_code: `device-${deviceStarts}`,
              user_code: `CODE-${deviceStarts}`,
              verification_uri: "https://accounts.feishu.cn/device",
              verification_uri_complete: `https://accounts.feishu.cn/device?user_code=CODE-${deviceStarts}`,
              expires_in: 240,
              interval: 1,
            }),
            { status: 200 },
          );
        }
        if (
          url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
        ) {
          tokenPolls += 1;
          return new Response(
            JSON.stringify({ error: "authorization_pending" }),
            { status: 400 },
          );
        }
        throw new Error(`Unexpected Feishu URL: ${url}`);
      },
    });
    await runtime.initialize();

    const explicitlyCancelled = await runtime.beginOAuth({
      timeoutMs: 30_000,
    });
    await vi.waitFor(() => expect(pendingSleeps).toHaveLength(1));
    const explicitRejection = expect(
      explicitlyCancelled.completion,
    ).rejects.toMatchObject({ code: "cancelled" });
    await explicitlyCancelled.cancel();
    await explicitRejection;
    pendingSleeps.shift()?.();
    expect(tokenPolls).toBe(0);

    const cancelledByClose = await runtime.beginOAuth({ timeoutMs: 30_000 });
    await vi.waitFor(() => expect(pendingSleeps).toHaveLength(1));
    pendingSleeps.shift()?.();
    await vi.waitFor(() => {
      expect(tokenPolls).toBe(1);
      expect(pendingSleeps).toHaveLength(1);
    });
    const closeRejection = expect(
      cancelledByClose.completion,
    ).rejects.toMatchObject({ code: "cancelled" });
    await runtime.close();
    await closeRejection;
    pendingSleeps.shift()?.();

    expect(deviceStarts).toBe(2);
    expect(writes).toEqual([]);
    await expect(runtime.syncNow()).rejects.toThrow(/closed/i);
  });

  it("uses encrypted SettingsService credentials in warned developer mode", async () => {
    const userDataPath = await mkdtemp(
      path.join(os.tmpdir(), "feishu-runtime-dev-"),
    );
    const settings = new SettingsService(userDataPath, encryption);
    await settings.load();
    await settings.setCredential(
      "feishu-app-secret",
      "DEVELOPER_APP_SECRET",
      "feishu-dev-secret",
    );
    const warnings: string[] = [];
    let tokenRequestBody: Record<string, string> | undefined;
    const ports = emptyPorts();
    const runtime = await createFeishuRuntime({
      accountId: "developer-account",
      userDataPath,
      tokenCredentialId: "feishu-user-token",
      mode: {
        mode: "local-development",
        clientId: "cli_developer",
        appSecretCredentialId: "feishu-dev-secret",
        acknowledgeInsecureLocalCredentials: true,
        onSecurityWarning: (message) => warnings.push(message),
      },
      settings,
      ...ports,
      now: () => NOW,
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        );
        tokenRequestBody = JSON.parse(String(init?.body)) as Record<
          string,
          string
        >;
        return new Response(
          JSON.stringify({
            code: 0,
            access_token: "USER_ACCESS_TOKEN",
            refresh_token: "USER_REFRESH_TOKEN",
            token_type: "Bearer",
            scope: "task:task:read task:task:write",
            expires_in: 7_200,
          }),
          { status: 200 },
        );
      },
    });
    await runtime.initialize();
    const authorization = await runtime.beginOAuth({ timeoutMs: 2_000 });
    const authorizationUrl = new URL(authorization.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(authorizationUrl.toString()).not.toContain("DEVELOPER_APP_SECRET");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/never ship/i);

    const state = authorizationUrl.searchParams.get("state")!;
    const callbackResponse = await fetch(
      `${authorization.redirectUri}?code=developer-code&state=${encodeURIComponent(state)}`,
    );
    expect(callbackResponse.status).toBe(200);
    await expect(authorization.completion).resolves.toMatchObject({
      accessToken: "USER_ACCESS_TOKEN",
      refreshToken: "USER_REFRESH_TOKEN",
    });
    expect(tokenRequestBody).toMatchObject({
      grant_type: "authorization_code",
      code: "developer-code",
      client_id: "cli_developer",
      client_secret: "DEVELOPER_APP_SECRET",
    });
    expect(tokenRequestBody?.redirect_uri).toBe(authorization.redirectUri);
    expect(tokenRequestBody?.code_verifier).toBeTruthy();

    const encryptedFile = await readFile(
      path.join(userDataPath, "private", "credentials.v1.json"),
      "utf8",
    );
    expect(encryptedFile).not.toContain("DEVELOPER_APP_SECRET");
    expect(encryptedFile).not.toContain("USER_ACCESS_TOKEN");
    expect(encryptedFile).not.toContain("USER_REFRESH_TOKEN");
    expect(settings.getCredential("feishu-user-token")).toContain(
      "USER_ACCESS_TOKEN",
    );
    expect(JSON.stringify(ports.stateStore.value ?? {})).not.toContain(
      "USER_ACCESS_TOKEN",
    );
    await runtime.close();
  });

  it("uses relay endpoints without reading/sending an app secret and cancels on close", async () => {
    const credentials = new Map<string, string>();
    const readIds: string[] = [];
    const settings: FeishuSettingsPort = {
      getCredential: (id) => {
        readIds.push(id);
        return credentials.get(id);
      },
      setCredential: async (_kind, value, id) => {
        credentials.set(id, value);
      },
    };
    let tokenBody: Record<string, string> | undefined;
    const ports = emptyPorts();
    const runtime = await createFeishuRuntime({
      accountId: "relay-account",
      userDataPath: "/unused-because-state-store-is-injected",
      tokenCredentialId: "relay-token",
      mode: {
        mode: "relay",
        relayBaseUrl: "https://relay.example.test/",
      },
      settings,
      ...ports,
      now: () => NOW,
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://relay.example.test/feishu/oauth/token",
        );
        tokenBody = JSON.parse(String(init?.body)) as Record<string, string>;
        return new Response(
          JSON.stringify({
            access_token: "relay-user-access",
            refresh_token: "relay-user-refresh",
            expires_in: 3_600,
          }),
          { status: 200 },
        );
      },
    });
    await runtime.initialize();
    const authorization = await runtime.beginOAuth({ timeoutMs: 2_000 });
    const url = new URL(authorization.authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://relay.example.test/feishu/oauth/authorize",
    );
    const callback = await fetch(
      `${authorization.redirectUri}?code=relay-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
    );
    expect(callback.status).toBe(200);
    await authorization.completion;
    expect(tokenBody).not.toHaveProperty("client_secret");
    expect(tokenBody).not.toHaveProperty("client_id");
    // Runtime may read only its encrypted user-token credential to recover the
    // authorized open_id used for role mapping; relay mode never reads an app secret.
    expect(readIds).toEqual(["relay-token"]);

    const pending = await runtime.beginOAuth({ timeoutMs: 2_000 });
    const cancelled = expect(pending.completion).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await runtime.close();
    await cancelled;
    await expect(runtime.syncNow()).rejects.toThrow(/closed/i);
  });

  it("rejects unsafe or incomplete developer configuration before startup", async () => {
    const ports = emptyPorts();
    const settings: FeishuSettingsPort = {
      getCredential: () => undefined,
      setCredential: async () => undefined,
    };
    const unsafeMode = {
      mode: "local-development",
      clientId: "cli",
      appSecretCredentialId: "missing",
      acknowledgeInsecureLocalCredentials: false,
      onSecurityWarning: () => undefined,
    } as unknown as Parameters<typeof createFeishuRuntime>[0]["mode"];

    await expect(
      createFeishuRuntime({
        accountId: "developer",
        userDataPath: "/unused",
        tokenCredentialId: "token",
        mode: unsafeMode,
        settings,
        ...ports,
      }),
    ).rejects.toBeInstanceOf(FeishuRuntimeConfigurationError);

    await expect(
      createFeishuRuntime({
        accountId: "developer",
        userDataPath: "/unused",
        tokenCredentialId: "token",
        mode: {
          mode: "local-development",
          clientId: "cli",
          appSecretCredentialId: "missing",
          acknowledgeInsecureLocalCredentials: true,
          onSecurityWarning: () => undefined,
        },
        settings,
        ...ports,
      }),
    ).rejects.toThrow(/secret is missing/i);
  });
});
