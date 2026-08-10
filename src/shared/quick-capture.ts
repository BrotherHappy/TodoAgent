export type CaptureSource = 'local' | 'feishu';

export interface CaptureChip {
  id: 'date' | 'reminder' | 'project' | 'priority' | 'source' | 'tag';
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
  privatePlanAt?: string;
  dueAt?: string;
  reminderAt?: string;
  chips: CaptureChip[];
  needsReview: boolean;
}
