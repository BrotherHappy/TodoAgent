import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), desktopCapturer: { getSources: vi.fn() }, dialog: {}, ipcMain: {}, screen: {} }));
import { AgentContextService, cropScreenRegion } from '../electron/agent/agent-context-service';
import { defaultSettings } from '../src/shared/settings';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), 'todo-context-unit-')); directories.push(root);
  const capabilities = { ...defaultSettings.agentCapabilities, filesAndTerminal: true, clipboardAndScreen: true };
  const service = new AgentContextService({ rendererPath: '/app/index.html', preloadPath: '/app/preload.cjs', capabilities: () => capabilities });
  const file = path.join(root, 'summary.md'); await writeFile(file, '# 本次资料\n请总结这份测试文档。');
  return { root, file, capabilities, service };
}
describe('explicit one-use screen/file context', () => {
  it('requires the same chat window and consumes each preview only once', async () => {
    const { service, file } = await harness();
    const preview = await service.readSelectedFile(file, 10);
    expect(preview).toMatchObject({ kind: 'file', title: 'summary.md' });
    expect(() => service.consume([preview.token], 11)).toThrow('不属于此窗口');
    expect(service.consume([preview.token], 10)[0]).toMatchObject({ kind: 'file', text: '# 本次资料\n请总结这份测试文档。' });
    expect(() => service.consume([preview.token], 10)).toThrow('过期');
  });
  it('expires previews and re-checks capability changes at send time', async () => {
    const { service, file, capabilities } = await harness();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const preview = await service.readSelectedFile(file, 10);
    capabilities.filesAndTerminal = false;
    expect(() => service.consume([preview.token], 10)).toThrow('文件能力已关闭');
    capabilities.filesAndTerminal = true;
    vi.spyOn(Date, 'now').mockReturnValue(now + 600_001);
    expect(() => service.consume([preview.token], 10)).toThrow('过期');
  });
  it('does not discard another window’s preview or partially consume invalid sets', async () => {
    const { service, file } = await harness();
    const preview = await service.readSelectedFile(file, 10);
    service.discard(preview.token, 11);
    expect(() => service.consume([preview.token, 'missing'], 10)).toThrow();
    expect(() => service.consume([preview.token, preview.token], 10)).toThrow('不同资料');
    expect(service.consume([preview.token], 10)).toHaveLength(1);
  });
  it('truncates long UTF-8 text honestly and rejects binary/oversized files', async () => {
    const { service, file, root } = await harness();
    await writeFile(file, '测'.repeat(30_000));
    const preview = await service.readSelectedFile(file, 10);
    expect(preview.preview.length).toBe(2400);
    expect(service.consume([preview.token], 10)[0]).toMatchObject({ text: `${'测'.repeat(24_000)}\n[文件较长，本次仅包含前 24000 字符]` });
    await writeFile(file, Buffer.from([0, 1, 2]));
    await expect(service.readSelectedFile(file, 10)).rejects.toThrow('UTF-8');
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await expect(service.readSelectedFile(file, 10)).rejects.toThrow('1MB');
    await expect(service.readSelectedFile(path.join(root, 'document.pdf'), 10)).rejects.toThrow('二进制');
  });
  it('maps retina selection coordinates without capturing adjacent areas', () => {
    expect(cropScreenRegion({ x: 100, y: 200, width: 400, height: 300 }, { width: 1440, height: 900 }, { width: 2880, height: 1800 })).toEqual({ x: 200, y: 400, width: 800, height: 600 });
    expect(() => cropScreenRegion({ x: 1300, y: 200, width: 400, height: 300 }, { width: 1440, height: 900 }, { width: 2880, height: 1800 })).toThrow('超出');
    expect(() => cropScreenRegion({ x: 0, y: 0, width: 24, height: 24 }, { width: 0, height: 0 }, { width: 100, height: 100 })).toThrow('无效');
  });
});
