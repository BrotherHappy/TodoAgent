import type { TaskSourceType } from "../../src/shared/models";

export type AgentTaskSourcePolicy =
  | {
      kind: "explicit";
      source: TaskSourceType;
    }
  | {
      kind: "default-local";
      source: "local";
    }
  | {
      kind: "clarification-required";
      reason: "conflicting-explicit-sources" | "unbound-source-reference";
    }
  | {
      /**
       * The user selected a source for a pending request, but their original
       * task text cannot be sent to the model because chat history is off.
       * Keep the trusted selection visible, while preventing an invented task.
       */
      kind: "details-required";
      source: TaskSourceType;
      reason: "chat-history-disabled";
    };

export class AgentTaskSourcePolicyError extends Error {
  constructor(
    readonly code:
      | "AGENT_TASK_SOURCE_MISMATCH"
      | "AGENT_TASK_SOURCE_CLARIFICATION_REQUIRED"
      | "AGENT_FEISHU_UNAVAILABLE"
      | "AGENT_FEISHU_ACCOUNT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = code;
  }
}

const creationIntent =
  /(?:创建|新建|新增|添加|建立|记下|记录|帮我建|帮我加|帮我记|\b(?:create|add|make|record|new)\b)/iu;

const localSourceToken =
  /(?:本地|本机|当前设备|这台(?:设备|电脑)|电脑(?:上|里)?|离线|local)/iu;
const feishuSourceToken = /(?:飞书|feishu|lark)/iu;

const localSelection = /^(?:本地|本机|local)(?:任务|待办|事项)?(?:吧)?$/iu;
const feishuSelection = /^(?:飞书|feishu|lark)(?:任务|待办|事项)?(?:吧)?$/iu;

const quotedValue = /“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'/gu;
const namedValue =
  /(?:标题|名称|任务名|备注|说明|描述|title|name|notes?|description)\s*(?:是|为|叫|:|=|is|as)?\s*[^，,。；;！？!?\n]+/giu;
const englishNamedValue =
  /\b(?:named|titled|called)\s+[^，,。；;！？!?\n]+/giu;

/**
 * Source choice must be based on an instruction, not arbitrary task content.
 * In particular, a title such as “飞书集成” is ordinary task data rather than
 * a request to create a Feishu task. Keep the labels themselves, but remove
 * title/note/description values before looking for a source directive.
 */
const withoutTaskContentValues = (message: string): string =>
  message
    .replace(quotedValue, " ")
    .replace(namedValue, (match) => {
      const label = /^(?:标题|名称|任务名|备注|说明|描述|title|name|notes?|description)/iu.exec(
        match,
      )?.[0];
      return label ?? " ";
    })
    .replace(englishNamedValue, " ");

