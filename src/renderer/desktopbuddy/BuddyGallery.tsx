import { useEffect, useRef, useState } from 'react';
import { buddyPersonaLabels, type BuddyPreferences } from '../../shared/desktopbuddy-contract';
import { BuddyCharacter } from './BuddyCharacter';
import { acceptBuddySnapshot, useBuddySnapshot } from './store';
import { generateBuddyTheme } from './generate-theme';
import { supplementalBuddyActions } from './motion-curves';
import { agentModelDestination } from '../../shared/agent-model-config';
import { useAgentSettings } from '../use-agent-settings';

export function BuddyInteractions({ mini = false }: { mini?: boolean }) {
  const snapshot = useBuddySnapshot();
  const [notice, setNotice] = useState('');
  const theme = snapshot?.themes.find(t => t.manifest.id === snapshot.preferences.themeId);
  if (!theme || !window.desktopApi?.buddy) return null;
  return <div className={mini ? 'buddy-mini-interactions' : 'buddy-interactions'} aria-label="角色专属互动">
    {theme.manifest.interactions.map(interaction => <button type="button" key={interaction.id} onClick={() => {
      void window.desktopApi!.buddy!.interact(interaction.id).then(() => setNotice('')).catch(reason => setNotice(reason instanceof Error ? reason.message.replace(/^Error invoking remote method[^:]*: /u, '') : '互动暂不可用'));
    }}>{interaction.label}</button>)}
    {notice && <small role="status">{notice}</small>}
  </div>;
}

