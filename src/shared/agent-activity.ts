import type { ExternalAgentId } from './settings';

/**
 * A deliberately small, redacted vocabulary shared by external Agent hooks
 * and the renderer.  The bridge never accepts prompts, tool arguments, file
 * contents, or credentials; it only mirrors posture and a few display-safe
 * labels.
 */
export type ExternalAgentState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'juggling'
  | 'error'
  | 'attention'
  | 'notification'
  | 'sweeping'
  | 'carrying'
  | 'sleeping';

export interface ExternalAgentActivityEvent {
  version: 1;
  agentId: ExternalAgentId;
  /** A display label; it is bounded and never used for execution. */
  agentName: string;
  sessionId: string;
  state: ExternalAgentState;
  event: string;
  timestamp: string;
  sequence?: number;
  sessionTitle?: string;
  workspace?: string;
  toolName?: string;
  model?: string;
  provider?: string;
  subagentCount?: number;
  /** True for a terminal event that removes the session from the snapshot. */
  terminal?: boolean;
}

export interface AgentActivitySessionView {
  agentId: ExternalAgentId;
  agentName: string;
  sessionId: string;
  state: ExternalAgentState;
  event: string;
  lastEventAt: string;
  sessionTitle?: string;
  workspace?: string;
  toolName?: string;
  model?: string;
  provider?: string;
  subagentCount: number;
}

export interface AgentActivitySnapshot {
  version: 1;
  state: ExternalAgentState;
  agentId?: ExternalAgentId;
  agentName?: string;
  sessionId?: string;
  sessionTitle?: string;
  workspace?: string;
  toolName?: string;
  model?: string;
  provider?: string;
  activeSessionCount: number;
  liveSubagentCount: number;
  lastEventAt?: string;
  sessions: AgentActivitySessionView[];
}

export interface AgentActivityStatus {
  enabled: boolean;
  running: boolean;
  port?: number;
  endpoint?: string;
  tokenAvailable: boolean;
  runtimePath: string;
  activeSessions: number;
  state: ExternalAgentState;
  lastEventAt?: string;
}

export interface AgentActivitySetup {
  endpoint: string;
  port: number;
  token: string;
  runtimePath: string;
  tokenPath: string;
  agents: ExternalAgentId[];
  example: string;
}

export interface NormalizedExternalAgentActivity {
  event: ExternalAgentActivityEvent;
  acceptedAgentId: ExternalAgentId;
}

const MAX_SESSION_ID = 180;
const MAX_LABEL = 120;
const MAX_WORKSPACE = 160;
const MAX_TOOL_NAME = 120;
const MAX_MODEL = 120;
const MAX_PROVIDER = 80;

const externalAgentAliases: Record<string, ExternalAgentId> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  'claude_code': 'claude-code',
  codex: 'codex',
  'codex-cli': 'codex',
  copilot: 'copilot-cli',
  'copilot-cli': 'copilot-cli',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  antigravity: 'antigravity-cli',
  'antigravity-cli': 'antigravity-cli',
  agy: 'antigravity-cli',
  cursor: 'cursor-agent',
  'cursor-agent': 'cursor-agent',
  codebuddy: 'codebuddy',
  workbuddy: 'workbuddy',
  kiro: 'kiro-cli',
  'kiro-cli': 'kiro-cli',
  kimi: 'kimi-cli',
  'kimi-cli': 'kimi-cli',
  qwen: 'qwen-code',
  'qwen-code': 'qwen-code',
  zcode: 'zcode',
  codewhale: 'codewhale',
  openclaw: 'openclaw',
  hermes: 'hermes',
  opencode: 'opencode',
  mimocode: 'mimocode',
  'mimo-code': 'mimocode',
  pi: 'pi',
  qoder: 'qoder',
  qoderwork: 'qoderwork',
  qwenwork: 'qwenwork',
  'qwen-work': 'qwenwork',
  reasonix: 'reasonix-cli',
  'reasonix-cli': 'reasonix-cli',
  traecode: 'traecode',
  'trae-code': 'traecode',
  'deepseek-harness': 'deepseek-harness',
  deepseek: 'deepseek-harness',
};

export const externalAgentDisplayNames: Record<ExternalAgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  'copilot-cli': 'Copilot CLI',
  'gemini-cli': 'Gemini CLI',
  'antigravity-cli': 'Antigravity',
  'cursor-agent': 'Cursor Agent',
  codebuddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  'kiro-cli': 'Kiro CLI',
  'kimi-cli': 'Kimi Code',
  'qwen-code': 'Qwen Code',
  zcode: 'ZCode',
  codewhale: 'CodeWhale',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  opencode: 'opencode',
  mimocode: 'MiMo Code',
  pi: 'Pi',
  qoder: 'Qoder',
  qoderwork: 'QoderWork',
  qwenwork: 'QwenWork',
  'reasonix-cli': 'Reasonix CLI',
  traecode: 'TraeCode',
  'deepseek-harness': 'DeepSeek Harness',
  custom: '自定义 Agent',
};

