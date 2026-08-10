import type {
  FeishuFetch,
  FeishuTokenSet,
} from "../../src/shared/feishu-types";
import { isTrustedFeishuAuthorizationUrl } from "./feishu-authorization-url";

/**
 * Current Feishu OAuth 2.0 Device Authorization Grant endpoints.
 *
 * Feishu serves the user-facing device authorization endpoint from the
 * accounts domain and the token endpoint from the Open Platform domain.
 */
export const FEISHU_DEVICE_AUTHORIZATION_URL =
  "https://accounts.feishu.cn/oauth/v1/device_authorization";
export const FEISHU_DEVICE_TOKEN_URL =
  "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
export const FEISHU_DEVICE_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

const DEFAULT_AUTHORIZATION_EXPIRES_IN_SECONDS = 240;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const REQUIRED_TOKEN_SCOPES = ["task:task:write", "offline_access"] as const;

export interface FeishuDeviceOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** `offline_access` is added automatically so background sync can refresh. */
  scopes?: readonly string[];
}

export interface FeishuDeviceAuthorization {
  deviceCode: string;
  userCode?: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  /** Absolute Unix time in milliseconds. */
  expiresAt: number;
  intervalMs: number;
}

export type FeishuDeviceOAuthStatus =
  | {
      status: "polling";
      attempt: number;
      intervalMs: number;
    }
  | {
      status: "authorization_pending";
      attempt: number;
      intervalMs: number;
    }
  | {
      status: "slow_down";
      attempt: number;
      intervalMs: number;
    };

export type FeishuDeviceOAuthErrorCode =
  | "invalid_configuration"
  | "network_error"
  | "invalid_response"
  | "access_denied"
  | "expired_token"
  | "cancelled"
  | "timeout"
  | "oauth_error";

interface FeishuDeviceOAuthErrorOptions {
  status?: number;
  providerError?: string;
  cause?: unknown;
}

export class FeishuDeviceOAuthError extends Error {
  readonly code: FeishuDeviceOAuthErrorCode;
  readonly status?: number;
  readonly providerError?: string;

  constructor(
    code: FeishuDeviceOAuthErrorCode,
    message: string,
    options: FeishuDeviceOAuthErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "FeishuDeviceOAuthError";
    this.code = code;
    this.status = options.status;
    this.providerError = options.providerError;
  }
}

export interface FeishuDeviceOAuthDependencies {
  fetch?: FeishuFetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Primarily useful for a local mock server in tests. */
  deviceAuthorizationUrl?: string;
  /** Primarily useful for a local mock server in tests. */
  tokenUrl?: string;
}

export interface FeishuDeviceAuthorizationOptions
  extends FeishuDeviceOAuthDependencies {
  signal?: AbortSignal;
}

export interface FeishuDeviceTokenPollingOptions
  extends FeishuDeviceOAuthDependencies {
  signal?: AbortSignal;
  /** Optional caller deadline, further restricting the provider expiry. */
  timeoutMs?: number;
  onStatusChange?: (status: FeishuDeviceOAuthStatus) => void;
}

