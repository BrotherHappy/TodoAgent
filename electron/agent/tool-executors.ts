import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentJsonValue,
  PermissionTarget,
  RiskLevel,
  ToolResult,
} from '../../src/shared/agent-types';
import type {
  ToolExecutionContext,
  UnhashedEffectPlan,
} from './tool-registry';

export class BuiltinToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BuiltinToolError';
  }
}

export type FileEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileInfo {
  exists: boolean;
  kind: FileEntryKind;
  size: number;
  version: string;
  hardLinkCount?: number;
}

export interface FileListEntry {
  path: string;
  kind: FileEntryKind;
  size: number;
  hardLinkCount?: number;
}

export interface FileSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface FileSystemToolAdapter {
  inspect(filePath: string, signal: AbortSignal): Promise<FileInfo>;
  realpath(filePath: string, signal: AbortSignal): Promise<string>;
  readText(filePath: string, maxBytes: number, signal: AbortSignal): Promise<string>;
  list(
    directoryPath: string,
    options: { recursive: boolean; maxEntries: number },
    signal: AbortSignal,
  ): Promise<FileListEntry[]>;
  search(
    directoryPath: string,
    options: {
      query: string;
      filePattern: string | null;
      maxResults: number;
      maxFileBytes: number;
    },
    signal: AbortSignal,
  ): Promise<FileSearchMatch[]>;
  writeText(
    filePath: string,
    content: string,
    options: { overwrite: boolean; createParents: boolean },
    signal: AbortSignal,
  ): Promise<void>;
  move(
    sourcePath: string,
    destinationPath: string,
    options: { overwrite: boolean; createParents: boolean },
    signal: AbortSignal,
  ): Promise<void>;
  remove(filePath: string, options: { recursive: boolean }, signal: AbortSignal): Promise<void>;
}

