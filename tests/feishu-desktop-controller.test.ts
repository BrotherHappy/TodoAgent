// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type {
  CreateTaskInput,
  LocalAppState,
  Task,
  TaskFilter,
  TaskMutationResult,
} from '../src/shared/models';
import { createEmptyLocalAppState } from '../src/shared/models';
import type { PublicCredentialState } from '../src/shared/settings';
import type { FeishuTokenSet } from '../src/shared/feishu-types';
import {
  FeishuRateLimitError,
} from '../electron/feishu/feishu-client';
import { OAuthLoopbackError } from '../electron/feishu/oauth-loopback-server';
import { FeishuDeviceOAuthError } from '../electron/feishu/device-oauth-flow';
import {
  FeishuAppRegistrationError,
  type FeishuAppRegistrationSession,
} from '../electron/feishu/feishu-app-registration';
import type {
  FeishuApplicationConflict,
  FeishuConflictDecision,
  FeishuConflictResolutionResult,
  FeishuPollingCallbacks,
  FeishuSyncRunReport,
} from '../electron/feishu/feishu-sync-service';
import type {
  BeginFeishuOAuthOptions,
  FeishuOAuthAuthorization,
  FeishuRuntime,
  FeishuRuntimeFactoryOptions,
} from '../electron/feishu/feishu-runtime-factory';
import {
  deriveFeishuAppSecretCredentialId,
  deriveFeishuTokenCredentialId,
} from '../electron/feishu/feishu-credential-ids';
import {
  FeishuDesktopController,
  FeishuDesktopControllerError,
  type FeishuDesktopPersonalConfiguration,
  type FeishuDesktopSettingsPort,
  type FeishuDesktopStatus,
} from '../electron/feishu/feishu-desktop-controller';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function token(): FeishuTokenSet {
  return {
    accessToken: 'token-hidden-from-controller-output',
    refreshToken: 'refresh-hidden-from-controller-output',
    tokenType: 'Bearer',
    scope: [],
    expiresAt: NOW + 3_600_000,
  };
}

