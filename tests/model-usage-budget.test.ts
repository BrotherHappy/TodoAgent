import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ModelUsageBudgetService,
} from '../electron/agent/model-usage-budget';

const temporaryDirectories: string[] = [];

const createHarness = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-usage-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'private', 'model-usage.v1.json');
  let localDate = '2026-08-09';
  let now = new Date('2026-08-09T01:00:00.000Z');
  const service = new ModelUsageBudgetService({
    filePath,
    now: () => now,
    localDate: () => localDate,
    timezone: () => 'Asia/Shanghai',
  });
  await service.initialize();
  return {
    directory,
    filePath,
    service,
    setDay: (value: string) => { localDate = value; },
    setNow: (value: string) => { now = new Date(value); },
  };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('ModelUsageBudgetService', () => {
  it('persists exact provider total_tokens and rejects the next run at the daily limit', async () => {
    const harness = await createHarness();

    expect(await harness.service.status(100, 5)).toMatchObject({
      localDate: '2026-08-09',
      timezone: 'Asia/Shanghai',
      usedTokens: 0,
      dailyTokenLimit: 100,
      remainingTokens: 100,
      blocked: false,
      accounting: 'none',
      cost: {
        configuredDailyLimitUsd: 5,
        mode: 'not-enforced',
        reason: 'MODEL_PRICING_NOT_CONFIGURED',
      },
    });

    await Promise.all([
      harness.service.recordProviderUsage(31, 100, 5),
      harness.service.recordProviderUsage(69, 100, 5),
    ]);
    expect(await harness.service.status(100, 5)).toMatchObject({
      usedTokens: 100,
      remainingTokens: 0,
      reportedRequestCount: 2,
      blocked: true,
      blockedReason: 'daily-token-limit-reached',
    });
    await expect(harness.service.assertCanStart(100, 5)).rejects.toMatchObject({
      code: 'AI_DAILY_TOKEN_LIMIT_REACHED',
    });

    const reloaded = new ModelUsageBudgetService({
      filePath: harness.filePath,
      localDate: () => '2026-08-09',
      timezone: () => 'Asia/Shanghai',
    });
    await reloaded.initialize();
    expect(await reloaded.status(100, 5)).toMatchObject({ usedTokens: 100, reportedRequestCount: 2 });

    const persisted = await readFile(harness.filePath, 'utf8');
    expect(JSON.parse(persisted)).toEqual({
      schemaVersion: 1,
      days: {
        '2026-08-09': {
          usedTokens: 100,
          usedCostUsd: 0,
          reportedRequestCount: 2,
          unreportedRequestCount: 0,
          unpricedRequestCount: 0,
          lastUpdatedAt: expect.any(String),
        },
      },
    });
    if (process.platform !== 'win32') {
      expect((await stat(harness.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rolls over by injected local calendar date without erasing prior accounting', async () => {
    const harness = await createHarness();
    await harness.service.recordProviderUsage(90, 100, 0);
    harness.setDay('2026-08-10');
    harness.setNow('2026-08-10T01:00:00.000Z');

    expect(await harness.service.status(100, 0)).toMatchObject({
      localDate: '2026-08-10',
      usedTokens: 0,
      remainingTokens: 100,
      blocked: false,
      cost: { configuredDailyLimitUsd: null, mode: 'not-enforced' },
    });
    await expect(harness.service.assertCanStart(100, 0)).resolves.toMatchObject({ blocked: false });

    const persisted = JSON.parse(await readFile(harness.filePath, 'utf8')) as { days: Record<string, unknown> };
    expect(persisted.days).toHaveProperty('2026-08-09');
  });

  it('fails closed when a limited provider omits usage.total_tokens', async () => {
    const harness = await createHarness();
    await harness.service.recordProviderUsage(undefined, 1_000, 10);

    expect(await harness.service.status(1_000, 10)).toMatchObject({
      usedTokens: 0,
      reportedRequestCount: 0,
      unreportedRequestCount: 1,
      accounting: 'unavailable',
      blocked: true,
      blockedReason: 'provider-usage-unavailable',
    });
    await expect(harness.service.assertCanStart(1_000, 10)).rejects.toMatchObject({
      code: 'AI_PROVIDER_USAGE_UNAVAILABLE',
    });

    // A zero token limit explicitly disables the local token gate. Cost is
    // still not fabricated or enforced.
    expect(await harness.service.status(0, 10)).toMatchObject({
      dailyTokenLimit: null,
      remainingTokens: null,
      blocked: false,
      cost: { mode: 'not-enforced', reason: 'MODEL_PRICING_NOT_CONFIGURED' },
    });
  });

  it('does not silently reset a corrupt usage state and bypass the budget', async () => {
    const harness = await createHarness();
    await writeFile(harness.filePath, '{corrupt', { encoding: 'utf8', mode: 0o600 });
    await rm(`${harness.filePath}.backup`, { force: true });
    // Ensure the test also covers a pre-existing file whose permissions are
    // not responsible for the read failure.
    if (process.platform !== 'win32') await chmod(harness.filePath, 0o600);

    const reloaded = new ModelUsageBudgetService({
      filePath: harness.filePath,
      localDate: () => '2026-08-09',
      timezone: () => 'Asia/Shanghai',
    });
    await reloaded.initialize();

    expect(await reloaded.status(100, 5)).toMatchObject({
      blocked: true,
      blockedReason: 'usage-state-unavailable',
    });
    await expect(reloaded.assertCanStart(100, 5)).rejects.toMatchObject({
      code: 'AI_USAGE_STATE_UNAVAILABLE',
    });
  });

  it('prices provider-reported prompt and completion tokens and enforces the cost cap', async () => {
    const harness = await createHarness();
    const pricing = {
      promptUsdPerMillionTokens: 10,
      completionUsdPerMillionTokens: 20,
    };
    await harness.service.recordProviderUsage(
      { promptTokens: 500, completionTokens: 250, totalTokens: 750 },
      0,
      0.01,
      pricing,
    );

    expect(await harness.service.status(0, 0.01, pricing)).toMatchObject({
      usedTokens: 750,
      unpricedRequestCount: 0,
      blocked: true,
      blockedReason: 'daily-cost-limit-reached',
      cost: {
        configuredDailyLimitUsd: 0.01,
        mode: 'enforced',
        usedUsd: 0.01,
        remainingUsd: 0,
      },
    });
    await expect(harness.service.assertCanStart(0, 0.01, pricing)).rejects.toMatchObject({
      code: 'AI_DAILY_COST_LIMIT_REACHED',
    });
  });

  it('fails closed when a configured cost profile cannot price a provider response', async () => {
    const harness = await createHarness();
    const pricing = {
      promptUsdPerMillionTokens: 1,
      completionUsdPerMillionTokens: 2,
    };
    await harness.service.recordProviderUsage(50, 0, 5, pricing);

    expect(await harness.service.status(0, 5, pricing)).toMatchObject({
      usedTokens: 50,
      unpricedRequestCount: 1,
      blocked: true,
      blockedReason: 'provider-cost-unavailable',
      cost: { mode: 'enforced', usedUsd: 0 },
    });
    await expect(harness.service.assertCanStart(0, 5, pricing)).rejects.toMatchObject({
      code: 'AI_PROVIDER_COST_UNAVAILABLE',
    });
  });
});
