import { describe, expect, it, vi } from "vitest";

import type {
  ModelCompletionRequest,
  ModelFunctionTool,
} from "../src/shared/agent-types";
import {
  ModelGatewayError,
  OpenAIChatCompletionsGateway,
  type SafeModelLogger,
} from "../electron/agent/model-gateway";

const updateTool: ModelFunctionTool = {
  type: "function",
  function: {
    name: "task_update",
    description: "Update a single task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        title: { type: "string" },
      },
      required: ["taskId", "title"],
      additionalProperties: false,
    },
    strict: true,
  },
};

const request = (): ModelCompletionRequest => ({
  messages: [{ role: "user", content: "Rename the task." }],
  tools: [updateTool],
});

const loggerHarness = () => {
  const entries: unknown[] = [];
  const logger: SafeModelLogger = {
    info: (event, metadata) => entries.push({ level: "info", event, metadata }),
    warn: (event, metadata) => entries.push({ level: "warn", event, metadata }),
  };
  return { entries, logger };
};

const successfulResponse = (content = "OK"): Response =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-success",
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const streamingResponse = (events: string[], splitAt?: number): Response => {
  const encoded = new TextEncoder().encode(
    `${events.map((event) => `data: ${event}\n\n`).join("")}data: [DONE]\n\n`,
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitAt && splitAt > 0 && splitAt < encoded.byteLength) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
      } else {
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

describe("OpenAIChatCompletionsGateway", () => {
  it.each([
    ["http://10.30.0.21:8005", "http://10.30.0.21:8005/v1/chat/completions"],
    [
      "http://10.30.0.21:8005/",
      "http://10.30.0.21:8005/v1/chat/completions",
    ],
    [
      "http://10.30.0.21:8005/v1",
      "http://10.30.0.21:8005/v1/chat/completions",
    ],
    [
      "http://10.30.0.21:8005/v1/chat/completions",
      "http://10.30.0.21:8005/v1/chat/completions",
    ],
    [
      "https://models.example/openai/v1/",
      "https://models.example/openai/v1/chat/completions",
    ],
  ])("normalizes endpoint %s to %s", async (baseUrl, expectedUrl) => {
    let capturedUrl = "";
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl,
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: async (input) => {
        capturedUrl = input.toString();
        return successfulResponse();
      },
    });

    await gateway.complete({
      messages: [{ role: "user", content: "Reply with OK." }],
      tools: [],
      toolChoice: "none",
    });

    expect(capturedUrl).toBe(expectedUrl);
  });

  it.each([
    "not-a-url",
    "file:///tmp/model",
    "https://embedded:secret@models.example/v1",
  ])("rejects unsafe or invalid endpoint %s", (baseUrl) => {
    expect(
      () =>
        new OpenAIChatCompletionsGateway({
          baseUrl,
          model: "compatible-model",
          credentialRef: "model.default",
          secretResolver: { resolve: async () => "provider-key" },
        }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_BASE_URL" }));
  });

  it("sends native Chat Completions tools and normalizes tool_calls", async () => {
    const apiKey = "provider-key-value";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedInit = init;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "task_update",
                        arguments: JSON.stringify({
                          taskId: "task-1",
                          title: "New title",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            // Deliberately differs from prompt + completion so the assertion
            // proves the gateway trusts the provider's total_tokens field.
            usage: {
              prompt_tokens: 10,
              completion_tokens: 8,
              total_tokens: 23,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: vi.fn(async () => apiKey) },
      fetch: fetchFn,
    });

    const completion = await gateway.complete(request());

    expect(capturedUrl).toBe("https://models.example/v1/chat/completions");
    expect(new Headers(capturedInit?.headers).get("Authorization")).toBe(
      `Bearer ${apiKey}`,
    );
    expect(capturedInit?.redirect).toBe("error");
    const body = JSON.parse(String(capturedInit?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      model: "compatible-model",
      parallel_tool_calls: false,
      stream: false,
      tool_choice: "auto",
    });
    expect(body.tools).toEqual([updateTool]);
    expect(completion).toMatchObject({
      id: "chatcmpl-1",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call-1",
          name: "task_update",
          arguments: { taskId: "task-1", title: "New title" },
        },
      ],
      usage: { promptTokens: 10, completionTokens: 8, totalTokens: 23 },
    });
    expect(completion.assistantMessage.tool_calls?.[0].id).toBe("call-1");
  });

  it("omits Authorization and does not resolve a key in explicit no-auth mode", async () => {
    const resolver = vi.fn(async () => "must-not-be-read");
    const requestInits: RequestInit[] = [];
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "http://10.30.0.21:8005",
      model: "DeepSeek-V4-Flash-0731",
      authentication: "none",
      // Deliberately provide a saved credential reference as a regression
      // guard: selecting no-auth must not accidentally leak it.
      credentialRef: "saved-model-key",
      secretResolver: { resolve: resolver },
      fetch: async (_input, init) => {
        requestInits.push(init ?? {});
        return successfulResponse();
      },
    });

    await gateway.complete({ messages: [{ role: "user", content: "OK" }], tools: [] });
    await gateway.complete(
      { messages: [{ role: "user", content: "OK" }], tools: [] },
      undefined,
      () => undefined,
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(requestInits).toHaveLength(2);
    for (const init of requestInits) {
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
    }
    expect(new Headers(requestInits[1]?.headers).get("Accept")).toBe(
      "text/event-stream",
    );
  });

  it("streams text deltas as they arrive and returns the same assembled completion", async () => {
    let capturedInit: RequestInit | undefined;
    const deltas: string[] = [];
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: async (_input, init) => {
        capturedInit = init;
        return streamingResponse(
          [
            JSON.stringify({
              id: "chatcmpl-stream",
              choices: [{ delta: { role: "assistant", content: "# 计划" } }],
            }),
            JSON.stringify({
              id: "chatcmpl-stream",
              choices: [
                { delta: { content: "\n\n- 第一项" }, finish_reason: "stop" },
              ],
            }),
            JSON.stringify({
              id: "chatcmpl-stream",
              choices: [],
              usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
            }),
          ],
          17,
        );
      },
    });

    const completion = await gateway.complete(
      { messages: [{ role: "user", content: "安排一下" }], tools: [] },
      undefined,
      (delta) => deltas.push(delta),
    );

    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(new Headers(capturedInit?.headers).get("Accept")).toBe(
      "text/event-stream",
    );
    expect(deltas).toEqual(["# 计划", "\n\n- 第一项"]);
    expect(completion).toMatchObject({
      id: "chatcmpl-stream",
      assistantMessage: { content: "# 计划\n\n- 第一项" },
      finishReason: "stop",
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
    });
  });

  it("assembles streamed tool-call argument fragments without exposing them as answer text", async () => {
    const deltas: string[] = [];
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: async () =>
        streamingResponse([
          JSON.stringify({
            id: "chatcmpl-tool-stream",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-stream",
                      type: "function",
                      function: {
                        name: "task_update",
                        arguments: '{"taskId":"task-1",',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: '"title":"New title"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        ]),
    });

    const completion = await gateway.complete(request(), undefined, (delta) =>
      deltas.push(delta),
    );

    expect(deltas).toEqual([]);
    expect(completion).toMatchObject({
      finishReason: "tool_calls",
      assistantMessage: { content: null },
      toolCalls: [
        {
          id: "call-stream",
          name: "task_update",
          arguments: { taskId: "task-1", title: "New title" },
        },
      ],
    });
  });

  it("does not retry after visible stream text was emitted", async () => {
    const encoded = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "已输出" } }] })}\n\n`,
    );
    let pullCount = 0;
    const fetchFn = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount === 0) {
            pullCount += 1;
            controller.enqueue(encoded);
          } else {
            controller.error(new Error("stream disconnected"));
          }
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const deltas: string[] = [];
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: fetchFn,
      retries: 3,
      retryBaseDelayMs: 0,
    });

    await expect(
      gateway.complete(
        { messages: [{ role: "user", content: "开始" }], tools: [] },
        undefined,
        (delta) => deltas.push(delta),
      ),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(deltas).toEqual(["已输出"]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("falls back to an accounted non-stream response when stream options are unsupported", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (_input, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      return body.stream
        ? new Response("stream_options is unsupported", { status: 400 })
        : successfulResponse("兼容回答");
    });
    const deltas: string[] = [];
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: fetchFn,
    });

    const completion = await gateway.complete(
      { messages: [{ role: "user", content: "兼容测试" }], tools: [] },
      undefined,
      (delta) => deltas.push(delta),
    );

    expect(requestBodies.map((body) => body.stream)).toEqual([true, false]);
    expect(deltas).toEqual([]);
    expect(completion).toMatchObject({
      assistantMessage: { content: "兼容回答" },
      usage: { totalTokens: 3 },
    });
  });

  it("fails without poisoning usage accounting when a visible stream omits usage", async () => {
    const deltas: string[] = [];
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: async () =>
        streamingResponse([
          JSON.stringify({
            choices: [
              { delta: { content: "提供方没有返回用量" }, finish_reason: "stop" },
            ],
          }),
        ]),
    });

    await expect(
      gateway.complete(
        { messages: [{ role: "user", content: "回答" }], tools: [] },
        undefined,
        (delta) => deltas.push(delta),
      ),
    ).rejects.toMatchObject({ code: "STREAM_USAGE_UNAVAILABLE" });
    expect(deltas).toEqual(["提供方没有返回用量"]);
  });

  it("retries network and transient HTTP failures with bounded exponential backoff", async () => {
    const apiKey = "retry-secret-value";
    const { entries, logger } = loggerHarness();
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError(`network failed with ${apiKey}`))
      .mockResolvedValueOnce(
        new Response(`temporarily unavailable ${apiKey}`, { status: 429 }),
      )
      .mockResolvedValueOnce(successfulResponse("recovered"));
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => apiKey },
      fetch: fetchFn,
      logger,
      retries: 2,
      retryBaseDelayMs: 1,
    });

    await expect(gateway.complete(request())).resolves.toMatchObject({
      assistantMessage: { content: "recovered" },
      usage: { totalTokens: 3 },
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(
      entries
        .filter(
          (entry) =>
            (entry as { event?: string }).event === "model.request.retrying",
        )
        .map(
          (entry) =>
            (entry as { metadata: { delayMs: number } }).metadata.delayMs,
        ),
    ).toEqual([1, 2]);
    expect(JSON.stringify(entries)).not.toContain(apiKey);
  });

  it.each([408, 500, 502, 503])(
    "retries HTTP %i once and then succeeds",
    async (status) => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response("transient", { status }))
        .mockResolvedValueOnce(successfulResponse());
      const gateway = new OpenAIChatCompletionsGateway({
        baseUrl: "https://models.example/v1/",
        model: "compatible-model",
        credentialRef: "model.default",
        secretResolver: { resolve: async () => "provider-key" },
        fetch: fetchFn,
        retries: 1,
        retryBaseDelayMs: 0,
      });

      await expect(gateway.complete(request())).resolves.toMatchObject({
        finishReason: "stop",
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it("does not exceed the configured retry count", async () => {
    const fetchFn = vi.fn(
      async () => new Response("still unavailable", { status: 503 }),
    );
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: fetchFn,
      retries: 2,
      retryBaseDelayMs: 0,
    });

    await expect(gateway.complete(request())).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404, 422])(
    "never retries non-transient HTTP %i",
    async (status) => {
      const fetchFn = vi.fn(
        async () => new Response("request rejected", { status }),
      );
      const gateway = new OpenAIChatCompletionsGateway({
        baseUrl: "https://models.example/v1/",
        model: "compatible-model",
        credentialRef: "model.default",
        secretResolver: { resolve: async () => "provider-key" },
        fetch: fetchFn,
        retries: 5,
        retryBaseDelayMs: 0,
      });

      await expect(gateway.complete(request())).rejects.toMatchObject({
        code: "HTTP_ERROR",
        status,
      });
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it("never retries response parsing or response-schema failures", async () => {
    const responses = [
      { body: "not-json", code: "INVALID_JSON" },
      { body: JSON.stringify({ choices: [] }), code: "INVALID_RESPONSE" },
    ];
    for (const fixture of responses) {
      const fetchFn = vi.fn(
        async () => new Response(fixture.body, { status: 200 }),
      );
      const gateway = new OpenAIChatCompletionsGateway({
        baseUrl: "https://models.example/v1/",
        model: "compatible-model",
        credentialRef: "model.default",
        secretResolver: { resolve: async () => "provider-key" },
        fetch: fetchFn,
        retries: 5,
        retryBaseDelayMs: 0,
      });

      await expect(gateway.complete(request())).rejects.toMatchObject({
        code: fixture.code,
      });
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  });

  it("never retries an external abort while a request is in flight", async () => {
    const fetchFn = vi.fn(
      async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("stopped")),
            { once: true },
          );
        }),
    );
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: fetchFn,
      retries: 5,
      retryBaseDelayMs: 0,
    });
    const controller = new AbortController();

    const pending = gateway.complete(request(), controller.signal);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    controller.abort(new Error("stopped by user"));

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("cancels exponential backoff immediately when the external signal aborts", async () => {
    let retryStarted!: () => void;
    const waitingForRetry = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    const logger: SafeModelLogger = {
      info: () => undefined,
      warn: (event) => {
        if (event === "model.request.retrying") retryStarted();
      },
    };
    const fetchFn = vi.fn(
      async () => new Response("transient", { status: 503 }),
    );
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: fetchFn,
      logger,
      retries: 5,
      retryBaseDelayMs: 10_000,
    });
    const controller = new AbortController();

    const pending = gateway.complete(request(), controller.signal);
    await waitingForRetry;
    controller.abort(new Error("stopped during retry delay"));

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects malformed native tool arguments before they reach the registry", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "task_update", arguments: "{not-json" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: fetchFn,
      retries: 5,
      retryBaseDelayMs: 0,
    });

    await expect(gateway.complete(request())).rejects.toMatchObject({
      code: "INVALID_TOOL_ARGUMENTS",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects tool calls that were not offered in the current request", async () => {
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => "provider-key" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "shell_exec", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(gateway.complete(request())).rejects.toMatchObject({
      code: "UNKNOWN_TOOL",
    });
  });

  it("never places an API key in logger metadata or surfaced HTTP errors", async () => {
    const apiKey = "arbitrary-provider-secret";
    const { entries, logger } = loggerHarness();
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => apiKey },
      logger,
      fetch: async () =>
        new Response(`Authorization: Bearer ${apiKey}; echoed key=${apiKey}`, {
          status: 401,
        }),
    });

    let thrown: unknown;
    try {
      await gateway.complete(request());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelGatewayError);
    expect((thrown as Error).message).not.toContain(apiKey);
    expect(JSON.stringify(entries)).not.toContain(apiKey);
    expect((thrown as Error).message).toContain("[REDACTED]");
  });

  it("redacts the API key even when a malformed provider response echoes it as data", async () => {
    const apiKey = "provider_secret_echo";
    const gateway = new OpenAIChatCompletionsGateway({
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      credentialRef: "model.default",
      secretResolver: { resolve: async () => apiKey },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: apiKey, arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    let thrown: unknown;
    try {
      await gateway.complete(request());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelGatewayError);
    expect(thrown).toMatchObject({ code: "UNKNOWN_TOOL" });
    expect((thrown as Error).message).not.toContain(apiKey);
    expect((thrown as Error).message).toContain("[REDACTED]");
  });
});
