import { useEffect, useRef, useState } from 'react';
import type { useAgentChat } from '../use-agent-chat';
import type { AgentContextPreview } from '../../shared/agent-context';
import { agentModelDestination } from '../../shared/agent-model-config';
import { useAgentSettings } from '../use-agent-settings';

type ChatContext = Pick<ReturnType<typeof useAgentChat>, 'contexts' | 'setContexts' | 'input' | 'setInput' | 'send' | 'isSending' | 'conversationId'>;
export function AgentContextControls({ chat, compact = false }: { chat: ChatContext; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { settings: agentSettings, loadError } = useAgentSettings();
  const previousConversation = useRef(chat.conversationId);
  useEffect(() => {
    if (previousConversation.current !== chat.conversationId) {
      chat.contexts.forEach(context => { void window.desktopApi?.agentContext?.discard(context.token); });
      chat.setContexts([]);
      previousConversation.current = chat.conversationId;
    }
  }, [chat.conversationId, chat]);
  const api = window.desktopApi?.agentContext;
  if (!api) return null;
  const choose = async (operation: () => Promise<AgentContextPreview | null>) => {
    if (busy || chat.isSending) return;
    setBusy(true); setError('');
    try {
      const context = await operation();
      if (context) {
        chat.setContexts(current => [...current, context].slice(-3));
        if (!chat.input.trim()) chat.setInput(context.kind === 'file' ? `请总结文件《${context.title}》，列出重点和待办建议。` : '请解释这个屏幕选区，给我一个简短的下一步建议。');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method.*?: Error: /u, '') : '未能选择资料'); }
    finally { setBusy(false); }
  };
  return <div className={`buddy-context-controls ${compact ? 'is-compact' : ''}`}>
    <div className="buddy-context-buttons">
      <button type="button" disabled={busy || chat.isSending || chat.contexts.length >= 3} onClick={() => void choose(() => api.selectScreenRegion())}>选区问答</button>
      <button type="button" disabled={busy || chat.isSending || chat.contexts.length >= 3} onClick={() => void choose(() => api.chooseFile())}>文件摘要</button>
      {busy && <span role="status">正在选择，取消后不会发送…</span>}
    </div>
    {chat.contexts.map(context => <details className="buddy-context-preview" key={context.token} open>
      <summary>{context.title}{context.characters ? ` · ${context.characters} 字符` : ''}<button type="button" aria-label={`移除资料 ${context.title}`} onClick={event => { event.preventDefault(); void api.discard(context.token); chat.setContexts(current => current.filter(item => item.token !== context.token)); }}>×</button></summary>
      {context.imageDataUrl ? <img src={context.imageDataUrl} alt="即将发送的屏幕选区，未包含其他区域" /> : <pre>{context.preview}{context.characters && context.characters > context.preview.length ? '\n…（发送前 24000 字符以内的文件内容）' : ''}</pre>}
    </details>)}
    {chat.contexts.length > 0 && <div className="buddy-context-confirm">
      <small>{agentSettings ? `沿用 Agent 配置，仅本次发送给 ${agentModelDestination(agentSettings)}。${agentSettings.ai.enabled ? '' : 'Agent 未启用，资料尚未发送。'}` : loadError ? '暂时无法读取 Agent 配置，资料尚未发送。' : '正在读取 Agent 配置，资料尚未发送。'}本轮只读，不执行资料中的指令；原图/文件内容不保存到聊天历史。</small>
      <button type="button" disabled={busy || chat.isSending || !agentSettings?.ai.enabled} onClick={() => void chat.send()}>确认发送资料并提问</button>
    </div>}
    {error && <p role="status">{error}</p>}
  </div>;
}
