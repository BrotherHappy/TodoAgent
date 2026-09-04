// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ReminderRuntimeStore,
  ReminderRuntimeStoreValidationError,
} from '../electron/services/reminder-runtime-store';
import { emptyReminderRuntimeState } from '../src/shared/reminders';

const directories: string[] = [];

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'todo-reminder-runtime-'));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('ReminderRuntimeStore', () => {
  it('persists valid runtime state with an atomic temporary-file replacement', async () => {
    const directory = await createDirectory();
    const store = new ReminderRuntimeStore(directory);
    const state = {
      ...emptyReminderRuntimeState(),
      delivered: { 'task:t1:r1:2026-08-09T01:00:00.000Z': '2026-08-09T01:01:00.000Z' },
      dismissed: { morning: 1 },
      snoozedUntil: { r2: '2026-08-09T02:00:00.000Z' },
      lastMorningBriefDate: '2026-08-09',
    };

    await store.save(state);

    expect(await new ReminderRuntimeStore(directory).load()).toEqual(state);
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      state,
    });
  });

  it('recovers the prior valid version when the main file is corrupt', async () => {
    const directory = await createDirectory();
    const store = new ReminderRuntimeStore(directory);
    const first = {
      ...emptyReminderRuntimeState(),
      delivered: { first: '2026-08-09T01:00:00.000Z' },
    };
    const second = {
      ...first,
      delivered: { ...first.delivered, second: '2026-08-09T02:00:00.000Z' },
    };
    await store.save(first);
    await store.save(second);
    await writeFile(store.filePath, '{broken', 'utf8');

    expect(await store.load()).toEqual(first);
    expect(JSON.parse(await readFile(store.filePath, 'utf8')).state).toEqual(first);
  });

  it('upgrades a pre-budget runtime file without discarding reminder history', async () => {
    const directory = await createDirectory();
    const store = new ReminderRuntimeStore(directory);
    const legacyState = {
      delivered: { first: '2026-08-09T01:00:00.000Z' },
      dismissed: {},
      snoozedUntil: {},
      lastRiskNoticeDate: '2026-08-09',
    };
    await writeFile(
      store.filePath,
      `${JSON.stringify({ schemaVersion: 1, state: legacyState })}\n`,
      'utf8',
    );

    await expect(store.load()).resolves.toEqual({
      ...legacyState,
      taskNotificationLog: {},
    });
  });

  it('falls back to an empty scheduler state when both copies are unusable', async () => {
    const directory = await createDirectory();
    const store = new ReminderRuntimeStore(directory);
    await writeFile(store.filePath, '{broken', 'utf8');
    await writeFile(store.backupPath, '{also broken', 'utf8');

    expect(await store.load()).toBeUndefined();
  });

  it('rejects malformed runtime values before replacing the valid file', async () => {
    const directory = await createDirectory();
    const store = new ReminderRuntimeStore(directory);
    await store.save(emptyReminderRuntimeState());
    const previous = await readFile(store.filePath, 'utf8');

    await expect(
      store.save({
        ...emptyReminderRuntimeState(),
        dismissed: { invalid: -1 },
      }),
    ).rejects.toBeInstanceOf(ReminderRuntimeStoreValidationError);

    expect(await readFile(store.filePath, 'utf8')).toBe(previous);
  });
});
