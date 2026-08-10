// @vitest-environment node

import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FeishuApplicationSyncState } from '../electron/feishu/feishu-sync-service';
import {
  FeishuStateStore,
  FeishuStateStoreCorruptionError,
} from '../electron/feishu/feishu-state-store';

function state(cursor: string): FeishuApplicationSyncState {
  const base = {
    title: 'Public task',
    notes: 'Public notes',
    status: 'open' as const,
  };
  return {
    schemaVersion: 1,
    accountId: 'account-1',
    mappingsByLocalId: {
      'local-1': {
        localId: 'local-1',
        guid: 'remote-1',
        base,
        remoteVersion: 'version-1',
      },
    },
    localIdByGuid: { 'remote-1': 'local-1' },
    queue: [
      {
        id: 'queue-1',
        localId: 'local-1',
        kind: 'update',
        createdAt: '2026-08-09T00:00:00.000Z',
        attempts: 0,
      },
    ],
    conflicts: {},
    cursor,
    lastFullSyncAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('FeishuStateStore', () => {
  it('round-trips all-day snapshot metadata and rejects a dangling flag', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-state-all-day-'));
    const store = new FeishuStateStore(directory);
    const value = state('cursor-all-day');
    value.mappingsByLocalId['local-1']!.base = {
      ...value.mappingsByLocalId['local-1']!.base,
      startAt: '2026-08-10T00:00:00.000Z',
      startAtIsAllDay: true,
      dueAt: '2026-08-11T00:00:00.000Z',
      dueAtIsAllDay: true,
    };
    await store.save(value);
    await expect(store.load()).resolves.toMatchObject({
      mappingsByLocalId: {
        'local-1': {
          base: {
            startAtIsAllDay: true,
            dueAtIsAllDay: true,
          },
        },
      },
    });

    const invalid = state('cursor-invalid-all-day');
    invalid.mappingsByLocalId['local-1']!.base = {
      ...invalid.mappingsByLocalId['local-1']!.base,
      startAtIsAllDay: true,
    };
    await expect(store.save(invalid)).rejects.toThrow(
      'startAtIsAllDay requires startAt',
    );
  });

  it('atomically rotates a backup and recovers a corrupt primary', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-state-'));
    const store = new FeishuStateStore(directory);
    await store.save(state('cursor-old'));
    await store.save(state('cursor-new'));

    expect(
      JSON.parse(await readFile(store.filePath, 'utf8')) as { cursor: string },
    ).toMatchObject({ cursor: 'cursor-new' });
    expect(
      JSON.parse(await readFile(store.backupPath, 'utf8')) as { cursor: string },
    ).toMatchObject({ cursor: 'cursor-old' });
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    );

    await writeFile(store.filePath, '{ definitely-not-json', 'utf8');
    const reloaded = new FeishuStateStore(directory);
    await expect(reloaded.load()).resolves.toMatchObject({ cursor: 'cursor-old' });
    expect(
      JSON.parse(await readFile(store.filePath, 'utf8')) as { cursor: string },
    ).toMatchObject({ cursor: 'cursor-old' });
  });

  it('serializes concurrent saves and strips unknown credential material', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-state-safe-'));
    const store = new FeishuStateStore(directory);
    const unsafe = state('cursor-1') as FeishuApplicationSyncState & {
      accessToken: string;
      appSecret: string;
      codeVerifier: string;
    };
    unsafe.accessToken = 'ACCESS_TOKEN_MUST_NOT_PERSIST';
    unsafe.appSecret = 'APP_SECRET_MUST_NOT_PERSIST';
    unsafe.codeVerifier = 'PKCE_VERIFIER_MUST_NOT_PERSIST';

    await store.save(unsafe);
    const raw = await readFile(store.filePath, 'utf8');
    expect(raw).not.toContain('ACCESS_TOKEN_MUST_NOT_PERSIST');
    expect(raw).not.toContain('APP_SECRET_MUST_NOT_PERSIST');
    expect(raw).not.toContain('PKCE_VERIFIER_MUST_NOT_PERSIST');
    expect(JSON.parse(raw)).not.toHaveProperty('accessToken');

    await Promise.all([
      store.save(state('cursor-2')),
      store.save(state('cursor-3')),
      store.save(state('cursor-4')),
    ]);
    await expect(store.load()).resolves.toMatchObject({ cursor: 'cursor-4' });
  });

  it('persists canonical member bases and member conflicts without weakening old-state compatibility', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-state-members-'));
    const store = new FeishuStateStore(directory);
    const value = state('cursor-members');
    value.mappingsByLocalId['local-1'].base.assigneeIds = [
      'ou_z',
      'ou_a',
      'ou_z',
    ];
    value.mappingsByLocalId['local-1'].base.followerIds = ['ou_watch'];
    value.conflicts['local-1'] = {
      localId: 'local-1',
      guid: 'remote-1',
      base: {
        title: 'Public task',
        notes: 'Public notes',
        status: 'open',
        assigneeIds: ['ou_a'],
        followerIds: [],
      },
      local: {
        title: 'Public task',
        notes: 'Public notes',
        status: 'open',
        assigneeIds: ['ou_local'],
        followerIds: [],
      },
      remote: {
        title: 'Public task',
        notes: 'Public notes',
        status: 'open',
        assigneeIds: ['ou_remote'],
        followerIds: [],
      },
      fields: [
        {
          field: 'assigneeIds',
          base: ['ou_a'],
          local: ['ou_local'],
          remote: ['ou_remote'],
        },
      ],
      detectedAt: '2026-08-09T00:00:00.000Z',
    };

    await store.save(value);
    await expect(store.load()).resolves.toMatchObject({
      mappingsByLocalId: {
        'local-1': {
          base: {
            assigneeIds: ['ou_a', 'ou_z'],
            followerIds: ['ou_watch'],
          },
        },
      },
      conflicts: {
        'local-1': {
          fields: [
            {
              field: 'assigneeIds',
              base: ['ou_a'],
              local: ['ou_local'],
              remote: ['ou_remote'],
            },
          ],
        },
      },
    });
  });

  it('round-trips explicit tasklist bindings and rejects a dangling section binding', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-state-tasklist-'));
    const store = new FeishuStateStore(directory);
    const value = state('cursor-tasklist');
    value.mappingsByLocalId['local-1']!.base = {
      ...value.mappingsByLocalId['local-1']!.base,
      tasklist: { tasklistGuid: 'tasklist-base', sectionGuid: 'section-base' },
    };
    value.conflicts['local-1'] = {
      localId: 'local-1',
      guid: 'remote-1',
      base: {
        title: 'Public task',
        notes: 'Public notes',
        status: 'open',
        tasklist: { tasklistGuid: 'tasklist-base' },
      },
      local: {
        title: 'Public task',
        notes: 'Public notes',
        status: 'open',
        tasklist: { tasklistGuid: 'tasklist-local' },
      },
      remote: {
        title: 'Public task',
        notes: 'Public notes',
        status: 'open',
        tasklist: { tasklistGuid: 'tasklist-remote' },
      },
      fields: [
        {
          field: 'tasklist',
          base: { tasklistGuid: 'tasklist-base' },
          local: { tasklistGuid: 'tasklist-local' },
          remote: { tasklistGuid: 'tasklist-remote' },
        },
      ],
      detectedAt: '2026-08-09T00:00:00.000Z',
    };

    await store.save(value);
    await expect(store.load()).resolves.toMatchObject({
      mappingsByLocalId: {
        'local-1': {
          base: {
            tasklist: {
              tasklistGuid: 'tasklist-base',
              sectionGuid: 'section-base',
            },
          },
        },
      },
      conflicts: {
        'local-1': {
          fields: [
            {
              field: 'tasklist',
              local: { tasklistGuid: 'tasklist-local' },
              remote: { tasklistGuid: 'tasklist-remote' },
            },
          ],
        },
      },
    });

    const invalid = state('cursor-invalid-tasklist') as FeishuApplicationSyncState;
    invalid.mappingsByLocalId['local-1']!.base = {
      ...invalid.mappingsByLocalId['local-1']!.base,
      tasklist: { sectionGuid: 'section-without-tasklist' },
    };
    await expect(store.save(invalid)).rejects.toThrow(
      'sectionGuid requires tasklistGuid',
    );
  });

  it('reports corruption when neither primary nor backup is usable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-state-bad-'));
    const store = new FeishuStateStore(directory);
    await store.save(state('cursor-1'));
    await store.save(state('cursor-2'));
    await writeFile(store.filePath, 'bad primary', 'utf8');
    await writeFile(store.backupPath, 'bad backup', 'utf8');

    await expect(new FeishuStateStore(directory).load()).rejects.toBeInstanceOf(
      FeishuStateStoreCorruptionError,
    );
  });
});
