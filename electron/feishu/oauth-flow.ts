import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import {
  FEISHU_AUTHORIZE_URL,
  FEISHU_TOKEN_URL,
  type FeishuAuthConfig,
  type FeishuFetch,
  type FeishuOAuthCallback,
  type FeishuOAuthSession,
  type FeishuTokenSet,
} from "../../src/shared/feishu-types";

interface OAuthDependencies {
  fetch?: FeishuFetch;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

interface TokenResponseShape {
  code?: number;
  msg?: string;
  access_token?: string;
  refresh_token?: string;
  open_id?: string;
  tenant_key?: string;
  token_type?: string;
  scope?: string | string[];
  expires_in?: number;
  refresh_token_expires_in?: number;
  data?: TokenResponseShape;
}

export class FeishuOAuthError extends Error {
  readonly status?: number;
  readonly code?: number;

  constructor(
    message: string,
    options: { status?: number; code?: number } = {},
  ) {
    super(message);
    this.name = "FeishuOAuthError";
    this.status = options.status;
    this.code = options.code;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function assertSafeConfiguration(config: FeishuAuthConfig): void {
  if (config.mode === "relay") {
    if (!/^https:\/\//i.test(config.relayBaseUrl)) {
      throw new FeishuOAuthError("Relay mode requires an HTTPS relay URL.");
    }
    return;
  }

  if (config.acknowledgeInsecureLocalCredentials !== true) {
    throw new FeishuOAuthError(
      "Local credentials are development-only and require explicit acknowledgement.",
    );
  }
}

export function createPkcePair(
  bytes: (size: number) => Uint8Array = nodeRandomBytes,
): { codeVerifier: string; codeChallenge: string } {
  // 64 bytes produce an 86-character verifier, within RFC 7636's 43-128 range.
  const codeVerifier = base64Url(bytes(64));
  const codeChallenge = createHash("sha256")
    .update(codeVerifier, "ascii")
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function createOAuthSession(
  config: FeishuAuthConfig,
  scopes: readonly string[] = [],
  dependencies: Pick<OAuthDependencies, "randomBytes"> = {},
): FeishuOAuthSession {
  assertSafeConfiguration(config);

  const bytes = dependencies.randomBytes ?? nodeRandomBytes;
  const { codeVerifier, codeChallenge } = createPkcePair(bytes);
  const state = base64Url(bytes(32));
  const authorizationEndpoint =
    config.mode === "relay"
      ? `${stripTrailingSlash(config.relayBaseUrl)}/feishu/oauth/authorize`
      : FEISHU_AUTHORIZE_URL;
  const url = new URL(authorizationEndpoint);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.clientId) {
    url.searchParams.set("client_id", config.clientId);
  }
  if (scopes.length > 0) {
    url.searchParams.set("scope", scopes.join(" "));
  }

  return {
    authorizationUrl: url.toString(),
    state,
    codeVerifier,
    codeChallenge,
  };
}

export function validateOAuthCallback(
  callback: FeishuOAuthCallback,
  session: Pick<FeishuOAuthSession, "state">,
): void {
  if (!callback.code) {
    throw new FeishuOAuthError("The OAuth callback did not contain a code.");
  }
  if (!callback.state || callback.state !== session.state) {
    throw new FeishuOAuthError("OAuth state mismatch.");
  }
}

function tokenEndpoint(config: FeishuAuthConfig): string {
  return config.mode === "relay"
    ? `${stripTrailingSlash(config.relayBaseUrl)}/feishu/oauth/token`
    : FEISHU_TOKEN_URL;
}

function scopeList(scope: string | string[] | undefined): string[] {
  if (Array.isArray(scope)) {
    return scope.filter(Boolean);
  }
  return scope?.split(/[ ,]+/).filter(Boolean) ?? [];
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function requestToken(
  config: FeishuAuthConfig,
  body: Record<string, string>,
  dependencies: Pick<OAuthDependencies, "fetch" | "now"> = {},
): Promise<FeishuTokenSet> {
  assertSafeConfiguration(config);
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;

  const requestBody: Record<string, string> = { ...body };
  if (config.mode === "local-development") {
    requestBody.client_id = config.clientId;
    requestBody.client_secret = config.clientSecret;
  }

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint(config), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    throw new FeishuOAuthError(
      `Token request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const json = (await parseJsonSafely(response)) as
    | TokenResponseShape
    | undefined;
  const payload = json?.data?.access_token ? json.data : json;
  if (
    !response.ok ||
    !payload ||
    (json?.code !== undefined && json.code !== 0)
  ) {
    throw new FeishuOAuthError(
      json?.msg || `Token request failed with HTTP ${response.status}.`,
      { status: response.status, code: json?.code },
    );
  }
  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new FeishuOAuthError(
      "Token response is missing access_token or expires_in.",
    );
  }

  const issuedAt = now();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    openId: payload.open_id,
    tenantKey: payload.tenant_key,
    tokenType: payload.token_type || "Bearer",
    scope: scopeList(payload.scope),
    expiresAt: issuedAt + payload.expires_in * 1_000,
    refreshTokenExpiresAt:
      typeof payload.refresh_token_expires_in === "number"
        ? issuedAt + payload.refresh_token_expires_in * 1_000
        : undefined,
  };
}

export async function exchangeAuthorizationCode(
  config: FeishuAuthConfig,
  callback: FeishuOAuthCallback,
  session: Pick<FeishuOAuthSession, "state" | "codeVerifier">,
  dependencies: Pick<OAuthDependencies, "fetch" | "now"> = {},
): Promise<FeishuTokenSet> {
  validateOAuthCallback(callback, session);
  return requestToken(
    config,
    {
      grant_type: "authorization_code",
      code: callback.code,
      code_verifier: session.codeVerifier,
      redirect_uri: config.redirectUri,
    },
    dependencies,
  );
}

export async function refreshUserToken(
  config: FeishuAuthConfig,
  refreshToken: string,
  dependencies: Pick<OAuthDependencies, "fetch" | "now"> = {},
): Promise<FeishuTokenSet> {
  if (!refreshToken) {
    throw new FeishuOAuthError("A refresh token is required.");
  }
  return requestToken(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    dependencies,
  );
}

/** Backwards-friendly aliases with explicit OAuth wording. */
export const buildFeishuAuthorizationRequest = createOAuthSession;
export const refreshFeishuUserToken = refreshUserToken;
