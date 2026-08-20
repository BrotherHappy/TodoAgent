import type { RecurrenceRule } from './models';

export type CaptureSource = 'local' | 'feishu';

export interface CaptureChip {
  id: 'date' | 'reminder' | 'project' | 'priority' | 'source' | 'tag' | 'context' | 'duration' | 'recurrence';
  label: string;
  value: string;
  confidence: 'certain' | 'inferred';
}

export interface QuickCaptureResult {
  originalText: string;
  title: string;
  note?: string;
  source: CaptureSource;
  priority: 0 | 1 | 2 | 3;
  project?: string;
  tags: string[];
  contexts: string[];
  estimatedMinutes?: number;
  recurrence?: RecurrenceRule;
  privatePlanAt?: string;
  dueAt?: string;
  reminderAt?: string;
  chips: CaptureChip[];
  needsReview: boolean;
}
