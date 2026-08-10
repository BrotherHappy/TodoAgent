import { describe, expect, it, vi } from 'vitest';

import { FeishuAutoSyncCoordinator } from '../electron/feishu/feishu-auto-sync-coordinator';

const report = {
  pushed: 1,
  pulled: 2,
  deleted: 0,
  conflicts: [],
  offline: false,
  usedFullSync: true,
};

describe('FeishuAutoSyncCoordinator', () => {
  it('starts polling and immediately recovers once when OAuth changes to connected', async () => {
    let status = { connected: false, polling: false };
    const startPolling = vi.fn(async () => undefined);
    const resumeAfterReconnect = vi.fn(async () => report);
    const onReport = vi.fn();
    const coordinator = new FeishuAutoSyncCoordinator({
      getStatus: () => status,
      getPolicy: () => ({ enabled: true, pollingIntervalMs: 60_000 }),
      startPolling,
      resumeAfterReconnect,
      onReport,
    });

    coordinator.onStatus(status);
    status = { connected: true, polling: false };
    coordinator.onStatus(status);

    await vi.waitFor(() => expect(onReport).toHaveBeenCalledWith(report));
    expect(startPolling).toHaveBeenCalledTimes(1);
    expect(startPolling).toHaveBeenCalledWith(60_000);
    expect(resumeAfterReconnect).toHaveBeenCalledTimes(1);

    coordinator.onStatus({ connected: true, polling: true });
    await Promise.resolve();
    expect(startPolling).toHaveBeenCalledTimes(1);
    expect(resumeAfterReconnect).toHaveBeenCalledTimes(1);
  });

  it('starts when auto-sync is enabled later and replaces a changed polling interval', async () => {
    let status = { connected: true, polling: false };
    let enabled = false;
    let intervalMs = 60_000;
    const startPolling = vi.fn(async () => undefined);
    const resumeAfterReconnect = vi.fn(async () => undefined);
    const coordinator = new FeishuAutoSyncCoordinator({
      getStatus: () => status,
      getPolicy: () => ({ enabled, pollingIntervalMs: intervalMs }),
      startPolling,
      resumeAfterReconnect,
    });

    coordinator.onSettingsChanged();
    expect(startPolling).not.toHaveBeenCalled();

    enabled = true;
    coordinator.onSettingsChanged();
    await vi.waitFor(() => expect(resumeAfterReconnect).toHaveBeenCalledTimes(1));
    expect(startPolling).toHaveBeenLastCalledWith(60_000);

    status = { connected: true, polling: true };
    intervalMs = 5 * 60_000;
    coordinator.onSettingsChanged();
    await vi.waitFor(() =>
      expect(startPolling).toHaveBeenLastCalledWith(5 * 60_000),
    );
    expect(resumeAfterReconnect).toHaveBeenCalledTimes(1);
  });
});
