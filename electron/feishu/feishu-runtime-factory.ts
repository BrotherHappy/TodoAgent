import { createHash } from "node:crypto";
import path from "node:path";

import type {
  FeishuAuthConfig,
  FeishuFetch,
  FeishuTokenSet,
  FeishuTokenStore,
} from "../../src/shared/feishu-types";
import { FeishuClient } from "./feishu-client";
import {
  pollFeishuDeviceToken,
  requestFeishuDeviceAuthorization,
  type FeishuDeviceOAuthConfig,
} from "./device-oauth-flow";
import { createOAuthSession, exchangeAuthorizationCode } from "./oauth-flow";
import {
  OAuthLoopbackServer,
  type OAuthLoopbackServerOptions,
} from "./oauth-loopback-server";
import {
  FeishuSyncService,
  type FeishuApplicationConflict,
  type FeishuConflictDecision,
  type FeishuConflictResolutionResult,
  type FeishuApplicationStateStore,
  type FeishuConnectivityPort,
  type FeishuPollingCallbacks,
  type FeishuPollingScheduler,
  type FeishuSyncRunOptions,
  type FeishuSyncRunReport,
} from "./feishu-sync-service";
import {
  FeishuTaskAdapter,
  type FeishuLocalStorePort,
  type FeishuTaskServicePort,
} from "./feishu-task-adapter";
import { FeishuStateStore } from "./feishu-state-store";
import {
  deriveFeishuAppIdentityId,
  deriveFeishuSyncIdentityId,
} from "./feishu-credential-ids";

export interface FeishuSettingsPort {
  /** SettingsService decrypts this value using OS-backed secure storage. */
  getCredential(id: string): string | undefined;
  /** SettingsService encrypts the value before writing its credential file. */
  setCredential(
    kind: "feishu-app-secret" | "feishu-token",
    value: string,
    id: string,
  ): Promise<unknown>;
}

export interface FeishuRelayRuntimeMode {
  mode: "relay";
  relayBaseUrl: string;
  clientId?: string;
}

export interface FeishuDeveloperRuntimeMode {
  mode: "local-development";
  clientId: string;
  appSecretCredentialId: string;
  acknowledgeInsecureLocalCredentials: true;
  /** Required so development builds cannot enable embedded credentials silently. */
  onSecurityWarning(message: string): void;
}

export interface FeishuPersonalDirectRuntimeMode {
  mode: "personal-direct";
  clientId: string;
  appSecretCredentialId: string;
}

/** Uses an app supplied by the user, but keeps the zero-server Device OAuth flow. */
export interface FeishuExistingDirectRuntimeMode {
  mode: "existing-direct";
  clientId: string;
  appSecretCredentialId: string;
}

export type FeishuRuntimeMode =
  | FeishuPersonalDirectRuntimeMode
  | FeishuExistingDirectRuntimeMode
  | FeishuRelayRuntimeMode
  | FeishuDeveloperRuntimeMode;

export interface FeishuRuntimeFactoryOptions {
  accountId: string;
  userDataPath: string;
  tokenCredentialId: string;
  mode: FeishuRuntimeMode;
  settings: FeishuSettingsPort;
  taskService: FeishuTaskServicePort;
  localStore: FeishuLocalStorePort;
  currentUserOpenId?: string;
  fetch?: FeishuFetch;
  stateStore?: FeishuApplicationStateStore;
  connectivity?: FeishuConnectivityPort;
  scheduler?: FeishuPollingScheduler;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  createId?: () => string;
  loopbackFactory?: (
    options: OAuthLoopbackServerOptions,
  ) => OAuthLoopbackServer;
}

export interface BeginFeishuOAuthOptions {
  scopes?: readonly string[];
  timeoutMs?: number;
  callbackPath?: string;
}

export interface FeishuOAuthAuthorization {
  authorizationUrl: string;
  redirectUri?: string;
  userCode?: string;
  expiresAt?: number;
  completion: Promise<FeishuTokenSet>;
  cancel(): Promise<void>;
}

