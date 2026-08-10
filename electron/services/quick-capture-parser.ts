import * as chrono from 'chrono-node';
import type { CaptureChip, QuickCaptureResult } from '../../src/shared/quick-capture';

const projectPattern = /(?:项目|清单)[:：]\s*([^，,。；;\s]+)/u;
const hashTagPattern = /#([^#\s，,。；;]+)/gu;
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

function normalizeTitle(value: string): string {
  return value
    .replace(/^(?:新增|创建|记下|帮我记|提醒我|待办)\s*(?:一个|一条)?\s*(?:任务|待办)?[:：]?\s*/u, '')
    .replace(/(?:存|创建|同步|放|添加)到飞书(?:任务)?/gu, '')
    .replace(/(?:存|创建|放|添加)到本地(?:任务)?/gu, '')
    .replace(/(?:并)?提前\s*(?:\d+|半)\s*(?:分钟|小时|天)(?:提醒)?/gu, '')
    .replace(/(?:提醒我|提醒一下)/gu, '')
    .replace(projectPattern, '')
    .replace(hashTagPattern, '')
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
  const parsed = chrono.zh.hans.casual.parse(originalText, now, { forwardDate: true });
  const primary = parsed[0];
  const parsedDate = primary?.start.date();
  const isDeadline = /(?:截止|之前|以前|前完成|到期)/u.test(originalText) || source === 'feishu';
  const offset = reminderOffsetMs(originalText.match(reminderPattern));
  const reminderAt = parsedDate && offset !== undefined
    ? new Date(parsedDate.getTime() - offset).toISOString()
    : undefined;

  let withoutDate = originalText;
  for (const result of [...parsed].reverse()) {
    withoutDate = `${withoutDate.slice(0, result.index)} ${withoutDate.slice(result.index + result.text.length)}`;
  }
  const title = normalizeTitle(withoutDate)
    .replace(/(?:截止|之前|以前|到期)|前(?=完成)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim() || originalText;

  const chips: CaptureChip[] = [];
  if (parsedDate) chips.push({ id: 'date', label: dateLabel(parsedDate), value: parsedDate.toISOString(), confidence: primary.start.isCertain('hour') ? 'certain' : 'inferred' });
  if (reminderAt) chips.push({ id: 'reminder', label: `提醒 ${dateLabel(new Date(reminderAt))}`, value: reminderAt, confidence: 'certain' });
  if (project) chips.push({ id: 'project', label: project, value: project, confidence: 'certain' });
  tags.forEach((tag) => chips.push({ id: 'tag', label: `#${tag}`, value: tag, confidence: 'certain' }));
  if (priority !== 1) chips.push({ id: 'priority', label: priority === 3 ? '紧急' : priority === 2 ? '高优先级' : '低优先级', value: String(priority), confidence: 'certain' });
  chips.push({ id: 'source', label: source === 'feishu' ? '飞书' : '本地', value: source, confidence: /飞书|本地/u.test(originalText) ? 'certain' : 'inferred' });

  return {
    originalText,
    title,
    source,
    priority,
    project,
    tags,
    dueAt: isDeadline && parsedDate ? parsedDate.toISOString() : undefined,
    privatePlanAt: !isDeadline && parsedDate ? parsedDate.toISOString() : undefined,
    reminderAt,
    chips,
    needsReview: !title || Boolean(primary && !primary.start.isCertain('hour') && /(?:点|时)/u.test(primary.text)) || Boolean(directReminderPattern.test(originalText) && !parsedDate),
  };
}