interface OAuthResponseShape {
  code?: number;
  msg?: string;
  message?: string;
  error?: string;
  error_description?: string;
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  expire_in?: number;
  interval?: number;
  access_token?: string;
  refresh_token?: string;
  open_id?: string;
  token_type?: string;
  scope?: string | string[];
  refresh_token_expires_in?: number;
  data?: OAuthResponseShape;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseShape(value: unknown): OAuthResponseShape | undefined {
  return isRecord(value) ? (value as OAuthResponseShape) : undefined;
}

function tokenPayload(value: unknown): OAuthResponseShape | undefined {
  const root = responseShape(value);
  if (!root) return undefined;
  return root.data?.access_token ? root.data : root;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function scopeList(scope: string | string[] | undefined): string[] {
  if (Array.isArray(scope)) {
    return scope.flatMap((item) => item.split(/[ ,]+/)).filter(Boolean);
  }
  return scope?.split(/[ ,]+/).filter(Boolean) ?? [];
}

function requestedScopeList(
  scopes: readonly string[] | undefined,
): string[] {
  const normalized = new Set(
    (scopes ?? []).flatMap((scope) => scope.split(/\s+/)).filter(Boolean),
  );
  normalized.add("offline_access");
  return [...normalized];
}

function requestedScope(scopes: readonly string[] | undefined): string {
  return requestedScopeList(scopes).join(" ");
}

function assertRequiredTokenScopes(scopes: readonly string[]): void {
  const granted = new Set(scopes);
  const missing = REQUIRED_TOKEN_SCOPES.filter(
    (scope) => !granted.has(scope),
  );
  if (missing.length === 0) return;

  throw new FeishuDeviceOAuthError(
    "oauth_error",
    `Feishu authorization is missing required scopes: ${missing.join(", ")}.`,
    { providerError: "insufficient_scope" },
  );
}

function assertConfiguration(config: FeishuDeviceOAuthConfig): void {
  if (!config.clientId.trim()) {
    throw new FeishuDeviceOAuthError(
      "invalid_configuration",
      "A Feishu client ID is required for device authorization.",
    );
  }
  if (!config.clientSecret) {
    throw new FeishuDeviceOAuthError(
      "invalid_configuration",
      "A Feishu client secret is required for device authorization.",
    );
  }
}

function cancellationError(): FeishuDeviceOAuthError {
  return new FeishuDeviceOAuthError(
    "cancelled",
    "Feishu device authorization was cancelled.",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sleepWithAbort(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await sleep(milliseconds);
    return;
  }

  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(cancellationError());
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

async function readJson(
  response: Response,
  stage: "device authorization" | "token polling",
): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new FeishuDeviceOAuthError(
      "invalid_response",
      `Feishu ${stage} returned a non-JSON response.`,
      { status: response.status, cause },
    );
  }
}

function providerMessage(
  payload: OAuthResponseShape | undefined,
  fallback: string,
): string {
  return (
    payload?.error_description ||
    payload?.msg ||
    payload?.message ||
    payload?.error ||
    fallback
  );
}

function providerError(
  payload: OAuthResponseShape | undefined,
): string | undefined {
  if (payload?.error) return payload.error;
  if (typeof payload?.code === "number" && payload.code !== 0) {
    return String(payload.code);
  }
  return undefined;
}

function fetchFailure(
  stage: "device authorization" | "token polling",
  signal: AbortSignal | undefined,
  cause: unknown,
): FeishuDeviceOAuthError {
  if (signal?.aborted) return cancellationError();
  return new FeishuDeviceOAuthError(
    "network_error",
    `Feishu ${stage} request failed: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    { cause },
  );
}

/**
 * Starts Feishu's OAuth 2.0 Device Authorization Grant.
 *
 * The returned complete verification URL should be opened in the user's
 * browser. Keep `deviceCode` private; it is used only by the polling function.
 */
export async function requestFeishuDeviceAuthorization(
  config: FeishuDeviceOAuthConfig,
  options: FeishuDeviceAuthorizationOptions = {},
): Promise<FeishuDeviceAuthorization> {
  assertConfiguration(config);
  throwIfAborted(options.signal);

  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({
    client_id: config.clientId,
    scope: requestedScope(config.scopes),
  });
  const basicCredentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
    "utf8",
  ).toString("base64");

  let response: Response;
  try {
    response = await fetchImpl(
      options.deviceAuthorizationUrl ?? FEISHU_DEVICE_AUTHORIZATION_URL,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basicCredentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: options.signal,
      },
    );
  } catch (cause) {
    throw fetchFailure("device authorization", options.signal, cause);
  }

  const json = await readJson(response, "device authorization");
  const payload = responseShape(json);
  const oauthError = providerError(payload);
  if (!response.ok || oauthError) {
    throw new FeishuDeviceOAuthError(
      "oauth_error",
      providerMessage(
        payload,
        `Feishu device authorization failed with HTTP ${response.status}.`,
      ),
      {
        status: response.status,
        providerError: oauthError,
      },
    );
  }

  const deviceCode = payload?.device_code;
  const verificationUri =
    payload?.verification_uri || payload?.verification_uri_complete;
  const verificationUriComplete =
    payload?.verification_uri_complete || verificationUri;
  if (
    !deviceCode ||
    !verificationUri ||
    !verificationUriComplete ||
    !isTrustedFeishuAuthorizationUrl(verificationUri) ||
    !isTrustedFeishuAuthorizationUrl(verificationUriComplete)
  ) {
    throw new FeishuDeviceOAuthError(
      "invalid_response",
      "Feishu device authorization response is missing a valid device_code or trusted verification URL.",
      { status: response.status },
    );
  }

  const expiresInSeconds = positiveNumber(
    payload.expires_in ?? payload.expire_in,
    DEFAULT_AUTHORIZATION_EXPIRES_IN_SECONDS,
  );
  const intervalMs =
    positiveNumber(payload.interval, DEFAULT_POLL_INTERVAL_MS / 1_000) *
    1_000;

  return {
    deviceCode,
    userCode: payload.user_code || undefined,
    verificationUri,
    verificationUriComplete,
    expiresInSeconds,
    expiresAt: now() + expiresInSeconds * 1_000,
    intervalMs,
  };
}

/** Parse a successful Feishu v2 OAuth token response into the app token shape. */
export function parseFeishuDeviceTokenResponse(
  value: unknown,
  now: () => number = Date.now,
  requestedScopes: readonly string[] = [],
): FeishuTokenSet {
  const root = responseShape(value);
  const payload = tokenPayload(value);
  const oauthError = providerError(root);
  if (oauthError) {
    throw new FeishuDeviceOAuthError(
      "oauth_error",
      providerMessage(root, "Feishu token request failed."),
      { providerError: oauthError },
    );
  }
  if (!payload?.access_token) {
    throw new FeishuDeviceOAuthError(
      "invalid_response",
      "Feishu token response is missing access_token.",
    );
  }
  if (
    typeof payload.expires_in !== "number" ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw new FeishuDeviceOAuthError(
      "invalid_response",
      "Feishu token response is missing a valid expires_in value.",
    );
  }

  const issuedAt = now();
  const reportedScopes = scopeList(payload.scope);
  const scopes =
    reportedScopes.length === 0
      ? requestedScopeList(requestedScopes)
      : reportedScopes;
  assertRequiredTokenScopes(scopes);

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || undefined,
    openId: payload.open_id || undefined,
    tokenType: payload.token_type || "Bearer",
    scope: scopes,
    expiresAt: issuedAt + payload.expires_in * 1_000,
    refreshTokenExpiresAt:
      typeof payload.refresh_token_expires_in === "number" &&
      Number.isFinite(payload.refresh_token_expires_in) &&
      payload.refresh_token_expires_in > 0
        ? issuedAt + payload.refresh_token_expires_in * 1_000
        : undefined,
  };
}

function terminalPollingError(
  oauthError: string,
  payload: OAuthResponseShape | undefined,
  status: number,
): FeishuDeviceOAuthError {
  if (oauthError === "access_denied") {
    return new FeishuDeviceOAuthError(
      "access_denied",
      providerMessage(payload, "Feishu authorization was denied by the user."),
      { status, providerError: oauthError },
    );
  }
  if (oauthError === "expired_token" || oauthError === "invalid_grant") {
    return new FeishuDeviceOAuthError(
      "expired_token",
      providerMessage(payload, "The Feishu device code has expired."),
      { status, providerError: oauthError },
    );
  }
  return new FeishuDeviceOAuthError(
    "oauth_error",
    providerMessage(payload, "Feishu device token polling failed."),
    { status, providerError: oauthError },
  );
}

function timeoutError(): FeishuDeviceOAuthError {
  return new FeishuDeviceOAuthError(
    "timeout",
    "Feishu device authorization timed out.",
  );
}

/**
 * Polls Feishu's v2 token endpoint until the user authorizes, rejects, the
 * device code expires, the caller cancels, or the effective deadline elapses.
 */
export async function pollFeishuDeviceToken(
  config: FeishuDeviceOAuthConfig,
  authorization: FeishuDeviceAuthorization,
  options: FeishuDeviceTokenPollingOptions = {},
): Promise<FeishuTokenSet> {
  assertConfiguration(config);
  if (!authorization.deviceCode) {
    throw new FeishuDeviceOAuthError(
      "invalid_configuration",
      "A Feishu device code is required for token polling.",
    );
  }

  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const callerDeadline =
    options.timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : startedAt + Math.max(0, options.timeoutMs);
  const deadline = Math.min(authorization.expiresAt, callerDeadline);
  let intervalMs = positiveNumber(
    authorization.intervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  let attempt = 0;

  while (true) {
    throwIfAborted(options.signal);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw timeoutError();

    await sleepWithAbort(
      Math.min(intervalMs, remainingMs),
      options.signal,
      sleep,
    );
    throwIfAborted(options.signal);
    if (now() >= deadline) throw timeoutError();

    attempt += 1;
    options.onStatusChange?.({ status: "polling", attempt, intervalMs });

    const body = new URLSearchParams({
      grant_type: FEISHU_DEVICE_CODE_GRANT_TYPE,
      device_code: authorization.deviceCode,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    let response: Response;
    try {
      response = await fetchImpl(
        options.tokenUrl ?? FEISHU_DEVICE_TOKEN_URL,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
          signal: options.signal,
        },
      );
    } catch (cause) {
      throw fetchFailure("token polling", options.signal, cause);
    }

    const json = await readJson(response, "token polling");
    const payload = responseShape(json);
    const oauthError = providerError(payload);

    if (!oauthError && response.ok && tokenPayload(json)?.access_token) {
      return parseFeishuDeviceTokenResponse(json, now, config.scopes);
    }

    if (oauthError === "authorization_pending") {
      options.onStatusChange?.({
        status: "authorization_pending",
        attempt,
        intervalMs,
      });
      continue;
    }

    if (oauthError === "slow_down") {
      intervalMs = Math.min(
        intervalMs + SLOW_DOWN_INCREMENT_MS,
        MAX_POLL_INTERVAL_MS,
      );
      options.onStatusChange?.({ status: "slow_down", attempt, intervalMs });
      continue;
    }

    if (oauthError) {
      throw terminalPollingError(oauthError, payload, response.status);
    }

    if (!response.ok) {
      throw new FeishuDeviceOAuthError(
        "oauth_error",
        providerMessage(
          payload,
          `Feishu token polling failed with HTTP ${response.status}.`,
        ),
        { status: response.status },
      );
    }

    // A successful HTTP response without either an OAuth error or a token is
    // malformed. Do not silently poll forever on an unexpected schema.
    throw new FeishuDeviceOAuthError(
      "invalid_response",
      "Feishu token polling response contained neither a token nor an OAuth error.",
      { status: response.status },
    );
  }
}

/** Naming alias for callers that use “start” terminology. */
export const startFeishuDeviceAuthorization =
  requestFeishuDeviceAuthorization;
