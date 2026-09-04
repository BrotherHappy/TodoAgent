import { describe, expect, it } from 'vitest';
import { createOllamaFetchAdapter, ollamaChatUrl } from '../electron/agent/ollama-adapter';
import { OpenAIChatCompletionsGateway } from '../electron/agent/model-gateway';

describe('Ollama native chat adapter', () => {
  it.each(['http://localhost:11434', 'http://localhost:11434/v1', 'http://localhost:11434/api/chat'])('normalizes %s without duplicating API paths', value => {
    expect(ollamaChatUrl(value).toString()).toBe('http://localhost:11434/api/chat');
  });
  it('preserves a reverse proxy prefix and rejects embedded credentials', () => {
    expect(ollamaChatUrl('https://models.test/ollama/v1').pathname).toBe('/ollama/api/chat');
    expect(() => ollamaChatUrl('https://user:secret@models.test')).toThrow();
  });
  it('streams UTF-8 text, supplies real usage and never invents an API key', async () => {
    let sent: any;
    const encoder = new TextEncoder();
    const wire = [
      { message: { content: '你好，' }, done: false },
      { message: { content: '一起开始吧。' }, done: false },
      { message: { content: '' }, done: true, prompt_eval_count: 12, eval_count: 8 },
    ].map(frame => JSON.stringify(frame)).join('\n') + '\n';
    const gateway = new OpenAIChatCompletionsGateway({ baseUrl: 'http://localhost:11434', model: 'local-model', authentication: 'none', retries: 0,
      fetch: createOllamaFetchAdapter('http://localhost:11434', async (url, init) => {
        expect(String(url)).toBe('http://localhost:11434/api/chat');
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        sent = JSON.parse(String(init?.body));
        const bytes = encoder.encode(wire);
        return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }));
      }),
    });
    const deltas: string[] = [];
    const result = await gateway.complete({ messages: [{ role: 'developer', content: '安全边界' }, { role: 'user', content: '你好' }], tools: [] }, undefined, delta => deltas.push(delta));
    expect(deltas.join('')).toBe('你好，一起开始吧。');
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 8, totalTokens: 20 });
    expect(sent.messages[0]).toMatchObject({ role: 'system', content: '安全边界' });
    expect(sent.stream).toBe(true);
  });
  it('maps native tool arguments and base64 vision inputs without executing anything', async () => {
    const adapter = createOllamaFetchAdapter('http://127.0.0.1:11434', async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.messages[0].images).toEqual(['YWJj']);
      expect(sent.messages[0].content).toBe('看选区');
      return Response.json({ message: { content: '', tool_calls: [{ function: { name: 'task_list', arguments: { view: 'today' } } }] }, done: true, prompt_eval_count: 2, eval_count: 3 });
    });
    const result = await adapter('', { body: JSON.stringify({ model: 'vision', stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: '看选区' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] }] }) });
    const output = await result.json();
    expect(output.choices[0].message.tool_calls[0].function).toEqual({ name: 'task_list', arguments: '{"view":"today"}' });
    expect(output.choices[0].finish_reason).toBe('tool_calls');
  });
  it('rejects a disconnected stream instead of reporting a completed operation', async () => {
    const adapter = createOllamaFetchAdapter('http://localhost:11434', async () => new Response('{"message":{"content":"部分"},"done":false}\n'));
    const result = await adapter('', { body: JSON.stringify({ model: 'local', stream: true, messages: [] }) });
    await expect(result.text()).rejects.toThrow('提前结束');
  });
});