export interface TerminalRunInput {
  executable: string;
  arguments: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface TerminalRunOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface TerminalToolAdapter {
  run(input: TerminalRunInput, signal: AbortSignal): Promise<TerminalRunOutput>;
}

export interface ClipboardToolAdapter {
  readText(signal: AbortSignal): Promise<string>;
  writeText(text: string, signal: AbortSignal): Promise<void>;
}

export interface ScreenCaptureOutput {
  artifactId: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  savedPath: string | null;
}

export interface ScreenCaptureToolAdapter {
  capture(
    input: {
      displayId: string | null;
      includeCursor: boolean;
      savePath: string | null;
      /** A non-null destination must be created exclusively and never overwritten. */
      mustCreate: true;
    },
    signal: AbortSignal,
  ): Promise<ScreenCaptureOutput>;
}

export interface UrlOpenerToolAdapter {
  open(url: string, signal: AbortSignal): Promise<void>;
}

export interface HttpHeader {
  name: string;
  value: string;
}

export interface HttpFetchOutput {
  status: number;
  statusText: string;
  finalUrl: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
  redirectUrl?: string | null;
}

export interface HttpFetchToolAdapter {
  /** Implementations must return redirects without following them; each new URL needs a new grant. */
  fetch(
    input: {
      url: string;
      method: 'GET' | 'HEAD';
      headers: HttpHeader[];
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<HttpFetchOutput>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchToolAdapter {
  readonly providerId: string;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]>;
}

export interface BuiltinToolAdapters {
  fileSystem?: FileSystemToolAdapter;
  terminal?: TerminalToolAdapter;
  clipboard?: ClipboardToolAdapter;
  screenCapture?: ScreenCaptureToolAdapter;
  urlOpener?: UrlOpenerToolAdapter;
  httpFetch?: HttpFetchToolAdapter;
  webSearch?: WebSearchToolAdapter;
}

export interface BuiltinToolExecutorOptions {
  allowedRoots: string[];
  adapters?: BuiltinToolAdapters;
  platform?: NodeJS.Platform;
  terminalMaxOutputBytes?: number;
}

export interface FileReadArguments {
  path: string;
  maxBytes: number;
  dryRun: boolean;
}

export interface FileListArguments {
  path: string;
  recursive: boolean;
  maxEntries: number;
  dryRun: boolean;
}

export interface FileSearchArguments {
  path: string;
  query: string;
  filePattern: string | null;
  maxResults: number;
  maxFileBytes: number;
  dryRun: boolean;
}

export interface FileWriteArguments {
  path: string;
  content: string;
  overwrite: boolean;
  createParents: boolean;
  dryRun: boolean;
}

export interface FileMoveArguments {
  source: string;
  destination: string;
  overwrite: boolean;
  createParents: boolean;
  dryRun: boolean;
}

export interface FileDeleteArguments {
  path: string;
  recursive: boolean;
  dryRun: boolean;
}

export interface TerminalRunArguments {
  executable: string;
  arguments: string[];
  cwd: string;
  timeoutMs: number;
  dryRun: boolean;
}

export interface ClipboardReadArguments {
  dryRun: boolean;
}

export interface ClipboardWriteArguments {
  text: string;
  dryRun: boolean;
}

export interface ScreenCaptureArguments {
  displayId: string | null;
  includeCursor: boolean;
  savePath: string | null;
  dryRun: boolean;
}

export interface UrlOpenArguments {
  url: string;
  dryRun: boolean;
}

export interface HttpFetchArguments {
  url: string;
  method: 'GET' | 'HEAD';
  headers: HttpHeader[];
  maxBytes: number;
  dryRun: boolean;
}

export interface WebSearchArguments {
  query: string;
  maxResults: number;
  dryRun: boolean;
}

interface ResolvedToolPath {
  path: string;
  root: string;
  isRoot: boolean;
  containsSymlink: boolean;
  info: FileInfo;
}

export interface CommandClassification {
  risk: RiskLevel;
  reason: string;
  executable: string;
  target: string;
}

interface SafeUrl {
  normalized: string;
  origin: string;
  target: string;
  forbiddenReason?: string;
}

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const assertNotAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new BuiltinToolError('ABORTED', 'The tool operation was stopped.');
  }
};

const isMissingError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT';

const pathEquals = (left: string, right: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;

const isInsidePath = (root: string, candidate: string, platform: NodeJS.Platform): boolean => {
  const normalizedRoot = platform === 'win32' ? root.toLocaleLowerCase('en-US') : root;
  const normalizedCandidate =
    platform === 'win32' ? candidate.toLocaleLowerCase('en-US') : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const safePreviewPath = (resolved: ResolvedToolPath): string => {
  const relative = path.relative(resolved.root, resolved.path);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
};

const fileTarget = (resolved: ResolvedToolPath): PermissionTarget => ({
  kind: 'path',
  value: resolved.path,
});

const dryRunRisk = (risk: RiskLevel, dryRun: boolean): RiskLevel =>
  dryRun && risk !== 'R4' ? 'R0' : risk;

const result = (
  context: ToolExecutionContext,
  data: AgentJsonValue,
  status: ToolResult['status'] = 'ok',
): ToolResult => ({
  invocationId: context.invocation.invocationId,
  status,
  data,
});

class SecurePathResolver {
  private readonly roots: string[];

  constructor(
    roots: string[],
    private readonly fileSystem: FileSystemToolAdapter,
    private readonly platform: NodeJS.Platform,
  ) {
    if (roots.length === 0) {
      throw new BuiltinToolError('NO_ALLOWED_ROOTS', 'At least one allowed file root is required.');
    }
    this.roots = roots.map((root) => path.resolve(root));
  }

  async resolve(
    requestedPath: string,
    options: { mustExist: boolean },
    signal: AbortSignal,
  ): Promise<ResolvedToolPath> {
    assertNotAborted(signal);
    if (requestedPath.trim() === '' || requestedPath.includes('\0')) {
      throw new BuiltinToolError('INVALID_PATH', 'The requested path is invalid.');
    }
    const lexicalCandidate = path.resolve(this.roots[0], requestedPath);
    const lexicalRoot = this.roots.find((root) =>
      isInsidePath(root, lexicalCandidate, this.platform),
    );
    if (lexicalRoot === undefined) {
      throw new BuiltinToolError('PATH_OUTSIDE_ROOT', 'The requested path is outside allowed roots.');
    }

    const canonicalRoot = await this.fileSystem.realpath(lexicalRoot, signal);
    let ancestor = lexicalCandidate;
    let ancestorInfo = await this.fileSystem.inspect(ancestor, signal);
    while (!ancestorInfo.exists && !pathEquals(ancestor, lexicalRoot, this.platform)) {
      const parent = path.dirname(ancestor);
      if (pathEquals(parent, ancestor, this.platform)) {
        break;
      }
      ancestor = parent;
      ancestorInfo = await this.fileSystem.inspect(ancestor, signal);
    }
    if (!ancestorInfo.exists) {
      throw new BuiltinToolError('ROOT_UNAVAILABLE', 'The allowed file root is unavailable.');
    }
    const canonicalAncestor = await this.fileSystem.realpath(ancestor, signal);
    const canonicalCandidate = path.resolve(
      canonicalAncestor,
      path.relative(ancestor, lexicalCandidate),
    );
    if (!isInsidePath(canonicalRoot, canonicalCandidate, this.platform)) {
      throw new BuiltinToolError(
        'SYMLINK_OUTSIDE_ROOT',
        'The requested path escapes an allowed root through a symbolic link.',
      );
    }
    const info = await this.fileSystem.inspect(canonicalCandidate, signal);
    if (options.mustExist && !info.exists) {
      throw new BuiltinToolError('PATH_NOT_FOUND', 'The requested path does not exist.');
    }
    const lexicalRelative = path.relative(lexicalRoot, lexicalCandidate);
    const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate);
    return {
      path: canonicalCandidate,
      root: canonicalRoot,
      isRoot: pathEquals(canonicalRoot, canonicalCandidate, this.platform),
      containsSymlink: !pathEquals(lexicalRelative, canonicalRelative, this.platform),
      info,
    };
  }
}

const executableName = (executable: string): string =>
  path.basename(executable).replace(/\.(exe|cmd|bat|com)$/i, '').toLocaleLowerCase('en-US');

const hasAnyArgument = (args: string[], candidates: string[]): boolean => {
  const normalized = args.map((argument) => argument.toLocaleLowerCase('en-US'));
  return candidates.some((candidate) => normalized.includes(candidate));
};

const commandTarget = (executable: string, args: string[]): string =>
  `${executableName(executable)}:${hash(JSON.stringify(args))}`;

export const classifyTerminalCommand = (
  executable: string,
  args: string[],
): CommandClassification => {
  const name = executableName(executable);
  const target = commandTarget(executable, args);
  if (/[\\/]/.test(executable) || executable === '.' || executable === '..') {
    return { risk: 'R4', reason: 'executable-path-indirection-is-not-permitted', executable: name, target };
  }
  const permanentlyForbidden = new Set([
    'sudo',
    'su',
    'doas',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'mkfs',
    'fdisk',
    'diskpart',
    'format',
    'dd',
    'shred',
    'rm',
    'rmdir',
    'del',
    'erase',
    'reg',
    'regedit',
    'bcdedit',
    'env',
    'printenv',
    'xargs',
    'nohup',
    'nice',
  ]);
  if (permanentlyForbidden.has(name) || name.startsWith('mkfs.')) {
    return { risk: 'R4', reason: 'destructive-or-privileged-executable', executable: name, target };
  }

  const shells = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh']);
  if (shells.has(name)) {
    return { risk: 'R4', reason: 'shell-indirection-is-not-permitted', executable: name, target };
  }
  const interpreters = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php']);
  if (
    interpreters.has(name) &&
    hasAnyArgument(args, ['-c', '-e', '--eval', '-command', '/c'])
  ) {
    return { risk: 'R4', reason: 'inline-code-indirection-is-not-permitted', executable: name, target };
  }
  if (name === 'find' && hasAnyArgument(args, ['-delete', '-exec', '-execdir'])) {
    return { risk: 'R4', reason: 'destructive-find-operation', executable: name, target };
  }
  if (name === 'git') {
    const normalizedArgs = args.map((argument) => argument.toLocaleLowerCase('en-US'));
    const includes = (argument: string): boolean => normalizedArgs.includes(argument);
    const subcommand = args.find((argument) => !argument.startsWith('-'))?.toLocaleLowerCase('en-US');
    if (
      (includes('reset') && hasAnyArgument(args, ['--hard'])) ||
      includes('clean') ||
      (includes('push') && hasAnyArgument(args, ['--force', '-f', '--force-with-lease'])) ||
      (includes('branch') && hasAnyArgument(args, ['-d', '-D']))
    ) {
      return { risk: 'R4', reason: 'destructive-version-control-operation', executable: name, target };
    }
    if (includes('push') || includes('publish')) {
      return { risk: 'R3', reason: 'external-publish-operation', executable: name, target };
    }
    if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand ?? '')) {
      return { risk: 'R0', reason: 'known-read-only-command', executable: name, target };
    }
  }
  const readOnlyCommands = new Set([
    'pwd',
    'whoami',
    'hostname',
    'date',
    'uname',
    'ls',
    'dir',
    'rg',
    'grep',
    'head',
    'tail',
    'wc',
    'which',
    'where',
    'echo',
    'printf',
  ]);
  if (readOnlyCommands.has(name)) {
    return { risk: 'R0', reason: 'known-read-only-command', executable: name, target };
  }
  const externalCommands = new Set([
    'curl',
    'wget',
    'ssh',
    'scp',
    'rsync',
    'npm',
    'pnpm',
    'yarn',
    'pip',
    'pip3',
    'brew',
    'winget',
    'choco',
  ]);
  if (externalCommands.has(name)) {
    return { risk: 'R3', reason: 'network-or-package-operation', executable: name, target };
  }
  return { risk: 'R2', reason: 'general-command-may-change-local-state', executable: name, target };
};

