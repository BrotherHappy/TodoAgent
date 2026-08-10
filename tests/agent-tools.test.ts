import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentJsonValue,
  ExecutionGrant,
  ModelCompletion,
  NormalizedToolCall,
  PermissionContext,
} from '../src/shared/agent-types';
import { AgentRuntime } from '../electron/agent/agent-runtime';
import { AuditLog, InMemoryAuditStore } from '../electron/agent/audit-log';
import {
  createBuiltinTools,
  fileReadArgumentsSchema,
} from '../electron/agent/builtin-tools';
import { PermissionEngine } from '../electron/agent/permission-engine';
import {
  BuiltinToolError,
  BuiltinToolExecutors,
  NodeHttpFetchToolAdapter,
  classifyTerminalCommand,
  type ClipboardToolAdapter,
  type HttpFetchToolAdapter,
  type ScreenCaptureToolAdapter,
  type TerminalRunOutput,
  type TerminalToolAdapter,
  type UrlOpenerToolAdapter,
  type WebSearchToolAdapter,
} from '../electron/agent/tool-executors';
import {
  ToolRegistry,
  type PreparedToolInvocation,
} from '../electron/agent/tool-registry';

const call = (
  name: string,
  args: AgentJsonValue,
  id = `${name}-call`,
): NormalizedToolCall => ({
  id,
  name,
  arguments: args,
  argumentsJson: JSON.stringify(args),
});

const authorize = (
  engine: PermissionEngine,
  prepared: PreparedToolInvocation,
  context: PermissionContext = { mode: 'standard' },
): ExecutionGrant => {
  let decision = engine.evaluate(prepared.invocation, prepared.effects, context);
  if (decision.kind === 'confirm') {
    decision = engine.resolveApproval(decision.request.approvalId, 'once');
  }
  if (decision.kind !== 'allow') {
    throw new Error(`Expected authorization, received ${decision.kind}.`);
  }
  engine.consumeGrant(decision.grant, prepared.invocation, prepared.effects, context);
  return decision.grant;
};

const executeAuthorized = async (
  registry: ToolRegistry,
  engine: PermissionEngine,
  runId: string,
  name: string,
  args: AgentJsonValue,
) => {
  const prepared = await registry.prepare(runId, call(name, args, `${name}-${runId}`));
  const grant = authorize(engine, prepared);
  const toolResult = await registry.execute(
    prepared.invocation,
    grant,
    new AbortController().signal,
  );
  return { prepared, toolResult };
};

const completionWithTool = (
  name: string,
  args: AgentJsonValue,
  id = 'provider-call-1',
): ModelCompletion => {
  const argumentsJson = JSON.stringify(args);
  return {
    assistantMessage: {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id, type: 'function', function: { name, arguments: argumentsJson } },
      ],
    },
    toolCalls: [{ id, name, arguments: args, argumentsJson }],
    finishReason: 'tool_calls',
  };
};

