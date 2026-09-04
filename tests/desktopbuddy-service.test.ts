import { mkdtemp, rm, writeFile, symlink, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }) } }));
import { DesktopBuddyService, safeBuddyPath } from '../electron/services/desktopbuddy-service';
import { buddyZip } from './helpers/buddy-zip-fixture';
import { resolveBuddyBehavior } from '../src/renderer/desktopbuddy/behavior';
import type { PetBehaviorIntent } from '../src/shared/desktopbuddy';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function makeService() {
  const root = await mkdtemp(path.join(tmpdir(), 'todo-buddy-unit-')); temporary.push(root);
  const service = new DesktopBuddyService({ appPath: path.resolve(import.meta.dirname, '..'), userDataPath: root });
  await service.load();
  return { service, root };
}
describe('DesktopBuddy safe theme management', () => {
  it.each([
    { name: '../escape.png', contents: 'bad' },
    { name: 'link.png', contents: '/tmp/outside.png', unixMode: 0o120777 },
    { name: 'run.js', contents: 'alert(1)' },
    { name: 'large.png', contents: 'x', declaredSize: 100 * 1024 * 1024 },
  ])('rejects unsafe ZIP entry $name without installing or overwriting a theme', async entry => {
    const { service, root } = await makeService();
    const zip = path.join(root, 'hostile.zip'); await writeFile(zip, buddyZip([entry]));
    await expect(service.importZip(zip)).rejects.toThrow();
    expect(service.snapshot().themes).toHaveLength(5);
    expect(await readdir(service.userRoot)).toEqual([]);
  });
  it('generates, imports and archives a user theme with restart-safe enable/disable', async () => {
    const { service, root } = await makeService();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const frames = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`idle_${index}`, png]));
    const generated = await service.generate({ frames, analysis: { subject: '测试伙伴', type: 'animal', characteristics: '仅用于隔离测试', dominantColor: '#aaaaaa', secondaryColor: '#bbbbbb' } });
    const id = generated.preferences.themeId;
    expect(generated.themes.find(theme => theme.manifest.id === id)).toMatchObject({ ready: true, origin: 'user' });
    const folder = path.join(service.userRoot, id);
    const manifest = JSON.parse(await readFile(path.join(folder, 'theme.json'), 'utf8'));
    manifest.id = 'imported-fixture';
    const zip = path.join(root, 'valid.zip');
    await writeFile(zip, buddyZip([{ name: 'bundle/theme.json', contents: JSON.stringify(manifest) }, ...Object.keys(frames).map(key => ({ name: `bundle/${key}.png`, contents: Buffer.from(png.split(',')[1], 'base64') }))]));
    expect((await service.importZip(zip)).preferences.themeId).toBe('imported-fixture');
    await expect(service.importZip(zip)).rejects.toThrow('已存在');
    expect((await service.setEnabled('imported-fixture', false)).preferences.themeId).toBe('wanko-live2d');
    await service.setEnabled('imported-fixture', true);
    await service.setPreferences({ themeId: 'imported-fixture' });
    const reopened = new DesktopBuddyService({ appPath: path.resolve(import.meta.dirname, '..'), userDataPath: root }); await reopened.load();
    expect(reopened.preferences().themeId).toBe('imported-fixture');
    await reopened.remove('imported-fixture');
    expect(reopened.snapshot().themes.some(theme => theme.manifest.id === 'imported-fixture')).toBe(false);
    expect((await readdir(path.join(root, 'pet', 'removed-themes')))[0]).toMatch(/^imported-fixture-/u);
  });
  it('loads all five original character manifests and every referenced asset', async () => {
    const { service } = await makeService();
    expect(service.snapshot().themes).toHaveLength(5);
    expect(service.snapshot().themes.every(theme => theme.ready)).toBe(true);
    expect(service.preferences().themeId).toBe('wanko-live2d');
    for (const theme of service.snapshot().themes) {
      await service.setPreferences({ themeId: theme.manifest.id });
      const assets = service.assets(theme.manifest.id);
      const model = JSON.parse((await readFile(await service.resolveAsset(assets.modelUrl!), 'utf8')).replace(/^\uFEFF/u, ''));
      for (const interaction of theme.manifest.interactions) {
        expect(service.interact(interaction.id)).toMatchObject({ themeId: theme.manifest.id, behavior: interaction.behavior });
        const [behavior, variant] = interaction.behavior.split('.');
        const resolved = resolveBuddyBehavior(theme.manifest, { behavior, variant } as PetBehaviorIntent);
        expect(model.FileReferences.Motions[resolved.motion!]?.length, `${theme.manifest.id}:${interaction.id} resolves to an authored motion`).toBeGreaterThan(0);
      }
    }
  });
  it.each(['../private.json', '/tmp/private', 'C:\\private', 'https://evil.test/image.png', 'a/../../private', ''])('rejects unsafe resource %s', value => {
    expect(() => safeBuddyPath('/tmp/safe-theme', value)).toThrow();
  });
  it('only executes the bundled Core and rejects symlink escapes', async () => {
    const { service, root } = await makeService();
    const outside = path.join(root, 'private.png'); await writeFile(outside, 'private');
    await symlink(outside, path.join(service.userRoot, 'escape.png'));
    await expect(service.resolveAsset('pet-asset://user/escape.png')).rejects.toThrow();
    await expect(service.resolveAsset('pet-asset://user/live2dcubismcore.min.js')).rejects.toThrow();
    await expect(service.resolveAsset('pet-asset://builtin/live2d-presets/wanko/live2dcubismcore.min.js')).resolves.toContain('wanko');
  });
  it('persists persona, memory and theme without touching task settings', async () => {
    const { service, root } = await makeService();
    await service.setPreferences({ themeId: 'mark-live2d', persona: 'efficient', memoryRounds: 50 });
    const reopened = new DesktopBuddyService({ appPath: path.resolve(import.meta.dirname, '..'), userDataPath: root }); await reopened.load();
    expect(reopened.preferences()).toMatchObject({ themeId: 'mark-live2d', persona: 'efficient', memoryRounds: 50 });
    await expect(service.setPreferences({ memoryRounds: 51 })).rejects.toThrow();
    await expect(service.remove('wanko-live2d')).rejects.toThrow();
  });
});
