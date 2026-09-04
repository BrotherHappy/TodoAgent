import { useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentContextControls } from '../src/renderer/desktopbuddy/AgentContextControls';
import { useAgentSettings } from '../src/renderer/use-agent-settings';
import { defaultSettings, type AppSettings } from '../src/shared/settings';
import type { AgentContextPreview } from '../src/shared/agent-context';

afterEach(() => { cleanup(); delete window.desktopApi; vi.restoreAllMocks(); });

function configured(model = 'shared-primary') {
  const settings = structuredClone(defaultSettings);
  settings.ai = { ...settings.ai, enabled: true, model, endpoint: 'https://model.test/proxy/v1', authMode: 'none' };
  return settings;
}

function installSettings(get = vi.fn(() => Promise.resolve(configured()))) {
  let onChange: ((settings: AppSettings) => void) | undefined;
  const unsubscribe = vi.fn();
  window.desktopApi = {
    settings: { get },
    events: { onSettingsChanged: (listener: typeof onChange) => { onChange = listener; return unsubscribe; } },
    agentContext: { chooseFile: vi.fn().mockResolvedValue(null), selectScreenRegion: vi.fn().mockResolvedValue(null), discard: vi.fn().mockResolvedValue(undefined) },
  } as unknown as NonNullable<Window['desktopApi']>;
  return { change: (settings: AppSettings) => onChange?.(settings), unsubscribe, get };
}

const preview: AgentContextPreview = {
  token: 'confirmed-file', kind: 'file', title: 'sample.md', preview: '仅本次发送的内容',
  expiresAt: '2026-09-01T00:00:00Z',
};
type ContextChat = ComponentProps<typeof AgentContextControls>['chat'];
function ContextHarness({ send }: { send: ContextChat['send'] }) {
  const [contexts, setContexts] = useState([preview]);
  const [input, setInput] = useState('总结这个文件');
  return <AgentContextControls chat={{ contexts, setContexts, input, setInput, send, isSending: false, conversationId: 'test' }} />;
}

describe('live shared Agent settings', () => {
  it('reads once and updates model, routing and history settings without remounting', async () => {
    const api = installSettings();
    const { result, unmount } = renderHook(() => useAgentSettings());
    await waitFor(() => expect(result.current.settings?.ai.model).toBe('shared-primary'));
    const updated = configured('new-shared-model');
    updated.ai.routing = 'local-only';
    updated.modelDataScope.chatHistory = true;
    act(() => api.change(updated));
    expect(result.current.settings).toBe(updated);
    expect(api.get).toHaveBeenCalledOnce();
    unmount();
    expect(api.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not overwrite a new event with a slow initial settings response', async () => {
    let resolve!: (settings: AppSettings) => void;
    const get = vi.fn(() => new Promise<AppSettings>(done => { resolve = done; }));
    const api = installSettings(get);
    const { result } = renderHook(() => useAgentSettings());
    act(() => api.change(configured('latest')));
    await act(async () => { resolve(configured('stale')); });
    expect(result.current.settings?.ai.model).toBe('latest');
    expect(result.current.loadError).toBe(false);
  });

  it('recovers from a settings read error when the user saves Agent settings', async () => {
    const api = installSettings(vi.fn().mockRejectedValue(new Error('unavailable')));
    const { result } = renderHook(() => useAgentSettings());
    await waitFor(() => expect(result.current.loadError).toBe(true));
    act(() => api.change(configured()));
    expect(result.current.loadError).toBe(false);
    expect(result.current.settings?.ai.model).toBe('shared-primary');
  });
});

describe('context confirmation uses the existing Agent connection', () => {
  it('updates both destinations while a file preview is open without sending automatically', async () => {
    const api = installSettings();
    const send = vi.fn().mockResolvedValue(undefined);
    render(<ContextHarness send={send} />);
    await waitFor(() => expect(screen.getByText(/沿用 Agent 配置/u)).toHaveTextContent('shared-primary · https://model.test/proxy/v1'));
    const updated = configured('new-primary');
    updated.ai.endpoint = 'https://user:secret@new.test/gateway/v1?token=private';
    updated.ai.routing = 'fallback-on-error';
    updated.ai.fallback = { ...updated.ai.fallback, enabled: true, model: 'backup', endpoint: 'http://backup.test:11434' };
    act(() => api.change(updated));
    const description = screen.getByText(/沿用 Agent 配置/u);
    expect(description).toHaveTextContent('new-primary · https://new.test/gateway/v1');
    expect(description).toHaveTextContent('备用模型：backup · http://backup.test:11434');
    expect(description).not.toHaveTextContent(/secret|private|shared-primary/u);
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发送资料并提问' }));
    expect(send).toHaveBeenCalledOnce();
  });

  it('blocks the preview confirmation while configuration is unavailable or Agent is disabled', async () => {
    const api = installSettings(vi.fn().mockRejectedValue(new Error('unavailable')));
    const send = vi.fn().mockResolvedValue(undefined);
    render(<ContextHarness send={send} />);
    await screen.findByText(/暂时无法读取 Agent 配置/u);
    const confirm = screen.getByRole('button', { name: '确认发送资料并提问' });
    expect(confirm).toBeDisabled();
    const disabled = configured(); disabled.ai.enabled = false;
    act(() => api.change(disabled));
    expect(screen.getByText(/沿用 Agent 配置/u)).toHaveTextContent('Agent 未启用，资料尚未发送');
    expect(confirm).toBeDisabled();
    act(() => api.change(configured()));
    expect(confirm).toBeEnabled();
    expect(send).not.toHaveBeenCalled();
  });

  it('reflects local-only routing and excludes the inactive primary destination', async () => {
    const initial = configured();
    initial.ai.routing = 'local-only';
    initial.ai.fallback.model = 'only-backup';
    installSettings(vi.fn().mockResolvedValue(initial));
    render(<ContextHarness send={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.getByText(/沿用 Agent 配置/u)).toHaveTextContent('only-backup · http://127.0.0.1:11434/v1'));
    expect(screen.getByText(/沿用 Agent 配置/u)).not.toHaveTextContent('shared-primary');
  });
});
