import { z } from 'zod';

import type {
  AgentJsonValue,
  JsonSchema,
} from '../../src/shared/agent-types';
import {
  BuiltinToolExecutors,
  type BuiltinToolExecutorOptions,
} from './tool-executors';
import {
  ToolRegistry,
  type ToolRegistryOptions,
  type TrustedToolDefinition,
} from './tool-registry';

const nonBlank = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() !== '', 'Value cannot contain only whitespace.')
    .refine((value) => !value.includes('\0'), 'Value cannot contain a null byte.');

export const fileReadArgumentsSchema = z.strictObject({
  path: nonBlank(4_096),
  maxBytes: z.number().int().min(1).max(4 * 1024 * 1024),
  dryRun: z.boolean(),
});

export const fileListArgumentsSchema = z.strictObject({
  path: nonBlank(4_096),
  recursive: z.boolean(),
  maxEntries: z.number().int().min(1).max(2_000),
  dryRun: z.boolean(),
});

export const fileSearchArgumentsSchema = z.strictObject({
  path: nonBlank(4_096),
  query: nonBlank(1_000),
  filePattern: nonBlank(256).nullable(),
  maxResults: z.number().int().min(1).max(500),
  maxFileBytes: z.number().int().min(1).max(4 * 1024 * 1024),
  dryRun: z.boolean(),
});

export const fileWriteArgumentsSchema = z.strictObject({
  path: nonBlank(4_096),
  content: z.string().max(1_000_000),
  overwrite: z.boolean(),
  createParents: z.boolean(),
  dryRun: z.boolean(),
});

export const fileMoveArgumentsSchema = z.strictObject({
  source: nonBlank(4_096),
  destination: nonBlank(4_096),
  overwrite: z.boolean(),
  createParents: z.boolean(),
  dryRun: z.boolean(),
});

export const fileDeleteArgumentsSchema = z.strictObject({
  path: nonBlank(4_096),
  recursive: z.boolean(),
  dryRun: z.boolean(),
});

export const terminalRunArgumentsSchema = z.strictObject({
  executable: nonBlank(512),
  arguments: z
    .array(
      z
        .string()
        .max(16_384)
        .refine((value) => !value.includes('\0'), 'Arguments cannot contain a null byte.'),
    )
    .max(128),
  cwd: nonBlank(4_096),
  timeoutMs: z.number().int().min(100).max(120_000),
  dryRun: z.boolean(),
});

export const clipboardReadArgumentsSchema = z.strictObject({
  dryRun: z.boolean(),
});

export const clipboardWriteArgumentsSchema = z.strictObject({
  text: z.string().max(1_000_000),
  dryRun: z.boolean(),
});

export const screenCaptureArgumentsSchema = z.strictObject({
  displayId: nonBlank(256).nullable(),
  includeCursor: z.boolean(),
  savePath: nonBlank(4_096).nullable(),
  dryRun: z.boolean(),
});

export const urlOpenArgumentsSchema = z.strictObject({
  url: z.string().url().max(8_192),
  dryRun: z.boolean(),
});

const httpHeaderSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  value: z.string().max(8_192).refine((value) => !/[\r\n]/.test(value), 'Header values cannot contain newlines.'),
});

export const httpFetchArgumentsSchema = z
  .strictObject({
    url: z.string().url().max(8_192),
    method: z.enum(['GET', 'HEAD']),
    headers: z.array(httpHeaderSchema).max(32),
    maxBytes: z.number().int().min(1).max(4 * 1024 * 1024),
    dryRun: z.boolean(),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, header] of value.headers.entries()) {
      const normalized = header.name.toLocaleLowerCase('en-US');
      if (seen.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: ['headers', index, 'name'],
          message: 'Header names must be unique.',
        });
      }
      seen.add(normalized);
    }
  });

export const webSearchArgumentsSchema = z.strictObject({
  query: nonBlank(2_000),
  maxResults: z.number().int().min(1).max(20),
  dryRun: z.boolean(),
});

const parametersFor = <T extends AgentJsonValue>(schema: z.ZodType<T>): JsonSchema => {
  const converted = z.toJSONSchema(schema) as Record<string, unknown>;
  delete converted.$schema;
  return converted as JsonSchema;
};

const tool = <TArguments extends AgentJsonValue>(input: {
  name: string;
  description: string;
  schema: z.ZodType<TArguments>;
  sensitiveArgumentPaths?: string[];
  analyze: TrustedToolDefinition<TArguments>['analyze'];
  execute: TrustedToolDefinition<TArguments>['execute'];
}): TrustedToolDefinition<TArguments> => ({
  name: input.name,
  version: 1,
  description: input.description,
  parameters: parametersFor(input.schema),
  argumentsSchema: input.schema,
  sensitiveArgumentPaths: input.sensitiveArgumentPaths,
  analyze: input.analyze,
  execute: input.execute,
});

