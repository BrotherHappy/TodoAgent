import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AgentActivitySetup,
  AgentActivitySnapshot,
  AgentActivityStatus,
  AgentActivityStore,
} from '../../src/shared/agent-activity';
import {
  AgentActivityStore as ActivityStore,
  normalizeExternalAgentActivity,
} from '../../src/shared/agent-activity';
import type { AgentActivitySettings, ExternalAgentId } from '../../src/shared/settings';

const DEFAULT_PORTS = [23333, 23334, 23335, 23336, 23337] as const;
const BODY_LIMIT_BYTES = 16 * 1024;

export interface AgentActivityBridgeOptions {
  userDataPath: string;
  settings: () => AgentActivitySettings;
  onSnapshot: (snapshot: AgentActivitySnapshot) => void;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(encoded);
}

function text(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+/iu.test(authorization)) {
    return authorization.replace(/^Bearer\s+/iu, '').trim();
  }
  const header = request.headers['x-todo-agent-token'];
  return typeof header === 'string' ? header.trim() : undefined;
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > BODY_LIMIT_BYTES) {
        request.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function configuredPort(port: number): number[] {
  if (Number.isInteger(port) && port > 0 && port <= 65_535) return [port];
  return [...DEFAULT_PORTS];
}

function createToken(): string {
  return `ta_${randomBytes(32).toString('base64url')}`;
}

function sameSettings(left: AgentActivitySettings, right: AgentActivitySettings): boolean {
  return left.enabled === right.enabled &&
    left.port === right.port &&
    left.staleAfterSeconds === right.staleAfterSeconds &&
    left.showInPet === right.showInPet &&
    JSON.stringify(left.allowedAgents) === JSON.stringify(right.allowedAgents);
}

export class AgentActivityBridge {
  readonly #options: AgentActivityBridgeOptions;
  readonly #runtimePath: string;
  readonly #tokenPath: string;
  readonly #store: AgentActivityStore;
  #server?: Server;
  #port?: number;
  #token?: string;
  #appliedSettings?: AgentActivitySettings;
  #pruneTimer?: ReturnType<typeof setInterval>;
  #lastBroadcast = '';

  constructor(options: AgentActivityBridgeOptions) {
    this.#options = options;
    const directory = path.join(options.userDataPath, 'agent-activity');
    this.#runtimePath = path.join(directory, 'runtime.json');
    this.#tokenPath = path.join(directory, 'token');
    this.#store = new ActivityStore({
      staleAfterMs: Math.max(15_000, options.settings().staleAfterSeconds * 1_000),
    });
  }

  async initialize(): Promise<void> {
    if (this.#options.settings().enabled) await this.start();
  }

  async applySettings(): Promise<void> {
    const next = this.#options.settings();
    if (this.#appliedSettings && sameSettings(next, this.#appliedSettings)) return;
    if (!next.enabled) {
      await this.stop();
      this.#appliedSettings = next;
      return;
    }
    await this.start();
  }

  async start(): Promise<void> {
    const settings = this.#options.settings();
    if (!settings.enabled) {
      await this.stop();
      this.#appliedSettings = settings;
      return;
    }
    if (this.#server && this.#appliedSettings && sameSettings(settings, this.#appliedSettings)) return;
    await this.stop();
    await fs.mkdir(path.dirname(this.#runtimePath), { recursive: true, mode: 0o700 });
    this.#token = await this.#readOrCreateToken();
    this.#store.setStaleAfterMs(settings.staleAfterSeconds * 1_000);
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    const port = await this.#listen(server, configuredPort(settings.port));
    this.#server = server;
    this.#port = port;
    this.#appliedSettings = structuredClone(settings);
    await this.#writeRuntimeFile(settings);
    this.#store.prune();
    this.#emitSnapshot(true);
    this.#pruneTimer = setInterval(() => {
      const before = this.#store.snapshot();
      this.#store.prune();
      const after = this.#store.snapshot();
      if (JSON.stringify(before) !== JSON.stringify(after)) this.#emitSnapshot(true);
    }, 15_000);
  }

  async stop(): Promise<void> {
    if (this.#pruneTimer) {
      clearInterval(this.#pruneTimer);
      this.#pruneTimer = undefined;
    }
    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await fs.rm(this.#runtimePath, { force: true }).catch(() => undefined);
    this.#store.clear();
    this.#emitSnapshot(true);
  }

  async rotateToken(): Promise<AgentActivitySetup> {
    if (!this.#server) await this.start();
    this.#token = createToken();
    await this.#writeToken(this.#token);
    await this.#writeRuntimeFile(this.#options.settings());
    return this.setup();
  }

  status(): AgentActivityStatus {
    const snapshot = this.#store.snapshot();
    return {
      enabled: this.#options.settings().enabled,
      running: Boolean(this.#server && this.#port && this.#token),
      port: this.#port,
      endpoint: this.#port ? `http://127.0.0.1:${this.#port}/state` : undefined,
      tokenAvailable: Boolean(this.#token),
      runtimePath: this.#runtimePath,
      activeSessions: snapshot.activeSessionCount,
      state: snapshot.state,
      lastEventAt: snapshot.lastEventAt,
    };
  }

  setup(): AgentActivitySetup {
    if (!this.#server || !this.#port || !this.#token) {
      throw new Error('AGENT_ACTIVITY_BRIDGE_DISABLED');
    }
    const settings = this.#options.settings();
    const endpoint = `http://127.0.0.1:${this.#port}/state`;
    return {
      endpoint,
      port: this.#port,
      token: this.#token,
      runtimePath: this.#runtimePath,
      tokenPath: this.#tokenPath,
      agents: [...settings.allowedAgents],
      example: `curl -sS -X POST ${endpoint} -H 'Authorization: Bearer ${this.#token}' -H 'Content-Type: application/json' -d '{"agent_id":"codex","session_id":"demo","event":"UserPromptSubmit"}'`,
    };
  }

  snapshot(): AgentActivitySnapshot {
    return this.#store.snapshot();
  }

  async #readOrCreateToken(): Promise<string> {
    try {
      const existing = (await fs.readFile(this.#tokenPath, 'utf8')).trim();
      if (existing.length >= 24) return existing;
    } catch {
      // Generate below when the token is absent or unreadable.
    }
    const token = createToken();
    await this.#writeToken(token);
    return token;
  }

  async #writeToken(token: string): Promise<void> {
    await fs.mkdir(path.dirname(this.#tokenPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.#tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(this.#tokenPath, 0o600).catch(() => undefined);
  }

  async #writeRuntimeFile(settings: AgentActivitySettings): Promise<void> {
    if (!this.#port) return;
    const runtime = {
      version: 1,
      endpoint: `http://127.0.0.1:${this.#port}/state`,
      port: this.#port,
      tokenPath: this.#tokenPath,
      agents: settings.allowedAgents,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${this.#runtimePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temporary, 0o600).catch(() => undefined);
    await fs.rename(temporary, this.#runtimePath);
  }

  async #listen(server: Server, ports: number[]): Promise<number> {
    for (const port of ports) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException) => {
            server.removeListener('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '127.0.0.1');
        });
        return port;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('AGENT_ACTIVITY_PORT_UNAVAILABLE');
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && request.method === 'GET') {
      json(response, 200, { ok: true, ...this.status() });
      return;
    }
    if (url.pathname !== '/state' || request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      text(response, 404, 'Not found');
      return;
    }
    if (!tokenMatches(bearerToken(request), this.#token ?? '')) {
      text(response, 401, 'Unauthorized');
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      text(response, 413, 'Payload too large');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      text(response, 400, 'Invalid JSON');
      return;
    }
    const allowedAgents = new Set<ExternalAgentId>(this.#options.settings().allowedAgents);
    const normalized = normalizeExternalAgentActivity(payload);
    if (!normalized || !allowedAgents.has(normalized.event.agentId)) {
      json(response, 400, { accepted: false, reason: 'AGENT_NOT_ALLOWED_OR_INVALID' });
      return;
    }
    const result = this.#store.ingest(normalized.event);
    this.#emitSnapshot(true);
    const snapshot = result.snapshot;
    json(response, 200, {
      accepted: true,
      state: snapshot.state,
      activeSessions: snapshot.activeSessionCount,
      liveSubagents: snapshot.liveSubagentCount,
    });
  }

  #emitSnapshot(force = false): void {
    const snapshot = this.#store.snapshot();
    const serialized = JSON.stringify(snapshot);
    if (!force && serialized === this.#lastBroadcast) return;
    this.#lastBroadcast = serialized;
    this.#options.onSnapshot(snapshot);
  }
}

export type AgentActivityStoreLike = AgentActivityStore;