describe('OpenClaw-style built-in Agent tools', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-agent-tools-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('publishes strict JSON schemas and enforces strict local Zod validation', async () => {
    const registry = new ToolRegistry(
      createBuiltinTools(new BuiltinToolExecutors({ allowedRoots: [root] })),
    );
    const modelTools = registry.listModelTools();

    expect(modelTools).toHaveLength(13);
    for (const modelTool of modelTools) {
      expect(modelTool.function.strict).toBe(true);
      expect(modelTool.function.parameters.additionalProperties).toBe(false);
      expect(modelTool.function.parameters.required?.sort()).toEqual(
        Object.keys(modelTool.function.parameters.properties).sort(),
      );
    }
    const httpTool = modelTools.find((entry) => entry.function.name === 'http_fetch');
    const httpProperties = httpTool?.function.parameters.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(
      (httpProperties?.headers?.items as Record<string, unknown> | undefined)
        ?.additionalProperties,
    ).toBe(false);
    expect(
      fileReadArgumentsSchema.safeParse({
        path: 'notes.txt',
        maxBytes: 1_024,
        dryRun: false,
        unexpected: true,
      }).success,
    ).toBe(false);
    await expect(
      registry.prepare(
        'run-strict',
        call('file_read', {
          path: 'notes.txt',
          maxBytes: 1_024,
          dryRun: false,
          unexpected: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
  });

  it('maps read, reversible, sensitive, destructive, and forbidden actions to R0-R4', async () => {
    await fs.writeFile(path.join(root, 'existing.txt'), 'old value', 'utf8');
    const registry = new ToolRegistry(
      createBuiltinTools(new BuiltinToolExecutors({ allowedRoots: [root] })),
    );
    const analyze = async (name: string, args: AgentJsonValue) =>
      (await registry.prepare('run-risk', call(name, args, `${name}-${Math.random()}`))).effects.risk;

    await expect(
      analyze('file_read', { path: 'existing.txt', maxBytes: 1_024, dryRun: false }),
    ).resolves.toBe('R0');
    await expect(
      analyze('file_write', {
        path: 'new.txt',
        content: 'new',
        overwrite: false,
        createParents: false,
        dryRun: false,
      }),
    ).resolves.toBe('R1');
    await expect(
      analyze('file_write', {
        path: 'existing.txt',
        content: 'replace',
        overwrite: true,
        createParents: false,
        dryRun: false,
      }),
    ).resolves.toBe('R2');
    await expect(
      analyze('screen_capture', {
        displayId: null,
        includeCursor: false,
        savePath: null,
        dryRun: false,
      }),
    ).resolves.toBe('R2');
    await expect(analyze('clipboard_read', { dryRun: false })).resolves.toBe('R2');
    await expect(
      analyze('file_delete', { path: 'existing.txt', recursive: false, dryRun: false }),
    ).resolves.toBe('R3');
    await expect(
      analyze('terminal_run', {
        executable: 'rm',
        arguments: ['-rf', '.'],
        cwd: '.',
        timeoutMs: 1_000,
        dryRun: false,
      }),
    ).resolves.toBe('R4');
    await expect(
      analyze('terminal_run', {
        executable: 'rg',
        arguments: ['password', '/etc/passwd'],
        cwd: '.',
        timeoutMs: 1_000,
        dryRun: false,
      }),
    ).resolves.toBe('R4');
  });

  it('normalizes path targets and rejects lexical and symbolic-link escapes', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-agent-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'inside.txt'), 'inside', 'utf8');
    const registry = new ToolRegistry(
      createBuiltinTools(new BuiltinToolExecutors({ allowedRoots: [root] })),
    );

    const normalized = await registry.prepare(
      'run-path',
      call('file_read', {
        path: 'sub/../inside.txt',
        maxBytes: 1_024,
        dryRun: false,
      }),
    );
    const canonicalRoot = await fs.realpath(root);
    expect(normalized.effects.targets).toEqual([
      { kind: 'path', value: path.join(canonicalRoot, 'inside.txt') },
    ]);
    await expect(
      registry.prepare(
        'run-path',
        call('file_read', {
          path: path.join('..', path.basename(outside), 'secret.txt'),
          maxBytes: 1_024,
          dryRun: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });

    await fs.link(path.join(outside, 'secret.txt'), path.join(root, 'outside-hardlink.txt'));
    const hardLinkOverwrite = await registry.prepare(
      'run-path',
      call('file_write', {
        path: 'outside-hardlink.txt',
        content: 'must not mutate the outside inode',
        overwrite: true,
        createParents: false,
        dryRun: false,
      }),
    );
    expect(hardLinkOverwrite.effects.risk).toBe('R4');
    const hardLinkRead = await registry.prepare(
      'run-path',
      call('file_read', {
        path: 'outside-hardlink.txt',
        maxBytes: 1_024,
        dryRun: false,
      }),
    );
    expect(hardLinkRead.effects.risk).toBe('R4');

    if (process.platform !== 'win32') {
      await fs.symlink(outside, path.join(root, 'escape'));
      await expect(
        registry.prepare(
          'run-path',
          call('file_read', {
            path: 'escape/secret.txt',
            maxBytes: 1_024,
            dryRun: false,
          }),
        ),
      ).rejects.toMatchObject({ code: 'SYMLINK_OUTSIDE_ROOT' });

      await fs.mkdir(path.join(root, 'target'));
      await fs.symlink(path.join(root, 'target'), path.join(root, 'inside-link'));
      const mutationThroughLink = await registry.prepare(
        'run-path',
        call('file_write', {
          path: 'inside-link/new.txt',
          content: 'blocked',
          overwrite: false,
          createParents: false,
          dryRun: false,
        }),
      );
      expect(mutationThroughLink.effects.risk).toBe('R4');
    }
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('blocks dangerous command indirection and R4 remains denied in full-access mode', async () => {
    expect(classifyTerminalCommand('bash', ['-lc', 'echo safe']).risk).toBe('R4');
    expect(classifyTerminalCommand('python3', ['-c', 'print(1)']).risk).toBe('R4');
    expect(classifyTerminalCommand('git', ['push', '--force']).risk).toBe('R4');
    expect(classifyTerminalCommand('/usr/bin/echo', ['hello']).risk).toBe('R4');
    expect(classifyTerminalCommand('git', ['status']).risk).toBe('R0');

    const executors = new BuiltinToolExecutors({ allowedRoots: [root] });
    const registry = new ToolRegistry(createBuiltinTools(executors));
    const prepared = await registry.prepare(
      'run-danger',
      call('terminal_run', {
        executable: 'rm',
        arguments: ['-rf', '.'],
        cwd: '.',
        timeoutMs: 1_000,
        dryRun: false,
      }),
    );
    const engine = new PermissionEngine();
    const lease = engine.createFullAccessLease({
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: [
        {
          toolName: 'terminal_run',
          risks: ['R2', 'R3'],
          targets: prepared.effects.targets,
        },
      ],
    });

    expect(
      engine.evaluate(prepared.invocation, prepared.effects, {
        mode: 'full-access',
        fullAccessLease: lease,
      }),
    ).toMatchObject({ kind: 'deny', reasonCode: 'R4_PERMANENTLY_FORBIDDEN' });
    await expect(
      executors.executeTerminalRun(
        prepared.invocation.arguments as unknown as {
          executable: string;
          arguments: string[];
          cwd: string;
          timeoutMs: number;
          dryRun: boolean;
        },
        {
          runId: prepared.invocation.runId,
          invocation: prepared.invocation,
          grant: {} as ExecutionGrant,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_COMMAND' });
  });

  it('blocks private-network fetches and escalates credential-bearing public requests', async () => {
    const registry = new ToolRegistry(
      createBuiltinTools(new BuiltinToolExecutors({ allowedRoots: [root] })),
    );
    const publicFetch = await registry.prepare(
      'run-network',
      call('http_fetch', {
        url: 'https://example.com/public?q=one',
        method: 'GET',
        headers: [],
        maxBytes: 4_096,
        dryRun: false,
      }),
    );
    const authenticatedFetch = await registry.prepare(
      'run-network',
      call('http_fetch', {
        url: 'https://example.com/private',
        method: 'GET',
        headers: [{ name: 'Authorization', value: 'Bearer private-value' }],
        maxBytes: 4_096,
        dryRun: false,
      }),
    );
    const privateFetch = await registry.prepare(
      'run-network',
      call('http_fetch', {
        url: 'http://127.0.0.1/admin',
        method: 'GET',
        headers: [],
        maxBytes: 4_096,
        dryRun: false,
      }),
    );
    const mappedLoopbackFetch = await registry.prepare(
      'run-network',
      call('http_fetch', {
        url: 'http://[::ffff:127.0.0.1]/admin',
        method: 'GET',
        headers: [],
        maxBytes: 4_096,
        dryRun: false,
      }),
    );
    const encodedLoopbackFetch = await registry.prepare(
      'run-network',
      call('http_fetch', {
        url: 'http://2130706433/admin',
        method: 'GET',
        headers: [],
        maxBytes: 4_096,
        dryRun: false,
      }),
    );

    expect(publicFetch.effects.risk).toBe('R1');
    expect(authenticatedFetch.effects.risk).toBe('R2');
    expect(privateFetch.effects.risk).toBe('R4');
    expect(mappedLoopbackFetch.effects.risk).toBe('R4');
    expect(encodedLoopbackFetch.effects.risk).toBe('R4');
    expect(JSON.stringify(authenticatedFetch.effects)).not.toContain('private-value');
    expect(publicFetch.effects.targets.map((target) => target.value).join(' ')).not.toContain('?q=one');

    const secretUrl = await registry.prepare(
      'run-network',
      call('url_open', {
        url: 'https://example.com/private-path-token?access=private-query-token',
        dryRun: false,
      }),
    );
    expect(JSON.stringify(secretUrl.effects)).not.toContain('private-path-token');
    expect(JSON.stringify(secretUrl.effects)).not.toContain('private-query-token');
  });

  it('does not follow HTTP redirects without a new exact-target permission decision', async () => {
    let requestCount = 0;
    const fetchFn: typeof fetch = async () => {
      requestCount += 1;
      return new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1/private-target' },
      });
    };
    const adapter = new NodeHttpFetchToolAdapter(fetchFn, async () => undefined);

    const response = await adapter.fetch(
      {
        url: 'https://example.com/original',
        method: 'GET',
        headers: [],
        maxBytes: 1_024,
      },
      new AbortController().signal,
    );

    expect(requestCount).toBe(1);
    expect(response.status).toBe(302);
    expect(response.redirectUrl).toBe('http://127.0.0.1/private-target');
  });

  it('executes the bounded file lifecycle through one-time permission grants', async () => {
    const registry = new ToolRegistry(
      createBuiltinTools(new BuiltinToolExecutors({ allowedRoots: [root] })),
    );
    const engine = new PermissionEngine();

    await executeAuthorized(registry, engine, 'file-run-1', 'file_write', {
      path: 'notes/first.txt',
      content: 'alpha searchable phrase',
      overwrite: false,
      createParents: true,
      dryRun: false,
    });
    const read = await executeAuthorized(registry, engine, 'file-run-2', 'file_read', {
      path: 'notes/first.txt',
      maxBytes: 4_096,
      dryRun: false,
    });
    const listed = await executeAuthorized(registry, engine, 'file-run-3', 'file_list', {
      path: 'notes',
      recursive: true,
      maxEntries: 20,
      dryRun: false,
    });
    const searched = await executeAuthorized(registry, engine, 'file-run-4', 'file_search', {
      path: 'notes',
      query: 'searchable phrase',
      filePattern: '**/*.txt',
      maxResults: 20,
      maxFileBytes: 4_096,
      dryRun: false,
    });
    await executeAuthorized(registry, engine, 'file-run-5', 'file_move', {
      source: 'notes/first.txt',
      destination: 'notes/moved.txt',
      overwrite: false,
      createParents: false,
      dryRun: false,
    });
    await executeAuthorized(registry, engine, 'file-run-6', 'file_delete', {
      path: 'notes/moved.txt',
      recursive: false,
      dryRun: false,
    });

    expect(read.toolResult).toMatchObject({ data: { content: 'alpha searchable phrase' } });
    expect(listed.toolResult).toMatchObject({ data: { entries: [{ path: 'notes/first.txt' }] } });
    expect(searched.toolResult).toMatchObject({
      data: { matches: [{ path: 'notes/first.txt', line: 1 }] },
    });
    await expect(fs.stat(path.join(root, 'notes', 'moved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('routes clipboard, screen, URL, HTTP, and web search through injected adapters', async () => {
    let clipboardValue = 'initial clipboard';
    const clipboard: ClipboardToolAdapter = {
      readText: vi.fn(async () => clipboardValue),
      writeText: vi.fn(async (text) => {
        clipboardValue = text;
      }),
    };
    const screenCapture: ScreenCaptureToolAdapter = {
      capture: vi.fn(async () => ({
        artifactId: 'screen-artifact-1',
        mimeType: 'image/png',
        width: 1_920,
        height: 1_080,
        bytes: 50_000,
        savedPath: null,
      })),
    };
    const urlOpener: UrlOpenerToolAdapter = { open: vi.fn(async () => undefined) };
    const httpFetch: HttpFetchToolAdapter = {
      fetch: vi.fn(async (input) => ({
        status: 200,
        statusText: 'OK',
        finalUrl: input.url,
        contentType: 'text/plain',
        body: 'bounded response',
        truncated: false,
      })),
    };
    const webSearch: WebSearchToolAdapter = {
      providerId: 'test-search',
      search: vi.fn(async () => [
        { title: 'Result', url: 'https://example.com/result', snippet: 'Snippet' },
      ]),
    };
    const registry = new ToolRegistry(
      createBuiltinTools(
        new BuiltinToolExecutors({
          allowedRoots: [root],
          adapters: { clipboard, screenCapture, urlOpener, httpFetch, webSearch },
        }),
      ),
    );
    const engine = new PermissionEngine();

    await executeAuthorized(registry, engine, 'platform-1', 'clipboard_write', {
      text: 'updated clipboard',
      dryRun: false,
    });
    const clipboardRead = await executeAuthorized(
      registry,
      engine,
      'platform-2',
      'clipboard_read',
      { dryRun: false },
    );
    const screenshot = await executeAuthorized(registry, engine, 'platform-3', 'screen_capture', {
      displayId: null,
      includeCursor: false,
      savePath: null,
      dryRun: false,
    });
    await executeAuthorized(registry, engine, 'platform-4', 'url_open', {
      url: 'https://example.com/path',
      dryRun: false,
    });
    const fetched = await executeAuthorized(registry, engine, 'platform-5', 'http_fetch', {
      url: 'https://example.com/data',
      method: 'GET',
      headers: [],
      maxBytes: 4_096,
      dryRun: false,
    });
    const searched = await executeAuthorized(registry, engine, 'platform-6', 'web_search', {
      query: 'Todo agent research',
      maxResults: 5,
      dryRun: false,
    });

    expect(clipboardRead.toolResult).toMatchObject({ data: { text: 'updated clipboard' } });
    expect(screenshot.toolResult).toMatchObject({ data: { artifactId: 'screen-artifact-1' } });
    expect(urlOpener.open).toHaveBeenCalledWith(
      'https://example.com/path',
      expect.any(AbortSignal),
    );
    expect(fetched.toolResult).toMatchObject({ data: { body: 'bounded response' } });
    expect(searched.toolResult).toMatchObject({ data: { providerId: 'test-search' } });
  });

  it('honors a stop signal after authorization and before platform completion', async () => {
    let adapterStarted = false;
    const terminal: TerminalToolAdapter = {
      run: vi.fn(async (_input, signal) => {
        adapterStarted = true;
        return new Promise<TerminalRunOutput>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new BuiltinToolError('ABORTED', 'Stopped by test.')),
            { once: true },
          );
        });
      }),
    };
    const registry = new ToolRegistry(
      createBuiltinTools(
        new BuiltinToolExecutors({ allowedRoots: [root], adapters: { terminal } }),
      ),
    );
    const prepared = await registry.prepare(
      'run-stop',
      call('terminal_run', {
        executable: 'echo',
        arguments: ['private argument'],
        cwd: '.',
        timeoutMs: 10_000,
        dryRun: false,
      }),
    );
    const engine = new PermissionEngine();
    const grant = authorize(engine, prepared);
    const controller = new AbortController();
    const executing = registry.execute(prepared.invocation, grant, controller.signal);
    await vi.waitFor(() => expect(adapterStarted).toBe(true));
    controller.abort();

    await expect(executing).rejects.toMatchObject({ code: 'ABORTED' });

    const notStarted = await registry.prepare(
      'run-stop-before',
      call('terminal_run', {
        executable: 'echo',
        arguments: ['never executed'],
        cwd: '.',
        timeoutMs: 10_000,
        dryRun: false,
      }),
    );
    const secondGrant = authorize(engine, notStarted);
    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    await expect(
      registry.prepare(
        'run-analysis-stopped',
        call('file_list', { path: '.', recursive: false, maxEntries: 10, dryRun: false }),
        alreadyStopped.signal,
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_ABORTED' });
    await expect(
      registry.execute(notStarted.invocation, secondGrant, alreadyStopped.signal),
    ).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
    expect(terminal.run).toHaveBeenCalledTimes(1);
  });

  it('keeps sensitive tool arguments out of the chained audit log', async () => {
    const secret = 'arbitrary private file content 81370';
    const registry = new ToolRegistry(
      createBuiltinTools(new BuiltinToolExecutors({ allowedRoots: [root] })),
    );
    const auditLog = new AuditLog({ store: new InMemoryAuditStore() });
    const completions: ModelCompletion[] = [
      completionWithTool('file_write', {
        path: 'agent-note.txt',
        content: secret,
        overwrite: false,
        createParents: false,
        dryRun: false,
      }),
      {
        assistantMessage: { role: 'assistant', content: 'Created the note.' },
        toolCalls: [],
        finishReason: 'stop',
      },
    ];
    const runtime = new AgentRuntime({
      modelGateway: {
        complete: vi.fn(async () => {
          const next = completions.shift();
          if (next === undefined) throw new Error('No completion configured.');
          return next;
        }),
      },
      permissionEngine: new PermissionEngine(),
      auditLog,
      toolRegistry: registry,
      getPermissionContext: () => ({ mode: 'standard' }),
      requestApproval: () => 'once',
    });

    const runResult = await runtime.run({
      runId: 'run-redaction',
      messages: [{ role: 'user', content: 'Create my private note.' }],
    });
    const records = await auditLog.records();
    const serialized = JSON.stringify(records);

    expect(runResult.state).toBe('completed');
    await expect(fs.readFile(path.join(root, 'agent-note.txt'), 'utf8')).resolves.toBe(secret);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
    await expect(auditLog.verify(records)).resolves.toEqual({ valid: true });
  });

  it('redacts arbitrary HTTP credentials from Agent audit records', async () => {
    const credential = 'provider credential value not matching a known key format';
    const httpFetch: HttpFetchToolAdapter = {
      fetch: vi.fn(async (input) => ({
        status: 200,
        statusText: 'OK',
        finalUrl: input.url,
        contentType: 'text/plain',
        body: 'ok',
        truncated: false,
      })),
    };
    const registry = new ToolRegistry(
      createBuiltinTools(
        new BuiltinToolExecutors({ allowedRoots: [root], adapters: { httpFetch } }),
      ),
    );
    const auditLog = new AuditLog({ store: new InMemoryAuditStore() });
    const completions: ModelCompletion[] = [
      completionWithTool('http_fetch', {
        url: 'https://example.com/account',
        method: 'GET',
        headers: [{ name: 'Authorization', value: `Bearer ${credential}` }],
        maxBytes: 4_096,
        dryRun: false,
      }),
      {
        assistantMessage: { role: 'assistant', content: 'Fetched.' },
        toolCalls: [],
        finishReason: 'stop',
      },
    ];
    const runtime = new AgentRuntime({
      modelGateway: {
        complete: vi.fn(async () => {
          const next = completions.shift();
          if (next === undefined) throw new Error('No completion configured.');
          return next;
        }),
      },
      permissionEngine: new PermissionEngine(),
      auditLog,
      toolRegistry: registry,
      getPermissionContext: () => ({ mode: 'standard' }),
      requestApproval: () => 'once',
    });

    const runResult = await runtime.run({
      runId: 'run-http-redaction',
      messages: [{ role: 'user', content: 'Fetch my account.' }],
    });
    const serialized = JSON.stringify(await auditLog.records());

    expect(runResult.state).toBe('completed');
    expect(serialized).not.toContain(credential);
    expect(serialized).toContain('[REDACTED]');
  });

  it('makes dry-run writes effect-free while still returning a reviewed summary', async () => {
    const registry = new ToolRegistry(
      createBuiltinTools(new BuiltinToolExecutors({ allowedRoots: [root] })),
    );
    const prepared = await registry.prepare(
      'run-dry',
      call('file_write', {
        path: 'not-created.txt',
        content: 'preview only',
        overwrite: false,
        createParents: false,
        dryRun: true,
      }),
    );
    const engine = new PermissionEngine();
    const grant = authorize(engine, prepared);
    const toolResult = await registry.execute(
      prepared.invocation,
      grant,
      new AbortController().signal,
    );

    expect(prepared.effects.risk).toBe('R0');
    expect(prepared.effects.writes).toEqual([]);
    expect(toolResult).toMatchObject({ status: 'ok', data: { dryRun: true } });
    await expect(fs.stat(path.join(root, 'not-created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