const privateIpv4 = (hostname: string): boolean => {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 192 && second === 0 && parts[2] === 2) ||
    (first === 198 && second === 51 && parts[2] === 100) ||
    (first === 203 && second === 0 && parts[2] === 113) ||
    first >= 224
  );
};

const ipv6Words = (hostname: string): number[] | null => {
  const normalized = hostname.replace(/^\[|\]$/g, '').split('%')[0].toLocaleLowerCase('en-US');
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (half === '') return [];
    const output: number[] = [];
    for (const component of half.split(':')) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(component)) {
        const parts = component.split('.').map(Number);
        if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) return null;
        output.push((parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(component)) {
        output.push(Number.parseInt(component, 16));
      } else {
        return null;
      }
    }
    return output;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
};

const privateIpv6 = (hostname: string): boolean => {
  const words = ipv6Words(hostname);
  if (words === null) return false;
  const [first, second] = words;
  const embeddedIpv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
  const embeddedPrefix = words.slice(0, 5).every((word) => word === 0) &&
    (words[5] === 0 || words[5] === 0xffff);
  return (
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first & 0xe000) !== 0x2000 ||
    (first === 0x2001 && [0, 2, 0xdb8].includes(second)) ||
    (embeddedPrefix && privateIpv4(embeddedIpv4))
  );
};

export const isPrivateNetworkHost = (hostname: string): boolean => {
  const normalized = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLocaleLowerCase('en-US');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.lan') ||
    normalized.endsWith('.home') ||
    normalized === 'metadata.google.internal' ||
    normalized === '169.254.169.254' ||
    privateIpv4(normalized) ||
    privateIpv6(normalized)
  );
};

const normalizeUrl = (rawUrl: string, blockPrivateNetwork: boolean): SafeUrl => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      normalized: 'invalid-url',
      origin: 'invalid-url',
      target: `invalid:${hash(rawUrl)}`,
      forbiddenReason: 'invalid-url',
    };
  }
  parsed.hash = '';
  const protocolAllowed = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  const credentialsPresent = parsed.username !== '' || parsed.password !== '';
  const privateHost = blockPrivateNetwork && isPrivateNetworkHost(parsed.hostname);
  const forbiddenReason = !protocolAllowed
    ? 'unsupported-url-protocol'
    : credentialsPresent
      ? 'embedded-url-credentials'
      : privateHost
        ? 'private-network-target'
        : undefined;
  const normalized = parsed.toString();
  return {
    normalized,
    origin: parsed.origin,
    target: `${parsed.origin}:resource-${hash(`${parsed.pathname}${parsed.search}`)}`,
    forbiddenReason,
  };
};

const sensitiveHeader = (name: string): boolean =>
  /(authorization|cookie|token|api.?key|secret|credential)/i.test(name);

const basePlan = (
  risk: RiskLevel,
  targets: PermissionTarget[],
  preview: AgentJsonValue,
  fields: Partial<Omit<UnhashedEffectPlan, 'risk' | 'targets' | 'preview'>> = {},
): UnhashedEffectPlan => ({
  risk,
  targets,
  reads: fields.reads ?? [],
  writes: fields.writes ?? [],
  network: fields.network ?? [],
  externalEffects: fields.externalEffects ?? [],
  reversible: fields.reversible ?? false,
  preview,
  baseVersions: fields.baseVersions ?? {},
});

export class NodeFileSystemToolAdapter implements FileSystemToolAdapter {
  async inspect(filePath: string, signal: AbortSignal): Promise<FileInfo> {
    assertNotAborted(signal);
    try {
      const stats = await fs.lstat(filePath);
      assertNotAborted(signal);
      const kind: FileEntryKind = stats.isSymbolicLink()
        ? 'symlink'
        : stats.isFile()
          ? 'file'
          : stats.isDirectory()
            ? 'directory'
            : 'other';
      return {
        exists: true,
        kind,
        size: stats.size,
        version: `${stats.size}:${stats.mtimeMs}`,
        hardLinkCount: stats.nlink,
      };
    } catch (error) {
      if (isMissingError(error)) {
        return { exists: false, kind: 'other', size: 0, version: 'missing' };
      }
      throw error;
    }
  }

  async realpath(filePath: string, signal: AbortSignal): Promise<string> {
    assertNotAborted(signal);
    const resolved = await fs.realpath(filePath);
    assertNotAborted(signal);
    return resolved;
  }

  async readText(filePath: string, maxBytes: number, signal: AbortSignal): Promise<string> {
    const info = await this.inspect(filePath, signal);
    if (!info.exists || info.kind !== 'file') {
      throw new BuiltinToolError('NOT_A_FILE', 'The requested path is not a regular file.');
    }
    if (info.size > maxBytes) {
      throw new BuiltinToolError('FILE_TOO_LARGE', 'The requested file exceeds the read limit.');
    }
    const content = await fs.readFile(filePath, 'utf8');
    assertNotAborted(signal);
    if (Buffer.byteLength(content) > maxBytes) {
      throw new BuiltinToolError('FILE_TOO_LARGE', 'The requested file exceeds the read limit.');
    }
    return content;
  }

