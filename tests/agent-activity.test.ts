// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentActivityStore,
  normalizeExternalAgentActivity,
} from '../src/shared/agent-activity';
import { AgentActivityBridge } from '../electron/agent/agent-activity-bridge';
import { defaultSettings, type AgentActivitySettings } from '../src/shared/settings';

const bridges: AgentActivityBridge[] = [];

afterEach(async () => {
  while (bridges.length) await bridges.pop()!.stop();
});

describe('external Agent activity protocol', () => {
  it('normalizes clawd-style hook payloads and keeps sensitive fields out', () => {
    const normalized = normalizeExternalAgentActivity({
      agent_id: 'codex',
      session_id: 'session-1',
      event: 'PreToolUse',
      cwd: '/Users/example/private/project',
      tool_name: 'terminal.exec',
      prompt: 'must never be retained',
      tool_input: { secret: 'nope' },
    }, 1_700_000_000_000);
    expect(normalized?.event).toMatchObject({
      agentId: 'codex',
      state: 'working',
      workspace: 'private / project',
      toolName: 'terminal.exec',
    });
    expect(normalized?.event).not.toHaveProperty('prompt');
    expect(normalized?.event).not.toHaveProperty('tool_input');
  });

  it('accepts the broader clawd agent roster through one redacted protocol', () => {
    const ids = [
      ['cursor', 'cursor-agent'],
      ['agy', 'antigravity-cli'],
      ['kimi', 'kimi-cli'],
      ['mimo-code', 'mimocode'],
      ['qwen-work', 'qwenwork'],
      ['trae-code', 'traecode'],
    ] as const;
    for (const [input, expected] of ids) {
      expect(normalizeExternalAgentActivity({
        agent_id: input,
        session_id: `session-${input}`,
        state: 'working',
      })?.event.agentId).toBe(expected);
    }
  });

  it('keeps an explicitly sleeping session visible until SessionEnd', () => {
    const sleeping = normalizeExternalAgentActivity({
      agent_id: 'codex',
      session_id: 'sleeping-session',
      state: 'sleeping',
    });
    expect(sleeping?.event.terminal).toBe(false);
    const ended = normalizeExternalAgentActivity({
      agent_id: 'codex',
      session_id: 'sleeping-session',
      event: 'SessionEnd',
    });
    expect(ended?.event.terminal).toBe(true);
  });

  it('aggregates sessions by meaningful posture, de-duplicates old sequences, and removes terminal sessions', () => {
    let now = 1_700_000_000_000;
    const store = new AgentActivityStore({ now: () => now, staleAfterMs: 60_000 });
    store.ingest({ agent_id: 'codex', session_id: 'a', state: 'working', sequence: 2 });
    store.ingest({ agent_id: 'openclaw', session_id: 'b', state: 'juggling', subagent_count: 3 });
    store.ingest({ agent_id: 'codex', session_id: 'a', state: 'idle', sequence: 1 });
    expect(store.snapshot()).toMatchObject({
      state: 'juggling',
      activeSessionCount: 2,
      liveSubagentCount: 3,
    });
    store.ingest({ agent_id: 'openclaw', session_id: 'b', event: 'SessionEnd' });
    expect(store.snapshot()).toMatchObject({ state: 'working', activeSessionCount: 1 });
    now += 61_000;
    expect(store.snapshot()).toMatchObject({ state: 'idle', activeSessionCount: 0 });
  });

  it('requires the local bearer token and exposes only the redacted activity state', async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), 'todo-agent-activity-'));
    let settings: AgentActivitySettings = {
      ...defaultSettings.agentActivity,
      enabled: true,
      port: 0,
    };
    let latest = undefined;
    const bridge = new AgentActivityBridge({
      userDataPath,
      settings: () => settings,
      onSnapshot: (snapshot) => {
        latest = snapshot;
      },
    });
    bridges.push(bridge);
    await bridge.start();
    const setup = bridge.setup();
    const runtime = JSON.parse(await readFile(setup.runtimePath, 'utf8')) as Record<string, unknown>;
    expect(runtime).not.toHaveProperty('token');
    expect(setup.endpoint).toContain('127.0.0.1');

    const post = (token: string | undefined, payload: unknown) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(setup.endpoint, {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'content-type': 'application/json',
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(JSON.stringify(payload));
      });

    expect((await post(undefined, { agent_id: 'codex', session_id: 'x', state: 'working' })).status).toBe(401);
    expect((await post(setup.token, { agent_id: 'codex', session_id: 'x', state: 'working', prompt: 'redacted' })).status).toBe(200);
    expect(latest).toMatchObject({ state: 'working', activeSessionCount: 1 });
    settings = { ...settings, enabled: false };
    await bridge.applySettings();
    expect(bridge.status().running).toBe(false);
  });
});
