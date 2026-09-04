// Native /api/chat adapter. Reuses the existing gateway's authentication,
// cancellation, timeout, usage accounting and no-retry-after-output rules.
import { randomUUID } from 'node:crypto';
import type { FetchLike } from './model-gateway';

export function ollamaChatUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Ollama 地址必须为不含凭据的 HTTP(S) 地址');
  const prefix = url.pathname.replace(/\/+$/u, '').replace(/\/(?:v1(?:\/chat\/completions)?|api(?:\/chat)?)$/u, '');
  url.pathname = `${prefix}/api/chat`;
  url.hash = '';
  return url;
}
type Json = Record<string, any>;
function ollamaMessages(messages: Json[]): Json[] {
  const names = new Map<string, string>();
  return messages.map(message => {
    const result: Json = { role: message.role === 'developer' ? 'system' : message.role, content: message.content ?? '' };
    if (Array.isArray(message.content)) {
      result.content = message.content.filter((part: Json) => part.type === 'text').map((part: Json) => part.text).join('\n');
      result.images = message.content.filter((part: Json) => part.type === 'image_url').map((part: Json) => {
        const source = part.image_url?.url;
        if (typeof source !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/u.test(source)) throw new Error('Ollama 只接收本次用户确认的本地图片');
        return source.slice(source.indexOf(',') + 1);
      });
    }
    if (message.tool_calls) result.tool_calls = message.tool_calls.map((call: Json) => {
      names.set(call.id, call.function.name);
      return { function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments } };
    });
    if (message.role === 'tool') result.tool_name = names.get(message.tool_call_id) ?? 'tool';
    return result;
  });
}
export function createOllamaFetchAdapter(baseUrl: string, fetcher: FetchLike = fetch): FetchLike {
  const endpoint = ollamaChatUrl(baseUrl);
  return async (_input, init) => {
    const input = JSON.parse(String(init?.body)) as Json;
    const tools = input.tools?.map((tool: Json) => ({ type: 'function', function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } }));
    const response = await fetcher(endpoint, { ...init, redirect: 'error', body: JSON.stringify({ model: input.model, messages: ollamaMessages(input.messages), ...(tools?.length ? { tools } : {}), stream: !!input.stream }) });
    if (!response.ok) return response;
    const id = `ollama-${randomUUID()}`;
    let toolIndex = 0;
    const normalize = (frame: Json, streaming: boolean): Json => {
      if (frame.error) throw new Error('Ollama 返回错误，请检查模型与本地服务');
      if (!frame.message && !frame.done) throw new Error('Ollama 响应格式无效');
      const calls = frame.message?.tool_calls?.map((call: Json) => {
        const index = toolIndex++;
        if (!call.function || typeof call.function.name !== 'string') throw new Error('Ollama 工具调用格式无效');
        return { ...(streaming ? { index } : {}), id: `${id}-tool-${index}`, type: 'function', function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) } };
      });
      const message = { ...(streaming ? {} : { role: 'assistant' }), content: frame.message?.content ?? '', ...(calls?.length ? { tool_calls: calls } : {}) };
      const usage = Number.isInteger(frame.prompt_eval_count) && Number.isInteger(frame.eval_count)
        ? { prompt_tokens: frame.prompt_eval_count, completion_tokens: frame.eval_count, total_tokens: frame.prompt_eval_count + frame.eval_count } : undefined;
      return { id, choices: [{ index: 0, [streaming ? 'delta' : 'message']: message, finish_reason: frame.done ? (toolIndex ? 'tool_calls' : frame.done_reason ?? 'stop') : null }], ...(usage ? { usage } : {}) };
    };
    if (!input.stream) {
      const text = await response.text();
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Ollama 响应过大');
      return Response.json(normalize(JSON.parse(text), false));
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Ollama 未返回流式响应');
    const encoder = new TextEncoder();
    let stopped = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const decoder = new TextDecoder();
        let buffer = '', bytes = 0, done = false;
        const consume = (line: string) => {
          if (!line.trim()) return;
          const frame = JSON.parse(line) as Json;
          const normalized = normalize(frame, true);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
          if (frame.done === true) done = true;
        };
        try {
          while (!stopped && !done) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2 * 1024 * 1024) throw new Error('Ollama 响应过大');
            buffer += decoder.decode(part.value, { stream: true });
            const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
            for (const line of lines) { if (!done) consume(line); }
          }
          buffer += decoder.decode();
          if (!stopped && !done && buffer.trim()) consume(buffer);
          if (!stopped) {
            if (!done) throw new Error('Ollama 连接提前结束，未确认回答或任务操作完成');
            controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
          }
        } catch (error) { if (!stopped) controller.error(error); }
        finally { await reader.cancel().catch(() => undefined); }
      },
      async cancel() { stopped = true; await reader.cancel().catch(() => undefined); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  };
}