const clauses = (message: string): string[] =>
  message
    .split(/[，,。；;！？!?\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);

const hasToken = (text: string, source: TaskSourceType): boolean =>
  (source === "local" ? localSourceToken : feishuSourceToken).test(text);

const sourceLabel = (text: string, source: TaskSourceType): boolean => {
  const token =
    source === "local"
      ? "(?:本地|本机|当前设备|离线|local)"
      : "(?:飞书|feishu|lark)";
  return new RegExp(
    `(?:任务\\s*)?(?:来源|保存位置|创建位置|source)\\s*(?:是|为|设为|设置为|选择|选|使用|=|:|is|as)\\s*${token}`,
    "iu",
  ).test(text);
};

const sourceMentionBoundToCreation = (
  clause: string,
  source: TaskSourceType,
): boolean => {
  const token =
    source === "local"
      ? "(?:本地|本机|当前设备|这台(?:设备|电脑)|离线|local)"
      : "(?:飞书|feishu|lark)";
  const sourceTask = new RegExp(
    `${token}(?:的)?\\s*(?:任务|待办|事项|清单|task|todo|to-do|item)`,
    "iu",
  );
  if (sourceTask.test(clause)) return true;

  // Directional wording in the same clause as creation is an explicit
  // destination. For example: “请在飞书创建任务” or “创建后同步到飞书”.
  const destination = new RegExp(
    `(?:在|到|至|放到|放在|保存到|保存于|同步到|同步至)\\s*${token}(?:里|中|上)?`,
    "iu",
  );
  if (destination.test(clause)) return true;

  const englishDestination = new RegExp(
    `\\b(?:in|on|to)\\s+${token}\\b`,
    "iu",
  );
  return englishDestination.test(clause);
};

/**
 * Recognize only a short, unambiguous answer to a prior source question.
 * This parser is deliberately not used for arbitrary sentences: the caller
 * must additionally prove that a pending source clarification exists.
 */
export const resolveAgentTaskSourceSelection = (
  message: string,
): TaskSourceType | undefined => {
  const normalized = message
    .trim()
    .replace(/[。.!！?？]/gu, "")
    .replace(/\s+/gu, " ");
  if (localSelection.test(normalized)) return "local";
  if (feishuSelection.test(normalized)) return "feishu";
  return undefined;
};

/**
 * Source selection is deliberately conservative. Only a source mentioned in
 * the same creation clause is treated as an explicit instruction; a source
 * reference elsewhere is ambiguous rather than silently becoming an external
 * write. No source mention defaults to local as the safe product default.
 */
export const resolveAgentTaskSourcePolicy = (
  message: string,
): AgentTaskSourcePolicy => {
  const text = withoutTaskContentValues(message.trim());
  const creationClauses = clauses(text).filter((clause) =>
    creationIntent.test(clause),
  );
  if (creationClauses.length === 0) {
    return { kind: "default-local", source: "local" };
  }

  // A labeled source is an instruction even when it appears in a later
  // clause: “创建一个任务，来源是飞书”. Other source mentions must be tied
  // to the same creation clause, otherwise we keep the conservative
  // clarification behavior (“创建一个任务。放到飞书”).
  const explicitLocal =
    sourceLabel(text, "local") ||
    creationClauses.some((clause) =>
      sourceMentionBoundToCreation(clause, "local"),
    );
  const explicitFeishu =
    sourceLabel(text, "feishu") ||
    creationClauses.some((clause) =>
      sourceMentionBoundToCreation(clause, "feishu"),
    );
  if (explicitLocal && explicitFeishu) {
    return {
      kind: "clarification-required",
      reason: "conflicting-explicit-sources",
    };
  }
  if (explicitLocal) return { kind: "explicit", source: "local" };
  if (explicitFeishu) return { kind: "explicit", source: "feishu" };

  // “创建一个任务。放到飞书” contains a source request, but it is not
  // unambiguously attached to a particular creation clause. Ask instead of
  // turning it into either a local task or an external Feishu write.
  if (hasToken(text, "local") || hasToken(text, "feishu")) {
    return {
      kind: "clarification-required",
      reason: "unbound-source-reference",
    };
  }
  return { kind: "default-local", source: "local" };
};

export const taskSourcePolicyInstruction = (
  policy: AgentTaskSourcePolicy,
): string => {
  if (policy.kind === "clarification-required") {
    return "可信任务来源规则：当前用户消息对新任务的本地/飞书来源存在冲突或未绑定的来源引用。不要调用 task_create 或 task_bulk_create，也不要创建任何任务；先简短询问用户要创建到本地还是飞书。";
  }
  if (policy.kind === "details-required") {
    const label = policy.source === "feishu" ? "飞书" : "本地";
    return `可信任务来源规则：用户刚刚明确选择了${label}，但由于“发送聊天历史给模型”未开启，上一条任务详情不会发送给模型。不要调用 task_create 或 task_bulk_create，也不要根据“${label}”猜测任务内容；说明已记住来源选择，并请用户在下一条消息重新说明要创建的任务。`;
  }
  if (policy.kind === "default-local") {
    return "可信任务来源规则：当前用户没有明确指定新任务来源。若需要创建任务，默认且只能创建本地任务（task_create 的 source 必须为 local）；不得静默创建飞书任务。创建后明确说明任务保存在本地。";
  }
  if (policy.source === "local") {
    return "可信任务来源规则：当前用户明确要求创建本地任务。task_create 的 source 必须为 local；不得改为飞书。创建后明确说明任务保存在本地。";
  }
  return "可信任务来源规则：当前用户明确要求创建飞书任务。task_create 的 source 必须为 feishu；飞书不可用时不得改成本地任务，应说明未连接或不可用并询问是否要在下一条消息改为本地。创建后明确说明飞书来源和同步状态。";
};

export const assertTaskCreationSource = (
  source: TaskSourceType,
  policy: AgentTaskSourcePolicy,
): void => {
  if (policy.kind === "clarification-required") {
    throw new AgentTaskSourcePolicyError(
      "AGENT_TASK_SOURCE_CLARIFICATION_REQUIRED",
      "The current user request has conflicting or ambiguous local/Feishu creation intent. Do not create a task. Ask the user whether the new task belongs in local tasks or Feishu.",
    );
  }
  if (policy.kind === "details-required") {
    throw new AgentTaskSourcePolicyError(
      "AGENT_TASK_SOURCE_CLARIFICATION_REQUIRED",
      `The user selected ${policy.source}, but chat history is disabled and the pending task details are unavailable. Do not create a guessed task. Ask the user to repeat the task details in a new message.`,
    );
  }
  if (source === policy.source) return;

  const requested =
    policy.kind === "default-local"
      ? "The user did not specify a source, so the trusted default is local. Retry with source=local; do not create a Feishu task."
      : policy.source === "local"
        ? "The user explicitly requested a local task. Retry with source=local; do not create a Feishu task."
        : "The user explicitly requested a Feishu task. Retry with source=feishu; do not create a local task.";
  throw new AgentTaskSourcePolicyError(
    "AGENT_TASK_SOURCE_MISMATCH",
    requested,
  );
};

export const assertFeishuTaskCreationAvailable = (
  accountId: string | undefined,
): asserts accountId is string => {
  if (accountId) return;
  throw new AgentTaskSourcePolicyError(
    "AGENT_FEISHU_UNAVAILABLE",
    "The user explicitly requested a Feishu task, but no Feishu account is connected or available. Do not create a local fallback task. Explain the connection issue and ask whether the user wants a local task in a new message.",
  );
};

/**
 * A task imported from (or created for) one Feishu account must never be
 * mutated through another account's currently-connected sync runtime. The
 * durable mutation bridge deliberately filters by accountId; without this
 * guard an Agent write could look accepted locally yet remain pending forever
 * because no runtime is allowed to upload it.
 *
 * Callers without an account resolver are deliberately left compatible with
 * isolated/local tool harnesses. The packaged desktop always supplies the
 * resolver and therefore gets the fail-closed behavior.
 */
export const assertFeishuTaskMutationAccount = (
  taskAccountId: string | undefined,
  connectedAccountId: string | undefined,
): void => {
  if (!connectedAccountId) {
    throw new AgentTaskSourcePolicyError(
      "AGENT_FEISHU_UNAVAILABLE",
      "This Feishu task cannot be changed remotely because no Feishu account is currently connected. Do not leave a local-only pending mutation; ask the user to reconnect first.",
    );
  }
  if (!taskAccountId || taskAccountId !== connectedAccountId) {
    throw new AgentTaskSourcePolicyError(
      "AGENT_FEISHU_ACCOUNT_MISMATCH",
      "This Feishu task is not bound to the currently connected Feishu account. Do not apply a mutation that the active sync queue cannot upload. Ask the user to reconnect the matching account or re-import/rebind the task.",
    );
  }
};