function report(overrides: Partial<FeishuSyncRunReport> = {}): FeishuSyncRunReport {
  return {
    pushed: 0,
    pulled: 0,
    deleted: 0,
    conflicts: [],
    offline: false,
    usedFullSync: false,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'local-1',
    source: { type: 'feishu', externalId: 'remote-1' },
    title: 'Task',
    notes: '',
    privateNotes: 'local only',
    status: 'open',
    priority: 'none',
    tags: [],
    dependencyIds: [],
    assigneeIds: [],
    followerIds: [],
    attachments: [],
    links: [],
    customFields: {},
    reminders: [],
    focusElapsedSeconds: 0,
    focusSessions: [],
    privateOrder: 0,
    sync: { status: 'synced' },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

const conflict: FeishuApplicationConflict = {
  localId: 'local-1',
  guid: 'remote-1',
  base: { title: 'base', notes: '', status: 'open' },
  local: { title: 'local', notes: '', status: 'open' },
  remote: { title: 'remote', notes: '', status: 'open' },
  fields: [{ field: 'title', base: 'base', local: 'local', remote: 'remote' }],
  detectedAt: new Date(NOW).toISOString(),
};

class MemorySettings implements FeishuDesktopSettingsPort {
  readonly credentials = new Map<string, { metadata: PublicCredentialState; value: string }>();
  readonly getCalls: string[] = [];
  readonly setCalls: Array<{
    kind: 'feishu-app-secret' | 'feishu-token';
    value: string;
    id: string;
  }> = [];
  readonly deleted: string[] = [];

  add(id: string, kind: PublicCredentialState['kind'], value = 'secure value'): void {
    this.credentials.set(id, {
      metadata: {
        id,
        kind,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
      value,
    });
  }

  getCredential(id: string): string | undefined {
    this.getCalls.push(id);
    return this.credentials.get(id)?.value;
  }

  async setCredential(
    kind: 'feishu-app-secret' | 'feishu-token',
    value: string,
    id: string,
  ): Promise<void> {
    this.setCalls.push({ kind, value, id });
    this.add(id, kind, value);
  }

  listCredentials(): PublicCredentialState[] {
    return [...this.credentials.values()].map(({ metadata }) => ({ ...metadata }));
  }

  async deleteCredential(id: string): Promise<boolean> {
    this.deleted.push(id);
    return this.credentials.delete(id);
  }
}

class MemoryLocalStore {
  state: LocalAppState = createEmptyLocalAppState();
  transactions = 0;

  async transact<Result>(
    mutator: (draft: LocalAppState) => Result | Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    return mutator(this.state);
  }
}

class EmptyTaskService {
  async getTask(_id: string, _includeDeleted?: boolean): Promise<Task | undefined> {
    return undefined;
  }

  async listTasks(_filter?: TaskFilter): Promise<Task[]> {
    return [];
  }

  async createTask(_input: CreateTaskInput): Promise<TaskMutationResult> {
    throw new Error('not used');
  }
}

class MockRuntime implements FeishuRuntime {
  initializeCalls = 0;
  closeCalls = 0;
  syncCalls = 0;
  resumeCalls = 0;
  startPollingCalls: Array<number | undefined> = [];
  stopPollingCalls = 0;
  pollingCallbacks?: FeishuPollingCallbacks;
  beginOAuthCalls = 0;
  beginOAuthOptions: BeginFeishuOAuthOptions[] = [];
  listConflictCalls = 0;
  resolveConflictCalls: Array<[string, FeishuConflictDecision]> = [];
  localMutationCalls: Array<['upsert' | 'delete' | 'complete', string, boolean?]> = [];
  nextOAuth?: FeishuOAuthAuthorization;
  syncResult: FeishuSyncRunReport | Error = report({ pushed: 1 });
  resumeResult: FeishuSyncRunReport | Error | undefined = report({ pushed: 1 });
  conflicts: FeishuApplicationConflict[] = [conflict];
  conflictResult: FeishuConflictResolutionResult = {
    decision: 'keep-local',
    task: task(),
  };

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  async beginOAuth(
    options: BeginFeishuOAuthOptions = {},
  ): Promise<FeishuOAuthAuthorization> {
    this.beginOAuthCalls += 1;
    this.beginOAuthOptions.push(structuredClone(options));
    if (!this.nextOAuth) throw new Error('No OAuth result configured.');
    return this.nextOAuth;
  }

  async syncNow(): Promise<FeishuSyncRunReport> {
    this.syncCalls += 1;
    if (this.syncResult instanceof Error) throw this.syncResult;
    return this.syncResult;
  }

  async resumeAfterReconnect(): Promise<FeishuSyncRunReport | undefined> {
    this.resumeCalls += 1;
    if (this.resumeResult instanceof Error) throw this.resumeResult;
    return this.resumeResult;
  }

  async listConflicts(): Promise<FeishuApplicationConflict[]> {
    this.listConflictCalls += 1;
    return structuredClone(this.conflicts);
  }

  async resolveConflict(
    localId: string,
    decision: FeishuConflictDecision,
  ): Promise<FeishuConflictResolutionResult> {
    this.resolveConflictCalls.push([localId, decision]);
    return structuredClone({ ...this.conflictResult, decision });
  }

  async notifyLocalUpsert(localId: string): Promise<void> {
    this.localMutationCalls.push(['upsert', localId]);
  }

  async notifyLocalDelete(localId: string): Promise<void> {
    this.localMutationCalls.push(['delete', localId]);
  }

  async notifyLocalComplete(localId: string, completed = true): Promise<void> {
    this.localMutationCalls.push(['complete', localId, completed]);
  }

  startPolling(
    intervalMs?: number,
    callbacks?: FeishuPollingCallbacks,
  ): void {
    this.startPollingCalls.push(intervalMs);
    this.pollingCallbacks = callbacks;
  }

  reportFromPolling(next: FeishuSyncRunReport): void {
    this.pollingCallbacks?.onReport?.(next);
  }

  failFromPolling(error: unknown): void {
    this.pollingCallbacks?.onError?.(error);
  }

  stopPolling(): void {
    this.stopPollingCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function oauthAttempt() {
  const result = deferred<FeishuTokenSet>();
  const authorization: FeishuOAuthAuthorization = {
    authorizationUrl: 'https://accounts.example.test/authorize?state=opaque',
    redirectUri: 'http://127.0.0.1:12345/oauth/feishu/callback',
    completion: result.promise,
    cancel: async () => {
      result.reject(new OAuthLoopbackError('CANCELLED', 'cancelled'));
    },
  };
  return { ...result, authorization };
}

function registrationAttempt(): {
  session: FeishuAppRegistrationSession;
  verification: ReturnType<
    typeof deferred<{
      verificationUrl: string;
      expiresAt: number;
    }>
  >;
  result: ReturnType<
    typeof deferred<{
      client_id: string;
      client_secret: string;
      open_id?: string;
      tenant_brand?: 'feishu' | 'lark';
    }>
  >;
  state: { cancelCalls: number };
} {
  const verification = deferred<{
    verificationUrl: string;
    expiresAt: number;
  }>();
  const result = deferred<{
    client_id: string;
    client_secret: string;
    open_id?: string;
    tenant_brand?: 'feishu' | 'lark';
  }>();
  const state = { cancelCalls: 0 };
  const session: FeishuAppRegistrationSession = {
    verification: verification.promise,
    result: result.promise,
    cancel: () => {
      state.cancelCalls += 1;
      const error = new FeishuAppRegistrationError(
        'abort',
        'raw registration cancellation detail',
      );
      verification.reject(error);
      result.reject(error);
    },
  };
  return { session, verification, result, state };
}

function harness(options: {
  connected?: boolean;
  secret?: boolean;
  onSecurityWarning?: (message: string) => void;
  personalRegistrationFactory?: () => FeishuAppRegistrationSession;
  onPersonalConfiguration?: (
    configuration: FeishuDesktopPersonalConfiguration,
  ) => void | Promise<void>;
  onOpenAuthorizationUrl?: (url: string) => void | Promise<void>;
} = {}) {
  const settings = new MemorySettings();
  if (options.connected) settings.add('token-ref', 'feishu-token');
  if (options.secret) settings.add('secret-ref', 'feishu-app-secret', 'RAW-SECRET');
  const runtime = new MockRuntime();
  const runtimeOptions: FeishuRuntimeFactoryOptions[] = [];
  const statuses: FeishuDesktopStatus[] = [];
  const personalConfigurations: FeishuDesktopPersonalConfiguration[] = [];
  const openedAuthorizationUrls: string[] = [];
  const localStore = new MemoryLocalStore();
  const controller = new FeishuDesktopController({
    userDataPath: '/not-used-by-mock-runtime',
    settings,
    taskService: new EmptyTaskService(),
    localStore,
    runtimeFactory: async (factoryOptions) => {
      runtimeOptions.push(factoryOptions);
      return runtime;
    },
    now: () => NOW,
    onStatusChange: (status) => statuses.push(status),
    onSecurityWarning: options.onSecurityWarning,
    personalRegistrationFactory: options.personalRegistrationFactory,
    onPersonalConfiguration: async (configuration) => {
      personalConfigurations.push(structuredClone(configuration));
      await options.onPersonalConfiguration?.(configuration);
    },
    onOpenAuthorizationUrl: async (url) => {
      openedAuthorizationUrls.push(url);
      await options.onOpenAuthorizationUrl?.(url);
    },
  });
  return {
    controller,
    settings,
    runtime,
    runtimeOptions,
    statuses,
    personalConfigurations,
    openedAuthorizationUrls,
    localStore,
  };
}

describe('FeishuDesktopController connection state machine', () => {
  it('orchestrates personal app registration, secure persistence, and Device OAuth without leaking the secret', async () => {
    const registration = registrationAttempt();
    const context = harness({
      personalRegistrationFactory: () => registration.session,
    });
    const device = oauthAttempt();
    device.authorization.authorizationUrl =
      'https://accounts.feishu.cn/device?user_code=DEVICE-CODE';
    device.authorization.expiresAt = NOW + 180_000;
    context.runtime.nextOAuth = device.authorization;

    registration.verification.resolve({
      verificationUrl:
        'https://accounts.feishu.cn/app-registration?user_code=APP-CODE',
      expiresAt: NOW + 90_000,
    });
    const started = await context.controller.beginPersonalConnect({
      accountId: ' personal-owner ',
      tokenCredentialId: ' personal-token-ref ',
      appSecretCredentialId: ' personal-secret-ref ',
      timeoutMs: 240_000,
    });

    expect(started).toEqual({
      authorizeUrl:
        'https://accounts.feishu.cn/app-registration?user_code=APP-CODE',
      expiresAt: new Date(NOW + 90_000).toISOString(),
    });
    expect(context.controller.status()).toMatchObject({
      state: 'authorizing',
      connected: false,
      authorizationStep: 'app-registration',
      oauthExpiresAt: started.expiresAt,
    });

    const rawSecret = 'RAW-PERSONAL-APP-SECRET-MUST-STAY-LOCAL';
    registration.result.resolve({
      client_id: 'cli_personal_owner',
      client_secret: rawSecret,
      open_id: 'ou_personal_owner',
      tenant_brand: 'feishu',
    });
    const personalIdentity = {
      mode: 'personal-direct' as const,
      accountId: 'personal-owner',
      clientId: 'cli_personal_owner',
    };
    const personalSecretId =
      deriveFeishuAppSecretCredentialId(personalIdentity);
    const personalTokenId = deriveFeishuTokenCredentialId(personalIdentity);

    await vi.waitFor(() => {
      expect(context.openedAuthorizationUrls).toEqual([
        device.authorization.authorizationUrl,
      ]);
    });
    expect(context.settings.setCalls).toEqual([
      {
        kind: 'feishu-app-secret',
        value: rawSecret,
        id: personalSecretId,
      },
    ]);
    expect(context.settings.listCredentials()).toEqual([
      expect.objectContaining({
        id: personalSecretId,
        kind: 'feishu-app-secret',
      }),
    ]);
    expect(context.personalConfigurations).toEqual([
      {
        mode: 'personal-direct',
        accountId: 'personal-owner',
        tokenCredentialId: personalTokenId,
        clientId: 'cli_personal_owner',
        appSecretCredentialId: personalSecretId,
      },
    ]);
    expect(context.runtimeOptions).toHaveLength(1);
    expect(context.runtimeOptions[0].mode).toEqual({
      mode: 'personal-direct',
      clientId: 'cli_personal_owner',
      appSecretCredentialId: personalSecretId,
    });
    expect(context.runtime.beginOAuthCalls).toBe(1);
    expect(context.controller.status()).toMatchObject({
      state: 'authorizing',
      configured: true,
      connected: false,
      mode: 'personal-direct',
      authorizationStep: 'account-authorization',
      oauthExpiresAt: new Date(NOW + 180_000).toISOString(),
    });

    const publicSurface = {
      started,
      statuses: context.statuses,
      configuration: context.personalConfigurations,
      runtimeMode: context.runtimeOptions[0].mode,
      openedAuthorizationUrls: context.openedAuthorizationUrls,
    };
    expect(JSON.stringify(publicSurface)).not.toContain(rawSecret);

    device.resolve(token());
    await expect(context.controller.completeOAuth()).resolves.toMatchObject({
      state: 'connected',
      configured: true,
      connected: true,
      mode: 'personal-direct',
      authorizationStep: undefined,
      oauthExpiresAt: undefined,
    });
  });

  it('cancels an in-flight personal app registration with a stable sanitized result', async () => {
    const registration = registrationAttempt();
    const context = harness({
      personalRegistrationFactory: () => registration.session,
    });
    const begin = context.controller.beginPersonalConnect({
      accountId: 'personal-owner',
      tokenCredentialId: 'personal-token-ref',
      appSecretCredentialId: 'personal-secret-ref',
    });
    const beginRejection = expect(begin).rejects.toMatchObject({
      code: 'OAUTH_CANCELLED',
      message: '飞书专属应用创建已取消。',
      retryable: false,
    });

    await expect(context.controller.cancelOAuth()).resolves.toMatchObject({
      state: 'disconnected',
      connected: false,
      authorizationStep: undefined,
      oauthExpiresAt: undefined,
    });
    await beginRejection;
    expect(registration.state.cancelCalls).toBe(1);
    expect(context.settings.setCalls).toEqual([]);
    expect(context.personalConfigurations).toEqual([]);
    expect(context.runtime.beginOAuthCalls).toBe(0);
    expect(JSON.stringify(context.controller.status())).not.toContain(
      'raw registration cancellation detail',
    );
  });

  it('does not open Device OAuth when cancelled during the registration handoff', async () => {
    const registration = registrationAttempt();
    const configurationGate = deferred<void>();
    const context = harness({
      personalRegistrationFactory: () => registration.session,
      onPersonalConfiguration: () => configurationGate.promise,
    });
    context.runtime.nextOAuth = oauthAttempt().authorization;

    registration.verification.resolve({
      verificationUrl:
        'https://accounts.feishu.cn/app-registration?user_code=APP-CODE',
      expiresAt: NOW + 90_000,
    });
    await context.controller.beginPersonalConnect({
      accountId: 'personal-owner',
      tokenCredentialId: 'personal-token-ref',
      appSecretCredentialId: 'personal-secret-ref',
    });
    registration.result.resolve({
      client_id: 'cli_personal_owner',
      client_secret: 'personal-secret',
    });
    const personalSecretId = deriveFeishuAppSecretCredentialId({
      mode: 'personal-direct',
      accountId: 'personal-owner',
      clientId: 'cli_personal_owner',
    });

    await vi.waitFor(() => {
      expect(context.personalConfigurations).toHaveLength(1);
    });
    const cancellation = context.controller.cancelOAuth();
    await vi.waitFor(() => expect(registration.state.cancelCalls).toBe(1));
    configurationGate.resolve();

    await expect(cancellation).resolves.toMatchObject({
      state: 'disconnected',
      configured: true,
      connected: false,
      authorizationStep: undefined,
    });
    expect(context.runtime.beginOAuthCalls).toBe(0);
    expect(context.openedAuthorizationUrls).toEqual([]);
    expect(context.settings.setCalls).toEqual([
      {
        kind: 'feishu-app-secret',
        value: 'personal-secret',
        id: personalSecretId,
      },
    ]);
  });

  it.each([
    {
      sdkCode: 'access_denied',
      expectedCode: 'OAUTH_CANCELLED',
      expectedMessage: '飞书专属应用创建已取消。',
      retryable: false,
    },
    {
      sdkCode: 'server_error',
      expectedCode: 'OAUTH_FAILED',
      expectedMessage: '飞书授权未完成，请重试。',
      retryable: true,
    },
  ])(
    'maps registration SDK rejection $sdkCode to a stable sanitized error',
    async ({ sdkCode, expectedCode, expectedMessage, retryable }) => {
      const registration = registrationAttempt();
      const context = harness({
        personalRegistrationFactory: () => registration.session,
      });
      const begin = context.controller.beginPersonalConnect({
        accountId: 'personal-owner',
        tokenCredentialId: 'personal-token-ref',
        appSecretCredentialId: 'personal-secret-ref',
      });
      const rawProviderDetail = `RAW-SDK-DETAIL-${sdkCode}`;
      const sdkError = Object.assign(new Error(rawProviderDetail), {
        code: sdkCode,
        description: rawProviderDetail,
      });

      registration.verification.reject(sdkError);
      registration.result.reject(sdkError);

      await expect(begin).rejects.toMatchObject({
        code: expectedCode,
        message: expectedMessage,
        retryable,
      });
      expect(context.controller.status()).toMatchObject({
        state: 'error',
        connected: false,
        lastError: {
          code: expectedCode,
          message: expectedMessage,
          retryable,
        },
      });
      expect(JSON.stringify(context.controller.status())).not.toContain(
        rawProviderDetail,
      );
      expect(context.settings.setCalls).toEqual([]);
      expect(context.personalConfigurations).toEqual([]);
      expect(context.runtime.beginOAuthCalls).toBe(0);
    },
  );

  it('never syncs/uploads before OAuth, then enables sync and polling after completion', async () => {
    const context = harness();
    await expect(context.controller.syncNow()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await context.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });
    expect(context.controller.status()).toMatchObject({
      state: 'disconnected',
      configured: true,
      connected: false,
    });
    await expect(context.controller.syncNow()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    await expect(context.controller.startPolling()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    expect(context.runtime.syncCalls).toBe(0);
    expect(context.runtime.startPollingCalls).toEqual([]);

    const oauth = oauthAttempt();
    context.runtime.nextOAuth = oauth.authorization;
    const started = await context.controller.beginOAuth({ timeoutMs: 2_500 });
    expect(started).toEqual({
      authorizeUrl: oauth.authorization.authorizationUrl,
      expiresAt: new Date(NOW + 2_500).toISOString(),
    });
    expect(context.controller.status()).toMatchObject({
      state: 'authorizing',
      connected: false,
      oauthExpiresAt: started.expiresAt,
    });
    await expect(context.controller.beginOAuth()).rejects.toMatchObject({
      code: 'ALREADY_AUTHORIZING',
    });

    oauth.resolve(token());
    await expect(context.controller.completeOAuth()).resolves.toMatchObject({
      state: 'connected',
      connected: true,
    });
    await expect(context.controller.syncNow()).resolves.toMatchObject({ pushed: 1 });
    await context.controller.startPolling(30_000);
    expect(context.runtime.syncCalls).toBe(1);
    expect(context.runtime.startPollingCalls).toEqual([30_000]);
    expect(context.controller.status()).toMatchObject({
      state: 'connected',
      polling: true,
      lastSyncAt: new Date(NOW).toISOString(),
    });
    context.controller.stopPolling();
    expect(context.controller.status().polling).toBe(false);
    expect(context.statuses.some((status) => status.state === 'authorizing')).toBe(
      true,
    );
  });

  it('immediately resumes durable work after reconnect and reports an offline launch honestly', async () => {
    const recovered = harness({ connected: true });
    await recovered.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });
    recovered.runtime.resumeResult = report({ pushed: 2, pulled: 1 });

    await expect(recovered.controller.resumeAfterReconnect()).resolves.toMatchObject({
      pushed: 2,
      pulled: 1,
    });
    expect(recovered.runtime.resumeCalls).toBe(1);
    expect(recovered.controller.status()).toMatchObject({
      state: 'connected',
      connected: true,
      lastSyncAt: new Date(NOW).toISOString(),
      lastError: undefined,
    });

    const offline = harness({ connected: true });
    await offline.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });
    offline.runtime.resumeResult = undefined;

    await expect(offline.controller.resumeAfterReconnect()).resolves.toBeUndefined();
    expect(offline.controller.status()).toMatchObject({
      state: 'connected',
      connected: true,
      lastError: { code: 'NETWORK_UNAVAILABLE', retryable: true },
    });
    expect(offline.controller.status().lastSyncAt).toBeUndefined();
  });

  it('keeps background polling status accurate for retryable and terminal outcomes', async () => {
    const retryable = harness({ connected: true });
    await retryable.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });
    await retryable.controller.startPolling(30_000);
    retryable.runtime.reportFromPolling(
      report({ issue: { code: 'RATE_LIMITED', retryable: true } }),
    );
    expect(retryable.controller.status()).toMatchObject({
      state: 'connected',
      connected: true,
      polling: true,
      lastError: { code: 'RATE_LIMITED', retryable: true },
    });
    expect(retryable.controller.status().lastSyncAt).toBeUndefined();

    retryable.runtime.reportFromPolling(report({ pushed: 1 }));
    expect(retryable.controller.status()).toMatchObject({
      state: 'connected',
      polling: true,
      lastSyncAt: new Date(NOW).toISOString(),
      lastError: undefined,
    });

    const terminal = harness({ connected: true });
    await terminal.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });
    await terminal.controller.startPolling(30_000);
    terminal.runtime.reportFromPolling(
      report({ issue: { code: 'PERMISSION_DENIED', retryable: false } }),
    );
    expect(terminal.controller.status()).toMatchObject({
      state: 'error',
      connected: true,
      polling: false,
      lastError: { code: 'PERMISSION_DENIED', retryable: false },
    });
    expect(terminal.runtime.stopPollingCalls).toBe(1);
  });

  it('maps OAuth cancellation and expiry to stable UI error codes', async () => {
    const context = harness();
    await context.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });

    const cancelled = oauthAttempt();
    context.runtime.nextOAuth = cancelled.authorization;
    await context.controller.beginOAuth();
    await expect(context.controller.cancelOAuth()).resolves.toMatchObject({
      state: 'disconnected',
    });
    await expect(context.controller.completeOAuth()).rejects.toMatchObject({
      code: 'NO_ACTIVE_OAUTH',
    });

    const expired = oauthAttempt();
    context.runtime.nextOAuth = expired.authorization;
    await context.controller.beginOAuth();
    expired.reject(new OAuthLoopbackError('TIMEOUT', 'raw timeout detail'));
    await expect(context.controller.completeOAuth()).rejects.toMatchObject({
      code: 'OAUTH_EXPIRED',
      message: '飞书授权已过期，请重新连接。',
      retryable: true,
    });
    expect(context.controller.status()).toMatchObject({
      state: 'error',
      connected: false,
      lastError: { code: 'OAUTH_EXPIRED' },
    });

    const insufficient = oauthAttempt();
    context.runtime.nextOAuth = insufficient.authorization;
    await context.controller.beginOAuth();
    insufficient.reject(
      new FeishuDeviceOAuthError(
        'oauth_error',
        'raw scope detail',
        { providerError: 'insufficient_scope' },
      ),
    );
    await expect(context.controller.completeOAuth()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '飞书授权缺少任务写入或离线访问权限，请在应用后台启用后重试。',
      retryable: false,
    });
    expect(context.controller.status()).toMatchObject({
      state: 'error',
      connected: false,
      lastError: { code: 'PERMISSION_DENIED' },
    });
  });

  it('detects an existing secure token reference and disconnects without touching local tasks', async () => {
    const context = harness({ connected: true });
    await context.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });
    expect(context.controller.status().connected).toBe(true);
    const localStateBefore = structuredClone(context.localStore.state);

    const disconnecting = context.controller.disconnect();
    expect(context.controller.status()).toMatchObject({
      state: 'disconnected',
      connected: false,
    });
    await disconnecting;
    expect(context.settings.deleted).toEqual(['token-ref']);
    expect(context.runtime.stopPollingCalls).toBeGreaterThanOrEqual(1);
    expect(context.runtime.closeCalls).toBe(1);
    expect(context.localStore.transactions).toBe(0);
    expect(context.localStore.state).toEqual(localStateBefore);
    expect(context.controller.status()).toMatchObject({
      state: 'disconnected',
      connected: false,
      configured: true,
    });
    await expect(context.controller.syncNow()).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    expect(context.runtime.syncCalls).toBe(0);
  });
});

