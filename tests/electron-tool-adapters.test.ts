import { describe, expect, it, vi } from 'vitest';
import { DuckDuckGoSearchToolAdapter } from '../electron/agent/electron-tool-adapters';

describe('DuckDuckGoSearchToolAdapter', () => {
  it('normalizes bounded public results', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      Heading: 'Todo',
      AbstractURL: 'https://example.com/todo',
      AbstractText: 'Task management overview',
      RelatedTopics: [
        { FirstURL: 'https://example.com/one', Text: 'One - result' },
        { Topics: [{ FirstURL: 'https://example.com/two', Text: 'Two - result' }] },
      ],
    }), { status: 200 })) as unknown as typeof fetch;
    const adapter = new DuckDuckGoSearchToolAdapter(fetchFn);
    const results = await adapter.search('todo', 2, new AbortController().signal);
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe('https://example.com/todo');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('forwards cancellation to the network adapter', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(new DuckDuckGoSearchToolAdapter(fetchFn).search('x', 1, controller.signal)).rejects.toThrow();
  });

  it('drops malformed or non-web abstract URLs returned by the provider', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      Heading: 'Unsafe',
      AbstractURL: 'javascript:alert(1)',
      AbstractText: 'Must not be surfaced',
      RelatedTopics: [{ FirstURL: 'https://example.com/safe', Text: 'Safe - result' }],
    }), { status: 200 })) as unknown as typeof fetch;

    const results = await new DuckDuckGoSearchToolAdapter(fetchFn)
      .search('safe', 10, new AbortController().signal);

    expect(results).toEqual([expect.objectContaining({ url: 'https://example.com/safe' })]);
  });

  it('stops reading a provider response once the byte limit is exceeded', async () => {
    const fetchFn = vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), {
      status: 200,
    })) as unknown as typeof fetch;

    await expect(new DuckDuckGoSearchToolAdapter(fetchFn)
      .search('large', 1, new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_SEARCH_RESPONSE_TOO_LARGE' });
  });
});