export interface FeishuRuntime {
  initialize(): Promise<void>;
  beginOAuth(
    options?: BeginFeishuOAuthOptions,
  ): Promise<FeishuOAuthAuthorization>;
  syncNow(options?: FeishuSyncRunOptions): Promise<FeishuSyncRunReport>;
  listConflicts(): Promise<FeishuApplicationConflict[]>;
  resolveConflict(
    localId: string,
    decision: FeishuConflictDecision,
  ): Promise<FeishuConflictResolutionResult>;
  notifyLocalUpsert(localId: string): Promise<void>;
  notifyLocalDelete(localId: string): Promise<void>;
  notifyLocalComplete(localId: string, completed?: boolean): Promise<void>;
  startPolling(
    intervalMs?: number,
    callbacks?: FeishuPollingCallbacks,
  ): void;
  stopPolling(): void;
  resumeAfterReconnect(): Promise<FeishuSyncRunReport | undefined>;
  close(): Promise<void>;
}

export class FeishuRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuRuntimeConfigurationError";
  }
}

function cloneToken(value: FeishuTokenSet): FeishuTokenSet {
  return { ...value, scope: [...value.scope] };
}

export function parseStoredFeishuToken(raw: string): FeishuTokenSet {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new FeishuRuntimeConfigurationError(
      "The encrypted Feishu token credential is invalid.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuRuntimeConfigurationError(
      "The encrypted Feishu token credential is invalid.",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.accessToken !== "string" ||
    typeof candidate.tokenType !== "string" ||
    !Array.isArray(candidate.scope) ||
    !candidate.scope.every((item) => typeof item === "string") ||
    typeof candidate.expiresAt !== "number"
  ) {
    throw new FeishuRuntimeConfigurationError(
      "The encrypted Feishu token credential is incomplete.",
    );
  }
  return {
    accessToken: candidate.accessToken,
    refreshToken:
      typeof candidate.refreshToken === "string"
        ? candidate.refreshToken
        : undefined,
    openId: typeof candidate.openId === "string" ? candidate.openId : undefined,
    tenantKey:
      typeof candidate.tenantKey === "string" ? candidate.tenantKey : undefined,
    appIdentityId:
      typeof candidate.appIdentityId === "string"
        ? candidate.appIdentityId
        : undefined,
    tokenType: candidate.tokenType,
    scope: [...candidate.scope] as string[],
    expiresAt: candidate.expiresAt,
    refreshTokenExpiresAt:
      typeof candidate.refreshTokenExpiresAt === "number"
        ? candidate.refreshTokenExpiresAt
        : undefined,
  };
}

export function serializeStoredFeishuToken(token: FeishuTokenSet): string {
  return JSON.stringify(cloneToken(token));
}

/** Token plaintext only crosses the SettingsService encryption boundary in memory. */
class SettingsBackedFeishuTokenStore implements FeishuTokenStore {
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: FeishuSettingsPort,
    private readonly credentialId: string,
  ) {}

  private runExclusive<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async read(): Promise<FeishuTokenSet | undefined> {
    const raw = this.settings.getCredential(this.credentialId);
    return raw === undefined
      ? undefined
      : cloneToken(parseStoredFeishuToken(raw));
  }

  async compareAndSwap(
    expectedRefreshToken: string | undefined,
    next: FeishuTokenSet,
  ): Promise<boolean> {
    return this.runExclusive(async () => {
      const current = await this.read();
      if (current?.refreshToken !== expectedRefreshToken) return false;
      await this.write(next);
      return true;
    });
  }

  async replace(next: FeishuTokenSet): Promise<void> {
    await this.runExclusive(() => this.write(next));
  }

  private async write(next: FeishuTokenSet): Promise<void> {
    await this.settings.setCredential(
      "feishu-token",
      serializeStoredFeishuToken(next),
      this.credentialId,
    );
  }
}

interface ActiveOAuthAttempt {
  completion: Promise<FeishuTokenSet>;
  cancel(): Promise<void>;
}

class DefaultFeishuRuntime implements FeishuRuntime {
  private activeOAuth?: ActiveOAuthAttempt;
  private closed = false;

