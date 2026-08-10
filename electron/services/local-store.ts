import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  createEmptyLocalAppState,
  type LocalAppState,
} from '../../src/shared/models';

export interface LocalStoreOptions {
  directory: string;
  fileName?: string;
  defaultState?: () => LocalAppState;
}

export class LocalStoreCorruptionError extends Error {
  readonly causeDetails: unknown[];

  constructor(message: string, causeDetails: unknown[]) {
    super(message);
    this.name = 'LocalStoreCorruptionError';
    this.causeDetails = causeDetails;
  }
}

const cloneState = (state: LocalAppState): LocalAppState =>
  JSON.parse(JSON.stringify(state)) as LocalAppState;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseState = (text: string): LocalAppState => {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !isRecord(value.tasks) ||
    !isRecord(value.drafts) ||
    !Array.isArray(value.operations)
  ) {
    throw new TypeError('The local state file does not match schema version 1.');
  }
  return value as unknown as LocalAppState;
};

const isMissingFileError = (error: unknown): boolean =>
  isRecord(error) && error.code === 'ENOENT';

const syncDirectory = async (directory: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isRecord(error) ||
      !['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(String(error.code))
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
};

export class LocalStore {
  readonly directory: string;
  readonly filePath: string;
  readonly backupPath: string;

  private readonly defaultState: () => LocalAppState;
  private queue: Promise<void> = Promise.resolve();

  constructor(directoryOrOptions: string | LocalStoreOptions) {
    const options: LocalStoreOptions =
      typeof directoryOrOptions === 'string'
        ? { directory: directoryOrOptions }
        : directoryOrOptions;
    const fileName = options.fileName ?? 'state.json';
    if (
      fileName.length === 0 ||
      fileName === '.' ||
      fileName === '..' ||
      path.posix.basename(fileName) !== fileName ||
      path.win32.basename(fileName) !== fileName
    ) {
      throw new TypeError('LocalStore fileName must be a file name, not a path.');
    }
    this.directory = path.resolve(options.directory);
    this.filePath = path.join(this.directory, fileName);
    this.backupPath = path.join(this.directory, `${fileName}.backup`);
    this.defaultState = options.defaultState ?? createEmptyLocalAppState;
  }

  async initialize(): Promise<LocalAppState> {
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      try {
        return await this.loadUnsafe();
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
        const initial = this.defaultState();
        await this.saveUnsafe(initial, false);
        return cloneState(initial);
      }
    });
  }

  async load(): Promise<LocalAppState> {
    return this.enqueue(async () => {
      try {
        return await this.loadUnsafe();
      } catch (error) {
        if (isMissingFileError(error)) {
          return cloneState(this.defaultState());
        }
        throw error;
      }
    });
  }

  async read(): Promise<LocalAppState> {
    return this.load();
  }

  async save(state: LocalAppState): Promise<void> {
    await this.enqueue(() => this.saveUnsafe(cloneState(state), true));
  }

  async write(state: LocalAppState): Promise<void> {
    await this.save(state);
  }

  /**
   * Runs a serialized copy-on-write transaction. A thrown mutator leaves the
   * previous on-disk state untouched.
   */
  async transact<Result>(mutator: (draft: LocalAppState) => Result | Promise<Result>): Promise<Result> {
    return this.enqueue(async () => {
      let current: LocalAppState;
      try {
        current = await this.loadUnsafe();
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
        current = this.defaultState();
      }

      const draft = cloneState(current);
      const result = await mutator(draft);
      draft.schemaVersion = 1;
      draft.revision = current.revision + 1;
      await this.saveUnsafe(draft, true);
      return result;
    });
  }

  async update<Result>(mutator: (draft: LocalAppState) => Result | Promise<Result>): Promise<Result> {
    return this.transact(mutator);
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadUnsafe(): Promise<LocalAppState> {
    await mkdir(this.directory, { recursive: true });
    let mainError: unknown;
    try {
      const text = await readFile(this.filePath, 'utf8');
      return cloneState(parseState(text));
    } catch (error) {
      mainError = error;
      if (isMissingFileError(error)) {
        try {
          const backupText = await readFile(this.backupPath, 'utf8');
          const backup = parseState(backupText);
          await this.writeTextAtomically(this.filePath, backupText);
          return cloneState(backup);
        } catch (backupError) {
          if (isMissingFileError(backupError)) {
            throw mainError;
          }
          throw new LocalStoreCorruptionError(
            'The state file is missing and its backup is unreadable.',
            [mainError, backupError],
          );
        }
      }
    }

    try {
      const backupText = await readFile(this.backupPath, 'utf8');
      const backup = parseState(backupText);
      await this.writeTextAtomically(this.filePath, backupText);
      return cloneState(backup);
    } catch (backupError) {
      throw new LocalStoreCorruptionError(
        'Both the state file and its backup are unreadable.',
        [mainError, backupError],
      );
    }
  }

  private async saveUnsafe(state: LocalAppState, preservePrevious: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    // Validate before touching either file so a bad caller cannot replace the
    // last recoverable state with an unsupported schema.
    parseState(serialized);

    if (preservePrevious) {
      try {
        const previous = await readFile(this.filePath, 'utf8');
        parseState(previous);
        await this.writeTextAtomically(this.backupPath, previous);
      } catch (error) {
        if (!isMissingFileError(error) && !(error instanceof SyntaxError) && !(error instanceof TypeError)) {
          throw error;
        }
      }
    }

    await this.writeTextAtomically(this.filePath, serialized);
  }

  private async writeTextAtomically(targetPath: string, contents: string): Promise<void> {
    const temporaryPath = path.join(
      this.directory,
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
