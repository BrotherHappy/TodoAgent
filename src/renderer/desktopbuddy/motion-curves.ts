import { petActionDefinitions, type PetAction } from '../pet-behavior';

export interface BuddyPose { x: number; y: number; rotation: number; scaleX: number; scaleY: number }
export const neutralBuddyPose: BuddyPose = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
export const supplementalBuddyActions = [
  ['pet', '抚摸回应'], ['jump-rope', '跳绳'], ['task-carry', '搬运任务'],
  ['celebrate', '庆祝'], ['drag', '拎起'], ['think', '思考'],
  ['search', '查资料'], ['work', '执行'], ['sync', '同步'], ['approve', '等待确认'],
] as const;
export function buddyActionDuration(action: string): number {
  return petActionDefinitions[action as PetAction]?.durationMs || (action === 'focus' ? 6000 : 3200);
}
export function buddyActionLoops(action: string): boolean {
  return action === 'drag' || petActionDefinitions[action as PetAction]?.durationMs === 0;
}
export function buddyActionProgress(action: string, elapsedMs: number): number {
  const progress = Math.max(0, elapsedMs) / buddyActionDuration(action);
  return buddyActionLoops(action) ? progress % 1 : Math.min(1, progress);
}
/** 33 authored transform keys, sampled continuously; endpoints share a neutral pose. */
export function createBuddyActionCurve(action: PetAction | string): BuddyPose[] {
  return Array.from({ length: 33 }, (_, index) => {
    const t = index / 32;
    const pulse = Math.sin(Math.PI * t) ** 2;
    const wiggle = Math.sin(t * Math.PI * 4) * pulse;
    const pose = { ...neutralBuddyPose };
    switch (action) {
      case 'jump-rope': {
        const flight = Math.max(0, Math.sin(Math.PI * Math.max(0, Math.min(1, (t - .14) / .68))));
        const crouch = Math.exp(-(((t - .12) / .075) ** 2)) + Math.exp(-(((t - .85) / .065) ** 2));
        pose.y = -19 * flight + 2 * crouch;
        pose.scaleX = 1 + .045 * crouch - .025 * flight;
        pose.scaleY = 1 - .06 * crouch + .025 * flight;
        break;
      }
      case 'pet': case 'tickle': case 'poke':
        pose.rotation = wiggle * 2.4; pose.scaleY = 1 - pulse * .025; pose.scaleX = 1 + pulse * .02; break;
      case 'drag': pose.rotation = wiggle * 4; pose.scaleY = 1 + .04 * pulse; pose.scaleX = 1 - .025 * pulse; break;
      case 'task-carry': pose.x = 5 * Math.sin(t * Math.PI * 2); pose.y = -1.8 * Math.abs(wiggle); pose.rotation = wiggle * 2; break;
      case 'celebrate': case 'high-five': case 'task-complete': pose.y = -8 * Math.abs(wiggle); pose.rotation = wiggle * 3; break;
      case 'search': case 'inspect': pose.x = 2 * wiggle; pose.rotation = wiggle * 2; break;
      case 'think': case 'head-tilt': pose.rotation = -3 * pulse; break;
      case 'work': case 'type': case 'sync': pose.y = -.8 * Math.abs(wiggle); break;
      case 'approve': case 'alert': pose.y = -2 * pulse; break;
      case 'stretch': pose.scaleY = 1 + .045 * pulse; pose.scaleX = 1 - .025 * pulse; pose.y = -1.5 * pulse; break;
      case 'yawn': case 'nap': case 'sit': case 'break': case 'focus-paused': pose.scaleY = 1 - .035 * pulse; pose.scaleX = 1 + .02 * pulse; break;
      case 'wave': case 'hum': case 'tail-wag': pose.rotation = wiggle * 1.4; break;
      case 'dance': case 'play': case 'juggle': pose.rotation = wiggle * 3; pose.y = -3 * Math.abs(wiggle); break;
      case 'float': pose.y = -4 * pulse; pose.rotation = wiggle; break;
      case 'peek': pose.x = 3 * pulse; pose.rotation = -4 * pulse; break;
      case 'look-left': case 'look-right': pose.rotation = (action === 'look-left' ? -1 : 1) * pulse; break;
      case 'task-drop': pose.y = 2 * pulse; pose.rotation = wiggle; break;
      case 'task-plan': case 'tidy': pose.x = 1.5 * wiggle; break;
      case 'sync-success': case 'task-clear': pose.y = -3 * pulse; break;
      case 'sync-error': case 'agent-error': pose.rotation = -1.5 * pulse; break;
      default: break;
    }
    return index === 0 || index === 32 ? { ...neutralBuddyPose } : pose;
  });
}
export function sampleBuddyCurve(curve: BuddyPose[], progress: number): BuddyPose {
  const offset = Math.max(0, Math.min(1, progress)) * (curve.length - 1);
  const lo = Math.floor(offset), hi = Math.min(curve.length - 1, lo + 1), mix = offset - lo;
  const result = { ...neutralBuddyPose };
  for (const key of Object.keys(result) as (keyof BuddyPose)[]) result[key] = curve[lo][key] + (curve[hi][key] - curve[lo][key]) * mix;
  return result;
}
