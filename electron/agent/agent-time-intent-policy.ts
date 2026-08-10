export type AgentTimeIntentPolicy =
  | { kind: "allow" }
  | {
      kind: "clarification-required";
      code:
        | "AGENT_INVALID_DATE"
        | "AGENT_AMBIGUOUS_TIME"
        | "AGENT_REMINDER_TIME_REQUIRED";
      clarification: string;
    };

const writeIntent =
  /(?:创建|新建|新增|添加|建立|记下|记录|安排|修改|更新|设置|设为|提醒|截止(?:日期|时间)?\s*(?:是|为|改为|设为)|开始(?:日期|时间)?\s*(?:是|为|改为|设为)|create|add|schedule|update|set|remind)/iu;
const reminderIntent = /(?:提醒|remind)/iu;

/**
 * A request can explicitly say that a new task must *not* have a reminder,
 * e.g. “不设置日期、备注、标签或提醒”.  That wording contains 提醒 but is not a
 * request to schedule one, so it must not be rejected for lacking a clock
 * time.  Strip only clear negative reminder clauses before deciding whether
 * the user asked for a reminder; ambiguous/positive mentions stay protected.
 */
const hasPositiveReminderIntent = (message: string): boolean => {
  const withoutNegativeReminderClauses = message
    .replace(
      /(?:不(?:要|用|需)?|无需|无|取消|关闭)\s*(?:设置|添加|创建|保留|开启)?\s*(?:提醒|remind(?:er)?)/giu,
      "",
    )
    .replace(
      /(?:不设置|不添加|不保留)(?:[\s、,，和与及或/]|日期|备注|标签|时间|开始|截止){0,32}(?:提醒|remind(?:er)?)/giu,
      "",
    )
    .replace(
      /(?:without|no|don't|do not)\s*(?:set\s*)?(?:a\s*)?(?:reminder|remind)/giu,
      "",
    );
  return reminderIntent.test(withoutNegativeReminderClauses);
};

const isValidDate = (year: number, month: number, day: number): boolean => {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const isAlwaysInvalidMonthDay = (month: number, day: number): boolean => {
  if (month < 1 || month > 12 || day < 1) return true;
  if (month === 2) return day > 29;
  if ([4, 6, 9, 11].includes(month)) return day > 30;
  return day > 31;
};

const invalidDateMention = (message: string): string | undefined => {
  const fullDate =
    /(?:^|[^\d])(\d{4})\s*(?:-|\/|年)\s*(\d{1,2})\s*(?:-|\/|月)\s*(\d{1,2})(?:日)?(?=$|[^\d])/gu;
  for (const match of message.matchAll(fullDate)) {
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (!isValidDate(year, month, day)) {
      return `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`;
    }
  }

  const monthDay = /(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})(?:日)?(?=$|[^\d])/gu;
  for (const match of message.matchAll(monthDay)) {
    const [, monthText, dayText] = match;
    if (isAlwaysInvalidMonthDay(Number(monthText), Number(dayText))) {
      return `${monthText}月${dayText}日`;
    }
  }
  return undefined;
};

const ambiguousTimeMention = (message: string): string | undefined => {
  const matches: Array<[RegExp, string]> = [
    [/(?:这|本|下|上)?周末/u, "周末"],
    [/(?:再)?过\s*几\s*天|几\s*天(?:后|之后)?/u, "过几天"],
    [/(?:这|本|下)周(?![一二三四五六日天])/u, "本周或下周"],
    [/(?:月初|月底|稍后|晚些时候)/u, "模糊时间"],
  ];
  return matches.find(([pattern]) => pattern.test(message))?.[1];
};

const hasExplicitClockTime = (message: string): boolean =>
  /(?:\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b|(?:凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)?\s*(?:[一二三四五六七八九十\d]{1,3})\s*(?:点|时)(?:半|\s*\d{1,2}\s*分?)?)/iu.test(
    message,
  );

/**
 * This is deliberately a narrow, trusted preflight for the unsafe temporal
 * forms that users cannot reasonably expect a model to guess. Other valid
 * natural-language date resolution remains model-assisted, with the current
 * device time injected by AgentDesktopService.
 */
export const resolveAgentTimeIntentPolicy = (
  message: string,
): AgentTimeIntentPolicy => {
  if (!writeIntent.test(message)) return { kind: "allow" };

  const invalidDate = invalidDateMention(message);
  if (invalidDate) {
    return {
      kind: "clarification-required",
      code: "AGENT_INVALID_DATE",
      clarification: `“${invalidDate}”不是有效日期。我没有创建或修改任何任务；请提供一个有效的具体日期。`,
    };
  }

  const ambiguous = ambiguousTimeMention(message);
  if (ambiguous) {
    return {
      kind: "clarification-required",
      code: "AGENT_AMBIGUOUS_TIME",
      clarification: `“${ambiguous}”不够具体。我没有创建或修改任何任务；请提供明确日期（例如“下周一”或 YYYY-MM-DD）以及需要时的具体时间。`,
    };
  }

  if (hasPositiveReminderIntent(message) && !hasExplicitClockTime(message)) {
    return {
      kind: "clarification-required",
      code: "AGENT_REMINDER_TIME_REQUIRED",
      clarification:
        "提醒需要明确的具体时刻。我没有创建或修改任何任务；请告诉我日期和时间，例如“明天下午六点提醒我”。",
    };
  }

  return { kind: "allow" };
};

export const agentTimeIntentPolicyInstruction = (): string =>
  "可信时间安全规则：日期不存在、时间含糊（如“周末”“过几天”）或提醒缺少具体时刻时，不得调用任何写工具；先说明问题并请求明确日期/时间。不得把“周末”擅自设为周六或周日，不得把“过几天”编造成具体日期，也不得为提醒编造时刻。";
