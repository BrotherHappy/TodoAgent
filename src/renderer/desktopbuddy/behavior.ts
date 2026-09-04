// DesktopBuddy behavior mapping retained; TodoAgent actions are adapters,
// never changes to the underlying character designs or model data.
import type { PetBehaviorIntent, PetResolvedBehavior } from '../../shared/desktopbuddy';
import type { BuddyThemeManifest } from '../../shared/desktopbuddy-contract';
import type { PetAction } from '../pet-behavior';

export function buddyIntent(action: PetAction): PetBehaviorIntent {
  switch (action) {
    case 'idle': return { behavior: 'idleMotion', variant: 'default' };
    case 'drag': return { behavior: 'dragReaction', variant: 'start' };
    case 'pet': case 'poke': case 'tickle': case 'high-five': return { behavior: 'touchReaction', variant: 'head', mood: 'happy' };
    case 'wave': case 'peek': return { behavior: 'attention', variant: 'called', mood: 'happy' };
    case 'look-left': case 'look-right': case 'head-tilt': case 'ear-twitch': case 'inspect': return { behavior: 'attention', variant: 'cursorNear', mood: 'thinking' };
    case 'stretch': case 'drink': return { behavior: 'lifeRoutine', variant: 'morning' };
    case 'nap': case 'yawn': return { behavior: 'lifeRoutine', variant: 'sleep', mood: 'sleepy' };
    case 'focus': case 'read': return { behavior: 'lifeRoutine', variant: 'focusTime' };
    case 'break': case 'focus-paused': case 'sit': return { behavior: 'lifeRoutine', variant: 'rest' };
    case 'think': case 'search': case 'work': case 'sync': case 'type': case 'tidy': case 'juggle': case 'task-plan': case 'task-carry': return { behavior: 'aiThinking', variant: 'default', mood: 'thinking' };
    case 'approve': case 'alert': return { behavior: 'aiNeedConfirm', variant: 'default' };
    case 'celebrate': case 'task-complete': case 'task-clear': case 'sync-success': return { behavior: 'aiSuccess', variant: 'default', mood: 'happy' };
    case 'sync-error': case 'agent-error': return { behavior: 'aiError', variant: 'default' };
    case 'play': case 'dance': case 'snack': case 'jump-rope': case 'jump-rope-ready': case 'tail-wag': case 'hum': case 'float': return { behavior: 'optionalCare', variant: 'play', mood: 'happy' };
    case 'task-drop': return { behavior: 'dropReaction', variant: 'default' };
    default: { const exhaustive: never = action; return exhaustive; }
  }
}

/** Theme-specific buttons must drive the body as well as the raw motion group. */
export function buddyActionFromIntent(intent: PetBehaviorIntent): PetAction {
  switch (intent.behavior) {
    case 'touchReaction': return 'pet';
    case 'dragReaction': return 'drag';
    case 'dropReaction': return 'task-drop';
    case 'attention': return intent.variant === 'called' ? 'wave' : 'head-tilt';
    case 'lifeRoutine': return intent.variant === 'sleep' || intent.variant === 'night' ? 'nap'
      : intent.variant === 'focusTime' ? 'focus' : intent.variant === 'morning' || intent.variant === 'wake' ? 'stretch' : 'sit';
    case 'optionalCare': return intent.variant === 'rest' ? 'sit' : intent.variant === 'chat' ? 'wave' : 'play';
    case 'aiThinking': return 'think';
    case 'aiSpeaking': return 'wave';
    case 'aiNeedConfirm': case 'pluginNotify': return 'approve';
    case 'aiSuccess': return 'celebrate';
    case 'aiError': return 'agent-error';
    case 'idleMotion': return 'idle';
  }
}
export function resolveBuddyBehavior(theme: BuddyThemeManifest, intent: PetBehaviorIntent): PetResolvedBehavior {
  const get = (behavior: string, variant?: string): string | undefined => {
    const value = theme.motions[behavior];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0];
    const selected = value?.[variant ?? 'default'] ?? value?.default;
    return Array.isArray(selected) ? selected[0] : selected;
  };
  const direct = get(intent.behavior, intent.variant);
  const fallbackKey = theme.fallback.motion[`${intent.behavior}.${intent.variant ?? 'default'}`] ?? theme.fallback.motion[intent.behavior];
  const [fallback, variant] = (fallbackKey ?? 'idleMotion.default').split('.');
  const fallbackMotion = get(fallback, variant) ?? get('idleMotion', 'default');
  return { themeId: theme.id, renderer: theme.renderer, motion: direct ?? fallbackMotion, fallbackMotion: direct ? undefined : fallbackMotion, missingMotion: !direct, expression: intent.mood ? theme.expressions?.[intent.mood] : undefined };
}
