import { z } from "zod";

import type {
  AgentJsonValue,
  ModelCompletion,
  ModelCompletionRequest,
  ModelFunctionTool,
  ModelToolCall,
  NormalizedToolCall,
} from "../../src/shared/agent-types";

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        arguments: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const responseSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().nullable().optional(),
            message: z
              .object({
                role: z.literal("assistant").optional(),
                content: z.string().nullable().optional(),
                tool_calls: z.array(toolCallSchema).optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const streamChunkSchema = z
  .object({
    id: z.string().optional(),
    choices: z.array(
      z
        .object({
          finish_reason: z.string().nullable().optional(),
          delta: z
            .object({
              content: z.string().nullable().optional(),
              tool_calls: z
                .array(
                  z
                    .object({
                      index: z.number().int().nonnegative(),
                      // OpenAI-compatible providers commonly send these
                      // fields only on the first tool-call fragment, then
                      // explicitly use null on continuation fragments.
                      id: z.string().nullable().optional(),
                      type: z.literal("function").nullable().optional(),
                      function: z
                        .object({
                          name: z.string().nullable().optional(),
                          arguments: z.string().nullable().optional(),
                        })
                        .passthrough()
                        .optional(),
                    })
                    .passthrough(),
                )
                .optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const toolArgumentsSchema = z.record(z.string(), z.json());
type RawToolCall = z.infer<typeof toolCallSchema>;

interface CompletionParts {
  id?: string;
  content: string | null;
  toolCalls: RawToolCall[];
  finishReason?: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const normalizeCompletion = (
  request: ModelCompletionRequest,
  parts: CompletionParts,
): ModelCompletion => {
  const knownTools = new Set(request.tools.map((tool) => tool.function.name));
  const seenIds = new Set<string>();
  const normalizedCalls: NormalizedToolCall[] = parts.toolCalls.map((call) => {
    if (!knownTools.has(call.function.name)) {
      throw new ModelGatewayError(
        "UNKNOWN_TOOL",
        `The model requested an unavailable tool: ${call.function.name}.`,
      );
    }
    if (seenIds.has(call.id)) {
      throw new ModelGatewayError(
        "DUPLICATE_TOOL_CALL",
        "The model repeated a tool call ID.",
      );
    }
    seenIds.add(call.id);

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new ModelGatewayError(
        "INVALID_TOOL_ARGUMENTS",
        `Tool ${call.function.name} returned invalid JSON arguments.`,
      );
    }
    const parsedArgs = toolArgumentsSchema.safeParse(args);
    if (!parsedArgs.success) {
      throw new ModelGatewayError(
        "INVALID_TOOL_ARGUMENTS",
        `Tool ${call.function.name} arguments must be a JSON object.`,
      );
    }
    return {
      id: call.id,
      name: call.function.name,
      arguments: parsedArgs.data as AgentJsonValue,
      argumentsJson: call.function.arguments,
    };
  });

  const assistantToolCalls: ModelToolCall[] | undefined =
    parts.toolCalls.length === 0
      ? undefined
      : parts.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        }));

  return {
    id: parts.id,
    assistantMessage: {
      role: "assistant",
      content: parts.content,
      tool_calls: assistantToolCalls,
    },
    toolCalls: normalizedCalls,
    finishReason: parts.finishReason ?? "unknown",
    usage:
      parts.usage === undefined
        ? undefined
        : {
            promptTokens: parts.usage.prompt_tokens,
            completionTokens: parts.usage.completion_tokens,
            totalTokens: parts.usage.total_tokens,
          },
  };
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SecretResolver {
  resolve(credentialRef: string): Promise<string>;
}

export interface SafeModelLogger {
  info(
    event: string,
    metadata: Record<string, string | number | boolean>,
  ): void;
  warn(
    event: string,
    metadata: Record<string, string | number | boolean>,
  ): void;
}

export interface ModelGatewayOptions {
  baseUrl: string;
  model: string;
  /** Defaults to bearer. `none` is an explicit self-hosted no-key mode. */
  authentication?: "bearer" | "none";
  credentialRef?: string;
  secretResolver?: SecretResolver;
  fetch?: FetchLike;
  logger?: SafeModelLogger;
  strictTools?: boolean;
  timeoutMs?: number;
  /** Additional attempts after the first request. Clamped to 0..5. */
  retries?: number;
  /** Test seam for the exponential retry delay. Production defaults to 250 ms. */
  retryBaseDelayMs?: number;
  maxResponseBytes?: number;
}

export class ModelGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

const normalizedRetries = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.floor(value)));
};

const isRetryableFailure = (error: ModelGatewayError): boolean =>
  error.code === "NETWORK_ERROR" ||
  (error.code === "HTTP_ERROR" &&
    (error.status === 408 ||
      error.status === 429 ||
      (error.status !== undefined &&
        error.status >= 500 &&
        error.status <= 599)));

const abortedError = (): ModelGatewayError =>
  new ModelGatewayError("ABORTED", "The model request was stopped.");

const waitForRetry = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortedError());
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
};

const sanitize = (input: string, secrets: string[] = []): string => {
  let output = input.replace(
    /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    "Bearer [REDACTED]",
  );
  for (const secret of secrets) {
    if (secret.length > 0) {
      output = output.split(secret).join("[REDACTED]");
    }
  }
  return output;
};

const buildEndpoint = (baseUrl: string): URL => {
  let normalized: URL;
  try {
    normalized = new URL(baseUrl);
  } catch {
    throw new ModelGatewayError(
      "INVALID_BASE_URL",
      "The model endpoint must be a valid absolute URL.",
    );
  }
  if (normalized.protocol !== "https:" && normalized.protocol !== "http:") {
    throw new ModelGatewayError(
      "INVALID_BASE_URL",
      "The model endpoint must use HTTP or HTTPS.",
    );
  }
  if (normalized.username || normalized.password) {
    throw new ModelGatewayError(
      "INVALID_BASE_URL",
      "The model endpoint must not contain embedded credentials.",
    );
  }

  normalized.hash = "";
  const pathname = normalized.pathname.replace(/\/+$/u, "") || "/";
  normalized.pathname = pathname.endsWith("/chat/completions")
    ? pathname
    : pathname === "/"
      ? "/v1/chat/completions"
      : `${pathname}/chat/completions`;
  return normalized;
};

const withStrictMode = (
  tool: ModelFunctionTool,
  strictTools: boolean,
): ModelFunctionTool => ({
  type: "function",
  function: {
    ...tool.function,
    parameters: structuredClone(tool.function.parameters),
    strict: strictTools ? true : tool.function.strict,
  },
});

export class OpenAIChatCompletionsGateway {
  private readonly endpoint: URL;
  private readonly fetchFn: FetchLike;
  private readonly logger?: SafeModelLogger;
  private readonly strictTools: boolean;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: ModelGatewayOptions) {
    this.endpoint = buildEndpoint(options.baseUrl);
    this.fetchFn = options.fetch ?? fetch;
    this.logger = options.logger;
    this.strictTools = options.strictTools ?? true;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retries = normalizedRetries(options.retries);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  }

  /**
   * Keep unauthenticated requests opt-in. In particular, do not turn a blank
   * credential into `Authorization: Bearer `, which some self-hosted servers
   * interpret differently from an unauthenticated request.
   */
  async #resolveApiKey(): Promise<string | undefined> {
    if (this.options.authentication === "none") return undefined;
    if (!this.options.credentialRef || !this.options.secretResolver) {
      throw new ModelGatewayError(
        "CREDENTIAL_NOT_CONFIGURED",
        "The configured model credential is unavailable.",
      );
    }
    const apiKey = await this.options.secretResolver.resolve(
      this.options.credentialRef,
    );
    if (apiKey.trim() === "") {
      throw new ModelGatewayError(
        "EMPTY_CREDENTIAL",
        "The configured model credential is empty.",
      );
    }
    return apiKey;
  }

  async complete(
    request: ModelCompletionRequest,
    externalSignal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<ModelCompletion> {
    const apiKey = await this.#resolveApiKey();

    const tools = request.tools.map((tool) =>
      withStrictMode(tool, this.strictTools),
    );
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages,
      parallel_tool_calls: false,
      stream: onTextDelta !== undefined,
    };
    if (onTextDelta) {
      body.stream_options = { include_usage: true };
    }
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = request.toolChoice ?? "auto";
    }
    const serializedBody = JSON.stringify(body);

    this.logger?.info("model.request.started", {
      origin: this.endpoint.origin,
      model: this.options.model,
      messageCount: request.messages.length,
      toolCount: tools.length,
      maxAttempts: this.retries + 1,
    });

    let emittedText = false;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const completion = onTextDelta
          ? await this.#streamAttempt(
              request,
              serializedBody,
              apiKey,
              externalSignal,
              (delta) => {
                emittedText = true;
                onTextDelta(delta);
              },
            )
          : await this.#completeAttempt(
              request,
              serializedBody,
              apiKey,
              externalSignal,
            );
        if (onTextDelta && completion.usage?.totalTokens === undefined) {
          if (!emittedText) {
            this.logger?.warn("model.stream.usage-missing-fallback", {
              origin: this.endpoint.origin,
              model: this.options.model,
            });
            return this.complete(request, externalSignal);
          }
          throw new ModelGatewayError(
            "STREAM_USAGE_UNAVAILABLE",
            "The model stream did not report usage.total_tokens; the partial response was not charged to the local usage counter.",
          );
        }
        this.logger?.info("model.request.completed", {
          origin: this.endpoint.origin,
          model: this.options.model,
          toolCallCount: completion.toolCalls.length,
          attemptCount: attempt + 1,
        });
        return completion;
      } catch (error) {
        let safeError =
          error instanceof ModelGatewayError
            ? new ModelGatewayError(
                error.code,
                sanitize(error.message, apiKey ? [apiKey] : []),
                error.status,
              )
            : new ModelGatewayError(
                "NETWORK_ERROR",
                sanitize(
                  error instanceof Error
                    ? error.message
                    : "Model request failed.",
                  apiKey ? [apiKey] : [],
                ),
              );
        if (externalSignal?.aborted && safeError.code !== "ABORTED") {
          safeError = abortedError();
        }

        if (
          onTextDelta &&
          !emittedText &&
          safeError.code === "HTTP_ERROR" &&
          (safeError.status === 400 || safeError.status === 422)
        ) {
          this.logger?.warn("model.stream.unsupported-fallback", {
            origin: this.endpoint.origin,
            model: this.options.model,
            status: safeError.status,
          });
          return this.complete(request, externalSignal);
        }

        const willRetry =
          attempt < this.retries &&
          !emittedText &&
          !externalSignal?.aborted &&
          isRetryableFailure(safeError);
        if (!willRetry) {
          this.#logFailure(safeError, attempt + 1);
          throw safeError;
        }

        const delayMs = Math.min(this.retryBaseDelayMs * 2 ** attempt, 2_000);
        this.logger?.warn("model.request.retrying", {
          origin: this.endpoint.origin,
          model: this.options.model,
          code: safeError.code,
          status: safeError.status ?? 0,
          failedAttempt: attempt + 1,
          delayMs,
        });
        try {
          await waitForRetry(delayMs, externalSignal);
        } catch (waitError) {
          const stopped =
            waitError instanceof ModelGatewayError ? waitError : abortedError();
          this.#logFailure(stopped, attempt + 1);
          throw stopped;
        }
      }
    }

    throw new ModelGatewayError("NETWORK_ERROR", "Model request failed.");
  }

  async #completeAttempt(
    request: ModelCompletionRequest,
    serializedBody: string,
    apiKey: string | undefined,
    externalSignal?: AbortSignal,
  ): Promise<ModelCompletion> {
    const abortController = new AbortController();
    let timedOut = false;
    const abortFromExternal = (): void =>
      abortController.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
    if (externalSignal?.aborted) abortFromExternal();
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error("Model request timed out."));
    }, this.timeoutMs);

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
        },
        body: serializedBody,
        redirect: "error",
        signal: abortController.signal,
      });
      const responseText = await response.text();
      if (externalSignal?.aborted) throw abortedError();
      if (timedOut) {
        throw new ModelGatewayError(
          "NETWORK_ERROR",
          "The model request timed out.",
        );
      }
      if (
        new TextEncoder().encode(responseText).byteLength >
        this.maxResponseBytes
      ) {
        throw new ModelGatewayError(
          "RESPONSE_TOO_LARGE",
          "The model response exceeded the configured size limit.",
          response.status,
        );
      }
      if (!response.ok) {
        throw new ModelGatewayError(
          "HTTP_ERROR",
          `Model endpoint returned ${response.status}: ${sanitize(responseText.slice(0, 1_000), apiKey ? [apiKey] : [])}`,
          response.status,
        );
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(responseText);
      } catch {
        throw new ModelGatewayError(
          "INVALID_JSON",
          "The model endpoint returned invalid JSON.",
        );
      }

      const parsed = responseSchema.safeParse(decoded);
      if (!parsed.success) {
        throw new ModelGatewayError(
          "INVALID_RESPONSE",
          `The model response did not match Chat Completions: ${sanitize(z.prettifyError(parsed.error))}`,
        );
      }

      const choice = parsed.data.choices[0];
      return normalizeCompletion(request, {
        id: parsed.data.id,
        content: choice.message.content ?? null,
        toolCalls: choice.message.tool_calls ?? [],
        finishReason: choice.finish_reason,
        usage: parsed.data.usage,
      });
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      if (externalSignal?.aborted) throw abortedError();
      if (timedOut) {
        throw new ModelGatewayError(
          "NETWORK_ERROR",
          "The model request timed out.",
        );
      }
      throw new ModelGatewayError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "Model request failed.",
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  async #streamAttempt(
    request: ModelCompletionRequest,
    serializedBody: string,
    apiKey: string | undefined,
    externalSignal: AbortSignal | undefined,
    onTextDelta: (delta: string) => void,
  ): Promise<ModelCompletion> {
    const abortController = new AbortController();
    let timedOut = false;
    const abortFromExternal = (): void =>
      abortController.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
    if (externalSignal?.aborted) abortFromExternal();
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error("Model request timed out."));
    }, this.timeoutMs);

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
        },
        body: serializedBody,
        redirect: "error",
        signal: abortController.signal,
      });
      if (!response.ok) {
        const responseText = await response.text();
        throw new ModelGatewayError(
          "HTTP_ERROR",
          `Model endpoint returned ${response.status}: ${sanitize(responseText.slice(0, 1_000), apiKey ? [apiKey] : [])}`,
          response.status,
        );
      }

      const contentType = response.headers.get("Content-Type") ?? "";
      if (contentType.toLowerCase().includes("application/json")) {
        const responseText = await response.text();
        if (
          new TextEncoder().encode(responseText).byteLength >
          this.maxResponseBytes
        ) {
          throw new ModelGatewayError(
            "RESPONSE_TOO_LARGE",
            "The model response exceeded the configured size limit.",
            response.status,
          );
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(responseText);
        } catch {
          throw new ModelGatewayError(
            "INVALID_JSON",
            "The model endpoint returned invalid JSON.",
          );
        }
        const parsed = responseSchema.safeParse(decoded);
        if (!parsed.success) {
          throw new ModelGatewayError(
            "INVALID_RESPONSE",
            `The model response did not match Chat Completions: ${sanitize(z.prettifyError(parsed.error))}`,
          );
        }
        const choice = parsed.data.choices[0];
        const content = choice.message.content ?? null;
        if (content) onTextDelta(content);
        return normalizeCompletion(request, {
          id: parsed.data.id,
          content,
          toolCalls: choice.message.tool_calls ?? [],
          finishReason: choice.finish_reason,
          usage: parsed.data.usage,
        });
      }

      if (!response.body) {
        throw new ModelGatewayError(
          "INVALID_RESPONSE",
          "The model endpoint returned an empty streaming response.",
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let responseBytes = 0;
      let completionId: string | undefined;
      let content = "";
      let finishReason: string | null | undefined;
      let usage: CompletionParts["usage"];
      let receivedChunk = false;
      let sawDone = false;
      const streamedTools = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      const consumeData = (data: string): void => {
        if (data === "[DONE]") {
          sawDone = true;
          return;
        }
        let decodedChunk: unknown;
        try {
          decodedChunk = JSON.parse(data);
        } catch {
          throw new ModelGatewayError(
            "INVALID_JSON",
            "The model stream returned an invalid JSON event.",
          );
        }
        const parsed = streamChunkSchema.safeParse(decodedChunk);
        if (!parsed.success) {
          throw new ModelGatewayError(
            "INVALID_RESPONSE",
            `The model stream event was invalid: ${sanitize(z.prettifyError(parsed.error))}`,
          );
        }
        receivedChunk = true;
        completionId ??= parsed.data.id;
        if (parsed.data.usage) usage = parsed.data.usage;
        const choice = parsed.data.choices[0];
        if (!choice) return;
        finishReason = choice.finish_reason ?? finishReason;
        const delta = choice.delta?.content;
        if (delta) {
          content += delta;
          onTextDelta(delta);
        }
        for (const call of choice.delta?.tool_calls ?? []) {
          const current = streamedTools.get(call.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) {
            current.arguments += call.function.arguments;
          }
          streamedTools.set(call.index, current);
        }
      };

      const consumeLines = (flush = false): void => {
        const lines = buffer.split(/\r?\n/u);
        const trailing = lines.pop() ?? "";
        buffer = flush ? "" : trailing;
        for (const line of lines) {
          if (sawDone) break;
          if (!line.startsWith("data:")) continue;
          consumeData(line.slice(5).trimStart().trimEnd());
        }
        if (flush && trailing.startsWith("data:") && !sawDone) {
          consumeData(trailing.slice(5).trimStart().trimEnd());
        }
      };

      while (!sawDone) {
        const next = await reader.read();
        if (next.done) break;
        responseBytes += next.value.byteLength;
        if (responseBytes > this.maxResponseBytes) {
          await reader.cancel();
          throw new ModelGatewayError(
            "RESPONSE_TOO_LARGE",
            "The model response exceeded the configured size limit.",
            response.status,
          );
        }
        buffer += decoder.decode(next.value, { stream: true });
        consumeLines();
      }
      buffer += decoder.decode();
      consumeLines(true);

      if (externalSignal?.aborted) throw abortedError();
      if (timedOut) {
        throw new ModelGatewayError(
          "NETWORK_ERROR",
          "The model request timed out.",
        );
      }
      if (!receivedChunk) {
        throw new ModelGatewayError(
          "INVALID_RESPONSE",
          "The model endpoint returned no streaming events.",
        );
      }

      const rawToolCalls = [...streamedTools.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => {
          const parsed = toolCallSchema.safeParse({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          });
          if (!parsed.success) {
            throw new ModelGatewayError(
              "INVALID_RESPONSE",
              "The model stream ended with an incomplete tool call.",
            );
          }
          return parsed.data;
        });

      return normalizeCompletion(request, {
        id: completionId,
        content: content || null,
        toolCalls: rawToolCalls,
        finishReason,
        usage,
      });
    } catch (error) {
      if (error instanceof ModelGatewayError) throw error;
      if (externalSignal?.aborted) throw abortedError();
      if (timedOut) {
        throw new ModelGatewayError(
          "NETWORK_ERROR",
          "The model request timed out.",
        );
      }
      throw new ModelGatewayError(
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "Model request failed.",
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  #logFailure(error: ModelGatewayError, attemptCount: number): void {
    this.logger?.warn("model.request.failed", {
      origin: this.endpoint.origin,
      model: this.options.model,
      code: error.code,
      status: error.status ?? 0,
      attemptCount,
    });
  }
}
