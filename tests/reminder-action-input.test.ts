// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  parseCustomSnoozeInput,
  parseReminderActionInput,
} from '../electron/services/reminder-action-input';

describe('reminder IPC action input', () => {
  it('keeps every existing preset action and strips surrounding id whitespace', () => {
    for (const action of [
      'complete',
      'snooze-10m',
      'snooze-1h',
      'tomorrow',
      'open',
      'dismiss',
    ] as const) {
      expect(parseReminderActionInput({
        reminderId: '  reminder-1  ',
        action,
      })).toEqual({ reminderId: 'reminder-1', action });
    }
  });

  it('accepts only a timezone-qualified ISO timestamp for custom snooze', () => {
    expect(parseReminderActionInput({
      reminderId: 'reminder-1',
      action: 'snooze-until',
      snoozeUntil: '2026-08-09T17:30:00.000+08:00',
    })).toEqual({
      reminderId: 'reminder-1',
      action: 'snooze-until',
      snoozeUntil: '2026-08-09T17:30:00.000+08:00',
    });

    for (const snoozeUntil of [
      '2026-08-09',
      '2026-08-09T09:30:00',
      'tomorrow',
      '',
    ]) {
      expect(() => parseReminderActionInput({
        reminderId: 'reminder-1',
        action: 'snooze-until',
        snoozeUntil,
      })).toThrow();
    }
  });

  it('rejects unknown fields, mixed action shapes, oversized ids, and unknown actions', () => {
    const invalidInputs: unknown[] = [
      {
        reminderId: 'reminder-1',
        action: 'open',
        snoozeUntil: '2026-08-09T09:30:00.000Z',
      },
      {
        reminderId: 'reminder-1',
        action: 'snooze-until',
      },
      {
        reminderId: 'x'.repeat(513),
        action: 'dismiss',
      },
      {
        reminderId: 'reminder-1',
        action: 'delete',
      },
      {
        reminderId: 'reminder-1',
        action: 'snooze-until',
        snoozeUntil: '2026-08-09T09:30:00.000Z',
        prototype: 'pollution-attempt',
      },
    ];
    invalidInputs.forEach((input) => {
      expect(() => parseReminderActionInput(input)).toThrow();
    });
  });

  it('uses a least-privilege shape for the dedicated preload method', () => {
    expect(parseCustomSnoozeInput({
      reminderId: 'reminder-1',
      snoozeUntil: '2026-08-09T09:30:00.000Z',
    })).toEqual({
      reminderId: 'reminder-1',
      snoozeUntil: '2026-08-09T09:30:00.000Z',
    });
    expect(() => parseCustomSnoozeInput({
      reminderId: 'reminder-1',
      action: 'complete',
      snoozeUntil: '2026-08-09T09:30:00.000Z',
    })).toThrow();
  });
});
