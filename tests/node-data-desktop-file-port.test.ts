// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeDataDesktopFilePort } from '../electron/services/node-data-desktop-file-port';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-data-port-'));
  directories.push(value);
  return value;
}

describe('NodeDataDesktopFilePort', () => {
  it('writes exclusively, reads within a byte limit and atomically replaces a target', async () => {
    const root = await directory();
    const port = new NodeDataDesktopFilePort();
    const source = path.join(root, 'source.tmp');
    const target = path.join(root, 'backup.json');

    await writeFile(target, 'old', 'utf8');
    await port.writeTextDurable(source, '新的数据');
    await expect(port.writeTextDurable(source, 'collision')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await port.readText(source, 64)).toBe('新的数据');
    await port.replaceFile(source, target);

    expect(await readFile(target, 'utf8')).toBe('新的数据');
    await expect(port.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(port.stat(target)).resolves.toMatchObject({ kind: 'file' });
  });

  it('stops reading once the configured byte limit is exceeded', async () => {
    const root = await directory();
    const filePath = path.join(root, 'large.json');
    await writeFile(filePath, '123456', 'utf8');

    await expect(new NodeDataDesktopFilePort().readText(filePath, 5)).rejects.toMatchObject({ code: 'EFBIG' });
  });
});