  async list(
    directoryPath: string,
    options: { recursive: boolean; maxEntries: number },
    signal: AbortSignal,
  ): Promise<FileListEntry[]> {
    const output: FileListEntry[] = [];
    const pending = [directoryPath];
    while (pending.length > 0 && output.length < options.maxEntries) {
      assertNotAborted(signal);
      const current = pending.shift();
      if (current === undefined) break;
      const entries = await fs.readdir(current, { withFileTypes: true });
      assertNotAborted(signal);
      for (const entry of entries) {
        assertNotAborted(signal);
        const entryPath = path.join(current, entry.name);
        const info = await this.inspect(entryPath, signal);
        output.push({
          path: entryPath,
          kind: info.kind,
          size: info.size,
          hardLinkCount: info.hardLinkCount,
        });
        if (output.length >= options.maxEntries) break;
        if (options.recursive && info.kind === 'directory') pending.push(entryPath);
      }
    }
    assertNotAborted(signal);
    return output;
  }

  async search(
    directoryPath: string,
    options: {
      query: string;
      filePattern: string | null;
      maxResults: number;
      maxFileBytes: number;
    },
    signal: AbortSignal,
  ): Promise<FileSearchMatch[]> {
    const matches: FileSearchMatch[] = [];
    const entries = await this.list(
      directoryPath,
      { recursive: true, maxEntries: 10_000 },
      signal,
    );
    const query = options.query.toLocaleLowerCase('en-US');
    const pattern = options.filePattern === null ? null : globPattern(options.filePattern);
    for (const entry of entries) {
      if (matches.length >= options.maxResults) break;
      if (
        entry.kind !== 'file' ||
        entry.size > options.maxFileBytes ||
        (entry.hardLinkCount ?? 1) > 1
      ) continue;
      const relative = path.relative(directoryPath, entry.path).split(path.sep).join('/');
      if (pattern !== null && !pattern.test(relative)) continue;
      let content: string;
      try {
        content = await this.readText(entry.path, options.maxFileBytes, signal);
      } catch (error) {
        if (signal.aborted) {
          throw new BuiltinToolError('ABORTED', 'The file search was stopped.');
        }
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const column = lines[lineIndex].toLocaleLowerCase('en-US').indexOf(query);
        if (column >= 0) {
          matches.push({
            path: entry.path,
            line: lineIndex + 1,
            column: column + 1,
            preview: lines[lineIndex].slice(0, 500),
          });
          if (matches.length >= options.maxResults) break;
        }
      }
    }
    assertNotAborted(signal);
    return matches;
  }

  async writeText(
    filePath: string,
    content: string,
    options: { overwrite: boolean; createParents: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    if (options.createParents) await fs.mkdir(path.dirname(filePath), { recursive: true });
    assertNotAborted(signal);
    await fs.writeFile(filePath, content, {
      encoding: 'utf8',
      flag: options.overwrite ? 'w' : 'wx',
    });
    assertNotAborted(signal);
  }

  async move(
    sourcePath: string,
    destinationPath: string,
    options: { overwrite: boolean; createParents: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    if (options.createParents) await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (options.overwrite) await fs.rm(destinationPath, { recursive: true, force: true });
    assertNotAborted(signal);
    await fs.rename(sourcePath, destinationPath);
    assertNotAborted(signal);
  }

  async remove(
    filePath: string,
    options: { recursive: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    await fs.rm(filePath, { recursive: options.recursive, force: false });
    assertNotAborted(signal);
  }
}

const globPattern = (pattern: string): RegExp => {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'i');
};

const safeTerminalEnvironment = (): NodeJS.ProcessEnv => {
  const sensitiveName =
    /(api.?key|token|secret|password|credential|cookie|authorization|private.?key)/i;
  const injectionVariables = new Set([
    'BASH_ENV',
    'ENV',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS',
    'PERL5OPT',
    'PYTHONPATH',
    'RUBYOPT',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !sensitiveName.test(name) && !injectionVariables.has(name.toLocaleUpperCase('en-US')),
    ),
  );
};

export class NodeTerminalToolAdapter implements TerminalToolAdapter {
  async run(input: TerminalRunInput, signal: AbortSignal): Promise<TerminalRunOutput> {
    assertNotAborted(signal);
    return new Promise<TerminalRunOutput>((resolve, reject) => {
      const child = spawn(input.executable, input.arguments, {
        cwd: input.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: safeTerminalEnvironment(),
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let truncated = false;
      let settled = false;

      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        operation();
      };
      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (bytes >= input.maxOutputBytes) {
          truncated = true;
          return;
        }
        const remaining = input.maxOutputBytes - bytes;
        const selected = chunk.subarray(0, remaining);
        bytes += selected.byteLength;
        if (selected.byteLength < chunk.byteLength) truncated = true;
        if (target === 'stdout') stdout += selected.toString('utf8');
        else stderr += selected.toString('utf8');
      };
      const abort = (): void => {
        child.kill();
        finish(() => reject(new BuiltinToolError('ABORTED', 'The terminal command was stopped.')));
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new BuiltinToolError('COMMAND_TIMEOUT', 'The terminal command timed out.')));
      }, input.timeoutMs);

      signal.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error) => finish(() => reject(error)));
      child.once('close', (exitCode) =>
        finish(() => resolve({ exitCode, stdout, stderr, truncated })),
      );
      if (signal.aborted) abort();
    });
  }
}

const assertPublicHostname = async (hostname: string): Promise<void> => {
  if (isPrivateNetworkHost(hostname)) {
    throw new BuiltinToolError('PRIVATE_NETWORK_BLOCKED', 'Private network requests are blocked.');
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateNetworkHost(entry.address))) {
    throw new BuiltinToolError('PRIVATE_NETWORK_BLOCKED', 'Private network requests are blocked.');
  }
};

