import { describe, expect, it } from 'vitest';
import { taskOperationErrorMessage } from '../src/shared/task-errors';
import { hasTaskTitle, taskTitleForDisplay } from '../src/shared/task-title';

describe('task feedback boundary', () => {
  it('translates the reported Electron exception into a recovery instruction', () => {
    const message = taskOperationErrorMessage(new Error("Error invoking remote method 'tasks:apply-today-plan': TaskValidationError: Task title cannot be empty."));
    expect(message).toContain('任务暂缺标题');
    expect(message).toContain('刷新任务');
    expect(message).not.toMatch(/Error|tasks:|cannot be/u);
  });
  it.each([
    ['TaskNotFoundError: Task not found: a-private-id', '重新预览'],
    ['TaskStateError: Task is not open: a-private-id', '重新预览'],
    ['TaskStateError: Task is in trash: a-private-id', '回收站'],
    ['UndoConflictError: Operation 1 cannot be undone because task 2 changed afterwards.', '无法安全撤销'],
    ['Error: ENOSPC: no space left on device, open /private/profile/state.json', '磁盘空间不足'],
  ])('provides actionable feedback for %s', (input, expected) => {
    expect(taskOperationErrorMessage(new Error(input))).toContain(expected);
  });
  it('preserves intentional Chinese conflicts without Electron wrappers', () => {
    expect(taskOperationErrorMessage(new Error("Error invoking remote method 'tasks:apply-today-plan': TaskStateError: 任务的计划已在别处发生变化，请重新预览。")))
      .toBe('任务的计划已在别处发生变化，请重新预览。');
  });
  it.each([new Error('unexpected internal failure'), new Error('服务器失败 https://example.test/?key=private'), new Error('错误 Bearer private'), { code: 'INTERNAL' }])('does not expose raw internals or credential-bearing messages: %s', reason => {
    expect(taskOperationErrorMessage(reason, '请稍后再试')).toBe('请稍后再试');
  });
});

describe('missing task titles remain distinguishable display data', () => {
  it.each([undefined, null, 0, '', ' \n\t', '\u200b\u200d\u2060'])('rejects unreadable input: %j', value => {
    expect(hasTaskTitle(value)).toBe(false);
    expect(taskTitleForDisplay({ title: value, source: { type: 'feishu' } })).toBe('待补全标题的飞书任务');
  });
  it('keeps meaningful Unicode and does not mutate task data to store a fallback', () => {
    const task = { title: '', source: { type: 'feishu' } };
    taskTitleForDisplay(task);
    expect(task.title).toBe('');
    expect(hasTaskTitle(' 👩‍💻 ')).toBe(true);
    expect(taskTitleForDisplay({ title: ' 阅读论文 ' })).toBe('阅读论文');
  });
});