const stateNames = new Set<ExternalAgentState>([
  'idle',
  'thinking',
  'working',
  'juggling',
  'error',
  'attention',
  'notification',
  'sweeping',
  'carrying',
  'sleeping',
]);

const eventStateMap: Record<string, ExternalAgentState> = {
  sessionstart: 'idle',
  session_start: 'idle',
  userpromptsubmit: 'thinking',
  user_prompt_submit: 'thinking',
  pretooluse: 'working',
  pre_tool_use: 'working',
  posttooluse: 'working',
  post_tool_use: 'working',
  subagentstart: 'juggling',
  subagent_start: 'juggling',
  posttoolusefailure: 'error',
  post_tool_use_failure: 'error',
  stop: 'attention',
  permissionrequest: 'notification',
  permission_request: 'notification',
  precompact: 'sweeping',
  pre_compact: 'sweeping',
  postcompact: 'attention',
  post_compact: 'attention',
  worktreecreate: 'carrying',
  worktree_create: 'carrying',
  sessionend: 'sleeping',
  session_end: 'sleeping',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, maximum) || undefined;
}

function workspaceLabel(value: string | undefined): string | undefined {
  const cleaned = bounded(value, MAX_WORKSPACE);
  if (!cleaned) return undefined;
  // Keep only a human-readable tail. Full paths are unnecessarily sensitive
  // and make the activity feed noisy across machines.
  const pieces = cleaned.split(/[\\/]+/u).filter(Boolean);
  return pieces.slice(-2).join(' / ').slice(0, MAX_WORKSPACE) || undefined;
}

function numberWithin(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizedEventName(value: string | undefined): string {
  return (value ?? 'state').trim().replace(/[-\s]+/gu, '_').toLowerCase();
}

function normalizedState(value: string | undefined): ExternalAgentState | undefined {
  if (!value) return undefined;
  const candidate = value.trim().replace(/[-\s]+/gu, '_').toLowerCase();
  return stateNames.has(candidate as ExternalAgentState)
    ? candidate as ExternalAgentState
    : undefined;
}

function normalizedAgentId(value: string | undefined): { id: ExternalAgentId; label: string } | undefined {
  const raw = bounded(value, MAX_LABEL);
  if (!raw) return undefined;
  const key = raw.toLowerCase().replace(/[\s_]+/gu, '-');
  const id = externalAgentAliases[key] ?? 'custom';
  return { id, label: raw };
}

function normalizeTimestamp(value: string | undefined, now: number): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > now + 5 * 60_000) {
    return new Date(now).toISOString();
  }
  return new Date(parsed).toISOString();
}

/**
 * Normalize both Todo Agent's camelCase shape and the clawd-on-desk
 * snake_case hook shape. Invalid or over-sized payloads are rejected rather
 * than partially accepted, which keeps the local bridge predictable.
 */
export function normalizeExternalAgentActivity(
  value: unknown,
  now = Date.now(),
): NormalizedExternalAgentActivity | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const agent = normalizedAgentId(firstString(source, 'agent_id', 'agentId', 'agent', 'provider'));
  const sessionId = bounded(firstString(source, 'session_id', 'sessionId'), MAX_SESSION_ID);
  if (!agent || !sessionId) return undefined;

  const event = bounded(firstString(source, 'event', 'event_name', 'eventName'), MAX_LABEL) ?? 'state';
  const eventKey = normalizedEventName(event);
  const state = normalizedState(firstString(source, 'state', 'status')) ?? eventStateMap[eventKey];
  if (!state) return undefined;
  // `sleeping` is a live posture in clawd-style adapters, not a lifecycle
  // close. Only an explicit SessionEnd (or terminal flag) retires a session.
  const terminal = source.terminal === true || eventKey === 'sessionend' || eventKey === 'session_end';
  const sequence = numberWithin(source.sequence ?? source.seq, 0, 2_147_483_647);
  const subagentCount = numberWithin(
    source.subagent_count ?? source.subagentCount ?? source.live_subagent_count,
    0,
    64,
  );
  return {
    acceptedAgentId: agent.id,
    event: {
      version: 1,
      agentId: agent.id,
      agentName: agent.id === 'custom' ? agent.label : externalAgentDisplayNames[agent.id],
      sessionId,
      state,
      event,
      timestamp: normalizeTimestamp(firstString(source, 'timestamp', 'at', 'created_at', 'createdAt'), now),
      sequence,
      sessionTitle: bounded(firstString(source, 'session_title', 'sessionTitle', 'title'), MAX_LABEL),
      workspace: workspaceLabel(firstString(source, 'cwd', 'workspace', 'workdir')),
      toolName: bounded(firstString(source, 'tool_name', 'toolName'), MAX_TOOL_NAME),
      model: bounded(firstString(source, 'model', 'model_name', 'modelName'), MAX_MODEL),
      provider: bounded(firstString(source, 'provider', 'provider_name', 'providerName'), MAX_PROVIDER),
      subagentCount,
      terminal,
    },
  };
}

