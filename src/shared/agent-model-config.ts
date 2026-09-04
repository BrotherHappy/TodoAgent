import type { AppSettings } from './settings';

export type AgentProviderRole = 'primary' | 'fallback';
export type AgentProviderConfig = AppSettings['ai'] | AppSettings['ai']['fallback'];

/** All LLM entry points use AppSettings.ai; pet preferences never own a connection. */
export const activeAgentProviderRole = (settings: AppSettings): AgentProviderRole =>
  settings.ai.routing === 'local-only' ? 'fallback' : 'primary';

export const agentProviderFor = (
  settings: AppSettings,
  role: AgentProviderRole = activeAgentProviderRole(settings),
): AgentProviderConfig => role === 'primary' ? settings.ai : settings.ai.fallback;

/** Keep the API base path visible, but never display URL credentials or query secrets. */
export function agentEndpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '未配置有效地址';
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return '未配置有效地址';
  }
}

/** Describes configured destinations, not a claim that a credential or model is reachable. */
export function agentModelDestination(settings: AppSettings): string {
  const describe = (provider: AgentProviderConfig) =>
    `${provider.model.trim() || '未选择模型'} · ${agentEndpointLabel(provider.endpoint)}`;
  const destination = describe(agentProviderFor(settings));
  const fallback = settings.ai.fallback;
  if (settings.ai.routing !== 'fallback-on-error' || !fallback.enabled) return destination;
  return `${destination}（失败时可能转发到备用模型：${describe(fallback)}）`;
}