export class NodeHttpFetchToolAdapter implements HttpFetchToolAdapter {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly hostGuard: (hostname: string) => Promise<void> = assertPublicHostname,
  ) {}

  async fetch(
    input: {
      url: string;
      method: 'GET' | 'HEAD';
      headers: HttpHeader[];
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<HttpFetchOutput> {
    const current = new URL(input.url);
    assertNotAborted(signal);
    const safe = normalizeUrl(current.toString(), true);
    if (safe.forbiddenReason !== undefined) {
      throw new BuiltinToolError('FORBIDDEN_URL', 'The HTTP target is not permitted.');
    }
    await this.hostGuard(current.hostname);
    const response = await this.fetchFn(current, {
      method: input.method,
      headers: new Headers(input.headers.map((header) => [header.name, header.value])),
      redirect: 'manual',
      signal,
    });
    const { body, truncated } = await readResponseBody(response, input.maxBytes, signal);
    const location = response.headers.get('location');
    return {
      status: response.status,
      statusText: response.statusText,
      finalUrl: current.toString(),
      contentType: response.headers.get('content-type'),
      body,
      truncated,
      redirectUrl: location === null ? null : new URL(location, current).toString(),
    };
  }
}

const readResponseBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: string; truncated: boolean }> => {
  if (response.body === null) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    assertNotAborted(signal);
    const next = await reader.read();
    if (next.done) break;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const selected = next.value.subarray(0, remaining);
    chunks.push(selected);
    bytes += selected.byteLength;
    if (selected.byteLength < next.value.byteLength) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(combined), truncated };
};

export class BuiltinToolExecutors {
  private readonly fileSystem: FileSystemToolAdapter;
  private readonly terminal: TerminalToolAdapter;
  private readonly paths: SecurePathResolver;
  private readonly terminalMaxOutputBytes: number;

  constructor(private readonly options: BuiltinToolExecutorOptions) {
    this.fileSystem = options.adapters?.fileSystem ?? new NodeFileSystemToolAdapter();
    this.terminal = options.adapters?.terminal ?? new NodeTerminalToolAdapter();
    this.paths = new SecurePathResolver(
      options.allowedRoots,
      this.fileSystem,
      options.platform ?? process.platform,
    );
    this.terminalMaxOutputBytes = options.terminalMaxOutputBytes ?? 256 * 1024;
  }