export const createBuiltinTools = (
  executors: BuiltinToolExecutors,
): TrustedToolDefinition[] => [
  tool({
    name: 'file_read',
    description: 'Read a UTF-8 text file inside an explicitly allowed root.',
    schema: fileReadArgumentsSchema,
    analyze: (args, context) => executors.analyzeFileRead(args, context.signal),
    execute: (args, context) => executors.executeFileRead(args, context),
  }),
  tool({
    name: 'file_list',
    description: 'List files and directories inside an explicitly allowed root without following symlinks.',
    schema: fileListArgumentsSchema,
    analyze: (args, context) => executors.analyzeFileList(args, context.signal),
    execute: (args, context) => executors.executeFileList(args, context),
  }),
  tool({
    name: 'file_search',
    description: 'Search UTF-8 files under an allowed directory using a literal query and optional glob.',
    schema: fileSearchArgumentsSchema,
    sensitiveArgumentPaths: ['query'],
    analyze: (args, context) => executors.analyzeFileSearch(args, context.signal),
    execute: (args, context) => executors.executeFileSearch(args, context),
  }),
  tool({
    name: 'file_write',
    description: 'Create or replace one UTF-8 file inside an allowed root. Use dryRun before replacing data.',
    schema: fileWriteArgumentsSchema,
    sensitiveArgumentPaths: ['content'],
    analyze: (args, context) => executors.analyzeFileWrite(args, context.signal),
    execute: (args, context) => executors.executeFileWrite(args, context),
  }),
  tool({
    name: 'file_move',
    description: 'Move one file or directory between paths inside allowed roots.',
    schema: fileMoveArgumentsSchema,
    analyze: (args, context) => executors.analyzeFileMove(args, context.signal),
    execute: (args, context) => executors.executeFileMove(args, context),
  }),
  tool({
    name: 'file_delete',
    description: 'Permanently delete one file or directory inside an allowed root. Allowed roots themselves can never be deleted.',
    schema: fileDeleteArgumentsSchema,
    analyze: (args, context) => executors.analyzeFileDelete(args, context.signal),
    execute: (args, context) => executors.executeFileDelete(args, context),
  }),
  tool({
    name: 'terminal_run',
    description: 'Run an executable directly, without a shell, inside an allowed working directory.',
    schema: terminalRunArgumentsSchema,
    sensitiveArgumentPaths: ['arguments'],
    analyze: (args, context) => executors.analyzeTerminalRun(args, context.signal),
    execute: (args, context) => executors.executeTerminalRun(args, context),
  }),
  tool({
    name: 'clipboard_read',
    description: 'Read plain text from the system clipboard.',
    schema: clipboardReadArgumentsSchema,
    analyze: (args) => executors.analyzeClipboardRead(args),
    execute: (args, context) => executors.executeClipboardRead(args, context),
  }),
  tool({
    name: 'clipboard_write',
    description: 'Replace plain text in the system clipboard.',
    schema: clipboardWriteArgumentsSchema,
    sensitiveArgumentPaths: ['text'],
    analyze: (args) => executors.analyzeClipboardWrite(args),
    execute: (args, context) => executors.executeClipboardWrite(args, context),
  }),
  tool({
    name: 'screen_capture',
    description: 'Capture a display through the configured platform adapter, optionally saving inside an allowed root.',
    schema: screenCaptureArgumentsSchema,
    analyze: (args, context) => executors.analyzeScreenCapture(args, context.signal),
    execute: (args, context) => executors.executeScreenCapture(args, context),
  }),
  tool({
    name: 'url_open',
    description: 'Open one HTTP or HTTPS URL with the configured system browser adapter.',
    schema: urlOpenArgumentsSchema,
    sensitiveArgumentPaths: ['url'],
    analyze: (args) => executors.analyzeUrlOpen(args),
    execute: (args, context) => executors.executeUrlOpen(args, context),
  }),
  tool({
    name: 'http_fetch',
    description: 'Fetch a bounded HTTP or HTTPS resource. Private-network and credential-bearing URLs are forbidden.',
    schema: httpFetchArgumentsSchema,
    sensitiveArgumentPaths: ['url', 'headers'],
    analyze: (args) => executors.analyzeHttpFetch(args),
    execute: (args, context) => executors.executeHttpFetch(args, context),
  }),
  tool({
    name: 'web_search',
    description: 'Search the public web through an injected search-provider adapter.',
    schema: webSearchArgumentsSchema,
    sensitiveArgumentPaths: ['query'],
    analyze: (args) => executors.analyzeWebSearch(args),
    execute: (args, context) => executors.executeWebSearch(args, context),
  }),
];

export const createBuiltinToolRegistry = (
  executorOptions: BuiltinToolExecutorOptions,
  registryOptions: ToolRegistryOptions = {},
): ToolRegistry => {
  const executors = new BuiltinToolExecutors(executorOptions);
  return new ToolRegistry(createBuiltinTools(executors), registryOptions);
};
