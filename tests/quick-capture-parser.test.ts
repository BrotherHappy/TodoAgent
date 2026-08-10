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
});