  constructor(
    private readonly syncService: FeishuSyncService,
    private readonly tokenStore: SettingsBackedFeishuTokenStore,
    private readonly adapter: FeishuTaskAdapter,
    private readonly authForRedirect: (redirectUri: string) => FeishuAuthConfig,
    private readonly deviceOAuth: FeishuDeviceOAuthConfig | undefined,
    private readonly fetchImpl: FeishuFetch | undefined,
    private readonly now: () => number,
    private readonly sleep: ((milliseconds: number) => Promise<void>) | undefined,
    private readonly loopbackFactory: (
      options: OAuthLoopbackServerOptions,
    ) => OAuthLoopbackServer,
  ) {}

  async initialize(): Promise<void> {
    if (this.closed) throw new Error("Feishu runtime is closed.");
    await this.syncService.initialize();
  }

  async beginOAuth(
    options: BeginFeishuOAuthOptions = {},
  ): Promise<FeishuOAuthAuthorization> {
    if (this.closed) throw new Error("Feishu runtime is closed.");
    if (this.activeOAuth)
      throw new Error("A Feishu OAuth attempt is already active.");

    const scopes = options.scopes ?? [
      "task:task:read",
      "task:task:write",
      "task:tasklist:read",
      "offline_access",
    ];

    if (this.deviceOAuth) {
      const abortController = new AbortController();
      const authorization = await requestFeishuDeviceAuthorization(
        { ...this.deviceOAuth, scopes },
        {
          fetch: this.fetchImpl,
          now: this.now,
          signal: abortController.signal,
        },
      );
      let completion!: Promise<FeishuTokenSet>;
      completion = (async () => {
        try {
          const token = await pollFeishuDeviceToken(
            { ...this.deviceOAuth!, scopes },
            authorization,
            {
              fetch: this.fetchImpl,
              now: this.now,
              sleep: this.sleep,
              signal: abortController.signal,
              timeoutMs: options.timeoutMs,
            },
          );
          await this.tokenStore.replace(token);
          if (token.openId) this.adapter.setCurrentUserOpenId(token.openId);
          return cloneToken(token);
        } finally {
          if (this.activeOAuth?.completion === completion) {
            this.activeOAuth = undefined;
          }
        }
      })();
      const cancel = async () => abortController.abort();
      this.activeOAuth = { completion, cancel };
      return {
        authorizationUrl: authorization.verificationUriComplete,
        userCode: authorization.userCode,
        expiresAt: authorization.expiresAt,
        completion,
        cancel,
      };
    }

    const server = this.loopbackFactory({
      callbackPath: options.callbackPath,
      timeoutMs: options.timeoutMs,
    });
    const redirectUri = await server.listen();
    const auth = this.authForRedirect(redirectUri);
    const session = createOAuthSession(
      auth,
      scopes,
    );
    const callback = server.waitForCallback(session.state);
    let completion!: Promise<FeishuTokenSet>;
    completion = (async () => {
      try {
        const token = await exchangeAuthorizationCode(
          auth,
          await callback,
          session,
          { fetch: this.fetchImpl, now: this.now },
        );
        await this.tokenStore.replace(token);
        if (token.openId) this.adapter.setCurrentUserOpenId(token.openId);
        return cloneToken(token);
      } finally {
        await server.close();
        if (this.activeOAuth?.completion === completion) {
          this.activeOAuth = undefined;
        }
      }
    })();
    const cancel = () => server.cancel();
    this.activeOAuth = { completion, cancel };

    return {
      authorizationUrl: session.authorizationUrl,
      redirectUri,
      completion,
      cancel,
    };
  }

  syncNow(options?: FeishuSyncRunOptions): Promise<FeishuSyncRunReport> {
    if (this.closed)
      return Promise.reject(new Error("Feishu runtime is closed."));
    return this.syncService.syncNow(options);
  }

  listConflicts(): Promise<FeishuApplicationConflict[]> {
    if (this.closed)
      return Promise.reject(new Error("Feishu runtime is closed."));
    return this.syncService.listConflicts();
  }

