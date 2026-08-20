import type { CalendarEvent } from "./calendar-events";

export interface CalendarFollowUpDraft {
  title: string;
  notes: string;
  plannedDate: string;
}

function localDateKey(value: string): string | undefined {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : undefined;
}

function localDateTimeLabel(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

/**
 * Build a safe, local-only preview for a post-meeting follow-up task.
 * The caller still needs to show the task editor and wait for confirmation.
 */
export function buildCalendarFollowUpDraft(
  event: CalendarEvent,
  fallbackDate?: string,
): CalendarFollowUpDraft {
  const summary = event.summary.trim() || "未命名日历事件";
  const plannedDate = localDateKey(event.startAt) ?? fallbackDate ?? "";
  const dateLabel = event.allDay
    ? `日期：${plannedDate || "未指定"}`
    : `时间：${localDateTimeLabel(event.startAt)}–${localDateTimeLabel(event.endAt)}`;
  const sourceLabel = event.sourceName.trim() || "本地日历";
  return {
    title: `跟进：${summary}`,
    notes: `会后跟进\n${dateLabel}\n来源：${sourceLabel}`,
    plannedDate,
  };
}
