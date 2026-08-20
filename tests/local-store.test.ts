import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore } from '../electron/services/local-store';

const testDirectories: string[] = [];

const createTestDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'todo-agent-local-store-'));
  testDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('LocalStore', () => {
  it('initializes a versioned state file in an injectable directory', async () => {
    const directory = await createTestDirectory();
    const store = new LocalStore({ directory, fileName: 'custom-state.json' });

    const state = await store.initialize();

    expect(state).toEqual({
      schemaVersion: 1,
      revision: 0,
      tasks: {},
      projects: {},
      lists: {},
      drafts: {},
      operations: [],
    });
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual(state);
  });

  it('serializes concurrent transactions without losing updates', async () => {
    const directory = await createTestDirectory();
    const store = new LocalStore(directory);
    await store.initialize();

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.transact(async (state) => {
          await Promise.resolve();
          const timestamp = `2026-08-09T00:00:${String(index).padStart(2, '0')}.000Z`;
          state.drafts[`draft-${index}`] = {
            id: `draft-${index}`,
            kind: 'quick-capture',
            text: `draft ${index}`,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
        }),
      ),
    );

    const state = await store.load();
    expect(state.revision).toBe(20);
    expect(Object.keys(state.drafts)).toHaveLength(20);
  });

  it('migrates a legacy state file without project entities', async () => {
    const directory = await createTestDirectory();
    const store = new LocalStore(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      store.filePath,
      JSON.stringify({ schemaVersion: 1, revision: 4, tasks: {}, drafts: {}, operations: [] }),
      'utf8',
    );
    await expect(store.load()).resolves.toMatchObject({ revision: 4, projects: {} });
  });

  it('does not commit mutations when a transaction throws', async () => {
    const directory = await createTestDirectory();
    const store = new LocalStore(directory);
    await store.initialize();

    await expect(
      store.transact((state) => {
        state.revision = 999;
        state.drafts.bad = {
          id: 'bad',
          kind: 'task-editor',
          text: 'must not persist',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
        };
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');

    expect(await store.load()).toMatchObject({ revision: 0, drafts: {} });
  });

  it('keeps the previous valid version and recovers from a corrupt main file', async () => {
    const directory = await createTestDirectory();
    const store = new LocalStore(directory);
    await store.initialize();
    await store.transact((state) => {
      state.drafts.first = {
        id: 'first',
        kind: 'agent',
        text: 'recover me',
        createdAt: '2026-08-09T01:00:00.000Z',
        updatedAt: '2026-08-09T01:00:00.000Z',
      };
    });
    await store.transact((state) => {
      state.drafts.second = {
        id: 'second',
        kind: 'agent',
        text: 'latest version',
        createdAt: '2026-08-09T02:00:00.000Z',
        updatedAt: '2026-08-09T02:00:00.000Z',
      };
    });

    const backup = JSON.parse(await readFile(store.backupPath, 'utf8')) as {
      revision: number;
    };
    expect(backup.revision).toBe(1);
    await writeFile(store.filePath, '{not valid json', 'utf8');

    const recovered = await store.load();
    expect(recovered.revision).toBe(1);
    expect(recovered.drafts.first?.text).toBe('recover me');
    expect(recovered.drafts.second).toBeUndefined();
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual(recovered);
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
