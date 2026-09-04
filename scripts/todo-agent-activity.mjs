#!/usr/bin/env node

/**
 * Tiny, dependency-free helper for external Agent hooks.
 *
 * It reads the runtime descriptor created by Todo Agent, loads the token from
 * the separate 0600 token file, and posts only the redacted activity fields
 * accepted by the local bridge.  The helper intentionally has no facility for
 * prompt text, tool input, file contents or arbitrary headers.
 */

import { readFile } from "node:fs/promises";

const MAX = {
  agent: 120,
  session: 180,
  event: 120,
  state: 40,
  title: 120,
  workspace: 160,
  tool: 120,
  model: 120,
  provider: 80,
};

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage: todo-agent-activity --agent <id> --session <id> [options]

Required:
  --agent <id>       codex, openclaw, hermes, opencode, or another allow-listed id
  --session <id>     stable session identifier from the source Agent

Options:
  --event <name>     lifecycle event, for example PreToolUse
  --state <state>    direct state override, for example working
  --title <text>     short session title (optional)
  --workspace <path> workspace path; only its last two components are sent
  --tool <name>      tool name (optional)
  --model <name>     model label (optional)
  --provider <name>  provider label (optional)
  --subagents <n>    active subagent count (optional)
  --sequence <n>     monotonic event sequence (optional)
  --runtime <path>   runtime.json path; defaults to TODO_AGENT_ACTIVITY_RUNTIME
  --quiet            suppress the success response
`);
  process.exitCode = message ? 2 : 0;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true, values };
    if (token === "--quiet") {
      values.quiet = true;
      continue;
    }
    if (!token.startsWith("--")) return { error: `Unknown argument: ${token}` };
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return { error: `Missing value for --${key}` };
    values[key] = value;
    index += 1;
  }
  return { values };
}

function bounded(value, maximum) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, maximum);
  return normalized || undefined;
}

function numberWithin(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

async function main() {
  const { values, error, help } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }
  if (error) {
    usage(error);
    return;
  }
  if (!values.agent || !values.session) {
    usage("--agent and --session are required");
    return;
  }
  const runtimePath = values.runtime || process.env.TODO_AGENT_ACTIVITY_RUNTIME;
  if (!runtimePath) {
    usage("Pass --runtime or set TODO_AGENT_ACTIVITY_RUNTIME to runtime.json");
    return;
  }

  let runtime;
  try {
    runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  } catch (cause) {
    throw new Error(`Unable to read Todo Agent runtime descriptor: ${cause instanceof Error ? cause.message : "invalid file"}`);
  }
  const endpoint = bounded(runtime?.endpoint, 300);
  const tokenPath = bounded(runtime?.tokenPath, 1_024);
  if (!endpoint || !tokenPath || !/^https?:\/\/127\.0\.0\.1(?::\d+)?\/state$/u.test(endpoint)) {
    throw new Error("Todo Agent runtime descriptor is invalid or not loopback-only");
  }
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token || token.length < 24) throw new Error("Todo Agent activity token is missing");

  const payload = {
    agent_id: bounded(values.agent, MAX.agent),
    session_id: bounded(values.session, MAX.session),
    event: bounded(values.event, MAX.event),
    state: bounded(values.state, MAX.state),
    session_title: bounded(values.title, MAX.title),
    cwd: bounded(values.workspace, MAX.workspace),
    tool_name: bounded(values.tool, MAX.tool),
    model: bounded(values.model, MAX.model),
    provider: bounded(values.provider, MAX.provider),
    subagent_count: numberWithin(values.subagents, 0, 64),
    sequence: numberWithin(values.sequence, 0, 2_147_483_647),
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  if (!payload.event && !payload.state) payload.event = "state";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Todo Agent activity bridge rejected the event (${response.status})`);
  }
  if (!values.quiet) {
    try {
      const result = JSON.parse(responseText);
      console.log(`Todo Agent activity: ${result.state || "accepted"}`);
    } catch {
      console.log("Todo Agent activity: accepted");
    }
  }
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : "Todo Agent activity failed");
  process.exitCode = 1;
});
