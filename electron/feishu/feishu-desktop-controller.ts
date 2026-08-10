import type { PublicCredentialState } from '../../src/shared/settings';
import type {
  FeishuApplicationConflict,
  FeishuConflictDecision,
  FeishuConflictResolutionResult,
  FeishuSyncIssue,
  FeishuSyncRunOptions,
  FeishuSyncRunReport,
} from './feishu-sync-service';
import {
  FeishuAuthenticationError,
  FeishuNetworkError,
  FeishuNotFoundError,
  FeishuPermissionError,
  FeishuRateLimitError,
  FeishuTasklistPermissionError,
} from './feishu-client';
import {
  OAuthLoopbackError,
} from './oauth-loopback-server';
import { FeishuDeviceOAuthError } from './device-oauth-flow';
import {
  FeishuAppRegistrationError,
  startFeishuAppRegistration,
  type FeishuAppRegistrationSession,
} from './feishu-app-registration';
import {
  createFeishuRuntime,
  FeishuRuntimeConfigurationError,
  type FeishuOAuthAuthorization,
  type FeishuRuntime,
  type FeishuRuntimeFactoryOptions,
  type FeishuSettingsPort,
} from './feishu-runtime-factory';
import {
  deriveFeishuAppSecretCredentialId,
  deriveFeishuTokenCredentialId,
  sameFeishuCredentialIdentity,
} from './feishu-credential-ids';

export type FeishuDesktopControllerErrorCode =
  | 'NOT_CONFIGURED'
  | 'NOT_CONNECTED'
  | 'ALREADY_AUTHORIZING'
  | 'NO_ACTIVE_OAUTH'
  | 'OAUTH_EXPIRED'
  | 'OAUTH_CANCELLED'
  | 'OAUTH_FAILED'
  | 'APP_REGISTRATION_FAILED'
  | 'CONFIG_INVALID'
  | 'CREDENTIAL_REF_MISSING'
  | 'AUTH_REQUIRED'
  | 'NETWORK_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'PERMISSION_DENIED'
  | 'REMOTE_NOT_FOUND'
  | 'CONFLICT_NOT_FOUND'
  | 'SYNC_FAILED'
  | 'DISCONNECT_FAILED'
  | 'RUNTIME_CLOSED';

export interface FeishuDesktopErrorOutput {
  code: FeishuDesktopControllerErrorCode;
  message: string;
  retryable: boolean;
}

export class FeishuDesktopControllerError extends Error {
  readonly code: FeishuDesktopControllerErrorCode;
  readonly retryable: boolean;

  constructor(output: FeishuDesktopErrorOutput, _options: { cause?: unknown } = {}) {
    // The underlying error is intentionally not retained: provider responses
    // and credential failures must not cross the controller/UI boundary.
    super(output.message);
    this.name = 'FeishuDesktopControllerError';
    this.code = output.code;
    this.retryable = output.retryable;
  }

