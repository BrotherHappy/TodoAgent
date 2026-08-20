// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseQuickCapture } from '../electron/services/quick-capture-parser';

const reference = new Date('2026-08-09T09:00:00+08:00');

describe('parseQuickCapture', () => {
  it('parses a Feishu deadline and relative reminder without losing the title', () => {
    const result = parseQuickCapture('明天下午三点前完成发布说明，存到飞书并提前半小时提醒', reference);
    expect(result.title).toBe('完成发布说明');
    expect(result.source).toBe('feishu');
    expect(result.dueAt).toBeTruthy();
    expect(result.privatePlanAt).toBeUndefined();
    expect(new Date(result.dueAt!).getTime() - new Date(result.reminderAt!).getTime()).toBe(30 * 60_000);
  });

  it('keeps a normal planned time private for a local task', () => {
    const result = parseQuickCapture('明天上午十点整理访谈笔记 #研究 项目：发布', reference);
    expect(result.source).toBe('local');
    expect(result.privatePlanAt).toBeTruthy();
    expect(result.dueAt).toBeUndefined();
    expect(result.project).toBe('发布');
    expect(result.tags).toContain('研究');
  });

  it('extracts priority while preserving uncertain original text for review', () => {
    const result = parseQuickCapture('重要：找时间复查数据', reference);
    expect(result.priority).toBe(2);
    expect(result.title).toContain('复查数据');
    expect(result.chips.some((chip) => chip.id === 'source' && chip.confidence === 'inferred')).toBe(true);
  });

  it('parses Todoist-style p1-p4 priority tokens and removes them from the title', () => {
    expect(parseQuickCapture('整理周报 p1', reference)).toMatchObject({
      title: '整理周报',
      priority: 3,
    });
    expect(parseQuickCapture('整理周报 p2', reference).priority).toBe(2);
    expect(parseQuickCapture('整理周报 p3', reference).chips).toContainEqual(
      expect.objectContaining({ id: 'priority', label: 'P3 · 中优先级' }),
    );
    expect(parseQuickCapture('整理周报 p4', reference).priority).toBe(0);
  });

  it('extracts manual contexts from Smart Add syntax without requesting location', () => {
    const result = parseQuickCapture('明天去办公室整理访谈笔记 @办公室 情境：深度工作', reference);
    expect(result.contexts).toEqual(['办公室', '深度工作']);
    expect(result.title).toBe('去办公室整理访谈笔记');
    expect(result.chips.filter((chip) => chip.id === 'context').map((chip) => chip.value)).toEqual([
      '办公室',
      '深度工作',
    ]);
  });

  it('extracts a bounded estimated duration from Smart Add syntax', () => {
    const result = parseQuickCapture('整理发布说明，预计 45 分钟 @办公室', reference);
    expect(result.estimatedMinutes).toBe(45);
    expect(result.title).toBe('整理发布说明');
    expect(result.chips).toContainEqual(expect.objectContaining({
      id: 'duration',
      value: '45',
      label: '预计 45 分钟',
    }));
  });

  it('normalizes shorthand hours and ignores estimates outside task limits', () => {
    expect(parseQuickCapture('整理资料 1.5h', reference).estimatedMinutes).toBe(90);
    expect(parseQuickCapture('整理资料 2 分钟', reference).estimatedMinutes).toBeUndefined();
    expect(parseQuickCapture('整理资料 13 小时', reference).estimatedMinutes).toBeUndefined();
  });

  it('parses local recurring task syntax into a structured rule', () => {
    const result = parseQuickCapture('每周一、三、五 9点整理周报', reference);
    expect(result.title).toBe('整理周报');
    expect(result.recurrence).toEqual({ frequency: 'weekly', interval: 1, weekdays: [1, 3, 5] });
    expect(result.chips.some((chip) => chip.id === 'recurrence')).toBe(true);
    expect(parseQuickCapture('每周一和周三整理周报', reference).recurrence).toEqual({
      frequency: 'weekly',
      interval: 1,
      weekdays: [1, 3],
    });
  });

  it('supports daily, workday and monthly recurrence without accepting invalid intervals', () => {
    expect(parseQuickCapture('每天整理收件箱', reference).recurrence).toEqual({ frequency: 'daily', interval: 1 });
    expect(parseQuickCapture('每个工作日处理日报', reference).recurrence).toEqual({
      frequency: 'weekly',
      interval: 1,
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(parseQuickCapture('每月15日缴费', reference).recurrence).toEqual({
      frequency: 'monthly',
      interval: 1,
      dayOfMonth: 15,
    });
    expect(parseQuickCapture('每隔 0 天整理资料', reference).recurrence).toBeUndefined();
  });
});