  resolveConflict(
    localId: string,
    decision: FeishuConflictDecision,
  ): Promise<FeishuConflictResolutionResult> {
    if (this.closed)
      return Promise.reject(new Error("Feishu runtime is closed."));
    return this.syncService.resolveConflict(localId, decision);
  }

  async notifyLocalUpsert(localId: string): Promise<void> {
    if (this.closed) throw new Error("Feishu runtime is closed.");
    await this.syncService.notifyLocalUpsert(localId);
  }

  async notifyLocalDelete(localId: string): Promise<void> {
    if (this.closed) throw new Error("Feishu runtime is closed.");
    await this.syncService.notifyLocalDelete(localId);
  }

  async notifyLocalComplete(localId: string, completed = true): Promise<void> {
    if (this.closed) throw new Error("Feishu runtime is closed.");
    await this.syncService.notifyLocalComplete(localId, completed);
  }

  startPolling(
    intervalMs?: number,
    callbacks?: FeishuPollingCallbacks,
  ): void {
    if (this.closed) throw new Error("Feishu runtime is closed.");
    this.syncService.startPolling(intervalMs, callbacks);
  }

  stopPolling(): void {
    this.syncService.stopPolling();
  }

  resumeAfterReconnect(): Promise<FeishuSyncRunReport | undefined> {
    if (this.closed)
      return Promise.reject(new Error("Feishu runtime is closed."));
    return this.syncService.resumeAfterReconnect();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.syncService.stopPolling();
    const active = this.activeOAuth;
    this.activeOAuth = undefined;
    if (active) {
      const settled = active.completion.catch(() => undefined);
      await active.cancel();
      await settled;
    }
  }
}

function validateCommon(options: FeishuRuntimeFactoryOptions): void {
  if (!options.accountId.trim()) {
    throw new FeishuRuntimeConfigurationError("Feishu accountId is required.");
  }
  if (!options.tokenCredentialId.trim()) {
    throw new FeishuRuntimeConfigurationError(
      "A secure token credential id is required.",
    );
  }
  if (options.mode.mode === "relay") {
    if (!/^https:\/\//i.test(options.mode.relayBaseUrl)) {
      throw new FeishuRuntimeConfigurationError("Relay mode requires HTTPS.");
    }
    return;
  }
  if (
    options.mode.mode === "personal-direct" ||
    options.mode.mode === "existing-direct"
  ) {
    if (!options.mode.clientId.trim() || !options.mode.appSecretCredentialId.trim()) {
      throw new FeishuRuntimeConfigurationError(
        "Direct Feishu app credentials are required.",
      );
    }
    return;
  }
  if (options.mode.acknowledgeInsecureLocalCredentials !== true) {
    throw new FeishuRuntimeConfigurationError(
      "Developer credentials require explicit acknowledgement.",
    );
  }
}

/**
 * Builds an account-scoped runtime without touching main/preload. Main only
 * needs to retain the returned object and call initialize()/close().
 */
