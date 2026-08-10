import { registerApp as sdkRegisterApp } from "@larksuiteoapi/node-sdk";

import { isTrustedFeishuAuthorizationUrl } from "./feishu-authorization-url";

export const FEISHU_APP_REGISTRATION_USER_SCOPES = [
  "task:task:read",
  "task:task:write",
  "offline_access",
] as const;

export interface FeishuAppRegistrationVerification {
  /** URL the UI should open in the user's browser. */
  verificationUrl: string;
  /** Absolute Unix timestamp in milliseconds. */
  expiresAt: number;
}

export interface FeishuAppRegistrationResult {
  client_id: string;
  client_secret: string;
  open_id?: string;
  tenant_brand?: "feishu" | "lark";
}

export interface FeishuAppRegistrationSession {
  /** Resolves as soon as the SDK has obtained a verification URL. */
  verification: Promise<FeishuAppRegistrationVerification>;
  /** Resolves after the user has confirmed app creation in Feishu/Lark. */
  result: Promise<FeishuAppRegistrationResult>;
  /** Cancels local polling. It does not delete an app that was already created. */
  cancel(): void;
}

export interface FeishuAppRegistrationDependencies {
  registerApp?: typeof sdkRegisterApp;
  now?: () => number;
}

export class FeishuAppRegistrationError extends Error {
  readonly code: string;
  readonly description: string;

  constructor(code: string, description: string) {
    super(description);
    this.name = "FeishuAppRegistrationError";
    this.code = code;
    this.description = description;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly state: () => "pending" | "resolved" | "rejected";
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let currentState: "pending" | "resolved" | "rejected" = "pending";
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    state: () => currentState,
    resolve(value) {
      if (currentState !== "pending") return;
      currentState = "resolved";
      resolvePromise(value);
    },
    reject(reason) {
      if (currentState !== "pending") return;
      currentState = "rejected";
      rejectPromise(reason);
    },
  };
}

function cancelledError(): FeishuAppRegistrationError {
  return new FeishuAppRegistrationError(
    "abort",
    "Feishu app registration was cancelled.",
  );
}

function invalidResponseError(): FeishuAppRegistrationError {
  return new FeishuAppRegistrationError(
    "invalid_response",
    "Feishu app registration completed without valid credentials or a verification URL.",
  );
}

/**
 * Starts Feishu's official RFC 8628 one-click app-creation flow.
 *
 * The app is created for the approving user and receives only the Task v2
 * user scopes required by Todo Agent. App credentials never leave the local
 * SDK flow; callers should place `client_secret` in OS secure storage as soon
 * as `result` resolves.
 */
export function startFeishuAppRegistration(
  dependencies: FeishuAppRegistrationDependencies = {},
): FeishuAppRegistrationSession {
  const registerApp = dependencies.registerApp ?? sdkRegisterApp;
  const now = dependencies.now ?? Date.now;
  const abortController = new AbortController();
  const verification = deferred<FeishuAppRegistrationVerification>();
  const cancellation = deferred<never>();
  let finished = false;
  let cancelled = false;

  const sdkResult = Promise.resolve().then(() =>
    registerApp({
      source: "todo-agent-desktop",
      signal: abortController.signal,
      createOnly: true,
      appPreset: {
        name: "Todo Agent - {user}",
        desc: "Todo Agent 的个人飞书任务同步应用",
      },
      addons: {
        preset: false,
        scopes: {
          user: [...FEISHU_APP_REGISTRATION_USER_SCOPES],
        },
      },
      onQRCodeReady(info) {
        if (cancelled) return;
        const expireIn = Number(info.expireIn);
        if (
          !info.url ||
          !isTrustedFeishuAuthorizationUrl(info.url) ||
          !Number.isFinite(expireIn) ||
          expireIn < 0
        ) {
          verification.reject(invalidResponseError());
          return;
        }
        verification.resolve({
          verificationUrl: info.url,
          expiresAt: now() + expireIn * 1_000,
        });
      },
    }),
  );

  const result = Promise.race([sdkResult, cancellation.promise]).then(
    (value): FeishuAppRegistrationResult => {
      finished = true;
      if (
        verification.state() !== "resolved" ||
        !value.client_id ||
        !value.client_secret
      ) {
        const error = invalidResponseError();
        verification.reject(error);
        throw error;
      }
      return {
        client_id: value.client_id,
        client_secret: value.client_secret,
        open_id: value.user_info?.open_id,
        tenant_brand: value.user_info?.tenant_brand,
      };
    },
    (error: unknown) => {
      finished = true;
      verification.reject(error);
      throw error;
    },
  );

  // Both promises are returned to the caller. Attaching internal rejection
  // observers prevents a fast network/cancellation failure from becoming an
  // unhandled rejection before the UI has installed its own handlers.
  void verification.promise.catch(() => undefined);
  void result.catch(() => undefined);

  return {
    verification: verification.promise,
    result,
    cancel() {
      if (finished || cancelled) return;
      cancelled = true;
      const error = cancelledError();
      abortController.abort();
      verification.reject(error);
      cancellation.reject(error);
    },
  };
}