  async analyzeFileRead(args: FileReadArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, signal);
    const underlyingRisk: RiskLevel =
      resolved.info.kind === 'file' && (resolved.info.hardLinkCount ?? 1) <= 1 ? 'R0' : 'R4';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [fileTarget(resolved)],
      {
        action: 'file.read',
        path: safePreviewPath(resolved),
        maxBytes: args.maxBytes,
        dryRun: args.dryRun,
        permitted: underlyingRisk !== 'R4',
      },
      {
        reads: [resolved.path],
        reversible: true,
        baseVersions: { [resolved.path]: resolved.info.version },
      },
    );
  }

  async executeFileRead(args: FileReadArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, context.signal);
    if (resolved.info.kind !== 'file' || (resolved.info.hardLinkCount ?? 1) > 1) {
      throw new BuiltinToolError('NOT_A_FILE', 'The path is not a permitted regular file.');
    }
    if (args.dryRun) return result(context, { dryRun: true, path: safePreviewPath(resolved) });
    const content = await this.fileSystem.readText(resolved.path, args.maxBytes, context.signal);
    assertNotAborted(context.signal);
    return result(context, { path: safePreviewPath(resolved), content, bytes: Buffer.byteLength(content) });
  }

  async analyzeFileList(args: FileListArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, signal);
    const underlyingRisk: RiskLevel = resolved.info.kind === 'directory' ? 'R0' : 'R4';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [fileTarget(resolved)],
      {
        action: 'file.list',
        path: safePreviewPath(resolved),
        recursive: args.recursive,
        maxEntries: args.maxEntries,
        dryRun: args.dryRun,
        permitted: underlyingRisk !== 'R4',
      },
      { reads: [resolved.path], reversible: true },
    );
  }

  async executeFileList(args: FileListArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, context.signal);
    if (resolved.info.kind !== 'directory') throw new BuiltinToolError('NOT_A_DIRECTORY', 'The path is not a directory.');
    if (args.dryRun) return result(context, { dryRun: true, path: safePreviewPath(resolved) });
    const entries = await this.fileSystem.list(
      resolved.path,
      { recursive: args.recursive, maxEntries: args.maxEntries },
      context.signal,
    );
    assertNotAborted(context.signal);
    return result(context, {
      path: safePreviewPath(resolved),
      entries: entries.map((entry) => ({
        path: path.relative(resolved.root, entry.path).split(path.sep).join('/'),
        kind: entry.kind,
        size: entry.size,
      })),
      truncated: entries.length >= args.maxEntries,
    });
  }

  async analyzeFileSearch(args: FileSearchArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, signal);
    const underlyingRisk: RiskLevel = resolved.info.kind === 'directory' ? 'R0' : 'R4';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [fileTarget(resolved)],
      {
        action: 'file.search',
        path: safePreviewPath(resolved),
        queryLength: args.query.length,
        queryDigest: hash(args.query),
        filePattern: args.filePattern,
        maxResults: args.maxResults,
        dryRun: args.dryRun,
        permitted: underlyingRisk !== 'R4',
      },
      { reads: [resolved.path], reversible: true },
    );
  }

  async executeFileSearch(args: FileSearchArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, context.signal);
    if (resolved.info.kind !== 'directory') throw new BuiltinToolError('NOT_A_DIRECTORY', 'The path is not a directory.');
    if (args.dryRun) return result(context, { dryRun: true, path: safePreviewPath(resolved) });
    const matches = await this.fileSystem.search(
      resolved.path,
      {
        query: args.query,
        filePattern: args.filePattern,
        maxResults: args.maxResults,
        maxFileBytes: args.maxFileBytes,
      },
      context.signal,
    );
    assertNotAborted(context.signal);
    return result(context, {
      matches: matches.map((match) => ({
        path: path.relative(resolved.root, match.path).split(path.sep).join('/'),
        line: match.line,
        column: match.column,
        preview: match.preview,
      })),
      truncated: matches.length >= args.maxResults,
    });
  }

  async analyzeFileWrite(args: FileWriteArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const resolved = await this.paths.resolve(args.path, { mustExist: false }, signal);
    const forbidden =
      resolved.isRoot ||
      resolved.containsSymlink ||
      (resolved.info.hardLinkCount ?? 1) > 1 ||
      (resolved.info.exists && resolved.info.kind !== 'file');
    const underlyingRisk: RiskLevel = forbidden ? 'R4' : args.overwrite ? 'R2' : 'R1';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [fileTarget(resolved)],
      {
        action: 'file.write',
        path: safePreviewPath(resolved),
        bytes: Buffer.byteLength(args.content),
        overwrite: args.overwrite,
        existed: resolved.info.exists,
        dryRun: args.dryRun,
        permitted: !forbidden && (!resolved.info.exists || args.overwrite),
      },
      {
        writes: args.dryRun ? [] : [resolved.path],
        reversible: !resolved.info.exists,
        baseVersions: { [resolved.path]: resolved.info.version },
      },
    );
  }

  async executeFileWrite(args: FileWriteArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const resolved = await this.paths.resolve(args.path, { mustExist: false }, context.signal);
    if (
      resolved.isRoot ||
      resolved.containsSymlink ||
      (resolved.info.hardLinkCount ?? 1) > 1 ||
      (resolved.info.exists && resolved.info.kind !== 'file')
    ) {
      throw new BuiltinToolError('FORBIDDEN_FILE_WRITE', 'The requested file write is forbidden.');
    }
    if (resolved.info.exists && !args.overwrite) {
      throw new BuiltinToolError('FILE_EXISTS', 'The destination already exists.');
    }
    if (args.dryRun) return result(context, { dryRun: true, path: safePreviewPath(resolved) });
    await this.fileSystem.writeText(
      resolved.path,
      args.content,
      { overwrite: args.overwrite, createParents: args.createParents },
      context.signal,
    );
    assertNotAborted(context.signal);
    return result(context, { path: safePreviewPath(resolved), bytes: Buffer.byteLength(args.content) });
  }

  async analyzeFileMove(args: FileMoveArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const source = await this.paths.resolve(args.source, { mustExist: true }, signal);
    const destination = await this.paths.resolve(args.destination, { mustExist: false }, signal);
    if (pathEquals(source.path, destination.path, this.options.platform ?? process.platform)) {
      throw new BuiltinToolError('SAME_PATH', 'Move source and destination must differ.');
    }
    const forbidden =
      source.isRoot ||
      destination.isRoot ||
      source.containsSymlink ||
      destination.containsSymlink;
    const underlyingRisk: RiskLevel = forbidden ? 'R4' : args.overwrite ? 'R3' : 'R1';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [fileTarget(source), fileTarget(destination)],
      {
        action: 'file.move',
        source: safePreviewPath(source),
        destination: safePreviewPath(destination),
        overwrite: args.overwrite,
        destinationExists: destination.info.exists,
        dryRun: args.dryRun,
        permitted: !forbidden && (!destination.info.exists || args.overwrite),
      },
      {
        reads: [source.path],
        writes: args.dryRun ? [] : [source.path, destination.path],
        reversible: !destination.info.exists,
        baseVersions: {
          [source.path]: source.info.version,
          [destination.path]: destination.info.version,
        },
      },
    );
  }

  async executeFileMove(args: FileMoveArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const source = await this.paths.resolve(args.source, { mustExist: true }, context.signal);
    const destination = await this.paths.resolve(args.destination, { mustExist: false }, context.signal);
    if (
      source.isRoot ||
      destination.isRoot ||
      source.containsSymlink ||
      destination.containsSymlink
    ) {
      throw new BuiltinToolError('FORBIDDEN_FILE_MOVE', 'Moving an allowed root is forbidden.');
    }
    if (destination.info.exists && !args.overwrite) {
      throw new BuiltinToolError('FILE_EXISTS', 'The move destination already exists.');
    }
    if (args.dryRun) return result(context, { dryRun: true, source: safePreviewPath(source), destination: safePreviewPath(destination) });
    await this.fileSystem.move(
      source.path,
      destination.path,
      { overwrite: args.overwrite, createParents: args.createParents },
      context.signal,
    );
    assertNotAborted(context.signal);
    return result(context, { source: safePreviewPath(source), destination: safePreviewPath(destination) });
  }

  async analyzeFileDelete(args: FileDeleteArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, signal);
    const recursiveDirectory = resolved.info.kind === 'directory' && !args.recursive;
    const underlyingRisk: RiskLevel =
      resolved.isRoot || resolved.containsSymlink || recursiveDirectory ? 'R4' : 'R3';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [fileTarget(resolved)],
      {
        action: 'file.delete',
        path: safePreviewPath(resolved),
        kind: resolved.info.kind,
        recursive: args.recursive,
        dryRun: args.dryRun,
        permitted: underlyingRisk !== 'R4',
      },
      {
        writes: args.dryRun ? [] : [resolved.path],
        reversible: false,
        baseVersions: { [resolved.path]: resolved.info.version },
      },
    );
  }

  async executeFileDelete(args: FileDeleteArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const resolved = await this.paths.resolve(args.path, { mustExist: true }, context.signal);
    if (
      resolved.isRoot ||
      resolved.containsSymlink ||
      (resolved.info.kind === 'directory' && !args.recursive)
    ) {
      throw new BuiltinToolError('FORBIDDEN_FILE_DELETE', 'The requested delete is forbidden.');
    }
    if (args.dryRun) return result(context, { dryRun: true, path: safePreviewPath(resolved) });
    await this.fileSystem.remove(resolved.path, { recursive: args.recursive }, context.signal);
    assertNotAborted(context.signal);
    return result(context, { path: safePreviewPath(resolved), deleted: true });
  }

  async analyzeTerminalRun(args: TerminalRunArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const cwd = await this.paths.resolve(args.cwd, { mustExist: true }, signal);
    const initialClassification = classifyTerminalCommand(args.executable, args.arguments);
    const argumentsWithinRoots = await this.terminalArgumentsStayInsideRoots(
      args.arguments,
      signal,
    );
    const classification: CommandClassification = argumentsWithinRoots
      ? initialClassification
      : {
          ...initialClassification,
          risk: 'R4',
          reason: 'command-path-escapes-allowed-roots',
        };
    const risk = dryRunRisk(classification.risk, args.dryRun);
    return basePlan(
      risk,
      [
        { kind: 'command', value: classification.target },
        fileTarget(cwd),
      ],
      {
        action: 'terminal.run',
        executable: classification.executable,
        argumentCount: args.arguments.length,
        commandDigest: classification.target.split(':').at(-1) ?? classification.target,
        cwd: safePreviewPath(cwd),
        timeoutMs: args.timeoutMs,
        classifiedRisk: classification.risk,
        reason: classification.reason,
        dryRun: args.dryRun,
        permitted: classification.risk !== 'R4',
      },
      {
        reads: [cwd.path],
        writes: risk === 'R0' || args.dryRun ? [] : [cwd.path],
        network: classification.risk === 'R3' ? [classification.target] : [],
        externalEffects: classification.risk === 'R3' ? ['terminal-network-or-publish'] : [],
        reversible: classification.risk === 'R0',
      },
    );
  }

  async executeTerminalRun(args: TerminalRunArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const cwd = await this.paths.resolve(args.cwd, { mustExist: true }, context.signal);
    if (cwd.info.kind !== 'directory') throw new BuiltinToolError('NOT_A_DIRECTORY', 'The command working directory is invalid.');
    const initialClassification = classifyTerminalCommand(args.executable, args.arguments);
    const argumentsWithinRoots = await this.terminalArgumentsStayInsideRoots(
      args.arguments,
      context.signal,
    );
    const classification: CommandClassification = argumentsWithinRoots
      ? initialClassification
      : {
          ...initialClassification,
          risk: 'R4',
          reason: 'command-path-escapes-allowed-roots',
        };
    if (classification.risk === 'R4') {
      throw new BuiltinToolError('FORBIDDEN_COMMAND', 'The requested terminal command is forbidden.');
    }
    if (args.dryRun) {
      return result(context, { dryRun: true, executable: classification.executable, commandDigest: classification.target });
    }
    const output = await this.terminal.run(
      {
        executable: args.executable,
        arguments: [...args.arguments],
        cwd: cwd.path,
        timeoutMs: args.timeoutMs,
        maxOutputBytes: this.terminalMaxOutputBytes,
      },
      context.signal,
    );
    return result(
      context,
      {
        exitCode: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
      },
      output.exitCode === 0 ? 'ok' : 'failed',
    );
  }

  analyzeClipboardRead(args: ClipboardReadArguments): UnhashedEffectPlan {
    return basePlan(
      dryRunRisk('R2', args.dryRun),
      [{ kind: 'app', value: 'system-clipboard' }],
      { action: 'clipboard.read', dryRun: args.dryRun },
      { reads: ['system-clipboard'], reversible: true },
    );
  }

  async executeClipboardRead(args: ClipboardReadArguments, context: ToolExecutionContext): Promise<ToolResult> {
    assertNotAborted(context.signal);
    if (args.dryRun) return result(context, { dryRun: true });
    const adapter = this.requireAdapter(this.options.adapters?.clipboard, 'CLIPBOARD_UNAVAILABLE');
    const text = await adapter.readText(context.signal);
    assertNotAborted(context.signal);
    return result(context, { text });
  }

  analyzeClipboardWrite(args: ClipboardWriteArguments): UnhashedEffectPlan {
    return basePlan(
      dryRunRisk('R1', args.dryRun),
      [{ kind: 'app', value: 'system-clipboard' }],
      {
        action: 'clipboard.write',
        characters: args.text.length,
        dryRun: args.dryRun,
      },
      {
        writes: args.dryRun ? [] : ['system-clipboard'],
        externalEffects: args.dryRun ? [] : ['clipboard-changed'],
        reversible: true,
      },
    );
  }

  async executeClipboardWrite(args: ClipboardWriteArguments, context: ToolExecutionContext): Promise<ToolResult> {
    assertNotAborted(context.signal);
    if (args.dryRun) return result(context, { dryRun: true, characters: args.text.length });
    const adapter = this.requireAdapter(this.options.adapters?.clipboard, 'CLIPBOARD_UNAVAILABLE');
    await adapter.writeText(args.text, context.signal);
    assertNotAborted(context.signal);
    return result(context, { characters: args.text.length });
  }

  async analyzeScreenCapture(args: ScreenCaptureArguments, signal = new AbortController().signal): Promise<UnhashedEffectPlan> {
    const savePath = args.savePath === null
      ? null
      : await this.paths.resolve(args.savePath, { mustExist: false }, signal);
    const forbidden = savePath === null
      ? false
      : savePath.isRoot || savePath.containsSymlink || savePath.info.exists;
    const underlyingRisk: RiskLevel = forbidden ? 'R4' : 'R2';
    const targets: PermissionTarget[] = [
      { kind: 'app', value: `screen:${args.displayId ?? 'primary'}` },
    ];
    if (savePath !== null) targets.push(fileTarget(savePath));
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      targets,
      {
        action: 'screen.capture',
        displayId: args.displayId,
        includeCursor: args.includeCursor,
        savePath: savePath === null ? null : safePreviewPath(savePath),
        dryRun: args.dryRun,
        permitted: !forbidden,
      },
      {
        reads: ['screen'],
        writes: args.dryRun || savePath === null ? [] : [savePath.path],
        externalEffects: args.dryRun ? [] : ['screen-captured'],
        reversible: savePath === null || !savePath.info.exists,
      },
    );
  }

  async executeScreenCapture(args: ScreenCaptureArguments, context: ToolExecutionContext): Promise<ToolResult> {
    const savePath = args.savePath === null
      ? null
      : await this.paths.resolve(args.savePath, { mustExist: false }, context.signal);
    if (
      savePath !== null &&
      (savePath.isRoot || savePath.containsSymlink || savePath.info.exists)
    ) {
      throw new BuiltinToolError('FORBIDDEN_SCREEN_PATH', 'The screenshot destination is forbidden.');
    }
    if (args.dryRun) return result(context, { dryRun: true, savePath: savePath === null ? null : safePreviewPath(savePath) });
    const adapter = this.requireAdapter(this.options.adapters?.screenCapture, 'SCREEN_CAPTURE_UNAVAILABLE');
    const captured = await adapter.capture(
      {
        displayId: args.displayId,
        includeCursor: args.includeCursor,
        savePath: savePath?.path ?? null,
        mustCreate: true,
      },
      context.signal,
    );
    assertNotAborted(context.signal);
    return result(context, {
      artifactId: captured.artifactId,
      mimeType: captured.mimeType,
      width: captured.width,
      height: captured.height,
      bytes: captured.bytes,
      savedPath: savePath === null ? null : safePreviewPath(savePath),
    });
  }

  analyzeUrlOpen(args: UrlOpenArguments): UnhashedEffectPlan {
    const safe = normalizeUrl(args.url, false);
    const underlyingRisk: RiskLevel = safe.forbiddenReason === undefined ? 'R2' : 'R4';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [
        { kind: 'origin', value: safe.origin },
        { kind: 'network', value: safe.target },
      ],
      {
        action: 'url.open',
        origin: safe.origin,
        targetDigest: hash(safe.target),
        dryRun: args.dryRun,
        permitted: safe.forbiddenReason === undefined,
        reason: safe.forbiddenReason ?? null,
      },
      {
        externalEffects: args.dryRun ? [] : ['external-url-opened'],
        reversible: true,
      },
    );
  }

  async executeUrlOpen(args: UrlOpenArguments, context: ToolExecutionContext): Promise<ToolResult> {
    assertNotAborted(context.signal);
    const safe = normalizeUrl(args.url, false);
    if (safe.forbiddenReason !== undefined) throw new BuiltinToolError('FORBIDDEN_URL', 'The requested URL is forbidden.');
    if (args.dryRun) return result(context, { dryRun: true, origin: safe.origin });
    const adapter = this.requireAdapter(this.options.adapters?.urlOpener, 'URL_OPENER_UNAVAILABLE');
    await adapter.open(safe.normalized, context.signal);
    assertNotAborted(context.signal);
    return result(context, { opened: true, origin: safe.origin });
  }

  analyzeHttpFetch(args: HttpFetchArguments): UnhashedEffectPlan {
    const safe = normalizeUrl(args.url, true);
    const hasSensitiveHeaders = args.headers.some((header) => sensitiveHeader(header.name));
    const underlyingRisk: RiskLevel = safe.forbiddenReason !== undefined
      ? 'R4'
      : hasSensitiveHeaders
        ? 'R2'
        : 'R1';
    return basePlan(
      dryRunRisk(underlyingRisk, args.dryRun),
      [
        { kind: 'origin', value: safe.origin },
        { kind: 'network', value: safe.target },
      ],
      {
        action: 'http.fetch',
        method: args.method,
        origin: safe.origin,
        targetDigest: hash(safe.target),
        headerCount: args.headers.length,
        sensitiveHeaderCount: args.headers.filter((header) => sensitiveHeader(header.name)).length,
        maxBytes: args.maxBytes,
        dryRun: args.dryRun,
        permitted: safe.forbiddenReason === undefined,
        reason: safe.forbiddenReason ?? null,
      },
      {
        network: args.dryRun ? [] : [safe.target],
        externalEffects: args.dryRun ? [] : ['http-request'],
        reversible: true,
      },
    );
  }

  async executeHttpFetch(args: HttpFetchArguments, context: ToolExecutionContext): Promise<ToolResult> {
    assertNotAborted(context.signal);
    const safe = normalizeUrl(args.url, true);
    if (safe.forbiddenReason !== undefined) throw new BuiltinToolError('FORBIDDEN_URL', 'The HTTP target is forbidden.');
    if (args.dryRun) return result(context, { dryRun: true, origin: safe.origin });
    const adapter = this.options.adapters?.httpFetch ?? new NodeHttpFetchToolAdapter();
    const response = await adapter.fetch(
      { url: safe.normalized, method: args.method, headers: args.headers, maxBytes: args.maxBytes },
      context.signal,
    );
    assertNotAborted(context.signal);
    return result(context, {
      status: response.status,
      statusText: response.statusText,
      finalUrl: response.finalUrl,
      contentType: response.contentType,
      body: response.body,
      truncated: response.truncated,
      redirectUrl: response.redirectUrl ?? null,
    });
  }

  analyzeWebSearch(args: WebSearchArguments): UnhashedEffectPlan {
    const providerId = this.options.adapters?.webSearch?.providerId ?? 'unconfigured';
    const target = `search:${providerId}`;
    return basePlan(
      dryRunRisk('R1', args.dryRun),
      [{ kind: 'network', value: target }],
      {
        action: 'web.search',
        providerId,
        queryLength: args.query.length,
        maxResults: args.maxResults,
        dryRun: args.dryRun,
      },
      {
        network: args.dryRun ? [] : [target],
        externalEffects: args.dryRun ? [] : ['web-search-request'],
        reversible: true,
      },
    );
  }

  async executeWebSearch(args: WebSearchArguments, context: ToolExecutionContext): Promise<ToolResult> {
    assertNotAborted(context.signal);
    if (args.dryRun) return result(context, { dryRun: true, providerId: this.options.adapters?.webSearch?.providerId ?? 'unconfigured' });
    const adapter = this.requireAdapter(this.options.adapters?.webSearch, 'WEB_SEARCH_UNAVAILABLE');
    const entries = await adapter.search(args.query, args.maxResults, context.signal);
    assertNotAborted(context.signal);
    return result(context, {
      providerId: adapter.providerId,
      results: entries.slice(0, args.maxResults).map((entry) => ({
        title: entry.title,
        url: entry.url,
        snippet: entry.snippet,
      })),
    });
  }

  private requireAdapter<T>(adapter: T | undefined, code: string): T {
    if (adapter === undefined) {
      throw new BuiltinToolError(code, 'This platform capability is not configured.');
    }
    return adapter;
  }

  private async terminalArgumentsStayInsideRoots(
    args: string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    for (const rawArgument of args) {
      assertNotAborted(signal);
      let candidate = rawArgument;
      const equalsIndex = candidate.indexOf('=');
      if (equalsIndex >= 0) candidate = candidate.slice(equalsIndex + 1);
      if (candidate.startsWith('@')) candidate = candidate.slice(1);
      if (/^https?:\/\//i.test(candidate)) continue;
      if (/^file:/i.test(candidate)) return false;
      const pathSegments = candidate.split(/[\\/]+/);
      const suspicious =
        path.isAbsolute(candidate) ||
        path.posix.isAbsolute(candidate) ||
        path.win32.isAbsolute(candidate) ||
        pathSegments.includes('..');
      if (!suspicious) continue;
      if (path.win32.isAbsolute(candidate) && process.platform !== 'win32') return false;
      try {
        await this.paths.resolve(candidate, { mustExist: false }, signal);
      } catch (error) {
        if (error instanceof BuiltinToolError) return false;
        throw error;
      }
    }
    return true;
  }
}