export async function createFeishuRuntime(
  options: FeishuRuntimeFactoryOptions,
): Promise<FeishuRuntime> {
  validateCommon(options);
  const now = options.now ?? Date.now;
  const tokenStore = new SettingsBackedFeishuTokenStore(
    options.settings,
    options.tokenCredentialId,
  );

  let authForRedirect: (redirectUri: string) => FeishuAuthConfig;
  let deviceOAuth: FeishuDeviceOAuthConfig | undefined;
  if (options.mode.mode === "relay") {
    const mode = options.mode;
    authForRedirect = (redirectUri) => ({
      mode: "relay",
      relayBaseUrl: mode.relayBaseUrl,
      clientId: mode.clientId,
      redirectUri,
    });
  } else {
    const mode = options.mode;
    if (mode.mode === "local-development") {
      mode.onSecurityWarning(
        "Developer mode sends a Feishu app secret from this process. Never ship shared credentials to users.",
      );
    }
    const appSecret = options.settings.getCredential(
      mode.appSecretCredentialId,
    );
    if (!appSecret) {
      throw new FeishuRuntimeConfigurationError(
        "The encrypted Feishu app secret is missing.",
      );
    }
    authForRedirect = (redirectUri) => ({
      mode: "local-development",
      clientId: mode.clientId,
      clientSecret: appSecret,
      redirectUri,
      acknowledgeInsecureLocalCredentials: true,
    });
    if (
      mode.mode === "personal-direct" ||
      mode.mode === "existing-direct"
    ) {
      deviceOAuth = {
        clientId: mode.clientId,
        clientSecret: appSecret,
      };
    }
  }

  const placeholderRedirect = "http://127.0.0.1/oauth/feishu/callback";
  const client = new FeishuClient({
    auth: authForRedirect(placeholderRedirect),
    tokenStore,
    fetch: options.fetch,
    now,
    sleep: options.sleep,
  });
  const storedToken = await tokenStore.read();
  const appIdentityId = deriveFeishuAppIdentityId({
    mode: options.mode.mode,
    clientId: options.mode.mode === "relay" ? options.mode.clientId : options.mode.clientId,
    relayBaseUrl:
      options.mode.mode === "relay" ? options.mode.relayBaseUrl : undefined,
  });
  if (
    storedToken?.appIdentityId !== undefined &&
    storedToken.appIdentityId !== appIdentityId
  ) {
    throw new FeishuRuntimeConfigurationError(
      "The encrypted Feishu token belongs to another OAuth application.",
    );
  }
  const syncIdentityId = storedToken?.openId
    ? deriveFeishuSyncIdentityId({
        appIdentityId,
        openId: storedToken.openId,
        tenantKey: storedToken.tenantKey,
      })
    : undefined;
  const adapter = new FeishuTaskAdapter({
    taskService: options.taskService,
    localStore: options.localStore,
    accountId: options.accountId,
    currentUserOpenId: options.currentUserOpenId ?? storedToken?.openId,
    syncIdentityId,
    now,
  });
  const legacyAccountDirectory = createHash("sha256")
    .update(options.accountId, "utf8")
    .digest("hex")
    .slice(0, 24);
  let stateStore = options.stateStore;
  if (!stateStore) {
    if (syncIdentityId) {
      const identityStore = new FeishuStateStore({
        directory: path.join(
          options.userDataPath,
          "feishu",
          "identities",
          syncIdentityId.replace(/^feishu-sync-/u, ""),
        ),
      });
      if ((await identityStore.load()) === undefined) {
        const legacyStore = new FeishuStateStore({
          directory: path.join(
            options.userDataPath,
            "feishu",
            legacyAccountDirectory,
          ),
        });
        const legacy = await legacyStore.load();
        if (
          legacy &&
          (legacy.syncIdentityId === undefined ||
            legacy.syncIdentityId === syncIdentityId)
        ) {
          const claimed = { ...legacy, syncIdentityId };
          // Mark the legacy source before copying it. A later login by another
          // open_id can see the owner and must start with an empty namespace.
          await legacyStore.save(claimed);
          // Keep the copy unbound for one load so FeishuSyncService can also
          // claim the exact local task ids proven by its mappings/queue.
          await identityStore.save(legacy);
        }
      }
      stateStore = identityStore;
    } else {
      stateStore = new FeishuStateStore({
        directory: path.join(
          options.userDataPath,
          "feishu",
          legacyAccountDirectory,
        ),
      });
    }
  }
  const syncService = new FeishuSyncService({
    remote: client,
    adapter,
    stateStore,
    syncIdentityId,
    connectivity: options.connectivity,
    scheduler: options.scheduler,
    sleep: options.sleep,
    now,
    createId: options.createId,
  });
  return new DefaultFeishuRuntime(
    syncService,
    tokenStore,
    adapter,
    authForRedirect,
    deviceOAuth,
    options.fetch,
    now,
    options.sleep,
    options.loopbackFactory ??
      ((loopbackOptions) => new OAuthLoopbackServer(loopbackOptions)),
  );
}
