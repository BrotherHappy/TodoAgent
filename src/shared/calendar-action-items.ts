import type { CalendarEvent } from "./calendar-events";
import { buildCalendarFollowUpDraft } from "./calendar-follow-up";

export interface CalendarActionItemDraft {
  id: string;
  title: string;
  notes: string;
  plannedDate: string;
}

const MAX_ITEMS = 8;
const MAX_TITLE_CHARS = 160;
const BULLET_PATTERN = /^\s*(?:[-*•▪◦]|☐|☑|\[[ xX]\]|\d+[.)])\s+/u;
const PREFIX_PATTERN = /^\s*(?:行动项|待办|跟进|下一步|action\s*item|todo|to-do|next\s*step)\s*[:：\-]\s*/iu;
const ACTION_VERB_PATTERN = /(?:完成|准备|联系|发送|确认|更新|整理|安排|创建|检查|跟进|review|send|follow(?:\s|-)?up|prepare|finish|complete|update|schedule|create|check|contact)/iu;

function splitCandidate(value: string): string[] {
  return value
    .split(/\s*[;；]\s*/u)
    .map((part) => part.replace(/^[-–—:：]\s*/u, "").trim())
    .filter(Boolean);
}

function normalizeCandidate(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/[。；;]+$/u, "")
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

function localDateForEvent(event: CalendarEvent, fallbackDate?: string): string {
  const instant = new Date(event.startAt);
  if (!Number.isNaN(instant.getTime())) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return date;
  }
  return fallbackDate ?? "";
}

/**
 * Extract only explicit or strongly signalled action items from a meeting
 * description. This is deliberately deterministic and local-only: ordinary
 * agenda prose is left alone, while checklists and “行动项/Next steps” blocks
 * become editable drafts for the user to confirm.
 */
export function extractCalendarActionItems(
  event: CalendarEvent,
  fallbackDate?: string,
): CalendarActionItemDraft[] {
  const description = event.description?.replace(/\r\n?/gu, "\n").trim();
  if (!description) return [];
  const lines = description.split("\n");
  const hasExplicitCue = /(?:行动项|待办|下一步|action\s*item|todo|to-do|next\s*step)/iu.test(description);
  const candidates: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const prefixed = PREFIX_PATTERN.exec(line);
    const bullet = BULLET_PATTERN.test(line);
    const withoutBullet = bullet ? line.replace(BULLET_PATTERN, "") : line;
    const value = prefixed?.[0]
      ? line.slice(prefixed[0].length)
      : bullet
        ? withoutBullet
        : "";
    if (!value) continue;
    // Once a description explicitly declares an action-item section, its
    // bullets are trusted. Without that cue, require a checklist marker or a
    // recognisable action verb to avoid turning every agenda bullet into work.
    if (!prefixed && !hasExplicitCue && !/^(?:☐|☑|\[[ xX]\])/u.test(line) && !ACTION_VERB_PATTERN.test(value)) {
      continue;
    }
    candidates.push(...splitCandidate(value));
  }

  const plannedDate = localDateForEvent(event, fallbackDate);
  const context = buildCalendarFollowUpDraft(event, plannedDate);
  const seen = new Set<string>();
  const drafts: CalendarActionItemDraft[] = [];
  for (const candidate of candidates) {
    const title = normalizeCandidate(candidate);
    const key = title.toLocaleLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      id: `${event.id}-action-${drafts.length + 1}`,
      title,
      notes: `会议：${event.summary.trim() || "未命名日历事件"}\n会议行动项：${title}\n${context.notes}`,
      plannedDate,
    });
    if (drafts.length >= MAX_ITEMS) break;
  }
  return drafts;
}
