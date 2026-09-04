import { createHash } from "node:crypto";

export type FeishuCredentialMode =
  | "personal-direct"
  | "existing-direct"
  | "relay"
  | "local-development";

export interface FeishuCredentialIdentity {
  mode: FeishuCredentialMode;
  accountId: string;
  clientId?: string;
  relayBaseUrl?: string;
}

export interface FeishuAuthorizedUserIdentity {
  /** Stable app/relay identity. The editable local account label is excluded. */
  appIdentityId: string;
  openId: string;
  tenantKey?: string;
}

function normalizedIdentity(identity: FeishuCredentialIdentity): string {
  return JSON.stringify([
    identity.mode,
    identity.accountId.trim(),
    identity.clientId?.trim() ?? "",
    identity.mode === "relay"
      ? identity.relayBaseUrl?.trim().replace(/\/+$/u, "") ?? ""
      : "",
  ]);
}

function identityDigest(identity: FeishuCredentialIdentity): string {
  return createHash("sha256")
    .update(normalizedIdentity(identity), "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Identifies the OAuth client without including a user-editable local label or
 * any credential material.  Relay URL is included because two relays with the
 * same optional client id are not necessarily the same application boundary.
 */
export function deriveFeishuAppIdentityId(
  identity: Pick<
    FeishuCredentialIdentity,
    "mode" | "clientId" | "relayBaseUrl"
  >,
): string {
  const normalized = JSON.stringify([
    identity.mode,
    identity.clientId?.trim() ?? "",
    identity.mode === "relay"
      ? identity.relayBaseUrl?.trim().replace(/\/+$/u, "") ?? ""
      : "",
  ]);
  return createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function authorizedIdentityDigest(identity: FeishuAuthorizedUserIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        1,
        identity.appIdentityId.trim(),
        identity.openId.trim(),
        identity.tenantKey?.trim() ?? "",
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

/** Opaque local sync namespace; it contains no token, secret, or raw open_id. */
export function deriveFeishuSyncIdentityId(
  identity: FeishuAuthorizedUserIdentity,
): string {
  return `feishu-sync-${authorizedIdentityDigest(identity)}`;
}

/** OS-vault reference tied to both the OAuth app and the authorized user. */
export function deriveFeishuAuthorizedTokenCredentialId(
  identity: FeishuAuthorizedUserIdentity,
): string {
  return `feishu-token-user-${authorizedIdentityDigest(identity)}`;
}

export function sameFeishuCredentialIdentity(
  left: FeishuCredentialIdentity,
  right: FeishuCredentialIdentity,
): boolean {
  return normalizedIdentity(left) === normalizedIdentity(right);
}

/** Stable, non-secret reference that prevents tokens crossing app identities. */
export function deriveFeishuTokenCredentialId(
  identity: FeishuCredentialIdentity,
): string {
  return `feishu-token-${identityDigest(identity)}`;
}

/** Stable, non-secret reference that prevents one app secret overwriting another. */
export function deriveFeishuAppSecretCredentialId(
  identity: Omit<FeishuCredentialIdentity, "relayBaseUrl">,
): string {
  return `feishu-app-secret-${identityDigest(identity)}`;
}
