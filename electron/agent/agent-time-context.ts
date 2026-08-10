export interface AgentTimeContext {
  /** IANA timezone resolved from the current device or an injected test clock. */
  timeZone: string;
  /** Calendar day in the resolved timezone, in YYYY-MM-DD form. */
  localDate: string;
  /** Local wall-clock time in 24-hour HH:mm:ss form. */
  localTime: string;
  /** UTC offset at the current instant, in +HH:mm / -HH:mm form. */
  utcOffset: string;
  /** Localized weekday for the current device locale. */
  weekday: string;
  /** Exact instant retained for audit-friendly model context. */
  instant: string;
}

const systemTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const usableTimeZone = (candidate: string | undefined): string => {
  const value = candidate?.trim() || systemTimeZone();
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format();
    return value;
  } catch {
    return systemTimeZone();
  }
};

const numericPart = (
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string => {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) throw new Error(`AGENT_TIME_PART_UNAVAILABLE:${type}`);
  return value;
};

const offsetText = (offsetMinutes: number): string => {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
};

/**
 * Formats an instant in the user's current IANA timezone without relying on
 * process-local Date getters. Keeping this separate makes date rollover and
 * timezone tests deterministic and prevents an Agent prompt from guessing the
 * calendar day from model training data.
 */
export const createAgentTimeContext = (
  now: Date,
  requestedTimeZone?: string,
): AgentTimeContext => {
  const timeZone = usableTimeZone(requestedTimeZone);
  const parts = new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const year = numericPart(parts, "year");
  const month = numericPart(parts, "month");
  const day = numericPart(parts, "day");
  const hour = numericPart(parts, "hour");
  const minute = numericPart(parts, "minute");
  const second = numericPart(parts, "second");
  const localMilliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const instantMilliseconds = Math.floor(now.getTime() / 1_000) * 1_000;
  const offsetMinutes = Math.round(
    (localMilliseconds - instantMilliseconds) / 60_000,
  );
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    weekday: "long",
  }).format(now);

  return {
    timeZone,
    localDate: `${year}-${month}-${day}`,
    localTime: `${hour}:${minute}:${second}`,
    utcOffset: offsetText(offsetMinutes),
    weekday,
    instant: now.toISOString(),
  };
};

export const agentTimeContextInstruction = (
  context: AgentTimeContext,
): string =>
  `可信当前时间（每轮由应用重新计算，不能用训练数据猜测）：时区=${context.timeZone}；本地日期=${context.localDate}；本地时间=${context.localTime}；UTC offset=${context.utcOffset}；星期=${context.weekday}；当前绝对时刻=${context.instant}。解析“今天、明天、后天、下周一”等相对日期时必须以此为准。plannedDate 是本地日历日 YYYY-MM-DD；startAt 和 dueAt 必须是带 offset 的 ISO 8601 时间。未来日期若遇夏令时 offset 不确定，先向用户澄清，不得猜测。`;
