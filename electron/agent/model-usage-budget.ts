import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { ModelUsageStatus } from '../../src/shared/desktop-api';

const storedDaySchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  reportedRequestCount: z.number().int().nonnegative(),
  unreportedRequestCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().datetime().optional(),
}).strict();

const storedStateSchema = z.object({
  schemaVersion: z.literal(1),
  days: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), storedDaySchema),
}).strict();

type StoredState = z.infer<typeof storedStateSchema>;

export interface ModelUsageBudgetOptions {
  filePath: string;
  now?: () => Date;
  localDate?: (date: Date) => string;
  timezone?: () => string;
}

export class ModelUsageBudgetError extends Error {
  constructor(readonly code:
    | 'AI_DAILY_TOKEN_LIMIT_REACHED'
    | 'AI_PROVIDER_USAGE_UNAVAILABLE'
    | 'AI_USAGE_STATE_UNAVAILABLE') {
    super(code);
    this.name = code;
  }
}

const initialState = (): StoredState => ({ schemaVersion: 1, days: {} });

const clone = <Value>(value: Value): Value => structuredClone(value);

const defaultLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/**
 * Persists provider-reported token usage separately from preferences and
 * credentials. The file never contains prompts, responses, endpoints, model
 * names, or credential references.
 */
export class ModelUsageBudgetService {
  readonly #filePath: string;
  readonly #backupPath: string;
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #localDate: (date: Date) => string;
  readonly #timezone: () => string;
  #state: StoredState = initialState();
  #initialized = false;
  #storageAvailable = true;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ModelUsageBudgetOptions) {
    this.#filePath = path.resolve(options.filePath);
    this.#backupPath = `${this.#filePath}.backup`;
    this.#directory = path.dirname(this.#filePath);
    this.#now = options.now ?? (() => new Date());
    this.#localDate = options.localDate ?? defaultLocalDate;
    this.#timezone = options.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local');
  }

  async initialize(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#initialized) return;
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      try {
        this.#state = await this.#readState(this.#filePath);
      } catch (primaryError) {
        if (isMissing(primaryError)) {
          try {
            this.#state = await this.#readState(this.#backupPath);
            await this.#writeAtomically(this.#filePath, this.#state);
          } catch (backupError) {
            if (!isMissing(backupError)) {
              this.#storageAvailable = false;
            } else {
              try {
                await this.#writeAtomically(this.#filePath, this.#state);
              } catch {
                this.#storageAvailable = false;
              }
            }
          }
        } else {
          try {
            this.#state = await this.#readState(this.#backupPath);
            await this.#writeAtomically(this.#filePath, this.#state);
          } catch {
            // Never reset a corrupt counter silently: that could bypass a
            // configured daily limit. The model path fails closed instead.
            this.#storageAvailable = false;
          }
        }
      }
      this.#initialized = true;
    });
  }

  async status(dailyTokenLimit: number, dailyCostLimit: number): Promise<ModelUsageStatus> {
    return this.#enqueue(async () => this.#statusUnsafe(dailyTokenLimit, dailyCostLimit));
  }

  async assertCanStart(dailyTokenLimit: number, dailyCostLimit: number): Promise<ModelUsageStatus> {
    return this.#enqueue(async () => {
      const status = this.#statusUnsafe(dailyTokenLimit, dailyCostLimit);
      if (status.blockedReason === 'usage-state-unavailable') {
        throw new ModelUsageBudgetError('AI_USAGE_STATE_UNAVAILABLE');
      }
      if (status.blockedReason === 'provider-usage-unavailable') {
        throw new ModelUsageBudgetError('AI_PROVIDER_USAGE_UNAVAILABLE');
      }
      if (status.blockedReason === 'daily-token-limit-reached') {
        throw new ModelUsageBudgetError('AI_DAILY_TOKEN_LIMIT_REACHED');
      }
      return status;
    });
  }

  async recordProviderUsage(
    totalTokens: number | undefined,
    dailyTokenLimit: number,
    dailyCostLimit: number,
  ): Promise<ModelUsageStatus> {
    return this.#enqueue(async () => {
      this.#assertInitialized();
      if (!this.#storageAvailable) {
        throw new ModelUsageBudgetError('AI_USAGE_STATE_UNAVAILABLE');
      }

      const now = this.#now();
      const localDate = this.#localDate(now);
      const next = clone(this.#state);
      const day = next.days[localDate] ?? {
        usedTokens: 0,
        reportedRequestCount: 0,
        unreportedRequestCount: 0,
      };
      if (Number.isInteger(totalTokens) && (totalTokens ?? -1) >= 0) {
        day.usedTokens += totalTokens!;
        day.reportedRequestCount += 1;
      } else {
        day.unreportedRequestCount += 1;
      }
      day.lastUpdatedAt = now.toISOString();
      next.days[localDate] = day;
      this.#prune(next);

      try {
        await this.#persist(next);
      } catch {
        this.#storageAvailable = false;
        throw new ModelUsageBudgetError('AI_USAGE_STATE_UNAVAILABLE');
      }
      this.#state = next;
      return this.#statusUnsafe(dailyTokenLimit, dailyCostLimit);
    });
  }

  #statusUnsafe(dailyTokenLimit: number, dailyCostLimit: number): ModelUsageStatus {
    this.#assertInitialized();
    const localDate = this.#localDate(this.#now());
    const day = this.#state.days[localDate] ?? {
      usedTokens: 0,
      reportedRequestCount: 0,
      unreportedRequestCount: 0,
    };
    const tokenLimit = Number.isInteger(dailyTokenLimit) && dailyTokenLimit > 0
      ? dailyTokenLimit
      : null;
    const remainingTokens = tokenLimit === null
      ? null
      : Math.max(0, tokenLimit - day.usedTokens);
    const blockedReason = !this.#storageAvailable
      ? 'usage-state-unavailable' as const
      : tokenLimit !== null && day.unreportedRequestCount > 0
        ? 'provider-usage-unavailable' as const
        : tokenLimit !== null && day.usedTokens >= tokenLimit
          ? 'daily-token-limit-reached' as const
          : undefined;
    const accounting = day.reportedRequestCount === 0 && day.unreportedRequestCount === 0
      ? 'none' as const
      : day.unreportedRequestCount > 0
        ? day.reportedRequestCount > 0 ? 'partial' as const : 'unavailable' as const
        : 'provider-reported' as const;

    return {
      localDate,
      timezone: this.#timezone(),
      usedTokens: day.usedTokens,
      dailyTokenLimit: tokenLimit,
      remainingTokens,
      blocked: blockedReason !== undefined,
      blockedReason,
      reportedRequestCount: day.reportedRequestCount,
      unreportedRequestCount: day.unreportedRequestCount,
      lastUpdatedAt: day.lastUpdatedAt,
      accounting,
      enforcement: 'block-new-runs-at-or-over-limit',
      cost: {
        configuredDailyLimitUsd: Number.isFinite(dailyCostLimit) && dailyCostLimit > 0
          ? dailyCostLimit
          : null,
        mode: 'not-enforced',
        reason: 'MODEL_PRICING_NOT_CONFIGURED',
      },
    };
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new ModelUsageBudgetError('AI_USAGE_STATE_UNAVAILABLE');
  }

  #prune(state: StoredState): void {
    const keys = Object.keys(state.days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 62))) {
      delete state.days[key];
    }
  }

  async #readState(filePath: string): Promise<StoredState> {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return storedStateSchema.parse(parsed);
  }

  async #persist(next: StoredState): Promise<void> {
    try {
      const current = await this.#readState(this.#filePath);
      await this.#writeAtomically(this.#backupPath, current);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.#writeAtomically(this.#filePath, next);
  }

  async #writeAtomically(targetPath: string, value: StoredState): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      this.#directory,
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
