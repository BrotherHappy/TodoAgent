import type { AiPersonaPreset, PetThemeManifest, PetThemeRuntimeAssets } from './desktopbuddy';

export interface BuddyPreferences {
  themeId: string;
  gravity: boolean;
  inertia: boolean;
  edgeSnap: boolean;
  breathing: boolean;
  cursorFollow: boolean;
  reducedMotion: boolean;
  persona: AiPersonaPreset;
  memoryRounds: number;
}

export const defaultBuddyPreferences: BuddyPreferences = {
  themeId: 'wanko-live2d',
  gravity: true,
  inertia: true,
  edgeSnap: true,
  breathing: true,
  cursorFollow: true,
  reducedMotion: false,
  persona: 'gentle',
  memoryRounds: 12,
};

export const buddyPersonaLabels: Record<AiPersonaPreset, string> = {
  gentle: '温柔', witty: '轻吐槽', quiet: '安静', efficient: '效率',
};
export const buddyPersonaInstructions: Record<AiPersonaPreset, string> = {
  gentle: '温柔陪伴：先接住用户的感受，再给一个具体的下一步；不制造压力、愧疚或签到焦虑。',
  witty: '轻吐槽陪伴：可以对事情做一句轻松机智的吐槽，但不讽刺、羞辱用户，不淡化风险或任务事实。',
  quiet: '安静陪伴：简短回答当前问题，避免主动打扰和多余寒暄；必要确认不可省略。',
  efficient: '效率伙伴：结论先行，优先清晰的行动、时间和状态；不虚构完成结果，不绕过确认。',
};

export interface BuddyMotionClip { frames: string[]; fps: number; loop: boolean }
export type BuddyThemeManifest = PetThemeManifest & { animationClips?: Record<string, BuddyMotionClip> };
export interface BuddyTheme {
  manifest: BuddyThemeManifest;
  origin: 'builtin' | 'user';
  enabled: boolean;
  ready: boolean;
  issue?: string;
}
export interface BuddyAssets extends PetThemeRuntimeAssets {
  manifest: BuddyThemeManifest;
}
export interface BuddySnapshot { preferences: BuddyPreferences; themes: BuddyTheme[] }
export interface BuddyImageAnalysis {
  subject: string;
  type: 'human' | 'animal' | 'plant' | 'objectSpirit';
  characteristics: string;
  dominantColor: string;
  secondaryColor: string;
}
export interface BuddyGeneratedTheme {
  frames: Record<string, string>;
  analysis: BuddyImageAnalysis;
  animationClips?: Record<string, BuddyMotionClip>;
}
export interface BuddyInteraction { themeId: string; behavior: string; label: string; at: number }
export interface BuddyCursor { x: number; y: number; velocityX: number; velocityY: number }

export const BUDDY_CHANNELS = {
  snapshot: 'buddy:snapshot', preferences: 'buddy:preferences', assets: 'buddy:assets',
  import: 'buddy:import', image: 'buddy:image', generate: 'buddy:generate',
  enabled: 'buddy:enabled', remove: 'buddy:remove', interaction: 'buddy:interaction',
  changed: 'buddy:changed', performed: 'buddy:performed', cursor: 'buddy:cursor',
} as const;

export interface BuddyDesktopApi {
  snapshot(): Promise<BuddySnapshot>;
  setPreferences(patch: Partial<BuddyPreferences>): Promise<BuddySnapshot>;
  assets(themeId: string): Promise<BuddyAssets>;
  importTheme(): Promise<BuddySnapshot | null>;
  chooseImage(): Promise<{ imageDataUrl: string; name: string } | null>;
  generateTheme(input: BuddyGeneratedTheme): Promise<BuddySnapshot>;
  setEnabled(themeId: string, enabled: boolean): Promise<BuddySnapshot>;
  removeTheme(themeId: string): Promise<BuddySnapshot>;
  interact(interactionId: string): Promise<BuddyInteraction>;
  onChange(listener: (snapshot: BuddySnapshot) => void): () => void;
  onInteraction(listener: (event: BuddyInteraction) => void): () => void;
  onCursor(listener: (event: BuddyCursor) => void): () => void;
}

/** A round begins with a user message. Never leak an orphaned assistant turn. */
export function trimBuddyHistory<T extends { role: string }>(messages: T[], rounds: number): T[] {
  const limit = Number.isFinite(rounds) ? Math.min(50, Math.max(4, Math.round(rounds))) : 12;
  let users = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      if (++users > limit) break;
      start = i;
    }
  }
  return messages.slice(start);
}
