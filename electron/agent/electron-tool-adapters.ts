import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import {
  clipboard,
  desktopCapturer,
  shell,
} from 'electron';
import type {
  BuiltinToolAdapters,
  ClipboardToolAdapter,
  ScreenCaptureOutput,
  ScreenCaptureToolAdapter,
  UrlOpenerToolAdapter,
  WebSearchResult,
  WebSearchToolAdapter,
} from './tool-executors';

class ElectronToolAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = code;
  }
}

const adapterError = (code: string): ElectronToolAdapterError =>
  new ElectronToolAdapterError(code);

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw adapterError('ABORTED');
};

const readBoundedText = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw adapterError('WEB_SEARCH_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

export class ElectronClipboardToolAdapter implements ClipboardToolAdapter {
  async readText(signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    return clipboard.readText();
  }

  async writeText(text: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    clipboard.writeText(text);
    throwIfAborted(signal);
  }
}

export class ElectronUrlOpenerToolAdapter implements UrlOpenerToolAdapter {
  async open(url: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await shell.openExternal(url, { activate: true });
    throwIfAborted(signal);
  }
}

export class ElectronScreenCaptureToolAdapter implements ScreenCaptureToolAdapter {
  async capture(
    input: { displayId: string | null; includeCursor: boolean; savePath: string | null; mustCreate: true },
    signal: AbortSignal,
  ): Promise<ScreenCaptureOutput> {
    throwIfAborted(signal);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 2_560, height: 1_440 },
      fetchWindowIcons: false,
    });
    throwIfAborted(signal);
    const selected = input.displayId
      ? sources.find((source) => source.display_id === input.displayId || source.id === input.displayId)
      : sources[0];
    if (!selected || selected.thumbnail.isEmpty()) throw adapterError('SCREEN_CAPTURE_UNAVAILABLE');
    const size = selected.thumbnail.getSize();
    const buffer = selected.thumbnail.toPNG();
    if (input.savePath) {
      const handle = await open(input.savePath, input.mustCreate ? 'wx' : 'w', 0o600);
      try {
        throwIfAborted(signal);
        await handle.writeFile(buffer);
        await handle.sync();
        throwIfAborted(signal);
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (input.mustCreate) await unlink(input.savePath).catch(() => undefined);
        throw error;
      }
      await handle.close();
    }
    return {
      artifactId: `screen_${randomUUID()}`,
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
      bytes: buffer.byteLength,
      savedPath: input.savePath,
    };
  }
}

interface DuckRelatedTopic {
  FirstURL?: unknown;
  Text?: unknown;
  Name?: unknown;
  Topics?: unknown;
}

const flattenTopics = (value: unknown, output: WebSearchResult[]): void => {
  if (!Array.isArray(value)) return;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const topic = raw as DuckRelatedTopic;
    if (Array.isArray(topic.Topics)) {
      flattenTopics(topic.Topics, output);
      continue;
    }
    if (typeof topic.FirstURL !== 'string' || typeof topic.Text !== 'string') continue;
    let url: URL;
    try { url = new URL(topic.FirstURL); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    output.push({
      title: typeof topic.Name === 'string' && topic.Name.trim() ? topic.Name : topic.Text.split(' - ')[0].slice(0, 160),
      url: url.toString(),
      snippet: topic.Text.slice(0, 600),
    });
  }
};

export class DuckDuckGoSearchToolAdapter implements WebSearchToolAdapter {
  readonly providerId = 'duckduckgo-instant-answer';

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]> {
    throwIfAborted(signal);
    const endpoint = new URL('https://api.duckduckgo.com/');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('format', 'json');
    endpoint.searchParams.set('no_html', '1');
    endpoint.searchParams.set('no_redirect', '1');
    endpoint.searchParams.set('skip_disambig', '0');
    const response = await this.fetchFn(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    throwIfAborted(signal);
    if (!response.ok) throw adapterError(`WEB_SEARCH_HTTP_${response.status}`);
    const text = await readBoundedText(response, 2 * 1024 * 1024, signal);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw adapterError('WEB_SEARCH_INVALID_RESPONSE');
    }
    const results: WebSearchResult[] = [];
    if (typeof payload.AbstractURL === 'string' && typeof payload.AbstractText === 'string' && payload.AbstractURL && payload.AbstractText) {
      try {
        const abstractUrl = new URL(payload.AbstractURL);
        if (abstractUrl.protocol === 'https:' || abstractUrl.protocol === 'http:') {
          results.push({
            title: typeof payload.Heading === 'string' && payload.Heading ? payload.Heading : query,
            url: abstractUrl.toString(),
            snippet: payload.AbstractText.slice(0, 600),
          });
        }
      } catch {
        // Ignore malformed provider URLs.
      }
    }
    flattenTopics(payload.RelatedTopics, results);
    return results.slice(0, maxResults);
  }
}

export const createElectronToolAdapters = (): BuiltinToolAdapters => ({
  clipboard: new ElectronClipboardToolAdapter(),
  screenCapture: new ElectronScreenCaptureToolAdapter(),
  urlOpener: new ElectronUrlOpenerToolAdapter(),
  webSearch: new DuckDuckGoSearchToolAdapter(),
});
