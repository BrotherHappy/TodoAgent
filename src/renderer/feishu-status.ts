import type { FeishuStatusView } from "../shared/desktop-api";

export type FeishuSyncVisualState = "pending" | "error";

/**
 * Keeps connection-level failures visible even when no individual task has a
 * failed sync marker yet. Retryable/network issues remain amber/pending;
 * permission, read-only and terminal failures are red/error.
 */
export function feishuSyncVisualState(
  status: FeishuStatusView | undefined,
): FeishuSyncVisualState | undefined {
  if (!status?.configured) return undefined;
  if (status.state === "syncing") return "pending";
  if (
    status.lastError?.code === "NETWORK_UNAVAILABLE" ||
    status.lastError?.retryable
  ) {
    return "pending";
  }
  if (status.state === "error" || status.lastError) return "error";
  return undefined;
}
