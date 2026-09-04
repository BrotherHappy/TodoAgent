import { z } from 'zod';

// One contract at both the IPC and domain boundaries. Invalid data from a
// renderer, Agent or future caller must fail before a transaction starts.
const id = z.string().trim().min(1).max(512);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const todayPlanRequestSchema = z.object({
  date: localDate.optional(),
  items: z.array(z.object({
    id,
    estimatedMinutes: z.number().int().min(5).max(720).optional(),
  }).strict()).max(500),
  clearTaskIds: z.array(id).max(500),
  baselines: z.array(z.object({
    id,
    plannedDate: localDate.optional(),
    privateOrder: z.number().finite(),
    estimatedMinutes: z.number().finite().nonnegative().optional(),
  }).strict()).max(500),
}).strict().refine(value => value.items.length + value.clearTaskIds.length <= 500, {
  message: '一次最多安排 500 项任务，请分批处理。', path: ['items'],
});
