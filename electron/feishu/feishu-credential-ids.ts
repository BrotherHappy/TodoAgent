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
