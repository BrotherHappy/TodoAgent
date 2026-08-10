import { createReadStream, type Stats } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type {
  DataDesktopFilePort,
  DataFileInfo,
} from './data-desktop-controller';

const fileKind = (value: Stats): DataFileInfo['kind'] =>
  value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other';

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '')) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/** Bounded, durable Node filesystem implementation used by import/export. */
export class NodeDataDesktopFilePort implements DataDesktopFilePort {
  async stat(filePath: string): Promise<DataFileInfo> {
    const value = await stat(filePath);
    return { size: value.size, kind: fileKind(value) };
  }

  async readText(filePath: string, maxBytes: number): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be positive.');
    return new Promise<string>((resolve, reject) => {
      const stream = createReadStream(filePath, { highWaterMark: Math.min(64 * 1024, maxBytes + 1) });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(error);
      };
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = new Error('FILE_TOO_LARGE') as NodeJS.ErrnoException;
          error.code = 'EFBIG';
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, bytes).toString('utf8'));
      });
    });
  }

  async writeTextDurable(filePath: string, contents: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await syncDirectory(path.dirname(filePath));
  }

  async replaceFile(sourcePath: string, targetPath: string): Promise<void> {
    if (path.dirname(sourcePath) !== path.dirname(targetPath)) {
      throw new Error('SOURCE_AND_TARGET_MUST_SHARE_DIRECTORY');
    }
    await rename(sourcePath, targetPath);
    await syncDirectory(path.dirname(targetPath));
  }

  removeFile(filePath: string): Promise<void> {
    return unlink(filePath);
  }
}
