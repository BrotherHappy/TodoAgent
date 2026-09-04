import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/shared/settings';
import {
  activeAgentProviderRole, agentEndpointLabel, agentModelDestination, agentProviderFor,
} from '../src/shared/agent-model-config';

describe('shared Agent model configuration', () => {
  it.each([
    ['primary-only', 'primary'],
    ['fallback-on-error', 'primary'],
    ['local-only', 'fallback'],
  ] as const)('selects the canonical provider for %s without copying its settings', (routing, role) => {
    const settings = structuredClone(defaultSettings);
    settings.ai.routing = routing;
    expect(activeAgentProviderRole(settings)).toBe(role);
    expect(agentProviderFor(settings)).toBe(role === 'primary' ? settings.ai : settings.ai.fallback);
    expect(agentProviderFor(settings, 'fallback')).toBe(settings.ai.fallback);
  });

  it('shows the actual API base path without exposing credentials, query or fragment', () => {
    expect(agentEndpointLabel('https://user:private@example.test/gateway/v1/?key=private#secret'))
      .toBe('https://example.test/gateway/v1');
    expect(agentEndpointLabel('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
  });

  it.each(['', 'not-a-url', 'file:///private/secret', 'javascript:alert(1)'])('handles invalid destination %s without throwing', endpoint => {
    expect(agentEndpointLabel(endpoint)).toBe('未配置有效地址');
  });

  it('lists both configured destinations only when automatic fallback is enabled', () => {
    const settings = structuredClone(defaultSettings);
    settings.ai.model = 'main-model';
    settings.ai.endpoint = 'https://main.test/proxy/v1';
    settings.ai.fallback = { ...settings.ai.fallback, enabled: true, model: 'backup-model', endpoint: 'https://backup.test/v1' };
    expect(agentModelDestination(settings)).toBe('main-model · https://main.test/proxy/v1');
    settings.ai.routing = 'fallback-on-error';
    expect(agentModelDestination(settings)).toContain('备用模型：backup-model · https://backup.test/v1');
    settings.ai.fallback.enabled = false;
    expect(agentModelDestination(settings)).not.toContain('备用');
    settings.ai.routing = 'local-only';
    expect(agentModelDestination(settings)).toBe('backup-model · https://backup.test/v1');
  });

  it('does not mistake the default endpoint for a configured model', () => {
    expect(agentModelDestination(defaultSettings)).toContain('未选择模型');
  });
});
