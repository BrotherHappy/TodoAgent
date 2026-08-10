import { describe, expect, it, vi } from 'vitest';

import { FeishuMutationSyncCoordinator } from '../electron/feishu/feishu-mutation-sync-coordinator';

function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('FeishuMutationSyncCoordinator', () => {
  it('starts on the next microtask and coalesces one interaction into one sync pass', async () => {
    const deferredCallbacks: Array<() => void> = [];
    const flush = vi.fn(async () => undefined);
    const coordinator = new FeishuMutationSyncCoordinator({
      flush,
      defer: (callback) => deferredCallbacks.push(callback),
    });

    coordinator.requestFlush();
    coordinator.requestFlush();
    coordinator.requestFlush();

    expect(flush).not.toHaveBeenCalled();
    expect(deferredCallbacks).toHaveLength(1);
    deferredCallbacks.shift()!();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
  });

  it('never overlaps syncs and coalesces mutations during a sync into one follow-up pass', async () => {
    const deferredCallbacks: Array<() => void> = [];
    const first = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const flush = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (flush.mock.calls.length === 1) await first.promise;
      active -= 1;
    });
    const coordinator = new FeishuMutationSyncCoordinator({
      flush,
      defer: (callback) => deferredCallbacks.push(callback),
    });

    coordinator.requestFlush();
    deferredCallbacks.shift()!();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));

    coordinator.requestFlush();
    coordinator.requestFlush();
    expect(deferredCallbacks).toHaveLength(0);

    first.resolve();
    await vi.waitFor(() => expect(deferredCallbacks).toHaveLength(1));
    deferredCallbacks.shift()!();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
  });

  it('cancels a not-yet-started background pass when manual sync runs now', async () => {
    const deferredCallbacks: Array<() => void> = [];
    const flush = vi.fn(async () => undefined);
    const manual = vi.fn(async () => 'manual-result');
    const coordinator = new FeishuMutationSyncCoordinator({
      flush,
      defer: (callback) => deferredCallbacks.push(callback),
    });

    coordinator.requestFlush();
    await expect(coordinator.runNow(manual)).resolves.toBe('manual-result');
    deferredCallbacks.shift()!();
    await Promise.resolve();

    expect(manual).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
  });
});