interface StoredSession extends AgentActivitySessionView {
  sequence?: number;
}

const statePriority: Record<ExternalAgentState, number> = {
  idle: 10,
  sleeping: 5,
  attention: 42,
  carrying: 45,
  sweeping: 50,
  thinking: 60,
  working: 70,
  juggling: 80,
  error: 90,
  notification: 100,
};

export interface AgentActivityStoreOptions {
  staleAfterMs?: number;
  maxSessions?: number;
  now?: () => number;
}

/** In-memory, bounded activity state; no activity history is persisted. */
export class AgentActivityStore {
  readonly #sessions = new Map<string, StoredSession>();
  #staleAfterMs: number;
  readonly #maxSessions: number;
  readonly #now: () => number;

  constructor(options: AgentActivityStoreOptions = {}) {
    this.#staleAfterMs = Math.min(3_600_000, Math.max(15_000, options.staleAfterMs ?? 120_000));
    this.#maxSessions = Math.min(128, Math.max(1, options.maxSessions ?? 32));
    this.#now = options.now ?? Date.now;
  }

  ingest(value: unknown): { event?: ExternalAgentActivityEvent; snapshot: AgentActivitySnapshot } {
    const normalized = normalizeExternalAgentActivity(value, this.#now());
    if (!normalized) return { snapshot: this.snapshot() };
    const event = normalized.event;
    const key = `${event.agentId}:${event.sessionId}`;
    this.prune();
    const previous = this.#sessions.get(key);
    if (previous?.sequence !== undefined && event.sequence !== undefined && event.sequence <= previous.sequence) {
      return { snapshot: this.snapshot() };
    }
    if (event.terminal) {
      this.#sessions.delete(key);
      return { event, snapshot: this.snapshot() };
    }
    const session: StoredSession = {
      agentId: event.agentId,
      agentName: event.agentName,
      sessionId: event.sessionId,
      state: event.state,
      event: event.event,
      lastEventAt: event.timestamp,
      sessionTitle: event.sessionTitle ?? previous?.sessionTitle,
      workspace: event.workspace ?? previous?.workspace,
      toolName: event.toolName ?? previous?.toolName,
      model: event.model ?? previous?.model,
      provider: event.provider ?? previous?.provider,
      subagentCount: event.subagentCount ?? previous?.subagentCount ?? 0,
      sequence: event.sequence,
    };
    this.#sessions.set(key, session);
    while (this.#sessions.size > this.#maxSessions) {
      const oldest = [...this.#sessions.entries()]
        .sort((left, right) => Date.parse(left[1].lastEventAt) - Date.parse(right[1].lastEventAt))[0];
      if (!oldest) break;
      this.#sessions.delete(oldest[0]);
    }
    return { event, snapshot: this.snapshot() };
  }

  prune(): void {
    const cutoff = this.#now() - this.#staleAfterMs;
    for (const [key, session] of this.#sessions) {
      if (Date.parse(session.lastEventAt) < cutoff) this.#sessions.delete(key);
    }
  }

  setStaleAfterMs(value: number): void {
    if (!Number.isFinite(value)) return;
    this.#staleAfterMs = Math.min(3_600_000, Math.max(15_000, value));
  }

  clear(): void {
    this.#sessions.clear();
  }

  snapshot(): AgentActivitySnapshot {
    this.prune();
    const sessions = [...this.#sessions.values()]
      .sort((left, right) => Date.parse(right.lastEventAt) - Date.parse(left.lastEventAt))
      .map(({ sequence: _sequence, ...session }) => session);
    const winner = sessions
      .slice()
      .sort((left, right) => {
        const priorityDelta = statePriority[right.state] - statePriority[left.state];
        return priorityDelta || Date.parse(right.lastEventAt) - Date.parse(left.lastEventAt);
      })[0];
    return {
      version: 1,
      state: winner?.state ?? 'idle',
      agentId: winner?.agentId,
      agentName: winner?.agentName,
      sessionId: winner?.sessionId,
      sessionTitle: winner?.sessionTitle,
      workspace: winner?.workspace,
      toolName: winner?.toolName,
      model: winner?.model,
      provider: winner?.provider,
      activeSessionCount: sessions.length,
      liveSubagentCount: sessions.reduce((sum, session) => sum + session.subagentCount, 0),
      lastEventAt: sessions[0]?.lastEventAt,
      sessions,
    };
  }
}

export const externalAgentStateLabels: Record<ExternalAgentState, string> = {
  idle: '待机',
  thinking: '思考中',
  working: '执行中',
  juggling: '并行处理中',
  error: '遇到错误',
  attention: '等待下一步',
  notification: '等待确认',
  sweeping: '整理上下文',
  carrying: '准备工作区',
  sleeping: '已结束',
};