  toOutput(): FeishuDesktopErrorOutput {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export interface FeishuDesktopRelayConfiguration {
  accountId: string;
  tokenCredentialId: string;
  mode: 'relay';
  relayBaseUrl: string;
  clientId?: string;
}

export interface FeishuDesktopDeveloperConfiguration {
  accountId: string;
  tokenCredentialId: string;
  mode: 'local-development';
  clientId: string;
  appSecretCredentialId: string;
  acknowledgeInsecureLocalCredentials: true;
}

export interface FeishuDesktopPersonalConfiguration {
  accountId: string;
  tokenCredentialId: string;
  mode: 'personal-direct';
  clientId: string;
  appSecretCredentialId: string;
}

export interface FeishuDesktopExistingConfiguration {
  accountId: string;
  tokenCredentialId: string;
  mode: 'existing-direct';
  clientId: string;
  appSecretCredentialId: string;
}

export type FeishuDesktopConfiguration =
  | FeishuDesktopPersonalConfiguration
  | FeishuDesktopExistingConfiguration
  | FeishuDesktopRelayConfiguration
  | FeishuDesktopDeveloperConfiguration;

export type FeishuDesktopConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'authorizing'
  | 'connected'
  | 'syncing'
  | 'error';

export interface FeishuDesktopStatus {
  state: FeishuDesktopConnectionState;
  configured: boolean;
  connected: boolean;
  polling: boolean;
  accountId?: string;
  mode?: FeishuDesktopConfiguration['mode'];
  authorizationStep?: 'app-registration' | 'account-authorization';
  oauthExpiresAt?: string;
  lastSyncAt?: string;
  lastError?: FeishuDesktopErrorOutput;
}

export interface FeishuDesktopOAuthStart {
  authorizeUrl: string;
  expiresAt: string;
}

export interface FeishuDesktopSettingsPort extends FeishuSettingsPort {
  listCredentials(): PublicCredentialState[];
  deleteCredential(id: string): Promise<boolean>;
}

export type FeishuDesktopRuntimeFactory = (
  options: FeishuRuntimeFactoryOptions,
) => Promise<FeishuRuntime>;

type RuntimeBaseOptions = Omit<
  FeishuRuntimeFactoryOptions,
  'accountId' | 'tokenCredentialId' | 'mode' | 'settings'
>;

export type FeishuDesktopControllerOptions = RuntimeBaseOptions & {
  settings: FeishuDesktopSettingsPort;
  runtimeFactory?: FeishuDesktopRuntimeFactory;
  onStatusChange?: (status: FeishuDesktopStatus) => void;
  /** Required before developer mode can be configured. */
  onSecurityWarning?: (message: string) => void;
  personalRegistrationFactory?: () => FeishuAppRegistrationSession;
  onPersonalConfiguration?: (
    configuration: FeishuDesktopPersonalConfiguration,
  ) => void | Promise<void>;
  onOpenAuthorizationUrl?: (url: string) => void | Promise<void>;
};

interface PendingOAuth {
  completion: Promise<void>;
  cancel(): Promise<void>;
  expiresAt: string;
  wasConnected: boolean;
}

type ControllerAction =
  | 'configure'
  | 'oauth'
  | 'sync'
  | 'conflict'
  | 'disconnect'
  | 'runtime';

const clone = <Value>(value: Value): Value => structuredClone(value);

function output(
  code: FeishuDesktopControllerErrorCode,
  message: string,
  retryable = false,
): FeishuDesktopErrorOutput {
  return { code, message, retryable };
}

function personalConnectCancelledError(): FeishuDeviceOAuthError {
  return new FeishuDeviceOAuthError(
    'cancelled',
    'Feishu personal connection was cancelled during authorization handoff.',
  );
}

function stableError(action: ControllerAction, error: unknown): FeishuDesktopControllerError {
  if (error instanceof FeishuDesktopControllerError) return error;
  if (error instanceof FeishuDeviceOAuthError) {
    if (
      error.providerError === 'invalid_client' ||
      error.providerError === 'unauthorized_client'
    ) {
      return new FeishuDesktopControllerError(
        output(
          'CONFIG_INVALID',
          '飞书 App ID 或 App Secret 无效，请检查后重新连接。',
        ),
        { cause: error },
      );
    }
    if (error.providerError === 'insufficient_scope') {
      return new FeishuDesktopControllerError(
        output(
          'PERMISSION_DENIED',
          '飞书授权缺少任务写入或离线访问权限，请在应用后台启用后重试。',
        ),
        { cause: error },
      );
    }
    if (error.code === 'cancelled' || error.code === 'access_denied') {
      return new FeishuDesktopControllerError(
        output('OAUTH_CANCELLED', '飞书授权已取消。'),
        { cause: error },
      );
    }
    if (error.code === 'timeout' || error.code === 'expired_token') {
      return new FeishuDesktopControllerError(
        output('OAUTH_EXPIRED', '飞书授权已过期，请重新连接。', true),
        { cause: error },
      );
    }
    if (error.code === 'network_error') {
      return new FeishuDesktopControllerError(
        output('NETWORK_UNAVAILABLE', '当前无法连接飞书，请检查网络后重试。', true),
        { cause: error },
      );
    }
    return new FeishuDesktopControllerError(
      output('OAUTH_FAILED', '飞书账号授权未完成，请重试。', true),
      { cause: error },
    );
  }
  const registrationCode =
    error instanceof FeishuAppRegistrationError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
  if (
    error instanceof FeishuAppRegistrationError ||
    ['abort', 'access_denied', 'expired_token', 'invalid_response'].includes(
      registrationCode,
    )
  ) {
    if (registrationCode === 'abort' || registrationCode === 'access_denied') {
      return new FeishuDesktopControllerError(
        output('OAUTH_CANCELLED', '飞书专属应用创建已取消。'),
        { cause: error },
      );
    }
    if (registrationCode === 'expired_token') {
      return new FeishuDesktopControllerError(
        output('OAUTH_EXPIRED', '飞书专属应用创建链接已过期，请重试。', true),
        { cause: error },
      );
    }
    if (action === 'oauth') {
      return new FeishuDesktopControllerError(
        output(
          'APP_REGISTRATION_FAILED',
          '无法创建飞书专属连接应用，请重试或使用已有飞书应用。',
          true,
        ),
        { cause: error },
      );
    }
  }
  if (error instanceof OAuthLoopbackError) {
    if (error.code === 'TIMEOUT') {
      return new FeishuDesktopControllerError(
        output('OAUTH_EXPIRED', '飞书授权已过期，请重新连接。', true),
        { cause: error },
      );
    }
    if (error.code === 'CANCELLED') {
      return new FeishuDesktopControllerError(
        output('OAUTH_CANCELLED', '飞书授权已取消。'),
        { cause: error },
      );
    }
    return new FeishuDesktopControllerError(
      output('OAUTH_FAILED', '飞书授权未完成，请重试。', true),
      { cause: error },
    );
  }
  if (error instanceof FeishuAuthenticationError) {
    return new FeishuDesktopControllerError(
      output('AUTH_REQUIRED', '飞书登录已失效，请重新连接。', true),
      { cause: error },
    );
  }
  if (error instanceof FeishuTasklistPermissionError) {
    return new FeishuDesktopControllerError(
      output(
        'PERMISSION_DENIED',
        `飞书清单权限不足。请在应用后台启用 ${error.requiredScope} 后重新授权，再重试同步。`,
      ),
      { cause: error },
    );
  }
  if (error instanceof FeishuPermissionError) {
    return new FeishuDesktopControllerError(
      output('PERMISSION_DENIED', '当前飞书账号没有执行此操作的权限。'),
      { cause: error },
    );
  }
  if (error instanceof FeishuRateLimitError) {
    return new FeishuDesktopControllerError(
      output('RATE_LIMITED', '飞书请求过于频繁，请稍后重试。', true),
      { cause: error },
    );
  }
  if (error instanceof FeishuNetworkError) {
    return new FeishuDesktopControllerError(
      output('NETWORK_UNAVAILABLE', '当前无法连接飞书，稍后会继续同步。', true),
      { cause: error },
    );
  }
  if (error instanceof FeishuNotFoundError) {
    return new FeishuDesktopControllerError(
      output('REMOTE_NOT_FOUND', '对应的飞书任务不存在或已删除。'),
      { cause: error },
    );
  }
  if (error instanceof FeishuRuntimeConfigurationError) {
    const missing = /missing|credential/i.test(error.message);
    return new FeishuDesktopControllerError(
      output(
        missing ? 'CREDENTIAL_REF_MISSING' : 'CONFIG_INVALID',
        missing ? '安全凭据引用不存在。' : '飞书连接配置无效。',
      ),
      { cause: error },
    );
  }
  if (
    action === 'conflict' &&
    error instanceof Error &&
    /no Feishu conflict|no Feishu mapping/i.test(error.message)
  ) {
    return new FeishuDesktopControllerError(
      output('CONFLICT_NOT_FOUND', '该任务没有待处理的飞书冲突。'),
      { cause: error },
    );
  }
  const fallback: Record<ControllerAction, FeishuDesktopErrorOutput> = {
    configure: output('CONFIG_INVALID', '飞书连接配置无效。'),
    oauth: output('OAUTH_FAILED', '飞书授权未完成，请重试。', true),
    sync: output('SYNC_FAILED', '飞书同步失败，请稍后重试。', true),
    conflict: output('SYNC_FAILED', '飞书冲突处理失败。', true),
    disconnect: output('DISCONNECT_FAILED', '断开飞书连接失败，请重试。', true),
    runtime: output('RUNTIME_CLOSED', '飞书运行时不可用。'),
  };
  return new FeishuDesktopControllerError(fallback[action], { cause: error });
}

function outputForSyncIssue(issue: FeishuSyncIssue): FeishuDesktopErrorOutput {
  switch (issue.code) {
    case 'NETWORK_UNAVAILABLE':
      return output(
        'NETWORK_UNAVAILABLE',
        '当前无法连接飞书，修改已保留并会在网络恢复后继续同步。',
        true,
      );
    case 'RATE_LIMITED':
      return output(
        'RATE_LIMITED',
        '飞书请求过于频繁，修改已保留并会稍后重试。',
        true,
      );
    case 'AUTH_REQUIRED':
      return output('AUTH_REQUIRED', '飞书登录已失效，请重新连接。', true);
    case 'PERMISSION_DENIED':
      return output(
        'PERMISSION_DENIED',
        issue.message ?? '当前飞书账号没有执行此操作的权限。',
      );
    case 'SYNC_FAILED':
      return output('SYNC_FAILED', '飞书同步失败，请检查任务后重试。');
  }
}

function issueForReport(report: FeishuSyncRunReport): FeishuSyncIssue | undefined {
  return report.issue ?? (report.offline
    ? { code: 'NETWORK_UNAVAILABLE', retryable: true }
    : undefined);
}

export class FeishuDesktopController {
  private readonly baseOptions: RuntimeBaseOptions;
  private readonly settings: FeishuDesktopSettingsPort;
  private readonly createRuntime: FeishuDesktopRuntimeFactory;
  private readonly onStatusChange?: (status: FeishuDesktopStatus) => void;
  private readonly onSecurityWarning?: (message: string) => void;
  private readonly startPersonalRegistration: () => FeishuAppRegistrationSession;
  private readonly onPersonalConfiguration?: (
    configuration: FeishuDesktopPersonalConfiguration,
  ) => void | Promise<void>;
  private readonly onOpenAuthorizationUrl?: (
    url: string,
  ) => void | Promise<void>;
  private readonly now: () => number;
  private configuration?: FeishuDesktopConfiguration;
  private runtime?: FeishuRuntime;
  private runtimePromise?: Promise<FeishuRuntime>;
  private pendingOAuth?: PendingOAuth;
  private currentStatus: FeishuDesktopStatus = {
    state: 'unconfigured',
    configured: false,
    connected: false,
    polling: false,
  };

  constructor(options: FeishuDesktopControllerOptions) {
    const {
      settings,
      runtimeFactory,
      onStatusChange,
      onSecurityWarning,
      personalRegistrationFactory,
      onPersonalConfiguration,
      onOpenAuthorizationUrl,
      ...baseOptions
    } = options;
    this.settings = settings;
    this.createRuntime = runtimeFactory ?? createFeishuRuntime;
    this.onStatusChange = onStatusChange;
    this.onSecurityWarning = onSecurityWarning;
    this.startPersonalRegistration =
      personalRegistrationFactory ?? startFeishuAppRegistration;
    this.onPersonalConfiguration = onPersonalConfiguration;
    this.onOpenAuthorizationUrl = onOpenAuthorizationUrl;
    this.now = options.now ?? Date.now;
    this.baseOptions = baseOptions;
  }

  status(): FeishuDesktopStatus {
    return clone(this.currentStatus);
  }

  private publish(patch: Partial<FeishuDesktopStatus>): FeishuDesktopStatus {
    this.currentStatus = { ...this.currentStatus, ...patch };
    const snapshot = this.status();
    try {
      this.onStatusChange?.(snapshot);
    } catch {
      // A presentation callback must never break the connection state machine.
    }
    return snapshot;
  }

  /**
   * Sync service reports deliberately contain only sanitized issue codes.
   * Apply them here so foreground calls and background polling always expose
   * the same trustworthy connection state to the desktop UI and tray.
   */
  private publishSyncReport(report: FeishuSyncRunReport): FeishuDesktopStatus {
    const issue = issueForReport(report);
    const lastError = issue ? outputForSyncIssue(issue) : undefined;
    const requiresAttention =
      issue?.code === 'AUTH_REQUIRED' ||
      issue?.code === 'PERMISSION_DENIED' ||
      issue?.code === 'SYNC_FAILED';
    if (requiresAttention) this.runtime?.stopPolling();
    return this.publish({
      state: requiresAttention ? 'error' : 'connected',
      connected:
        issue?.code === 'AUTH_REQUIRED' ? false : this.currentStatus.connected,
      polling: requiresAttention ? false : this.currentStatus.polling,
      lastSyncAt: issue ? this.currentStatus.lastSyncAt : new Date(this.now()).toISOString(),
      lastError,
    });
  }

  private publishSyncFailure(error: unknown): FeishuDesktopControllerError {
    const mapped = stableError('sync', error);
    const authRequired = mapped.code === 'AUTH_REQUIRED';
    const stopPolling = authRequired || !mapped.retryable;
    if (stopPolling) this.runtime?.stopPolling();
    this.publish({
      state: 'error',
      connected: authRequired ? false : this.currentStatus.connected,
      polling: stopPolling ? false : this.currentStatus.polling,
      lastError: mapped.toOutput(),
    });
    return mapped;
  }

  private credential(id: string): PublicCredentialState | undefined {
    return this.settings.listCredentials().find((item) => item.id === id);
  }

  private validateConfiguration(configuration: FeishuDesktopConfiguration): void {
    if (!configuration.accountId.trim() || !configuration.tokenCredentialId.trim()) {
      throw new FeishuDesktopControllerError(
        output('CONFIG_INVALID', '飞书账号和 token 凭据引用不能为空。'),
      );
    }
    const token = this.credential(configuration.tokenCredentialId);
    if (token && token.kind !== 'feishu-token') {
      throw new FeishuDesktopControllerError(
        output('CONFIG_INVALID', 'token 凭据引用的类型不正确。'),
      );
    }
    if (configuration.mode === 'relay') {
      if (!/^https:\/\//i.test(configuration.relayBaseUrl)) {
        throw new FeishuDesktopControllerError(
          output('CONFIG_INVALID', 'Relay 地址必须使用 HTTPS。'),
        );
      }
      return;
    }
    const secret = this.credential(configuration.appSecretCredentialId);
    if (!secret || secret.kind !== 'feishu-app-secret') {
      throw new FeishuDesktopControllerError(
        output('CREDENTIAL_REF_MISSING', '飞书应用凭据引用不存在。'),
      );
    }
    if (
      configuration.mode === 'personal-direct' ||
      configuration.mode === 'existing-direct'
    ) return;
    if (
      configuration.acknowledgeInsecureLocalCredentials !== true ||
      !this.onSecurityWarning
    ) {
      throw new FeishuDesktopControllerError(
        output(
          'CONFIG_INVALID',
          'Developer 模式需要显式风险确认和安全警告处理器。',
        ),
      );
    }
  }

  private runtimeOptions(): FeishuRuntimeFactoryOptions {
    const configuration = this.configuration!;
    let mode: FeishuRuntimeFactoryOptions['mode'];
    if (configuration.mode === 'relay') {
      mode = {
        mode: 'relay',
        relayBaseUrl: configuration.relayBaseUrl,
        clientId: configuration.clientId,
      };
    } else if (
      configuration.mode === 'personal-direct' ||
      configuration.mode === 'existing-direct'
    ) {
      mode = {
        mode: configuration.mode,
        clientId: configuration.clientId,
        appSecretCredentialId: configuration.appSecretCredentialId,
      };
    } else {
      mode = {
        mode: 'local-development',
        clientId: configuration.clientId,
        appSecretCredentialId: configuration.appSecretCredentialId,
        acknowledgeInsecureLocalCredentials: true,
        onSecurityWarning: this.onSecurityWarning!,
      };
    }
    return {
      ...this.baseOptions,
      settings: this.settings,
      accountId: configuration.accountId,
      tokenCredentialId: configuration.tokenCredentialId,
      mode,
    };
  }

  private async ensureRuntime(): Promise<FeishuRuntime> {
    if (!this.configuration) {
      throw new FeishuDesktopControllerError(
        output('NOT_CONFIGURED', '请先配置飞书连接。'),
      );
    }
    if (this.runtime) return this.runtime;
    if (this.runtimePromise) return this.runtimePromise;
    const promise = this.createRuntime(this.runtimeOptions()).then(async (runtime) => {
      await runtime.initialize();
      this.runtime = runtime;
      return runtime;
    });
    this.runtimePromise = promise;
    try {
      return await promise;
    } catch (error) {
      throw stableError('configure', error);
    } finally {
      if (this.runtimePromise === promise) this.runtimePromise = undefined;
    }
  }

  async configure(
    configuration: FeishuDesktopConfiguration,
  ): Promise<FeishuDesktopStatus> {
    this.validateConfiguration(configuration);
    const identityChanged = Boolean(
      this.configuration &&
        !sameFeishuCredentialIdentity(this.configuration, configuration),
    );
    if (this.pendingOAuth) await this.cancelOAuth().catch(() => undefined);
    this.runtime?.stopPolling();
    await this.runtime?.close();
    this.runtime = undefined;
    if (identityChanged) {
      // A token belongs to one account/app identity. Clearing the incoming
      // reference also protects older callers that still use one fixed id.
      await this.settings.deleteCredential(configuration.tokenCredentialId);
    }
    this.configuration = clone(configuration);
    const connected =
      !identityChanged &&
      this.credential(configuration.tokenCredentialId)?.kind === 'feishu-token';
    this.publish({
      state: connected ? 'connected' : 'disconnected',
      configured: true,
      connected,
      polling: false,
      accountId: configuration.accountId,
      mode: configuration.mode,
      authorizationStep: undefined,
      oauthExpiresAt: undefined,
      lastError: undefined,
    });
    try {
      await this.ensureRuntime();
      return this.status();
    } catch (error) {
      const mapped = stableError('configure', error);
      // A credential metadata record alone is not proof that its encrypted
      // payload can still be opened and parsed. Runtime initialization is the
      // local verification boundary, so fail closed if restoration cannot
      // load the app secret or stored token.
      this.publish({
        state: 'error',
        connected: false,
        polling: false,
        lastError: mapped.toOutput(),
      });
      throw mapped;
    }
  }

  async beginOAuth(options: {
    timeoutMs?: number;
    scopes?: readonly string[];
  } = {}): Promise<FeishuDesktopOAuthStart> {
    if (!this.configuration) {
      throw new FeishuDesktopControllerError(
        output('NOT_CONFIGURED', '请先配置飞书连接。'),
      );
    }
    if (this.pendingOAuth) {
      throw new FeishuDesktopControllerError(
        output('ALREADY_AUTHORIZING', '已有进行中的飞书授权。'),
      );
    }
    const runtime = await this.ensureRuntime();
    const usesDeviceOAuth =
      this.configuration.mode === 'personal-direct' ||
      this.configuration.mode === 'existing-direct';
    const timeoutMs = Math.max(
      1_000,
      options.timeoutMs ?? (usesDeviceOAuth ? 600_000 : 120_000),
    );
    let authorization: FeishuOAuthAuthorization;
    try {
      authorization = await runtime.beginOAuth({
        timeoutMs,
        scopes: options.scopes,
      });
    } catch (error) {
      if (error instanceof FeishuDeviceOAuthError) {
        console.warn('[feishu] device authorization failed', {
          code: error.code,
          providerError: error.providerError,
          status: error.status,
          message: error.message,
        });
      }
      const mapped = stableError('oauth', error);
      this.publish({ state: 'error', lastError: mapped.toOutput() });
      throw mapped;
    }

    const expiresAt = new Date(
      authorization.expiresAt ?? this.now() + timeoutMs,
    ).toISOString();
    const pending: PendingOAuth = {
      completion: Promise.resolve(),
      cancel: () => authorization.cancel(),
      expiresAt,
      wasConnected: this.currentStatus.connected,
    };
    const completion = authorization.completion.then(
      () => {
        if (this.pendingOAuth === pending) {
          this.publish({
            state: 'connected',
            connected: true,
            authorizationStep: undefined,
            oauthExpiresAt: undefined,
            lastError: undefined,
          });
        }
      },
      (error: unknown) => {
        const mapped = stableError('oauth', error);
        if (this.pendingOAuth === pending) {
          this.publish({
            state: 'error',
            connected: pending.wasConnected,
            authorizationStep: undefined,
            oauthExpiresAt: undefined,
            lastError: mapped.toOutput(),
          });
        }
        throw mapped;
      },
    );
    // Observe eagerly so a timeout is not an unhandled rejection while the UI
    // waits before calling completeOAuth().
    void completion.catch(() => undefined);
    pending.completion = completion;
    this.pendingOAuth = pending;
    this.publish({
      state: 'authorizing',
      authorizationStep:
        this.configuration.mode === 'personal-direct' ||
        this.configuration.mode === 'existing-direct'
          ? 'account-authorization'
          : undefined,
      oauthExpiresAt: expiresAt,
      lastError: undefined,
    });
    return { authorizeUrl: authorization.authorizationUrl, expiresAt };
  }

  async beginPersonalConnect(options: {
    accountId: string;
    tokenCredentialId: string;
    appSecretCredentialId: string;
    timeoutMs?: number;
  }): Promise<FeishuDesktopOAuthStart> {
    if (
      this.configuration?.mode === 'personal-direct' &&
      this.credential(this.configuration.appSecretCredentialId)?.kind ===
        'feishu-app-secret'
    ) {
      return this.beginOAuth({ timeoutMs: options.timeoutMs ?? 600_000 });
    }
    if (this.pendingOAuth) {
      throw new FeishuDesktopControllerError(
        output('ALREADY_AUTHORIZING', '已有进行中的飞书授权。'),
      );
    }
    if (!this.onPersonalConfiguration || !this.onOpenAuthorizationUrl) {
      throw new FeishuDesktopControllerError(
        output('CONFIG_INVALID', '一键连接飞书所需的桌面回调未配置。'),
      );
    }

    const accountId = options.accountId.trim();
    if (!accountId) {
      throw new FeishuDesktopControllerError(
        output('CONFIG_INVALID', '飞书本地账号不能为空。'),
      );
    }

    const registration = this.startPersonalRegistration();
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 600_000);
    let cancellationRequested = false;
    let cancelCurrent = async (): Promise<void> => registration.cancel();
    const pending: PendingOAuth = {
      completion: Promise.resolve(),
      cancel: async () => {
        cancellationRequested = true;
        await cancelCurrent();
      },
      expiresAt: new Date(this.now() + timeoutMs).toISOString(),
      wasConnected: this.currentStatus.connected,
    };
    this.pendingOAuth = pending;
    this.publish({
      state: 'authorizing',
      connected: pending.wasConnected,
      authorizationStep: 'app-registration',
      oauthExpiresAt: pending.expiresAt,
      lastError: undefined,
    });

    const rawCompletion = (async () => {
      const result = await registration.result;
      const credentialIdentity = {
        mode: 'personal-direct' as const,
        accountId,
        clientId: result.client_id,
      };
      const appSecretCredentialId =
        deriveFeishuAppSecretCredentialId(credentialIdentity);
      const tokenCredentialId =
        deriveFeishuTokenCredentialId(credentialIdentity);
      await this.settings.setCredential(
        'feishu-app-secret',
        result.client_secret,
        appSecretCredentialId,
      );
      const configuration: FeishuDesktopPersonalConfiguration = {
        mode: 'personal-direct',
        accountId,
        tokenCredentialId,
        clientId: result.client_id,
        appSecretCredentialId,
      };
      this.validateConfiguration(configuration);

      this.runtime?.stopPolling();
      await this.runtime?.close();
      this.runtime = undefined;
      await this.settings.deleteCredential(tokenCredentialId);
      this.configuration = clone(configuration);
      pending.wasConnected = false;
      await this.onPersonalConfiguration!(clone(configuration));
      if (cancellationRequested) throw personalConnectCancelledError();

      const runtime = await this.ensureRuntime();
      if (cancellationRequested) throw personalConnectCancelledError();
      let authorization: FeishuOAuthAuthorization;
      try {
        authorization = await runtime.beginOAuth({ timeoutMs });
      } catch (error) {
        if (cancellationRequested) throw personalConnectCancelledError();
        throw error;
      }
      cancelCurrent = () => authorization.cancel();
      if (cancellationRequested) {
        await authorization.cancel().catch(() => undefined);
        throw personalConnectCancelledError();
      }
      pending.expiresAt = new Date(
        authorization.expiresAt ?? this.now() + timeoutMs,
      ).toISOString();
      this.publish({
        state: 'authorizing',
        configured: true,
        connected: false,
        polling: false,
        accountId,
        mode: 'personal-direct',
        authorizationStep: 'account-authorization',
        oauthExpiresAt: pending.expiresAt,
        lastError: undefined,
      });
      try {
        await this.onOpenAuthorizationUrl!(authorization.authorizationUrl);
      } catch (error) {
        await authorization.cancel().catch(() => undefined);
        throw error;
      }
      if (cancellationRequested) throw personalConnectCancelledError();
      await authorization.completion;
    })();

    const completion = rawCompletion.then(
      () => {
        if (this.pendingOAuth === pending) {
          this.publish({
            state: 'connected',
            configured: true,
            connected: true,
            polling: false,
            authorizationStep: undefined,
            oauthExpiresAt: undefined,
            lastError: undefined,
          });
        }
      },
      (error: unknown) => {
        const mapped = stableError('oauth', error);
        if (this.pendingOAuth === pending) {
          this.publish({
            state: 'error',
            configured: Boolean(this.configuration),
            connected: pending.wasConnected,
            authorizationStep: undefined,
            oauthExpiresAt: undefined,
            lastError: mapped.toOutput(),
          });
        }
        throw mapped;
      },
    );
    void completion.catch(() => undefined);
    pending.completion = completion;

    try {
      const verification = await registration.verification;
      pending.expiresAt = new Date(verification.expiresAt).toISOString();
      if (this.pendingOAuth === pending) {
        this.publish({ oauthExpiresAt: pending.expiresAt });
      }
      return {
        authorizeUrl: verification.verificationUrl,
        expiresAt: pending.expiresAt,
      };
    } catch (error) {
      await completion.catch(() => undefined);
      if (this.pendingOAuth === pending) this.pendingOAuth = undefined;
      throw stableError('oauth', error);
    }
  }

  async completeOAuth(): Promise<FeishuDesktopStatus> {
    const pending = this.pendingOAuth;
    if (!pending) {
      throw new FeishuDesktopControllerError(
        output('NO_ACTIVE_OAUTH', '当前没有等待完成的飞书授权。'),
      );
    }
    try {
      await pending.completion;
      return this.status();
    } catch (error) {
      throw stableError('oauth', error);
    } finally {
      if (this.pendingOAuth === pending) this.pendingOAuth = undefined;
    }
  }

  async cancelOAuth(): Promise<FeishuDesktopStatus> {
    const pending = this.pendingOAuth;
    if (!pending) {
      throw new FeishuDesktopControllerError(
        output('NO_ACTIVE_OAUTH', '当前没有进行中的飞书授权。'),
      );
    }
    const settled = pending.completion.catch(() => undefined);
    try {
      await pending.cancel();
      await settled;
    } finally {
      if (this.pendingOAuth === pending) this.pendingOAuth = undefined;
    }
    return this.publish({
      state: pending.wasConnected ? 'connected' : 'disconnected',
      connected: pending.wasConnected,
      authorizationStep: undefined,
      oauthExpiresAt: undefined,
      lastError: undefined,
    });
  }

  async disconnect(): Promise<FeishuDesktopStatus> {
    if (!this.configuration) return this.status();
    try {
      // Fail closed immediately. A settings/mode switch can call disconnect
      // without awaiting it, so no task mutation may observe the old identity
      // as connected while runtime shutdown or secure-token deletion is still
      // in progress.
      if (this.pendingOAuth) this.pendingOAuth.wasConnected = false;
      this.runtime?.stopPolling();
      this.publish({
        state: 'disconnected',
        connected: false,
        polling: false,
        authorizationStep: undefined,
        oauthExpiresAt: undefined,
        lastError: undefined,
      });
      if (this.pendingOAuth) await this.cancelOAuth();
      await this.runtime?.close();
      this.runtime = undefined;
      await this.settings.deleteCredential(this.configuration.tokenCredentialId);
      // Mapping, cursor, conflict state and all local tasks are deliberately kept.
      return this.status();
    } catch (error) {
      const mapped = stableError('disconnect', error);
      this.publish({ state: 'error', lastError: mapped.toOutput() });
      throw mapped;
    }
  }

  private requireConnected(): void {
    if (!this.configuration) {
      throw new FeishuDesktopControllerError(
        output('NOT_CONFIGURED', '请先配置飞书连接。'),
      );
    }
    if (!this.currentStatus.connected) {
      // This guard runs before runtime creation or any sync call, preventing a
      // configured-but-unconnected account from uploading local tasks.
      throw new FeishuDesktopControllerError(
        output('NOT_CONNECTED', '请先完成飞书授权。'),
      );
    }
  }

  async syncNow(options?: FeishuSyncRunOptions): Promise<FeishuSyncRunReport> {
    this.requireConnected();
    const runtime = await this.ensureRuntime();
    this.publish({ state: 'syncing', lastError: undefined });
    try {
      const report = await runtime.syncNow(options);
      this.publishSyncReport(report);
      return report;
    } catch (error) {
      throw this.publishSyncFailure(error);
    }
  }

  /**
   * Performs one immediate, safe recovery attempt after app launch/wake. The
   * runtime first checks connectivity, so an offline laptop keeps its durable
   * queue untouched and the UI accurately reports that it is waiting.
   */
  async resumeAfterReconnect(): Promise<FeishuSyncRunReport | undefined> {
    this.requireConnected();
    const runtime = await this.ensureRuntime();
    this.publish({ state: 'syncing', lastError: undefined });
    try {
      const report = await runtime.resumeAfterReconnect();
      if (report) {
        this.publishSyncReport(report);
        return report;
      }
      this.publish({
        state: 'connected',
        lastError: output(
          'NETWORK_UNAVAILABLE',
          '当前无法连接飞书，修改已保留并会在网络恢复后继续同步。',
          true,
        ),
      });
      return undefined;
    } catch (error) {
      throw this.publishSyncFailure(error);
    }
  }

  async listConflicts(): Promise<FeishuApplicationConflict[]> {
    if (!this.configuration) {
      throw new FeishuDesktopControllerError(
        output('NOT_CONFIGURED', '请先配置飞书连接。'),
      );
    }
    try {
      return await (await this.ensureRuntime()).listConflicts();
    } catch (error) {
      throw stableError('conflict', error);
    }
  }

  async resolveConflict(
    localId: string,
    decision: FeishuConflictDecision,
  ): Promise<FeishuConflictResolutionResult> {
    if (!this.configuration) {
      throw new FeishuDesktopControllerError(
        output('NOT_CONFIGURED', '请先配置飞书连接。'),
      );
    }
    try {
      const result = await (await this.ensureRuntime()).resolveConflict(
        localId,
        decision,
      );
      this.publish({ lastError: undefined });
      return result;
    } catch (error) {
      const mapped = stableError('conflict', error);
      this.publish({ lastError: mapped.toOutput() });
      throw mapped;
    }
  }

  /** Queues local changes without requiring an active network connection. */
  async notifyLocalUpsert(localId: string): Promise<void> {
    if (!this.configuration) return;
    try {
      await (await this.ensureRuntime()).notifyLocalUpsert(localId);
    } catch (error) {
      const mapped = stableError('sync', error);
      this.publish({ lastError: mapped.toOutput() });
      throw mapped;
    }
  }

  async notifyLocalDelete(localId: string): Promise<void> {
    if (!this.configuration) return;
    try {
      await (await this.ensureRuntime()).notifyLocalDelete(localId);
    } catch (error) {
      const mapped = stableError('sync', error);
      this.publish({ lastError: mapped.toOutput() });
      throw mapped;
    }
  }

  async notifyLocalComplete(localId: string, completed = true): Promise<void> {
    if (!this.configuration) return;
    try {
      await (await this.ensureRuntime()).notifyLocalComplete(localId, completed);
    } catch (error) {
      const mapped = stableError('sync', error);
      this.publish({ lastError: mapped.toOutput() });
      throw mapped;
    }
  }

  async startPolling(intervalMs?: number): Promise<FeishuDesktopStatus> {
    this.requireConnected();
    const runtime = await this.ensureRuntime();
    runtime.startPolling(intervalMs, {
      onReport: (report) => {
        if (this.runtime !== runtime || !this.currentStatus.polling) return;
        this.publishSyncReport(report);
      },
      onError: (error) => {
        if (this.runtime !== runtime || !this.currentStatus.polling) return;
        this.publishSyncFailure(error);
      },
    });
    return this.publish({ polling: true });
  }

  stopPolling(): FeishuDesktopStatus {
    this.runtime?.stopPolling();
    return this.publish({ polling: false });
  }
}
