import { z } from 'zod';

import type { ReminderActionEvent } from '../../src/shared/reminders';

const reminderIdSchema = z.string().trim().min(1).max(512);

const customSnoozeInputSchema = z.object({
  reminderId: reminderIdSchema,
  // Clock-relative validation remains in NotificationController. This layer
  // only permits a bounded, timezone-qualified ISO value across IPC.
  snoozeUntil: z.string().max(64).datetime({ offset: true }),
}).strict();

const reminderActionInputSchema = z.discriminatedUnion('action', [
  z.object({
    reminderId: reminderIdSchema,
    action: z.enum([
      'complete',
      'snooze-10m',
      'snooze-1h',
      'tomorrow',
      'open',
      'dismiss',
    ]),
  }).strict(),
  z.object({
    action: z.literal('snooze-until'),
  }).extend(customSnoozeInputSchema.shape).strict(),
]);

export interface CustomSnoozeInput {
  reminderId: string;
  snoozeUntil: string;
}

export const parseReminderActionInput = (
  input: unknown,
): ReminderActionEvent => reminderActionInputSchema.parse(input);

export const parseCustomSnoozeInput = (
  input: unknown,
): CustomSnoozeInput => customSnoozeInputSchema.parse(input);
