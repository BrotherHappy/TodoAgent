import * as chrono from 'chrono-node';
import type { RecurrenceRule } from '../../src/shared/models';
import type { CaptureChip, QuickCaptureResult } from '../../src/shared/quick-capture';

const projectPattern = /(?:项目|清单)[:：]\s*([^，,。；;\s]+)/u;
const hashTagPattern = /#([^#\s，,。；;]+)/gu;
const contextPattern = /(?:情境|场景|地点)[:：]\s*([^，,。；;\s]+)/u;
const atContextPattern = /@([\p{L}\p{N}_-]{1,40})/gu;
const durationPattern = /(?:预计|大约|约|用时|耗时|时长|需要)[:：]?\s*(\d+(?:\.\d+)?)\s*(分钟|分|小时|时|m|h)/iu;
const shorthandDurationPattern = /(\d+(?:\.\d+)?)\s*(m|h)\b/iu;
const recurrenceDailyPattern = /每(?:隔\s*)?(\d+)?\s*天/u;
const recurrenceWeeklyPattern = /每(?:隔\s*)?(\d+)?\s*周([一二三四五六日天周、，,和\s]*)?/u;
const recurrenceMonthlyPattern = /每(?:隔\s*)?(\d+)?\s*个?月(?:\s*(\d{1,2})\s*(?:日|号))?/u;
const workdayPattern = /工作日/u;
const reminderPattern = /提前\s*(\d+|半)\s*(分钟|小时|天)(?:提醒)?/u;
const directReminderPattern = /(?:在)?(.{0,16})(?:提醒我|提醒一下)/u;

function reminderOffsetMs(match: RegExpMatchArray | null): number | undefined {
  if (!match) return undefined;
  const amount = match[1] === '半' ? 0.5 : Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2];
  if (unit === '分钟') return amount * 60_000;
  if (unit === '小时') return amount * 60 * 60_000;
  return amount * 24 * 60 * 60_000;
}

function parseDuration(text: string): number | undefined {
  const match = text.match(durationPattern) ?? text.match(shorthandDurationPattern);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2].toLocaleLowerCase();
  const minutes = unit === '小时' || unit === '时' || unit === 'h'
    ? amount * 60
    : amount;
  const rounded = Math.round(minutes);
  return rounded >= 5 && rounded <= 720 ? rounded : undefined;
}

const weekdayMap: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function parseRecurrence(text: string): { rule?: RecurrenceRule; match?: RegExpMatchArray; label?: string } {
  const monthly = text.match(recurrenceMonthlyPattern);
  if (monthly) {
    const interval = Number(monthly[1] ?? 1);
    const dayOfMonth = monthly[2] ? Number(monthly[2]) : undefined;
    if (interval >= 1 && interval <= 365 && (!dayOfMonth || (dayOfMonth >= 1 && dayOfMonth <= 31))) {
      return {
        rule: { frequency: 'monthly', interval, ...(dayOfMonth ? { dayOfMonth } : {}) },
        match: monthly,
        label: dayOfMonth ? `每${interval === 1 ? '' : `${interval}个月`} ${dayOfMonth}日` : interval === 1 ? '每月' : `每隔 ${interval} 个月`,
      };
    }
  }

  const weekly = text.match(recurrenceWeeklyPattern);
  if (weekly) {
    const interval = Number(weekly[1] ?? 1);
    const weekdays = [...(weekly[2] ?? '')]
      .map((character) => weekdayMap[character])
      .filter((day): day is number => day !== undefined)
      .filter((day, index, values) => values.indexOf(day) === index)
      .sort((left, right) => left - right);
    if (interval >= 1 && interval <= 365) {
      const weekdayLabel = weekdays.map((day) => ['日', '一', '二', '三', '四', '五', '六'][day]).join('、');
      return {
        rule: { frequency: 'weekly', interval, ...(weekdays.length ? { weekdays } : {}) },
        match: weekly,
        label: weekdays.length
          ? `每${interval === 1 ? '' : `${interval}周`}${weekdayLabel}`
          : interval === 1 ? '每周' : `每隔 ${interval} 周`,
      };
    }
  }

  const daily = text.match(recurrenceDailyPattern);
  if (daily) {
    const interval = Number(daily[1] ?? 1);
    if (interval >= 1 && interval <= 365) {
      return {
        rule: { frequency: 'daily', interval },
        match: daily,
        label: interval === 1 ? '每天' : `每隔 ${interval} 天`,
      };
    }
  }

  const workday = text.match(workdayPattern);
  if (workday) {
    return {
      rule: { frequency: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] },
      match: workday,
      label: '每个工作日',
    };
  }

  return {};
}