describe('FeishuDesktopController configuration and operations', () => {
  it('configures an existing app for Device OAuth without developer warning or plaintext secret access', async () => {
    const context = harness({ secret: true });
    const device = oauthAttempt();
    device.authorization.authorizationUrl =
      'https://accounts.feishu.cn/device?user_code=EXISTING-CODE';
    device.authorization.redirectUri = undefined;
    device.authorization.expiresAt = NOW + 420_000;
    context.runtime.nextOAuth = device.authorization;

    await context.controller.configure({
      accountId: 'existing-account',
      tokenCredentialId: 'token-ref',
      mode: 'existing-direct',
      clientId: 'cli_reviewed_existing',
      appSecretCredentialId: 'secret-ref',
    });
    expect(context.runtimeOptions[0].mode).toEqual({
      mode: 'existing-direct',
      clientId: 'cli_reviewed_existing',
      appSecretCredentialId: 'secret-ref',
    });
    expect(context.settings.getCalls).toEqual([]);
    expect(JSON.stringify(context.runtimeOptions[0])).not.toContain('RAW-SECRET');

    const started = await context.controller.beginOAuth();
    expect(started.authorizeUrl).toBe(device.authorization.authorizationUrl);
    expect(started.expiresAt).toBe(new Date(NOW + 420_000).toISOString());
    expect(context.runtime.beginOAuthOptions).toEqual([
      { timeoutMs: 600_000, scopes: undefined },
    ]);
    expect(context.controller.status()).toMatchObject({
      state: 'authorizing',
      mode: 'existing-direct',
      authorizationStep: 'account-authorization',
    });
    device.resolve(token());
    await expect(context.controller.completeOAuth()).resolves.toMatchObject({
      state: 'connected',
      connected: true,
      mode: 'existing-direct',
    });
  });

  it.each(['invalid_client', 'unauthorized_client'])(
    'maps the Device OAuth provider error %s to a credential-specific sanitized result',
    async (providerError) => {
      const context = harness({ secret: true });
      await context.controller.configure({
        accountId: 'existing-account',
        tokenCredentialId: 'token-ref',
        mode: 'existing-direct',
        clientId: 'cli_reviewed_existing',
        appSecretCredentialId: 'secret-ref',
      });
      context.runtime.beginOAuth = async () => {
        throw new FeishuDeviceOAuthError(
          'oauth_error',
          'raw provider credential detail',
          { providerError, status: 400 },
        );
      };

      await expect(context.controller.beginOAuth()).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        message: '飞书 App ID 或 App Secret 无效，请检查后重新连接。',
        retryable: false,
      });
      expect(context.controller.status()).toMatchObject({
        state: 'error',
        connected: false,
        lastError: {
          code: 'CONFIG_INVALID',
          message: '飞书 App ID 或 App Secret 无效，请检查后重新连接。',
          retryable: false,
        },
      });
      expect(JSON.stringify(context.controller.status())).not.toContain(
        'raw provider credential detail',
      );
    },
  );

  it('disconnects and clears a reused token reference when the app identity changes', async () => {
    const context = harness({ connected: true, secret: true });
    await context.controller.configure({
      accountId: 'existing-account',
      tokenCredentialId: 'token-ref',
      mode: 'existing-direct',
      clientId: 'cli_app_a',
      appSecretCredentialId: 'secret-ref',
    });
    expect(context.controller.status().connected).toBe(true);
    await context.controller.startPolling(30_000);

    await context.controller.configure({
      accountId: 'existing-account',
      tokenCredentialId: 'token-ref',
      mode: 'existing-direct',
      clientId: 'cli_app_b',
      appSecretCredentialId: 'secret-ref',
    });
    expect(context.settings.deleted).toContain('token-ref');
    expect(context.runtime.stopPollingCalls).toBeGreaterThanOrEqual(1);
    expect(context.controller.status()).toMatchObject({
      state: 'disconnected',
      connected: false,
      polling: false,
      mode: 'existing-direct',
    });

    const oauth = oauthAttempt();
    oauth.authorization.authorizationUrl =
      'https://accounts.feishu.cn/device?user_code=NEW-APP';
    context.runtime.nextOAuth = oauth.authorization;
    await context.controller.beginOAuth();
    await expect(context.controller.cancelOAuth()).resolves.toMatchObject({
      state: 'disconnected',
      connected: false,
    });
  });

  it('passes only developer credential references and requires an explicit warning path', async () => {
    const warnings: string[] = [];
    const context = harness({
      secret: true,
      onSecurityWarning: (message) => warnings.push(message),
    });
    await context.controller.configure({
      accountId: 'developer-account',
      tokenCredentialId: 'token-ref',
      mode: 'local-development',
      clientId: 'cli_developer',
      appSecretCredentialId: 'secret-ref',
      acknowledgeInsecureLocalCredentials: true,
    });
    const factoryMode = context.runtimeOptions[0].mode;
    expect(factoryMode).toMatchObject({
      mode: 'local-development',
      clientId: 'cli_developer',
      appSecretCredentialId: 'secret-ref',
    });
    expect(JSON.stringify(factoryMode)).not.toContain('RAW-SECRET');
    expect(context.settings.getCalls).toEqual([]);
    if (factoryMode.mode === 'local-development') {
      factoryMode.onSecurityWarning('explicit developer warning');
    }
    expect(warnings).toEqual(['explicit developer warning']);

    const missing = harness({ onSecurityWarning: () => undefined });
    await expect(
      missing.controller.configure({
        accountId: 'developer-account',
        tokenCredentialId: 'token-ref',
        mode: 'local-development',
        clientId: 'cli_developer',
        appSecretCredentialId: 'missing-secret-ref',
        acknowledgeInsecureLocalCredentials: true,
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_MISSING' });

    const noWarning = harness({ secret: true });
    await expect(
      noWarning.controller.configure({
        accountId: 'developer-account',
        tokenCredentialId: 'token-ref',
        mode: 'local-development',
        clientId: 'cli_developer',
        appSecretCredentialId: 'secret-ref',
        acknowledgeInsecureLocalCredentials: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('exposes conflicts and maps operational failures to sanitized stable codes', async () => {
    const context = harness({ connected: true });
    await context.controller.configure({
      accountId: 'account-1',
      tokenCredentialId: 'token-ref',
      mode: 'relay',
      relayBaseUrl: 'https://relay.example.test',
    });
    await expect(context.controller.listConflicts()).resolves.toEqual([conflict]);
    await expect(
      context.controller.resolveConflict('local-1', 'duplicate'),
    ).resolves.toMatchObject({ decision: 'duplicate' });
    expect(context.runtime.resolveConflictCalls).toEqual([
      ['local-1', 'duplicate'],
    ]);

    context.runtime.syncResult = new FeishuRateLimitError(
      'raw provider detail with SECRET_VALUE',
      { status: 429, retryAfterMs: 1_000 },
    );
    const rateError = await context.controller
      .syncNow()
      .catch((error: unknown) => error);
    expect(rateError).toBeInstanceOf(FeishuDesktopControllerError);
    expect(rateError).toMatchObject({
      code: 'RATE_LIMITED',
      message: '飞书请求过于频繁，请稍后重试。',
      retryable: true,
    });
    expect(JSON.stringify(context.controller.status())).not.toContain('SECRET_VALUE');

    context.runtime.syncResult = report({ offline: true });
    await context.controller.syncNow();
    expect(context.controller.status()).toMatchObject({
      state: 'connected',
      connected: true,
      lastError: { code: 'NETWORK_UNAVAILABLE', retryable: true },
    });

    context.runtime.resolveConflict = async () => {
      throw new Error('Task local-1 has no Feishu conflict. SECRET_VALUE');
    };
    await expect(
      context.controller.resolveConflict('local-1', 'keep-local'),
    ).rejects.toMatchObject({
      code: 'CONFLICT_NOT_FOUND',
      message: '该任务没有待处理的飞书冲突。',
    });
    expect(JSON.stringify(context.controller.status())).not.toContain('SECRET_VALUE');
  });
});
