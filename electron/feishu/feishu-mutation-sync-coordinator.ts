export interface FeishuMutationSyncCoordinatorOptions {
  flush(): Promise<void>;
  onError?(error: unknown): void;
  defer?(callback: () => void): void;
}

/**
 * Starts mutation-driven sync on the next microtask, while keeping all sync
 * entry points serialized. Repeated task-change notifications in the same
 * interaction are coalesced, and changes arriving during a sync produce at
 * most one follow-up pass.
 */
export class FeishuMutationSyncCoordinator {
  private readonly flush: () => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly defer: (callback: () => void) => void;
  private serial: Promise<void> = Promise.resolve();
  private scheduled = false;
  private backgroundPending = false;
  private rerunRequested = false;
  private disposed = false;

  constructor(options: FeishuMutationSyncCoordinatorOptions) {
    this.flush = options.flush;
    this.onError = options.onError ?? (() => undefined);
    this.defer = options.defer ?? queueMicrotask;
  }

  requestFlush(): void {
    if (this.disposed) return;
    if (this.backgroundPending) {
      this.rerunRequested = true;
      return;
    }
    if (this.scheduled) return;

    this.scheduled = true;
    this.defer(() => {
      if (!this.scheduled || this.disposed) return;
      this.scheduled = false;
      this.backgroundPending = true;
      void this.enqueue(this.flush)
        .catch(this.onError)
        .finally(() => {
          this.backgroundPending = false;
          if (!this.rerunRequested || this.disposed) return;
          this.rerunRequested = false;
          this.requestFlush();
        });
    });
  }

  runNow<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.scheduled = false;
    this.rerunRequested = false;
    return this.enqueue(operation);
  }

  dispose(): void {
    this.disposed = true;
    this.scheduled = false;
    this.rerunRequested = false;
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const running = this.serial.then(operation, operation);
    this.serial = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}