export function BuddyGallery({ onOpenAgentSettings }: { onOpenAgentSettings: () => void }) {
  const snapshot = useBuddySnapshot();
  const { settings: agentSettings, loadError } = useAgentSettings();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<{ imageDataUrl: string; name: string } | null>(null);
  const [actions, setActions] = useState<string[]>(['pet', 'jump-rope', 'task-carry']);
  const [progress, setProgress] = useState('');
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const api = window.desktopApi?.buddy;
  if (!api || !snapshot) return null;
  const preferences = snapshot.preferences;
  const theme = snapshot.themes.find(t => t.manifest.id === preferences.themeId);
  const perform = async (operation: () => Promise<unknown>, message?: string) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await operation(); if (message) setNotice(message); }
    catch (error) { setNotice(error instanceof Error ? error.message.replace(/^Error invoking remote method.*?: Error: /u, '') : '操作没有完成'); }
    finally { setBusy(false); }
  };
  const save = (patch: Partial<BuddyPreferences>) => perform(async () => acceptBuddySnapshot(await api.setPreferences(patch)));
  return <section className="buddy-gallery" aria-label="DesktopBuddy 伙伴与动画">
    <h2>选择你的桌面伙伴</h2>
    <p>DesktopBuddy 原版 Live2D 动画。眼神、呼吸、触摸和拖拽连续响应；换角色不改变任务与账号。</p>
    <div className="buddy-gallery-grid">
      {snapshot.themes.map(entry => <article key={entry.manifest.id}>
        <button type="button" className="buddy-theme-option" aria-pressed={entry.manifest.id === preferences.themeId} disabled={busy || !entry.ready || !entry.enabled}
          onClick={() => void save({ themeId: entry.manifest.id })} title={entry.issue ?? entry.manifest.description}>
          <span className="buddy-theme-swatches" aria-hidden="true">{entry.manifest.colors.swatches.map((color, i) => <i key={i} style={{ backgroundColor: /^#[\da-f]{3,8}$/iu.test(color) ? color : '#b6aec7' }} />)}</span>
          <strong>{entry.manifest.displayName}</strong>
          <small>{entry.manifest.renderer === 'live2d' ? 'Live2D 连续动作' : `${Object.keys(entry.manifest.model?.staticImages ?? {}).length} 帧图片主题`}</small>
          <small>{entry.issue ?? (!entry.enabled ? '已停用' : `${entry.manifest.interactions.length} 个专属互动`)}</small>
        </button>
        {entry.origin === 'user' && <div className="buddy-gallery-actions">
          <button type="button" disabled={busy} onClick={() => void perform(async () => acceptBuddySnapshot(await api.setEnabled(entry.manifest.id, !entry.enabled)))}>{entry.enabled ? '停用' : '启用'}</button>
          <button type="button" disabled={busy} onClick={() => void perform(async () => acceptBuddySnapshot(await api.removeTheme(entry.manifest.id)), '已移到本地 removed-themes 归档，可恢复；未删除原图片。')}>移除</button>
        </div>}
      </article>)}
    </div>
    {theme && <div className="buddy-gallery-stage">
      <BuddyCharacter themeId={theme.manifest.id} />
      <div className="buddy-gallery-stage-info"><strong>{theme.manifest.displayName}</strong><p>{theme.manifest.description}</p><BuddyInteractions /></div>
    </div>}
    <div className="buddy-gallery-preferences">
      {([
        ['gravity', '重力弹跳'], ['inertia', '惯性抛掷'], ['edgeSnap', '边缘弹簧吸附'],
        ['breathing', '呼吸浮动'], ['cursorFollow', '眼神跟随光标'], ['reducedMotion', '减少动态效果'],
      ] as const).map(([key, label]) => <label key={key}>{label}<input type="checkbox" checked={preferences[key]} disabled={busy} onChange={event => void save({ [key]: event.currentTarget.checked })} /></label>)}
      <label>陪伴人格<select aria-label="陪伴人格" value={preferences.persona} disabled={busy} onChange={event => void save({ persona: event.target.value as BuddyPreferences['persona'] })}>{Object.entries(buddyPersonaLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>记忆轮数<input type="number" aria-label="对话记忆轮数" min={4} max={50} step={1} key={preferences.memoryRounds} defaultValue={preferences.memoryRounds} onBlur={event => {
        const value = Number(event.currentTarget.value);
        if (Number.isInteger(value) && value >= 4 && value <= 50) void save({ memoryRounds: value });
        else { event.currentTarget.value = String(preferences.memoryRounds); setNotice('记忆轮数应为 4–50 的整数'); }
      }} /></label>
      <label>向模型发送最近对话<input type="checkbox" checked={agentSettings?.modelDataScope.chatHistory ?? false} disabled={busy || !agentSettings} onChange={event => {
        const enabled = event.currentTarget.checked;
        void perform(async () => {
          const settings = await window.desktopApi!.settings.get();
          await window.desktopApi!.settings.replace({ ...settings, modelDataScope: { ...settings.modelDataScope, chatHistory: enabled } });
        }, enabled ? '仅发送配置轮数内的最近对话；历史仍可在聊天中清除。' : '已关闭历史发送，下次请求只包含本次消息。');
      }} /></label>
    </div>
    <section className="buddy-agent-connection" aria-label="共用 Agent 模型配置">
      <strong>与 Agent 共用模型</strong>
      <p>对话、晨间简报、文件摘要和屏幕问答共用 Agent 的地址、认证、主副模型及用量限制，无需重复配置。</p>
      <small>{agentSettings ? `${agentSettings.ai.enabled ? 'Agent 已启用' : 'Agent 未启用'} · ${agentModelDestination(agentSettings)}` : loadError ? '暂时无法读取 Agent 配置，请在模型设置中检查。' : '正在读取 Agent 配置…'}</small>
      <button type="button" onClick={onOpenAgentSettings}>管理 Agent 模型配置</button>
    </section>
    <div className="buddy-gallery-actions">
      <button type="button" disabled={busy} onClick={() => void perform(async () => { const next = await api.importTheme(); if (next) acceptBuddySnapshot(next); })}>导入 DesktopBuddy 角色包</button>
      <button type="button" disabled={busy} onClick={() => void perform(async () => setSource(await api.chooseImage()))}>用一张图片生成动画</button>
    </div>
    {source && <div className="buddy-generation-panel">
      <img src={source.imageDataUrl} alt="待生成的角色原图" />
      <input type="text" aria-label="新角色名字" value={source.name} maxLength={40} onChange={event => setSource({ ...source, name: event.target.value })} disabled={busy} />
      <p>本地生成 1 张基准图和原版 33 张状态帧，可为下面的每个补充动作生成 33 帧。不会自动上传图片。这是连续图像运动，不会把静态图变成可独立操控肢体的 Live2D 模型。</p>
      <fieldset disabled={busy}><legend>补充动作</legend>{supplementalBuddyActions.map(([id, label]) => <label key={id}><input type="checkbox" checked={actions.includes(id)} onChange={event => setActions(current => event.target.checked ? [...current, id] : current.filter(action => action !== id))} />{label}</label>)}</fieldset>
      <div className="buddy-gallery-actions">
        <button type="button" className="buddy-generate-button" disabled={busy || !source.name.trim()} onClick={() => void perform(async () => {
          abort.current = new AbortController();
          const generated = await generateBuddyTheme(source.imageDataUrl, {
            subject: source.name.trim(), type: 'objectSpirit', characteristics: '用户提供的完整角色图片', dominantColor: '#7f79b2', secondaryColor: '#eeeeef',
          }, actions, (done, total) => setProgress(`${done} / ${total} 帧`), abort.current.signal);
          abort.current.signal.throwIfAborted();
          acceptBuddySnapshot(await api.generateTheme(generated));
          setSource(null); setProgress('');
        }, '新伙伴已生成并切换。')}>{busy ? `正在生成 ${progress}` : '生成并切换'}</button>
        <button type="button" onClick={() => { abort.current?.abort(); if (!busy) setSource(null); }}>取消</button>
      </div>
    </div>}
    {notice && <p className="buddy-notice" role="status">{notice}</p>}
    <p className="buddy-license-note">动画播放器来自 <a href="https://github.com/DCDingCong/desktopbuddy" target="_blank" rel="noreferrer">DesktopBuddy</a>。Live2D 原版角色 © Live2D Inc.，使用独立的样例数据与 SDK 条款；不应用旧版换色/服装以免改变原版设计。<a href="https://www.live2d.com/eula/live2d-sample-model-terms_en.html" target="_blank" rel="noreferrer">查看条款</a>。</p>
  </section>;
}