function normalizeTitle(value: string): string {
  return value
    .replace(/^(?:新增|创建|记下|帮我记|提醒我|待办)\s*(?:一个|一条)?\s*(?:任务|待办)?[:：]?\s*/u, '')
    .replace(/(?:存|创建|同步|放|添加)到飞书(?:任务)?/gu, '')
    .replace(/(?:存|创建|放|添加)到本地(?:任务)?/gu, '')
    .replace(/(?:并)?提前\s*(?:\d+|半)\s*(?:分钟|小时|天)(?:提醒)?/gu, '')
    .replace(/(?:提醒我|提醒一下)/gu, '')
    .replace(projectPattern, '')
    .replace(contextPattern, '')
    .replace(hashTagPattern, '')
    .replace(atContextPattern, '')
    .replace(durationPattern, '')
    .replace(shorthandDurationPattern, '')
    .replace(/[，,。；;]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function dateLabel(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function parseQuickCapture(text: string, now = new Date()): QuickCaptureResult {
  const originalText = text.trim();
  const source = /飞书/u.test(originalText) ? 'feishu' : 'local';
  const priority: QuickCaptureResult['priority'] = /(?:!!!|紧急|最高优先级)/u.test(originalText)
    ? 3
    : /(?:!!|高优先级|重要)/u.test(originalText)
      ? 2
      : /(?:低优先级|稍后有空)/u.test(originalText)
        ? 0
        : 1;
  const project = originalText.match(projectPattern)?.[1];
  const tags = [...originalText.matchAll(hashTagPattern)].map((match) => match[1]);
  const contextMatch = originalText.match(contextPattern);
  const contextCandidates = [
    ...(contextMatch?.[1]
      ? [{ value: contextMatch[1], index: contextMatch.index ?? 0 }]
      : []),
    ...[...originalText.matchAll(atContextPattern)].map((match) => ({
      value: match[1],
      index: match.index,
    })),
  ].sort((left, right) => left.index - right.index);
  const contexts = contextCandidates.map((candidate) => candidate.value).filter((context, index, values) => {
    const key = context.trim().toLocaleLowerCase();
    return values.findIndex((candidate) => candidate.trim().toLocaleLowerCase() === key) === index;
  });
  const estimatedMinutes = parseDuration(originalText);
  const recurrence = parseRecurrence(originalText);
  // Remove the recurrence phrase before chrono sees the text. Chinese chrono
  // can otherwise consume part of “每周一、三、五” as a date and leave a
  // broken fragment in the title.
  const textForDate = recurrence.match?.[0]
    ? originalText.replace(recurrence.match[0], ' ')
    : originalText;
  const parsed = chrono.zh.hans.casual.parse(textForDate, now, { forwardDate: true });
  const primary = parsed[0];
  const parsedDate = primary?.start.date();
  const isDeadline = /(?:截止|之前|以前|前完成|到期)/u.test(originalText) || source === 'feishu';
  const offset = reminderOffsetMs(originalText.match(reminderPattern));
  const reminderAt = parsedDate && offset !== undefined
    ? new Date(parsedDate.getTime() - offset).toISOString()
    : undefined;

  let withoutDate = textForDate;
  for (const result of [...parsed].reverse()) {
    // chrono-node treats the first character of a following Chinese title as
    // the “整” (exactly) suffix in phrases such as “9点整理周报”. Keep that
    // character when it is immediately followed by another Chinese word.
    const resultEnd = result.index + result.text.length;
    const accidentalExactSuffix = result.text.endsWith('整')
      && /点/u.test(result.text)
      && /[\p{L}]/u.test(textForDate[resultEnd] ?? '');
    const removalLength = accidentalExactSuffix ? result.text.length - 1 : result.text.length;
    withoutDate = `${withoutDate.slice(0, result.index)} ${withoutDate.slice(result.index + removalLength)}`;
  }
  const title = normalizeTitle(withoutDate)
    .replace(recurrence.match?.[0] ?? '', '')
    .replace(/(?:截止|之前|以前|到期)|前(?=完成)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim() || originalText;

  const chips: CaptureChip[] = [];
  if (parsedDate) chips.push({ id: 'date', label: dateLabel(parsedDate), value: parsedDate.toISOString(), confidence: primary.start.isCertain('hour') ? 'certain' : 'inferred' });
  if (reminderAt) chips.push({ id: 'reminder', label: `提醒 ${dateLabel(new Date(reminderAt))}`, value: reminderAt, confidence: 'certain' });
  if (project) chips.push({ id: 'project', label: project, value: project, confidence: 'certain' });
  tags.forEach((tag) => chips.push({ id: 'tag', label: `#${tag}`, value: tag, confidence: 'certain' }));
  contexts.forEach((context) => chips.push({ id: 'context', label: `情境 · ${context}`, value: context, confidence: 'certain' }));
  if (estimatedMinutes !== undefined) chips.push({ id: 'duration', label: `预计 ${estimatedMinutes} 分钟`, value: String(estimatedMinutes), confidence: 'certain' });
  if (recurrence.rule) chips.push({ id: 'recurrence', label: `循环 · ${recurrence.label ?? '已设置'}`, value: JSON.stringify(recurrence.rule), confidence: 'certain' });
  if (priority !== 1) chips.push({ id: 'priority', label: priority === 3 ? '紧急' : priority === 2 ? '高优先级' : '低优先级', value: String(priority), confidence: 'certain' });
  chips.push({ id: 'source', label: source === 'feishu' ? '飞书' : '本地', value: source, confidence: /飞书|本地/u.test(originalText) ? 'certain' : 'inferred' });

  return {
    originalText,
    title,
    source,
    priority,
    project,
    tags,
    contexts,
    estimatedMinutes,
    recurrence: recurrence.rule,
    dueAt: isDeadline && parsedDate ? parsedDate.toISOString() : undefined,
    privatePlanAt: !isDeadline && parsedDate ? parsedDate.toISOString() : undefined,
    reminderAt,
    chips,
    needsReview: !title || Boolean(primary && !primary.start.isCertain('hour') && /(?:点|时)/u.test(primary.text)) || Boolean(directReminderPattern.test(originalText) && !parsedDate),
  };
}
