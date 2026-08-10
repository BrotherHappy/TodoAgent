import type { FeishuSyncRunReport } from './feishu-sync-service';

export interface FeishuAutoSyncConnectionStatus {
  connected: boolean;
  polling: boolean;
}

export interface FeishuAutoSyncPolicy {
  enabled: boolean;
  pollingIntervalMs: number;
}

export interface FeishuAutoSyncCoordinatorOptions {
  getStatus(): FeishuAutoSyncConnectionStatus;
  getPolicy(): FeishuAutoSyncPolicy;
  startPolling(intervalMs: number): Promise<unknown>;
  resumeAfterReconnect(): Promise<FeishuSyncRunReport | undefined>;
  onReport?(report: FeishuSyncRunReport): void;
  onError?(error: unknown): void;
}

/**
 * Owns the small but important gap between a connection becoming available
 * and its first automatic sync. The connection controller intentionally does
 * not know product settings, while main must not start a recovery pass for
 * every later polling status update.
 */
export class FeishuAutoSyncCoordinator {
  private readonly getStatus: () => FeishuAutoSyncConnectionStatus;
  private readonly getPolicy: () => FeishuAutoSyncPolicy;
  private readonly startPolling: (intervalMs: number) => Promise<unknown>;
  private readonly resumeAfterReconnect: () => Promise<
    FeishuSyncRunReport | undefined
  >;
  private readonly onReport: (report: FeishuSyncRunReport) => void;
  private readonly onError: (error: unknown) => void;
  private wasConnected = false;
  private recoveryInFlight = false;
  private pollingIntervalMs?: number;

  constructor(options: FeishuAutoSyncCoordinatorOptions) {
    this.getStatus = options.getStatus;
    this.getPolicy = options.getPolicy;
    this.startPolling = options.startPolling;
    this.resumeAfterReconnect = options.resumeAfterReconnect;
    this.onReport = options.onReport ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
  }

  /** Call from each controller status publication. */
  onStatus(status: FeishuAutoSyncConnectionStatus): void {
    const becameConnected = status.connected && !this.wasConnected;
    this.wasConnected = status.connected;
    if (!status.connected) this.pollingIntervalMs = undefined;
    if (becameConnected) this.startAndRecover();
  }

  /** Call after a user changes automatic-sync settings. */
  onSettingsChanged(): void {
    const policy = this.getPolicy();
    const status = this.getStatus();
    if (!policy.enabled) {
      this.pollingIntervalMs = undefined;
      return;
    }
    if (!status.connected) return;
    if (!status.polling) {
      this.startAndRecover();
      return;
    }
    if (this.pollingIntervalMs !== policy.pollingIntervalMs) {
      this.startPollingOnly(policy.pollingIntervalMs);
    }
  }

  /** Covers a restored connected session that existed before this object. */
  reconcile(): void {
    const status = this.getStatus();
    this.wasConnected = status.connected;
    if (status.connected) this.startAndRecover();
  }

  private startAndRecover(): void {
    if (this.recoveryInFlight) return;
    const policy = this.getPolicy();
    if (!policy.enabled || !this.getStatus().connected) return;
    this.recoveryInFlight = true;
    void (async () => {
      try {
        await this.startPolling(policy.pollingIntervalMs);
        this.pollingIntervalMs = policy.pollingIntervalMs;
        const report = await this.resumeAfterReconnect();
        if (report) this.onReport(report);
      } catch (error) {
        this.onError(error);
      } finally {
        this.recoveryInFlight = false;
      }
    })();
  }

  private startPollingOnly(intervalMs: number): void {
    void this.startPolling(intervalMs).then(
      () => {
        this.pollingIntervalMs = intervalMs;
      },
      (error: unknown) => this.onError(error),
    );
  }
}
